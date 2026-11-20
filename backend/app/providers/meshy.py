"""meshy provider: Meshy's REST API (https://docs.meshy.ai, checked 2026-11), with your own key.

- From a picture: ``POST /openapi/v1/image-to-3d`` (geometry and texture in one task).
- From a prompt: ``POST /openapi/v2/text-to-3d`` ``mode: preview`` (the mesh), then
  ``mode: refine`` with ``preview_task_id`` (the texture). Meshy bills them separately. As on
  meshy.ai, the words go to Meshy as written (it reads Italian too): no translation and no
  FLUX picture in between.
- Every task is polled with ``GET .../{id}`` until ``SUCCEEDED``, ``FAILED`` or ``CANCELED``,
  waiting what ``Retry-After`` says; then the GLB is downloaded (Meshy keeps it 3 days).

Quality -> geometry: ``draft`` the standard pass, ``standard`` Ultra 2K (2048³), ``high`` Ultra
4K (4096³). The textured GLB the API hands over has ~400-700k faces even in Ultra 4K
(three models, Nov 2026): the fine detail is in the 4K texture, read at ~10M triangles
(pipeline/texture.py). Always Meshy 7.1,
no remesh (Meshy's advice for the best mesh), GLB only. Credits (Pro plan, Nov 2026): image
30 (+5 for Ultra), prompt 20 (+5) + 10 for the texture.

Relief (``POST /openapi/v1/relief``, Nov 2026): one photo -> a bas-relief, already at its real
size in millimetres with Z up (the STL), 20 credits. Quality -> mesh points along the photo's
longer side: 512, 1024, 2048 (an STL of ~100 MB at 1024, ~300 MB at 2048).

As Meshy asks: a create request is never sent again by itself after a timeout or a 5xx (the
task may exist and be billed); polls are retried. The shared test-mode key was retired on
2026-09-16: a real key from https://www.meshy.ai/developers/keys is needed (MESHY_API_KEY).
"""

from __future__ import annotations

import base64
import io
import tempfile
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
from PIL import Image

from ..config import Settings, get_settings
from .base import (
    GenerationResult,
    GenParams,
    ModelInfo,
    ProgressFn,
    Provider,
    ProviderError,
    load_mesh_file,
)

API = "https://api.meshy.ai/openapi"
AI_MODEL = "meshy-7.1"
GEOMETRY = {"draft": "standard", "standard": "2k", "high": "4k"}
TEXTURE = {"draft": "2k", "standard": "2k", "high": "4k"}
# Meshy's own timeouts: create 60 s, status 30 s; poll every Retry-After (5 s if missing).
CREATE_TIMEOUT_S, GET_TIMEOUT_S, POLL_S = 60.0, 30.0, 5.0
FINAL = ("SUCCEEDED", "FAILED", "CANCELED")
RELIEF = "relief"
RELIEF_RESOLUTION = {"draft": 512, "standard": 1024, "high": 2048}


def _number(raw: dict[str, Any], key: str, lo: float, hi: float, default: float | None) -> float | None:
    value = raw.get(key)
    if value is None or value == "":
        return default
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"Rilievo: {key} non è un numero") from exc
    if not lo <= number <= hi:
        raise ValueError(f"Rilievo: {key} va da {lo:g} a {hi:g}")
    return number


