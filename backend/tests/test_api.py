import io
import struct

import pytest
import trimesh
from PIL import Image

from app.config import Settings
from app.providers import register_provider
from app.providers.endpoints.common import extract_path
from app.providers.hf_remote import HFRemoteProvider

from .conftest import wait_job


def test_health(client):
    assert client.get("/api/health").json()["ok"] is True


def test_providers_list(client):
    data = client.get("/api/providers").json()
    names = {p["name"] for p in data["providers"]}
    assert names == {"hf_remote", "local", "procedural"}
    hf = next(p for p in data["providers"] if p["name"] == "hf_remote")
    keys = [m["key"] for m in hf["models"]]
    assert keys[0] == "trellis2"
    assert next(m for m in hf["models"] if m["default"])["key"] == "trellis2"
    assert data["default"] == "procedural"
    assert data["hf_token"] is False
    local = next(p for p in data["providers"] if p["name"] == "local")
    assert local["available"] is False  # no CUDA in CI


def test_generate_text_procedural_full_flow(client):
    r = client.post("/api/generate", data={"prompt": "un vaso", "settings": '{"target_size_mm": 80}'})
    assert r.status_code == 200, r.text
    job = wait_job(client, r.json()["job_id"])
    assert job["status"] == "done", job
    assert [s["status"] for s in job["stages"]] == ["done"] * 4
    assert job["progress"] == 1.0
    model = job["result"]
    assert model["report"]["watertight"]
    assert max(model["report"]["bbox_mm"]) == pytest.approx(80, rel=1e-3)
    # intermediate image, thumbnail, preview mesh
    assert client.get(model["urls"]["image"]).headers["content-type"] == "image/png"
    assert client.get(model["urls"]["thumb"]).status_code == 200
    glb = client.get(f"/api/models/{model['id']}/mesh.glb")
    assert glb.content[:4] == b"glTF"
    # history
    models = client.get("/api/models").json()["models"]
    assert models[0]["id"] == model["id"]


@pytest.mark.parametrize("fmt,magic", [("stl", None), ("3mf", b"PK"), ("obj", b"#"), ("glb", b"glTF")])
def test_export_formats(client, fmt, magic):
    job = wait_job(client, client.post("/api/generate", data={"prompt": "cubo"}).json()["job_id"])
    mid = job["result"]["id"]
    r = client.get(f"/api/export/{mid}", params={"format": fmt})
    assert r.status_code == 200
    assert "attachment" in r.headers["content-disposition"]
    assert f".{fmt}" in r.headers["content-disposition"]
    if magic:
        assert r.content.startswith(magic)
    else:
        (count,) = struct.unpack("<I", r.content[80:84])
        assert len(r.content) == 84 + 50 * count


def test_export_errors(client):
    assert client.get("/api/export/000000000000?format=stl").status_code == 404
    assert client.get("/api/export/000000000000?format=fbx").status_code == 422
    assert client.get("/api/export/..%2f..?format=stl").status_code == 404


def test_generate_requires_input(client):
    assert client.post("/api/generate", data={"prompt": "  "}).status_code == 422
    assert client.post("/api/generate", data={"prompt": "x", "provider": "nope"}).status_code == 422


def test_generate_rejects_bad_image(client):
    r = client.post("/api/generate", files={"image": ("a.png", b"not an image", "image/png")})
    assert r.status_code == 422


def test_generate_from_uploaded_image(client):
    buf = io.BytesIO()
    Image.new("RGB", (64, 64), "white").save(buf, "PNG")
    r = client.post("/api/generate", files={"image": ("a.png", buf.getvalue(), "image/png")})
    job = wait_job(client, r.json()["job_id"])
    assert job["status"] == "done"
    assert job["result"]["kind"] == "image"
    assert job["stages"][0]["message"] == "Immagine caricata"


def test_reprocess_and_edit(client):
    job = wait_job(client, client.post("/api/generate", data={"prompt": "sfera"}).json()["job_id"])
    mid = job["result"]["id"]
    r = client.post("/api/process", data={"model_id": mid, "settings": '{"target_size_mm": 42, "base_plate": true}'})
    assert r.status_code == 200, r.text
    assert r.json()["id"] == mid
    assert r.json()["report"]["base_plate"] is True
    # edited mesh upload (as the viewer does): binary STL, Z-up mm
    edited = trimesh.creation.icosphere()
    edited.apply_scale(20)
    stl = trimesh.exchange.stl.export_stl(edited)
    r = client.post("/api/process", data={"model_id": mid, "settings": "{}"},
                    files={"file": ("edit.stl", stl, "model/stl")})
    assert r.status_code == 200, r.text
    new = r.json()
    assert new["id"] != mid and new["parent_id"] == mid and new["kind"] == "edit"
    assert new["report"]["watertight"]
    assert client.delete(f"/api/models/{new['id']}").json()["ok"]
    assert client.get(f"/api/models/{new['id']}").status_code == 404


