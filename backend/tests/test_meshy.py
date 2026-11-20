"""Meshy (prompt and picture) against a simulated Meshy API: the requests Forma sends, the waits
it respects, the errors it explains, and that a create request is never sent twice."""

import dataclasses
import io
import json

import httpx
import numpy as np
import pytest
import trimesh
from fastapi.testclient import TestClient
from PIL import Image

from app.config import set_settings
from app.providers import register_provider
from app.providers.meshy import MeshyProvider

from .conftest import wait_job

KEY = "msy_forma_test_key_not_real"
ASSET = "https://assets.meshy.ai/tasks/model.glb"
ASSET_STL = "https://assets.meshy.ai/tasks/model.stl"


def _relief_stl() -> bytes:
    """A relief as Meshy's STL: a 60 x 40 mm plate 2 mm thick with a bump on it, Z up, in mm."""
    plate = trimesh.creation.box((60.0, 40.0, 2.0))
    plate.apply_translation([0, 0, 1.0])
    bump = trimesh.creation.icosphere(2, radius=8.0)
    bump.apply_scale([1.0, 1.0, 0.4])
    bump.apply_translation([0, 0, 2.0])
    return trimesh.exchange.stl.export_stl(trimesh.util.concatenate([plate, bump]))


def _glb() -> bytes:
    box = trimesh.creation.box((1.0, 2.0, 1.0))
    box.visual = trimesh.visual.ColorVisuals(box, vertex_colors=np.tile([200, 40, 30, 255], (8, 1)))
    return trimesh.exchange.gltf.export_glb(trimesh.Scene(box))


class FakeMeshy:
    """Meshy's API: tasks that take a couple of polls, then succeed (or what the test says)."""

    def __init__(self, fail_create=None, fail_task=None, flaky_polls=0):
        self.requests: list[httpx.Request] = []
        self.bodies: list[dict] = []
        self.polls: dict[str, int] = {}
        self.fail_create, self.fail_task, self.flaky = fail_create, fail_task, flaky_polls
        self.n = 0

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        url = str(request.url)
        if url == ASSET:
            return httpx.Response(200, content=_glb())
        if url == ASSET_STL:
            return httpx.Response(200, content=_relief_stl())
        if request.method == "POST":
            if isinstance(self.fail_create, Exception):
                raise self.fail_create
            if self.fail_create:
                return httpx.Response(self.fail_create, json={"message": "nope"})
            self.bodies.append(json.loads(request.content))
            self.n += 1
            return httpx.Response(202, json={"result": f"task{self.n}"})
        task_id = url.rsplit("/", 1)[-1]
        seen = self.polls[task_id] = self.polls.get(task_id, 0) + 1
        if seen <= self.flaky:
            return httpx.Response(503, text="busy")
        if seen - self.flaky == 1:
            return httpx.Response(200, headers={"Retry-After": "3"},
                                  json={"id": task_id, "status": "IN_PROGRESS", "progress": 40})
        if self.fail_task:
            return httpx.Response(200, json={"id": task_id, "status": "FAILED", "progress": 40,
                                             "task_error": {"message": self.fail_task}})
        return httpx.Response(200, json={"id": task_id, "status": "SUCCEEDED", "progress": 100,
                                         "model_urls": {"glb": ASSET, "stl": ASSET_STL}, "consumed_credits": 15})


def _png() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (320, 240), (90, 140, 200)).save(buf, "PNG")
    return buf.getvalue()


@pytest.fixture()
def meshy_app(settings):
    """The app with a Meshy key and Meshy among the picture models; the network is FakeMeshy."""
    s = dataclasses.replace(settings, meshy_api_key=KEY, image_to_3d="local:idol,hf_remote:*,meshy:*")
    set_settings(s)
    fake, sleeps = FakeMeshy(), []
    provider = MeshyProvider(s, transport=httpx.MockTransport(fake), sleep=sleeps.append)
    register_provider(provider)
    from app.main import create_app

    with TestClient(create_app(s)) as c:
        yield c, fake, sleeps, provider


def test_a_picture_goes_to_meshy_image_to_3d(meshy_app):
    client, fake, sleeps, _ = meshy_app
    r = client.post("/api/generate", data={"provider": "meshy", "model": "meshy-7.1", "quality": "high"},
                    files={"image": ("gufo.png", _png(), "image/png")})
    job = wait_job(client, r.json()["job_id"])
    assert job["status"] == "done", job
    (body,) = fake.bodies
    assert str(fake.requests[0].url) == "https://api.meshy.ai/openapi/v1/image-to-3d"
    assert body["image_url"].startswith("data:image/png;base64,")
    assert body | {"image_url": ""} == {
        "image_url": "", "ai_model": "meshy-7.1", "geometry_resolution": "4k", "should_texture": True,
        "texture_resolution": "4k", "enable_pbr": False, "should_remesh": False, "target_formats": ["glb"]}
    model = job["result"]
    assert model["provider"] == "meshy" and model["model"] == "meshy-7.1" and model["has_colors"]
    assert model["gen_meta"]["meshy_credits"] == 15 and model["gen_meta"]["meshy_task"] == "task1"
    assert sleeps == [3.0]  # Retry-After respected


