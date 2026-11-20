"""FastAPI application."""

from __future__ import annotations

import io
import json
import logging
import os
import uuid
from pathlib import Path
from typing import Any

import trimesh
from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, UnidentifiedImageError
from starlette.background import BackgroundTask
from starlette.middleware.gzip import DEFAULT_EXCLUDED_CONTENT_TYPES, GZipMiddleware
from starlette.types import Scope

from . import __version__
from .blender import BlenderError, find_blender, open_in_blender
from .config import Settings, get_settings
from .downloads import ExportManager
from .exporters import FORMATS, ExportError, export_glb, write_export
from .pipeline import PrintSettings
from .pipeline.colors import carry
from .pipeline.process import to_z_up
from .providers import GenParams, ProviderError, all_providers, get_provider
from .providers.base import as_single_mesh
from .providers.idol_local import IdolRunner
from .providers.meshy import relief_options
from .service import JobManager, finalize, public_model
from .storage import DraftStore, ModelStore

log = logging.getLogger("forma")
# A model kept at full resolution (up to 10M triangles, see pipeline.process.MAX_FACES)
# comes back from the editor as a binary STL of up to ~477 MB.
MAX_UPLOAD = 512 * 1024 * 1024
MESH_TYPES = {"stl", "obj", "ply", "glb", "gltf", "off", "3mf"}

# Cache-Control for files whose name changes with their content (the frontend's build output).
IMMUTABLE = "public, max-age=31536000, immutable"
# For URLs whose content can change (index.html after a new build, a thumbnail after
# "Applica"): the browser asks every time, an unchanged file costs a 304 and no body.
REVALIDATE = "no-cache"
# Compressed: JSON, JS, CSS, HTML, SVG. Not meshes: GLB and STL shrink by about half but cost
# hundreds of ms of CPU per request (a loss on localhost), 3MF is a zip already.
GZIP_EXCLUDED = (*DEFAULT_EXCLUDED_CONTENT_TYPES, "model/*")


class FrontendFiles(StaticFiles):
    """The built frontend. Vite names every file under assets/ after its content, so those
    are kept for a year; the rest (index.html first) is revalidated, so a new build shows at once."""

    def file_response(
        self,
        full_path: str | os.PathLike[str],
        stat_result: os.stat_result,
        scope: Scope,
        status_code: int = 200,
    ) -> Response:
        response = super().file_response(full_path, stat_result, scope, status_code)
        hashed = Path(self.get_path(scope)).parts[:1] == ("assets",)
        response.headers["Cache-Control"] = IMMUTABLE if hashed else REVALIDATE
        return response


