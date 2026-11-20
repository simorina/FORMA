"""Idol on the local GPU: its Gaussians become a closed, coloured solid, and the API runs it for a
photo, a generated picture or a prompt (the GPU part simulated: the tests need no CUDA). An
uploaded picture goes to Idol and nowhere else."""

import dataclasses
import io

import numpy as np
import pytest
import trimesh
from PIL import Image

from app.config import set_settings
from app.pipeline.colors import vertex_colors
from app.pipeline.repair import is_print_ok
from app.pipeline.splats import Splats, density_grid, sh_to_rgb, sphere_splats, splats_to_mesh
from app.providers import register_provider
from app.providers.local import LocalProvider

from .conftest import wait_job
from .test_api import remote  # noqa: F401 - the simulated Spaces (fixture)


def test_a_splat_becomes_a_closed_solid_of_the_same_size_and_colours():
    mesh = splats_to_mesh(sphere_splats(20_000), resolution=128)
    assert is_print_ok(mesh)  # closed, consistently wound, valid for manifold3d
    radius = np.linalg.norm(mesh.vertices, axis=1)
    assert radius.mean() == pytest.approx(0.4, rel=0.03)  # the Gaussians lie on r = 0.4
    assert mesh.volume == pytest.approx(4 / 3 * np.pi * 0.4**3, rel=0.08)  # filled, not a shell
    colors = vertex_colors(mesh)
    top, bottom = mesh.vertices[:, 2] > 0.2, mesh.vertices[:, 2] < -0.2
    np.testing.assert_allclose(colors[top, :3].mean(axis=0), [220, 30, 30], atol=3)
    np.testing.assert_allclose(colors[bottom, :3].mean(axis=0), [30, 30, 220], atol=3)


def test_the_density_of_one_gaussian_peaks_at_its_opacity():
    one = Splats(xyz=np.array([[0.0, 0.0, 0.0], [1.0, 1.0, 1.0]]), scales=np.full((2, 3), 0.05),
                 rotations=np.array([[1.0, 0, 0, 0], [1.0, 0, 0, 0]]), opacity=np.array([0.8, 0.8]),
                 colors=np.zeros((2, 3), dtype=np.uint8))
    grid, origin, cell = density_grid(one, 64, gpu=False)
    i = np.round((np.zeros(3) - origin) / cell).astype(int)
    assert grid[tuple(i)] == pytest.approx(0.8, rel=0.02)
    assert grid.max() == pytest.approx(0.8, rel=0.02)


def test_the_gpu_adds_up_the_same_density_as_the_cpu():
    torch = pytest.importorskip("torch")
    if not torch.cuda.is_available():
        pytest.skip("no CUDA GPU")
    s = sphere_splats(30_000)
    cpu, _, _ = density_grid(s, 128, gpu=False)
    gpu, _, _ = density_grid(s, 128, gpu=True)
    np.testing.assert_allclose(gpu, cpu, atol=2e-3)


def test_spherical_harmonics_become_colours():
    np.testing.assert_array_equal(sh_to_rgb(np.array([[0.0, 0.0, 0.0], [10.0, -10.0, 0.0]])),
                                  [[128, 128, 128], [255, 0, 128]])


class FakeIdol:
    """The GPU part of Idol: records what it is asked and gives back a known splat."""

    def __init__(self):
        self.calls = []

    def generate(self, image, mode, seed, quality, progress):
        self.calls.append({"mode": mode, "seed": seed, "quality": quality, "size": image.size})
        progress(1.0, "Gaussiane pronte")
        return sphere_splats(20_000), image


class FakeRemote:
    """FLUX on Hugging Face, for the prompts the local provider cannot draw on an 8 GB GPU."""

    def __init__(self):
        self.prompts = []

    def image(self, prompt, seed=0, progress=lambda *a: None):
        self.prompts.append(prompt)
        return Image.new("RGB", (512, 512), (200, 120, 80))

    def english(self, prompt):
        return prompt


@pytest.fixture()
def settings(settings):
    """As in the app: an uploaded picture goes to Idol on this GPU, or to TRELLIS.2 when chosen."""
    s = dataclasses.replace(settings, image_to_3d="local:idol,hf_remote:trellis2")
    set_settings(s)
    return s


