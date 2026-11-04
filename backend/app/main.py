"""FastAPI application."""

from __future__ import annotations

import io
import json
import logging
from pathlib import Path
from typing import Any

import trimesh
from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, UnidentifiedImageError

from . import __version__
from .config import Settings, get_settings
from .exporters import FORMATS, export_glb, export_mesh
from .pipeline import PrintSettings
from .pipeline.process import to_z_up
from .providers import GenParams, ProviderError, all_providers, get_provider
from .providers.base import as_single_mesh
from .service import JobManager, finalize, public_model
from .storage import DraftStore, ModelStore

log = logging.getLogger("forma")
MAX_UPLOAD = 40 * 1024 * 1024
MESH_TYPES = {"stl", "obj", "ply", "glb", "gltf", "off", "3mf"}


def _parse_json(raw: str | None, what: str) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(422, f"{what}: JSON non valido") from exc
    if not isinstance(data, dict):
        raise HTTPException(422, f"{what}: atteso un oggetto JSON")
    return data


def _print_settings(raw: str | None) -> PrintSettings:
    try:
        return PrintSettings.from_dict(_parse_json(raw, "settings"))
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


async def _read_upload(upload: UploadFile) -> bytes:
    data = await upload.read(MAX_UPLOAD + 1)
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, "File troppo grande (max 40 MB)")
    if not data:
        raise HTTPException(422, "File vuoto")
    return data


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    store = ModelStore(settings.data_dir)
    drafts = DraftStore(settings.data_dir)
    jobs = JobManager(store, settings.max_workers)

    app = FastAPI(title="Forma API", version=__version__)
    app.state.store = store
    app.state.jobs = jobs
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins or ["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.exception_handler(ProviderError)
    async def provider_error(_, exc: ProviderError):  # pragma: no cover - jobs catch these
        return JSONResponse({"detail": str(exc)}, status_code=502)

    @app.get("/api/health")
    def health() -> dict[str, Any]:
        return {"ok": True, "version": __version__}

    @app.get("/api/providers")
    def providers() -> dict[str, Any]:
        return {
            "default": settings.gen_provider,
            "hf_token": bool(settings.hf_token),
            "providers": [p.info() for p in all_providers()],
            "formats": list(FORMATS),
            "defaults": PrintSettings().to_dict(),
        }

    def _provider(name: str):
        try:
            prov = get_provider(name or settings.gen_provider)
        except ProviderError as exc:
            raise HTTPException(422, str(exc)) from exc
        ok, reason = prov.available()
        if not ok:
            raise HTTPException(409, reason)
        return prov

    @app.post("/api/image")
    async def preview_image(
        prompt: str = Form(""), provider: str = Form(""), seed: int = Form(0)
    ) -> dict[str, Any]:
        """Text -> image only: a draft the user approves before spending GPU on the 3D step."""
        prompt = prompt.strip()[:600]
        if not prompt:
            raise HTTPException(422, "Scrivi un prompt per l'immagine")
        prov = _provider(provider)
        try:
            img = await run_in_threadpool(prov.image, prompt, seed)
        except ProviderError as exc:
            raise HTTPException(502, str(exc)) from exc
        draft_id = drafts.save(img)
        english = await run_in_threadpool(prov.english, prompt)  # cached by the provider
        return {"draft_id": draft_id, "url": f"/api/drafts/{draft_id}.png", "prompt": prompt,
                "prompt_en": english if english != prompt else None,
                "seed": seed, "provider": prov.name}

    @app.get("/api/drafts/{draft_id}.png")
    def draft_png(draft_id: str) -> FileResponse:
        try:
            path = drafts.path(draft_id)
        except KeyError as exc:
            raise HTTPException(404, "Bozza non trovata") from exc
        if not path.is_file():
            raise HTTPException(404, "Bozza non trovata")
        return FileResponse(path, media_type="image/png")

    @app.post("/api/generate")
    async def generate(
        prompt: str = Form(""),
        provider: str = Form(""),
        model: str = Form(""),
        seed: int = Form(0),
        quality: str = Form("standard"),
        settings_json: str = Form("", alias="settings"),
        draft: str = Form(""),
        image: UploadFile | None = File(None),
    ) -> dict[str, Any]:
        prompt = prompt.strip()[:600]
        pil: Image.Image | None = None
        source = "upload"
        if draft:
            try:
                pil = drafts.load(draft)
            except (KeyError, OSError) as exc:
                raise HTTPException(404, "Bozza non trovata: rigenera l'immagine") from exc
            source = "draft"
        elif image is not None and image.filename:
            raw = await _read_upload(image)
            try:
                pil = Image.open(io.BytesIO(raw))
                pil.load()
            except Image.DecompressionBombError as exc:
                raise HTTPException(422, "Immagine troppo grande in pixel") from exc
            # PIL raises SyntaxError / ValueError (not OSError) for some corrupt files
            except (UnidentifiedImageError, OSError, SyntaxError, ValueError) as exc:
                raise HTTPException(422, "Immagine non riconosciuta (usa PNG, JPG o WEBP)") from exc
            if max(pil.size) > 2048:
                pil.thumbnail((2048, 2048))
        if not prompt and pil is None:
            raise HTTPException(422, "Scrivi un prompt o carica un'immagine")
        prov = _provider(provider)
        if quality not in ("draft", "standard", "high"):
            quality = "standard"
        print_settings = _print_settings(settings_json)
        params = GenParams(model=model or None, seed=seed, quality=quality)
        job = jobs.submit(prompt or None, pil, prov.name, params, print_settings, source=source)
        return {"job_id": job.id, "job": job.to_dict()}

    @app.get("/api/jobs/{job_id}")
    def job_status(job_id: str) -> dict[str, Any]:
        job = jobs.get(job_id)
        if job is None:
            raise HTTPException(404, "Job non trovato")
        return job.to_dict()

    @app.post("/api/process")
    async def process(
        model_id: str = Form(""),
        settings_json: str = Form("", alias="settings"),
        prompt: str = Form(""),
        file: UploadFile | None = File(None),
    ) -> dict[str, Any]:
        """Re-run the print pipeline on a stored model, or on an uploaded/edited mesh.

        - only ``model_id``: re-process its original source with new settings (in place);
        - ``file`` (+ optional ``model_id`` as parent): store as a new model, then process.
        """
        print_settings = _print_settings(settings_json)
        if file is not None and file.filename:
            raw = await _read_upload(file)
            ext = Path(file.filename).suffix.lower().lstrip(".")
            if ext not in MESH_TYPES:
                raise HTTPException(422, f"Formato mesh non supportato: .{ext}")
            try:
                loaded = trimesh.load(io.BytesIO(raw), file_type=ext, process=False)
                mesh = as_single_mesh(loaded)
                mesh = trimesh.Trimesh(mesh.vertices, mesh.faces, process=False)
            except Exception as exc:
                raise HTTPException(422, f"Impossibile leggere la mesh: {exc}") from exc
            if len(mesh.faces) == 0:
                raise HTTPException(422, "La mesh è vuota")
            parent = None
            meta: dict[str, Any] = {"kind": "upload", "prompt": prompt or Path(file.filename).stem,
                                    "provider": "upload", "model": ext}
            if model_id and store.exists(model_id):
                parent = store.read_meta(model_id)
                meta = {"kind": "edit", "prompt": prompt or parent.get("prompt", ""),
                        "provider": parent.get("provider"), "model": parent.get("model"),
                        "parent_id": model_id}
            # glTF/GLB uploads are Y-up; everything else (STL/OBJ/3MF/PLY) Z-up.
            # Edits come from our own viewer already Z-up in mm.
            up = "y" if ext in ("glb", "gltf") and meta["kind"] == "upload" else "z"
            source = to_z_up(mesh, up)
            new_id = store.create()
            if parent and parent.get("has_image"):
                try:
                    Image.open(store.file(model_id, "image.png")).save(
                        store.path(new_id) / "image.png")
                    meta["has_image"] = True
                except (KeyError, OSError):
                    pass
            try:
                result = await run_in_threadpool(
                    finalize, store, new_id, source, print_settings, meta)
            except ValueError as exc:
                store.delete(new_id)
                raise HTTPException(422, str(exc)) from exc
            return public_model(result)
        if not model_id or not store.exists(model_id):
            raise HTTPException(404, "Modello non trovato")
        meta = store.read_meta(model_id)
        source = store.load_source(model_id)
        result = await run_in_threadpool(finalize, store, model_id, source, print_settings, meta)
        return public_model(result)

    @app.get("/api/export/{model_id}")
    def export(model_id: str, format: str = Query("stl")) -> Response:
        fmt = format.lower()
        if fmt not in FORMATS:
            raise HTTPException(422, f"Formato non supportato: {format}")
        try:
            mesh = store.load_processed(model_id)
            meta = store.read_meta(model_id)
        except KeyError as exc:
            raise HTTPException(404, "Modello non trovato") from exc
        data, mime, ext = export_mesh(mesh, fmt)
        stem = _slug(meta.get("title") or meta.get("prompt") or "forma") + f"-{int(mesh.extents.max())}mm"
        return Response(
            data,
            media_type=mime,
            headers={"Content-Disposition": f'attachment; filename="{stem}.{ext}"'},
        )

    @app.get("/api/models")
    def list_models(limit: int = 60) -> dict[str, Any]:
        return {"models": [public_model(m) for m in store.list(limit)]}

    @app.get("/api/models/{model_id}")
    def get_model(model_id: str) -> dict[str, Any]:
        try:
            return public_model(store.read_meta(model_id))
        except KeyError as exc:
            raise HTTPException(404, "Modello non trovato") from exc

    @app.patch("/api/models/{model_id}")
    async def rename_model(model_id: str, title: str = Form("")) -> dict[str, Any]:
        """Give a model a name of your own (empty: back to its prompt). Also names the files."""
        if not store.exists(model_id):
            raise HTTPException(404, "Modello non trovato")
        meta = store.read_meta(model_id)
        clean = " ".join(title.split())[:120]
        if clean:
            meta["title"] = clean
        else:
            meta.pop("title", None)
        # touch=False keeps updated_at: the mesh did not change, its cached GLB stays valid
        return public_model(store.write_meta(model_id, meta, touch=False))

    @app.delete("/api/models/{model_id}")
    def delete_model(model_id: str) -> dict[str, Any]:
        if not store.exists(model_id):
            raise HTTPException(404, "Modello non trovato")
        store.delete(model_id)
        return {"ok": True}

    @app.get("/api/models/{model_id}/mesh.glb")
    def model_mesh(model_id: str) -> Response:
        """Preview mesh for the viewer: millimetres, Z up (not glTF metres)."""
        try:
            mesh = store.load_processed(model_id)
        except KeyError as exc:
            raise HTTPException(404, "Modello non trovato") from exc
        return Response(export_glb(mesh, metres=False), media_type="model/gltf-binary",
                        headers={"Cache-Control": "no-cache"})

    @app.get("/api/models/{model_id}/{name}.png")
    def model_png(model_id: str, name: str) -> FileResponse:
        if name not in ("image", "thumb"):
            raise HTTPException(404)
        try:
            return FileResponse(store.file(model_id, f"{name}.png"), media_type="image/png")
        except KeyError as exc:
            raise HTTPException(404, "Immagine non trovata") from exc

    # Unknown /api paths are a JSON 404, never the frontend's index.html (registered last,
    # before the static mount, so every real API route above still matches first).
    @app.api_route("/api/{rest:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    def api_not_found(rest: str) -> None:
        raise HTTPException(404, "Endpoint inesistente")

    # Serve the built frontend (docker / `make serve`) when present.
    dist = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"
    if dist.is_dir():
        app.mount("/", StaticFiles(directory=dist, html=True), name="frontend")

    return app


def _slug(text: str) -> str:
    import re
    import unicodedata

    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    text = re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()
    return text[:40] or "forma"


app = create_app()
