"""How the SDK sends one call: the client's settings, the request built from an operation of the table, one
attempt on the wire, and the loop that applies the rules of _retry.py to the attempts of a call.

Four things hold on every path through this file:

- a call makes its Idempotency-Key once, before the first attempt, and sends that key on every attempt and every
  wait; it never makes a second one;
- every attempt ends by its own timeout, and every call by its deadline;
- a redirect is never followed (_http.py);
- the API key leaves this file only in the Authorization header of a request to base_url.
"""

import inspect
import json
import math
import os
import random
import re
import time
import urllib.parse
from dataclasses import dataclass
from typing import Any, Callable, Dict, Iterable, List, Mapping, MutableMapping, NoReturn, Optional, Set, Tuple, Union

from ._generated import CONVENTIONS
from ._http import Cancel, Deadline, UrllibWire, Wire, WireFailure, WireRequest, WireResponse
from ._redact import REDACTED, Secret, scrub_text, scrub_value
from ._retry import (
    DEADLINE,
    MAX_RETRIES,
    MAX_SAFE_INTEGER,
    RETRY_AFTER_MAX_SEC,
    TIMEOUT,
    Answer,
    ApiFailure,
    Failure,
    NetworkFailure,
    Outcome,
    RateLimit,
    Success,
    backoff_ms,
    is_idempotency_key,
    may_have_spent,
    new_idempotency_key,
    policy_of,
    retry_after_sec,
)
from ._table import UNSET, OperationSpec
from ._version import VERSION
from .errors import INVALID_ARGUMENT, MESSAGES, TEXTS, GptVideoApiError, GptVideoError, GptVideoNetworkError, format_error_message

DEFAULT_BASE_URL: str = CONVENTIONS["baseUrl"]
"""The base URL of the documentation, used when the caller gives none."""

API_KEY_ENV: str = CONVENTIONS["apiKeyEnv"]
"""The environment variable read when the caller passes no api_key."""

API_KEY_PREFIX = "gvk_"
"""Every API key starts with this."""

USER_AGENT_PRODUCT = "gpt-video-python"
"""The product token of the User-Agent; the request log of the API counts it as an SDK."""

MAX_DURATION = 2_147_483.647
"""The longest timeout or deadline, in seconds: the one the JavaScript SDK takes too."""

CALL_OPTIONS: Tuple[str, ...] = ("idempotency_key", "timeout", "deadline", "max_retries", "cancel")
"""The options of one call. The bytes of an operation that sends bytes travel beside them, never inside."""

_HEADER: Mapping[str, str] = CONVENTIONS["headers"]
_ERROR_CODE = re.compile(r"[A-Z][A-Z0-9_]{0,63}")
_VISIBLE = re.compile(r"[\x21-\x7E]+")
_SUFFIX = re.compile(r"[\x21-\x7E](?:[\x20-\x7E]{0,254}[\x21-\x7E])?")
_WHOLE = re.compile(r"[0-9]{1,15}")
_LOCAL_IPV4 = re.compile(r"127\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}")


@dataclass(frozen=True)
class ResponseEvent:
    """What on_response receives for every HTTP answer, error answers included. Never a header, never the key."""

    operation: str
    status: int
    request_id: Optional[str]
    attempt: int
    replayed: bool
    rate_limit: RateLimit


@dataclass(frozen=True)
class RetryEvent:
    """What on_retry receives before every pause of a call: the attempt that just ended (from 1), what it ended
    with (an API code, or CONNECTION_FAILED, TIMEOUT, BAD_RESPONSE), and the pause before the next one, in seconds."""

    operation: str
    attempt: int
    code: str
    delay: float