@pytest.fixture()
def idol(settings, monkeypatch):
    monkeypatch.setattr(LocalProvider, "available", lambda self: (True, ""))
    monkeypatch.setattr("app.providers.idol_local.IdolRunner.installed", staticmethod(lambda: True))
    monkeypatch.setattr("app.providers.local.IDOL_QUALITY", {q: (1, 1, 128) for q in ("draft", "standard", "high")})
    provider = LocalProvider(settings)
    provider._idol = FakeIdol()
    provider._hf = FakeRemote()
    monkeypatch.setattr(provider, "_remote_images", lambda: True)
    register_provider(provider)
    return provider


def _png() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (640, 480), (90, 140, 200)).save(buf, "PNG")
    return buf.getvalue()


@pytest.mark.parametrize(("kind", "mode"), [("", "real"), ("real", "real"), ("synthetic", "synthetic")])
def test_a_picture_goes_to_idol_on_the_gpu_and_comes_back_a_coloured_print(client, idol, kind, mode):
    r = client.post("/api/generate", data={"provider": "local", "model": "idol", "seed": 5,
                                           "quality": "high", "image_kind": kind},
                    files={"image": ("gufo.png", _png(), "image/png")})
    job = wait_job(client, r.json()["job_id"])
    assert job["status"] == "done", job
    assert idol._idol.calls == [{"mode": mode, "seed": 5, "quality": "high", "size": (640, 480)}]
    model = job["result"]
    assert model["model"] == "idol" and model["has_colors"] and model["kind"] == "image"
    assert model["report"]["watertight"] and model["report"]["components"] == 1
    assert model["gen_meta"]["idol_mode"] == mode and model["gen_meta"]["up"] == "z"


def test_a_prompt_gets_its_picture_from_flux_and_its_shape_from_idol(client, idol):
    r = client.post("/api/generate", data={"prompt": "un gufo", "provider": "local", "model": "idol"})
    job = wait_job(client, r.json()["job_id"])
    assert job["status"] == "done", job
    assert idol._hf.prompts == ["un gufo"]
    assert idol._idol.calls[0]["mode"] == "synthetic"  # a generated picture, not a photo
    assert job["result"]["has_image"]


@pytest.mark.parametrize(("provider", "model"), [("hf_remote", "pixal3d"), ("hf_remote", ""),
                                                ("procedural", ""), ("local", "trellis2"), ("", "")])
def test_a_picture_asking_for_a_model_not_allowed_goes_to_idol(client, idol, provider, model):
    r = client.post("/api/generate", data={"provider": provider, "model": model},
                    files={"image": ("gufo.png", _png(), "image/png")})
    job = wait_job(client, r.json()["job_id"])
    assert job["status"] == "done", job
    assert len(idol._idol.calls) == 1
    assert job["result"]["provider"] == "local" and job["result"]["model"] == "idol"
    assert "fallback_from" not in job["result"]["gen_meta"]


def test_without_the_gpu_a_picture_is_refused_never_sent_elsewhere(client, idol, monkeypatch):
    monkeypatch.setattr(LocalProvider, "available", lambda self: (False, "Nessuna GPU CUDA disponibile."))
    r = client.post("/api/generate", data={"provider": "hf_remote", "model": "pixal3d"},
                    files={"image": ("gufo.png", _png(), "image/png")})
    assert r.status_code == 409
    assert "Idol" in r.json()["detail"] and "Nessuna GPU" in r.json()["detail"]
    assert idol._idol.calls == []
    route = client.get("/api/providers").json()["image_to_3d"]
    assert route["model"] == "idol" and route["available"] is False


def test_idol_is_the_local_default_and_says_how_to_install_it(client, idol, monkeypatch):
    data = client.get("/api/providers").json()
    model = next(m for m in data["providers"] if m["name"] == "local")
    assert next(m for m in model["models"] if m["default"])["key"] == "idol"
    assert {k: data["image_to_3d"][k] for k in ("provider", "model", "label", "available", "reason",
                                                "license")} == {
        "provider": "local", "model": "idol", "label": "Idol", "available": True, "reason": "",
        "license": "Apache-2.0"}
    assert [(r["provider"], r["model"], r["label"]) for r in data["image_routes"]] == [
        ("local", "idol", "Idol"), ("hf_remote", "trellis2", "TRELLIS.2 · 4B")]
    monkeypatch.setattr("app.providers.idol_local.IdolRunner.installed", staticmethod(lambda: False))
    r = client.post("/api/generate", data={"provider": "local", "model": "idol"},
                    files={"image": ("gufo.png", _png(), "image/png")})
    assert r.status_code == 409 and "make install-idol" in r.json()["detail"]


