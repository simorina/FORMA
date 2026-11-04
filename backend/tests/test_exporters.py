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