def relief_options(raw: dict[str, Any] | None, size_mm: float, quality: str) -> dict[str, Any]:
    """The Relief request for these choices, every value within Meshy's ranges (ValueError, in
    Italian, otherwise). Choices that Meshy would bill for an empty model are refused here."""
    raw = dict(raw or {})
    variant = raw.get("variant") or "high"  # deeper carving, for 3D-printed pieces
    carving = raw.get("carving_mode") or "emboss"
    bend = raw.get("bend_mode") or "off"
    if variant not in ("high", "low") or carving not in ("emboss", "engrave") or bend not in ("off", "convex", "concave"):
        raise ValueError("Rilievo: stile, effetto o curvatura non validi")
    remove_base = bool(raw.get("remove_base"))
    depth = _number(raw, "carving_depth_mm", 0.0, 60.0, None)
    if remove_base and depth is not None and depth <= 0:
        raise ValueError("Rilievo: senza base serve una profondità maggiore di 0 mm (il modello sarebbe vuoto)")
    body: dict[str, Any] = {
        "variant": variant, "carving_mode": carving, "remove_base": remove_base,
        "size_mm": round(min(max(float(size_mm), 20.0), 250.0), 2),
        "mesh_resolution": RELIEF_RESOLUTION.get(quality, 1024), "bend_mode": bend,
        "should_generate_model": True,
    }
    if depth is not None:
        body["carving_depth_mm"] = depth
    if not remove_base:
        body["base_thickness_mm"] = _number(raw, "base_thickness_mm", 0.1, 10.0, 1.0)
    if bend != "off":
        axis = raw.get("bend_axis") or "xz"
        if axis not in ("xz", "yz"):
            raise ValueError("Rilievo: asse della curvatura non valido")
        body["bend_axis"] = axis
        body["bend_angle"] = _number(raw, "bend_angle", 0.0, 360.0, 60.0)
    return body


