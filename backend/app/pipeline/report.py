"""Printability report."""

from __future__ import annotations

from typing import Any

import numpy as np
import trimesh

PLA_DENSITY = 1.24  # g/cm³
OVERHANG_LIMIT_DEG = 45.0


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
        "components": int(len(mesh.split(only_watertight=False))) if len(mesh.faces) < 400000 else 1,
        "warnings": warnings,
    }
    if extra:
        report.update(extra)
    return report
