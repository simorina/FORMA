"""Provider interface: generate(prompt, image, params) -> mesh."""

from __future__ import annotations

import re
from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import trimesh
from PIL import Image

from ..pipeline.colors import colored_mesh, concatenate

# Prompt template used for every text->image step: we want a single, solid,
# well-lit object that image->3D models can lift into clean printable geometry.
PRINTABLE_TEMPLATE = (
    "{prompt}. A single object, centered, full view, isolated on a plain light grey "
    "background, solid and printable, matte clay material, soft studio lighting, "
    "no text, no shadows, no cropping, high detail, product photo"
)


def build_image_prompt(prompt: str) -> str:
    return PRINTABLE_TEMPLATE.format(prompt=prompt.strip().rstrip("."))


# Short Italian function words and accented vowels: enough to tell an Italian prompt from an
# English one ("un vaso con il collo stretto" vs "a vase with a narrow neck").
_ITALIAN = re.compile(
    r"\b(il|lo|la|gli|le|un|una|uno|con|di|del|dello|della|dei|degli|delle|da|dal|per|che|sul|"
    r"sulla|nel|nella|tra|fra|e|ed|è)\b|[àèéìòù]",
    re.IGNORECASE,
)


def looks_italian(text: str) -> bool:
    return bool(_ITALIAN.search(text or ""))


# Callback signature: (stage, progress 0..1, message)
ProgressFn = Callable[[str, float, str], None]


def _noop(stage: str, progress: float, message: str) -> None:  # pragma: no cover
    return None


@dataclass
class GenParams:
    model: str | None = None  # image->3D model key (e.g. "trellis2")
    seed: int = 0
    quality: str = "standard"  # "draft" | "standard" | "high"
    extra: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> GenParams:
        data = dict(data or {})
        known = {k: data.pop(k) for k in ("model", "seed", "quality") if k in data}
        if "seed" in known:
            known["seed"] = int(known["seed"])
        return cls(**known, extra=data)


@dataclass
class GenerationResult:
    mesh: trimesh.Trimesh
    image: Image.Image | None = None  # intermediate text->image render (if any)
    model: str = ""
    meta: dict[str, Any] = field(default_factory=dict)


@dataclass
class ModelInfo:
    key: str
    label: str
    description: str
    license: str
    default: bool = False
    notes: list[str] = field(default_factory=list)  # short Italian notes for the UI

    @property
    def eu_restricted(self) -> bool:
        """The licence grants no rights in the EU (the user is in Italy)."""
        return "esclusi UE" in self.license

    def to_dict(self) -> dict[str, Any]:
        return {**self.__dict__, "notes": list(self.notes), "eu_restricted": self.eu_restricted}


class ProviderError(RuntimeError):
    """Raised with a user-facing (Italian) message.

    ``kind`` classifies the failure (quota, auth, unavailable, network, error) so the
    remote provider can decide whether falling back to another model makes sense.
    """

    def __init__(self, message: str, kind: str = "error") -> None:
        super().__init__(message)
        self.kind = kind


class Provider(ABC):
    name: str = ""
    label: str = ""
    description: str = ""

    @abstractmethod
    def models(self) -> list[ModelInfo]: ...

    def available(self) -> tuple[bool, str]:
        """(is_available, reason-if-not)."""
        return True, ""

    @abstractmethod
    def generate(
        self,
        prompt: str | None,
        image: Image.Image | None,
        params: GenParams,
        progress: ProgressFn = _noop,
    ) -> GenerationResult: ...

    def image(self, prompt: str, seed: int = 0, progress: ProgressFn = _noop) -> Image.Image:
        """Only the text->image step, so the user can approve the picture before the
        (slower, quota-hungry) image->3D step."""
        raise ProviderError(f"{self.label} non genera immagini di anteprima.")

    def english(self, prompt: str) -> str:
        """The prompt as the text->image model will read it (translated when needed)."""
        return prompt

    def info(self) -> dict[str, Any]:
        ok, reason = self.available()
        return {
            "name": self.name,
            "label": self.label,
            "description": self.description,
            "available": ok,
            "reason": reason,
            "models": [m.to_dict() for m in self.models()],
        }


def as_single_mesh(obj: Any) -> trimesh.Trimesh:
    """Flatten a trimesh Scene / list into one Trimesh, keeping per-vertex colours (from a
    texture, a material or vertex/face colours; see ``pipeline.colors``) and nothing else."""
    if isinstance(obj, trimesh.Trimesh):
        return colored_mesh(obj)
    if isinstance(obj, trimesh.Scene):
        meshes = [g for g in obj.dump() if isinstance(g, trimesh.Trimesh)] if hasattr(
            obj, "dump"
        ) else []
        if not meshes:
            raise ProviderError("Il file 3D ricevuto non contiene geometria.")
        return concatenate(meshes)
    if isinstance(obj, (list, tuple)):
        return concatenate([as_single_mesh(o) for o in obj])
    raise ProviderError(f"Formato mesh non supportato: {type(obj).__name__}")


def load_mesh_file(path: str, file_type: str | None = None) -> trimesh.Trimesh:
    """Geometry plus per-vertex colours, when the file has any (an AI model's texture)."""
    loaded = trimesh.load(path, file_type=file_type, force=None, process=False)
    return as_single_mesh(loaded)
