"""End-to-end print preparation: repair -> orient -> scale -> hollow -> base -> decimate."""

from __future__ import annotations

import math
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from typing import Any

import manifold3d as mf
import numpy as np
import trimesh
from scipy import ndimage

from .fmt import it_num
from .repair import (
    DECIMATION_LOCK,
    fill_surface,
    from_manifold,
    grid_to_mesh,
    make_watertight,
    remove_debris,
    to_manifold,
    voxelize_surface,
)
from .report import printability_report

StepFn = Callable[[str, float], None]

ORIENTATIONS = ("upright", "supports", "flat", "keep")


@dataclass
class PrintSettings:
    target_size_mm: float = 100.0  # size of the largest dimension (base plate included)
    # "upright": as generated, levelled if it stands on a slightly tilted base;
    # "supports": the stable resting face that leaves the least overhang;
    # "flat": largest flat face on the bed; "keep": untouched.
    orientation: str = "upright"
    # Cut this many mm off the bottom so a rounded AI model gets a flat, stable face (0 = off).
    flat_bottom_mm: float = 0.0
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
        """Coerce and clamp user input. Raises ValueError (Italian) on unusable values."""
        data = data or {}
        fields = cls.__dataclass_fields__
        kwargs: dict[str, Any] = {}
        for key, value in data.items():
            if key not in fields or value is None:
                continue
            kind = fields[key].type
            try:
                if kind in ("float", float, "int", int):
                    if isinstance(value, bool):
                        raise ValueError(key)
                    number = float(value)
                    if not math.isfinite(number):
                        raise ValueError(key)
                    value = int(round(number)) if kind in ("int", int) else number
                elif kind in ("bool", bool):
                    value = value if isinstance(value, bool) else str(value).lower() in (
                        "1", "true", "yes", "on")
                else:
                    value = str(value)
            except (TypeError, ValueError) as exc:
                raise ValueError(f"Impostazione non valida: {key} = {value!r}") from exc
            kwargs[key] = value
        s = cls(**kwargs)
        s.target_size_mm = float(np.clip(s.target_size_mm, 5.0, 500.0))
        s.flat_bottom_mm = float(np.clip(s.flat_bottom_mm, 0.0, 30.0))
        s.wall_mm = float(np.clip(s.wall_mm, 0.8, 20.0))
        s.base_thickness_mm = float(np.clip(s.base_thickness_mm, 0.6, 20.0))
        s.base_margin_mm = float(np.clip(s.base_margin_mm, 0.0, 50.0))
        s.target_faces = int(np.clip(s.target_faces, 2_000, 2_000_000))
        s.repair_resolution = int(np.clip(s.repair_resolution, 64, 384))
        if s.orientation not in ORIENTATIONS:
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


def _hull_regions(mesh: trimesh.Trimesh) -> tuple[np.ndarray, np.ndarray, float]:
    """Planar regions of the convex hull: (normals (n, 3), areas (n,), hull area)."""
    hull = mesh.convex_hull
    normals = [hull.face_normals[f[0]] for f in hull.facets]
    areas = [float(a) for a in hull.facets_area]
    in_facet = np.zeros(len(hull.faces), dtype=bool)
    for facet in hull.facets:
        in_facet[facet] = True
    for i in np.nonzero(~in_facet)[0]:
        normals.append(hull.face_normals[i])
        areas.append(float(hull.area_faces[i]))
    return np.asarray(normals, dtype=float).reshape(-1, 3), np.asarray(areas), float(hull.area)


