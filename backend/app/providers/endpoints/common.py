"""Shared helpers for Gradio Space calls."""

from __future__ import annotations

import time
from abc import ABC, abstractmethod
from collections.abc import Callable
from typing import Any

from ..base import ModelInfo, ProgressFn, ProviderError

ClientFactory = Callable[[str], Any]  # space_id -> gradio_client.Client


def extract_path(result: Any, exts: tuple[str, ...] = ()) -> str | None:
    """Find the first file path inside a (nested) Gradio result."""
    if result is None:
        return None
    if isinstance(result, str):
        if not exts or result.lower().endswith(exts):
            return result
        return None
    if isinstance(result, dict):
        for key in ("path", "value", "name", "url"):
            found = extract_path(result.get(key), exts)
            if found:
                return found
        return None
    if isinstance(result, (list, tuple)):
        for item in result:
            found = extract_path(item, exts)
            if found:
                return found
    return None


MESH_EXTS = (".glb", ".gltf", ".obj", ".ply", ".stl", ".off")
IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp")


def friendly_error(exc: Exception, space: str) -> ProviderError:
    text = str(exc)
    low = text.lower()
    if "quota" in low or "zerogpu" in low or "gpu duration" in low:
        return ProviderError(
            f"Quota GPU gratuita di Hugging Face esaurita per {space}. "
            "Aggiungi HF_TOKEN (meglio se PRO) nel file .env o riprova più tardi."
        )
    if "401" in low or "unauthorized" in low or "invalid token" in low:
        return ProviderError("HF_TOKEN non valido o senza permessi. Controlla il token su huggingface.co.")
    if "sleeping" in low or "paused" in low or "building" in low or "runtime_error" in low:
        return ProviderError(f"Lo Space {space} non è attivo in questo momento (in pausa o in avvio).")
    if "could not fetch config" in low or "connect" in low or "resolve" in low or "timed out" in low:
        return ProviderError(f"Impossibile raggiungere lo Space {space}: controlla la connessione.")
    return ProviderError(f"Errore dallo Space {space}: {text[:300]}")


def call(
    client: Any,
    api_name: str,
    progress: ProgressFn,
    stage: str,
    label: str,
    timeout_s: float,
    span: tuple[float, float] = (0.0, 1.0),
    **kwargs: Any,
) -> Any:
    """Submit a Gradio job and relay queue/progress updates while waiting."""
    job = client.submit(api_name=api_name, **kwargs)
    start = time.monotonic()
    lo, hi = span
    while not job.done():
        if time.monotonic() - start > timeout_s:
            try:
                job.cancel()
            finally:
                raise ProviderError(f"Tempo scaduto in attesa di {label}.")
        message = label
        frac = None
        try:
            status = job.status()
            rank = getattr(status, "rank", None)
            queue_size = getattr(status, "queue_size", None)
            eta = getattr(status, "eta", None)
            pdata = getattr(status, "progress_data", None)
            if rank is not None and rank > 0:
                message = f"In coda: posizione {rank}" + (f"/{queue_size}" if queue_size else "")
                if eta:
                    message += f" · ~{int(eta)} s"
            elif pdata:
                last = pdata[-1]
                idx, length = getattr(last, "index", None), getattr(last, "length", None)
                if idx is not None and length:
                    frac = float(idx) / float(length)
                desc = getattr(last, "desc", None)
                if desc:
                    message = f"{label} · {desc}"
        except Exception:  # status() is best effort
            pass
        elapsed = time.monotonic() - start
        if frac is None:
            # Ease towards the end of the span while we wait.
            frac = 1.0 - 1.0 / (1.0 + elapsed / 45.0)
        progress(stage, lo + (hi - lo) * min(frac, 0.98), message)
        time.sleep(0.5)
    return job.result()


class ShapeEndpoint(ABC):
    key: str = ""
    label: str = ""
    description: str = ""
    license: str = ""
    settings_attr: str = ""  # Settings field holding the Space id

    def space_id(self, settings: Any) -> str:
        return getattr(settings, self.settings_attr)

    def info(self, default: bool = False) -> ModelInfo:
        return ModelInfo(self.key, self.label, self.description, self.license, default)

    @abstractmethod
    def run(
        self,
        client: Any,
        image_path: str,
        seed: int,
        quality: str,
        progress: ProgressFn,
        timeout_s: float,
    ) -> str:
        """Return the local path of the generated mesh file."""
