"""Colours through the API: uploads, "Applica", the viewer's mesh and the exports."""

import io

import numpy as np
import trimesh

RED = [255, 0, 0, 255]


def ply(mesh: trimesh.Trimesh) -> bytes:
    return trimesh.exchange.ply.export_ply(mesh)


def red_sphere() -> trimesh.Trimesh:
    m = trimesh.creation.icosphere(subdivisions=3)
    m.visual = trimesh.visual.ColorVisuals(m, vertex_colors=np.tile(RED, (len(m.vertices), 1)))
    return m


def upload(client, name: str, data: bytes, **form) -> dict:
    r = client.post("/api/process", files={"file": (name, data, "application/octet-stream")}, data=form)
    assert r.status_code == 200, r.text
    return r.json()


def viewer_mesh(client, model: dict) -> trimesh.Trimesh:
    r = client.get(model["urls"]["mesh"])
    assert r.status_code == 200
    scene = trimesh.load(io.BytesIO(r.content), file_type="glb", process=False)
    return next(iter(scene.geometry.values()))


def test_colored_upload_keeps_its_colors(client):
    model = upload(client, "palla.ply", ply(red_sphere()))
    assert model["has_colors"] is True
    mesh = viewer_mesh(client, model)
    assert mesh.visual.kind == "vertex"
    assert (np.asarray(mesh.visual.vertex_colors) == RED).all()
    obj = client.get(model["urls"]["export"]["obj"]).content.decode()
    assert all(len(line.split()) == 7 for line in obj.splitlines() if line.startswith("v "))


def test_plain_model_reports_no_colors_after_applica(client):
    stl = trimesh.exchange.stl.export_stl(trimesh.creation.box((20, 20, 20)))
    model = upload(client, "cubo.stl", stl)
    assert model["has_colors"] is False
    r = client.post("/api/process", data={"model_id": model["id"], "settings": "{}"})
    assert r.status_code == 200, r.text
    assert r.json()["has_colors"] is False


BLUE = [0, 0, 255, 255]
KEEP = '{"orientation": "keep"}'


def red_blue_sphere() -> trimesh.Trimesh:
    """Red on -X, blue on +X."""
    m = trimesh.creation.icosphere(subdivisions=3)
    colors = np.where(m.vertices[:, :1] < 0, RED, BLUE)
    m.visual = trimesh.visual.ColorVisuals(m, vertex_colors=colors)
    return m


def test_edit_takes_colors_from_its_model(client):
    """The editor sends an STL (no colours): the edit gets them back from its model."""
    model = upload(client, "palla.ply", ply(red_blue_sphere()), settings=KEEP)
    stl = client.get(model["urls"]["export"]["stl"]).content
    edit = upload(client, "modifica.stl", stl, model_id=model["id"], settings=KEEP)
    assert edit["kind"] == "edit"
    assert edit["has_colors"] is True
    mesh = viewer_mesh(client, edit)
    colors = np.asarray(mesh.visual.vertex_colors)
    x = mesh.vertices[:, 0]
    assert (colors[x < -5] == RED).all()
    assert (colors[x > 5] == BLUE).all()


def test_edit_of_a_plain_model_stays_plain(client):
    stl = trimesh.exchange.stl.export_stl(trimesh.creation.box((20, 20, 20)))
    model = upload(client, "cubo.stl", stl)
    edit = upload(client, "modifica.stl", stl, model_id=model["id"])
    assert edit["has_colors"] is False