class Clock:
    """The time and the pauses of the engine. A test passes a fake one."""

    def monotonic(self) -> float:
        return time.monotonic()

    def time(self) -> float:
        return time.time()

    def rand(self) -> float:
        return random.random()

    def sleep(self, seconds: float, cancel: Optional[Cancel]) -> bool:
        """Waits, or less when the cancel event is set. True when the time passed, False when cancel stopped it."""
        if cancel is None:
            if seconds > 0:
                time.sleep(seconds)
            return True
        if seconds <= 0:
            return not cancel.is_set()
        return not cancel.wait(seconds)


# ------------------------------------------------------------------------------------------- small helpers


def invalid(message: str, operation: Optional[str] = None) -> GptVideoError:
    """A mistake found before anything is sent."""
    return GptVideoError(format_error_message(INVALID_ARGUMENT, message), code=INVALID_ARGUMENT, operation=operation)


def call_hook(hook: Optional[Callable[[Any], Any]], event: Any) -> None:
    """Calls a hook of the caller. What it raises is ignored: a logging hook must never turn a call that
    succeeded, perhaps a spend, into an exception the caller would answer by sending it again."""
    if hook is None:
        return
    try:
        result = hook(event)
        if inspect.iscoroutine(result):
            # an async hook cannot be awaited here; closing it spares the warning of a coroutine never awaited
            result.close()
    except Exception:
        pass


def is_cancel(value: Any) -> bool:
    return callable(getattr(value, "is_set", None)) and callable(getattr(value, "wait", None))


def is_this_machine(hostname: str) -> bool:
    """Whether an http:// address is this machine, the only place a key may travel without TLS: localhost,
    *.localhost, 127.0.0.0/8 and ::1."""
    host = hostname.lower()
    return host == "localhost" or host.endswith(".localhost") or _LOCAL_IPV4.fullmatch(host) is not None or host in ("::1", "[::1]")


def is_safe_address(scheme: str, hostname: str) -> bool:
    """Whether an address may be called: https://, or http:// to this machine."""
    return scheme == "https" or (scheme == "http" and is_this_machine(hostname))


def check_count(name: str, value: Any, operation: Optional[str] = None) -> int:
    if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= MAX_SAFE_INTEGER:
        return value
    raise invalid(f"{name} must be a whole number, 0 or more.", operation)


def check_duration(name: str, value: Any, operation: Optional[str] = None) -> float:
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and 0 < value <= MAX_DURATION:
        return float(value)
    raise invalid(f"{name} must be a number of seconds, more than 0 and at most {MAX_DURATION}.", operation)


def check_cancel(value: Any, operation: Optional[str] = None) -> Optional[Cancel]:
    if value is None:
        return None
    if is_cancel(value):
        return value
    raise invalid("cancel must be a threading.Event, or an object with is_set() and wait().", operation)


# ------------------------------------------------------------------------------------------------ settings


@dataclass(frozen=True)
class Origin:
    """A base URL, checked: with and without its final /v1, and whether proxies may carry it."""

    root: str
    base_url: str
    use_proxies: bool


def resolve_base_url(raw: Any, name: str = "base_url") -> Origin:
    """The base URL with and without its final /v1. Both forms send the same requests."""
    if not isinstance(raw, str):
        raise invalid(f"{name} must be a string, such as {DEFAULT_BASE_URL}.")
    not_absolute = invalid(f"{name} is not an absolute URL. Use the base URL of the documentation, such as {DEFAULT_BASE_URL}.")
    if not _VISIBLE.fullmatch(raw):
        raise not_absolute
    try:
        parts = urllib.parse.urlsplit(raw)
        port = parts.port
        hostname = parts.hostname
    except ValueError:
        raise not_absolute from None
    if parts.scheme not in ("https", "http") or not hostname:
        raise not_absolute
    if not is_safe_address(parts.scheme, hostname):
        raise invalid(MESSAGES["insecure_base_url"])
    if parts.username is not None or parts.password is not None:
        raise invalid(f"{name} must not hold a user name or a password.")
    if parts.query or parts.fragment or "?" in raw or "#" in raw:
        raise invalid(f"{name} must not have a query or a fragment.")
    host = f"[{hostname}]" if ":" in hostname else hostname
    default_port = 443 if parts.scheme == "https" else 80
    origin = f"{parts.scheme}://{host}{'' if port is None or port == default_port else f':{port}'}"
    path = re.sub(r"/v1$", "", re.sub(r"/+$", "", parts.path))
    return Origin(root=f"{origin}{path}", base_url=f"{origin}{path}/v1", use_proxies=not is_this_machine(hostname))