def minimal_rotation(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """4x4 rotation taking direction ``a`` onto ``b`` by the smallest angle.

    Unlike trimesh.geometry.align_vectors (any rotation that maps a to b), this keeps
    the object's heading: levelling a tilted model does not also spin it around Z."""
    a = np.asarray(a, dtype=float) / np.linalg.norm(a)
    b = np.asarray(b, dtype=float) / np.linalg.norm(b)
    axis = np.cross(a, b)
    sin, cos = float(np.linalg.norm(axis)), float(np.dot(a, b))
    if sin < 1e-9:
        if cos > 0:
            return np.eye(4)
        helper = [1.0, 0.0, 0.0] if abs(a[0]) < 0.9 else [0.0, 1.0, 0.0]
        return trimesh.transformations.rotation_matrix(math.pi, np.cross(a, helper))
    return trimesh.transformations.rotation_matrix(math.atan2(sin, cos), axis)


def _rest_on(mesh: trimesh.Trimesh, normal: np.ndarray) -> trimesh.Trimesh:
    out = mesh.copy()
    out.apply_transform(minimal_rotation(normal, [0, 0, -1]))
    return out


def orient_flat(mesh: trimesh.Trimesh) -> trimesh.Trimesh:
    """Rotate so the largest flat region of the convex hull rests on the bed."""
    normals, areas, _ = _hull_regions(mesh)
    if not len(areas):
        return mesh
    return _rest_on(mesh, normals[int(np.argmax(areas))])


def overhang_for(mesh: trimesh.Trimesh, down: np.ndarray, limit_deg: float = 45.0) -> float:
    """Overhang fraction if ``down`` pointed at the bed, without rotating the mesh.

    After a rotation taking ``down`` to -Z a face normal n has z = -(n . down), so it
    overhangs when n . down > sin(90° - limit). Faces within 0.4 mm of the bed rest on it.
    """
    d = np.asarray(down, dtype=float) / np.linalg.norm(down)
    areas = mesh.area_faces
    total = float(areas.sum())
    if total <= 0:
        return 0.0
    heights = -(mesh.triangles_center @ d)
    bed = float((-(mesh.vertices @ d)).min())
    mask = (mesh.face_normals @ d > math.sin(math.radians(90.0 - limit_deg))) & (heights > bed + 0.4)
    return float(areas[mask].sum() / total)


def orient_min_supports(
    mesh: trimesh.Trimesh, candidates: int = 32, min_area_frac: float = 0.02
) -> tuple[trimesh.Trimesh, float, float]:
    """Rest the model on the stable face that leaves the least overhang.

    Candidates are the largest planar regions of the convex hull (the faces a print can
    stand on) plus the current orientation. Ties go to the larger resting face.
    Returns (mesh, overhang before, overhang after) as fractions of the surface.
    """
    normals, areas, hull_area = _hull_regions(mesh)
    current = np.array([0.0, 0.0, -1.0])
    before = overhang_for(mesh, current)
    if not len(areas) or hull_area <= 0:
        return mesh, before, before
    order = np.argsort(-areas)[:candidates]
    best_dir: np.ndarray | None = None
    best_over, best_area = before, 0.0
    for i in order:
        if areas[i] < min_area_frac * hull_area:
            continue
        over = overhang_for(mesh, normals[i])
        if over > before - 0.005:
            continue  # no real gain: never turn a model for nothing
        a = areas[i] / hull_area
        # within a percent of overhang, the bigger (steadier) footprint wins
        if best_dir is None or (round(over, 2), -a) < (round(best_over, 2), -best_area):
            best_dir, best_over, best_area = normals[i], over, a
    if best_dir is None:
        return mesh, before, before
    return _rest_on(mesh, best_dir), before, best_over


def level_upright(
    mesh: trimesh.Trimesh, max_tilt_deg: float = 35.0, min_area_frac: float = 0.02
) -> tuple[trimesh.Trimesh, float]:
    """Keep the generated pose but level a slightly tilted base.

    Image->3D models (Pixal3D in particular, which is camera-aligned) return objects
    tilted by the photo's elevation. If a real flat region of the hull faces down within
    ``max_tilt_deg``, rotate it onto the bed. Round bottoms are left alone.
    Returns (mesh, tilt corrected in degrees).
    """
    normals, areas, hull_area = _hull_regions(mesh)
    if not len(areas) or hull_area <= 0:
        return mesh, 0.0
    down = -normals[:, 2]  # cos of the angle with -Z
    ok = down >= math.cos(math.radians(max_tilt_deg))
    if not ok.any():
        return mesh, 0.0
    score = np.where(ok, areas * down**2, -1.0)  # prefer large, then level regions
    best = int(np.argmax(score))
    if areas[best] < min_area_frac * hull_area:
        return mesh, 0.0
    tilt = math.degrees(math.acos(float(np.clip(down[best], -1.0, 1.0))))
    if tilt < 0.5:
        return mesh, 0.0
    return _rest_on(mesh, normals[best]), tilt


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


def hollow(
    mesh: trimesh.Trimesh, wall_mm: float, max_cells: int = 200, core_faces: int = 60_000
) -> trimesh.Trimesh | None:
    """Subtract an inward offset to leave walls of at least ``wall_mm``.

    The wall is measured from samples of the *real* surface, not from the voxelized
    solid: closing the solid fills narrow crevices (folds, fingers), and a cavity
    sized on the filled solid would cut through the wall at the bottom of them.
    """
    extent = float(mesh.extents.max())
    pitch = max(min(wall_mm / 3.0, extent / 120.0), extent / max_cells)
    surface, origin = voxelize_surface(mesh, pitch)
    solid = fill_surface(surface)
    dist = ndimage.distance_transform_edt(~surface) * pitch  # to the nearest surface sample
    inner = solid & (dist > wall_mm + pitch * 0.5)
    # Drop specks: cavities of a few voxels add shells without saving material.
    labels, n = ndimage.label(inner)
    if n == 0:
        return None
    sizes = ndimage.sum(inner, labels, index=np.arange(1, n + 1))
    keep_ids = np.nonzero(sizes >= max(27, 0.002 * sizes.max()))[0] + 1
    inner = np.isin(labels, keep_ids)
    if inner.sum() < 8:
        return None
    core = grid_to_mesh(inner, origin, pitch, smooth=6)
    if len(core.faces) > core_faces:  # the cavity needs no fine detail
        smaller = decimate(core, core_faces)
        if to_manifold(smaller) is not None:
            core = smaller
    outer_m, core_m = to_manifold(mesh), to_manifold(core)
    if outer_m is None or core_m is None:
        return None
    result = outer_m - core_m
    if result.is_empty():
        return None
    return from_manifold(result)


def cut_flat_bottom(mesh: trimesh.Trimesh, depth_mm: float, max_share: float = 0.4) -> trimesh.Trimesh | None:
    """Slice ``depth_mm`` off the bottom (an exact planar cut, closed by manifold3d), so the
    model rests on a flat face. None when the cut would take more than ``max_share`` of the
    height or the mesh is not a valid solid."""
    height = float(mesh.extents[2])
    if depth_mm <= 0 or depth_mm > max_share * height:
        return None
    solid = to_manifold(mesh)
    if solid is None:
        return None
    kept = solid.trim_by_plane((0.0, 0.0, 1.0), float(mesh.bounds[0, 2]) + depth_mm)  # keeps z >= cut
    return None if kept.is_empty() else from_manifold(kept)


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
        with DECIMATION_LOCK:
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
    elif s.orientation == "upright":
        work, tilt = level_upright(work)
        if tilt:
            steps.append(f"base livellata ({tilt:.0f}°)")
    elif s.orientation == "supports":
        work, before, after = orient_min_supports(work)
        if after < before:
            steps.append(f"girato per ridurre i supporti (sbalzi {before * 100:.0f}% → {after * 100:.0f}%)")
    work = scale_to(place_on_bed(work), s.target_size_mm)

    if s.flat_bottom_mm > 0:
        notify("Base piana", 0.52)
        cut = cut_flat_bottom(work, s.flat_bottom_mm)
        if cut is not None:
            work = scale_to(place_on_bed(cut), s.target_size_mm)
            steps.append(f"fondo tagliato in piano ({it_num(s.flat_bottom_mm)} mm)")
        else:
            steps.append("base piana saltata (taglio troppo alto per questo modello)")

    if s.hollow:
        notify("Svuotamento", 0.6)
        hollowed = hollow(work, s.wall_mm)
        if hollowed is not None:
            work = hollowed
            steps.append(f"svuotato, pareti {it_num(s.wall_mm)} mm")
        else:
            steps.append("svuotamento saltato (pareti troppo sottili)")

    if s.base_plate:
        notify("Base", 0.72)
        work = add_base_plate(place_on_bed(work), s.base_thickness_mm, s.base_margin_mm)
        steps.append(f"base {it_num(s.base_thickness_mm)} mm aggiunta")
        # The requested size is the size of the whole print, plate included.
        if work.extents.max() > s.target_size_mm * 1.0005:
            work = scale_to(work, s.target_size_mm)

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
