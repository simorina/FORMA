"""Endpoint adapters for Hugging Face Spaces.

Every Space exposes a different Gradio API, so all endpoint-specific knowledge
(api names, argument names, defaults, output shapes) lives in this package,
one module per model. The rest of the app only sees ``ShapeEndpoint.run`` ->
path of a mesh file on disk.

The argument names mirror the Spaces' ``app.py`` as published upstream
(checked 2026-11). If a Space changes its API, adjust only the matching module
or point the env var (e.g. ``HF_SPACE_TRELLIS2``) to a compatible duplicate.
"""

from __future__ import annotations

from .common import ShapeEndpoint
from .hunyuan import Hunyuan2mvEndpoint, Hunyuan21Endpoint
from .pixal3d import Pixal3DEndpoint
from .step1x import Step1XEndpoint
from .trellis import Trellis2Endpoint, TrellisEndpoint

# Ordered by geometry quality for printing (see README, "Scelta del modello").
SHAPE_ENDPOINTS: dict[str, ShapeEndpoint] = {
    e.key: e
    for e in (
        Pixal3DEndpoint(),
        Trellis2Endpoint(),
        Hunyuan21Endpoint(),
        Step1XEndpoint(),
        Hunyuan2mvEndpoint(),
        TrellisEndpoint(),
    )
}

__all__ = ["SHAPE_ENDPOINTS", "ShapeEndpoint"]
