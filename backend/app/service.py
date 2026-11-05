"""Orchestration shared by the API: generation jobs and (re)processing."""

from __future__ import annotations

import logging
import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any

import trimesh
from PIL import Image

from .pipeline import PrintSettings, process_mesh
from .pipeline.colors import vertex_colors
from .pipeline.process import to_z_up
from .providers import GenParams, ProviderError, get_provider
from .render import render_preview
from .storage import ModelStore

log = logging.getLogger(__name__)

STAGES = [
    ("image", "Immagine"),
    ("shape", "Forma 3D"),
    ("repair", "Riparazione"),
    ("ready", "Pronto"),
]
STAGE_WEIGHTS = {"image": 0.25, "shape": 0.5, "repair": 0.2, "ready": 0.05}


def _settings_now(raw: Any) -> Any:
    """Stored settings with today's defaults for the fields added since (e.g. flat_bottom_mm)."""
    if not isinstance(raw, dict):
        return raw
    try:
        return PrintSettings.from_dict(raw).to_dict()
    except ValueError:
        return raw


def public_model(meta: dict[str, Any]) -> dict[str, Any]:
    mid = meta["id"]
    base = f"/api/models/{mid}"
    out = {k: v for k, v in meta.items() if not k.startswith("_")}
    if "settings" in out:
        out["settings"] = _settings_now(out["settings"])
    # Every finalize (a new model, "Applica") rewrites the mesh and the thumbnail and bumps
    # updated_at: the version in their URLs makes a page that already shows them fetch again.
    version = int(meta.get("updated_at", 0))
    return {
        **out,
        "urls": {
            "mesh": f"{base}/mesh.glb?v={version}",
            "image": f"{base}/image.png" if meta.get("has_image") else None,
            "thumb": f"{base}/thumb.png?v={version}",
            "export": {f: f"/api/export/{mid}?format={f}" for f in ("stl", "3mf", "obj", "glb")},
        },
    }


def finalize(
    store: ModelStore,
    model_id: str,
    source_z_up: trimesh.Trimesh,
    settings: PrintSettings,
    meta: dict[str, Any],
    on_step: Any = None,
) -> dict[str, Any]:
    store.save_source(model_id, source_z_up)
    result = process_mesh(source_z_up, settings, on_step)
    store.save_processed(model_id, result.mesh)
    try:
        store.save_image(model_id, render_preview(result.mesh, size=384), "thumb.png")
    except Exception:  # thumbnails are nice-to-have
        log.exception("thumbnail failed")
    meta = {**meta, "report": result.report, "settings": settings.to_dict(),
            "has_colors": vertex_colors(result.mesh) is not None}
    return store.write_meta(model_id, meta)


@dataclass
class Job:
    id: str
    prompt: str | None
    provider: str
    model: str | None
    created_at: float = field(default_factory=time.time)
    status: str = "queued"  # queued | running | done | error
    stage: str = "image"
    message: str = "In coda"
    error: str | None = None
    model_id: str | None = None
    image_url: str | None = None
    result: dict[str, Any] | None = None
    stages: list[dict[str, Any]] = field(default_factory=list)
    source: str = "upload"  # where an input image came from: "upload" or "draft"

    def __post_init__(self) -> None:
        if not self.stages:
            self.stages = [
                {"key": k, "label": label, "status": "pending", "progress": 0.0, "message": ""}
                for k, label in STAGES
            ]

    def set_stage(self, key: str, progress: float, message: str = "") -> None:
        reached = False
        for st in self.stages:
            if st["key"] == key:
                reached = True
                st["status"] = "done" if progress >= 1.0 else "active"
                st["progress"] = round(max(st["progress"], min(progress, 1.0)), 3)
                if message:
                    st["message"] = message
            elif not reached and st["status"] in ("pending", "active"):
                st["status"] = "done" if st["status"] == "active" else "skipped"
                if st["status"] == "done":
                    st["progress"] = 1.0
        self.stage = key
        if message:
            self.message = message

    @property
    def progress(self) -> float:
        total = 0.0
        for st in self.stages:
            w = STAGE_WEIGHTS[st["key"]]
            total += w * (1.0 if st["status"] in ("done", "skipped") else st["progress"])
        return round(min(total, 1.0), 3)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "status": self.status,
            "stage": self.stage,
            "message": self.message,
            "progress": self.progress,
            "stages": self.stages,
            "error": self.error,
            "model_id": self.model_id,
            "image_url": self.image_url,
            "prompt": self.prompt,
            "provider": self.provider,
            "model": self.model,
            "created_at": self.created_at,
            "result": self.result,
        }


