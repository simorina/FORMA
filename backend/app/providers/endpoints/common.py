"""Shared helpers for Gradio Space calls."""

from __future__ import annotations

import time
from abc import ABC, abstractmethod
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any

from ..base import ModelInfo, ProgressFn, ProviderError

ClientFactory = Callable[[str], Any]  # space_id -> gradio_client.Client
# Optional live status from a Space: returns a short message (or None) while a call runs.
StatusPoll = Callable[[], "str | None"]


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


@contextmanager
def no_downloads(client: Any) -> Iterator[None]:
    """Leave output files on the Space for the calls inside: gradio_client downloads every
    file in a result unless ``download_files`` is False, and fails if one is refused."""
    saved = getattr(client, "download_files", None)
    client.download_files = False
    try:
        yield
    finally:
        client.download_files = saved


def friendly_error(exc: Exception, space: str) -> ProviderError:
    """Map a raw Space/HTTP failure to an Italian message plus a machine-readable kind.

    kind is one of: quota, auth, unavailable, network, error. Only ``auth`` is
    considered hopeless for an automatic fallback to another model.
    """
    text = str(exc)
    low = text.lower()
    if "quota" in low or "zerogpu" in low or "gpu duration" in low:
        return ProviderError(
            f"Quota GPU gratuita di Hugging Face esaurita per {space}. "
            "Aggiungi HF_TOKEN (meglio se PRO) nel file .env o riprova più tardi.",
            kind="quota",
        )
    if "401" in low or "unauthorized" in low or "invalid token" in low:
        return ProviderError(
            "HF_TOKEN non valido o senza permessi. Controlla il token su huggingface.co.",
            kind="auth",
        )
    if "sleeping" in low or "paused" in low or "building" in low or "runtime_error" in low:
        return ProviderError(
            f"Lo Space {space} non è attivo in questo momento (in pausa o in avvio).",
            kind="unavailable",
        )
    if "could not fetch config" in low or "connect" in low or "resolve" in low or "timed out" in low:
        return ProviderError(
            f"Impossibile raggiungere lo Space {space}: controlla la connessione.", kind="network"
        )
    return ProviderError(f"Errore dallo Space {space}: {text[:300]}", kind="error")


def call(
    client: Any,
    api_name: str,
    progress: ProgressFn,
    stage: str,
    label: str,
    timeout_s: float,
    span: tuple[float, float] = (0.0, 1.0),
    poll: StatusPoll | None = None,
    **kwargs: Any,
) -> Any:
    """Submit a Gradio job and relay queue/progress updates while waiting."""
    job = client.submit(api_name=api_name, **kwargs)
    start = time.monotonic()
    lo, hi = span
    last_poll, polled = 0.0, None
    while not job.done():
        if time.monotonic() - start > timeout_s:
            try:
                job.cancel()
            finally:
                raise ProviderError(f"Tempo scaduto in attesa di {label}.", kind="unavailable")
        message = label
        frac = None
        queued = False
        try:
            status = job.status()
            rank = getattr(status, "rank", None)
            queue_size = getattr(status, "queue_size", None)
            eta = getattr(status, "eta", None)
            pdata = getattr(status, "progress_data", None)
            if rank is not None and rank > 0:
                queued = True
                message = f"In coda: posizione {rank}" + (f"/{queue_size}" if queue_size else "")
                if eta:
                    message += f" · ~{int(eta)} s"
            elif pdata:
                last = pdata[-1]
                idx, length = getattr(last, "index", None), getattr(last, "length", None)
                if idx is not None and length:
                    frac = float(idx) / float(length)
                elif isinstance(getattr(last, "progress", None), (int, float)):
                    frac = float(last.progress)  # gr.Progress(fraction, desc=...)
                desc = getattr(last, "desc", None)
                if desc:
                    message = f"{label} · {desc}"
        except Exception:  # status() is best effort
            pass
        if poll is not None and not queued:
            now = time.monotonic()
            if now - last_poll > 1.5:
                last_poll = now
                try:
                    polled = poll()
                except Exception:  # live status is best effort too
                    polled = None
            if polled:
                message = f"{label} · {polled}"
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
    # Short Italian notes shown next to the model in the UI (licence, quota, ...).
    notes: tuple[str, ...] = ()

    def space_id(self, settings: Any) -> str:
        return getattr(settings, self.settings_attr)

    def info(self, default: bool = False) -> ModelInfo:
        return ModelInfo(self.key, self.label, self.description, self.license, default,
                         list(self.notes))

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