@dataclass(frozen=True)
class Settings:
    """The settings of a client, checked once."""

    api_key: Secret
    origin: Origin
    max_retries: int
    timeout: float
    deadline: float
    on_response: Optional[Callable[[ResponseEvent], Any]]
    on_retry: Optional[Callable[[RetryEvent], Any]]
    user_agent: str


def resolve_settings(
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    max_retries: Optional[int] = None,
    timeout: Optional[float] = None,
    deadline: Optional[float] = None,
    on_response: Optional[Callable[[ResponseEvent], Any]] = None,
    on_retry: Optional[Callable[[RetryEvent], Any]] = None,
    user_agent_suffix: Optional[str] = None,
    environ: Optional[Mapping[str, str]] = None,
) -> Settings:
    """The settings of a client, checked in this order: the key, the base URL, the rest. Every mistake is a
    GptVideoError with INVALID_ARGUMENT, raised before anything is sent; no message repeats the key."""
    key: Any = api_key if api_key is not None else (os.environ if environ is None else environ).get(API_KEY_ENV)
    if key is None or key == "":
        raise invalid(MESSAGES["missing_api_key"])
    # a key pasted with a space or a line break around it is a key with bad characters, not a wrong key
    if not isinstance(key, str) or not key.strip().startswith(API_KEY_PREFIX):
        raise invalid(MESSAGES["bad_api_key_prefix"])
    if not _VISIBLE.fullmatch(key):
        raise invalid(MESSAGES["bad_api_key_characters"])
    origin = resolve_base_url(DEFAULT_BASE_URL if base_url is None else base_url)
    for hook_name, hook in (("on_response", on_response), ("on_retry", on_retry)):
        if hook is not None and not callable(hook):
            raise invalid(f"{hook_name} must be a function.")
    user_agent = f"{USER_AGENT_PRODUCT}/{VERSION}"
    if user_agent_suffix is not None:
        if not isinstance(user_agent_suffix, str) or not _SUFFIX.fullmatch(user_agent_suffix):
            raise invalid("user_agent_suffix must be 1 to 256 visible ASCII characters, with no space at either end.")
        user_agent += f" {user_agent_suffix}"
    return Settings(
        api_key=Secret(key),
        origin=origin,
        max_retries=MAX_RETRIES if max_retries is None else check_count("max_retries", max_retries),
        timeout=TIMEOUT if timeout is None else check_duration("timeout", timeout),
        deadline=DEADLINE if deadline is None else check_duration("deadline", deadline),
        on_response=on_response,
        on_retry=on_retry,
        user_agent=user_agent,
    )


# ------------------------------------------------------------------------------------------------- request


@dataclass(frozen=True)
class PreparedRequest:
    """A request built once and sent as it is on every attempt: every header but Authorization."""

    url: str
    method: str
    headers: Mapping[str, str]
    body: Optional[bytes]


_SAFE = "-_.!~*'()"


def _encoded(spec: OperationSpec, name: str, text: str) -> str:
    """A text percent-encoded for a URL: every byte outside A-Z a-z 0-9 - _ . ! ~ * ' ( ) as %XX, a space as %20,
    so that no server reads a + or a / of the value as anything but itself. A text with a lone surrogate has no
    UTF-8 form, and is refused before anything is sent."""
    try:
        return urllib.parse.quote(text, safe=_SAFE)
    except UnicodeEncodeError:
        raise invalid(f"{name} is not well-formed text: it has a lone surrogate.", spec["id"]) from None


