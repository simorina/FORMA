"""microsoft/TRELLIS.2 and TRELLIS (v1) Spaces.

TRELLIS.2 app.py (upstream, checked 2026-11): preprocess_image(input) -> image;
image_to_3d(image, seed, resolution, ss_*, shape_slat_*, tex_slat_*) -> (state, html);
extract_glb(state, decimation_target, texture_size) -> (glb, glb).
The state lives server-side in the gradio session, so the same Client must be
used for image_to_3d and extract_glb (gradio_client keeps the session hash).
"""

from __future__ import annotations

from typing import Any

from .common import IMAGE_EXTS, MESH_EXTS, ShapeEndpoint, call, extract_path

RESOLUTION = {"draft": "512", "standard": "1024", "high": "1536"}
# Triangles asked of extract_glb, whatever the quality: the most the Space's "Decimation
# Target" slider allows (100k-500k, app.py checked 2026-11). The preparation then refines
# the mesh to the 5M every print has (pipeline/refine.py).
TRIANGLES = 500_000


def _handle(path: str) -> Any:
    from gradio_client import handle_file

    return handle_file(path)


class Trellis2Endpoint(ShapeEndpoint):
    key = "trellis2"
    label = "TRELLIS.2 · 4B"
    description = (
        "Microsoft, dic. 2025. Voxel O-Voxel fino a 1536³: la geometria più pulita e dettagliata "
        "tra i modelli aperti, gestisce anche parti sottili e topologie complesse."
    )
    license = "MIT"
    settings_attr = "hf_space_trellis2"
    notes = ("Alternativa solida e più leggera: usata in automatico se Pixal3D non risponde.",)

    def run(self, client, image_path, seed, quality, progress, timeout_s):
        pre = call(client, "/preprocess_image", progress, "shape", "Scontorno immagine",
                   timeout_s, (0.0, 0.08), input=_handle(image_path))
        pre_path = extract_path(pre, IMAGE_EXTS) or image_path
        call(client, "/image_to_3d", progress, "shape", "TRELLIS.2 genera la forma", timeout_s,
             (0.08, 0.8),
             image=_handle(pre_path), seed=int(seed), resolution=RESOLUTION.get(quality, "1024"),
             ss_guidance_strength=7.5, ss_guidance_rescale=0.7, ss_sampling_steps=12,
             ss_rescale_t=5.0,
             shape_slat_guidance_strength=7.5, shape_slat_guidance_rescale=0.5,
             shape_slat_sampling_steps=12, shape_slat_rescale_t=3.0,
             tex_slat_guidance_strength=1.0, tex_slat_guidance_rescale=0.0,
             tex_slat_sampling_steps=12, tex_slat_rescale_t=3.0)
        glb = call(client, "/extract_glb", progress, "shape", "Estrazione mesh", timeout_s,
                   (0.8, 1.0), decimation_target=TRIANGLES, texture_size=1024)
        path = extract_path(glb, MESH_EXTS)
        if not path:
            raise RuntimeError("TRELLIS.2 non ha restituito un file GLB")
        return path


class TrellisEndpoint(ShapeEndpoint):
    key = "trellis"
    label = "TRELLIS · v1"
    description = "Microsoft, 2024. Predecessore di TRELLIS.2: più leggero, geometria buona ma meno fine."
    license = "MIT"
    settings_attr = "hf_space_trellis"

    def run(self, client, image_path, seed, quality, progress, timeout_s):
        pre = call(client, "/preprocess_image", progress, "shape", "Scontorno immagine",
                   timeout_s, (0.0, 0.1), image=_handle(image_path))
        pre_path = extract_path(pre, IMAGE_EXTS) or image_path
        steps = {"draft": 8, "standard": 12, "high": 25}.get(quality, 12)
        call(client, "/image_to_3d", progress, "shape", "TRELLIS genera la forma", timeout_s,
             (0.1, 0.8), image=_handle(pre_path), multiimages=[], is_multiimage=False,
             seed=int(seed), ss_guidance_strength=7.5, ss_sampling_steps=steps,
             slat_guidance_strength=3.0, slat_sampling_steps=steps,
             multiimage_algo="stochastic")
        glb = call(client, "/extract_glb", progress, "shape", "Estrazione mesh", timeout_s,
                   (0.8, 1.0), mesh_simplify=0.9, texture_size=1024)
        path = extract_path(glb, MESH_EXTS)
        if not path:
            raise RuntimeError("TRELLIS non ha restituito un file GLB")
        return path
