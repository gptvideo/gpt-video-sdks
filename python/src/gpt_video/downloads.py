"""Downloading the file behind a signed link: the downloadUrl of an export or of a tool run.

The link is its own credential, so the request never carries the API key. That is a rule of this function, not of
the address: it holds even when the link points at the host of the API. Only https:// links are opened, and http://
to this machine for development. A redirect is followed only to an address of the same kind, checked before it is
opened, and never carries a key either.

Failures before the body starts are retried like a read of the API: a connection that failed, an attempt that
timed out, a 5xx or a 429, with Retry-After or a backoff. Once the body starts, each read waits at most timeout, and
a failure ends the download: a path given as the destination is left as it was, a file object keeps what it got.
"""

import os
import re
import tempfile
import urllib.parse
from dataclasses import dataclass
from typing import Any, Callable, Optional, Tuple, Union

from ._http import Cancel, Deadline, Idle, LiveResponse, Wire, WireRequest, failure_of
from ._retry import RETRY_AFTER_MAX_SEC, backoff_ms, retry_after_sec
from ._transport import RetryEvent, Transport, check_cancel, check_count, check_duration, invalid, is_safe_address, is_this_machine
from .errors import MESSAGES, TEXTS, GptVideoNetworkError, format_error_message

DOWNLOAD = "download"
"""The name a download goes by in on_retry and in its errors, where an API call has its operation id."""

REFUSED = frozenset({401, 403, 404, 410})
"""The statuses that mean the link itself was refused: expired, wrong, or for another file."""

REDIRECTS = frozenset({301, 302, 303, 307, 308})

MAX_REDIRECTS = 10
"""The most redirects one attempt follows."""

BLOCK = 1 << 20
"""The bytes read from the body at once."""


@dataclass(frozen=True)
class DownloadContext:
    transport: Transport
    wire_for: Callable[[bool], Wire]
    """The wire for an address: with the proxies of the environment, or without them for this machine."""


@dataclass(frozen=True)
class _Failure:
    code: str
    status: Optional[int]
    text: str
    retry: bool
    retry_after: Optional[str] = None


def _error(failure: _Failure, ra: Optional[int]) -> GptVideoNetworkError:
    return GptVideoNetworkError(
        format_error_message(failure.code, failure.text, status=failure.status),
        code=failure.code,
        status=failure.status,
        retry_after_sec=ra if failure.code == "BAD_RESPONSE" else None,
        retryable=failure.retry,
        operation=DOWNLOAD,
    )


_VISIBLE = re.compile(r"[\x21-\x7E]+")


def _parts(url: str) -> Optional[urllib.parse.SplitResult]:
    """The parts of an absolute http:// or https:// link written in visible ASCII, or None."""
    if not _VISIBLE.fullmatch(url):
        return None
    try:
        parts = urllib.parse.urlsplit(url)
        hostname = parts.hostname
        parts.port
    except ValueError:
        return None
    return parts if parts.scheme in ("http", "https") and hostname else None


def _safe(url: str) -> Optional[urllib.parse.SplitResult]:
    """The parts of a link that may be opened: https://, or http:// to this machine, with no user or password."""
    parts = _parts(url)
    if parts is None or not is_safe_address(parts.scheme, parts.hostname or "") or parts.username is not None or parts.password is not None:
        return None
    return parts


def _lost(failure: Any, timeout: float) -> _Failure:
    if failure.kind == "aborted":
        return _Failure("ABORTED", None, MESSAGES["aborted"], False)
    if failure.kind == "timeout":
        return _Failure("TIMEOUT", None, TEXTS.timeout(timeout), True)
    text = f"{MESSAGES['connection_failed']} {MESSAGES['python_tls']}" if failure.tls else MESSAGES["connection_failed"]
    return _Failure("CONNECTION_FAILED", None, text, True)


def _attempt(ctx: DownloadContext, url: str, headers: dict, timeout: float, cancel: Optional[Cancel]) -> Union[LiveResponse, _Failure]:
    """One attempt, until the headers arrive, through the redirects. A response handed back keeps its body unread."""
    clock = ctx.transport.clock
    started = clock.monotonic()
    deadline = Deadline(started + timeout, cancel, clock.monotonic)
    current = url
    for _ in range(MAX_REDIRECTS + 1):
        parts = _safe(current)
        if parts is None:
            return _Failure("BAD_RESPONSE", None, MESSAGES["download_insecure"], False)
        # a proxy cannot reach this machine, and would see the request
        wire = ctx.wire_for(not is_this_machine(parts.hostname or ""))
        try:
            live = wire.open(WireRequest(method="GET", url=current, headers=headers), deadline)
        except Exception as error:
            return _lost(failure_of(error, deadline), timeout)
        if clock.monotonic() - started >= timeout:
            live.close()
            return _Failure("TIMEOUT", None, TEXTS.timeout(timeout), True)
        status = live.status
        if status in REDIRECTS:
            location = live.headers.get("location")
            live.close()
            if not location:
                return _Failure("BAD_RESPONSE", status, MESSAGES["download_failed"], False)
            current = urllib.parse.urljoin(current, location)
            if _safe(current) is None:
                return _Failure("BAD_RESPONSE", status, MESSAGES["download_insecure"], False)
            continue
        if 200 <= status < 300:
            return live
        retry_after = live.headers.get("retry-after")
        live.close()
        text = MESSAGES["download_refused"] if status in REFUSED else MESSAGES["download_failed"]
        return _Failure("BAD_RESPONSE", status, text, status >= 500 or status == 429, retry_after)
    return _Failure("BAD_RESPONSE", None, MESSAGES["download_failed"], False)


