"""Tiny CPU renderer (painter's algorithm) for thumbnails without OpenGL."""

from __future__ import annotations

import numpy as np
import trimesh
from PIL import Image, ImageDraw, ImageFilter
from scipy.spatial import cKDTree

from .pipeline.colors import vertex_colors
from .pipeline.repair import DECIMATION_LOCK

SHADOW_BLUR = 14
# The blurred shadow reaches about 3 * SHADOW_BLUR past its ellipse (three box-blur passes):
# blurring only that neighbourhood gives the same pixels as blurring the whole frame.
SHADOW_PAD = 4 * SHADOW_BLUR


def _rotation(yaw: float, pitch: float) -> np.ndarray:
    cy, sy = np.cos(yaw), np.sin(yaw)
    cp, sp = np.cos(pitch), np.sin(pitch)
    rz = np.array([[cy, -sy, 0], [sy, cy, 0], [0, 0, 1]])
    rx = np.array([[1, 0, 0], [0, cp, -sp], [0, sp, cp]])
    return rx @ rz


def _clustered(vertices: np.ndarray, faces: np.ndarray, cells: int) -> tuple[np.ndarray, np.ndarray]:
    """Vertex clustering: one vertex per cell of a grid with ``cells`` along the longest side
    (the mean of those in it), triangles that collapse dropped. Linear in the mesh size."""
    lo = vertices.min(axis=0)
    size = float((vertices.max(axis=0) - lo).max()) / cells or 1.0
    cell = np.minimum(((vertices - lo) / size).astype(np.int64), cells - 1)
    _, group = np.unique((cell[:, 0] * cells + cell[:, 1]) * cells + cell[:, 2], return_inverse=True)
    count = np.bincount(group)
    merged = np.stack([np.bincount(group, weights=vertices[:, i]) for i in range(3)], axis=1)
    f = group[faces]
    kept = (f[:, 0] != f[:, 1]) & (f[:, 1] != f[:, 2]) & (f[:, 2] != f[:, 0])
    return merged / count[:, None], f[kept]


# Above this many triangles, a thumbnail first clusters the vertices on a grid of PREVIEW_CELLS
# (finer than its pixels): quadric decimation of a whole 5M-triangle print takes ~20 s.
CLUSTER_ABOVE = 1_000_000
PREVIEW_CELLS = 256


def _decimated(mesh: trimesh.Trimesh, max_faces: int) -> tuple[np.ndarray, np.ndarray]:
    """Vertices and faces with at most ``max_faces`` faces (quadric decimation)."""
    vertices = np.asarray(mesh.vertices, dtype=float)
    faces = np.asarray(mesh.faces)
    if len(faces) <= max_faces:
        return vertices, faces
    if len(faces) > max(CLUSTER_ABOVE, 8 * max_faces):
        vertices, faces = _clustered(vertices, faces, PREVIEW_CELLS)
        if len(faces) <= max_faces:
            return vertices, faces
    try:
        # The same decimation as Trimesh.simplify_quadric_decimation, without building (and
        # vertex-merging) a Trimesh around the result: the triangles are the same.
        from fast_simplification import simplify

        with DECIMATION_LOCK:
            v, f = simplify(vertices, faces, target_count=max_faces)
        return np.asarray(v, dtype=float), np.asarray(f)
    except Exception:  # pragma: no cover - fast_simplification missing
        idx = np.random.default_rng(0).choice(len(faces), max_faces, replace=False)
        return vertices, faces[idx]


def _face_colors(mesh: trimesh.Trimesh, v: np.ndarray, faces: np.ndarray) -> np.ndarray | None:
    """RGB (float) per face of the decimated (v, faces): its corners' colours averaged, each
    corner taking the colour of the nearest original vertex. None: no colours."""
    colors = vertex_colors(mesh)
    if colors is None:
        return None
    if len(v) == len(mesh.vertices):
        per_vertex = colors
    else:
        _, nearest = cKDTree(mesh.vertices).query(v, workers=-1)
        per_vertex = colors[nearest]
    return per_vertex[faces][:, :, :3].astype(float).mean(axis=1)


