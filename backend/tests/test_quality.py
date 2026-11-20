"""Highest quality, always: every print has at least 5M triangles and keeps up to 10M of the
model's own. Pixal3D and Step1X are asked for 10M in every quality, TRELLIS.2 for the most its
Space allows; a model under 5M is topped up to 5M with the same surface, one up to 10M (Meshy
Ultra 4K) is kept whole, and the rest of Forma keeps (and can send back from the editor) all of
them."""

import io
import zipfile

import numpy as np
import pytest
import trimesh

from app.main import MAX_UPLOAD
from app.pipeline import PrintSettings
from app.pipeline.colors import vertex_colors, with_colors
from app.pipeline.process import (
    MAX_FACES,
    MIN_FACES,
    PRE_DECIMATE_ABOVE,
    PRE_DECIMATE_TO,
    min_faces,
)
from app.pipeline.refine import refine
from app.pipeline.repair import count_bodies, from_manifold, to_manifold
from app.pipeline.report import printability_report
from app.providers.endpoints import pixal3d, step1x, trellis

from .conftest import wait_job
from .test_api import FakeClient, remote  # noqa: F401 - the simulated Spaces (fixture)


def _generate(client, model, quality):
    r = client.post("/api/generate", data={"prompt": "un gufo", "provider": "hf_remote",
                                           "model": model, "seed": 7, "quality": quality})
    job = wait_job(client, r.json()["job_id"])
    assert job["status"] == "done", job


@pytest.mark.parametrize(("quality", "texture"), [
    ("high", 4096),
    ("standard", 1024),
    ("draft", 1024),
])
def test_pixal3d_asks_the_space_for_10_million_triangles_in_every_quality(
        client, remote, quality, texture):  # noqa: F811
    _generate(client, "pixal3d", quality)
    extract = next(kwargs for _, api, kwargs in remote if api == "/extract_glb_api")
    assert extract["decimation_target"] == 10_000_000 == MAX_FACES
    assert extract["texture_size"] == texture


@pytest.mark.parametrize("quality", ["high", "standard", "draft"])
def test_trellis2_asks_the_most_triangles_its_space_allows(client, remote, quality):  # noqa: F811
    """TRELLIS.2's "Decimation Target" slider stops at 500k (Space config, 2026-11)."""
    _generate(client, "trellis2", quality)
    extract = next(kwargs for _, api, kwargs in remote if api == "/extract_glb")
    assert extract["decimation_target"] == trellis.TRIANGLES == 500_000


def test_print_preparation_keeps_every_triangle_pixal3d_gives():
    """A Pixal3D model at 10M triangles is neither pre-simplified nor simplified, and one the
    Space hands back a few triangles over is brought back to 10M, not below."""
    assert PrintSettings().target_faces == pixal3d.TRIANGLES
    assert PRE_DECIMATE_ABOVE >= pixal3d.TRIANGLES
    assert PRE_DECIMATE_TO >= pixal3d.TRIANGLES
    assert PrintSettings.from_dict({"target_faces": pixal3d.TRIANGLES}).target_faces == pixal3d.TRIANGLES


def test_the_largest_model_kept_comes_back_from_the_editor():
    """The editor saves through a binary STL (84 + 50 bytes per triangle): the largest model
    the preparation keeps must fit the upload limit."""
    assert 84 + 50 * PrintSettings().target_faces <= MAX_UPLOAD
    assert 84 + 50 * (MIN_FACES + 1) <= MAX_UPLOAD  # the refinement may add one over the minimum


@pytest.mark.parametrize("quality", ["high", "standard", "draft"])
def test_step1x_asks_the_space_for_10_million_faces(client, remote, quality):  # noqa: F811
    """Its "Max. Number of Faces" is a plain number field: no 400k default holding it back."""
    _generate(client, "step1x-3d", quality)
    gen = next(kwargs for _, api, kwargs in remote if api == "/generate_func")
    assert gen["max_facenum"] == step1x.TRIANGLES == MAX_FACES


def test_the_minimum_is_5_million_and_simplification_never_goes_below_it(monkeypatch):
    monkeypatch.delenv("FORMA_MIN_FACES")
    assert min_faces() == MIN_FACES == 5_000_000
    # up to 10M of the model's own are kept: Meshy Ultra 4K (~10M) is not cut in half
    assert MAX_FACES == PrintSettings().target_faces == PRE_DECIMATE_ABOVE == 10_000_000
    assert PrintSettings.from_dict({"target_faces": 7_500_000}).target_faces == 7_500_000
    assert PrintSettings.from_dict({"target_faces": 50_000_000}).target_faces == MAX_FACES
    assert PrintSettings.from_dict({"target_faces": 100_000}).target_faces == MIN_FACES
    for raw in ("abc", "9000000"):  # nonsense, or above the minimum: the minimum
        monkeypatch.setenv("FORMA_MIN_FACES", raw)
        assert min_faces() == MIN_FACES
    monkeypatch.setenv("FORMA_MIN_FACES", "20000")  # the e2e flows and the tests lower it
    assert min_faces() == 20_000


