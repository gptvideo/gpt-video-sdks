"""The rules of one call, as retry.json of the shared vectors writes them: which outcomes are retried, which count
against max_retries, how long to pause, whether a spend may have been charged, and what an Idempotency-Key looks
like. Pure functions over plain values: the clock, the network and the pauses belong to _transport.py, which
applies these rules in order.
"""

import calendar
import re
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Optional, Set, Tuple, Union

from ._generated import CONVENTIONS
from ._table import OperationSpec

MAX_RETRIES = 2
"""Failures retried after the first attempt; IDEMPOTENCY_IN_PROGRESS is a wait and never counts."""

TIMEOUT = 60.0
"""The seconds one attempt has, longer than a ?wait=25 read."""

DEADLINE = 180.0
"""The seconds the whole call has, pauses included: the idempotency lease of 120 s plus one attempt."""

RETRY_AFTER_MAX_SEC = 60
"""A Retry-After longer than this stops the call instead of being waited."""

BACKOFF_BASE_MS = 500
BACKOFF_CAP_MS = 8000
"""The backoff after attempt a is drawn from [0, min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2^(a-1))) milliseconds."""

SWITCHED_OFF: str = CONVENTIONS["switchedOffReason"]
"""The reason of an UNAVAILABLE that comes from an operation turned off: sending it again does not help."""

MAX_SAFE_INTEGER = 2**53 - 1
"""The largest whole number both SDKs read the same way."""

_IN_PROGRESS = "IDEMPOTENCY_IN_PROGRESS"
_RATE_LIMITED = "RATE_LIMITED"
_UNAVAILABLE = "UNAVAILABLE"


@dataclass(frozen=True)
class RateLimit:
    """The rate limit headers of an answer: requests allowed in the window, left in it, seconds until it starts again."""

    limit: Optional[int]
    remaining: Optional[int]
    reset_sec: Optional[int]


@dataclass(frozen=True)
class Answer:
    """What an HTTP answer said besides its body."""

    status: int
    retry_after: Optional[str]
    request_id: Optional[str]
    replayed: bool
    rate_limit: RateLimit


@dataclass(frozen=True)
class Success:
    status: int
    body: Any
    answer: Answer
    kind: str = "success"


@dataclass(frozen=True)
class ApiFailure:
    code: str
    status: int
    message: str
    hint: Optional[str]
    details: Any
    request_id: Optional[str]
    answer: Answer
    kind: str = "api"


@dataclass(frozen=True)
class NetworkFailure:
    """CONNECTION_FAILED, TIMEOUT, ABORTED or BAD_RESPONSE; answer is there when an HTTP answer arrived."""

    code: str
    status: Optional[int]
    text: str
    answer: Optional[Answer]
    kind: str = "network"


Failure = Union[ApiFailure, NetworkFailure]
Outcome = Union[Success, ApiFailure, NetworkFailure]

_ACCEPTED_KEY = re.compile(r"[\x21-\x7E]{1,255}")


def is_idempotency_key(key: Any) -> bool:
    """Whether the API would take this Idempotency-Key: 1 to 255 visible ASCII characters, no spaces (keys.json).
    The whole text must match, so a final newline is refused too."""
    return isinstance(key, str) and _ACCEPTED_KEY.fullmatch(key) is not None


def new_idempotency_key() -> str:
    """A new Idempotency-Key: a random UUID from the operating system's random source, never from a seeded
    generator, because two calls that drew the same key would receive each other's answer."""
    return str(uuid.uuid4())


_DIGITS = re.compile(r"[0-9]+")
_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
_IMF_FIXDATE = re.compile(r"(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), ([0-9]{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([0-9]{4}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT")


