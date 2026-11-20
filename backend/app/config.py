"""Runtime configuration, read from environment variables (see .env.example)."""

from __future__ import annotations

import logging
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

log = logging.getLogger("forma")

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = BACKEND_DIR.parent


def _env(name: str, default: str = "") -> str:
    value = os.environ.get(name)
    return value.strip() if value and value.strip() else default


def _optional(value: str) -> str:
    """'none' / 'off' / '0' disable an optional setting."""
    return "" if value.lower() in ("none", "off", "0", "false") else value


def _data_dir(raw: str) -> Path:
    """DATA_DIR may be relative: resolve it against the repository root, not the CWD,
    so `make dev`, `cd backend && uv run ...` and Docker all agree on the location."""
    path = Path(raw).expanduser()
    return path if path.is_absolute() else (REPO_ROOT / path).resolve()


def _system_env(key: str) -> str | None:
    """The value Windows keeps for ``key`` in its settings (the user's, then the system's):
    what every program inherits, not something set for this run."""
    if sys.platform != "win32":
        return None
    import winreg

    places = ((winreg.HKEY_CURRENT_USER, r"Environment"),
              (winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"))
    for hive, path in places:
        try:
            with winreg.OpenKey(hive, path) as k:
                return str(winreg.QueryValueEx(k, key)[0])
        except OSError:
            continue
    return None


def _load_dotenv() -> None:
    """Minimal .env loader (repo root or backend/), no extra dependency.

    A variable set for this run (the shell, the Makefile, the tests) wins over the .env. One
    that Windows keeps in its settings does not, whatever value this process inherited: an old
    HF_TOKEN left there kept the backend on an expired token whatever the .env said, and a
    program started before the setting changed (VS Code, its terminals) still hands down the old
    copy. The value is never logged."""
    for candidate in (BACKEND_DIR / ".env", REPO_ROOT / ".env"):
        if not candidate.is_file():
            continue
        for raw in candidate.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key, value = key.strip(), value.strip().strip('"').strip("'")
            current = os.environ.get(key)
            if current is None:
                os.environ[key] = value
            elif current != value and value and _system_env(key) is not None:
                log.warning("%s: uso il valore del file .env, non quello delle variabili di Windows "
                            "(lì è diverso: aggiornalo o eliminalo)", key)
                os.environ[key] = value


@dataclass(frozen=True)
class Settings:
    gen_provider: str = "hf_remote"
    hf_token: str = ""
    data_dir: Path = Path("data")
    cors_origins: list[str] = field(default_factory=list)

    # hf_remote: default image->3D model + Space ids (overridable per model).
    hf_shape_model: str = "pixal3d"
    # Used automatically when the chosen model's Space fails (quota, paused, API change).
    hf_fallback_model: str = "trellis2"
    hf_space_flux: str = "black-forest-labs/FLUX.1-schnell"
    hf_flux_model: str = "black-forest-labs/FLUX.1-schnell"
    # FLUX's T5 text encoder is English-only: Italian prompts are translated first ("" = off).
    hf_translate_model: str = "Helsinki-NLP/opus-mt-it-en"
    hf_space_pixal3d: str = "TencentARC/Pixal3D"
    hf_space_trellis2: str = "microsoft/TRELLIS.2"
    hf_space_hunyuan21: str = "tencent/Hunyuan3D-2.1"
    hf_space_hunyuan2mv: str = "tencent/Hunyuan3D-2mv"
    hf_space_trellis: str = "trellis-community/TRELLIS"
    hf_space_step1x: str = "stepfun-ai/Step1X-3D"
    # Hi3D v1.0: refines Idol's shape on Hugging Face (providers/endpoints/hi3d.py).
    hf_space_hi3d: str = "hugging-apps/hi3dv1"

    # meshy: Meshy's API with your key (providers/meshy.py); off without a key.
    meshy_api_key: str = ""
    meshy_timeout_s: float = 1800.0
    # "Apri in Blender": the Blender to start (empty: looked for, see blender.py).
    blender_path: str = ""
    hf_timeout_s: float = 600.0

    # local: CUDA inference. Idol fits an 8 GB GPU; Pixal3D and TRELLIS.2 want 24 GB.
    local_shape_model: str = "idol"
    local_device: str = "cuda"
    # Text -> image for the local provider: "auto" (on this GPU from 20 GB of VRAM, otherwise
    # FLUX on Hugging Face), "local" or "remote".
    local_text_to_image: str = "auto"
    # Idol's FLUX.2 VAE: the one of FLUX.2-dev, without its gate (see providers/idol_local.py).
    idol_vae: str = "black-forest-labs/FLUX.2-klein-4B"
    # The models an uploaded picture may go to ("provider:model", comma-separated; "provider:*"
    # is every model of it; the first is the default): Idol on this machine's GPU, then every
    # image->3D Space (Pixal3D, TRELLIS.2, Hunyuan3D, Step1X-3D, TRELLIS), then Meshy. The panel picks one;
    # anything else goes to the first. Never a fallback to another model. The offline mode and
    # the tests set "procedural:".
    image_to_3d: str = "local:idol,hf_remote:*,meshy:*"

    max_workers: int = 2

    # The built frontend the backend serves; None: <repo>/frontend/dist (as in Docker).
    frontend_dist: Path | None = None

    @classmethod
    def from_env(cls) -> Settings:
        _load_dotenv()
        origins = _env("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173")
        return cls(
            gen_provider=_env("GEN_PROVIDER", "hf_remote"),
            hf_token=_env("HF_TOKEN"),
            data_dir=_data_dir(_env("DATA_DIR", str(BACKEND_DIR / "data"))),
            cors_origins=[o.strip() for o in origins.split(",") if o.strip()],
            hf_shape_model=_env("HF_SHAPE_MODEL", cls.hf_shape_model),
            hf_fallback_model=_optional(_env("HF_FALLBACK_MODEL", cls.hf_fallback_model)),
            hf_space_flux=_env("HF_SPACE_FLUX", cls.hf_space_flux),
            hf_flux_model=_env("HF_FLUX_MODEL", cls.hf_flux_model),
            hf_translate_model=_optional(_env("HF_TRANSLATE_MODEL", cls.hf_translate_model)),
            hf_space_pixal3d=_env("HF_SPACE_PIXAL3D", cls.hf_space_pixal3d),
            hf_space_trellis2=_env("HF_SPACE_TRELLIS2", cls.hf_space_trellis2),
            hf_space_hunyuan21=_env("HF_SPACE_HUNYUAN21", cls.hf_space_hunyuan21),
            hf_space_hunyuan2mv=_env("HF_SPACE_HUNYUAN2MV", cls.hf_space_hunyuan2mv),
            hf_space_trellis=_env("HF_SPACE_TRELLIS", cls.hf_space_trellis),
            hf_space_step1x=_env("HF_SPACE_STEP1X", cls.hf_space_step1x),
            hf_space_hi3d=_env("HF_SPACE_HI3D", cls.hf_space_hi3d),
            meshy_api_key=_env("MESHY_API_KEY"),
            meshy_timeout_s=float(_env("MESHY_TIMEOUT_S", "1800")),
            blender_path=_env("BLENDER_PATH"),
            hf_timeout_s=float(_env("HF_TIMEOUT_S", "600")),
            local_shape_model=_env("LOCAL_SHAPE_MODEL", cls.local_shape_model),
            local_device=_env("LOCAL_DEVICE", "cuda"),
            local_text_to_image=_env("LOCAL_TEXT_TO_IMAGE", cls.local_text_to_image),
            idol_vae=_env("IDOL_FLUX2_VAE", cls.idol_vae),
            image_to_3d=_env("IMAGE_TO_3D", cls.image_to_3d),
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
