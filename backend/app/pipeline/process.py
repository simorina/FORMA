"""End-to-end print preparation: repair -> orient -> scale -> hollow -> base -> decimate."""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from typing import Any

import manifold3d as mf
import numpy as np
import trimesh
from scipy import ndimage

from .repair import (
    from_manifold,
    grid_to_mesh,
    make_watertight,
    remove_debris,
    to_manifold,
    voxelize_solid,
)
from .report import printability_report

StepFn = Callable[[str, float], None]


@dataclass
class PrintSettings:
    target_size_mm: float = 100.0  # size of the largest dimension
    orientation: str = "upright"  # "upright" | "flat" | "keep"
    hollow: bool = False
    wall_mm: float = 2.0
    base_plate: bool = False
    base_thickness_mm: float = 2.0
    base_margin_mm: float = 3.0
    decimate: bool = True
    target_faces: int = 150_000
    remove_debris: bool = True
    repair_resolution: int = 192

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> PrintSettings:
        data = data or {}
        fields = cls.__dataclass_fields__
        kwargs: dict[str, Any] = {}
        for key, value in data.items():
            if key not in fields or value is None:
                continue
            kind = fields[key].type
            if kind in ("float", float):
                value = float(value)
            elif kind in ("int", int):
                value = int(value)
            elif kind in ("bool", bool):
                value = value if isinstance(value, bool) else str(value).lower() in ("1", "true", "yes")
            kwargs[key] = value
        s = cls(**kwargs)
        s.target_size_mm = float(np.clip(s.target_size_mm, 5.0, 500.0))
        s.wall_mm = float(np.clip(s.wall_mm, 0.8, 20.0))
        s.base_thickness_mm = float(np.clip(s.base_thickness_mm, 0.6, 20.0))
        s.base_margin_mm = float(np.clip(s.base_margin_mm, 0.0, 50.0))
        s.target_faces = int(np.clip(s.target_faces, 2_000, 2_000_000))
        s.repair_resolution = int(np.clip(s.repair_resolution, 64, 384))
        if s.orientation not in ("upright", "flat", "keep"):
            s.orientation = "upright"
        return s

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ProcessResult:
    mesh: trimesh.Trimesh
    report: dict[str, Any]
    steps: list[str] = field(default_factory=list)


Y_UP_TO_Z_UP = np.array(
    [[1, 0, 0, 0], [0, 0, -1, 0], [0, 1, 0, 0], [0, 0, 0, 1]], dtype=float
)  # (x, y, z)_yup -> (x, -z, y)_zup


def to_z_up(mesh: trimesh.Trimesh, up: str) -> trimesh.Trimesh:
    mesh = mesh.copy()
    if up == "y":
        mesh.apply_transform(Y_UP_TO_Z_UP)
    return mesh


def orient_flat(mesh: trimesh.Trimesh) -> trimesh.Trimesh:
    """Rotate so the largest flat region of the convex hull rests on the bed."""
    hull = mesh.convex_hull
    candidates: list[tuple[float, np.ndarray]] = []
    for facet, area in zip(hull.facets, hull.facets_area, strict=False):
        candidates.append((float(area), hull.face_normals[facet[0]]))
    in_facet = np.zeros(len(hull.faces), dtype=bool)
    for facet in hull.facets:
        in_facet[facet] = True
    for i in np.nonzero(~in_facet)[0]:
        candidates.append((float(hull.area_faces[i]), hull.face_normals[i]))
    if not candidates:
        return mesh
    _, normal = max(candidates, key=lambda c: c[0])
    rot = trimesh.geometry.align_vectors(normal, [0, 0, -1])
    out = mesh.copy()
    out.apply_transform(rot)
    return out


def place_on_bed(mesh: trimesh.Trimesh) -> trimesh.Trimesh:
    """Center XY on the origin and drop to Z=0."""
    lo, hi = mesh.bounds
    mesh = mesh.copy()
    mesh.apply_translation([-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -lo[2]])
    return mesh


def scale_to(mesh: trimesh.Trimesh, target_mm: float) -> trimesh.Trimesh:
    extent = float(mesh.extents.max())
    if extent <= 0:
        return mesh
    mesh = mesh.copy()
    mesh.apply_scale(target_mm / extent)
    return mesh


def hollow(mesh: trimesh.Trimesh, wall_mm: float, max_cells: int = 200) -> trimesh.Trimesh | None:
    """Subtract an inward offset (voxel distance field) to leave walls of ``wall_mm``."""
    extent = float(mesh.extents.max())
    pitch = max(min(wall_mm / 3.0, extent / 120.0), extent / max_cells)
    grid, origin = voxelize_solid(mesh, pitch)
    dist = ndimage.distance_transform_edt(grid) * pitch
    inner = dist > (wall_mm + pitch * 0.5)
    if inner.sum() < 8:
        return None
    core = grid_to_mesh(inner, origin, pitch, smooth=6)
    outer_m, core_m = to_manifold(mesh), to_manifold(core)
    if outer_m is None or core_m is None:
        return None
    result = outer_m - core_m
    if result.is_empty():
        return None
    return from_manifold(result)