def _not_modified(request: Request, etag: str) -> Response | None:
    """A 304 when the browser already holds this version (its If-None-Match lists ``etag``)."""
    tags = request.headers.get("if-none-match")
    if tags and (tags.strip() == "*" or etag in (t.strip().removeprefix("W/") for t in tags.split(","))):
        return Response(status_code=304, headers={"ETag": etag, "Cache-Control": REVALIDATE})
    return None


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
        raise HTTPException(413, "File troppo grande (max 512 MB)")
    if not data:
        raise HTTPException(422, "File vuoto")
    return data


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    store = ModelStore(settings.data_dir)
    drafts = DraftStore(settings.data_dir)
    jobs = JobManager(store, settings.max_workers)
    exports = ExportManager(store, settings.data_dir)

    app = FastAPI(title="Forma API", version=__version__)
    app.state.store = store
    app.state.jobs = jobs
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins or ["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_middleware(
        GZipMiddleware, minimum_size=1024, compresslevel=6, exclude_content_types=GZIP_EXCLUDED
    )

    @app.exception_handler(ProviderError)
    async def provider_error(_, exc: ProviderError):  # pragma: no cover - jobs catch these
        return JSONResponse({"detail": str(exc)}, status_code=502)

    @app.get("/api/health")
    def health() -> dict[str, Any]:
        return {"ok": True, "version": __version__}

    def _image_routes() -> list[tuple[str, str]]:
        """The models an uploaded picture may go to (IMAGE_TO_3D), the default first;
        "provider:*" stands for every model of that provider, in its own order."""
        routes: list[tuple[str, str]] = []
        for part in settings.image_to_3d.split(","):
            name, _, model = (x.strip() for x in part.strip().partition(":"))
            if not name:
                continue
            if model == "*":
                try:
                    keys = [m.key for m in get_provider(name).models()]
                except ProviderError:
                    keys = []
            else:
                keys = [model]
            routes += [(name, k) for k in keys if (name, k) not in routes]
        return routes or [("local", "idol")]

    def _route_info(name: str, model: str) -> dict[str, Any]:
        info: dict[str, Any] = {"description": "", "license": "", "eu_restricted": False, "notes": []}
        try:
            prov = get_provider(name)
            ok, reason = prov.available()
            found = next((m for m in prov.models() if m.key == model), None)
            label = found.label if found else prov.label
            if found:
                info = {k: v for k, v in found.to_dict().items()
                        if k in ("description", "license", "eu_restricted", "notes")}
        except ProviderError as exc:
            ok, reason, label = False, str(exc), name
        if ok and model == "idol" and not IdolRunner.installed():
            ok, reason = False, "Idol non è installato: esegui `make install-idol`."
        return {"provider": name, "model": model, "label": label, "available": ok, "reason": reason,
                **info}

    def _image_provider(provider: str, model: str):
        """The model an uploaded picture goes to: the one asked for when IMAGE_TO_3D allows it,
        the default otherwise; a 409 saying why when it cannot run. Never another one."""
        routes = _image_routes()
        name, key = (provider, model) if (provider, model) in routes else routes[0]
        info = _route_info(name, key)
        if not info["available"]:
            where = "Idol, sulla GPU NVIDIA di questo computer," if key == "idol" else info["label"]
            raise HTTPException(409, f"{where} non è disponibile: {info['reason']}")
        return get_provider(name), key

    @app.get("/api/providers")
    def providers() -> dict[str, Any]:
        routes = [_route_info(*r) for r in _image_routes()]
        return {
            "default": settings.gen_provider,
            "hf_token": bool(settings.hf_token),
            "providers": [p.info() for p in all_providers()],
            # the models an uploaded picture may go to, the default first
            "image_routes": routes,
            "image_to_3d": routes[0],
            "formats": list(FORMATS),
            "defaults": PrintSettings().to_dict(),
            # "Apri in Blender": a Blender on this computer to open the model in, colours on
            "blender": find_blender(settings) is not None,
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
        image_kind: str = Form(""),
        refine: str = Form(""),
        relief: str = Form(""),
        image: UploadFile | None = File(None),
    ) -> dict[str, Any]:
        """``image_kind`` of an uploaded picture: "real" (a photo, the default) or "synthetic"
        (a render or a generated picture). Idol frames the object differently for each.
        ``refine`` = "hi3d": Idol's shape is then refined by Hi3D on its Hugging Face Space.
        ``relief`` (JSON): a bas-relief of the uploaded photo by Meshy, with these options (style,
        carving, depth, base, bend); its size is the print's longest side."""
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
        if relief and (pil is None or source != "upload"):
            raise HTTPException(422, "Carica la foto da cui fare il rilievo")
        if not prompt and pil is None:
            raise HTTPException(422, "Scrivi un prompt o carica un'immagine")
        if quality not in ("draft", "standard", "high"):
            quality = "standard"
        print_settings = _print_settings(settings_json)
        extra: dict[str, Any] = {}
        if relief:
            # A bas-relief: only Meshy makes it, only from a photo the user brings.
            if pil is None or source != "upload":
                raise HTTPException(422, "Carica la foto da cui fare il rilievo")
            try:
                extra["relief"] = relief_options(_parse_json(relief, "relief"),
                                                 print_settings.target_size_mm, quality)
            except ValueError as exc:
                raise HTTPException(422, str(exc)) from exc
            prov, model = _provider("meshy"), "relief"
            print_settings.orientation = "keep"  # it comes lying on its back, face up
        elif pil is not None and source == "upload":
            # A picture the user brings goes only to a model IMAGE_TO_3D allows (Idol on this
            # GPU or TRELLIS.2 on its Space), and to that one alone: no fallback.
            prov, model = _image_provider(provider, model)
        else:
            prov = _provider(provider)
        if pil is not None:  # an approved preview was made by FLUX: never a photo
            extra["image_kind"] = ("synthetic" if source == "draft"
                                   else image_kind if image_kind in ("real", "synthetic") else "real")
        if refine == "hi3d":
            extra["refine"] = "hi3d"
        if pil is not None and source == "upload":
            extra["no_fallback"] = True
        params = GenParams(model=model or None, seed=seed, quality=quality, extra=extra)
        job = jobs.submit(prompt or None, pil, prov.name, params, print_settings, source=source)
        return {"job_id": job.id, "job": job.to_dict()}

    @app.get("/api/jobs/{job_id}")
    async def job_status(job_id: str) -> dict[str, Any]:
        # Polled every 700 ms while a job runs; memory only, so it is answered on the event loop
        # instead of waiting twice for a worker thread (endpoint, then response validation).
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
                mesh = as_single_mesh(loaded)  # geometry + per-vertex colours, if any
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
                # The editor sends an STL: the colours come back from the model it edited
                # (same frame: millimetres, Z up), nearest vertex.
                try:
                    mesh = carry(store.load_processed(model_id), mesh)
                except KeyError:
                    pass
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

    def _export_format(raw: str) -> str:
        fmt = raw.lower()
        if fmt not in FORMATS:
            raise HTTPException(422, f"Formato non supportato: {raw}")
        return fmt

    def _export_name(model_id: str, fmt: str) -> str:
        """What the file is and how big: "pedone-degli-scacchi-100mm.3mf"."""
        try:
            meta = store.read_meta(model_id)
        except KeyError as exc:
            raise HTTPException(404, "Modello non trovato") from exc
        size = max((meta.get("report") or {}).get("bbox_mm") or [0])
        stem = _slug(meta.get("title") or meta.get("prompt") or "forma") + f"-{int(size)}mm"
        return f"{stem}.{FORMATS[fmt][1]}"

    @app.post("/api/models/{model_id}/export")
    def start_export(model_id: str, format: str = Query("3mf")) -> dict[str, Any]:
        """Write the model in a format as a job: poll /api/exports/{id}, then fetch its file."""
        fmt = _export_format(format)
        name = _export_name(model_id, fmt)
        return exports.start(model_id, fmt, name).to_dict()

    @app.get("/api/exports/{export_id}")
    async def export_status(export_id: str) -> dict[str, Any]:
        job = exports.get(export_id)
        if job is None:
            raise HTTPException(404, "Esportazione non trovata")
        return job.to_dict()

    @app.get("/api/exports/{export_id}/file")
    def export_file(export_id: str) -> FileResponse:
        """The checked file, with its length; deleted once sent."""
        job = exports.get(export_id)
        if job is None:
            raise HTTPException(404, "Esportazione non trovata")
        if job.status != "ready" or job.path is None or not job.path.is_file():
            raise HTTPException(409, job.error or "Il file non è ancora pronto")
        return FileResponse(job.path, media_type=FORMATS[job.fmt][0], filename=job.filename,
                            headers={"Cache-Control": "no-store"},
                            background=BackgroundTask(exports.finish, export_id))

    @app.delete("/api/exports/{export_id}")
    def cancel_export(export_id: str) -> dict[str, Any]:
        exports.cancel(export_id)
        return {"ok": True}

    @app.get("/api/export/{model_id}")
    def export(model_id: str, format: str = Query("stl")) -> FileResponse:
        """The same written and checked file in one request (no progress): direct links."""
        fmt = _export_format(format)
        name = _export_name(model_id, fmt)
        try:
            mesh = store.load_processed(model_id)
        except KeyError as exc:
            raise HTTPException(404, "Modello non trovato") from exc
        path = exports.dir / f"direct-{uuid.uuid4().hex[:12]}.{FORMATS[fmt][1]}"
        try:
            write_export(mesh, fmt, path)
        except ExportError as exc:
            raise HTTPException(500, str(exc)) from exc
        return FileResponse(path, media_type=FORMATS[fmt][0], filename=name,
                            headers={"Cache-Control": "no-store"},
                            background=BackgroundTask(path.unlink, missing_ok=True))

    @app.post("/api/models/{model_id}/blender")
    async def model_in_blender(model_id: str) -> dict[str, Any]:
        """Open the model in Blender on this computer: the GLB, colours showing, framed."""
        name = _export_name(model_id, "glb")
        try:
            mesh = await run_in_threadpool(store.load_processed, model_id)
        except KeyError as exc:
            raise HTTPException(404, "Modello non trovato") from exc
        try:
            path = await run_in_threadpool(open_in_blender, mesh, name, settings)
        except BlenderError as exc:
            raise HTTPException(409, str(exc)) from exc
        except ExportError as exc:
            raise HTTPException(500, str(exc)) from exc
        return {"ok": True, "file": path.name}

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
    def model_mesh(model_id: str, request: Request) -> Response:
        """Preview mesh for the viewer: millimetres, Z up (not glTF metres)."""
        try:
            st = store.file(model_id, "model.ply").stat()
        except (KeyError, OSError) as exc:
            raise HTTPException(404, "Modello non trovato") from exc
        # The version of model.ply: while it stands, a revalidation is a 304, no PLY load and
        # no GLB export (the ?v= in the URL only has second resolution, the file's mtime more).
        etag = f'"glb-{st.st_mtime_ns:x}-{st.st_size:x}"'
        if cached := _not_modified(request, etag):
            return cached
        try:
            mesh = store.load_processed(model_id)
        except KeyError as exc:
            raise HTTPException(404, "Modello non trovato") from exc
        return Response(export_glb(mesh, metres=False), media_type="model/gltf-binary",
                        headers={"Cache-Control": REVALIDATE, "ETag": etag})

    @app.get("/api/models/{model_id}/{name}.png")
    def model_png(model_id: str, name: str, request: Request) -> Response:
        if name not in ("image", "thumb"):
            raise HTTPException(404)
        try:
            path = store.file(model_id, f"{name}.png")
            st = path.stat()
        except (KeyError, OSError) as exc:
            raise HTTPException(404, "Immagine non trovata") from exc
        # "Applica" renders thumb.png again under the same path: revalidate, 304 while unchanged.
        response = FileResponse(path, media_type="image/png", stat_result=st,
                                headers={"Cache-Control": REVALIDATE})
        return _not_modified(request, response.headers["etag"]) or response

    # Unknown /api paths are a JSON 404, never the frontend's index.html (registered last,
    # before the static mount, so every real API route above still matches first).
    @app.api_route("/api/{rest:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    def api_not_found(rest: str) -> None:
        raise HTTPException(404, "Endpoint inesistente")

    # Serve the built frontend (docker / `make serve`) when present.
    dist = settings.frontend_dist or Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"
    if dist.is_dir():
        app.mount("/", FrontendFiles(directory=dist, html=True), name="frontend")

    return app


def _slug(text: str) -> str:
    import re
    import unicodedata

    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    text = re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()
    return text[:40] or "forma"


app = create_app()
