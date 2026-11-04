"""HTTP caching and compression, and the history list that every page load asks for."""

import json
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.storage import ModelStore

from .conftest import wait_job

GZIP = {"Accept-Encoding": "gzip"}
IDENTITY = {"Accept-Encoding": "identity"}


@pytest.fixture()
def site(settings: Settings, tmp_path: Path) -> TestClient:
    """The API serving a small built frontend of its own (not the repository's)."""
    from app.main import create_app

    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text(
        '<!doctype html><script type="module" src="/assets/index-AbCd1234.js"></script>'
        + "<!-- Forma -->" * 100
    )
    (dist / "assets" / "index-AbCd1234.js").write_text("export const forma = 'atelier';\n" * 200)
    (dist / "favicon.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg"/>')
    s = Settings(**{**settings.__dict__, "frontend_dist": dist})
    with TestClient(create_app(s)) as c:
        yield c


def test_hashed_assets_are_kept_a_year_and_index_is_revalidated(site):
    asset = site.get("/assets/index-AbCd1234.js", headers=GZIP)
    assert asset.status_code == 200
    assert asset.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert asset.headers["content-encoding"] == "gzip"
    assert asset.text.startswith("export const forma")
    for path in ("/", "/index.html", "/favicon.svg"):
        r = site.get(path)
        assert r.status_code == 200, path
        assert r.headers["cache-control"] == "no-cache", path
    # an unchanged file is a 304 that keeps its caching rule
    for path, rule in (("/assets/index-AbCd1234.js", "immutable"), ("/", "no-cache")):
        etag = site.get(path).headers["etag"]
        again = site.get(path, headers={"If-None-Match": etag})
        assert again.status_code == 304 and again.content == b""
        assert rule in again.headers["cache-control"]
    # the API is still the API, never the frontend
    assert site.get("/api/nope").headers["content-type"].startswith("application/json")


def test_json_is_compressed_meshes_and_images_are_not(client):
    job = wait_job(client, client.post("/api/generate", data={"prompt": "cubo"}).json()["job_id"])
    model = job["result"]
    listing = client.get("/api/models", headers=GZIP)
    assert listing.headers["content-encoding"] == "gzip"
    assert listing.json()["models"][0]["id"] == model["id"]
    assert "content-encoding" not in client.get("/api/models", headers=IDENTITY).headers
    assert "content-encoding" not in client.get("/api/health", headers=GZIP).headers  # tiny
    for url in (model["urls"]["mesh"], model["urls"]["thumb"], model["urls"]["image"],
                *model["urls"]["export"].values()):
        r = client.get(url, headers=GZIP)
        assert r.status_code == 200, url
        assert "content-encoding" not in r.headers, url


def test_model_files_revalidate_and_change_with_applica(client):
    job = wait_job(client, client.post("/api/generate", data={"prompt": "cubo"}).json()["job_id"])
    model = job["result"]
    version = int(model["updated_at"])
    assert model["urls"]["thumb"].endswith(f"/thumb.png?v={version}")
    assert model["urls"]["mesh"].endswith(f"/mesh.glb?v={version}")

    first = {}
    for kind in ("mesh", "thumb", "image"):
        r = client.get(model["urls"][kind])
        assert r.headers["cache-control"] == "no-cache", kind
        etag = r.headers["etag"]
        again = client.get(model["urls"][kind], headers={"If-None-Match": etag})
        assert again.status_code == 304 and again.content == b"", kind
        assert again.headers["etag"] == etag
        first[kind] = (etag, r.content)

    # renaming changes neither the mesh nor its picture: same URLs, still a 304
    renamed = client.patch(f"/api/models/{model['id']}", data={"title": "Dado"}).json()
    assert renamed["urls"]["mesh"] == model["urls"]["mesh"]
    assert renamed["urls"]["thumb"] == model["urls"]["thumb"]
    etag = first["mesh"][0]
    assert client.get(renamed["urls"]["mesh"], headers={"If-None-Match": etag}).status_code == 304

    time.sleep(0.01)  # file times must move on, as they do between two clicks
    applied = client.post("/api/process", data={
        "model_id": model["id"], "settings": '{"target_size_mm": 42, "base_plate": true}'}).json()
    assert applied["urls"]["thumb"].endswith(f"?v={int(applied['updated_at'])}")
    for kind in ("mesh", "thumb"):
        etag, before = first[kind]
        r = client.get(applied["urls"][kind], headers={"If-None-Match": etag})
        assert r.status_code == 200, kind  # rewritten by Applica: the old copy is not reused
        assert r.headers["etag"] != etag and r.content != before, kind
    image = client.get(applied["urls"]["image"], headers={"If-None-Match": first["image"][0]})
    assert image.status_code == 304  # the generation's picture did not change

    assert client.get("/api/models/abcdefabcdef/mesh.glb").status_code == 404
    assert client.get("/api/models/abcdefabcdef/thumb.png").status_code == 404


def test_history_list_reads_again_only_what_changed(tmp_path):
    store = ModelStore(tmp_path)
    ids = []
    for i in range(5):
        mid = store.create()
        store.write_meta(mid, {"prompt": f"modello {i}", "created_at": 1000.0 + i})
        ids.append(mid)
    assert [m["prompt"] for m in store.list(3)] == ["modello 4", "modello 3", "modello 2"]

    first = store.list()
    first[0]["prompt"] = "changed by a caller"  # results are fresh dicts, not the cache
    first[0].setdefault("report", {})["x"] = 1
    assert store.list()[0]["prompt"] == "modello 4" and "report" not in store.list()[0]

    # app writes (atomic replace), a hand edit in place, a deletion: all seen at once
    store.write_meta(ids[1], {**store.read_meta(ids[1]), "title": "Rinominato"}, touch=False)
    path = store.path(ids[2]) / "meta.json"
    meta = json.loads(path.read_text())
    meta["prompt"] = "a mano, più lungo"
    path.write_text(json.dumps(meta))
    store.delete(ids[4])
    by_id = {m["id"]: m for m in store.list()}
    assert set(by_id) == set(ids[:4])
    assert by_id[ids[1]]["title"] == "Rinominato"
    assert by_id[ids[2]]["prompt"] == "a mano, più lungo"

    (store.path(ids[0]) / "meta.json").write_text("{broken")
    assert {m["id"] for m in store.list()} == {ids[1], ids[2], ids[3]}
