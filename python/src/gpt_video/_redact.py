"""Keeping the API key out of everything the SDK hands back.

The key travels in one place only, the Authorization header of a request to the API. Every text and value that
comes back from the server and ends up in an error (message, hint, details) passes through here first. The key
itself lives in a Secret, which prints as [redacted] and refuses to be pickled or copied.
"""

import re
from typing import Any, NoReturn, Optional

REDACTED = "[redacted]"

_KEY_SHAPE = re.compile(r"gvk_[A-Za-z0-9_-]{16,}")
"""A key-shaped token, whichever key it is: gvk_ and at least 16 more characters of its alphabet."""

MAX_DEPTH = 16
"""How deep an error's details are copied; anything deeper is cut, never walked."""

TRUNCATED = "[truncated]"
"""What stands in for a part of details deeper than MAX_DEPTH."""


def scrub_text(text: str, key: Optional[str]) -> str:
    """The text with the key, and anything shaped like a key, replaced by [redacted]."""
    plain = text.replace(key, REDACTED) if key else text
    return _KEY_SHAPE.sub(REDACTED, plain)


def scrub_value(value: Any, key: Optional[str], depth: int = 0) -> Any:
    """A copy of a parsed JSON value with every string scrubbed, the keys of objects included."""
    if isinstance(value, str):
        return scrub_text(value, key)
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if depth >= MAX_DEPTH:
        return TRUNCATED
    if isinstance(value, (list, tuple)):
        return [scrub_value(item, key, depth + 1) for item in value]
    if isinstance(value, dict):
        return {scrub_text(str(name), key): scrub_value(item, key, depth + 1) for name, item in value.items()}
    return TRUNCATED


class Secret:
    """A text that never shows: repr and str print [redacted], and pickling or copying it fails."""

    __slots__ = ("_value",)

    def __init__(self, value: str) -> None:
        self._value = value

    def reveal(self) -> str:
        """The text itself, for the one place it is sent."""
        return self._value

    def __repr__(self) -> str:
        return REDACTED

    __str__ = __repr__

    def __reduce__(self) -> NoReturn:
        raise TypeError("An API key cannot be pickled or copied: it would leave the process in the clear.")

    def __copy__(self) -> NoReturn:
        self.__reduce__()

    def __deepcopy__(self, memo: Any) -> NoReturn:
        self.__reduce__()
