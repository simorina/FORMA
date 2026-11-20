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
from .endpoints.pixal3d import TRIANGLES
from .idol_local import QUALITY as IDOL_QUALITY
from .idol_local import IdolRunner

HUNYUAN_LICENSE = "Tencent Hunyuan 3D 2.1 Community License (esclusi UE/UK/KR)"
LOCAL_MODELS = {
    "idol": ModelInfo(
        "idol", "Idol",
        "speridlabs/idol, ott. 2026, sulla tua GPU NVIDIA (8 GB di VRAM bastano): l'immagine "
        "diventa un milione di gaussiane, poi un solido chiuso a colori.",
        "Apache-2.0",
        notes=["Circa 2 minuti su una RTX 4070 portatile. Dal testo, l'immagine la fa FLUX su "
               "Hugging Face; il 3D resta sulla tua GPU."],
    ),
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
    description = "Il modello 3D gira sulla tua GPU NVIDIA: nessuna coda, nessuna quota."

    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self._lock = threading.Lock()
        self._flux: Any = None
        self._shape: dict[str, Any] = {}
        self._moge: Any = None
        self._mt: Any = None  # translation pipeline
        self._idol = IdolRunner(self.settings.data_dir, self.settings.idol_vae)
        self._hf: Provider | None = None
        self._client_factory: Any = None  # Gradio clients for the Hi3D Space (tests swap it)

    def _remote_images(self) -> bool:
        """Text -> image on Hugging Face instead of this GPU: FLUX.1-schnell wants ~24 GB of
        weights, so "auto" keeps it local only on a GPU with at least 20 GB."""
        mode = self.settings.local_text_to_image
        if mode in ("local", "remote"):
            return mode == "remote"
        try:
            import torch

            return torch.cuda.get_device_properties(0).total_memory < 20 * 2**30
        except Exception:
            return True

    def _remote(self) -> Provider:
        if self._hf is None:
            from .hf_remote import HFRemoteProvider

            self._hf = HFRemoteProvider(self.settings)
        return self._hf

    def _text_image(self, prompt: str, seed: int, progress: ProgressFn):
        if self._remote_images():
            return self._remote().image(prompt, seed, progress)
        return self._flux_image(prompt, seed, progress)

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

    def _to_glb_mesh(self, mesh: Any, pipe: Any, res: Any, rotate: bool):
        import o_voxel  # type: ignore

        glb = o_voxel.postprocess.to_glb(
            vertices=mesh.vertices, faces=mesh.faces, attr_volume=mesh.attrs, coords=mesh.coords,
            attr_layout=getattr(pipe, "pbr_attr_layout", None) or mesh.layout,
            grid_size=res, aabb=[[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
            decimation_target=TRIANGLES, texture_size=1024,  # 10M, as the Pixal3D Space
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
        the original prompt on any failure. On Hugging Face when the picture is made there."""
        if self._remote_images():
            return self._remote().english(prompt)
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
        if self._remote_images():
            return self._remote().image(prompt, seed, progress)
        ok, reason = self.available()
        if not ok:
            raise ProviderError(reason)
        with self._lock:
            return self._flux_image(prompt, seed, progress)

    def _idol_mesh(self, image: Any, params: GenParams, progress: ProgressFn) -> tuple[Any, dict[str, Any]]:
        """Idol's Gaussians for ``image``, made a closed coloured solid (Z up, unit cube)."""
        from ..pipeline.splats import splats_to_mesh

        if not IdolRunner.installed():
            raise ProviderError("Idol non è installato: esegui `make install-idol` (PyTorch con CUDA "
                                "e l'SDK di speridlabs).")
        # "real": a photo of a real object; "synthetic": a render or a generated picture.
        kind = str(params.extra.get("image_kind") or "")
        mode = kind if kind in ("real", "synthetic") else "synthetic"
        try:
            splats, _ = self._idol.generate(
                image, mode, params.seed, params.quality,
                lambda f, msg: progress("shape", 0.05 + 0.8 * f, msg))
        except Exception as exc:
            text = str(exc).lower()
            if "gated" in text or "terms" in text:
                raise ProviderError(
                    "Idol legge le immagini con DINOv3, un modello ad accesso vincolato: accetta i "
                    "termini su huggingface.co/facebook/dinov3-vith16plus-pretrain-lvd1689m con "
                    "l'account di HF_TOKEN.", kind="auth") from exc
            if "out of memory" in text:
                raise ProviderError("Memoria della GPU esaurita: chiudi i programmi che la usano "
                                    "(giochi, altri modelli) e riprova.") from exc
            raise
        progress("shape", 0.8, "Ricavo la superficie dalle gaussiane")
        _, _, cells = IDOL_QUALITY.get(params.quality, IDOL_QUALITY["standard"])
        mesh = splats_to_mesh(splats, resolution=cells)
        meta: dict[str, Any] = {"up": "z", "gaussians": len(splats), "idol_mode": mode}
        if params.extra.get("refine") == "hi3d":
            mesh = self._hi3d(image, mesh, params, progress, meta)
        return mesh, meta

    def _hi3d(self, image: Any, mesh: Any, params: GenParams, progress: ProgressFn,
              meta: dict[str, Any]) -> Any:
        """Idol's shape refined by Hi3D on its Space, or Idol's shape as it was (with the reason
        in ``meta``) when the Space cannot: never another model."""
        from .endpoints import hi3d

        space = self.settings.hf_space_hi3d
        progress("shape", 0.82, f"Connessione a {space}")
        try:
            if self._client_factory is None:
                from .hf_remote import default_client_factory

                self._client_factory = default_client_factory(self.settings)
            refined, grid = hi3d.refine(
                self._client_factory(space), image, mesh, params.quality, params.seed, progress,
                self.settings.hf_timeout_s, space=space, span=(0.83, 0.99))
        except Exception as exc:  # the Space is out of quota, asleep, changed its API...
            reason = str(exc) if isinstance(exc, ProviderError) else str(hi3d.friendly_error(exc, space))
            meta["hi3d_error"] = reason[:300]
            progress("shape", 0.99, "Hi3D non disponibile: tengo la forma di Idol")
            return mesh
        meta.update(refine="hi3d", hi3d_resolution=grid, hi3d_space=space)
        return refined

    def generate(self, prompt, image, params: GenParams, progress: ProgressFn = lambda *a: None):
        ok, reason = self.available()
        if not ok:
            raise ProviderError(reason)
        key = params.model or self.settings.local_shape_model
        if key not in LOCAL_MODELS:
            raise ProviderError(f"Modello locale sconosciuto: {key}")
        meta: dict[str, Any] = {"up": "y"}
        with self._lock:  # one generation at a time on the GPU
            if image is None:
                if not prompt:
                    raise ProviderError("Scrivi un prompt o carica un'immagine.")
                image = self._text_image(prompt, params.seed, progress)
                params.extra["image_kind"] = "synthetic"  # FLUX made it
            progress("image", 1.0, "Immagine pronta")
            if key == "idol":
                mesh, meta = self._idol_mesh(image, params, progress)
                progress("shape", 1.0, "Forma 3D pronta")
                return GenerationResult(mesh=mesh, image=image, model=key, meta=meta)
            import torch

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
                mesh = self._to_glb_mesh(meshes[0], pipe, res, key == "pixal3d")
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
        return GenerationResult(mesh=mesh, image=image, model=key, meta=meta)
