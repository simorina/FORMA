"""'Apri in Blender': the model's GLB, written and checked, and Blender started on it with the
script that empties the scene, imports it and turns the colours on."""

import dataclasses
import json
import os
import struct

import pytest
from fastapi.testclient import TestClient

from app import blender
from app.config import set_settings

from .conftest import wait_job


@pytest.fixture()
def started(monkeypatch):
    calls = []
    monkeypatch.setattr(blender.subprocess, "Popen", lambda args, **kw: calls.append(args))
    return calls


def _client(settings, exe: str) -> TestClient:
    s = dataclasses.replace(settings, blender_path=exe)
    set_settings(s)
    from app.main import create_app

    return TestClient(create_app(s))


def _model(client: TestClient) -> str:
    r = client.post("/api/generate", data={"prompt": "un vaso", "provider": "procedural"})
    return wait_job(client, r.json()["job_id"])["result"]["id"]


def test_blender_opens_the_glb_with_the_colour_script(settings, tmp_path, started):
    exe = tmp_path / "blender.exe"
    exe.write_bytes(b"")
    with _client(settings, str(exe)) as client:
        assert client.get("/api/providers").json()["blender"] is True
        model_id = _model(client)
        r = client.post(f"/api/models/{model_id}/blender")
    assert r.status_code == 200, r.text
    (args,) = started
    assert args[0] == str(exe) and args[1] == "--python" and args[3] == "--"
    script, glb = args[2], args[4]
    text = open(script, encoding="utf-8").read()
    assert 'shading.type = "MATERIAL"' in text and "objects.remove" in text and "view_selected" in text
    data = open(glb, "rb").read()
    assert data[:4] == b"glTF"
    n = struct.unpack("<I", data[12:16])[0]
    gltf = json.loads(data[20:20 + n])
    assert "POSITION" in gltf["meshes"][0]["primitives"][0]["attributes"]


def test_without_blender_the_button_is_hidden_and_the_call_explains(settings, tmp_path, started):
    with _client(settings, str(tmp_path / "manca.exe")) as client:
        assert client.get("/api/providers").json()["blender"] is False
        model_id = _model(client)
        r = client.post(f"/api/models/{model_id}/blender")
    assert r.status_code == 409 and "BLENDER_PATH" in r.json()["detail"]
    assert started == []


def test_an_unknown_model_is_404(settings, tmp_path, started):
    exe = tmp_path / "blender.exe"
    exe.write_bytes(b"")
    with _client(settings, str(exe)) as client:
        assert client.post("/api/models/nessuno/blender").status_code == 404
    assert started == []


def test_only_the_latest_glbs_are_kept(tmp_path):
    folder = tmp_path / "blender"
    folder.mkdir()
    for i in range(6):
        p = folder / f"m{i}.glb"
        p.write_bytes(b"x")
        old = 1_000_000 + i
        os.utime(p, (old, old))
    blender._tidy(folder)
    assert sorted(p.name for p in folder.glob("*.glb")) == ["m3.glb", "m4.glb", "m5.glb"]
