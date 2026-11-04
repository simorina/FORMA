"""local provider: CUDA inference with weights lazily downloaded/loaded.

Install with ``uv sync --extra gpu`` plus the model's own package (TRELLIS.2
needs its CUDA extensions; see README). Nothing here is imported unless the
provider is actually used, so the app runs fine on machines without CUDA.
"""

from __future__ import annotations

import threading
from typing import Any

import numpy as np
import trimesh

from ..config import Settings, get_settings
from .base import (
    GenerationResult,
    GenParams,
    ModelInfo,
    ProgressFn,
    Provider,
    ProviderError,
    as_single_mesh,
    build_image_prompt,
)

LOCAL_MODELS = {
    "trellis2": ModelInfo(
        "trellis2", "TRELLIS.2 · 4B", "microsoft/TRELLIS.2-4B in locale (≥24 GB VRAM).", "MIT"
    ),
    "hunyuan3d-2.1": ModelInfo(
        "hunyuan3d-2.1",
        "Hunyuan3D 2.1",
        "tencent/Hunyuan3D-2.1 (solo shape, ~10 GB VRAM).",
        "Tencent Hunyuan 3D 2.1 Community License (esclusi UE/UK/KR)",
    ),
}


class LocalProvider(Provider):
    name = "local"
    label = "GPU locale (CUDA)"
    description = "Esegue FLUX.1-schnell e il modello 3D sulla tua GPU NVIDIA. Nessuna coda."

    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self._lock = threading.Lock()
        self._flux: Any = None
        self._shape: dict[str, Any] = {}

    def models(self) -> list[ModelInfo]:
        default = self.settings.local_shape_model
        return [
            ModelInfo(m.key, m.label, m.description, m.license, m.key == default)
            for m in LOCAL_MODELS.values()
        ]

    def available(self) -> tuple[bool, str]:
        try:
            import torch  # noqa: F401
        except ImportError:
            return False, "PyTorch non installato: esegui `uv sync --extra gpu`."
        import torch

        if not torch.cuda.is_available():
            return False, "Nessuna GPU CUDA disponibile."
        return True, ""

    # -- lazy loaders -------------------------------------------------------
    def _load_flux(self) -> Any:
        if self._flux is None:
            import torch
            from diffusers import FluxPipeline

            pipe = FluxPipeline.from_pretrained(
                "black-forest-labs/FLUX.1-schnell",
                torch_dtype=torch.bfloat16,
                token=self.settings.hf_token or None,
            )
            pipe.enable_model_cpu_offload()
            self._flux = pipe
        return self._flux

    def _load_shape(self, key: str) -> Any:
        if key in self._shape:
            return self._shape[key]
        if key == "trellis2":
            try:
                from trellis2.pipelines import Trellis2ImageTo3DPipeline  # type: ignore
            except ImportError as exc:
                raise ProviderError(
                    "Pacchetto trellis2 non trovato: installa TRELLIS.2 da github.com/microsoft/TRELLIS.2"
                ) from exc
            pipe = Trellis2ImageTo3DPipeline.from_pretrained("microsoft/TRELLIS.2-4B")
            pipe.cuda()
        elif key == "hunyuan3d-2.1":
            try:
                from hy3dshape.pipelines import Hunyuan3DDiTFlowMatchingPipeline  # type: ignore
            except ImportError as exc:
                raise ProviderError(
                    "Pacchetto hy3dshape non trovato: installa Hunyuan3D-2.1 da GitHub"
                ) from exc
            pipe = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained("tencent/Hunyuan3D-2.1")
        else:
            raise ProviderError(f"Modello locale sconosciuto: {key}")
        self._shape[key] = pipe
        return pipe

    def generate(self, prompt, image, params: GenParams, progress: ProgressFn = lambda *a: None):
        ok, reason = self.available()
        if not ok:
            raise ProviderError(reason)
        import torch

        key = params.model or self.settings.local_shape_model
        with self._lock:  # one generation at a time on the GPU
            if image is None:
                if not prompt:
                    raise ProviderError("Scrivi un prompt o carica un'immagine.")
                progress("image", 0.1, "Carico FLUX.1-schnell")
                flux = self._load_flux()
                progress("image", 0.4, "FLUX.1 crea l'immagine")
                gen = torch.Generator("cpu").manual_seed(int(params.seed))
                image = flux(
                    build_image_prompt(prompt), guidance_scale=0.0, num_inference_steps=4,
                    width=1024, height=1024, generator=gen,
                ).images[0]
            progress("image", 1.0, "Immagine pronta")
            progress("shape", 0.05, "Carico il modello 3D")
            pipe = self._load_shape(key)
            progress("shape", 0.2, "Genero la forma")
            if key == "trellis2":
                res = {"draft": "512", "standard": "1024_cascade", "high": "1536_cascade"}
                outputs = pipe.run(image, seed=int(params.seed),
                                   pipeline_type=res.get(params.quality, "1024_cascade"))
                m = outputs[0]
                verts = m.vertices.detach().cpu().numpy()
                faces = m.faces.detach().cpu().numpy()
                mesh = trimesh.Trimesh(verts.astype(np.float64), faces, process=False)
                up = "z"  # TRELLIS works Z-up internally (its GLB export swaps to Y-up)
            else:
                try:
                    from hy3dshape.rembg import BackgroundRemover  # type: ignore

                    if image.mode == "RGB":
                        image = BackgroundRemover()(image)
                except ImportError:
                    pass
                steps = {"draft": 20, "standard": 30, "high": 50}.get(params.quality, 30)
                out = pipe(image=image, num_inference_steps=steps,
                           generator=torch.manual_seed(int(params.seed)))
                mesh = as_single_mesh(out[0])
                up = "y"
            torch.cuda.empty_cache()
        progress("shape", 1.0, "Forma 3D pronta")
        return GenerationResult(mesh=mesh, image=image, model=key, meta={"up": up})
