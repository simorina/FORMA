"""Tiny CPU renderer (painter's algorithm) for thumbnails without OpenGL."""

from __future__ import annotations

import numpy as np
import trimesh
from PIL import Image, ImageDraw, ImageFilter


def _rotation(yaw: float, pitch: float) -> np.ndarray:
    cy, sy = np.cos(yaw), np.sin(yaw)
    cp, sp = np.cos(pitch), np.sin(pitch)
    rz = np.array([[cy, -sy, 0], [sy, cy, 0], [0, 0, 1]])
    rx = np.array([[1, 0, 0], [0, cp, -sp], [0, sp, cp]])
    return rx @ rz


def render_preview(
    mesh: trimesh.Trimesh,
    size: int = 512,
    up: str = "z",
    color: tuple[int, int, int] = (226, 214, 196),
    max_faces: int = 40000,
) -> Image.Image:
    """Render a soft-shaded 3/4 view of ``mesh`` on a neutral background."""
    m = mesh
    if len(m.faces) > max_faces:
        try:
            m = m.simplify_quadric_decimation(face_count=max_faces)
        except Exception:  # pragma: no cover - fast_simplification missing
            idx = np.random.default_rng(0).choice(len(m.faces), max_faces, replace=False)
            m = trimesh.Trimesh(m.vertices, m.faces[idx], process=False)
    v = np.asarray(m.vertices, dtype=float)
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

    faces = np.asarray(m.faces)
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

    order = np.argsort(-depth[faces].mean(axis=1))
    img = Image.new("RGB", (size, size))
    # Soft vertical gradient background: the ivory studio sweep of the interface.
    top, bottom = np.array([250, 247, 241]), np.array([228, 219, 205])
    grad = (top[None, :] * (1 - np.linspace(0, 1, size))[:, None] + bottom[None, :] * np.linspace(
        0, 1, size
    )[:, None]).astype(np.uint8)
    img = Image.fromarray(np.repeat(grad[:, None, :], size, axis=1))

    # Contact shadow ellipse.
    shadow = Image.new("L", (size, size), 0)
    sd = ImageDraw.Draw(shadow)
    base_y = xy[:, 1].max()
    w = (xy[:, 0].max() - xy[:, 0].min()) * 0.55
    sd.ellipse([size / 2 - w, base_y - 12, size / 2 + w, base_y + 12], fill=110)
    shadow = shadow.filter(ImageFilter.GaussianBlur(14))
    img.paste((120, 104, 84), (0, 0), shadow)

    draw = ImageDraw.Draw(img)
    base = np.array(color, dtype=float)
    for fi in order:
        if not visible[fi]:
            continue
        c = tuple(int(x) for x in np.clip(base * shade[fi], 0, 255))
        pts = [tuple(xy[i]) for i in faces[fi]]
        draw.polygon(pts, fill=c, outline=c)
    return img