def test_a_prompt_makes_the_shape_then_paints_it(meshy_app):
    client, fake, _, _ = meshy_app
    r = client.post("/api/generate", data={"prompt": "  un gufo di ceramica ", "provider": "meshy"})
    job = wait_job(client, r.json()["job_id"])
    assert job["status"] == "done", job
    preview, refine = fake.bodies
    # as on meshy.ai: the words as written, not translated
    assert preview == {"mode": "preview", "prompt": "un gufo di ceramica", "ai_model": "meshy-7.1",
                       "geometry_resolution": "2k", "should_remesh": False, "target_formats": ["glb"]}
    assert refine == {"mode": "refine", "preview_task_id": "task1", "texture_resolution": "2k",
                      "enable_pbr": False, "target_formats": ["glb"]}
    meta = job["result"]["gen_meta"]
    assert meta["meshy_credits"] == 30 and "prompt_en" not in meta
    assert job["result"]["prompt"] == "un gufo di ceramica"
    assert [str(r.url) for r in fake.requests if r.method == "POST"] == [
        "https://api.meshy.ai/openapi/v2/text-to-3d"] * 2  # straight to Text to 3D, no FLUX


def test_meshy_makes_no_preview_picture(meshy_app):
    client, fake, _, _ = meshy_app
    r = client.post("/api/image", data={"prompt": "un gufo", "provider": "meshy"})
    assert r.status_code == 502 and "anteprima" in r.json()["detail"]
    assert fake.requests == []


def test_the_key_goes_to_the_api_and_never_to_the_file_storage(meshy_app):
    client, fake, _, _ = meshy_app
    wait_job(client, client.post("/api/generate", data={"provider": "meshy", "model": "meshy-7.1"},
                                 files={"image": ("g.png", _png(), "image/png")}).json()["job_id"])
    for req in fake.requests:
        if str(req.url) == ASSET:
            assert "authorization" not in req.headers
        else:
            assert req.headers["authorization"] == f"Bearer {KEY}"


@pytest.mark.parametrize(("code", "words"), [(401, "Chiave Meshy non valida"), (402, "Crediti Meshy esauriti"),
                                             (400, "non accetta la richiesta: nope")])
def test_meshy_errors_are_explained(meshy_app, code, words):
    client, fake, _, _ = meshy_app
    fake.fail_create = code
    job = wait_job(client, client.post("/api/generate", data={"provider": "meshy", "model": "meshy-7.1"},
                                       files={"image": ("g.png", _png(), "image/png")}).json()["job_id"])
    assert job["status"] == "error" and words in job["error"]


def test_a_failed_task_says_why_and_that_credits_came_back(meshy_app):
    client, fake, _, _ = meshy_app
    fake.fail_task = "image not recognizable"
    job = wait_job(client, client.post("/api/generate", data={"provider": "meshy", "model": "meshy-7.1"},
                                       files={"image": ("g.png", _png(), "image/png")}).json()["job_id"])
    assert job["status"] == "error"
    assert "image not recognizable" in job["error"] and "restituiti" in job["error"]


def test_a_create_that_times_out_is_never_sent_again(meshy_app):
    """Meshy may have made (and billed) the task: Forma says so and does not resend it."""
    client, fake, _, _ = meshy_app
    fake.fail_create = httpx.ReadTimeout("slow")
    job = wait_job(client, client.post("/api/generate", data={"provider": "meshy", "model": "meshy-7.1"},
                                       files={"image": ("g.png", _png(), "image/png")}).json()["job_id"])
    assert job["status"] == "error" and "prima di riprovare" in job["error"]
    assert sum(1 for r in fake.requests if r.method == "POST") == 1


def test_busy_polls_are_asked_again(meshy_app):
    client, fake, _, _ = meshy_app
    fake.flaky = 2  # two 503s while waiting: not a failure
    job = wait_job(client, client.post("/api/generate", data={"provider": "meshy", "model": "meshy-7.1"},
                                       files={"image": ("g.png", _png(), "image/png")}).json()["job_id"])
    assert job["status"] == "done", job
    assert fake.polls["task1"] == 4


