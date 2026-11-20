"""Hi3D v1.0 (hi3d-official/Hi3Dv1.0, Oct 2026): refines a coarse mesh into high-resolution
geometry, up to a 1536³ extraction grid, conditioned on the picture of the same object.

Space ``hugging-apps/hi3dv1`` (ZeroGPU, app.py checked 2026-11):
  refine(image, coarse_mesh, resolution: 512 | 1024 | 1536, num_inference_steps, seed,
         randomize_seed, remove_background)
      -> (coarse GLB, refined GLB, refined GLB as a file, coarse GLB as a file, seed, status)
It reserves 40 + 20, 225 + 20 or 440 + 20 s of GPU (one, two or three passes). Without a coarse
mesh the Space makes one with Hunyuan3D-2mini, whose licence grants no rights in the EU: Forma
always sends its own (Idol's), so that never runs.

The output is geometry only, mean-centred with unit radius. The coarse mesh goes in the
convention of the image->3D Spaces (glTF, Y up, the picture's view facing +Z), which is Idol's
frame turned Y up: checked on the same picture, Idol's mesh and TRELLIS.2's line up within 5°.
The refined mesh comes back into the coarse mesh's frame and box, with its colours.

Licence: Hi3D Open License 1.0 (no territorial exclusions; outputs are yours to use and sell).
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any

import trimesh
from PIL import Image

from ...exporters import Z_UP_TO_Y_UP
from ...pipeline.colors import carry
from ...pipeline.process import decimate, to_z_up
from ..base import ProgressFn, load_mesh_file
from .common import MESH_EXTS, call, extract_path, friendly_error
from .trellis import _handle

SPACE = "hugging-apps/hi3dv1"
LICENSE = "Hi3D Open License 1.0"
# Extraction grid per quality: 1, 2 or 3 passes.
RESOLUTION = {"draft": 512, "standard": 1024, "high": 1536}
# The coarse mesh only places Hi3D's first 64³ grid: this many triangles hold all of it and
# keep the upload small (~5 MB).
COARSE_FACES = 300_000


def refine(client: Any, image: Image.Image, coarse: trimesh.Trimesh, quality: str, seed: int,
           progress: ProgressFn, timeout_s: float, space: str = SPACE,
           span: tuple[float, float] = (0.0, 1.0)) -> tuple[trimesh.Trimesh, int]:
    """``coarse`` (Z up, any units, with colours) refined by Hi3D on the Space: the refined
    surface in the same frame and box, with ``coarse``'s colours. Returns it and the grid."""
    resolution = RESOLUTION.get(quality, RESOLUTION["standard"])
    sent = decimate(trimesh.Trimesh(coarse.vertices, coarse.faces, process=False), COARSE_FACES)
    sent.apply_transform(Z_UP_TO_Y_UP)
    with tempfile.TemporaryDirectory(prefix="forma-hi3d-") as tmp:
        glb = Path(tmp) / "coarse.glb"
        sent.export(glb)
        picture = Path(tmp) / "image.png"
        image.save(picture)
        try:
            out = call(client, "/refine", progress, "shape", f"Hi3D rifinisce la forma ({resolution}³)",
                       timeout_s, span, image=_handle(str(picture)), coarse_mesh=_handle(str(glb)),
                       resolution=resolution, num_inference_steps=25, seed=int(seed) % 2**31,
                       randomize_seed=False, remove_background=True)
        except Exception as exc:
            raise friendly_error(exc, space) from exc
        refined = out[1] if isinstance(out, (list, tuple)) and len(out) > 1 else out
        path = extract_path(refined, MESH_EXTS)
        if not path:
            raise RuntimeError("Hi3D non ha restituito una mesh")
        mesh = load_mesh_file(path)
    mesh = to_z_up(trimesh.Trimesh(mesh.vertices, mesh.faces, process=False), "y")
    if len(mesh.faces) == 0 or mesh.extents.max() <= 0:
        raise RuntimeError("Hi3D ha restituito una mesh vuota")
    # Hi3D centres and normalises its output: back onto the coarse mesh's box.
    mesh.apply_scale(coarse.extents.max() / mesh.extents.max())
    mesh.apply_translation(coarse.bounds.mean(axis=0) - mesh.bounds.mean(axis=0))
    return carry(coarse, mesh), resolution
