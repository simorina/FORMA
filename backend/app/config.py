"""Runtime configuration, read from environment variables (see .env.example)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _env(name: str, default: str = "") -> str:
    value = os.environ.get(name)
    return value.strip() if value and value.strip() else default


def _load_dotenv() -> None:
    """Minimal .env loader (repo root or backend/), no extra dependency."""
    here = Path(__file__).resolve().parent
    for candidate in (here.parent / ".env", here.parent.parent / ".env"):
        if not candidate.is_file():
            continue
        for raw in candidate.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key, value = key.strip(), value.strip().strip('"').strip("'")
            os.environ.setdefault(key, value)


@dataclass(frozen=True)
class Settings:
    gen_provider: str = "hf_remote"
    hf_token: str = ""
    data_dir: Path = Path("data")
    cors_origins: list[str] = field(default_factory=list)

    # hf_remote: default image->3D model + Space ids (overridable per model).
    hf_shape_model: str = "trellis2"
    hf_space_flux: str = "black-forest-labs/FLUX.1-schnell"
    hf_flux_model: str = "black-forest-labs/FLUX.1-schnell"
    hf_space_trellis2: str = "microsoft/TRELLIS.2"
    hf_space_hunyuan21: str = "tencent/Hunyuan3D-2.1"
    hf_space_hunyuan2mv: str = "tencent/Hunyuan3D-2mv"
    hf_space_trellis: str = "trellis-community/TRELLIS"
    hf_space_step1x: str = "stepfun-ai/Step1X-3D"
    hf_timeout_s: float = 600.0

    # local: CUDA inference.
    local_shape_model: str = "trellis2"
    local_device: str = "cuda"

    max_workers: int = 2

    @classmethod
    def from_env(cls) -> Settings:
        _load_dotenv()
        origins = _env("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173")
        return cls(
            gen_provider=_env("GEN_PROVIDER", "hf_remote"),
            hf_token=_env("HF_TOKEN"),
            data_dir=Path(_env("DATA_DIR", str(Path(__file__).resolve().parent.parent / "data"))),
            cors_origins=[o.strip() for o in origins.split(",") if o.strip()],
            hf_shape_model=_env("HF_SHAPE_MODEL", "trellis2"),
            hf_space_flux=_env("HF_SPACE_FLUX", cls.hf_space_flux),
            hf_flux_model=_env("HF_FLUX_MODEL", cls.hf_flux_model),
            hf_space_trellis2=_env("HF_SPACE_TRELLIS2", cls.hf_space_trellis2),
            hf_space_hunyuan21=_env("HF_SPACE_HUNYUAN21", cls.hf_space_hunyuan21),
            hf_space_hunyuan2mv=_env("HF_SPACE_HUNYUAN2MV", cls.hf_space_hunyuan2mv),
            hf_space_trellis=_env("HF_SPACE_TRELLIS", cls.hf_space_trellis),
            hf_space_step1x=_env("HF_SPACE_STEP1X", cls.hf_space_step1x),
            hf_timeout_s=float(_env("HF_TIMEOUT_S", "600")),
            local_shape_model=_env("LOCAL_SHAPE_MODEL", "trellis2"),
            local_device=_env("LOCAL_DEVICE", "cuda"),
            max_workers=int(_env("MAX_WORKERS", "2")),
        )


_settings: Settings | None = None


def get_settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings.from_env()
    return _settings


def set_settings(settings: Settings) -> None:
    """Used by tests to inject a custom configuration."""
    global _settings
    _settings = settings
