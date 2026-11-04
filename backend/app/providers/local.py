"""local provider: CUDA inference with weights lazily downloaded/loaded.

Install with ``uv sync --extra gpu`` plus the model's own package (Pixal3D and
TRELLIS.2 need their CUDA extensions; see README "Linux con GPU"). Nothing here is
imported unless the provider is actually used, so the app runs fine without CUDA.

Each model follows its upstream inference script (Pixal3D ``inference.py``, TRELLIS.2
README example) up to the GLB export, so orientation matches the Spaces exactly
(glTF, Y up).
"""

from __future__ import annotations

import math
import tempfile
import threading
from pathlib import Path
from typing import Any

import numpy as np

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
    load_mesh_file,
    looks_italian,
)

HUNYUAN_LICENSE = "Tencent Hunyuan 3D 2.1 Community License (esclusi UE/UK/KR)"
LOCAL_MODELS = {
    "pixal3d": ModelInfo(
        "pixal3d", "Pixal3D", "TencentARC/Pixal3D in locale (≥24 GB VRAM).",
        "MIT",
    ),
    "trellis2": ModelInfo(
        "trellis2", "TRELLIS.2 · 4B", "microsoft/TRELLIS.2-4B in locale (≥24 GB VRAM).", "MIT"
    ),
    "hunyuan3d-2.1": ModelInfo(
        "hunyuan3d-2.1",
        "Hunyuan3D 2.1",
        "tencent/Hunyuan3D-2.1 (solo shape, ~10 GB VRAM).",
        HUNYUAN_LICENSE,
        notes=["Licenza Tencent: non valida nell'Unione Europea (Italia inclusa)."],
    ),
}