def test_process_rejects_bad_upload(client):
    r = client.post("/api/process", files={"file": ("x.fbx", b"abc", "application/octet-stream")})
    assert r.status_code == 422
    assert client.post("/api/process", data={"model_id": "abcdefabcdef"}).status_code == 404


# --- hf_remote with a mocked Gradio client ------------------------------------------------


class FakeJob:
    def __init__(self, value):
        self.value = value

    def done(self):
        return True

    def status(self):
        return None

    def result(self):
        return self.value

    def cancel(self):
        pass


class FakeClient:
    def __init__(self, space, tmp_path, calls):
        self.space = space
        self.tmp = tmp_path
        self.calls = calls

    def submit(self, api_name, **kwargs):
        self.calls.append((self.space, api_name, kwargs))
        if api_name == "/infer":
            p = self.tmp / "flux.png"
            Image.new("RGB", (256, 256), (200, 190, 180)).save(p)
            return FakeJob((str(p), 0))
        if api_name == "/preprocess_image":
            p = self.tmp / "pre.png"
            Image.new("RGBA", (256, 256)).save(p)
            return FakeJob(str(p))
        if api_name == "/image_to_3d":
            return FakeJob(({"state": 1}, "<html>"))
        if api_name in ("/extract_glb", "/shape_generation"):
            p = self.tmp / "out.glb"
            mesh = trimesh.creation.capsule(height=1.0, radius=0.3)  # tall along Z
            mesh.apply_transform(trimesh.transformations.rotation_matrix(-1.5707963, [1, 0, 0]))
            assert mesh.extents[1] == mesh.extents.max()  # now tall along Y, like glTF
            mesh.export(p)
            return FakeJob(({"path": str(p)}, str(p)) if api_name == "/extract_glb" else (
                {"value": str(p)}, "<html>", {}, 1))
        raise AssertionError(f"unexpected api {api_name}")


@pytest.fixture()
def remote(settings, tmp_path):
    calls = []
    s = Settings(**{**settings.__dict__, "gen_provider": "hf_remote"})
    provider = HFRemoteProvider(s, client_factory=lambda space: FakeClient(space, tmp_path, calls))
    register_provider(provider)
    return calls


@pytest.mark.parametrize("model", ["trellis2", "hunyuan3d-2.1"])
def test_hf_remote_text_to_3d_mocked(client, remote, model):
    r = client.post("/api/generate", data={"prompt": "un gufo", "provider": "hf_remote",
                                           "model": model, "seed": 7})
    job = wait_job(client, r.json()["job_id"])
    assert job["status"] == "done", job
    apis = [c[1] for c in remote]
    assert apis[0] == "/infer"
    flux_prompt = remote[0][2]["prompt"]
    assert flux_prompt.startswith("un gufo") and "single object" in flux_prompt
    if model == "trellis2":
        assert apis[1:] == ["/preprocess_image", "/image_to_3d", "/extract_glb"]
        assert remote[2][2]["seed"] == 7 and remote[2][2]["resolution"] == "1024"
    else:
        assert apis[1:] == ["/shape_generation"]
    # capsule is Y-up (height along Y) -> after conversion the tallest axis must be Z
    bbox = job["result"]["report"]["bbox_mm"]
    assert bbox[2] == max(bbox)


def test_hf_remote_error_is_friendly(client, settings, tmp_path):
    class Boom(FakeClient):
        def submit(self, api_name, **kwargs):
            raise RuntimeError("You have exceeded your GPU quota (ZeroGPU)")

    s = Settings(**{**settings.__dict__, "gen_provider": "hf_remote"})
    register_provider(HFRemoteProvider(s, client_factory=lambda sp: Boom(sp, tmp_path, [])))
    job = wait_job(client, client.post("/api/generate", data={"prompt": "x", "provider": "hf_remote"}).json()["job_id"])
    assert job["status"] == "error"
    assert "Quota GPU" in job["error"]
    assert any(s["status"] == "error" for s in job["stages"])


def test_extract_path_variants():
    assert extract_path(("a.png", {"path": "b.glb"}), (".glb",)) == "b.glb"
    assert extract_path({"value": {"path": "c.obj"}}, (".obj",)) == "c.obj"
    assert extract_path(None) is None
