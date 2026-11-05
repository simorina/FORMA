"""Per-vertex colours of a model: read from any trimesh visual (the texture of an AI model,
vertex or face colours of an upload) and carried onto meshes the preparation rebuilds.

A coloured mesh has ``visual.kind == "vertex"`` with RGBA uint8 colours; a mesh without
colours has no visual at all, and every function here leaves it that way.
"""

from __future__ import annotations

import logging

import numpy as np
import trimesh
from scipy.spatial import cKDTree

log = logging.getLogger(__name__)

# Parts without colour inside a coloured model.
NEUTRAL = np.array([160, 160, 160, 255], dtype=np.uint8)


def vertex_colors(mesh: trimesh.Trimesh) -> np.ndarray | None:
    """RGBA uint8 colour per vertex, or None when the mesh has no colours."""
    visual = getattr(mesh, "visual", None)
    if visual is None or visual.kind != "vertex":
        return None
    colors = np.asarray(visual.vertex_colors, dtype=np.uint8)
    return colors if colors.shape == (len(mesh.vertices), 4) else None


def with_colors(mesh: trimesh.Trimesh, colors: np.ndarray | None) -> trimesh.Trimesh:
    """``mesh``'s geometry with these vertex colours (none: no visual)."""
    out = trimesh.Trimesh(vertices=mesh.vertices, faces=mesh.faces, process=False)
    if colors is not None:
        out.visual = trimesh.visual.ColorVisuals(out, vertex_colors=colors)
    return out


def _read_colors(mesh: trimesh.Trimesh) -> np.ndarray | None:
    visual = getattr(mesh, "visual", None)
    kind = getattr(visual, "kind", None)
    if kind is None:
        return None
    n = len(mesh.vertices)
    if isinstance(visual, trimesh.visual.TextureVisuals):
        material = visual.material
        image = getattr(material, "baseColorTexture", None) or getattr(material, "image", None)
        if image is None or visual.uv is None or len(visual.uv) != n:
            # No texture to sample (or no UVs to sample it at): the material's base colour.
            main = getattr(material, "main_color", None)
            return None if main is None else np.tile(np.asarray(main, dtype=np.uint8), (n, 1))
        return np.asarray(visual.to_color().vertex_colors, dtype=np.uint8).reshape(n, 4)
    # ColorVisuals: vertex colours as they are, face colours spread to the vertices.
    return np.asarray(visual.vertex_colors, dtype=np.uint8).reshape(n, 4)


def _safe_colors(mesh: trimesh.Trimesh) -> np.ndarray | None:
    """Colours are a bonus: a visual we cannot read leaves the model without them, never
    stops it from loading."""
    try:
        return _read_colors(mesh)
    except Exception as exc:  # noqa: BLE001 - any odd visual from any exporter
        log.warning("colori non leggibili, modello senza colori: %s", exc)
        return None


def colored_mesh(mesh: trimesh.Trimesh) -> trimesh.Trimesh:
    """A plain copy of ``mesh`` (``process=False``) with per-vertex colours from whatever
    visual it has: a texture is sampled at the UVs, a material without one gives its base
    colour, face colours are spread to the vertices. No colours: no visual."""
    return with_colors(mesh, _safe_colors(mesh))


def concatenate(meshes: list[trimesh.Trimesh]) -> trimesh.Trimesh:
    """One mesh from many, each converted with ``colored_mesh``. If any part has colours,
    the parts without get ``NEUTRAL``; if none has, the result has none."""
    parts = [colored_mesh(m) for m in meshes]
    if len(parts) == 1:
        return parts[0]
    colors = [vertex_colors(p) for p in parts]
    joined = trimesh.util.concatenate([with_colors(p, None) for p in parts])
    if all(c is None for c in colors):
        return joined
    filled = [c if c is not None else np.tile(NEUTRAL, (len(p.vertices), 1))
              for p, c in zip(parts, colors, strict=True)]
    return with_colors(joined, np.vstack(filled))


def carry(ref: trimesh.Trimesh, new: trimesh.Trimesh) -> trimesh.Trimesh:
    """Give every vertex of ``new`` the colour of the nearest vertex of ``ref`` (same frame
    of reference) when ``ref`` has colours and ``new`` lost them; otherwise ``new`` as is."""
    ref_colors = vertex_colors(ref)
    if ref_colors is None or vertex_colors(new) is not None or len(new.vertices) == 0:
        return new
    _, nearest = cKDTree(ref.vertices).query(new.vertices, workers=-1)
    return with_colors(new, ref_colors[nearest])
