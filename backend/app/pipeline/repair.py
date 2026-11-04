"""Mesh repair: watertight + manifold, with progressively stronger fallbacks.

1. trimesh cleanup (merge, degenerate/duplicate faces, normals, hole filling)
2. pymeshlab non-manifold repair + hole closing (optional dependency)
3. voxel remesh (always yields a closed 2-manifold surface)
Finally we validate with manifold3d, the same kernel used for booleans.
"""

from __future__ import annotations

import logging

import manifold3d as mf
import numpy as np
import trimesh
from scipy import ndimage

log = logging.getLogger(__name__)


def to_manifold(mesh: trimesh.Trimesh) -> mf.Manifold | None:
    """Convert to a manifold3d solid, or None if it is not a valid 2-manifold."""
    try:
        m = mf.Manifold(
            mf.Mesh(
                vert_properties=np.ascontiguousarray(mesh.vertices, dtype=np.float32),
                tri_verts=np.ascontiguousarray(mesh.faces, dtype=np.uint32),
            )
        )
    except Exception:
        return None
    if m.status() != mf.Error.NoError or m.is_empty():
        return None
    return m


def from_manifold(m: mf.Manifold) -> trimesh.Trimesh:
    out = m.to_mesh()
    return trimesh.Trimesh(
        vertices=np.asarray(out.vert_properties)[:, :3].astype(np.float64),
        faces=np.asarray(out.tri_verts).astype(np.int64),
        process=False,
    )


def basic_cleanup(mesh: trimesh.Trimesh) -> trimesh.Trimesh:
    mesh = mesh.copy()
    mesh.merge_vertices(digits_vertex=6)
    mesh.update_faces(mesh.nondegenerate_faces())
    mesh.update_faces(mesh.unique_faces())
    mesh.remove_unreferenced_vertices()
    if len(mesh.faces):
        trimesh.repair.fix_winding(mesh)
        trimesh.repair.fix_inversion(mesh, multibody=True)
    return mesh


def remove_debris(mesh: trimesh.Trimesh, min_fraction: float = 0.01) -> tuple[trimesh.Trimesh, int]:
    """Drop floating fragments much smaller than the main body (by surface area)."""
    parts = mesh.split(only_watertight=False)
    if len(parts) <= 1:
        return mesh, 0
    areas = np.array([p.area for p in parts])
    keep = [p for p, a in zip(parts, areas, strict=False) if a >= areas.max() * min_fraction]
    removed = len(parts) - len(keep)
    if removed == 0:
        return mesh, 0
    return trimesh.util.concatenate(keep), removed


def _pymeshlab_repair(mesh: trimesh.Trimesh) -> trimesh.Trimesh | None:
    try:
        import pymeshlab  # type: ignore
    except Exception:
        return None
    try:
        ms = pymeshlab.MeshSet()
        ms.add_mesh(pymeshlab.Mesh(vertex_matrix=mesh.vertices, face_matrix=mesh.faces))
        ms.meshing_remove_duplicate_vertices()
        ms.meshing_repair_non_manifold_edges(method=0)
        ms.meshing_repair_non_manifold_vertices()
        ms.meshing_close_holes(maxholesize=1000)
        ms.meshing_re_orient_faces_coherently()
        m = ms.current_mesh()
        return trimesh.Trimesh(m.vertex_matrix(), m.face_matrix(), process=True)
    except Exception as exc:  # pragma: no cover - depends on system libs
        log.warning("pymeshlab repair failed: %s", exc)
        return None


def voxelize_solid(mesh: trimesh.Trimesh, pitch: float, pad: int = 3) -> tuple[np.ndarray, np.ndarray]:
    """Fast solid voxelization: dense surface sampling + closing + hole filling.

    Returns (bool grid, origin) where voxel (i, j, k) has its centre at
    ``origin + (i, j, k) * pitch``. Works on open / non-manifold input too.
    """
    lo = mesh.bounds[0] - pad * pitch
    shape = np.ceil(mesh.extents / pitch).astype(int) + 2 * pad + 1
    count = int(np.clip(mesh.area / (pitch * pitch) * 6, 20_000, 8_000_000))
    pts, _ = trimesh.sample.sample_surface(mesh, count, seed=0)
    pts = np.vstack([pts, mesh.vertices])
    idx = np.clip(np.round((pts - lo) / pitch).astype(int), 0, shape - 1)
    grid = np.zeros(shape, dtype=bool)
    grid[idx[:, 0], idx[:, 1], idx[:, 2]] = True
    # Flood the outside from a corner through a dilated shell (closes sampling gaps),
    # then erode once to give back the thickness added by the dilation.
    shell = ndimage.binary_dilation(grid, structure=np.ones((3, 3, 3)))
    labels, _ = ndimage.label(~shell)
    outside = labels == labels[0, 0, 0]
    solid = ndimage.binary_erosion(~outside, structure=np.ones((3, 3, 3))) | grid
    return solid, lo


def grid_to_mesh(grid: np.ndarray, origin: np.ndarray, pitch: float, smooth: int = 10) -> trimesh.Trimesh:
    from skimage import measure

    verts, faces, _, _ = measure.marching_cubes(np.pad(grid, 1).astype(np.float32), level=0.5)
    verts = (verts - 1) * pitch + origin
    out = trimesh.Trimesh(verts, faces, process=True)
    if smooth:
        trimesh.smoothing.filter_taubin(out, lamb=0.5, nu=-0.53, iterations=smooth)
    trimesh.repair.fix_normals(out)
    return out


def voxel_remesh(mesh: trimesh.Trimesh, resolution: int = 192) -> trimesh.Trimesh:
    """Rebuild a closed surface from a filled voxelization (+ Taubin smoothing)."""
    pitch = (float(mesh.extents.max()) or 1.0) / resolution
    grid, origin = voxelize_solid(mesh, pitch)
    return grid_to_mesh(grid, origin, pitch)


def is_print_ok(mesh: trimesh.Trimesh) -> bool:
    return bool(mesh.is_watertight and mesh.is_winding_consistent and to_manifold(mesh) is not None)


def make_watertight(
    mesh: trimesh.Trimesh, voxel_resolution: int = 192
) -> tuple[trimesh.Trimesh, list[str]]:
    """Return a closed manifold mesh and the list of repairs applied (Italian)."""
    steps: list[str] = []
    m = basic_cleanup(mesh)
    if is_print_ok(m):
        return m, steps
    solid = to_manifold(m)
    if solid is not None:
        # Valid for manifold3d (e.g. edge-touching bodies): its output splits shared edges.
        rebuilt = from_manifold(solid)
        if rebuilt.is_watertight:
            steps.append("bordi condivisi separati")
            return rebuilt, steps
    trimesh.repair.fill_holes(m)
    trimesh.repair.fix_normals(m)
    if is_print_ok(m):
        steps.append("buchi chiusi")
        return m, steps
    pm = _pymeshlab_repair(m)
    if pm is not None:
        pm = basic_cleanup(pm)
        if is_print_ok(pm):
            steps.append("bordi non-manifold riparati (pymeshlab)")
            return pm, steps
    vm = voxel_remesh(m, voxel_resolution)
    solid = to_manifold(vm)
    if solid is not None:
        steps.append(f"superficie ricostruita (voxel {voxel_resolution}³)")
        return from_manifold(solid), steps
    steps.append("riparazione incompleta")
    return vm, steps
