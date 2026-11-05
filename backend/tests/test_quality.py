"""Highest quality: Pixal3D asked for 4M triangles and a 4096 px colour texture, and the
rest of Forma keeps (and can send back from the editor) all of them."""

import pytest

from app.main import MAX_UPLOAD
from app.pipeline import PrintSettings
from app.pipeline.process import PRE_DECIMATE_ABOVE
from app.providers.endpoints import pixal3d

from .conftest import wait_job
from .test_api import FakeClient, remote  # noqa: F401 - the simulated Spaces (fixture)


@pytest.mark.parametrize(("quality", "triangles", "texture"), [
    ("high", 4_000_000, 4096),
    ("standard", 500_000, 1024),
    ("draft", 200_000, 1024),
])
def test_pixal3d_asks_the_space_for_triangles_and_texture_by_quality(
        client, remote, quality, triangles, texture):  # noqa: F811
    r = client.post("/api/generate", data={"prompt": "un gufo", "provider": "hf_remote",
                                           "model": "pixal3d", "seed": 7, "quality": quality})
    job = wait_job(client, r.json()["job_id"])
    assert job["status"] == "done", job
    extract = next(kwargs for _, api, kwargs in remote if api == "/extract_glb_api")
    assert extract["decimation_target"] == triangles
    assert extract["texture_size"] == texture


def test_print_preparation_keeps_every_triangle_pixal3d_gives():
    """A Pixal3D model at its highest quality is neither pre-simplified nor simplified."""
    most = max(pixal3d.DECIMATION.values())
    assert PrintSettings().target_faces >= most
    assert PRE_DECIMATE_ABOVE >= most
    assert PrintSettings.from_dict({"target_faces": most}).target_faces == most


def test_the_largest_model_kept_comes_back_from_the_editor():
    """The editor saves through a binary STL (84 + 50 bytes per triangle): the largest model
    the preparation keeps must fit the upload limit."""
    assert 84 + 50 * PrintSettings().target_faces <= MAX_UPLOAD