class JobManager:
    def __init__(self, store: ModelStore, max_workers: int = 2) -> None:
        self.store = store
        self.jobs: dict[str, Job] = {}
        self._lock = threading.Lock()
        self._pool = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="forma-job")

    def get(self, job_id: str) -> Job | None:
        return self.jobs.get(job_id)

    def submit(
        self,
        prompt: str | None,
        image: Image.Image | None,
        provider_name: str,
        params: GenParams,
        settings: PrintSettings,
        source: str = "upload",
    ) -> Job:
        """``source``: "upload" (the user's photo) or "draft" (a preview image they approved)."""
        job = Job(id=uuid.uuid4().hex[:12], prompt=prompt, provider=provider_name, model=params.model)
        job.source = source
        with self._lock:
            self.jobs[job.id] = job
            # keep memory bounded: forget the oldest *finished* jobs only
            if len(self.jobs) > 200:
                finished = [j for j in self.jobs.values() if j.status in ("done", "error")]
                for old in sorted(finished, key=lambda j: j.created_at)[:50]:
                    self.jobs.pop(old.id, None)
        self._pool.submit(self._run, job, image, params, settings)
        return job

    def _run(self, job: Job, image: Image.Image | None, params: GenParams, settings: PrintSettings) -> None:
        job.status = "running"
        model_id = self.store.create()
        job.model_id = model_id
        uploaded = image is not None
        try:
            provider = get_provider(job.provider)
            if uploaded:
                self.store.save_image(model_id, image)
                job.image_url = f"/api/models/{model_id}/image.png"
                job.set_stage("image", 1.0, "Immagine approvata" if job.source == "draft" else "Immagine caricata")

            def progress(stage: str, frac: float, message: str) -> None:
                if uploaded and stage == "image":
                    return
                job.set_stage(stage, frac, message)

            job.set_stage("image" if not uploaded else "shape", 0.02, "Avvio")
            result = provider.generate(job.prompt, image, params, progress)
            if result.image is not None and not uploaded:
                self.store.save_image(model_id, result.image)
                job.image_url = f"/api/models/{model_id}/image.png"
            job.set_stage("shape", 1.0, "Forma 3D pronta")

            source = to_z_up(result.mesh, result.meta.get("up", "y"))

            def on_step(msg: str, frac: float) -> None:
                job.set_stage("repair", min(frac, 0.99), msg)

            job.set_stage("repair", 0.01, "Riparazione")
            meta = finalize(
                self.store,
                model_id,
                source,
                settings,
                {
                    "prompt": job.prompt or "",
                    "provider": provider.name,
                    "model": result.model or params.model,
                    # an approved preview still comes from a prompt: it is a text model
                    "kind": "image" if uploaded and job.source != "draft" else "text",
                    "has_image": (self.store.path(model_id) / "image.png").is_file(),
                    "seed": params.seed,
                    "quality": params.quality,
                    "gen_meta": {k: v for k, v in result.meta.items() if isinstance(v, (str, int, float))},
                },
                on_step,
            )
            job.set_stage("repair", 1.0, "Mesh stampabile")
            job.set_stage("ready", 1.0, "Pronto da stampare")
            job.result = public_model(meta)
            job.status = "done"
        except ProviderError as exc:
            self._fail(job, str(exc))
        except Exception as exc:  # pragma: no cover - defensive
            log.error("job %s failed: %s\n%s", job.id, exc, traceback.format_exc())
            self._fail(job, f"Errore inatteso: {exc}")

    def _fail(self, job: Job, message: str) -> None:
        job.status = "error"
        job.error = message
        job.message = message
        for st in job.stages:
            if st["status"] == "active":
                st["status"] = "error"
                break
        if job.model_id and not self.store.exists(job.model_id):
            self.store.delete(job.model_id)