def test_meshy_is_a_choice_for_pictures_and_says_when_it_lacks_a_key(settings):
    from app.main import create_app

    s = dataclasses.replace(settings, image_to_3d="local:idol,hf_remote:*,meshy:*")  # no key
    set_settings(s)
    from app.providers import reset_providers

    reset_providers()
    with TestClient(create_app(s)) as c:
        data = c.get("/api/providers").json()
        route = next(r for r in data["image_routes"] if r["provider"] == "meshy")
        assert route["model"] == "meshy-7.1" and route["available"] is False
        assert "MESHY_API_KEY" in route["reason"]
        assert any(p["name"] == "meshy" for p in data["providers"])
        r = c.post("/api/generate", data={"provider": "meshy", "model": "meshy-7.1"},
                   files={"image": ("g.png", _png(), "image/png")})
        assert r.status_code == 409 and "MESHY_API_KEY" in r.json()["detail"]


# -- Relief: a bas-relief from a photo ----------------------------------------------------------


def _relief(client, options, quality="standard", size=100, photo=True):
    data = {"relief": json.dumps(options), "quality": quality,
            "settings": json.dumps({"target_size_mm": size})}
    files = {"image": ("ritratto.png", _png(), "image/png")} if photo else None
    return client.post("/api/generate", data=data, files=files)


def test_a_photo_becomes_a_relief_at_the_size_of_the_print(meshy_app):
    client, fake, _, _ = meshy_app
    r = _relief(client, {"variant": "high", "carving_mode": "emboss", "carving_depth_mm": 5,
                         "base_thickness_mm": 2}, quality="high", size=120)
    job = wait_job(client, r.json()["job_id"])
    assert job["status"] == "done", job
    (body,) = fake.bodies
    assert str(fake.requests[0].url) == "https://api.meshy.ai/openapi/v1/relief"
    assert body.pop("image_url").startswith("data:image/png;base64,")
    assert body == {"variant": "high", "carving_mode": "emboss", "remove_base": False, "size_mm": 120.0,
                    "mesh_resolution": 2048, "bend_mode": "off", "should_generate_model": True,
                    "carving_depth_mm": 5.0, "base_thickness_mm": 2.0}
    model = job["result"]
    assert model["provider"] == "meshy" and model["model"] == "relief"
    assert model["gen_meta"]["relief_variant"] == "high" and model["gen_meta"]["meshy_credits"] == 15
    x, y, z = model["report"]["bbox_mm"]
    assert max(x, y, z) == pytest.approx(120, abs=0.5) and z < min(x, y)  # lying flat, face up
    assert model["settings"]["orientation"] == "keep"


def test_relief_options_without_base_and_bent(meshy_app):
    client, fake, _, _ = meshy_app
    r = _relief(client, {"variant": "low", "carving_mode": "engrave", "remove_base": True,
                         "bend_mode": "convex", "bend_angle": 90}, quality="draft")
    assert wait_job(client, r.json()["job_id"])["status"] == "done"
    (body,) = fake.bodies
    assert "base_thickness_mm" not in body and body["remove_base"] is True
    assert body["bend_mode"] == "convex" and body["bend_axis"] == "xz" and body["bend_angle"] == 90.0
    assert body["mesh_resolution"] == 512 and "carving_depth_mm" not in body  # Meshy's own default


@pytest.mark.parametrize(("options", "words"), [
    ({"variant": "deep"}, "stile"),
    ({"carving_depth_mm": 70}, "da 0 a 60"),
    ({"remove_base": True, "carving_depth_mm": 0}, "sarebbe vuoto"),
    ({"base_thickness_mm": 0.05}, "da 0.1 a 10"),
    ({"bend_mode": "convex", "bend_angle": 400}, "da 0 a 360"),
])
def test_relief_options_meshy_would_refuse_or_bill_for_nothing_are_stopped_here(meshy_app, options, words):
    client, fake, _, _ = meshy_app
    r = _relief(client, options)
    assert r.status_code == 422 and words in r.json()["detail"]
    assert fake.requests == []  # nothing sent, nothing billed


def test_a_relief_needs_a_photo_and_a_key(meshy_app, settings):
    client, fake, _, _ = meshy_app
    r = _relief(client, {}, photo=False)
    assert r.status_code == 422 and "foto" in r.json()["detail"]
    from app.main import create_app
    from app.providers import reset_providers

    set_settings(settings)  # Meshy without a key
    reset_providers()
    with TestClient(create_app(settings)) as c:
        r = _relief(c, {})
        assert r.status_code == 409 and "MESHY_API_KEY" in r.json()["detail"]