def _data_uri(image: Image.Image) -> str:
    """The picture as a PNG data URI (Meshy takes up to 20 MB; Forma's are at most 2048 px)."""
    buf = io.BytesIO()
    image.convert("RGBA" if image.mode in ("RGBA", "LA", "P") else "RGB").save(buf, "PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def _api_error(res: httpx.Response) -> ProviderError:
    """An HTTP error from Meshy, in Italian, with a kind for the job's message."""
    try:
        detail = str(res.json().get("message") or res.text)
    except Exception:  # noqa: BLE001 - not JSON
        detail = res.text
    detail = detail[:300]
    code = res.status_code
    if code == 401:
        return ProviderError("Chiave Meshy non valida o revocata: controlla MESHY_API_KEY nel file .env.", kind="auth")
    if code == 402:
        return ProviderError("Crediti Meshy esauriti: ricaricali nelle impostazioni dell'abbonamento Meshy.", kind="quota")
    if code == 403:
        return ProviderError(f"Meshy rifiuta la richiesta ({detail}). Se la chiave ha una lista di IP, "
                             "aggiungi quello di questo computer.", kind="auth")
    if code == 429:
        return ProviderError("Troppe richieste a Meshy in questo momento: riprova tra poco.", kind="quota")
    if code >= 500:
        return ProviderError(f"Meshy non risponde ({code}). Il task potrebbe essere partito lo stesso: "
                             "controlla su meshy.ai prima di riprovare.", kind="unavailable")
    return ProviderError(f"Meshy non accetta la richiesta: {detail}", kind="error")


class MeshyProvider(Provider):
    name = "meshy"
    label = "Meshy"
    description = ("Meshy 7.1 sul cloud di Meshy, con la tua chiave: da prompt o da immagine, "
                   "con i colori. Usa crediti Meshy.")

    def __init__(self, settings: Settings | None = None, transport: httpx.BaseTransport | None = None,
                 sleep: Callable[[float], None] = time.sleep) -> None:
        self.settings = settings or get_settings()
        self._transport = transport  # tests swap the network
        self._sleep = sleep

    # -- the provider interface ----------------------------------------------------------
    def models(self) -> list[ModelInfo]:
        return [ModelInfo(
            "meshy-7.1", "Meshy 7.1",
            "Meshy, 2026: forma e texture in un solo servizio, geometria Ultra fino a 4096³ "
            "(qualità Alta), circa 10 milioni di facce.",
            "Commerciale (crediti Meshy)", default=True,
            notes=["Immagine: 30 crediti (35 in Standard e Alta, geometria Ultra). Prompt: 30 "
                   "(35), forma e colori in due passi."],
        )]

    def available(self) -> tuple[bool, str]:
        if self.settings.meshy_api_key:
            return True, ""
        return False, "Aggiungi MESHY_API_KEY nel file .env (chiave da meshy.ai/developers/keys)."

    def generate(self, prompt, image, params: GenParams, progress: ProgressFn = lambda *a: None):
        ok, reason = self.available()
        if not ok:
            raise ProviderError(reason, kind="auth")
        quality = params.quality if params.quality in GEOMETRY else "standard"
        if params.model == RELIEF:
            return self._relief(image, params, progress)
        meta: dict[str, Any] = {"up": "y", "meshy_model": AI_MODEL,
                                "meshy_geometry": GEOMETRY[quality]}
        with self._client() as client:
            if image is not None:
                progress("image", 1.0, "Immagine pronta")
                task = self._run(client, "v1/image-to-3d", {
                    "image_url": _data_uri(image), "ai_model": AI_MODEL,
                    "geometry_resolution": GEOMETRY[quality], "should_texture": True,
                    "texture_resolution": TEXTURE[quality], "enable_pbr": False,
                    "should_remesh": False, "target_formats": ["glb"],
                }, progress, "Meshy crea il modello", (0.02, 0.95))
                meta["meshy_task"] = task["id"]
                credits = int(task.get("consumed_credits") or 0)
            else:
                if not prompt:
                    raise ProviderError("Scrivi un prompt o carica un'immagine.")
                # as on meshy.ai: the prompt as written, Meshy's limit is 800 characters
                progress("image", 1.0, "Meshy lavora dal tuo prompt")
                preview = self._run(client, "v2/text-to-3d", {
                    "mode": "preview", "prompt": prompt.strip()[:800], "ai_model": AI_MODEL,
                    "geometry_resolution": GEOMETRY[quality], "should_remesh": False,
                    "target_formats": ["glb"],
                }, progress, "Meshy crea la forma", (0.02, 0.6))
                task = self._run(client, "v2/text-to-3d", {
                    "mode": "refine", "preview_task_id": preview["id"],
                    "texture_resolution": TEXTURE[quality], "enable_pbr": False,
                    "target_formats": ["glb"],
                }, progress, "Meshy dipinge i colori", (0.6, 0.95))
                meta.update(meshy_preview=preview["id"], meshy_task=task["id"])
                credits = int(preview.get("consumed_credits") or 0) + int(task.get("consumed_credits") or 0)
            if credits:
                meta["meshy_credits"] = credits
            url = (task.get("model_urls") or {}).get("glb")
            if not url:
                raise ProviderError("Meshy ha finito ma non ha restituito un file GLB.")
            progress("shape", 0.97, "Scarico il modello da Meshy")
            mesh = self._download(url, "glb")
        progress("shape", 1.0, "Forma 3D ricevuta")
        return GenerationResult(mesh=mesh, image=image, model=AI_MODEL, meta=meta)

    def _relief(self, image: Image.Image | None, params: GenParams, progress: ProgressFn) -> GenerationResult:
        """A bas-relief from the photo: Meshy's STL, in millimetres with Z up, lying on the bed."""
        if image is None:
            raise ProviderError("Carica la foto da cui fare il rilievo.")
        body = dict(params.extra.get("relief") or {})
        if not body:
            raise ProviderError("Rilievo: opzioni mancanti.")
        progress("image", 1.0, "Foto pronta")
        with self._client() as client:
            task = self._run(client, "v1/relief", {"image_url": _data_uri(image), **body},
                             progress, "Meshy scolpisce il rilievo", (0.02, 0.9))
        url = (task.get("model_urls") or {}).get("stl")
        if not url:
            raise ProviderError("Meshy ha finito il rilievo ma senza il file STL.")
        progress("shape", 0.92, "Scarico il rilievo da Meshy")
        mesh = self._download(url, "stl")
        if len(mesh.faces) == 0:
            raise ProviderError("Il rilievo è vuoto: aumenta la profondità o tieni la base.")
        meta: dict[str, Any] = {"up": "z", "meshy_task": task["id"], "relief_variant": body["variant"],
                                "relief_carving": body["carving_mode"], "relief_size_mm": body["size_mm"],
                                "relief_resolution": body["mesh_resolution"], "relief_bend": body["bend_mode"]}
        if task.get("consumed_credits"):
            meta["meshy_credits"] = int(task["consumed_credits"])
        progress("shape", 1.0, "Rilievo ricevuto")
        return GenerationResult(mesh=mesh, image=image, model=RELIEF, meta=meta)

    # -- HTTP ----------------------------------------------------------------------------
    def _client(self) -> httpx.Client:
        return httpx.Client(base_url=API, transport=self._transport, follow_redirects=True,
                            headers={"Authorization": f"Bearer {self.settings.meshy_api_key}"})

    def _run(self, client: httpx.Client, path: str, body: dict[str, Any], progress: ProgressFn,
             label: str, span: tuple[float, float]) -> dict[str, Any]:
        """Create one task (never resent by itself) and wait for it to finish."""
        lo, hi = span
        progress("shape", lo, f"{label}: invio a Meshy")
        try:
            res = client.post(f"/{path}", json=body, timeout=CREATE_TIMEOUT_S)
        except httpx.HTTPError as exc:
            raise ProviderError(f"Meshy non risponde ({exc.__class__.__name__}). Il task potrebbe essere "
                                "partito lo stesso: controlla su meshy.ai prima di riprovare.",
                                kind="network") from exc
        if res.status_code >= 400:
            raise _api_error(res)
        task_id = str(res.json()["result"])
        deadline = time.monotonic() + self.settings.meshy_timeout_s
        while True:
            wait = POLL_S
            try:
                got = client.get(f"/{path}/{task_id}", timeout=GET_TIMEOUT_S)
            except httpx.HTTPError:
                got = None  # a network blip: the task goes on, ask again
            if got is not None:
                wait = float(got.headers.get("Retry-After") or POLL_S)
                if got.status_code == 429 or got.status_code >= 500:
                    pass  # not a task failure: ask again
                elif got.status_code >= 400:
                    raise _api_error(got)
                else:
                    task = got.json()
                    status = task.get("status")
                    if status == "SUCCEEDED":
                        progress("shape", hi, f"{label}: fatto")
                        return task
                    if status in FINAL:
                        why = (task.get("task_error") or {}).get("message") or status
                        refund = " I crediti sono stati restituiti." if status == "FAILED" else ""
                        raise ProviderError(f"Meshy non è riuscito: {why}.{refund}")
                    frac = max(0, min(int(task.get("progress") or 0), 100)) / 100
                    where = "in coda" if status == "PENDING" else f"{int(frac * 100)}%"
                    progress("shape", lo + (hi - lo) * frac, f"{label} · {where}")
            if time.monotonic() > deadline:
                raise ProviderError(f"Meshy non ha finito in {int(self.settings.meshy_timeout_s // 60)} minuti. "
                                    f"Il task {task_id} continua su meshy.ai: non lo rilancio per non "
                                    "pagarlo due volte.", kind="unavailable")
            self._sleep(max(1.0, min(wait, 30.0)))

    def _download(self, url: str, ext: str):
        """A model file from Meshy's storage: a client of its own, so the key never goes there."""
        try:
            with httpx.Client(transport=self._transport, follow_redirects=True) as files:
                res = files.get(url, timeout=120.0)
            res.raise_for_status()
        except httpx.HTTPError as exc:
            raise ProviderError(f"Download del modello da Meshy non riuscito: {exc}", kind="network") from exc
        with tempfile.TemporaryDirectory(prefix="forma-meshy-") as tmp:
            path = Path(tmp) / f"model.{ext}"
            path.write_bytes(res.content)
            return load_mesh_file(str(path), file_type=ext)
