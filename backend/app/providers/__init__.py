"""Provider registry (GEN_PROVIDER selects the default)."""

from __future__ import annotations

from ..config import get_settings
from .base import GenerationResult, GenParams, Provider, ProviderError
from .hf_remote import HFRemoteProvider
from .local import LocalProvider
from .procedural import ProceduralProvider

_REGISTRY: dict[str, Provider] = {}


def _build(name: str) -> Provider:
    if name == "hf_remote":
        return HFRemoteProvider()
    if name == "local":
        return LocalProvider()
    if name == "procedural":
        return ProceduralProvider()
    raise ProviderError(f"Provider sconosciuto: {name}")


PROVIDER_NAMES = ("hf_remote", "local", "procedural")


def get_provider(name: str | None = None) -> Provider:
    name = name or get_settings().gen_provider
    if name not in _REGISTRY:
        _REGISTRY[name] = _build(name)
    return _REGISTRY[name]


def register_provider(provider: Provider) -> None:
    """Override a provider instance (used by tests to inject mocks)."""
    _REGISTRY[provider.name] = provider


def reset_providers() -> None:
    _REGISTRY.clear()


def all_providers() -> list[Provider]:
    return [get_provider(n) for n in PROVIDER_NAMES]


__all__ = [
    "GenParams",
    "GenerationResult",
    "Provider",
    "ProviderError",
    "all_providers",
    "get_provider",
    "register_provider",
    "reset_providers",
]
