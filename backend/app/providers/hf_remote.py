"""hf_remote provider: Hugging Face Spaces / Inference, no local GPU needed.

Text -> FLUX.1-schnell image -> image->3D Space (Pixal3D by default, TRELLIS.2 as
automatic fallback). All Space-specific calls live in ``providers/endpoints``.
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
    looks_italian,
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
        translator: Callable[[str], str] | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        self._client_factory = client_factory or default_client_factory(self.settings)
        self._text_to_image = text_to_image
        self._translator = translator
        self._translations: dict[str, str] = {}

    def english(self, prompt: str) -> str:
        """Italian prompts go to FLUX in English (its T5 encoder was trained on English).
        Uses the HF translation model with the token; on any failure the original is kept."""
        text = prompt.strip()
        if not text or not looks_italian(text):
            return text
        if text in self._translations:
            return self._translations[text]
        translate = self._translator
        if translate is None:
            model, token = self.settings.hf_translate_model, self.settings.hf_token
            if not model or not token:
                return text

            def translate(t: str) -> str:
                from huggingface_hub import InferenceClient

                out = InferenceClient(token=token).translation(t, model=model)
                return getattr(out, "translation_text", None) or str(out)
        try:
            english = (translate(text) or "").strip() or text
        except Exception:
            english = text
        self._translations[text] = english
        return english

    def models(self) -> list[ModelInfo]:
        default = self.settings.hf_shape_model
        return [e.info(default=e.key == default) for e in SHAPE_ENDPOINTS.values()]

    def available(self) -> tuple[bool, str]:
        if self.settings.hf_token:
            return True, ""
        return True, "Senza HF_TOKEN si usa la quota anonima degli Space (limitata)."

    def _image_from_prompt(self, prompt: str, seed: int, progress: ProgressFn) -> Image.Image:
        text = build_image_prompt(self.english(prompt))
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

    def image(self, prompt: str, seed: int = 0, progress: ProgressFn = lambda *a: None) -> Image.Image:
        if not prompt.strip():
            raise ProviderError("Scrivi un prompt per l'immagine.")
        return self._image_from_prompt(prompt, seed, progress)

    def _shape(self, key: str, img_path: Path, params: GenParams, progress: ProgressFn):
        endpoint = SHAPE_ENDPOINTS[key]
        space = endpoint.space_id(self.settings)
        progress("shape", 0.01, f"Connessione a {space}")
        try:
            client = self._client_factory(space)
            mesh_path = endpoint.run(
                client, str(img_path), params.seed, params.quality, progress,
                self.settings.hf_timeout_s,
            )
            return load_mesh_file(mesh_path), space
        except ProviderError:
            raise
        except Exception as exc:
            raise friendly_error(exc, space) from exc

    def generate(self, prompt, image, params: GenParams, progress: ProgressFn = lambda *a: None):
        key = params.model or self.settings.hf_shape_model
        if key not in SHAPE_ENDPOINTS:
            raise ProviderError(f"Modello sconosciuto: {key}")
        from_text = image is None
        if image is None:
            if not prompt:
                raise ProviderError("Scrivi un prompt o carica un'immagine.")
            progress("image", 0.05, "Preparo il prompt")
            image = self._image_from_prompt(prompt, params.seed, progress)
        progress("image", 1.0, "Immagine pronta")

        meta: dict[str, Any] = {"up": "y"}
        if from_text:  # the picture came from the prompt: record what FLUX actually read
            english = self.english(prompt)
            if english != prompt.strip():
                meta["prompt_en"] = english
        with tempfile.TemporaryDirectory(prefix="forma-") as tmp:
            img_path = Path(tmp) / "input.png"
            image.convert("RGBA" if image.mode in ("RGBA", "LA") else "RGB").save(img_path)
            try:
                mesh, space = self._shape(key, img_path, params, progress)
            except ProviderError as exc:
                fallback = self.settings.hf_fallback_model
                # an uploaded picture goes to the model chosen for it, or nowhere
                if (exc.kind == "auth" or not fallback or fallback == key
                        or fallback not in SHAPE_ENDPOINTS or params.extra.get("no_fallback")):
                    raise
                first = SHAPE_ENDPOINTS[key].label
                second = SHAPE_ENDPOINTS[fallback].label
                progress("shape", 0.02, f"{first} non disponibile: passo a {second}")
                try:
                    mesh, space = self._shape(fallback, img_path, params, progress)
                except ProviderError as exc2:
                    raise ProviderError(f"{exc} Anche {second} non è disponibile: {exc2}",
                                        kind=exc2.kind) from exc2
                meta.update(fallback_from=key, fallback_reason=str(exc))
                key = fallback
        meta["space"] = space
        progress("shape", 1.0, "Forma 3D ricevuta")
        return GenerationResult(mesh=mesh, image=image, model=key, meta=meta)
