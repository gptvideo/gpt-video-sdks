"""Waiting for work that finishes later: a job, an export, a tool run, an Editor Assistant turn.

The read that follows each kind comes from the table (async.waitWith), and is sent again with ?wait=25 until the
work is final: its status is done, failed or cancelled, or it has a finishedAt, which also ends a status this SDK
does not know yet. Work that failed or was cancelled raises GptVideoJobError unless the caller says otherwise; a
failed analysis never looks like an empty list of clips.

The API holds at most a few waits per account at once and answers the others at once. A read that comes back early
without a final status is followed by a pause of 3 to 5 seconds, and a client holds at most WAITS_PER_CLIENT reads
open, leaving room for the other clients of the same account.
"""

import math
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, Mapping, Optional, Tuple

from ._generated import CONVENTIONS
from ._http import CANCEL_POLL, Cancel
from ._table import OperationSpec
from ._transport import OperationIndex, Transport, call_hook, check_cancel, check_duration, invalid
from .errors import MESSAGES, TEXTS, GptVideoJobError, GptVideoNetworkError, format_error_message

FINAL_STATUSES: Tuple[str, ...] = tuple(CONVENTIONS["finalStatuses"])
"""The statuses that end a piece of work, as the API lists them."""

WAIT_READ_SEC: int = CONVENTIONS["waitMaxSec"]
"""The longest ?wait= the API holds a read for, in seconds."""

WAIT_TIMEOUT = 3600.0
"""How long a wait lasts when the caller does not say, in seconds: an analysis can take many minutes."""

WAITS_PER_CLIENT = 4
"""How many reads with ?wait= one client holds open at once."""

EARLY_ANSWER_PAUSE = (3.0, 2.0)
"""The pause after a read that came back early without a final status: 3 seconds and up to 2 more."""

READ_GRACE = 10.0
"""The time a read of a wait has for the network, in seconds: beyond the seconds the API holds the read, for one
attempt, and beyond the end of the wait, for the last read."""

WAIT_OPTIONS: Tuple[str, ...] = ("timeout", "on_progress", "throw_on_failure", "cancel")


class WaitSlots:
    """The reads a client holds open with ?wait=, first come first served."""

    def __init__(self, size: int) -> None:
        self._semaphore = threading.BoundedSemaphore(size)

    def acquire(self, seconds: float, cancel: Optional[Cancel]) -> bool:
        """A slot within seconds, or False when the time passes or the cancel event is set first."""
        end = time.monotonic() + seconds
        while True:
            if cancel is not None and cancel.is_set():
                return False
            left = end - time.monotonic()
            if left <= 0:
                return False
            if self._semaphore.acquire(timeout=min(left, CANCEL_POLL) if cancel is not None else left):
                return True

    def release(self) -> None:
        self._semaphore.release()


@dataclass(frozen=True)
class WaitContext:
    """What the wait functions need from the client."""

    transport: Transport
    index: OperationIndex
    slots: WaitSlots


@dataclass(frozen=True)
class _Options:
    timeout: float
    on_progress: Optional[Callable[[Any], Any]]
    throw_on_failure: bool
    cancel: Optional[Cancel]


def read_times(defaults: Tuple[int, float, float], wait_sec: int, left: float) -> Tuple[float, float]:
    """The timeout and the deadline of one read of a wait. An attempt always outlasts the seconds the API may hold
    the read, even when the client has a short timeout or deadline for its other calls; the retries of the read end
    at most READ_GRACE after the wait itself."""
    _, timeout, deadline = defaults
    read_timeout = max(timeout, wait_sec + READ_GRACE)
    read_deadline = min(max(deadline, read_timeout), max(0.001, left) + READ_GRACE)
    return (read_timeout, read_deadline)


def is_final(current: Mapping[str, Any]) -> bool:
    """Whether a piece of work is over: a final status, or a finishedAt the API set."""
    return current.get("status") in FINAL_STATUSES or current.get("finishedAt") is not None


def _check_options(options: Optional[Mapping[str, Any]], where: str) -> _Options:
    o = dict(options or {})
    for name in o:
        if name not in WAIT_OPTIONS:
            raise invalid(f"{where} has no option {name}. Its options are: {', '.join(WAIT_OPTIONS)}.")
    on_progress = o.get("on_progress")
    if on_progress is not None and not callable(on_progress):
        raise invalid("on_progress must be a function.")
    throw = o.get("throw_on_failure", True)
    if not isinstance(throw, bool):
        raise invalid("throw_on_failure must be True or False.")
    return _Options(
        timeout=WAIT_TIMEOUT if o.get("timeout") is None else check_duration("timeout", o["timeout"]),
        on_progress=on_progress,
        throw_on_failure=throw,
        cancel=check_cancel(o.get("cancel")),
    )


def wait_on(ctx: WaitContext, result: Any, options: Optional[Mapping[str, Any]] = None) -> Any:
    """wait(result): the answer of a call that starts work, {job}, {export}, {toolRun} or {turn}, followed until the
    work is over. Returns the object as the last read gave it."""
    o = _check_options(options, "wait")
    handles = ctx.index.handles
    found = [handle for handle in handles if isinstance(result.get(handle), Mapping)] if isinstance(result, Mapping) else []
    if len(found) != 1:
        raise invalid(f"wait takes the answer of a call that starts work: a dict with one of {', '.join(handles)}.")
    handle = found[0]
    current = result[handle]
    id = current.get("id")
    if not isinstance(id, str) or not id:
        raise invalid(f"{handle}.id must be a non-empty string.")
    return _follow(ctx, handle, id, o)


