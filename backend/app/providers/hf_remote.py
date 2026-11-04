"""hf_remote provider: Hugging Face Spaces / Inference, no local GPU needed.

Text -> FLUX.1-schnell image -> image->3D Space (TRELLIS.2 by default).
All Space-specific calls live in ``providers/endpoints``.
"""

from __future__ import annotations

import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

from PIL import Image

from ..config import Settings, get_settings
from .base import (
    GenerationResult,
    GenParams,
    ModelInfo,
    ProgressFn,
    Provider,
    ProviderError,
    build_image_prompt,
    load_mesh_file,
)
from .endpoints import SHAPE_ENDPOINTS, flux
from .endpoints.common import friendly_error


def default_client_factory(settings: Settings) -> Callable[[str], Any]:
    def make(space_id: str) -> Any:
        try:
            from gradio_client import Client
        except ImportError as exc:  # pragma: no cover
            raise ProviderError("gradio_client non installato") from exc
        token = settings.hf_token or None
        try:
            return Client(space_id, token=token, verbose=False)
        except TypeError:  # older gradio_client
            return Client(space_id, hf_token=token)

    return make


class HFRemoteProvider(Provider):
    name = "hf_remote"
    label = "Hugging Face (remoto)"
    description = (
        "Modelli open-weight eseguiti sugli Space di Hugging Face. Funziona su Mac senza GPU; "
        "con HF_TOKEN hai più quota e meno code."
    )

    def __init__(
        self,
        settings: Settings | None = None,
        client_factory: Callable[[str], Any] | None = None,
        text_to_image: Callable[[str, int], Image.Image] | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        self._client_factory = client_factory or default_client_factory(self.settings)
        self._text_to_image = text_to_image

    def models(self) -> list[ModelInfo]:
        default = self.settings.hf_shape_model
        return [e.info(default=e.key == default) for e in SHAPE_ENDPOINTS.values()]

    def available(self) -> tuple[bool, str]:
        if self.settings.hf_token:
            return True, ""
        return True, "Senza HF_TOKEN si usa la quota anonima degli Space (limitata)."

    def _image_from_prompt(self, prompt: str, seed: int, progress: ProgressFn) -> Image.Image:
        text = build_image_prompt(prompt)
        if self._text_to_image is not None:
            return self._text_to_image(text, seed)
        s = self.settings
        if s.hf_token:
            try:
                progress("image", 0.2, "FLUX.1 crea l'immagine")
                return flux.via_inference(text, seed, s.hf_token, s.hf_flux_model)
            except Exception:  # fall back to the Space
                progress("image", 0.3, "Inference non disponibile, uso lo Space FLUX")
        try:
            client = self._client_factory(s.hf_space_flux)
            return flux.via_space(client, text, seed, progress, s.hf_timeout_s)
        except ProviderError:
            raise
        except Exception as exc:
            raise friendly_error(exc, s.hf_space_flux) from exc

    def generate(self, prompt, image, params: GenParams, progress: ProgressFn = lambda *a: None):
        key = params.model or self.settings.hf_shape_model
        endpoint = SHAPE_ENDPOINTS.get(key)
        if endpoint is None:
            raise ProviderError(f"Modello sconosciuto: {key}")
        if image is None:
            if not prompt:
                raise ProviderError("Scrivi un prompt o carica un'immagine.")
            progress("image", 0.05, "Preparo il prompt")
            image = self._image_from_prompt(prompt, params.seed, progress)
        progress("image", 1.0, "Immagine pronta")

        space = endpoint.space_id(self.settings)
        with tempfile.TemporaryDirectory(prefix="forma-") as tmp:
            img_path = Path(tmp) / "input.png"
            image.convert("RGBA" if image.mode in ("RGBA", "LA") else "RGB").save(img_path)
            progress("shape", 0.01, f"Connessione a {space}")
            try:
                client = self._client_factory(space)
                mesh_path = endpoint.run(
                    client, str(img_path), params.seed, params.quality, progress,
                    self.settings.hf_timeout_s,
                )
            except ProviderError:
                raise
            except Exception as exc:
                raise friendly_error(exc, space) from exc
            mesh = load_mesh_file(mesh_path)
        progress("shape", 1.0, "Forma 3D ricevuta")
        return GenerationResult(mesh=mesh, image=image, model=key, meta={"up": "y", "space": space})
