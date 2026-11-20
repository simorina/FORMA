import threading

import numpy as np
import pytest
import trimesh
from PIL import Image, ImageDraw, ImageFilter

from app import render
from app.pipeline import process
from app.pipeline.refine import refine
from app.providers.base import GenParams
from app.providers.procedural import ProceduralProvider


def _full_frame_backdrop(size: int, xy: np.ndarray) -> Image.Image:
    """The backdrop as first written: the shadow mask blurred over the whole frame."""
    top, bottom = np.array([250, 247, 241]), np.array([228, 219, 205])
    grad = (top[None, :] * (1 - np.linspace(0, 1, size))[:, None] + bottom[None, :] * np.linspace(
        0, 1, size
    )[:, None]).astype(np.uint8)
    img = Image.fromarray(np.repeat(grad[:, None, :], size, axis=1))
    shadow = Image.new("L", (size, size), 0)
    base_y = xy[:, 1].max()
    w = (xy[:, 0].max() - xy[:, 0].min()) * 0.55
    ImageDraw.Draw(shadow).ellipse([size / 2 - w, base_y - 12, size / 2 + w, base_y + 12], fill=110)
    shadow = shadow.filter(ImageFilter.GaussianBlur(14))
    img.paste((120, 104, 84), (0, 0), shadow)
    return img


@pytest.mark.parametrize("size", [384, 512])
@pytest.mark.parametrize(
    "x0,x1,base",
    [(0.3, 0.7, 0.8), (0.1, 0.9, 0.9), (0.45, 0.55, 0.5), (0.02, 0.98, 0.99), (0.5, 0.5, 0.97)],
)
def test_shadow_blurred_around_the_ellipse_only_is_the_same(size, x0, x1, base):
    xy = np.array([[x0 * size, 0.2 * size], [x1 * size, base * size + 0.37]])
    fast = np.asarray(render._backdrop(size, xy))
    assert np.array_equal(fast, np.asarray(_full_frame_backdrop(size, xy)))


def test_render_preview_draws_the_model_on_the_backdrop():
    mesh = trimesh.creation.icosphere(subdivisions=4, radius=20)
    img = np.asarray(render.render_preview(mesh, size=384))
    assert img.shape == (384, 384, 3)
    assert np.array_equal(img[0, 0], [250, 247, 241])  # untouched studio sweep in the corner
    centre = img[180:204, 180:204].reshape(-1, 3)
    assert np.all(np.abs(centre.astype(int) - [250, 247, 241]).sum(axis=1) > 0)
    # a mesh above the face budget is decimated first and still fills the same frame
    dense = trimesh.creation.icosphere(subdivisions=6, radius=20)
    big = np.asarray(render.render_preview(dense, size=384, max_faces=20_000))
    covered = lambda a: (np.abs(a.astype(int) - a[0, 0]).sum(axis=2) > 30).mean()  # noqa: E731
    assert covered(big) == pytest.approx(covered(img), abs=0.01)


def test_a_print_of_millions_of_triangles_is_clustered_before_decimating(monkeypatch):
    """Every print has 5M triangles: quadric decimation of all of them would take ~20 s per
    thumbnail, so they are first clustered on a grid finer than the pixels."""
    sphere = refine(trimesh.creation.icosphere(subdivisions=4, radius=20), 1_200_000)
    clustered = []
    real = render._clustered
    monkeypatch.setattr(render, "_clustered", lambda *a: clustered.append(len(a[1])) or real(*a))
    v, f = render._decimated(sphere, 40_000)
    assert clustered == [len(sphere.faces)] and 0 < len(f) <= 40_000
    np.testing.assert_allclose(v.min(axis=0), sphere.bounds[0], atol=0.5)  # same frame
    np.testing.assert_allclose(v.max(axis=0), sphere.bounds[1], atol=0.5)
    small = trimesh.creation.icosphere(subdivisions=4, radius=20)
    covered = lambda a: (np.abs(a.astype(int) - a[0, 0]).sum(axis=2) > 30).mean()  # noqa: E731
    big = np.asarray(render.render_preview(sphere, size=384))
    assert covered(big) == pytest.approx(covered(np.asarray(render.render_preview(small, size=384))),
                                         abs=0.01)


def test_decimations_from_two_threads_keep_their_own_mesh():
    """fast_simplification works on global state: a job's pipeline and another model's
    thumbnail decimating at the same moment used to swap meshes."""
    left = trimesh.creation.icosphere(subdivisions=5, radius=10)
    right = trimesh.creation.icosphere(subdivisions=5, radius=10)
    right.apply_translation([100, 0, 0])
    n = len(left.faces)
    wrong: list[str] = []

    def pipeline_side() -> None:
        for _ in range(20):
            out = process.decimate(left, n // 2)
            if abs(out.vertices[:, 0].mean()) > 1:
                wrong.append("the pipeline got the thumbnail's mesh")

    def thumbnail_side() -> None:
        for _ in range(20):
            v, _ = render._decimated(right, n // 4)
            if abs(v[:, 0].mean() - 100) > 1:
                wrong.append("the thumbnail got the pipeline's mesh")

    threads = [threading.Thread(target=pipeline_side), threading.Thread(target=thumbnail_side)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert wrong == []


def test_procedural_skips_the_preview_when_an_image_is_given():
    photo = Image.new("RGB", (64, 64), "white")
    result = ProceduralProvider().generate("un vaso", photo, GenParams(seed=1))
    assert result.image is None  # the job keeps the photo / approved draft
    assert result.mesh.is_watertight


def test_preview_shows_vertex_colors():
    """The history thumbnail of a coloured model shows its colours, not the default ivory."""
    sphere = trimesh.creation.icosphere(subdivisions=4)
    sphere.visual = trimesh.visual.ColorVisuals(
        sphere, vertex_colors=np.tile([200, 30, 10, 255], (len(sphere.vertices), 1)))
    r, g, b = np.asarray(render.render_preview(sphere, size=128, max_faces=500))[64, 64][:3].astype(int)
    assert r > g + 60 and r > b + 60
