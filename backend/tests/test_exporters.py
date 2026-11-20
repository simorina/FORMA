import io
import json
import struct
import zipfile

import numpy as np
import pytest
import trimesh

from app import exporters
from app.exporters import ExportError, export_mesh, verify_export, write_export


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
        assert [float(x) for x in values[3:]] == pytest.approx([200 / 255, 30 / 255, 10 / 255], abs=1e-4)


def _glb_parts(data: bytes) -> tuple[dict, bytes]:
    n = struct.unpack("<I", data[12:16])[0]
    gltf = json.loads(data[20:20 + n])
    return gltf, data[20 + n + 8:]


def test_glb_keeps_vertex_colors_in_linear_light_as_gltf_asks(colored_cube):
    """glTF reads COLOR_0 as linear: sRGB bytes there made Blender show a red as pale pink.
    16 bits per channel, and back to sRGB they are the model's colours."""
    data, _, _ = export_mesh(colored_cube, "glb")
    gltf, blob = _glb_parts(data)
    prim = gltf["meshes"][0]["primitives"][0]
    acc = gltf["accessors"][prim["attributes"]["COLOR_0"]]
    assert (acc["componentType"], acc["type"], acc["normalized"]) == (5123, "VEC4", True)
    view = gltf["bufferViews"][acc["bufferView"]]
    rgba = np.frombuffer(blob, "<u2", acc["count"] * 4, view["byteOffset"]).reshape(-1, 4) / 65535.0
    lin = rgba[:, :3]
    srgb = np.where(lin <= 0.0031308, lin * 12.92, 1.055 * lin ** (1 / 2.4) - 0.055) * 255
    assert np.abs(srgb - [200, 30, 10]).max() < 0.5 and (rgba[:, 3] == 1).all()
    material = gltf["materials"][prim["material"]]["pbrMetallicRoughness"]
    assert material["metallicFactor"] == 0  # the glTF default, with no material, is a metal
    back = trimesh.load(io.BytesIO(data), file_type="glb", force="mesh", process=False)
    assert len(back.faces) == 12


@pytest.mark.parametrize("fmt", ["stl", "3mf"])
def test_stl_and_3mf_stay_plain_for_colored_meshes(colored_cube, fmt):
    data, _, ext = export_mesh(colored_cube, fmt)
    back = trimesh.load(io.BytesIO(data), file_type=ext, force="mesh")
    assert len(back.faces) == 12


# -- every file is read back and checked before it is served ----------------------------------


@pytest.mark.parametrize("fmt", ["stl", "3mf", "obj", "glb"])
def test_every_format_is_written_whole_and_reads_back(colored_cube, fmt, tmp_path):
    path = tmp_path / f"m.{fmt}"
    writes, checks = [], []
    write_export(colored_cube, fmt, path, writes.append, checks.append)
    assert writes[-1] == pytest.approx(1.0) and checks[-1] == pytest.approx(1.0)
    assert writes == sorted(writes)  # the bar only moves forward
    back = trimesh.load(path, file_type=fmt, force="mesh", process=False)
    assert len(back.faces) == 12


def _break(path, how):
    data = bytearray(path.read_bytes())
    if how == "truncate":
        data = data[: len(data) - 30]
    elif how == "flip":
        mid = len(data) // 2
        data[mid] ^= 0xFF
    path.write_bytes(bytes(data))


@pytest.mark.parametrize(("fmt", "how", "why"), [
    ("stl", "truncate", "triangoli"),
    ("obj", "truncate", "attesi"),
    ("3mf", "flip", ""),
    ("3mf", "truncate", ""),
    ("glb", "truncate", ""),
])
def test_a_damaged_file_never_passes_the_check(cube, tmp_path, fmt, how, why):
    path = tmp_path / f"m.{fmt}"
    write_export(cube, fmt, path)
    _break(path, how)
    with pytest.raises(ExportError, match=why or "controllo"):
        verify_export(path, fmt, cube)


def test_a_file_of_another_model_never_passes_the_check(cube, tmp_path):
    path = tmp_path / "m.obj"
    write_export(cube, "obj", path)
    bigger = trimesh.creation.icosphere(1)
    with pytest.raises(ExportError, match="attesi"):
        verify_export(path, "obj", bigger)


def test_a_failed_check_leaves_no_file(cube, tmp_path, monkeypatch):
    def broken(mesh, path, progress):
        path.write_text("v 0 0 0" + chr(10))  # a writer that stops halfway
    monkeypatch.setitem(exporters.WRITERS, "obj", broken)
    path = tmp_path / "m.obj"
    with pytest.raises(ExportError):
        write_export(cube, "obj", path)
    assert not path.exists()


@pytest.mark.parametrize("fmt", ["obj", "3mf"])
def test_lines_split_between_read_blocks_are_counted_once(fmt, tmp_path, monkeypatch):
    """The check reads big files in blocks: a line cut by a block boundary must count once
    (a 7-byte block cuts almost every line)."""
    sphere = trimesh.creation.icosphere(2)
    path = tmp_path / f"m.{fmt}"
    write_export(sphere, fmt, path)
    monkeypatch.setattr(exporters, "BLOCK", 7)
    verify_export(path, fmt, sphere)
