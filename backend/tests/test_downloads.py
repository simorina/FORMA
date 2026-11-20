"""Downloads with progress: the file is written and checked as a job, served once, then gone."""

import io
import time

import pytest
import trimesh

from app.exporters import ExportError

from .conftest import wait_job


@pytest.fixture()
def model(client):
    r = client.post("/api/generate", data={"prompt": "vaso", "provider": "procedural"})
    job = wait_job(client, r.json()["job_id"])
    assert job["status"] == "done", job
    return job["result"]


def _wait_export(client, export_id, timeout=60):
    seen = []
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = client.get(f"/api/exports/{export_id}").json()
        seen.append(job["progress"])
        if job["status"] != "running":
            return job, seen
        time.sleep(0.05)
    raise AssertionError("export timed out")


@pytest.mark.parametrize("fmt", ["3mf", "stl", "obj", "glb"])
def test_an_export_is_prepared_checked_then_served_once(client, model, fmt):
    start = client.post(f"/api/models/{model['id']}/export", params={"format": fmt})
    assert start.status_code == 200, start.text
    job, seen = _wait_export(client, start.json()["id"])
    assert job["status"] == "ready" and job["progress"] == 1.0, job
    assert seen == sorted(seen)  # the bar never goes back
    assert job["filename"].endswith(f"-100mm.{fmt}") and "verificato" in job["message"]
    r = client.get(job["url"])
    assert r.status_code == 200
    assert int(r.headers["content-length"]) == job["size"] == len(r.content)
    assert f'filename="{job["filename"]}"' in r.headers["content-disposition"]
    back = trimesh.load(io.BytesIO(r.content), file_type=fmt, force="mesh", process=False)
    assert len(back.faces) == model["report"]["triangles"]
    # served once: the file and the job are gone
    assert client.get(job["url"]).status_code == 404
    assert client.get(f"/api/exports/{job['id']}").status_code == 404


def test_a_file_that_fails_its_check_is_never_served(client, model, monkeypatch):
    def failing(path, fmt, mesh, progress=None):
        raise ExportError("Il file OBJ non ha superato il controllo (prova): non te lo do corrotto.")
    monkeypatch.setattr("app.exporters.verify_export", failing)
    job, _ = _wait_export(client, client.post(f"/api/models/{model['id']}/export", params={"format": "obj"}).json()["id"])
    assert job["status"] == "error" and "controllo" in job["error"]
    assert client.get(job["url"]).status_code == 409


def test_an_export_can_be_cancelled(client, model):
    started = client.post(f"/api/models/{model['id']}/export", params={"format": "3mf"}).json()
    assert client.delete(f"/api/exports/{started['id']}").json() == {"ok": True}
    deadline = time.time() + 30
    while time.time() < deadline:
        r = client.get(f"/api/exports/{started['id']}")
        if r.status_code == 404 or r.json()["status"] in ("cancelled", "ready"):
            break
        time.sleep(0.05)
    assert r.status_code == 404 or r.json()["status"] != "running"
    assert client.get(started["url"]).status_code in (404, 409) or r.json()["status"] == "ready"


def test_bad_requests(client, model):
    assert client.post(f"/api/models/{model['id']}/export", params={"format": "fbx"}).status_code == 422
    assert client.post("/api/models/000000000000/export", params={"format": "obj"}).status_code == 404
    assert client.get("/api/exports/nope").status_code == 404


def test_the_direct_link_is_checked_too(client, model):
    r = client.get(f"/api/export/{model['id']}", params={"format": "obj"})
    assert r.status_code == 200 and int(r.headers["content-length"]) == len(r.content)
    back = trimesh.load(io.BytesIO(r.content), file_type="obj", force="mesh", process=False)
    assert len(back.faces) == model["report"]["triangles"]
