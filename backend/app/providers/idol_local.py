"""Idol (speridlabs/idol, Apache-2.0) on this machine's NVIDIA GPU: one image -> 3D Gaussians.

Install with ``make install-idol`` (the uv extra "idol": PyTorch with CUDA, Windows included,
and the SDK). On the first run Idol's weights (~3 GB) and two image encoders download into the
Hugging Face cache:
- DINOv3 ViT-H+/16 is gated: accept its terms on huggingface.co with the HF_TOKEN account;
- the FLUX.2 VAE: Idol names FLUX.2-dev (gated); the very same VAE ships, in bf16 (the precision
  Idol runs it in), with FLUX.2-klein-4B, Apache-2.0 and not gated. That one is the default.

Fits an 8 GB laptop GPU: the image encoders (DINOv3, the VAE, BiRefNet) wait in system memory
and come to the GPU only to read the image; the denoiser and the decoders stay there.
"""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import sys
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

from ..pipeline.splats import Splats, sh_to_rgb

REPO = "speridlabs/idol"
WEIGHT_FILES = ("config.json", "denoiser.safetensors", "decoder.safetensors",
                "decoder_gs.safetensors", "birefnet.safetensors")
# The FLUX.2-dev VAE without the gate (its config says it was saved from FLUX.2-dev).
DEFAULT_VAE = "black-forest-labs/FLUX.2-klein-4B"

# Per quality: Gaussians (32,768 to 1,048,576), sampling steps, grid cells along the longest
# side for the surface. A million Gaussians are ~1/600 of the object apart: a 512 grid keeps
# what they hold.
QUALITY = {
    "draft": (262_144, 30, 384),
    "standard": (1_048_576, 50, 512),
    "high": (1_048_576, 50, 512),
}

Progress = Callable[[float, str], None]


def _weights_dir(cache: Path, vae: str) -> str:
    """Idol's weights, with ``vae`` as its FLUX.2 VAE: the downloaded files linked (not copied)
    next to a config.json naming it. The plain download when it already names it."""
    from huggingface_hub import snapshot_download

    snapshot = Path(snapshot_download(REPO, allow_patterns=list(WEIGHT_FILES)))
    config = json.loads((snapshot / "config.json").read_text(encoding="utf-8"))
    if config["image_encoders"]["flux2_vae"] == vae:
        return str(snapshot)
    config["image_encoders"]["flux2_vae"] = vae
    out = cache / "idol-weights"
    marker = out / "source.txt"
    if not (marker.is_file() and marker.read_text(encoding="utf-8") == f"{snapshot}\n{vae}"):
        shutil.rmtree(out, ignore_errors=True)
        out.mkdir(parents=True)
        for name in WEIGHT_FILES[1:]:
            src = (snapshot / name).resolve()
            try:
                os.link(src, out / name)
            except OSError:  # another drive, or links not allowed: a copy
                shutil.copy2(src, out / name)
        (out / "config.json").write_text(json.dumps(config, indent=2), encoding="utf-8")
        marker.write_text(f"{snapshot}\n{vae}", encoding="utf-8")
    return str(out)


class _Counted:
    """The denoiser, counting its calls to report the sampling's progress."""

    def __init__(self, model: Any, calls: int, progress: Progress) -> None:
        self._model, self._calls, self._progress, self._done = model, max(1, calls), progress, 0

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        out = self._model(*args, **kwargs)
        self._done += 1
        self._progress(min(1.0, self._done / self._calls), "Idol genera la forma")
        return out

    def __getattr__(self, name: str) -> Any:
        return getattr(self._model, name)


class IdolRunner:
    def __init__(self, cache: Path, vae: str = DEFAULT_VAE) -> None:
        self.cache = Path(cache)
        self.vae = vae
        self._pipe: Any = None

    @staticmethod
    def installed() -> bool:
        return importlib.util.find_spec("idol") is not None

    def _load(self) -> Any:
        if self._pipe is not None:
            return self._pipe
        from idol import IdolPipeline  # type: ignore

        # torch.compile needs Triton, which PyTorch does not ship for Windows: eager there.
        optimize = sys.platform != "win32" and importlib.util.find_spec("triton") is not None
        pipe = IdolPipeline(_weights_dir(self.cache, self.vae), device="cuda", optimize=optimize)
        self._pipe = pipe
        self._park()
        return pipe

    def _encoders(self) -> list[Any]:
        p = self._pipe
        return [p.background_remover, p.image_encoder.dinov3, p.image_encoder.flux2_vae]

    def _park(self) -> None:
        import torch

        for m in self._encoders():
            m.to("cpu")
        torch.cuda.empty_cache()

    @contextmanager
    def _encoders_on_gpu(self) -> Iterator[None]:
        for m in self._encoders():
            m.to("cuda")
        try:
            yield
        finally:
            self._park()

    def generate(self, image: Image.Image, mode: str, seed: int, quality: str,
                 progress: Progress) -> tuple[Splats, Image.Image]:
        """``mode``: "synthetic" (renders, generated pictures: tight crop) or "real" (photos).
        Returns the Gaussians (Z up, inside the unit cube) and the picture Idol saw."""
        import torch
        from idol.sampler import sample_flow  # type: ignore
        from tensordict import TensorDict  # type: ignore

        gaussians, steps, _ = QUALITY.get(quality, QUALITY["standard"])
        progress(0.0, "Carico Idol")
        pipe = self._load()
        with torch.no_grad():
            progress(0.02, "Idol legge l'immagine")
            with self._encoders_on_gpu():
                prepared = pipe.preprocess(image, mode=mode)
                pixels = torch.from_numpy(np.array(prepared)).permute(2, 0, 1).float().div(255.0)[None].cuda()
                torch.manual_seed(int(seed))
                cond = pipe.image_encoder(pixels)
            den = pipe.denoiser
            noise = TensorDict({
                "latent": torch.randn(1, den.q_token_length, den.in_channels, device="cuda"),
                "camera": torch.randn(1, 1, den.cam_channels, device="cuda"),
            }, batch_size=1, device="cuda")
            # The guided and unguided passes as one batch of two: the same formula, one call per
            # step instead of two (upstream ties it to torch.compile, which Windows lacks).
            counted = _Counted(den, steps, lambda f, msg: progress(0.05 + 0.85 * f, msg))
            with pipe._sampling_settings():
                sample = sample_flow(counted, noise, cond=cond, neg_cond=cond.apply(torch.zeros_like),
                                     steps=steps, rescale_t=3.0, cfg_strength=3.0, verbose=False,
                                     batch_cfg=True)
            progress(0.92, f"Idol posa {gaussians:,} gaussiane".replace(",", "."))
            g = pipe.decode(sample["latent"], gaussians)
            splats = Splats(
                xyz=g.xyz.float().cpu().numpy(),
                scales=g.scaling.float().cpu().numpy(),
                rotations=g.rotation.float().cpu().numpy(),
                opacity=g.opacity.float().cpu().numpy().reshape(-1),
                colors=sh_to_rgb(g.features_dc.float().cpu().numpy()),
            )
            del g, sample, cond, noise
        torch.cuda.empty_cache()
        progress(1.0, "Gaussiane pronte")
        return splats, prepared
