"""Colours of AI models: kept from the texture as per-vertex colours, carried through the
print preparation, written to OBJ/GLB for Bambu Studio's colour import."""

import numpy as np
import trimesh
from PIL import Image

from app.pipeline import PrintSettings, process_mesh
from app.pipeline.colors import NEUTRAL, carry, vertex_colors
from app.providers.base import load_mesh_file

from .test_pipeline import touching_boxes

RED = [255, 0, 0, 255]
BLUE = [0, 0, 255, 255]
GREEN = [0, 255, 0, 255]


def textured_box() -> trimesh.Trimesh:
    """A unit cube with a 2x1 texture: red on its -X half, blue on its +X half."""
    box = trimesh.creation.box()
    image = Image.new("RGB", (2, 1))
    image.putpixel((0, 0), (255, 0, 0))
    image.putpixel((1, 0), (0, 0, 255))
    box.visual = trimesh.visual.TextureVisuals(uv=box.vertices[:, :2] + 0.5, image=image)
    return box


def save_glb(geometry, path) -> str:
    scene = geometry if isinstance(geometry, trimesh.Scene) else trimesh.Scene(geometry)
    path.write_bytes(trimesh.exchange.gltf.export_glb(scene))
    return str(path)


def colored(mesh: trimesh.Trimesh, rgba) -> trimesh.Trimesh:
    mesh = mesh.copy()
    mesh.visual = trimesh.visual.ColorVisuals(mesh, vertex_colors=np.tile(rgba, (len(mesh.vertices), 1)))
    return mesh


# -- loading -----------------------------------------------------------------------------

def test_textured_glb_loads_with_vertex_colors(tmp_path):
    mesh = load_mesh_file(save_glb(textured_box(), tmp_path / "box.glb"))
    colors = vertex_colors(mesh)
    assert colors is not None
    assert (colors[mesh.vertices[:, 0] < 0] == RED).all()
    assert (colors[mesh.vertices[:, 0] > 0] == BLUE).all()


def test_plain_stl_loads_without_colors(tmp_path):
    path = tmp_path / "box.stl"
    path.write_bytes(trimesh.exchange.stl.export_stl(trimesh.creation.box()))
    assert vertex_colors(load_mesh_file(str(path))) is None


def test_mixed_scene_paints_uncolored_parts_neutral(tmp_path):
    plain = trimesh.creation.box()
    plain.apply_translation([3, 0, 0])
    mesh = load_mesh_file(save_glb(trimesh.Scene([textured_box(), plain]), tmp_path / "mix.glb"))
    colors = vertex_colors(mesh)
    assert colors is not None
    assert (colors[mesh.vertices[:, 0] > 2] == NEUTRAL).all()
    assert (colors[mesh.vertices[:, 0] < 0] == RED).all()


def test_material_without_image_gives_its_base_color(tmp_path):
    box = trimesh.creation.box()
    box.visual = trimesh.visual.TextureVisuals(
        material=trimesh.visual.material.PBRMaterial(baseColorFactor=[0, 255, 0, 255]))
    colors = vertex_colors(load_mesh_file(save_glb(box, tmp_path / "green.glb")))
    assert colors is not None
    assert (colors == GREEN).all()


def test_material_with_uvs_but_no_image_gives_its_base_color(tmp_path):
    """UVs without a texture image (common in untextured exports) must not break loading."""
    box = trimesh.creation.box()
    box.visual = trimesh.visual.TextureVisuals(
        uv=box.vertices[:, :2] + 0.5,
        material=trimesh.visual.material.PBRMaterial(baseColorFactor=[0, 255, 0, 255]))
    colors = vertex_colors(load_mesh_file(save_glb(box, tmp_path / "uv-green.glb")))
    assert colors is not None
    assert (colors == GREEN).all()


# -- carrying colours to a rebuilt mesh --------------------------------------------------

def test_carry_gives_each_new_vertex_its_nearest_color():
    ref = trimesh.creation.box()
    palette = np.array([[i * 30, 255 - i * 30, 7 * i, 255] for i in range(8)], dtype=np.uint8)
    ref.visual = trimesh.visual.ColorVisuals(ref, vertex_colors=palette)
    new = trimesh.Trimesh(*trimesh.remesh.subdivide(ref.vertices, ref.faces), process=False)
    out = vertex_colors(carry(ref, new))
    assert out is not None and len(out) == len(new.vertices)
    for corner, color in zip(ref.vertices, palette, strict=True):
        at = np.nonzero(np.all(np.isclose(new.vertices, corner), axis=1))[0]
        assert (out[at] == color).all()


def test_carry_leaves_uncolored_meshes_alone():
    out = carry(trimesh.creation.box(), trimesh.creation.icosphere())
    assert vertex_colors(out) is None


# -- print preparation -------------------------------------------------------------------

def test_colors_survive_repair_and_simplification():
    """Two cubes sharing an edge (repair rebuilds them with manifold3d), then simplified."""
    red = touching_boxes(([0, 0, 0],), subdivisions=4)
    blue = touching_boxes(([1, 1, 0],), subdivisions=4)
    mesh = trimesh.util.concatenate([red, blue])
    mesh.visual = trimesh.visual.ColorVisuals(mesh, vertex_colors=np.vstack(
        [np.tile(RED, (len(red.vertices), 1)), np.tile(BLUE, (len(blue.vertices), 1))]))
    res = process_mesh(mesh, PrintSettings(target_size_mm=100, target_faces=2000, orientation="keep"))
    colors = vertex_colors(res.mesh)
    assert colors is not None
    x = res.mesh.vertices[:, 0]  # red cube on -X, blue on +X once centred on the bed
    assert (colors[x < -5] == RED).all()
    assert (colors[x > 5] == BLUE).all()
    assert any(step.startswith("semplificato") for step in res.steps)


def test_hollow_base_and_flat_bottom_keep_colors():
    sphere = colored(trimesh.creation.icosphere(subdivisions=3), GREEN)
    res = process_mesh(sphere, PrintSettings(
        target_size_mm=60, hollow=True, base_plate=True, flat_bottom_mm=3))
    assert any(step.startswith("svuotato") for step in res.steps)
    assert any(step.startswith("base") for step in res.steps)
    assert any(step.startswith("fondo tagliato") for step in res.steps)
    colors = vertex_colors(res.mesh)
    assert colors is not None
    assert (colors == GREEN).all()


def test_voxel_rebuild_keeps_colors():
    sphere = colored(trimesh.creation.icosphere(subdivisions=3), GREEN)
    sphere.update_faces(sphere.triangles_center[:, 2] < 0.9)  # a hole too big to fill
    res = process_mesh(sphere, PrintSettings(target_size_mm=60, repair_resolution=64))
    assert any("voxel" in step for step in res.steps)
    colors = vertex_colors(res.mesh)
    assert colors is not None
    assert (colors == GREEN).all()


def test_uncolored_model_stays_uncolored():
    res = process_mesh(trimesh.creation.box(), PrintSettings(target_size_mm=40))
    assert vertex_colors(res.mesh) is None
