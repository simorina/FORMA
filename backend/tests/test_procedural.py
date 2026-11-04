import pytest

from app.providers.base import GenParams
from app.providers.procedural import SHAPES, ProceduralProvider, pick_shape


@pytest.mark.parametrize(
    "prompt,expected",
    [
        ("un vaso elegante con collo sottile", "vaso"),
        ("A coffee MUG", "tazza"),
        ("pedone degli scacchi", "pedone"),
        ("ingranaggio con 20 denti", "ingranaggio"),
        ("una stella", "stella"),
        ("razzo spaziale", "razzo"),
        ("una città galleggiante", "scultura organica"),
    ],
)
def test_keyword_pick(prompt, expected):
    assert pick_shape(prompt)[0] == expected


@pytest.mark.parametrize("label", [label for _, label, _ in SHAPES] + ["drago"])
def test_every_shape_is_watertight(label):
    result = ProceduralProvider().generate(label, None, GenParams(seed=1))
    assert result.mesh.is_watertight
    assert result.mesh.volume > 0
    assert result.image is not None and result.image.size == (512, 512)
    assert result.meta["up"] == "z"


def test_seed_is_deterministic():
    p = ProceduralProvider()
    a = p.generate("vaso", None, GenParams(seed=3)).mesh
    b = p.generate("vaso", None, GenParams(seed=3)).mesh
    c = p.generate("vaso", None, GenParams(seed=4)).mesh
    assert abs(a.volume - b.volume) < 1e-6
    assert abs(a.volume - c.volume) > 1e-3


def test_progress_callback_reports_stages():
    seen = []
    ProceduralProvider().generate("cubo", None, GenParams(), lambda s, f, m: seen.append(s))
    assert "shape" in seen