def test_an_approved_preview_from_text_follows_the_chosen_provider(client, idol):
    """Only pictures the user brings are bound to Idol: a preview FLUX drew for a prompt goes
    where the panel says (here the offline shapes)."""
    draft = client.post("/api/image", data={"prompt": "un vaso", "provider": "procedural"}).json()
    r = client.post("/api/generate", data={"prompt": "un vaso", "provider": "procedural",
                                           "draft": draft["draft_id"]})
    job = wait_job(client, r.json()["job_id"])
    assert job["status"] == "done", job
    assert job["result"]["provider"] == "procedural" and idol._idol.calls == []


# -- the chain: Idol on the GPU, then Hi3D on its Space ---------------------------------------


class FakeHi3D:
    """The Hi3D Space: keeps the coarse mesh it is sent (glTF, Y up) and answers, as the real one
    does, with a finer mesh of the same shape, mean-centred with unit radius; or fails."""

    def __init__(self, tmp, fail=None):
        self.tmp, self.fail, self.calls = tmp, fail, []

    def submit(self, api_name, **kwargs):
        from .test_api import FakeJob

        if self.fail:
            raise RuntimeError(self.fail)
        coarse = trimesh.load(kwargs["coarse_mesh"]["path"], force="mesh", process=False)
        self.calls.append({"api": api_name, "extents": coarse.extents, "faces": len(coarse.faces),
                           **{k: v for k, v in kwargs.items() if k not in ("image", "coarse_mesh")}})
        fine = coarse.subdivide()
        fine.apply_translation(-fine.vertices.mean(axis=0))
        fine.apply_scale(1.0 / np.linalg.norm(fine.vertices, axis=1).max())
        path = str(self.tmp / "refined.glb")
        fine.export(path)
        return FakeJob((kwargs["coarse_mesh"]["path"], path, path, None, 0, "done"))


def _tall_splats():
    s = sphere_splats(20_000)  # red on top, blue below
    s.xyz = s.xyz * np.array([0.5, 0.7, 1.0])  # tallest along Z, as Idol stands an object
    return s


def _refine(client, idol, tmp_path, quality="high", refine="hi3d", fail=None):
    space = FakeHi3D(tmp_path, fail)
    idol._client_factory = lambda name: space
    idol._idol.generate = lambda image, mode, seed, q, progress: (_tall_splats(), image)
    r = client.post("/api/generate", data={"provider": "local", "model": "idol", "quality": quality,
                                           "refine": refine},
                    files={"image": ("drago.png", _png(), "image/png")})
    job = wait_job(client, r.json()["job_id"])
    assert job["status"] == "done", job
    return space, job["result"]


def test_hi3d_refines_idols_shape_in_the_same_frame_with_its_colours(client, idol, tmp_path):
    space, model = _refine(client, idol, tmp_path)
    call = space.calls[0]
    assert call["api"] == "/refine" and call["resolution"] == 1536  # Alta: three passes
    assert call["remove_background"] is True and call["randomize_seed"] is False
    assert np.argmax(call["extents"]) == 1  # sent Y up, the image->3D Spaces' convention
    assert call["faces"] <= 300_000
    assert model["gen_meta"]["refine"] == "hi3d" and model["gen_meta"]["hi3d_resolution"] == 1536
    assert "hi3d_error" not in model["gen_meta"]
    report = model["report"]
    assert report["watertight"] and report["components"] == 1
    assert np.argmax(report["bbox_mm"]) == 2  # back Z up: still standing
    mesh = trimesh.load(io.BytesIO(client.get(model["urls"]["mesh"]).content), file_type="glb",
                        force="mesh", process=False)
    colors, z = vertex_colors(mesh), mesh.vertices[:, 2]
    top, bottom = z > np.percentile(z, 80), z < np.percentile(z, 20)
    assert colors[top, 0].mean() > 150 > colors[top, 2].mean()  # Idol's red stays on top
    assert colors[bottom, 2].mean() > 150 > colors[bottom, 0].mean()  # and its blue below


@pytest.mark.parametrize(("quality", "grid"), [("draft", 512), ("standard", 1024)])
def test_the_quality_picks_hi3ds_passes(client, idol, tmp_path, quality, grid):
    space, model = _refine(client, idol, tmp_path, quality=quality)
    assert space.calls[0]["resolution"] == grid == model["gen_meta"]["hi3d_resolution"]


