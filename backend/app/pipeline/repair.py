"""Mesh repair: watertight + manifold, with progressively stronger fallbacks.

1. trimesh cleanup (merge, degenerate/duplicate faces, normals, hole filling)
2. pymeshlab non-manifold repair + hole closing (optional dependency)
3. voxel remesh (always yields a closed 2-manifold surface)
Finally we validate with manifold3d, the same kernel used for booleans.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

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


@dataclass
class Shell:
    """One connected component of a mesh, seen as a (possibly nested) boundary."""

    faces: np.ndarray  # indices into mesh.faces
    closed: bool
    volume: float  # signed: > 0 when normals point outwards
    depth: int  # how many other closed shells contain it (odd = cavity)


def winding_number(point: np.ndarray, triangles: np.ndarray) -> float:
    """Generalised winding number of ``point`` w.r.t. closed ``triangles`` (n, 3, 3).

    ~±1 inside, ~0 outside (Van Oosterom & Strackee solid angles)."""
    a, b, c = (triangles[:, i, :] - point for i in range(3))
    la, lb, lc = (np.linalg.norm(x, axis=1) for x in (a, b, c))
    det = np.einsum("ij,ij->i", a, np.cross(b, c))
    denom = (la * lb * lc + np.einsum("ij,ij->i", a, b) * lc
             + np.einsum("ij,ij->i", b, c) * la + np.einsum("ij,ij->i", c, a) * lb)
    return float(np.arctan2(det, denom).sum() / (2.0 * np.pi))


def analyze_shells(mesh: trimesh.Trimesh, max_shells: int = 64) -> list[Shell]:
    """Split ``mesh`` into connected shells and find how they nest.

    A hollowed print has an outer shell (depth 0, outward normals) and a cavity shell
    (depth 1, inward normals). Beyond ``max_shells`` nesting is not computed (depth 0).
    """
    nf = len(mesh.faces)
    if nf == 0:
        return []
    groups = trimesh.graph.connected_components(
        mesh.face_adjacency, nodes=np.arange(nf), min_len=1
    )
    if len(groups) == 1:  # the common case: one shell, use trimesh's cached properties
        return [Shell(np.arange(nf), bool(mesh.is_watertight), float(mesh.volume), 0)]
    edges = mesh.edges_sorted.reshape(-1, 3, 2).astype(np.int64)
    keys = edges[..., 0] * (len(mesh.vertices) + 1) + edges[..., 1]  # one int per edge
    tris = mesh.triangles
    shells: list[Shell] = []
    for g in groups:
        g = np.asarray(g, dtype=np.int64)
        _, counts = np.unique(keys[g].ravel(), return_counts=True)
        t = tris[g]
        volume = float(np.einsum("ij,ij->i", t[:, 0], np.cross(t[:, 1], t[:, 2])).sum() / 6.0)
        shells.append(Shell(g, bool(np.all(counts == 2)), volume, 0))
    closed = [s for s in shells if s.closed]
    if 1 < len(closed) <= max_shells:
        lo = np.array([tris[s.faces].reshape(-1, 3).min(0) for s in closed])
        hi = np.array([tris[s.faces].reshape(-1, 3).max(0) for s in closed])
        for i, inner in enumerate(closed):
            probe = tris[inner.faces[0]].mean(axis=0)
            for j, outer in enumerate(closed):
                if i == j or not (np.all(lo[i] >= lo[j] - 1e-9) and np.all(hi[i] <= hi[j] + 1e-9)):
                    continue
                if abs(winding_number(probe, tris[outer.faces])) > 0.5:
                    inner.depth += 1
    return shells


def orient_shells(mesh: trimesh.Trimesh) -> None:
    """Point every closed shell the right way: outwards at even depth, inwards for
    cavities (odd depth). Unlike trimesh's multibody fix_inversion this keeps the
    cavity of a hollowed model a cavity instead of turning it into a second solid."""
    flip = np.zeros(len(mesh.faces), dtype=bool)
    for s in analyze_shells(mesh):
        outward = s.depth % 2 == 0 or not s.closed
        if (s.volume < 0) == outward:
            flip[s.faces] = True
    if flip.any():
        faces = mesh.faces.copy()
        faces[flip] = faces[flip][:, ::-1]
        mesh.faces = faces


def count_bodies(mesh: trimesh.Trimesh) -> int:
    """Separate printable pieces: cavity shells do not count as pieces."""
    return sum(1 for s in analyze_shells(mesh) if not s.closed or s.depth % 2 == 0)


def basic_cleanup(mesh: trimesh.Trimesh) -> trimesh.Trimesh:
    mesh = mesh.copy()
    mesh.merge_vertices(digits_vertex=6)
    mesh.update_faces(mesh.nondegenerate_faces())
    mesh.update_faces(mesh.unique_faces())
    mesh.remove_unreferenced_vertices()
    if len(mesh.faces):
        trimesh.repair.fix_winding(mesh)
        orient_shells(mesh)
    return mesh


def weld(mesh: trimesh.Trimesh) -> trimesh.Trimesh:
    """Merge coincident vertices (STL uploads, UV seams of textured GLBs) so that
    connectivity reflects the real surface."""
    mesh = mesh.copy()
    mesh.merge_vertices(digits_vertex=6)
    return mesh


def remove_debris(mesh: trimesh.Trimesh, min_fraction: float = 0.01) -> tuple[trimesh.Trimesh, int]:
    """Drop floating fragments much smaller than the main body (by surface area).

    The mesh is welded first: on unwelded input every triangle is its own
    "component", and small real triangles would be thrown away as debris.
    """
    mesh = weld(mesh)
    if len(mesh.faces) == 0:
        return mesh, 0
    # Connected components by face adjacency (not mesh.split(): its submeshes are
    # silently "repaired", which would hide hole filling from the report).
    groups = trimesh.graph.connected_components(
        mesh.face_adjacency, nodes=np.arange(len(mesh.faces)), min_len=1
    )
    if len(groups) <= 1:
        return mesh, 0
    face_area = mesh.area_faces
    areas = np.array([face_area[g].sum() for g in groups])
    small = areas < areas.max() * min_fraction
    removed = int(small.sum())
    if removed == 0:
        return mesh, 0
    keep = np.ones(len(mesh.faces), dtype=bool)
    for g in np.asarray(groups, dtype=object)[small]:
        keep[np.asarray(g, dtype=np.int64)] = False
    mesh.update_faces(keep)
    mesh.remove_unreferenced_vertices()
    return mesh, removed


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


def voxelize_surface(
    mesh: trimesh.Trimesh, pitch: float, pad: int = 3
) -> tuple[np.ndarray, np.ndarray]:
    """Voxels touched by a dense sampling of the surface: (bool grid, origin)."""
    lo = mesh.bounds[0] - pad * pitch
    shape = np.ceil(mesh.extents / pitch).astype(int) + 2 * pad + 1
    count = int(np.clip(mesh.area / (pitch * pitch) * 6, 20_000, 8_000_000))
    pts, _ = trimesh.sample.sample_surface(mesh, count, seed=0)
    pts = np.vstack([pts, mesh.vertices])
    idx = np.clip(np.round((pts - lo) / pitch).astype(int), 0, shape - 1)
    grid = np.zeros(shape, dtype=bool)
    grid[idx[:, 0], idx[:, 1], idx[:, 2]] = True
    return grid, lo


def fill_surface(surface: np.ndarray) -> np.ndarray:
    """Solid from surface voxels: flood the outside from a corner through a dilated
    shell (closes sampling gaps), then erode once to give back the added thickness."""
    shell = ndimage.binary_dilation(surface, structure=np.ones((3, 3, 3)))
    labels, _ = ndimage.label(~shell)
    outside = labels == labels[0, 0, 0]
    return ndimage.binary_erosion(~outside, structure=np.ones((3, 3, 3))) | surface


def voxelize_solid(mesh: trimesh.Trimesh, pitch: float, pad: int = 3) -> tuple[np.ndarray, np.ndarray]:
    """Fast solid voxelization: dense surface sampling + closing + hole filling.

    Returns (bool grid, origin) where voxel (i, j, k) has its centre at
    ``origin + (i, j, k) * pitch``. Works on open / non-manifold input too.
    """
    surface, lo = voxelize_surface(mesh, pitch, pad)
    return fill_surface(surface), lo


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
