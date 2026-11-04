"""tencent/Hunyuan3D-2.1 and Hunyuan3D-2mv Spaces.

Both expose shape_generation(caption, image, mv_image_front, mv_image_back,
mv_image_left, mv_image_right, steps, guidance_scale, seed, octree_resolution,
check_box_rembg, num_chunks, randomize_seed) -> (file, html, stats, seed).

License note: the Tencent Hunyuan 3D community license does NOT apply (= no
rights granted) in the European Union, the United Kingdom and South Korea.
"""

from __future__ import annotations

from .common import MESH_EXTS, ShapeEndpoint, call, extract_path
from .trellis import _handle

OCTREE = {"draft": 256, "standard": 384, "high": 512}
STEPS = {"draft": 20, "standard": 30, "high": 50}


class _HunyuanBase(ShapeEndpoint):
    multiview = False

    def run(self, client, image_path, seed, quality, progress, timeout_s):
        img = _handle(image_path)
        kwargs = dict(
            caption=None,
            image=None if self.multiview else img,
            mv_image_front=img if self.multiview else None,
            mv_image_back=None,
            mv_image_left=None,
            mv_image_right=None,
            steps=STEPS.get(quality, 30),
            guidance_scale=5.0,
            seed=int(seed),
            octree_resolution=OCTREE.get(quality, 384),
            check_box_rembg=True,
            num_chunks=8000,
            randomize_seed=False,
        )
        out = call(client, "/shape_generation", progress, "shape", f"{self.label} genera la forma",
                   timeout_s, (0.0, 1.0), **kwargs)
        path = extract_path(out, MESH_EXTS)
        if not path:
            raise RuntimeError(f"{self.label} non ha restituito una mesh")
        return path


class Hunyuan21Endpoint(_HunyuanBase):
    key = "hunyuan3d-2.1"
    label = "Hunyuan3D 2.1"
    description = (
        "Tencent, 2025. Ottima geometria, forte su superfici organiche. Licenza community Tencent: "
        "NON valida in UE, Regno Unito e Corea del Sud."
    )
    license = "Tencent Hunyuan 3D 2.1 Community License (esclusi UE/UK/KR)"
    settings_attr = "hf_space_hunyuan21"


class Hunyuan2mvEndpoint(_HunyuanBase):
    key = "hunyuan3d-2mv"
    label = "Hunyuan3D 2mv"
    description = "Tencent, variante multi-vista: qui usata con la sola vista frontale."
    license = "Tencent Hunyuan 3D Community License (esclusi UE/UK/KR)"
    settings_attr = "hf_space_hunyuan2mv"
    multiview = True
