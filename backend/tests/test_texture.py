"""An AI model's texture is read at its own resolution: the mesh is split first, its UVs
following every new vertex, so the plate shows the colours Meshy shows."""

import numpy as np
import pytest
import trimesh
from PIL import Image

from app.pipeline.colors import concatenate, vertex_colors
from app.pipeline.process import MAX_FACES, MIN_FACES
from app.pipeline.refine import refine_uv
from app.pipeline.repair import weld
from app.pipeline.texture import CEILING, bake, bake_all, sample, target_faces
from app.providers.base import load_mesh_file


def checker(size: int = 64, square: int = 8) -> Image.Image:
    yy, xx = np.mgrid[0:size, 0:size]
    white = ((xx // square + yy // square) % 2 == 0)[..., None]
    return Image.fromarray(np.where(white, 255, 0).astype(np.uint8).repeat(3, axis=2), "RGB")


def unwrapped(mesh: trimesh.Trimesh, image: Image.Image) -> trimesh.Trimesh:
    """Every triangle its own UV island (a seam on every edge, as in the worst atlas): the
    three corners of each face get their own vertices, UVs from a projection per face."""
    corners = mesh.vertices[mesh.faces].reshape(-1, 3)
    normals = np.repeat(mesh.face_normals, 3, axis=0)
    axis = np.abs(normals).argmax(axis=1)  # project each face along its main axis
    keep = np.array([[1, 2], [0, 2], [0, 1]])[axis]
    uv = np.take_along_axis(corners, keep, axis=1)
    uv = (uv - uv.min(axis=0)) / np.ptp(uv, axis=0).max()
    out = trimesh.Trimesh(corners, np.arange(len(corners)).reshape(-1, 3), process=False)
    out.visual = trimesh.visual.TextureVisuals(uv=uv, image=image)
    return out


def test_sample_is_bilinear_between_texel_centres():
    pixels = np.array([[[0, 0, 0, 255], [200, 100, 50, 255]]], dtype=np.uint8)  # 2x1
    got = sample(pixels, np.array([[0.0, 0.0], [1.0, 0.0], [0.5, 0.0], [0.25, 0.5]]))
    assert got.tolist() == [[0, 0, 0, 255], [200, 100, 50, 255], [100, 50, 25, 255], [50, 25, 12, 255]]


@pytest.mark.parametrize("goal", [3_000, 7_777, 40_000])
def test_seam_edges_split_in_pairs_so_the_welded_mesh_stays_closed(goal):
    sphere = trimesh.creation.icosphere(2)
    flat = unwrapped(sphere, checker())
    vertices, faces, uv = refine_uv(flat.vertices, flat.faces, flat.visual.uv, goal)
    assert len(faces) >= goal and len(uv) == len(vertices)
    out = weld(trimesh.Trimesh(vertices, faces, process=False))
    assert out.is_watertight and out.is_winding_consistent
    assert out.volume == pytest.approx(sphere.volume, rel=1e-9)  # the surface did not move


def test_the_texture_detail_reaches_the_vertices():
    """A box with a checkerboard texture: read at its corners it is a few flat colours; read
    after the split, the squares are there."""
    box = unwrapped(trimesh.creation.box((10.0, 10.0, 10.0)), checker())
    old = vertex_colors(concatenate([box]))  # read at the corners only, as before
    assert len(np.unique(old[:, 0])) <= 3
    baked = bake(box, 30_000)
    colors = vertex_colors(baked)
    assert len(baked.faces) >= 30_000
    dark, light = (colors[:, 0] < 40).mean(), (colors[:, 0] > 215).mean()
    assert dark > 0.25 and light > 0.25  # both colours of the checker, side by side
    assert weld(baked).is_watertight


def test_the_split_follows_the_texture_size(monkeypatch):
    monkeypatch.delenv("FORMA_MIN_FACES")
    assert target_faces(4096 * 4096) == CEILING < MAX_FACES  # Meshy Alta: up to the ceiling
    assert target_faces(2048 * 2048) == int(2048 * 2048 * 1.3)  # ~5.45M
    assert target_faces(1024 * 1024) == MIN_FACES  # never below what every print has
    monkeypatch.setenv("FORMA_MIN_FACES", "0")
    assert target_faces(64 * 64) == int(64 * 64 * 1.3)


def test_a_textured_glb_is_split_when_loaded(tmp_path):
    box = unwrapped(trimesh.creation.box((10.0, 10.0, 10.0)), checker())
    path = tmp_path / "box.glb"
    path.write_bytes(trimesh.exchange.gltf.export_glb(trimesh.Scene(box)))
    mesh = load_mesh_file(str(path))
    assert len(mesh.faces) >= target_faces(64 * 64) > len(box.faces)
    assert weld(mesh).is_watertight


def test_a_scene_shares_the_triangles_among_its_textured_parts():
    a = unwrapped(trimesh.creation.box(), checker())
    b = unwrapped(trimesh.creation.icosphere(2), checker())  # 320 faces against 12
    plain = trimesh.creation.box()
    out = bake_all([a, b, plain])
    assert out[2] is plain
    budget = target_faces(2 * 64 * 64)
    assert len(out[0].faces) + len(out[1].faces) == pytest.approx(budget, rel=0.1)
    assert len(out[1].faces) > 10 * len(out[0].faces)  # by size
