"""Verifying the signature of a GPT-Video webhook, as Standard Webhooks defines it.

A delivery carries three headers: webhook-id, webhook-timestamp (whole seconds since 1970) and webhook-signature, a
list of v1,<base64> separated by spaces. Each v1 signature is HMAC-SHA256 over the bytes of <id>.<timestamp>.<body>,
keyed with the bytes of the signing secret (whsec_ followed by standard base64). A delivery is accepted when its
timestamp is within the tolerance of the current time and at least one v1 signature equals, byte for byte, the one
computed with one of the secrets.

The rules this module keeps, each one tested by the shared vectors of webhooks.generated.json:

- the body is verified as the bytes that arrived: a str is encoded as UTF-8, bytes are used as they are and never
  decoded. A body that was already parsed into an object is refused, because its bytes are gone;
- signatures are compared as bytes, with hmac.compare_digest. A signature that is not standard base64 (base64url
  included), or that does not decode to exactly 32 bytes, is no match. A missing = padding is accepted, as the
  libraries of the specification accept it;
- only v1 counts: v1a, v2 and any other version are skipped, so a sender can add a scheme without breaking a
  receiver, and a receiver never accepts a scheme it does not check;
- every signature is compared with every secret, with no early exit: the time taken can tell which signature
  matched, never its bytes.
"""

import base64
import binascii
import datetime
import hashlib
import hmac
import json
import math
import re
import time
from dataclasses import dataclass
from typing import Any, Iterable, List, Mapping, Optional, Sequence, Union

from .errors import INVALID_ARGUMENT, MESSAGES, GptVideoError, WebhookVerificationError, format_error_message, WEBHOOK_VERIFICATION_FAILED

__all__ = ["VerifiedWebhook", "Webhook", "WebhookVerificationError", "construct_event", "verify_webhook"]

SECRET_PREFIX = "whsec_"
"""The prefix of a webhook signing secret."""

_API_KEY_PREFIX = "gvk_"

DEFAULT_TOLERANCE_SEC = 300
"""How far, in seconds and in both directions, a timestamp may be from the current time: five minutes."""

SIGNATURE_VERSION = "v1"
"""The only signature scheme this SDK checks."""

HEADER_ID = "webhook-id"
HEADER_TIMESTAMP = "webhook-timestamp"
HEADER_SIGNATURE = "webhook-signature"

TIMESTAMP_MAX_DIGITS = 400
"""The most significant digits a webhook-timestamp is read with: any longer number is outside every tolerance."""

_STANDARD_BASE64 =re.compile(r"[A-Za-z0-9+/]*={0,2}")
_DIGITS = re.compile(r"[0-9]+")


class _Sentences:
    """The sentences of a refusal."""

    bad_secret_encoding = "The webhook signing secret must be whsec_ followed by standard base64, as the console shows it, with no spaces or line breaks. If you read it from a file, remove the line break at the end."
    no_secret = "Pass the signing secret of the webhook: secret, or secrets during a rotation."
    secret_and_secrets = "Pass secret or secrets, not both."
    bad_timestamp = "The webhook-timestamp header must be whole seconds since 1970, written with digits only."
    no_match = "No v1 signature in the webhook-signature header matches this body with this secret. Verify the raw body, exactly as it arrived, with the signing secret of this webhook."
    bad_tolerance = "tolerance_sec must be a finite number of seconds, 0 or more."
    bad_now = "now must be a datetime with a time zone, or a number of seconds since 1970."

    @staticmethod
    def missing_header(name: str) -> str:
        return f"The {name} header is missing or empty."

    @staticmethod
    def ambiguous_header(name: str) -> str:
        return f"The {name} header was sent more than once, with different values."

    @staticmethod
    def outside_tolerance(seconds: float) -> str:
        return f"The webhook-timestamp is more than {_number(seconds)} seconds away from the current time. Check the clock of this machine; otherwise the message is a replay."


def _number(value: float) -> str:
    return str(int(value)) if float(value).is_integer() else str(value)


@dataclass(frozen=True)
class VerifiedWebhook:
    """What a verified delivery says about itself: its webhook-id, the same for every retry of one message (so it
    can be used to skip duplicates), and the webhook-timestamp of this attempt, in seconds since 1970."""

    id: str
    timestamp: int


RawBody = Union[str, bytes, bytearray, memoryview]
"""The body as it arrived: the text of the request, or its bytes."""