def add_base_plate(mesh: trimesh.Trimesh, thickness: float, margin: float) -> trimesh.Trimesh:
    """Rounded plate under the footprint of the lowest part; the model is lifted onto it."""
    verts = mesh.vertices
    z0 = verts[:, 2].min()
    band = verts[verts[:, 2] < z0 + max(1.0, mesh.extents[2] * 0.08)]
    pts = band[:, :2] if len(band) >= 3 else verts[:, :2]
    cs = mf.CrossSection.hull_points(pts.astype(np.float64).tolist())
    cs = cs.offset(max(margin, 0.01), mf.JoinType.Round, circular_segments=64)
    plate = mf.Manifold.extrude(cs, thickness)
    lifted = mesh.copy()
    lifted.apply_translation([0, 0, thickness - z0 - 0.2])  # 0.2 mm overlap for a clean union
    body = to_manifold(lifted)
    if body is None:
        return trimesh.util.concatenate([lifted, from_manifold(plate)])
    return from_manifold(body + plate)


def decimate(mesh: trimesh.Trimesh, target_faces: int) -> trimesh.Trimesh:
    if len(mesh.faces) <= target_faces:
        return mesh
    try:
        out = mesh.simplify_quadric_decimation(face_count=target_faces)
    except Exception:
        return mesh
    out = trimesh.Trimesh(out.vertices, out.faces, process=True)
    return out


def process_mesh(
    mesh: trimesh.Trimesh,
    settings: PrintSettings | None = None,
    on_step: StepFn | None = None,
) -> ProcessResult:
    """Make ``mesh`` (Z-up, any units) print-ready in millimetres."""
    s = settings or PrintSettings()
    t0 = time.perf_counter()
    notify = on_step or (lambda msg, frac: None)
    steps: list[str] = []
    if len(mesh.faces) == 0:
        raise ValueError("La mesh è vuota.")

    notify("Pulizia", 0.05)
    work = mesh
    if s.remove_debris:
        work, removed = remove_debris(work)
        if removed:
            steps.append(
                "1 frammento isolato rimosso" if removed == 1 else f"{removed} frammenti isolati rimossi"
            )

    # Normalise scale early so voxel-based repair works in predictable units.
    work = scale_to(place_on_bed(work), s.target_size_mm)

    # Pre-decimate huge AI meshes so repair stays fast (final decimation later).
    if len(work.faces) > max(s.target_faces * 3, 600_000):
        work = decimate(work, max(s.target_faces * 2, 300_000))
        steps.append("pre-semplificazione")

    notify("Riparazione", 0.25)
    work, repairs = make_watertight(work, s.repair_resolution)
    steps += repairs

    notify("Orientamento", 0.45)
    if s.orientation == "flat":
        work = orient_flat(work)
        steps.append("appoggiato sulla faccia più ampia")
    work = scale_to(place_on_bed(work), s.target_size_mm)

    if s.hollow:
        notify("Svuotamento", 0.6)
        hollowed = hollow(work, s.wall_mm)
        if hollowed is not None:
            work = hollowed
            steps.append(f"svuotato, pareti {s.wall_mm:g} mm")
        else:
            steps.append("svuotamento saltato (pareti troppo sottili)")

    if s.base_plate:
        notify("Base", 0.72)
        work = add_base_plate(place_on_bed(work), s.base_thickness_mm, s.base_margin_mm)
        steps.append(f"base {s.base_thickness_mm:g} mm aggiunta")

    if s.decimate and len(work.faces) > s.target_faces:
        notify("Semplificazione", 0.82)
        before = len(work.faces)
        candidate = decimate(work, s.target_faces)
        if not candidate.is_watertight:
            solid = to_manifold(candidate)
            candidate = from_manifold(solid) if solid is not None else candidate
        if candidate.is_watertight or not work.is_watertight:
            work = candidate
            steps.append(f"semplificato {before:,} → {len(work.faces):,} triangoli".replace(",", "."))

    notify("Verifica", 0.92)
    work = place_on_bed(work)
    trimesh.repair.fix_normals(work)
    report = printability_report(
        work,
        {
            "hollowed": bool(s.hollow and any(x.startswith("svuotato") for x in steps)),
            "base_plate": bool(s.base_plate),
            "repairs": steps,
            "settings": s.to_dict(),
            "process_ms": int((time.perf_counter() - t0) * 1000),
        },
    )
    notify("Pronto", 1.0)
    return ProcessResult(mesh=work, report=report, steps=steps)