def test_when_hi3d_cannot_run_idols_shape_stays(client, idol, tmp_path):
    space, model = _refine(client, idol, tmp_path, fail="ZeroGPU quota exceeded")
    assert model["model"] == "idol" and "refine" not in model["gen_meta"]
    assert "Quota GPU" in model["gen_meta"]["hi3d_error"]
    assert model["report"]["watertight"]


def test_without_the_refinement_the_space_is_never_called(client, idol, tmp_path):
    space, model = _refine(client, idol, tmp_path, refine="")
    assert space.calls == [] and "refine" not in model["gen_meta"]


# -- or TRELLIS.2 on its Space, when chosen -------------------------------------------------


def test_a_picture_can_go_to_trellis2_on_its_space(client, idol, remote):  # noqa: F811
    r = client.post("/api/generate", data={"provider": "hf_remote", "model": "trellis2", "quality": "high"},
                    files={"image": ("gufo.png", _png(), "image/png")})
    job = wait_job(client, r.json()["job_id"])
    assert job["status"] == "done", job
    assert job["result"]["provider"] == "hf_remote" and job["result"]["model"] == "trellis2"
    assert idol._idol.calls == []  # Idol not touched
    apis = [api for _, api, _ in remote]
    assert apis == ["/preprocess_image", "/image_to_3d", "/extract_glb"]  # no FLUX: the picture is given
    assert next(k for _, a, k in remote if a == "/image_to_3d")["resolution"] == "1536"


def test_when_trellis2_fails_nothing_else_takes_the_picture(client, idol, settings, tmp_path):
    """Its Space is down: the job says so; no Pixal3D, no Idol, no other model in its place."""
    from app.providers.hf_remote import HFRemoteProvider

    from .test_api import FakeClient

    calls = []

    class Down(FakeClient):
        def submit(self, api_name, **kwargs):
            self.calls.append((self.space, api_name, kwargs))
            raise RuntimeError("Space is sleeping")

    s = dataclasses.replace(settings, gen_provider="hf_remote", hf_fallback_model="pixal3d")
    register_provider(HFRemoteProvider(s, client_factory=lambda space: Down(space, tmp_path, calls)))
    r = client.post("/api/generate", data={"provider": "hf_remote", "model": "trellis2"},
                    files={"image": ("gufo.png", _png(), "image/png")})
    job = wait_job(client, r.json()["job_id"])
    assert job["status"] == "error", job
    assert "TRELLIS.2" in job["error"]
    assert {space for space, _, _ in calls} == {"microsoft/TRELLIS.2"}  # never Pixal3D
    assert idol._idol.calls == []


def test_every_image_to_3d_space_is_offered_after_idol(client, settings):
    """IMAGE_TO_3D="local:idol,hf_remote:*,meshy:*" (the default): Idol first, then every Space,
    then Meshy, each with its licence: the Hunyuan ones flagged as not valid in the EU."""
    from app.config import Settings

    assert Settings().image_to_3d == "local:idol,hf_remote:*,meshy:*"
    set_settings(dataclasses.replace(settings, image_to_3d=Settings().image_to_3d))
    from fastapi.testclient import TestClient

    from app.main import create_app

    with TestClient(create_app(dataclasses.replace(settings, image_to_3d=Settings().image_to_3d))) as c:
        routes = c.get("/api/providers").json()["image_routes"]
    assert [(r["provider"], r["model"]) for r in routes] == [
        ("local", "idol"), ("hf_remote", "pixal3d"), ("hf_remote", "trellis2"),
        ("hf_remote", "hunyuan3d-2.1"), ("hf_remote", "step1x-3d"), ("hf_remote", "hunyuan3d-2mv"),
        ("hf_remote", "trellis"), ("meshy", "meshy-7.1")]
    eu = {r["model"] for r in routes if r["eu_restricted"]}
    assert eu == {"hunyuan3d-2.1", "hunyuan3d-2mv"}
    assert all(r["description"] for r in routes)


@pytest.mark.parametrize("model", ["pixal3d", "step1x-3d", "trellis"])
def test_a_picture_can_go_to_any_space_allowed(client, idol, remote, settings, model):  # noqa: F811
    from fastapi.testclient import TestClient

    from app.main import create_app

    s = dataclasses.replace(settings, image_to_3d="local:idol,hf_remote:*")
    with TestClient(create_app(s)) as c:
        r = c.post("/api/generate", data={"provider": "hf_remote", "model": model},
                   files={"image": ("gufo.png", _png(), "image/png")})
        job = wait_job(c, r.json()["job_id"])
    assert job["status"] == "done", job
    assert job["result"]["model"] == model and idol._idol.calls == []
