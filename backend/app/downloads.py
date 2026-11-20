"""Downloads: a model written in a format as a job with progress, checked, then served once.

``POST /api/models/{id}/export?format=obj`` starts one; ``GET /api/exports/{id}`` says how far it
is (reading the model, writing the file, checking it); ``GET /api/exports/{id}/file`` sends the
checked file with its length, so the browser can show how much is left, and deletes it once
sent. A file nobody fetched goes after an hour.
"""

from __future__ import annotations

import logging
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .exporters import FORMATS, LABELS, ExportError, write_export
from .storage import ModelStore

log = logging.getLogger(__name__)

# Share of the bar for reading the model, writing the file and checking it, per format: their
# times at 5M triangles (s): read 1; write STL 1.1, 3MF 6.2, OBJ 3.5, GLB 1.1; check 0, 3.5, 0.5, 2.3.
WEIGHTS = {"stl": (0.45, 0.53, 0.02), "3mf": (0.09, 0.58, 0.33),
           "obj": (0.2, 0.7, 0.1), "glb": (0.23, 0.25, 0.52)}


class Cancelled(Exception):
    pass


@dataclass
class ExportJob:
    id: str
    model_id: str
    fmt: str
    filename: str
    status: str = "running"  # running | ready | error | cancelled
    stage: str = "load"  # load | write | check | ready
    progress: float = 0.0
    message: str = "Leggo il modello"
    size: int | None = None
    error: str | None = None
    created_at: float = field(default_factory=time.time)
    path: Path | None = None
    cancel: threading.Event = field(default_factory=threading.Event)

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "model_id": self.model_id, "format": self.fmt,
                "filename": self.filename, "status": self.status, "stage": self.stage,
                "progress": round(self.progress, 4), "message": self.message, "size": self.size,
                "error": self.error, "url": f"/api/exports/{self.id}/file"}


class ExportManager:
    def __init__(self, store: ModelStore, root: Path, max_workers: int = 2, ttl_s: float = 3600) -> None:
        self.store = store
        self.dir = Path(root) / "exports"
        self.dir.mkdir(parents=True, exist_ok=True)
        for stale in self.dir.iterdir():  # files of a previous run: their jobs are gone
            stale.unlink(missing_ok=True)
        self.ttl_s = ttl_s
        self.jobs: dict[str, ExportJob] = {}
        self._lock = threading.Lock()
        self._pool = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="forma-export")

    def start(self, model_id: str, fmt: str, filename: str) -> ExportJob:
        if fmt not in FORMATS:
            raise ValueError(f"Formato non supportato: {fmt}")
        self._sweep()
        job = ExportJob(id=uuid.uuid4().hex[:12], model_id=model_id, fmt=fmt, filename=filename)
        with self._lock:
            self.jobs[job.id] = job
        self._pool.submit(self._run, job)
        return job

    def get(self, export_id: str) -> ExportJob | None:
        return self.jobs.get(export_id)

    def cancel(self, export_id: str) -> None:
        job = self.jobs.get(export_id)
        if job is None:
            return
        job.cancel.set()
        if job.status != "running":
            self.finish(export_id)

    def finish(self, export_id: str) -> None:
        """The file was sent (or is not wanted any more): delete it and forget the job."""
        with self._lock:
            job = self.jobs.pop(export_id, None)
        if job is not None and job.path is not None:
            job.path.unlink(missing_ok=True)

    def _sweep(self) -> None:
        now = time.time()
        for job in [j for j in list(self.jobs.values()) if now - j.created_at > self.ttl_s]:
            job.cancel.set()
            self.finish(job.id)

    def _step(self, job: ExportJob, stage: str, frac: float, message: str) -> None:
        if job.cancel.is_set():
            raise Cancelled
        load, write, _ = WEIGHTS[job.fmt]
        start = {"load": 0.0, "write": load, "check": load + write}[stage]
        share = WEIGHTS[job.fmt][("load", "write", "check").index(stage)]
        job.stage, job.message = stage, message
        job.progress = max(job.progress, min(start + share * frac, 0.999))

    def _run(self, job: ExportJob) -> None:
        label = LABELS[job.fmt]
        path = self.dir / f"{job.id}.{FORMATS[job.fmt][1]}"
        try:
            self._step(job, "load", 0.1, "Leggo il modello")
            mesh = self.store.load_processed(job.model_id)
            self._step(job, "write", 0.0, f"Converto in {label}")
            write_export(
                mesh, job.fmt, path,
                on_write=lambda f: self._step(job, "write", f, f"Converto in {label}"),
                on_check=lambda f: self._step(job, "check", f, "Controllo che il file sia integro"),
            )
            if job.cancel.is_set():
                raise Cancelled
            job.path, job.size = path, path.stat().st_size
            job.stage, job.status, job.progress = "ready", "ready", 1.0
            job.message = f"{label} pronto e verificato"
        except Cancelled:
            path.unlink(missing_ok=True)
            job.status, job.message = "cancelled", "Annullato"
            self.finish(job.id)
        except KeyError:
            job.status, job.error = "error", "Modello non trovato"
        except ExportError as exc:
            log.error("export %s %s failed its check: %s", job.model_id, job.fmt, exc)
            job.status, job.error = "error", str(exc)
        except Exception as exc:  # noqa: BLE001 - reported to the page, never a half file
            log.exception("export %s %s failed", job.model_id, job.fmt)
            path.unlink(missing_ok=True)
            job.status, job.error = "error", f"Esportazione non riuscita: {exc}"
        if job.status == "error":
            job.message = job.error or "Errore"