def verify_webhook(
    *,
    headers: Any,
    body: Any,
    secret: Optional[str] = None,
    secrets: Optional[Sequence[str]] = None,
    tolerance_sec: Optional[float] = None,
    now: Optional[Union[datetime.datetime, float]] = None,
) -> VerifiedWebhook:
    """Verifies a webhook delivery. Returns its id and timestamp, or raises WebhookVerificationError, whose reason
    says why: missing_headers, bad_timestamp, timestamp_outside_tolerance, no_matching_signature, bad_secret,
    body_not_raw.

    headers are the request headers: a dict (names in any case, values a str or a list of str) or the headers
    object of a web framework. body is the raw request body, before any JSON parsing. secret is the signing secret
    of the webhook (whsec_...), or secrets several of them during a rotation on your side. tolerance_sec is 300 by
    default; now is the current time, the clock of this machine by default.
    """
    keys = _secrets_of(secret, secrets)
    raw = _bytes_of(body)
    return _verify(keys, headers, raw, _tolerance_of(tolerance_sec), _now_of(now))


def construct_event(
    *,
    headers: Any,
    body: Any,
    secret: Optional[str] = None,
    secrets: Optional[Sequence[str]] = None,
    tolerance_sec: Optional[float] = None,
    now: Optional[Union[datetime.datetime, float]] = None,
) -> Any:
    """Verifies a webhook delivery like verify_webhook, then parses its body as JSON and returns the event. A
    verified body that is not JSON raises the json.JSONDecodeError of json.loads."""
    keys = _secrets_of(secret, secrets)
    raw = _bytes_of(body)
    _verify(keys, headers, raw, _tolerance_of(tolerance_sec), _now_of(now))
    return json.loads(raw)


class Webhook:
    """The form of the Standard Webhooks libraries: Webhook(secret).verify(body, headers) returns the event."""

    __slots__ = ("_keys", "_tolerance")

    def __init__(self, secret: Union[str, Sequence[str]], *, tolerance_sec: Optional[float] = None) -> None:
        """Checks the secret at once: a wrong secret fails here, not on the first delivery."""
        self._keys = _secrets_of(secret, None) if isinstance(secret, str) else _secrets_of(None, secret)
        self._tolerance = _tolerance_of(tolerance_sec)

    def verify(self, payload: Any, headers: Any) -> Any:
        """Verifies a delivery against the clock of this machine and returns its event."""
        raw = _bytes_of(payload)
        _verify(self._keys, headers, raw, self._tolerance, time.time())
        return json.loads(raw)

    def __repr__(self) -> str:
        return "Webhook(secret='[redacted]')"

    def __reduce__(self) -> Any:
        raise TypeError("A Webhook cannot be pickled or copied: it holds the signing secret.")


# ---------------------------------------------------------------------------------------------------- input


def _refused(reason: str, sentence: str) -> WebhookVerificationError:
    return WebhookVerificationError(format_error_message(WEBHOOK_VERIFICATION_FAILED, sentence), reason=reason)


def _invalid(sentence: str) -> GptVideoError:
    return GptVideoError(format_error_message(INVALID_ARGUMENT, sentence), code=INVALID_ARGUMENT)


def _secrets_of(secret: Any, secrets: Any) -> List[bytes]:
    """The bytes of each signing secret."""
    if secret is not None and secrets is not None:
        raise _invalid(_Sentences.secret_and_secrets)
    listed: Any = secrets if secrets is not None else ([secret] if secret is not None else [])
    if isinstance(listed, (str, bytes)) or not isinstance(listed, Iterable):
        raise _refused("bad_secret", _Sentences.no_secret)
    values = list(listed)
    if not values:
        raise _refused("bad_secret", _Sentences.no_secret)
    return [_secret_bytes(value) for value in values]


def _secret_bytes(secret: Any) -> bytes:
    if not isinstance(secret, str) or not secret:
        raise _refused("bad_secret", _Sentences.no_secret)
    if secret.startswith(_API_KEY_PREFIX):
        raise _refused("bad_secret", MESSAGES["api_key_as_webhook_secret"])
    if not secret.startswith(SECRET_PREFIX):
        raise _refused("bad_secret", MESSAGES["bad_webhook_secret"])
    value = _from_standard_base64(secret[len(SECRET_PREFIX) :])
    if value is None:
        raise _refused("bad_secret", _Sentences.bad_secret_encoding)
    return value


_SURROGATE = re.compile("[\ud800-\udfff]")


def _utf8(text: str) -> bytes:
    """A text as UTF-8, a lone surrogate written as U+FFFD, as the TextEncoder of the JavaScript SDK writes it."""
    return _SURROGATE.sub("�", text).encode("utf-8")


def _bytes_of(body: Any) -> bytes:
    """The bytes of the body, never decoded. Anything that is not text or bytes is a body that was parsed."""
    if isinstance(body, str):
        return _utf8(body)
    if isinstance(body, (bytes, bytearray, memoryview)):
        return bytes(body)
    raise _refused("body_not_raw", MESSAGES["webhook_body_not_raw"])


def _tolerance_of(value: Any) -> float:
    if value is None:
        return DEFAULT_TOLERANCE_SEC
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise _invalid(_Sentences.bad_tolerance)
    return value


