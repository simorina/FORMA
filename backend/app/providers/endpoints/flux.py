"""FLUX.1-schnell text->image (Apache-2.0).

With HF_TOKEN we use Hugging Face Inference Providers (fast, reliable);
without it we fall back to the public Space ``/infer`` endpoint:
infer(prompt, seed, randomize_seed, width, height, num_inference_steps) -> (image, seed).
"""

from __future__ import annotations

from typing import Any

from PIL import Image

from ..base import ProgressFn
from .common import IMAGE_EXTS, call, extract_path


def via_inference(prompt: str, seed: int, token: str, model: str) -> Image.Image:
    from huggingface_hub import InferenceClient

    client = InferenceClient(token=token)
    return client.text_to_image(
        prompt, model=model, width=1024, height=1024, num_inference_steps=4, seed=seed
    )


def via_space(
    client: Any, prompt: str, seed: int, progress: ProgressFn, timeout_s: float
) -> Image.Image:
    out = call(client, "/infer", progress, "image", "FLUX.1 crea l'immagine", timeout_s,
               (0.0, 1.0), prompt=prompt, seed=int(seed), randomize_seed=False,
               width=1024, height=1024, num_inference_steps=4)
    path = extract_path(out, IMAGE_EXTS) or extract_path(out)
    if not path:
        raise RuntimeError("FLUX non ha restituito un'immagine")
    return Image.open(path).convert("RGB")