def wait_for_handle(ctx: WaitContext, handle: str, target: Any, options: Optional[Mapping[str, Any]], where: str) -> Any:
    """The long forms, wait_for_job(job_or_id) and its siblings: an id, the object ({id}), or the answer that
    carries it ({job})."""
    o = _check_options(options, where)
    id: Any = target
    if isinstance(target, Mapping):
        inner = target.get(handle)
        id = inner.get("id") if isinstance(inner, Mapping) else target.get("id")
    if not isinstance(id, str) or not id:
        raise invalid(f"{where} takes an id, the {handle} object, or the answer that carries it.")
    return _follow(ctx, handle, id, o)


def _follow(ctx: WaitContext, handle: str, id: str, o: _Options) -> Any:
    """The loop. The wait ends at its own time or on the caller's cancel event; a read already sent ends on its
    own terms, within a deadline that outlasts the wait by READ_GRACE at most."""
    read = ctx.index.read_for(handle)
    if read is None:
        raise invalid(f"There is no way to follow {handle} in this version of the SDK.")
    param = read["pathParams"][0]
    clock = ctx.transport.clock
    end_at = clock.monotonic() + o.timeout
    last: Optional[Dict[str, Any]] = None

    def ended() -> Exception:
        if o.cancel is not None and o.cancel.is_set():
            return _aborted(read)
        return _timed_out(ctx, read, id, last, o.timeout)

    while True:
        left = end_at - clock.monotonic()
        if left <= 0:
            raise ended()
        if not ctx.slots.acquire(left, o.cancel):
            raise ended()
        started = clock.monotonic()
        wait_sec = max(0, min(WAIT_READ_SEC, math.floor(end_at - started)))
        try:
            timeout, deadline = read_times(ctx.transport.defaults, wait_sec, end_at - started)
            body = ctx.transport.send(read, {param: id, "wait": wait_sec}, {"timeout": timeout, "deadline": deadline, "cancel": o.cancel})
        finally:
            ctx.slots.release()
        current = _object_in(body, handle, read)
        last = current
        call_hook(o.on_progress, current)
        if is_final(current):
            return _settle(ctx, current, read, o.throw_on_failure)
        # an answer before the wait it asked for was not held: the account's waits are full, so pause
        if wait_sec == 0 or clock.monotonic() - started < wait_sec:
            pause = EARLY_ANSWER_PAUSE[0] + int(clock.rand() * EARLY_ANSWER_PAUSE[1] * 1000) / 1000
            left = end_at - clock.monotonic()
            if pause >= left:
                clock.sleep(max(0.0, left), o.cancel)
                raise ended()
            if not clock.sleep(pause, o.cancel):
                raise ended()


def _object_in(body: Any, handle: str, read: OperationSpec) -> Dict[str, Any]:
    """The object a read carries, or BAD_RESPONSE when it carries none."""
    current = body.get(handle) if isinstance(body, dict) else None
    if isinstance(current, dict) and isinstance(current.get("status"), str):
        return current
    raise GptVideoNetworkError(format_error_message("BAD_RESPONSE", TEXTS.missing_handle(handle)), code="BAD_RESPONSE", operation=read["id"])


def _settle(ctx: WaitContext, current: Dict[str, Any], read: OperationSpec, throw_on_failure: bool) -> Dict[str, Any]:
    """The end of a wait on a final object: failed and cancelled raise unless the caller asked for the object."""
    status = current.get("status")
    code = "JOB_FAILED" if status == "failed" else "JOB_CANCELLED" if status == "cancelled" else None
    if code is None or not throw_on_failure:
        return current
    id = ctx.transport.scrub(str(current.get("id")))
    said_raw = current.get("errorMessage")
    said = ctx.transport.scrub(said_raw) if isinstance(said_raw, str) and said_raw else None
    text = TEXTS.job_failed(id) if code == "JOB_FAILED" else TEXTS.job_cancelled(id)
    raise GptVideoJobError(
        format_error_message(code, f"{text} {said}" if said else text),
        code=code,
        handle=ctx.transport.scrub_value(current),
        error_message=said,
        operation=read["id"],
    )


def _aborted(read: OperationSpec) -> GptVideoNetworkError:
    return GptVideoNetworkError(format_error_message("ABORTED", MESSAGES["aborted"]), code="ABORTED", operation=read["id"])


def _timed_out(ctx: WaitContext, read: OperationSpec, id: str, last: Optional[Dict[str, Any]], seconds: float) -> GptVideoJobError:
    status_raw = last.get("status") if last is not None else None
    status = ctx.transport.scrub(status_raw)[:64] if isinstance(status_raw, str) else None
    said_raw = last.get("errorMessage") if last is not None else None
    said = ctx.transport.scrub(said_raw) if isinstance(said_raw, str) and said_raw else None
    return GptVideoJobError(
        format_error_message("WAIT_TIMEOUT", TEXTS.wait_timeout(ctx.transport.scrub(id), status, seconds)),
        code="WAIT_TIMEOUT",
        handle=None if last is None else ctx.transport.scrub_value(last),
        error_message=said,
        # waiting again can still see the work end
        retryable=True,
        operation=read["id"],
    )