def _now_of(value: Any) -> float:
    if value is None:
        return time.time()
    if isinstance(value, datetime.datetime):
        if value.tzinfo is None:
            raise _invalid(_Sentences.bad_now)
        return value.timestamp()
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise _invalid(_Sentences.bad_now)
    return float(value)


# -------------------------------------------------------------------------------------------------- headers


def _values_of(value: Any) -> List[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, (list, tuple)):
        return [item for item in value if isinstance(item, str)]
    return []


def _header_values(headers: Any, name: str) -> List[str]:
    """Every value a header has, whatever the case of its name and the form of the headers: a dict, a mapping of a
    web framework, or an email.message.Message."""
    get_all = getattr(headers, "get_all", None)
    if callable(get_all):
        return _values_of(list(get_all(name) or []))
    items = getattr(headers, "items", None)
    if not callable(items):
        return []
    out: List[str] = []
    for key, value in items():
        if isinstance(key, str) and key.lower() == name:
            out.extend(_values_of(value))
    return out


def _single_header(headers: Any, name: str, ambiguous_reason: str) -> str:
    """The one value of a header that must have one. Missing or empty is missing_headers; two different values are
    refused, because the content to sign would be ambiguous."""
    values = list(dict.fromkeys(value for value in _header_values(headers, name) if value != ""))
    if not values:
        raise _refused("missing_headers", _Sentences.missing_header(name))
    if len(values) > 1:
        raise _refused(ambiguous_reason, _Sentences.ambiguous_header(name))
    return values[0]


# --------------------------------------------------------------------------------------------- verification


def _verify(keys: Sequence[bytes], headers: Any, body: bytes, tolerance_sec: float, now: float) -> VerifiedWebhook:
    id = _single_header(headers, HEADER_ID, "missing_headers")
    timestamp_text = _single_header(headers, HEADER_TIMESTAMP, "bad_timestamp")
    signature_values = [value for value in _header_values(headers, HEADER_SIGNATURE) if value != ""]
    if not signature_values:
        raise _refused("missing_headers", _Sentences.missing_header(HEADER_SIGNATURE))

    if not _DIGITS.fullmatch(timestamp_text):
        raise _refused("bad_timestamp", _Sentences.bad_timestamp)
    digits = timestamp_text.lstrip("0")
    # int() refuses a text of more than 4300 digits with a ValueError, which a receiver that catches
    # WebhookVerificationError would not expect. A number of more than TIMESTAMP_MAX_DIGITS digits is past the
    # current time plus any finite tolerance (a float ends near 1.8e308), as the JavaScript SDK finds it
    if len(digits) > TIMESTAMP_MAX_DIGITS:
        raise _refused("timestamp_outside_tolerance", _Sentences.outside_tolerance(tolerance_sec))
    timestamp = int(digits or "0")
    # whole seconds on both sides, as the libraries of the specification compare them: the sender writes the second
    # it is in, rounded down, so the receiver does the same with its clock
    now_sec = math.floor(now)
    if now_sec - timestamp > tolerance_sec or timestamp - now_sec > tolerance_sec:
        raise _refused("timestamp_outside_tolerance", _Sentences.outside_tolerance(tolerance_sec))

    # the signed content holds the timestamp as a number, as the sender writes it: 0123 is signed as 123
    content = _utf8(f"{id}.{timestamp}.") + body
    expected = [hmac.new(key, content, hashlib.sha256).digest() for key in keys]
    matched = False
    for received in _signatures_of(" ".join(signature_values)):
        for mac in expected:
            # every pair is compared, with no early exit; compare_digest takes the same time for any two 32-byte values
            matched = hmac.compare_digest(received, mac) | matched
    if not matched:
        raise _refused("no_matching_signature", _Sentences.no_match)
    return VerifiedWebhook(id=id, timestamp=timestamp)


def _signatures_of(header: str) -> List[bytes]:
    """The decoded v1 signatures of a header. Each space-separated entry is split on commas as the libraries of the
    specification split it: the first part is the version, the second the signature. An entry of another version,
    an empty one, or one whose signature is not standard base64 is skipped; one that decodes to another length than
    the HMAC is no match."""
    out: List[bytes] = []
    for entry in header.split(" "):
        parts = entry.split(",")
        if len(parts) < 2 or parts[0] != SIGNATURE_VERSION:
            continue
        decoded = _from_standard_base64(parts[1])
        if decoded is not None:
            out.append(decoded)
    return out


def _from_standard_base64(text: str) -> Optional[bytes]:
    """Standard base64 to bytes, or None. Padding may be left out; when it is there it must complete the last
    group. Base64url, whitespace and any other character are refused."""
    if not _STANDARD_BASE64.fullmatch(text):
        return None
    core = text.rstrip("=")
    if not core or len(core) % 4 == 1:
        return None
    if len(core) != len(text) and len(text) % 4 != 0:
        return None
    try:
        return base64.b64decode(core + "=" * ((4 - len(core) % 4) % 4), validate=True)
    except (binascii.Error, ValueError):
        return None
