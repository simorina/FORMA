"""stepfun-ai/Step1X-3D Space.

app.py: generate_func(input_image_path, guidance_scale, inference_steps,
max_facenum, symmetry, edge_type) -> (geometry_glb, textured_glb).
"""

from __future__ import annotations

from .common import MESH_EXTS, ShapeEndpoint, call, extract_path
from .trellis import _handle


class Step1XEndpoint(ShapeEndpoint):
    key = "step1x-3d"
    label = "Step1X-3D"
    description = "StepFun, 2025. Geometria a SDF con bordi netti, buona per oggetti meccanici."
    license = "Apache-2.0"
    settings_attr = "hf_space_step1x"

    def run(self, client, image_path, seed, quality, progress, timeout_s):
        steps = {"draft": 25, "standard": 50, "high": 75}.get(quality, 50)
        out = call(client, "/generate_func", progress, "shape", "Step1X-3D genera la forma",
                   timeout_s, (0.0, 1.0), input_image_path=_handle(image_path),
                   guidance_scale=7.5, inference_steps=steps, max_facenum=400000,
                   symmetry="x", edge_type="sharp")
        # First output is the untextured geometry: exactly what we want.
        first = out[0] if isinstance(out, (list, tuple)) and out else out
        path = extract_path(first, MESH_EXTS) or extract_path(out, MESH_EXTS)
        if not path:
            raise RuntimeError("Step1X-3D non ha restituito una mesh")
        return path
