"""On-disk model store: one folder per model under DATA_DIR/models/<id>/."""

from __future__ import annotations

import json
import re
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Any

import trimesh
from PIL import Image

ID_RE = re.compile(r"^[a-f0-9]{12}$")


class ModelStore:
    def __init__(self, root: Path) -> None:
        self.root = Path(root) / "models"
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    @staticmethod
    def new_id() -> str:
        return uuid.uuid4().hex[:12]

    def path(self, model_id: str) -> Path:
        if not ID_RE.match(model_id or ""):
            raise KeyError(model_id)
        return self.root / model_id

    def exists(self, model_id: str) -> bool:
        try:
            return (self.path(model_id) / "meta.json").is_file()
        except KeyError:
            return False

    def create(self, model_id: str | None = None) -> str:
        model_id = model_id or self.new_id()
        self.path(model_id).mkdir(parents=True, exist_ok=True)
        return model_id

    # -- files ----------------------------------------------------------------
    def save_image(self, model_id: str, image: Image.Image, name: str = "image.png") -> None:
        image.convert("RGB").save(self.path(model_id) / name, optimize=True)

    def save_source(self, model_id: str, mesh: trimesh.Trimesh) -> None:
        mesh.export(self.path(model_id) / "source.ply")

    def save_processed(self, model_id: str, mesh: trimesh.Trimesh) -> None:
        mesh.export(self.path(model_id) / "model.ply")

    def _load(self, model_id: str, name: str) -> trimesh.Trimesh:
        path = self.path(model_id) / name
        if not path.is_file():
            raise KeyError(model_id)
        return trimesh.load(path, file_type="ply", process=False, force="mesh")

    def load_source(self, model_id: str) -> trimesh.Trimesh:
        return self._load(model_id, "source.ply")

    def load_processed(self, model_id: str) -> trimesh.Trimesh:
        return self._load(model_id, "model.ply")

    def file(self, model_id: str, name: str) -> Path:
        path = self.path(model_id) / name
        if not path.is_file():
            raise KeyError(name)
        return path

    # -- metadata -------------------------------------------------------------
    def write_meta(self, model_id: str, meta: dict[str, Any], touch: bool = True) -> dict[str, Any]:
        """``touch`` bumps updated_at (it versions the mesh URL): off for name-only edits."""
        meta = {**meta, "id": model_id}
        if touch or "updated_at" not in meta:
            meta["updated_at"] = time.time()
        meta.setdefault("created_at", meta["updated_at"])
        tmp = self.path(model_id) / "meta.json.tmp"
        tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(self.path(model_id) / "meta.json")
        return meta

    def read_meta(self, model_id: str) -> dict[str, Any]:
        path = self.path(model_id) / "meta.json"
        if not path.is_file():
            raise KeyError(model_id)
        return json.loads(path.read_text(encoding="utf-8"))

    def list(self, limit: int = 60) -> list[dict[str, Any]]:
        items = []
        for d in self.root.iterdir():
            meta = d / "meta.json"
            if d.is_dir() and meta.is_file():
                try:
                    items.append(json.loads(meta.read_text(encoding="utf-8")))
                except (OSError, json.JSONDecodeError):
                    continue
        items.sort(key=lambda m: m.get("created_at", 0), reverse=True)
        return items[:limit]

    def delete(self, model_id: str) -> None:
        with self._lock:
            shutil.rmtree(self.path(model_id), ignore_errors=True)


class DraftStore:
    """Preview images waiting for approval, under DATA_DIR/drafts/<id>.png (the newest kept)."""

    def __init__(self, root: Path, keep: int = 40) -> None:
        self.root = Path(root) / "drafts"
        self.root.mkdir(parents=True, exist_ok=True)
        self.keep = keep
        self._lock = threading.Lock()

    def path(self, draft_id: str) -> Path:
        if not ID_RE.match(draft_id or ""):
            raise KeyError(draft_id)
        return self.root / f"{draft_id}.png"

    def save(self, image: Image.Image) -> str:
        draft_id = uuid.uuid4().hex[:12]
        image.convert("RGB").save(self.path(draft_id), optimize=True)
        with self._lock:
            files = sorted(self.root.glob("*.png"), key=lambda p: p.stat().st_mtime, reverse=True)
            for old in files[self.keep:]:
                old.unlink(missing_ok=True)
        return draft_id

    def load(self, draft_id: str) -> Image.Image:
        path = self.path(draft_id)
        if not path.is_file():
            raise KeyError(draft_id)
        img = Image.open(path)
        img.load()
        return img