def _colored(mesh: trimesh.Trimesh) -> trimesh.Trimesh:
    colors = np.random.default_rng(0).integers(0, 256, (len(mesh.vertices), 4), dtype=np.uint8)
    colors[:, 3] = 255
    return with_colors(mesh, colors)


@pytest.mark.parametrize("target", [13, 20, 47, 48, 200_000])
def test_refinement_reaches_the_minimum_with_the_same_surface(target):
    """Each split edge adds a triangle per face on it (two on a closed mesh): at most one
    over the target. Midpoints only: the solid, its sides and its colours do not move."""
    box = _colored(trimesh.creation.box((80.0, 30.0, 12.0)))
    out = refine(box, target)
    assert target <= len(out.faces) <= target + 1
    assert out.is_watertight and out.is_winding_consistent and to_manifold(out) is not None
    assert out.volume == pytest.approx(box.volume, rel=1e-9)  # > 0: normals still outwards
    assert out.area == pytest.approx(box.area, rel=1e-9)
    np.testing.assert_allclose(out.bounds, box.bounds)
    n = len(box.vertices)
    np.testing.assert_array_equal(out.vertices[:n], box.vertices)
    colors = vertex_colors(out)
    assert colors is not None and len(colors) == len(out.vertices)
    np.testing.assert_array_equal(colors[:n], vertex_colors(box))


def test_refinement_interpolates_colours_along_the_edge():
    box = with_colors(trimesh.creation.box((10.0, 10.0, 10.0)), None)
    colors = np.zeros((len(box.vertices), 4), dtype=np.uint8)
    colors[:, 3] = 255
    colors[box.vertices[:, 0] > 0, 0] = 200  # red on +X, black on -X
    out = refine(with_colors(box, colors), 48)  # every edge split once
    new = out.vertices[len(box.vertices):]
    reds = vertex_colors(out)[len(box.vertices):, 0]
    np.testing.assert_array_equal(reds[np.isclose(new[:, 0], 0.0)], 100)  # halfway: half red
    np.testing.assert_array_equal(reds[new[:, 0] > 0], 200)
    np.testing.assert_array_equal(reds[new[:, 0] < 0], 0)


def test_refinement_splits_the_longest_edges_first():
    box = trimesh.creation.box((100.0, 10.0, 10.0))
    out = refine(box, 14)  # one edge: two triangles more
    assert len(out.faces) == 14
    new = out.vertices[len(box.vertices):]
    assert len(new) == 1
    lengths = box.edges_unique_length
    longest = box.edges_unique[np.isclose(lengths, lengths.max())]
    midpoints = box.vertices[longest].mean(axis=1)
    assert np.isclose(np.linalg.norm(midpoints - new[0], axis=1), 0.0).any()


def test_refinement_keeps_a_hollow_model_hollow():
    outer = to_manifold(trimesh.creation.box((40.0, 40.0, 40.0)))
    cavity = to_manifold(trimesh.creation.box((30.0, 30.0, 30.0)))
    hollowed = from_manifold(outer - cavity)
    out = refine(hollowed, 50_000)
    assert len(out.faces) >= 50_000 and out.is_watertight and out.is_winding_consistent
    assert out.volume == pytest.approx(40.0**3 - 30.0**3, rel=1e-9)
    assert count_bodies(out) == 1  # the cavity is still a cavity, not a second piece


def test_the_report_checks_thin_parts_and_pieces_at_any_resolution():
    """With 5M triangles in every print, the checks that used to stop at 1M must still run."""
    slab = trimesh.creation.box((40.0, 40.0, 0.5))  # thinner than the 0.8 mm two walls need
    other = slab.copy()
    other.apply_translation([60.0, 0.0, 0.0])
    report = printability_report(refine(trimesh.util.concatenate([slab, other]), 1_200_000))
    assert report["triangles"] >= 1_200_000
    assert report["components"] == 2
    assert report["thin_pct"] > 50 and report["thin_mm"] == pytest.approx(0.5, abs=0.1)
    assert any("Parti sottili" in w for w in report["warnings"])


def test_every_generated_model_reaches_the_plate_with_5_million_triangles(client, monkeypatch):
    """The real minimum, end to end: an offline model of a few thousand triangles is prepared,
    stored and exported for the slicer with at least 5M, still a closed solid."""
    monkeypatch.delenv("FORMA_MIN_FACES")
    r = client.post("/api/generate", data={"prompt": "un vaso", "provider": "procedural"})
    job = wait_job(client, r.json()["job_id"], timeout=300)
    assert job["status"] == "done", job
    report = job["result"]["report"]
    assert MIN_FACES <= report["triangles"] <= MIN_FACES + 1
    assert report["watertight"] and report["manifold"] and report["components"] == 1
    assert any(step.startswith("suddiviso") for step in report["repairs"])
    data = client.get(f"/api/export/{job['result']['id']}", params={"format": "3mf"}).content
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        name = next(n for n in archive.namelist() if n.endswith(".model"))
        assert archive.read(name).count(b"<triangle ") == report["triangles"]
