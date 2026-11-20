"""An AI model's texture, read at its own resolution.

The colours of a Meshy (or Pixal3D, TRELLIS.2) model live in its texture, up to 4096 px, while
its geometry has far fewer vertices: Meshy Ultra 4K sends ~650k triangles, ~350k vertices.
Reading the texture only there kept one colour every ~45 texels, and the plate showed a blurred
copy of the model Meshy shows. So the textured mesh is split first (``refine_uv``: midpoints,
the surface unchanged, the texture coordinates following every new vertex), to about one
vertex per texel the model uses, never below the minimum every print has and never above the
ceiling; then the texture is read at every vertex, bilinearly.
"""

from __future__ import annotations

import numpy as np
import trimesh
from PIL import Image

from .colors import with_colors
from .process import MAX_FACES, min_faces
from .refine import refine_uv

# A mesh has about two triangles per vertex and a texture atlas covers about 65% of its
# image: 1.3 triangles per texel puts about one vertex on every texel the model uses
# (2048 px: ~5.4M triangles; 4096 px: the ceiling).
FACES_PER_TEXEL = 1.3
# Below the ceiling, so a few twin splits over the target never send the model to the
# simplification before the repair (process.PRE_DECIMATE_ABOVE).
CEILING = int(MAX_FACES * 0.99)
CHUNK = 2_000_000  # vertices sampled at once: bounded memory at 10M triangles


def _texture(mesh: trimesh.Trimesh) -> tuple[np.ndarray, np.ndarray] | None:
    """(H, W, 4) uint8 image and (V, 2) UVs, when the mesh has a texture to read."""
    visual = getattr(mesh, "visual", None)
    if not isinstance(visual, trimesh.visual.TextureVisuals) or visual.uv is None:
        return None
    material = visual.material
    image = getattr(material, "baseColorTexture", None) or getattr(material, "image", None)
    if not isinstance(image, Image.Image) or len(visual.uv) != len(mesh.vertices):
        return None
    # The image alone, as trimesh reads it: its own exports carry a 0.4 grey baseColorFactor
    # (from SimpleMaterial's default diffuse) that would darken every Space's model.
    pixels = np.asarray(image.convert("RGBA"), dtype=np.uint8)
    return pixels, np.asarray(visual.uv, dtype=np.float64)


def sample(pixels: np.ndarray, uv: np.ndarray) -> np.ndarray:
    """RGBA uint8 at each UV, bilinear, repeating outside 0-1; the texel centres as trimesh
    places them (u 0 -> column 0, u 1 -> the last; v 0 -> the bottom row)."""
    h, w = pixels.shape[:2]
    out = np.empty((len(uv), 4), dtype=np.uint8)
    for lo in range(0, len(uv), CHUNK):
        part = uv[lo:lo + CHUNK]
        x = np.mod(part[:, 0], 1.0 + 1e-12) * (w - 1)
        y = (1.0 - np.mod(part[:, 1], 1.0 + 1e-12)) * (h - 1)
        x0 = np.floor(x).astype(np.int64)
        y0 = np.floor(y).astype(np.int64)
        fx = (x - x0)[:, None].astype(np.float32)
        fy = (y - y0)[:, None].astype(np.float32)
        x0 %= w
        y0 %= h
        x1, y1 = (x0 + 1) % w, (y0 + 1) % h
        top = pixels[y0, x0] * (1 - fx) + pixels[y0, x1] * fx
        bottom = pixels[y1, x0] * (1 - fx) + pixels[y1, x1] * fx
        out[lo:lo + CHUNK] = np.clip(np.rint(top * (1 - fy) + bottom * fy), 0, 255)
    return out


def target_faces(texels: int) -> int:
    """Triangles to split a textured mesh into, for a texture of ``texels`` pixels."""
    return int(np.clip(texels * FACES_PER_TEXEL, min(min_faces(), CEILING), CEILING))


def bake(mesh: trimesh.Trimesh, faces: int | None = None) -> trimesh.Trimesh | None:
    """``mesh`` split to ``faces`` triangles (from its texture's size when None) with its
    texture read at every vertex; None when it has no texture image to read."""
    found = _texture(mesh)
    if found is None:
        return None
    pixels, uv = found
    goal = target_faces(pixels.shape[0] * pixels.shape[1]) if faces is None else faces
    vertices, tris, uv = refine_uv(mesh.vertices, mesh.faces, uv, goal)
    out = trimesh.Trimesh(vertices=vertices, faces=tris, process=False)
    return with_colors(out, sample(pixels, uv))


def bake_all(meshes: list[trimesh.Trimesh]) -> list[trimesh.Trimesh]:
    """``bake`` every textured part, the triangles shared among them by size; the others as
    they are."""
    textures = [_texture(m) for m in meshes]
    sized = [(i, t[0].shape[0] * t[0].shape[1]) for i, t in enumerate(textures) if t is not None]
    if not sized:
        return list(meshes)
    budget = target_faces(sum(texels for _, texels in sized))
    total = sum(len(meshes[i].faces) for i, _ in sized) or 1
    out = list(meshes)
    for i, _ in sized:
        share = max(len(meshes[i].faces), budget * len(meshes[i].faces) // total)
        out[i] = bake(meshes[i], share) or meshes[i]
    return out
