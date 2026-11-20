"""Minimum resolution: split triangles until a mesh has at least N of them, shape unchanged.

Every split puts a new vertex at the midpoint of an edge, so the surface stays exactly where
it was: no smoothing, so flat cuts, base plates and sharp edges stay sharp and the sizes in
millimetres stay exact. The longest edges go first, so the triangles even out instead of the
small ones getting smaller. A triangle with one, two or three split edges becomes two, three
or four (red-green refinement): the two triangles on an edge share its midpoint, so no crack
opens and a closed, manifold mesh stays closed and manifold. Colours are interpolated along
the edge, and so are texture coordinates (``refine_uv``: a textured mesh is split before its
texture is read, see texture.py).
"""

from __future__ import annotations

import numpy as np
import trimesh

from .colors import vertex_colors, with_colors


def _unique_edges(faces: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(E, 2) unique edges, (F, 3) the edge of each face side (side k: corner k -> k + 1, as
    trimesh orders them) and (E,) how many faces share each edge."""
    sides = faces[:, [0, 1, 1, 2, 2, 0]].reshape(-1, 2)
    lo, hi = sides.min(axis=1).astype(np.int64), sides.max(axis=1).astype(np.int64)
    keys = lo * (int(faces.max()) + 1) + hi
    _, first, inverse, degree = np.unique(keys, return_index=True, return_inverse=True,
                                          return_counts=True)
    edges = np.stack([lo[first], hi[first]], axis=1)
    return edges, inverse.reshape(-1, 3), degree


def _roll(rows: np.ndarray, shift: np.ndarray) -> np.ndarray:
    """Rotate each row of an (n, 3) array left by its ``shift``: the winding is kept."""
    idx = (np.arange(3)[None, :] + shift[:, None]) % 3
    return np.take_along_axis(rows, idx, axis=1)


def _tris(*corners: np.ndarray) -> np.ndarray:
    return np.stack(corners, axis=1)


def _split(
    vertices: np.ndarray, faces: np.ndarray, colors: np.ndarray | None, extra: int,
    uv: np.ndarray | None = None, twins: bool = False,
) -> tuple[np.ndarray, np.ndarray, np.ndarray | None, np.ndarray | None]:
    """One round: split the longest edges, enough for ``extra`` more triangles (at most every
    edge, which turns every triangle into four). ``twins``: also every edge as long as the
    last one split, so the two copies of an edge along a UV seam (same ends, same length,
    welded later) are always split together and no crack opens there."""
    edges, side_edge, degree = _unique_edges(faces)
    if extra >= int(degree.sum()):  # every edge: each split adds one triangle per face on it
        marked = np.ones(len(edges), dtype=bool)
    else:
        ends = np.round(vertices, 6) if twins else vertices  # as the weld rounds them
        length = np.linalg.norm(ends[edges[:, 0]] - ends[edges[:, 1]], axis=1)
        order = np.argsort(-length, kind="stable")
        count = int(np.searchsorted(np.cumsum(degree[order]), extra)) + 1
        marked = np.zeros(len(edges), dtype=bool)
        marked[order[:count]] = True
        if twins:
            marked |= length >= length[order[count - 1]]

    split = np.nonzero(marked)[0]
    mid = np.full(len(edges), -1, dtype=np.int64)
    mid[split] = len(vertices) + np.arange(len(split))
    a_end, b_end = edges[split, 0], edges[split, 1]
    vertices = np.vstack([vertices, (vertices[a_end] + vertices[b_end]) * 0.5])
    if colors is not None:
        blend = (colors[a_end].astype(np.uint16) + colors[b_end] + 1) // 2
        colors = np.vstack([colors, blend.astype(np.uint8)])
    if uv is not None:
        uv = np.vstack([uv, (uv[a_end] + uv[b_end]) * 0.5])

    side_marked = marked[side_edge]
    n_marked = side_marked.sum(axis=1)
    side_mid = mid[side_edge]
    out = [faces[n_marked == 0]]

    sel = n_marked == 1  # rotate so the split side is side 0 (a-b): two triangles
    shift = np.argmax(side_marked[sel], axis=1)
    (a, b, c), m = _roll(faces[sel], shift).T, _roll(side_mid[sel], shift)
    out += [_tris(a, m[:, 0], c), _tris(m[:, 0], b, c)]

    sel = n_marked == 2  # rotate so the whole side is side 2 (c-a): corner b + a quad
    shift = (np.argmin(side_marked[sel], axis=1) + 1) % 3
    (a, b, c), m = _roll(faces[sel], shift).T, _roll(side_mid[sel], shift)
    m0, m1 = m[:, 0], m[:, 1]
    out.append(_tris(m0, b, m1))
    # The quad a-m0-m1-c is cut along its shorter diagonal: the better-shaped pair.
    via_a = (np.linalg.norm(vertices[a] - vertices[m1], axis=1)
             <= np.linalg.norm(vertices[m0] - vertices[c], axis=1))
    out += [_tris(a, m0, m1)[via_a], _tris(a, m1, c)[via_a],
            _tris(a, m0, c)[~via_a], _tris(m0, m1, c)[~via_a]]

    sel = n_marked == 3  # four triangles, one per corner and one in the middle
    (a, b, c), m = faces[sel].T, side_mid[sel]
    m0, m1, m2 = m[:, 0], m[:, 1], m[:, 2]
    out += [_tris(a, m0, m2), _tris(m0, b, m1), _tris(m2, m1, c), _tris(m0, m1, m2)]
    return vertices, np.concatenate(out).astype(np.int64), colors, uv


def refine(mesh: trimesh.Trimesh, min_faces: int) -> trimesh.Trimesh:
    """``mesh`` with at least ``min_faces`` triangles (a few more at most), same surface and
    colours; the mesh itself when it already has that many."""
    if len(mesh.faces) == 0 or len(mesh.faces) >= min_faces:
        return mesh
    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    faces = np.asarray(mesh.faces, dtype=np.int64)
    colors = vertex_colors(mesh)
    while len(faces) < min_faces:
        vertices, faces, colors, _ = _split(vertices, faces, colors, min_faces - len(faces))
    return with_colors(trimesh.Trimesh(vertices=vertices, faces=faces, process=False), colors)


def refine_uv(
    vertices: np.ndarray, faces: np.ndarray, uv: np.ndarray, min_faces: int
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """``refine`` for a textured mesh, its UV seams still open (one vertex per side): the
    texture coordinates follow every new vertex, and seam edges split in pairs."""
    vertices = np.asarray(vertices, dtype=np.float64)
    faces = np.asarray(faces, dtype=np.int64)
    uv = np.asarray(uv, dtype=np.float64)
    while 0 < len(faces) < min_faces:
        vertices, faces, _, uv = _split(vertices, faces, None, min_faces - len(faces), uv, twins=True)
    return vertices, faces, uv