def download(
    ctx: DownloadContext,
    url: Any,
    destination: Any,
    *,
    timeout: Optional[float] = None,
    deadline: Optional[float] = None,
    max_retries: Optional[int] = None,
    cancel: Optional[Cancel] = None,
) -> int:
    """download(url, destination): the bytes behind the link written to destination, a path or a binary file
    object. Returns how many bytes were written."""
    if not isinstance(url, str):
        raise invalid("download takes a link, such as the downloadUrl of an export.")
    parts = _parts(url)
    if parts is None:
        raise invalid("download takes an absolute link, such as the downloadUrl of an export.")
    if not is_safe_address(parts.scheme, parts.hostname or ""):
        raise invalid("download takes an https:// link. http:// is accepted only for an address on this machine.")
    if parts.username is not None or parts.password is not None:
        raise invalid("A download link must not hold a user name or a password.")
    if isinstance(destination, (str, os.PathLike)):
        path: Optional[str] = os.fspath(destination)
        writer: Any = None
    elif callable(getattr(destination, "write", None)):
        path, writer = None, destination
    else:
        raise invalid('download takes a destination: the path of a file to write, or a file opened in binary mode, such as open(path, "wb").')
    max_default, timeout_default, deadline_default = ctx.transport.defaults
    tries = max_default if max_retries is None else check_count("max_retries", max_retries)
    attempt_timeout = timeout_default if timeout is None else check_duration("timeout", timeout)
    total = deadline_default if deadline is None else check_duration("deadline", deadline)
    cancel = check_cancel(cancel)

    # no Authorization, ever: the signed link is the credential
    headers = {"User-Agent": ctx.transport.user_agent}
    aborted = _Failure("ABORTED", None, MESSAGES["aborted"], False)
    if cancel is not None and cancel.is_set():
        raise _error(aborted, None)
    clock = ctx.transport.clock
    deadline_at = clock.monotonic() + total
    failures = 0
    last: Optional[Tuple[_Failure, Optional[int]]] = None
    attempt = 0
    while True:
        attempt += 1
        left = deadline_at - clock.monotonic()
        if left <= 0 and last is not None:
            raise _error(*last)
        result = _attempt(ctx, url, headers, min(attempt_timeout, left), cancel)
        if not isinstance(result, _Failure):
            return _write(result, path, writer, attempt_timeout, cancel)
        ra = retry_after_sec(result.retry_after, clock.time())
        last = (result, ra)
        failures += 1
        if not result.retry or failures > tries:
            raise _error(result, ra)
        if ra is not None:
            if ra > RETRY_AFTER_MAX_SEC:
                raise _error(result, ra)
            delay = float(ra)
        else:
            delay = backoff_ms(attempt, clock.rand) / 1000
        if clock.monotonic() + delay >= deadline_at:
            raise _error(result, ra)
        ctx.transport.report_retry(RetryEvent(operation=DOWNLOAD, attempt=attempt, code=result.code, delay=delay))
        if not clock.sleep(delay, cancel):
            raise _error(aborted, None)


def _write(live: LiveResponse, path: Optional[str], writer: Any, timeout: float, cancel: Optional[Cancel]) -> int:
    """The body, read a block at a time, each read within timeout, into the destination."""
    temp: Any = None
    written = 0
    try:
        live.idle(timeout, cancel)
        if path is not None:
            folder = os.path.dirname(os.path.abspath(path))
            temp = tempfile.NamedTemporaryFile(mode="wb", dir=folder, prefix=".gpt-video-", suffix=".part", delete=False)
            writer = temp
        while True:
            try:
                block = live.read(BLOCK)
            except Exception as error:
                lost = _lost(failure_of(error, Idle(timeout, cancel)), timeout)
                raise _error(lost, None) from None
            if not block:
                break
            writer.write(block)
            written += len(block)
        if temp is not None:
            temp.close()
            os.replace(temp.name, path)  # type: ignore[arg-type]
            temp = None
        return written
    finally:
        live.close()
        if temp is not None:
            temp.close()
            try:
                os.remove(temp.name)
            except OSError:
                pass
