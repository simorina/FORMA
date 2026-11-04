"""Printability report."""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import trimesh
from scipy.spatial import cKDTree

from .fmt import it_num
from .repair import count_bodies

PLA_DENSITY = 1.24  # g/cm³
OVERHANG_LIMIT_DEG = 45.0
MIN_WALL_MM = 0.8  # two perimeters of a 0.4 mm nozzle: anything thinner may not print


def thin_parts(
    mesh: trimesh.Trimesh, min_wall: float = MIN_WALL_MM, max_samples: int = 60_000, k: int = 16
) -> tuple[float, float | None]:
    """Share of the surface lying on parts thinner than ``min_wall``, and their typical
    thickness (mm, 5th percentile) or None.

    A surface sample is on a thin part when, within ``min_wall``, there is a sample of the
    opposite side: a normal pointing the other way, lying behind it inside the material.
    Edges and corners of thick parts have perpendicular normals there, so they never count.
    """
    if len(mesh.faces) == 0:
        return 0.0, None
    area = float(mesh.area)
    spacing = max(min_wall / 2.0, math.sqrt(area / max_samples))
    n = int(min(max_samples, max(2_000, area / spacing**2)))
    pts, face = trimesh.sample.sample_surface(mesh, n, seed=0)
    nrm = mesh.face_normals[face]
    dist, idx = cKDTree(pts).query(pts, k=min(k, n), distance_upper_bound=min_wall)
    valid = np.isfinite(dist) & (dist > 1e-9)
    j = np.where(valid, idx, 0)
    facing = np.einsum("ij,ikj->ik", nrm, nrm[j]) < -0.5
    depth = np.einsum("ikj,ij->ik", pts[j] - pts[:, None, :], -nrm)  # how far behind
    opposite = valid & facing & (depth > 0.5 * np.where(valid, dist, 1.0))
    thin = opposite.any(axis=1)
    if not thin.any():
        return 0.0, None
    thickness = np.where(opposite, depth, np.inf).min(axis=1)[thin]
    return float(thin.mean()), float(np.percentile(thickness, 5))


def bed_contact_cm2(mesh: trimesh.Trimesh) -> float:
    """Area of the faces resting flat on the bed (Z min), in cm²."""
    if len(mesh.faces) == 0:
        return 0.0
    z0 = mesh.bounds[0, 2]
    on_bed = (mesh.face_normals[:, 2] < -0.95) & (mesh.triangles_center[:, 2] < z0 + 0.05)
    return float(mesh.area_faces[on_bed].sum() / 100.0)


def overhang_fraction(mesh: trimesh.Trimesh, limit_deg: float = OVERHANG_LIMIT_DEG) -> float:
    """Fraction of surface area facing downwards beyond ``limit_deg`` from vertical,
    ignoring faces resting on the bed (Z≈min)."""
    if len(mesh.faces) == 0:
        return 0.0
    normals = mesh.face_normals
    areas = mesh.area_faces
    z_min = mesh.bounds[0, 2]
    centroids_z = mesh.triangles_center[:, 2]
    threshold = -np.sin(np.radians(90.0 - limit_deg))  # n_z below this -> overhang
    on_bed = centroids_z < z_min + 0.4
    mask = (normals[:, 2] < threshold) & ~on_bed
    total = areas.sum()
    return float(areas[mask].sum() / total) if total > 0 else 0.0


def printability_report(mesh: trimesh.Trimesh, extra: dict[str, Any] | None = None) -> dict[str, Any]:
    watertight = bool(mesh.is_watertight)
    winding = bool(mesh.is_winding_consistent)
    volume_mm3 = float(abs(mesh.volume)) if watertight else 0.0
    volume_cm3 = volume_mm3 / 1000.0
    area_cm2 = float(mesh.area) / 100.0
    extents = mesh.extents if len(mesh.vertices) else np.zeros(3)
    grams = volume_cm3 * PLA_DENSITY
    # Typical slicer profile: ~0.8 mm of shell + 15% infill.
    shell_cm3 = min(volume_cm3, area_cm2 * 0.08)
    typical_g = (shell_cm3 + (volume_cm3 - shell_cm3) * 0.15) * PLA_DENSITY
    over = overhang_fraction(mesh)
    warnings: list[str] = []
    if not watertight:
        warnings.append("La mesh non è chiusa: lo slicer potrebbe rifiutarla.")
    if over > 0.08:
        warnings.append(
            f"Sbalzi oltre {int(OVERHANG_LIMIT_DEG)}° sul {over * 100:.0f}% della superficie: "
            "attiva i supporti."
        )
    if extents.size and extents.min() < 1.0:
        warnings.append("Una dimensione è sotto 1 mm: il pezzo potrebbe non stamparsi.")
    thin_frac, thin_mm = thin_parts(mesh) if len(mesh.faces) < 1_000_000 else (0.0, None)
    if thin_frac > 0.001 and thin_mm is not None:
        scale = MIN_WALL_MM / max(thin_mm, 0.05)
        warnings.append(
            f"Parti sottili (circa {it_num(thin_mm, 1)} mm) sul {it_num(thin_frac * 100, 1)}% della superficie: "
            f"sotto {it_num(MIN_WALL_MM)} mm potrebbero non stamparsi. Ingrandisci di circa ×{it_num(scale, 1)} "
            "o rinforzale nella modifica."
        )
    contact = bed_contact_cm2(mesh)
    if extents.size and extents[2] > 15 and contact < 1.0:
        warnings.append(
            f"Appoggia sul piatto solo per {it_num(contact, 1)} cm²: potrebbe staccarsi o cadere. "
            "Prova la base piana o una base d'appoggio."
        )
    report = {
        "watertight": watertight,
        "manifold": watertight and winding,
        "volume_cm3": round(volume_cm3, 2),
        "surface_cm2": round(area_cm2, 2),
        "bbox_mm": [round(float(x), 2) for x in extents],
        "triangles": int(len(mesh.faces)),
        "vertices": int(len(mesh.vertices)),
        "pla_grams": round(grams, 1),
        "pla_grams_typical": round(typical_g, 1),
        "overhang_pct": round(over * 100, 1),
        "overhang_warning": over > 0.08,
        "thin_pct": round(thin_frac * 100, 2),
        "thin_mm": round(thin_mm, 2) if thin_mm is not None else None,
        "bed_contact_cm2": round(contact, 2),
        # Separate pieces on the bed; the cavity of a hollowed model is not a piece.
        "components": count_bodies(mesh) if len(mesh.faces) < 1_000_000 else 1,
        "warnings": warnings,
    }
    if extra:
        report.update(extra)
    return report