def _backdrop(size: int, xy: np.ndarray) -> Image.Image:
    """The ivory studio sweep of the interface, with a soft contact shadow under the model."""
    top, bottom = np.array([250, 247, 241]), np.array([228, 219, 205])
    t = np.linspace(0, 1, size)[:, None]
    grad = (top[None, :] * (1 - t) + bottom[None, :] * t).astype(np.uint8)
    img = Image.fromarray(np.repeat(grad[:, None, :], size, axis=1))

    base_y = xy[:, 1].max()
    w = (xy[:, 0].max() - xy[:, 0].min()) * 0.55
    ellipse = [size / 2 - w, base_y - 12, size / 2 + w, base_y + 12]
    # Blur only the box around the ellipse (the rest of the shadow mask stays 0).
    box = (
        max(0, int(ellipse[0]) - SHADOW_PAD),
        max(0, int(ellipse[1]) - SHADOW_PAD),
        min(size, int(ellipse[2]) + SHADOW_PAD + 1),
        min(size, int(ellipse[3]) + SHADOW_PAD + 1),
    )
    if box[0] >= box[2] or box[1] >= box[3]:
        return img
    shadow = Image.new("L", (box[2] - box[0], box[3] - box[1]), 0)
    ImageDraw.Draw(shadow).ellipse(
        [ellipse[0] - box[0], ellipse[1] - box[1], ellipse[2] - box[0], ellipse[3] - box[1]],
        fill=110,
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(SHADOW_BLUR))
    img.paste((120, 104, 84), box, shadow)
    return img


def render_preview(
    mesh: trimesh.Trimesh,
    size: int = 512,
    up: str = "z",
    color: tuple[int, int, int] = (226, 214, 196),
    max_faces: int = 40000,
) -> Image.Image:
    """Render a soft-shaded 3/4 view of ``mesh`` on a neutral background, in the mesh's own
    per-vertex colours when it has them, in ``color`` otherwise."""
    v, faces = _decimated(mesh, max_faces)
    face_rgb = _face_colors(mesh, v, faces)
    if up == "y":
        v = v[:, [0, 2, 1]] * np.array([1, -1, 1])
    v = v - (v.max(0) + v.min(0)) / 2
    # Camera: rotate so we look from front-right, slightly above. View dir = +Y.
    rot = _rotation(np.radians(-35), np.radians(18))
    p = v @ rot.T
    extent = np.abs(p[:, [0, 2]]).max() or 1.0
    scale = size * 0.40 / extent
    xy = np.stack([p[:, 0] * scale + size / 2, -p[:, 2] * scale + size / 2], axis=1)
    depth = p[:, 1]

    tri = p[faces]
    normals = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    normals /= np.linalg.norm(normals, axis=1, keepdims=True) + 1e-12
    visible = normals[:, 1] < 0  # facing the camera (camera looks towards +Y)
    key = np.array([-0.5, -0.6, 0.62])
    key /= np.linalg.norm(key)
    lam = np.clip(normals @ key, 0, 1)
    fill = np.clip(normals @ np.array([0.7, -0.3, 0.1]), 0, 1) * 0.25
    rim = np.clip(1 + normals[:, 1], 0, 1) ** 3 * 0.25
    shade = np.clip(0.28 + 0.72 * lam + fill + rim, 0, 1.15)

    # Back to front, faces turned to the camera only.
    order = np.argsort(-depth[faces].mean(axis=1))
    order = order[visible[order]]
    img = _backdrop(size, xy)

    # Colours and corners for every face at once: the loop only hands them to PIL.
    base = face_rgb[order] if face_rgb is not None else np.asarray(color, dtype=float)[None, :]
    colours = np.clip(base * shade[order, None], 0, 255)
    colours = map(tuple, colours.astype(np.uint8).tolist())
    corners = xy[faces[order]].reshape(-1, 6).tolist()
    draw = ImageDraw.Draw(img)
    for pts, c in zip(corners, colours, strict=True):
        draw.polygon(pts, fill=c)  # an outline in the fill's colour would be skipped by PIL anyway
    return img