def _whole(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= MAX_SAFE_INTEGER


def _path_segment(spec: OperationSpec, name: str, value: Any) -> str:
    """The text of a path parameter. A string is percent-encoded, so / stays inside the segment; . and .. are
    refused, because a URL parser would read them as this folder and the folder above and send the call, with
    the key, to another endpoint."""
    if value is None or value is UNSET or value == "":
        raise invalid(f"{spec['id']} needs {name}.", spec["id"])
    if isinstance(value, str):
        if value in (".", ".."):
            raise invalid(f'{name} cannot be "{value}".', spec["id"])
        return _encoded(spec, name, value)
    if _whole(value):
        return str(value)
    raise invalid(f"{name} must be a non-empty string or a whole number.", spec["id"])


def _query_value(spec: OperationSpec, name: str, value: Any) -> str:
    """The text of a query value, in the only forms the API reads from a URL: a string as it is, true or false,
    a whole number in decimal digits, with no sign."""
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    if _whole(value):
        return str(value)
    raise invalid(f"{name} must be a string, True or False, or a whole number 0 or more: {spec['id']} sends it in the URL.", spec["id"])


def build_request(settings: Settings, spec: OperationSpec, fields: Optional[Mapping[str, Any]], body: Optional[bytes], idempotency_key: Optional[str]) -> PreparedRequest:
    """The request of one call. The flat input of the catalogue is split as the API reads it: the path parameters
    into the path, the other fields into the query or the JSON body (inQuery); an operation that sends bytes
    sends body with its content type. A field left at UNSET is not sent; None is sent as null."""
    op = spec["id"]
    if fields is not None and not isinstance(fields, Mapping):
        raise invalid(f"The input of {op} must be a dict.", op)
    present: Dict[str, Any] = {}
    for name, value in (fields or {}).items():
        if not isinstance(name, str):
            raise invalid(f"The fields of {op} must be named with strings.", op)
        if value is not UNSET:
            present[name] = value
    path = spec["path"]
    for name in spec["pathParams"]:
        path = path.replace("{" + name + "}", _path_segment(spec, name, present.pop(name, None)))

    headers: Dict[str, str] = {"Accept": "application/json", "User-Agent": settings.user_agent}
    if idempotency_key is not None:
        headers[_HEADER["idempotencyKey"]] = idempotency_key
    query = ""
    data: Optional[bytes] = None
    if spec["inQuery"] or spec["binary"] is not None:
        query = "&".join(f"{_encoded(spec, name, name)}={_encoded(spec, name, _query_value(spec, name, value))}" for name, value in present.items())
    elif present:
        try:
            # ensure_ascii writes every character outside ASCII as an escape, as JSON allows: the server reads the
            # same text, and a lone surrogate travels as an escape instead of failing to encode
            data = json.dumps(present, ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode("ascii")
        except (TypeError, ValueError, RecursionError) as error:
            raise invalid(f"The input of {op} cannot be written as JSON: {error}", op) from None
        headers["Content-Type"] = "application/json"
    binary = spec["binary"]
    if binary is not None and body is not None:
        data = body
        headers["Content-Type"] = binary["contentType"]
    return PreparedRequest(url=f"{settings.origin.root}{path}{f'?{query}' if query else ''}", method=spec["method"], headers=headers, body=data)


def check_bytes(spec: OperationSpec, body: Any) -> Optional[bytes]:
    """The bytes of a call: required by an operation that sends bytes, at most its maxBytes, and refused by any
    other operation."""
    binary = spec["binary"]
    if binary is None:
        if body is not None:
            raise invalid(f"{spec['id']} sends no bytes.", spec["id"])
        return None
    if not isinstance(body, (bytes, bytearray, memoryview)):
        raise invalid(f"{spec['id']} sends bytes: pass bytes, a bytearray or a memoryview.", spec["id"])
    data = bytes(body)
    if len(data) > binary["maxBytes"]:
        raise invalid(f"{spec['id']} sends at most {binary['maxBytes']} bytes.", spec["id"])
    return data


# ------------------------------------------------------------------------------------------------- answers


def _whole_header(raw: Optional[str]) -> Optional[int]:
    if raw is None:
        return None
    value = raw.strip()
    return int(value) if _WHOLE.fullmatch(value) else None


def answer_of(response: WireResponse) -> Answer:
    replayed = response.headers.get(_HEADER["replayed"].lower())
    return Answer(
        status=response.status,
        retry_after=response.headers.get(_HEADER["retryAfter"].lower()),
        request_id=response.headers.get(_HEADER["requestId"].lower()),
        replayed=replayed is not None and replayed.strip().lower() == "true",
        rate_limit=RateLimit(
            limit=_whole_header(response.headers.get(_HEADER["rateLimitLimit"].lower())),
            remaining=_whole_header(response.headers.get(_HEADER["rateLimitRemaining"].lower())),
            reset_sec=_whole_header(response.headers.get(_HEADER["rateLimitReset"].lower())),
        ),
    )


def _no_constant(name: str) -> NoReturn:
    raise ValueError(f"{name} is not JSON")


def parse_json(body: bytes) -> Tuple[bool, Any]:
    """The body read as UTF-8 JSON, as fetch reads it: a leading byte order mark dropped, NaN and Infinity refused."""
    text = body.decode("utf-8", errors="replace")
    if text.startswith("﻿"):
        text = text[1:]
    if not text:
        return (False, None)
    try:
        return (True, json.loads(text, parse_constant=_no_constant))
    except (ValueError, RecursionError):
        return (False, None)


def classify_answer(answer: Answer, body: bytes) -> Outcome:
    """What an answer whose body was read means: a 2xx with a JSON body is a success; a JSON body with error.code
    is an API error; anything else is BAD_RESPONSE, and its body is never repeated."""
    status = answer.status
    ok, value = parse_json(body)
    if 200 <= status < 300:
        return Success(status=status, body=value, answer=answer) if ok else NetworkFailure("BAD_RESPONSE", status, MESSAGES["not_json"], answer)
    if not ok:
        return NetworkFailure("BAD_RESPONSE", status, MESSAGES["not_json"], answer)
    error = value.get("error") if isinstance(value, dict) else None
    code = error.get("code") if isinstance(error, dict) else None
    if not isinstance(error, dict) or not isinstance(code, str) or not _ERROR_CODE.fullmatch(code):
        return NetworkFailure("BAD_RESPONSE", status, MESSAGES["not_api_error"], answer)
    message = error.get("message")
    hint = error.get("hint")
    request_id = error.get("requestId")
    return ApiFailure(
        code=code,
        status=status,
        message=message if isinstance(message, str) and message else MESSAGES["no_server_message"],
        hint=hint if isinstance(hint, str) and hint else None,
        details=error.get("details"),
        request_id=request_id if isinstance(request_id, str) and request_id else answer.request_id,
        answer=answer,
    )


# ----------------------------------------------------------------------------------------------- the table


class OperationIndex:
    """The operation table, indexed for the engine: by id and, for each kind of work that finishes later, the
    read that follows it with ?wait=. A table that breaks what the engine relies on is refused when the package
    loads, never discovered at the first wait."""

    def __init__(self, rows: Iterable[OperationSpec]) -> None:
        self._by_id: Dict[str, OperationSpec] = {}
        self._reads: Dict[str, OperationSpec] = {}
        for row in rows:
            if row["id"] in self._by_id:
                raise ValueError(f"The operation table has two rows for {row['id']}.")
            self._by_id[row["id"]] = row
        for row in self._by_id.values():
            work = row["async"]
            if work is None:
                continue
            read = self._by_id.get(work["waitWith"])
            if read is None or read["method"] != "GET" or len(read["pathParams"]) != 1 or not read["inQuery"]:
                raise ValueError(f"The operation table follows {work['handle']} with {work['waitWith']}, which is not a GET of one id.")
            known = self._reads.get(work["handle"])
            if known is not None and known is not read:
                raise ValueError(f"The operation table follows {work['handle']} with two reads.")
            self._reads[work["handle"]] = read

    def by_id(self, id: str) -> Optional[OperationSpec]:
        return self._by_id.get(id)

    def read_for(self, handle: str) -> Optional[OperationSpec]:
        """The read that follows a kind of work: job, get_job."""
        return self._reads.get(handle)

    @property
    def handles(self) -> List[str]:
        """The kinds of work that finish later, in the order of the table: job, export, toolRun, turn."""
        return list(self._reads)

    @property
    def list_ids(self) -> List[str]:
        """The ids of the lists, in the order of the table."""
        return [row["id"] for row in self._by_id.values() if row["paginated"]]

    def operation(self, id: str) -> OperationSpec:
        """An operation the engine composes calls from (upload_file), which the table must have."""
        row = self._by_id.get(id)
        if row is None:
            raise ValueError(f"The operation table has no {id}.")
        return row


# ----------------------------------------------------------------------------------------------- transport


@dataclass(frozen=True)
class CallOptions:
    idempotency_key: Optional[str]
    cancel: Optional[Cancel]
    max_retries: int
    timeout: float
    deadline: float


@dataclass(frozen=True)
class SendHooks:
    """What a module of this package passes to send beyond the caller's options: on_failure is told of every
    failed attempt, explain gives a sentence of this SDK to add after the message of the error a call stops with."""

    on_failure: Optional[Callable[[Failure], Any]] = None
    explain: Optional[Callable[[Failure], Optional[str]]] = None


class Transport:
    """Sends calls for one client. The key lives in a Secret, and leaves it only in the Authorization header of a
    request to the base URL."""

    __slots__ = ("_settings", "_retryable", "_wire", "_clock")

    def __init__(self, settings: Settings, retryable: Set[str], *, wire: Optional[Wire] = None, clock: Optional[Clock] = None) -> None:
        self._settings = settings
        self._retryable = retryable
        self._wire: Wire = wire if wire is not None else UrllibWire(use_proxies=settings.origin.use_proxies)
        self._clock = clock if clock is not None else Clock()

    @property
    def base_url(self) -> str:
        """The base URL with /v1, as the documentation writes it."""
        return self._settings.origin.base_url

    @property
    def defaults(self) -> Tuple[int, float, float]:
        """max_retries, timeout and deadline of a call, for the modules that send calls of their own."""
        return (self._settings.max_retries, self._settings.timeout, self._settings.deadline)

    @property
    def user_agent(self) -> str:
        return self._settings.user_agent

    @property
    def clock(self) -> Clock:
        return self._clock

    @property
    def wire(self) -> Wire:
        return self._wire

    def scrub(self, text: str) -> str:
        """The key, and anything shaped like a key, taken out of a text that came from outside."""
        return scrub_text(text, self._settings.api_key.reveal())

    def scrub_value(self, value: Any) -> Any:
        """The key taken out of a parsed JSON value that came from outside, into a copy."""
        return scrub_value(value, self._settings.api_key.reveal())

    def report_retry(self, event: RetryEvent) -> None:
        """Tells the caller's on_retry of a pause taken outside send (a download)."""
        call_hook(self._settings.on_retry, event)

    def call_options(self, spec: OperationSpec, options: Optional[Mapping[str, Any]]) -> CallOptions:
        """The options of one call, checked; None is the client's default."""
        if options is not None and not isinstance(options, Mapping):
            raise invalid(f"The options of {spec['id']} must be a dict.", spec["id"])
        o = dict(options or {})
        for name in o:
            if name not in CALL_OPTIONS:
                raise invalid(f"{spec['id']} has no option {name}. Its options are: {', '.join(CALL_OPTIONS)}.", spec["id"])
        key = o.get("idempotency_key")
        if key is not None:
            if spec["idempotencyKey"] == "none":
                raise invalid(f"{spec['id']} takes no idempotency_key: the API does not read one for it.", spec["id"])
            if not is_idempotency_key(key):
                raise invalid(MESSAGES["bad_idempotency_key"], spec["id"])
        max_retries, timeout, deadline = self.defaults
        return CallOptions(
            idempotency_key=key,
            cancel=check_cancel(o.get("cancel"), spec["id"]),
            max_retries=max_retries if o.get("max_retries") is None else check_count("max_retries", o["max_retries"], spec["id"]),
            timeout=timeout if o.get("timeout") is None else check_duration("timeout", o["timeout"], spec["id"]),
            deadline=deadline if o.get("deadline") is None else check_duration("deadline", o["deadline"], spec["id"]),
        )

    def send(self, spec: OperationSpec, fields: Optional[Mapping[str, Any]], options: Optional[Mapping[str, Any]] = None, body: Any = None, hooks: Optional[SendHooks] = None) -> Any:
        """One call: the options checked, the request built, the key made, then attempts until one succeeds or the
        rules stop the call. Returns the body of the answer, as it is; raises a GptVideoError."""
        call = self.call_options(spec, options)
        data = check_bytes(spec, body)
        # the caller's key was checked with the options; the key of the call is made once, here, before any attempt
        key = None if spec["idempotencyKey"] == "none" else (call.idempotency_key or new_idempotency_key())
        request = build_request(self._settings, spec, fields, data, key)
        hooks = hooks or SendHooks()
        clock = self._clock

        # whether an attempt of this call has left the charge of a spend unknown: once it has, a later refusal that
        # the API gives before looking at the key (RATE_LIMITED) cannot make it known again
        unknown = False

        def stop(outcome: Failure, sent: bool, ra: Optional[int], retryable: bool) -> GptVideoError:
            extra: Optional[str] = None
            if hooks.explain is not None:
                try:
                    extra = hooks.explain(outcome)
                except Exception:
                    extra = None
            return self._error_of(spec, outcome, key, sent, ra, retryable, extra, unknown)

        aborted = NetworkFailure("ABORTED", None, MESSAGES["aborted"], None)
        if call.cancel is not None and call.cancel.is_set():
            raise stop(aborted, False, None, False)

        deadline_at = clock.monotonic() + call.deadline
        failures = 0
        last: Optional[Tuple[Failure, Optional[int], bool]] = None
        attempt = 0
        while True:
            attempt += 1
            left = deadline_at - clock.monotonic()
            # a pause can end late on a busy machine: past the deadline, no attempt starts
            if left <= 0 and last is not None:
                raise stop(last[0], True, last[1], last[2])
            outcome = self._attempt(request, min(call.timeout, left), call.cancel)
            answer = outcome.answer
            if answer is not None:
                self._report_answer(spec, answer, attempt)
            if isinstance(outcome, Success):
                return outcome.body
            call_hook(hooks.on_failure, outcome)

            ra = retry_after_sec(answer.retry_after, clock.time()) if answer is not None else None
            retry, consumes = policy_of(outcome, spec, self._retryable)
            unknown = unknown or may_have_spent(outcome, spec, True, unknown)
            last = (outcome, ra, retry)
            if not retry:
                raise stop(outcome, True, ra, retry)
            if consumes:
                failures += 1
                if failures > call.max_retries:
                    raise stop(outcome, True, ra, retry)
            if ra is not None:
                if ra > RETRY_AFTER_MAX_SEC:
                    raise stop(outcome, True, ra, retry)
                delay = float(ra)
            else:
                delay = backoff_ms(attempt, clock.rand) / 1000
            if clock.monotonic() + delay >= deadline_at:
                raise stop(outcome, True, ra, retry)
            call_hook(self._settings.on_retry, RetryEvent(operation=spec["id"], attempt=attempt, code=outcome.code, delay=delay))
            if not clock.sleep(delay, call.cancel):
                raise stop(aborted, True, None, False)

    def _attempt(self, request: PreparedRequest, timeout: float, cancel: Optional[Cancel]) -> Outcome:
        """One attempt: the request, then the whole answer, within timeout. An answer that arrives at or after
        that moment is a TIMEOUT."""
        clock = self._clock
        started = clock.monotonic()
        deadline = Deadline(started + timeout, cancel, clock.monotonic)
        headers = dict(request.headers)
        headers["Authorization"] = f"Bearer {self._settings.api_key.reveal()}"
        result = self._wire.send(WireRequest(method=request.method, url=request.url, headers=headers, body=request.body), deadline)
        del headers
        if isinstance(result, WireFailure):
            if result.kind == "aborted":
                return NetworkFailure("ABORTED", None, MESSAGES["aborted"], None)
            if result.kind == "timeout":
                return NetworkFailure("TIMEOUT", None, TEXTS.timeout(timeout), None)
            text = TEXTS.connection_failed(result.detail) if result.detail else MESSAGES["connection_failed"]
            return NetworkFailure("CONNECTION_FAILED", None, f"{text} {MESSAGES['python_tls']}" if result.tls else text, None)
        if clock.monotonic() - started >= timeout:
            return NetworkFailure("TIMEOUT", None, TEXTS.timeout(timeout), None)
        answer = answer_of(result)
        # a redirect is never followed: the wire hands it over as it came, and nothing of it is read
        if 300 <= result.status < 400:
            return NetworkFailure("BAD_RESPONSE", result.status, MESSAGES["redirect"], answer)
        return classify_answer(answer, result.body)

    def _report_answer(self, spec: OperationSpec, answer: Answer, attempt: int) -> None:
        if self._settings.on_response is None:
            return
        call_hook(
            self._settings.on_response,
            ResponseEvent(
                operation=spec["id"],
                status=answer.status,
                request_id=None if answer.request_id is None else self.scrub(answer.request_id),
                attempt=attempt,
                replayed=answer.replayed,
                rate_limit=answer.rate_limit,
            ),
        )

    def _error_of(
        self,
        spec: OperationSpec,
        outcome: Failure,
        key: Optional[str],
        sent: bool,
        ra: Optional[int],
        retryable: bool,
        extra: Optional[str],
        unknown_before: bool,
    ) -> GptVideoError:
        """The error a call stops with: its last outcome, with the key of the call and what the rules say about
        it. Every text that came from the server is scrubbed of the key first."""
        spent = may_have_spent(outcome, spec, sent, unknown_before)
        if isinstance(outcome, ApiFailure):
            message = self.scrub(outcome.message)
            hint = None if outcome.hint is None else self.scrub(outcome.hint)
            request_id = None if outcome.request_id is None else self.scrub(outcome.request_id)
            return GptVideoApiError(
                format_error_message(outcome.code, message, status=outcome.status, hint=hint, request_id=request_id, may_have_spent=spent, note=extra),
                code=outcome.code,
                status=outcome.status,
                request_id=request_id,
                hint=hint,
                details=self.scrub_value(outcome.details),
                retry_after_sec=ra,
                retryable=retryable,
                operation=spec["id"],
                idempotency_key=key,
                may_have_spent=spent,
            )
        return GptVideoNetworkError(
            format_error_message(outcome.code, outcome.text, status=outcome.status, may_have_spent=spent, note=extra),
            code=outcome.code,
            status=outcome.status,
            retry_after_sec=ra,
            retryable=retryable,
            operation=spec["id"],
            idempotency_key=key,
            may_have_spent=spent,
        )

    def __repr__(self) -> str:
        return f"Transport(base_url={self.base_url!r}, api_key={REDACTED!r})"

    def __reduce__(self) -> NoReturn:
        raise TypeError("A GPT-Video transport cannot be pickled or copied: it holds the API key.")
