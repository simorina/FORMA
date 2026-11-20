from __future__ import annotations

import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings, set_settings
from app.providers import reset_providers


@pytest.fixture(autouse=True)
def few_triangles(monkeypatch: pytest.MonkeyPatch) -> None:
    """Every print has at least 5M triangles (pipeline.process.MIN_FACES): the tests prepare
    small meshes without topping them up, except those that delete this to check the minimum."""
    monkeypatch.setenv("FORMA_MIN_FACES", "0")


@pytest.fixture()
def settings(tmp_path: Path) -> Settings:
    # pictures go to the offline shapes here (the app sends them only to Idol: test_idol.py)
    s = Settings(gen_provider="procedural", data_dir=tmp_path / "data", cors_origins=["*"],
                 image_to_3d="procedural:")
    set_settings(s)
    reset_providers()
    yield s
    reset_providers()


@pytest.fixture()
def client(settings: Settings) -> TestClient:
    from app.main import create_app

    with TestClient(create_app(settings)) as c:
        yield c


def wait_job(client: TestClient, job_id: str, timeout: float = 60.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = client.get(f"/api/jobs/{job_id}").json()
        if job["status"] in ("done", "error"):
            return job
        time.sleep(0.1)
    raise AssertionError("job timed out")
