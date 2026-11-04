"""Numbers for user-facing messages, in Italian: decimal comma, as the UI shows them."""

from __future__ import annotations


def it_num(value: float, digits: int | None = None) -> str:
    """``value`` with ``digits`` decimals, or in its shortest form (like ``:g``) when None."""
    text = f"{value:.{digits}f}" if digits is not None else f"{value:g}"
    return text.replace(".", ",")
