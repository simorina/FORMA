import io
import struct
import zipfile

import numpy as np
import pytest
import trimesh

from app.exporters import export_mesh


@pytest.fixture()
def cube():
    m = trimesh.creation.box((20, 20, 20))
    m.apply_translation([0, 0, 10])
    return m


def test_stl_is_binary(cube):
    data, mime, ext = export_mesh(cube, "stl")
    assert ext == "stl" and mime == "model/stl"
    (count,) = struct.unpack("<I", data[80:84])
    assert count == 12
    assert len(data) == 84 + 50 * 12


def test_3mf_has_millimetre_units(cube):
    data, _, _ = export_mesh(cube, "3mf")
    z = zipfile.ZipFile(io.BytesIO(data))
    model = z.read("3D/3dmodel.model").decode()
    assert 'unit="millimeter"' in model
    back = trimesh.load(io.BytesIO(data), file_type="3mf", force="mesh")
    assert back.extents.max() == pytest.approx(20, rel=1e-4)


def test_obj_roundtrip(cube):
    data, _, _ = export_mesh(cube, "obj")
    back = trimesh.load(io.BytesIO(data), file_type="obj", force="mesh")
    assert back.extents.max() == pytest.approx(20, rel=1e-4)


def test_glb_is_metres_y_up(cube):
    data, _, _ = export_mesh(cube, "glb")
    assert data[:4] == b"glTF"
    back = trimesh.load(io.BytesIO(data), file_type="glb", force="mesh")
    assert back.extents.max() == pytest.approx(0.02, rel=1e-4)
    assert np.isclose(back.bounds[1][1], 0.02, atol=1e-6)  # height is +Y


def test_unknown_format(cube):
    with pytest.raises(ValueError):
        export_mesh(cube, "fbx")


@pytest.fixture()
def colored_cube(cube):
    m = cube.copy()
    m.visual = trimesh.visual.ColorVisuals(m, vertex_colors=np.tile([200, 30, 10, 255], (len(m.vertices), 1)))
    return m


def test_obj_writes_vertex_colors(colored_cube):
    """Bambu Studio's colour import reads `v x y z r g b` (r, g, b from 0 to 1)."""
    data, _, _ = export_mesh(colored_cube, "obj")
    vertices = [line.split()[1:] for line in data.decode().splitlines() if line.startswith("v ")]
    assert len(vertices) == 8
    for values in vertices:
        assert len(values) == 6
        assert values[3:] == ["0.78431373", "0.11764706", "0.03921569"]


def test_glb_keeps_vertex_colors(colored_cube):
    data, _, _ = export_mesh(colored_cube, "glb")
    back = trimesh.load(io.BytesIO(data), file_type="glb", process=False)
    mesh = next(iter(back.geometry.values()))
    assert mesh.visual.kind == "vertex"
    assert (np.asarray(mesh.visual.vertex_colors) == [200, 30, 10, 255]).all()


@pytest.mark.parametrize("fmt", ["stl", "3mf"])
def test_stl_and_3mf_stay_plain_for_colored_meshes(colored_cube, fmt):
    data, _, ext = export_mesh(colored_cube, fmt)
    back = trimesh.load(io.BytesIO(data), file_type=ext, force="mesh")
    assert len(back.faces) == 12