def retry_after_sec(raw: Optional[str], now: float) -> Optional[int]:
    """Retry-After in whole seconds, or None when it cannot be read.

    Readable is: ASCII digits after trimming spaces and tabs, or an IMF-fixdate (Sun, 11 Oct 2026 12:00:07 GMT)
    that is a real calendar time and not in the past, which becomes ceil((date - now) / 1000 ms). Everything else
    (-1, abc, 1e9, 1.5, an older date format, a past date) counts as absent. The weekday name is not checked.
    Digits past the largest safe integer read as that integer, which stops the call like any value over
    RETRY_AFTER_MAX_SEC, and never as absent, which would retry at once. now is the wall-clock time the answer
    arrived, in seconds.
    """
    if not isinstance(raw, str):
        return None
    value = raw.strip(" \t")
    if _DIGITS.fullmatch(value):
        # int() refuses a text of more than 4300 digits (sys.int_info.default_max_str_digits): a ValueError here
        # would leave send() without a GptVideoError, and a spend without its idempotency_key. More significant
        # digits than the largest safe integer has are that integer; leading zeros count for nothing
        digits = value.lstrip("0")
        return MAX_SAFE_INTEGER if len(digits) > len(str(MAX_SAFE_INTEGER)) else min(int(digits or "0"), MAX_SAFE_INTEGER)
    m = _IMF_FIXDATE.fullmatch(value)
    if not m:
        return None
    day, month, year, hour, minute, second = int(m[1]), _MONTHS.index(m[2]) + 1, int(m[3]), int(m[4]), int(m[5]), int(m[6])
    # a time that does not exist (31 November, 24:00) does not roll over to the next day: it is unreadable
    if year < 1 or not 1 <= day <= calendar.monthrange(year, month)[1] or hour > 23 or minute > 59 or second > 59:
        return None
    at_ms = calendar.timegm((year, month, day, hour, minute, second, 0, 0, 0)) * 1000
    delta_ms = at_ms - int(round(now * 1000))
    return None if delta_ms < 0 else -(-delta_ms // 1000)


def backoff_ms(attempt: int, random: Callable[[], float]) -> int:
    """The pause after attempt number attempt (1, 2, 3...) when there is no readable Retry-After: a whole number
    of milliseconds drawn uniformly from [0, min(8000, 500 * 2^(attempt-1)))."""
    cap = min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1))
    return int(random() * cap)


def _switched_off(details: Any) -> bool:
    return isinstance(details, dict) and details.get("reason") == SWITCHED_OFF


def policy_of(outcome: Failure, spec: OperationSpec, retryable: Set[str]) -> Tuple[bool, bool]:
    """Whether a failure is retried, and whether it uses up one of max_retries.

    Retried when the call is retry-safe: CONNECTION_FAILED, TIMEOUT, BAD_RESPONSE with a 5xx status, and the API's
    retryable codes, except an UNAVAILABLE that says switched_off. Retried even when the call is not retry-safe:
    RATE_LIMITED, which the API refuses before running anything. IDEMPOTENCY_IN_PROGRESS is the first attempt still
    running on the server: it is waited for and never uses up max_retries. Everything else stops the call, a code
    this SDK does not know included.
    """
    if isinstance(outcome, NetworkFailure):
        if outcome.code == "ABORTED":
            return (False, False)
        if outcome.code == "BAD_RESPONSE":
            return (outcome.status is not None and outcome.status >= 500 and spec["retrySafe"], True)
        return (spec["retrySafe"], True)
    if outcome.code not in retryable:
        return (False, False)
    if outcome.code == _RATE_LIMITED:
        return (True, True)
    if outcome.code == _UNAVAILABLE and _switched_off(outcome.details):
        return (False, False)
    return (spec["retrySafe"], outcome.code != _IN_PROGRESS)


def may_have_spent(outcome: Failure, spec: OperationSpec, sent: bool, unknown_before: bool = False) -> bool:
    """Whether a spend may have been charged when the call stops on this outcome: only for an operation whose
    effect is spend, only once a request left the client, and only when the outcome leaves the charge unknown. A
    definite refusal (a 4xx with the API's error body) never may have spent.

    One refusal is not an answer about the charge: RATE_LIMITED. The API refuses a rate-limited request before it
    looks at the Idempotency-Key, so when an earlier attempt of the same call left the charge unknown (it timed
    out, or the API said IDEMPOTENCY_IN_PROGRESS), a RATE_LIMITED that ends the call leaves it unknown too.
    """
    if spec["effect"] != "spend" or not sent:
        return False
    if isinstance(outcome, NetworkFailure):
        if outcome.code != "BAD_RESPONSE":
            return True
        status = outcome.status
        return status is not None and (200 <= status < 300 or status >= 500)
    if outcome.code == _IN_PROGRESS:
        return True
    if outcome.code == _RATE_LIMITED:
        return unknown_before
    return outcome.status >= 500 and not (outcome.code == _UNAVAILABLE and _switched_off(outcome.details))