# Pixal3D image-conditioning models (upstream inference.py).
PIXAL3D_COND = {
    "ss": {"image_size": 512, "grid_resolution": 16},
    "shape_512": {"image_size": 512, "grid_resolution": 32, "use_naf_upsample": True,
                  "naf_target_size": 512},
    "shape_1024": {"image_size": 1024, "grid_resolution": 64, "use_naf_upsample": True,
                   "naf_target_size": 512},
    "tex_1024": {"image_size": 1024, "grid_resolution": 64, "use_naf_upsample": True,
                 "naf_target_size": 1024},
}
DINOV3 = "camenduru/dinov3-vitl16-pretrain-lvd1689m"
MOGE = "Ruicheng/moge-2-vitl"
# Pixal3D/TRELLIS.2 GLB export: o_voxel's to_glb output, then Pixal3D's extra rotation.
PIXAL3D_GLB_ROT = np.array(
    [[-1, 0, 0, 0], [0, 0, -1, 0], [0, -1, 0, 0], [0, 0, 0, 1]], dtype=np.float64
)
SAMPLERS = {
    "sparse_structure_sampler_params": {"steps": 12, "guidance_strength": 7.5,
                                        "guidance_rescale": 0.7, "rescale_t": 5.0},
    "shape_slat_sampler_params": {"steps": 12, "guidance_strength": 7.5,
                                  "guidance_rescale": 0.5, "rescale_t": 3.0},
    "tex_slat_sampler_params": {"steps": 12, "guidance_strength": 1.0,
                                "guidance_rescale": 0.0, "rescale_t": 3.0},
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
        self._moge: Any = None
        self._mt: Any = None  # translation pipeline

    def models(self) -> list[ModelInfo]:
        default = self.settings.local_shape_model
        return [
            ModelInfo(m.key, m.label, m.description, m.license, m.key == default, list(m.notes))
            for m in LOCAL_MODELS.values()
        ]

    def available(self) -> tuple[bool, str]:
        try:
            import torch
        except ImportError:
            return False, "PyTorch non installato: esegui `uv sync --extra gpu`."
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
        if key == "pixal3d":
            try:
                from pixal3d.pipelines import Pixal3DImageTo3DPipeline  # type: ignore
                from pixal3d.trainers.flow_matching.mixins.image_conditioned_proj import (  # type: ignore
                    DinoV3ProjFeatureExtractor,
                )
            except ImportError as exc:
                raise ProviderError(
                    "Pacchetto pixal3d non trovato: installa Pixal3D da github.com/TencentARC/Pixal3D"
                ) from exc
            pipe = Pixal3DImageTo3DPipeline.from_pretrained("TencentARC/Pixal3D")
            for name, cfg in PIXAL3D_COND.items():
                cond = DinoV3ProjFeatureExtractor(model_name=DINOV3, **cfg)
                cond.eval()
                setattr(pipe, f"image_cond_model_{name}", cond.cuda())
                if getattr(cond, "use_naf_upsample", False):
                    cond._load_naf()
            pipe.low_vram = False
            pipe.cuda()
        elif key == "trellis2":
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

    def _pixal3d_camera(self, image_path: str) -> dict[str, float]:
        """MoGe-2 field of view -> camera distance (upstream get_camera_params_wild_moge)."""
        import torch
        from PIL import Image

        if self._moge is None:
            from moge.model.v2 import MoGeModel  # type: ignore

            self._moge = MoGeModel.from_pretrained(MOGE).cuda().eval()
        pil = Image.open(image_path).convert("RGB")
        width = pil.size[0]
        tensor = torch.from_numpy(np.asarray(pil, dtype=np.float32) / 255.0).permute(2, 0, 1).cuda()
        with torch.no_grad():
            out = self._moge.infer(tensor)
        fx = float(out["intrinsics"].squeeze().cpu().numpy()[0, 0]) * width
        angle = 2 * math.atan(width / (2 * fx))
        # distance_from_fov() with grid point (-1, 0, 0), mesh_scale 1, 512 px target.
        res = 512
        f_pixels = (16.0 / math.tan(angle / 2.0)) * res / 32.0
        xw, yw = -0.5, 0.0  # rotated grid point / scale / 2
        distance = f_pixels * xw / (0 - res / 2.0) - yw
        return {"camera_angle_x": angle, "distance": distance, "mesh_scale": 1.0}

    def _to_glb_mesh(self, mesh: Any, pipe: Any, res: Any, rotate: bool, quality: str):
        import o_voxel  # type: ignore

        glb = o_voxel.postprocess.to_glb(
            vertices=mesh.vertices, faces=mesh.faces, attr_volume=mesh.attrs, coords=mesh.coords,
            attr_layout=getattr(pipe, "pbr_attr_layout", None) or mesh.layout,
            grid_size=res, aabb=[[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
            decimation_target=1_000_000 if quality == "high" else 500_000, texture_size=1024,
            remesh=True, remesh_band=1, remesh_project=0,
        )
        if rotate:
            glb.apply_transform(PIXAL3D_GLB_ROT)
        with tempfile.TemporaryDirectory(prefix="forma-") as tmp:
            path = Path(tmp) / "shape.glb"
            glb.export(path)
            return load_mesh_file(str(path))

    def english(self, prompt: str) -> str:
        """Italian -> English for FLUX with a small MarianMT model on the CPU (lazy, cached);
        the original prompt on any failure."""
        text = prompt.strip()
        model = self.settings.hf_translate_model
        if not text or not model or not looks_italian(text):
            return text
        try:
            if self._mt is None:
                from transformers import pipeline  # type: ignore

                self._mt = pipeline("translation", model=model, device=-1)
            return (self._mt(text)[0]["translation_text"] or "").strip() or text
        except Exception:
            return text

    def _flux_image(self, prompt: str, seed: int, progress: ProgressFn):
        import torch

        progress("image", 0.1, "Carico FLUX.1-schnell")
        flux = self._load_flux()
        progress("image", 0.4, "FLUX.1 crea l'immagine")
        gen = torch.Generator("cpu").manual_seed(int(seed))
        return flux(
            build_image_prompt(self.english(prompt)), guidance_scale=0.0, num_inference_steps=4,
            width=1024, height=1024, generator=gen,
        ).images[0]

    def image(self, prompt: str, seed: int = 0, progress: ProgressFn = lambda *a: None):
        ok, reason = self.available()
        if not ok:
            raise ProviderError(reason)
        with self._lock:
            return self._flux_image(prompt, seed, progress)

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
                image = self._flux_image(prompt, params.seed, progress)
            progress("image", 1.0, "Immagine pronta")
            progress("shape", 0.05, "Carico il modello 3D")
            pipe = self._load_shape(key)
            progress("shape", 0.2, "Genero la forma")
            if key in ("pixal3d", "trellis2"):
                resolution = {"draft": 1024, "standard": 1536, "high": 1536}.get(params.quality, 1536)
                processed = pipe.preprocess_image(image)
                kwargs: dict[str, Any] = dict(SAMPLERS, seed=int(params.seed),
                                              preprocess_image=False, return_latent=True)
                if key == "pixal3d":
                    with tempfile.TemporaryDirectory(prefix="forma-") as tmp:
                        path = str(Path(tmp) / "pre.png")
                        processed.save(path)
                        kwargs["camera_params"] = self._pixal3d_camera(path)
                    kwargs.update(pipeline_type=f"{resolution}_cascade", max_num_tokens=49152)
                else:
                    kwargs["pipeline_type"] = {1024: "1024_cascade", 1536: "1536_cascade"}[resolution]
                torch.manual_seed(int(params.seed))
                meshes, (_, _, res) = pipe.run(processed, **kwargs)
                progress("shape", 0.85, "Estraggo la superficie")
                mesh = self._to_glb_mesh(meshes[0], pipe, res, key == "pixal3d", params.quality)
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
            torch.cuda.empty_cache()
        progress("shape", 1.0, "Forma 3D pronta")
        return GenerationResult(mesh=mesh, image=image, model=key, meta={"up": "y"})
