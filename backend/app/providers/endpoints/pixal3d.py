"""TencentARC/Pixal3D Space (SIGGRAPH 2026, MIT licence for code and weights).

Pixal3D is TRELLIS.2 (same O-Voxel representation, up to 1536^3) with pixel-aligned
conditioning: image features are back-projected into 3D with a camera estimated by
MoGe-2, so the geometry follows the input image much more faithfully.

The Space is a ``gradio.Server`` app (upstream ``app.py``, checked 2026-11) exposing:
  preprocess(image: FileData) -> FileData                      (background removal)
  generate_3d(image, seed, resolution: int, ss_*, shape_slat_*, tex_slat_*,
              manual_fov=-1.0, fov_unit="deg", session_id="") -> {"state_path", ...}
  extract_glb_api(state_path: str, decimation_target: int, texture_size: int,
                  session_id="") -> FileData (GLB, Y-up)
The latent state is a file on the Space (``state_path``), and ``GET /progress?session_id=``
reports the current stage, which we relay to the UI.
ZeroGPU reserves up to 30 + 120 + 240 s of GPU per model: with the anonymous quota the
call may be refused; HF_TOKEN (better PRO) avoids that, and hf_remote falls back to
TRELLIS.2 automatically.
"""

from __future__ import annotations

import uuid
from typing import Any

from .common import IMAGE_EXTS, MESH_EXTS, ShapeEndpoint, StatusPoll, call, extract_path
from .trellis import _handle

RESOLUTION = {"draft": 1024, "standard": 1536, "high": 1536}
# Triangles asked of extract_glb (the Space remeshes at its 1536³ grid, then simplifies to
# this) and the colour texture's size: "high" is the most Forma keeps (see process.py).
DECIMATION = {"draft": 200_000, "standard": 500_000, "high": 4_000_000}
TEXTURE = {"draft": 1024, "standard": 1024, "high": 4096}

# Upstream stage names (tqdm descriptions) -> Italian.
_STAGES = (
    ("camera", "stima della camera"),
    ("sampling", "campionamento"),
    ("sample", "campionamento"),
    ("render", "anteprime"),
    ("decod", "decodifica della forma"),
    ("remesh", "ricostruzione superficie"),
    ("decimat", "semplificazione"),
    ("simplif", "semplificazione"),
    ("uv", "mappatura UV"),
    ("bak", "texture"),
    ("texture", "texture"),
)


def _italian_stage(stage: str) -> str:
    low = stage.lower()
    for key, text in _STAGES:
        if key in low:
            return text
    return stage


def status_poller(client: Any, session_id: str) -> StatusPoll | None:
    """Poll the Space's /progress endpoint (best effort, short timeouts)."""
    base = getattr(client, "src", None)
    if not isinstance(base, str) or not base.startswith("http"):
        return None
    url = base.rstrip("/") + "/progress"

    def poll() -> str | None:
        import httpx

        data = httpx.get(url, params={"session_id": session_id}, timeout=1.5).json()
        if not isinstance(data, dict) or data.get("done"):
            return None
        stage = str(data.get("stage") or "")
        if not stage or stage.lower().startswith(("waiting", "initializing")):
            return None
        step, total = data.get("step") or 0, data.get("total") or 0
        text = _italian_stage(stage)
        return f"{text} {step}/{total}" if total and total > 1 else text

    return poll


class Pixal3DEndpoint(ShapeEndpoint):
    key = "pixal3d"
    label = "Pixal3D"
    description = (
        "Tencent ARC, SIGGRAPH 2026. Costruito su TRELLIS.2 (O-Voxel fino a 1536³) con "
        "condizionamento allineato ai pixel: la forma segue l'immagine molto più fedelmente."
    )
    license = "MIT"
    settings_attr = "hf_space_pixal3d"
    notes = (
        "Qualità geometrica migliore tra i modelli aperti (novembre 2026).",
        "Usa più quota GPU: con HF_TOKEN PRO non ci sono limiti pratici.",
    )

    def run(self, client, image_path, seed, quality, progress, timeout_s):
        session_id = uuid.uuid4().hex
        poll = status_poller(client, session_id)
        pre = call(client, "/preprocess", progress, "shape", "Scontorno immagine",
                   timeout_s, (0.0, 0.06), image=_handle(image_path))
        pre_path = extract_path(pre, IMAGE_EXTS) or image_path
        out = call(client, "/generate_3d", progress, "shape", "Pixal3D genera la forma",
                   timeout_s, (0.06, 0.78), poll=poll,
                   image=_handle(pre_path), seed=int(seed),
                   resolution=RESOLUTION.get(quality, 1536),
                   ss_guidance_strength=7.5, ss_guidance_rescale=0.7, ss_sampling_steps=12,
                   ss_rescale_t=5.0,
                   shape_slat_guidance_strength=7.5, shape_slat_guidance_rescale=0.5,
                   shape_slat_sampling_steps=12, shape_slat_rescale_t=3.0,
                   tex_slat_guidance_strength=1.0, tex_slat_guidance_rescale=0.0,
                   tex_slat_sampling_steps=12, tex_slat_rescale_t=3.0,
                   manual_fov=-1.0, fov_unit="deg", session_id=session_id)
        state_path = out.get("state_path") if isinstance(out, dict) else None
        if not state_path:
            raise RuntimeError("Pixal3D non ha restituito lo stato della forma")
        glb = call(client, "/extract_glb_api", progress, "shape", "Estrazione mesh", timeout_s,
                   (0.78, 1.0), poll=poll, state_path=state_path,
                   decimation_target=DECIMATION.get(quality, 500_000),
                   texture_size=TEXTURE.get(quality, 1024),
                   session_id=session_id)
        path = extract_path(glb, MESH_EXTS)
        if not path:
            raise RuntimeError("Pixal3D non ha restituito un file GLB")
        return path
