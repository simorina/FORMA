from __future__ import annotations

import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings, set_settings
from app.providers import reset_providers


@pytest.fixture()
def settings(tmp_path: Path) -> Settings:
    s = Settings(gen_provider="procedural", data_dir=tmp_path / "data", cors_origins=["*"])
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
