"""Uploading a file: create_upload says how many parts to send and how big each one is, the parts go out in
parallel with upload_part, and complete_upload turns the file into an asset. The part size is the one the API
answers, never a number of this SDK.

What holds on every path:

- a part is read when it is about to be sent, so the file is never held in memory whole: at most one part per part
  in flight. Every read happens in the thread that called upload_file, so a file object is never read by two
  threads;
- each part has a timeout that grows with its size, from 60 seconds at 100 KB a second up to 10 minutes, and is
  retried on its own: sending a part again replaces it. A slow part never restarts the others; after a part times
  out, the next parts go one at a time, because parallel parts share the line;
- a complete refused with CONFLICT reads the upload again, sends the parts it lacks once more and asks again with
  the same Idempotency-Key, once;
- an upload that fails after it was opened is cancelled in the background, so it does not count against the open
  uploads and the storage of the account until it expires.
"""

import abc
import concurrent.futures
import io
import math
import os
import threading
from collections import deque
from dataclasses import dataclass
from typing import Any, Callable, Deque, Dict, List, Optional, Set, Tuple, Union

from ._http import CANCEL_POLL, Cancel
from ._retry import RETRY_AFTER_MAX_SEC, SWITCHED_OFF, Failure, new_idempotency_key
from ._table import OperationSpec
from ._transport import MAX_DURATION, OperationIndex, SendHooks, Transport, call_hook, check_cancel, invalid
from .errors import MESSAGES, TEXTS, GptVideoApiError, GptVideoNetworkError, format_error_message

UPLOAD_CONCURRENCY = 4
"""Parts in flight at once, unless the caller says otherwise."""

UPLOAD_CONCURRENCY_MAX = 16
"""The most parts in flight a caller may ask for."""

PART_TIMEOUT_MIN = 60.0
"""The seconds a part has, whatever its size."""

PART_TIMEOUT_MAX = 600.0
"""The most seconds a part has."""

PART_SLOWEST_BYTES_PER_SEC = 100_000
"""The slowest line a part is given time for: 100 KB a second."""

CANCEL_DEADLINE = 15.0
"""How long the cancel of a failed upload may take, in the background, in seconds."""


@dataclass(frozen=True)
class UploadProgress:
    """What on_progress receives after every part the API received."""

    uploaded_bytes: int
    total_bytes: int


def part_timeout(size: int) -> float:
    """The timeout of a part: its size at the slowest line, between one and ten minutes."""
    ms = math.ceil(size * 1000 / PART_SLOWEST_BYTES_PER_SEC)
    return min(PART_TIMEOUT_MAX, max(PART_TIMEOUT_MIN, ms / 1000))


def part_deadline(timeout: float, max_retries: int) -> float:
    """The deadline of a part: every attempt with its whole timeout, and every pause with the longest Retry-After
    the SDK waits. It never cuts a run of retries the rules allow, and it ends."""
    return min(MAX_DURATION, (max_retries + 1) * timeout + max_retries * RETRY_AFTER_MAX_SEC)


class _Linked:
    """Set when either event is set: the caller's cancel, or the stop of the upload."""

    def __init__(self, first: Optional[Cancel], second: threading.Event) -> None:
        self._first = first
        self._second = second

    def is_set(self) -> bool:
        return self._second.is_set() or (self._first is not None and self._first.is_set())

    def wait(self, timeout: Optional[float] = None) -> bool:
        if self._first is None:
            return self._second.wait(timeout)
        remaining = timeout
        while not self.is_set():
            step = CANCEL_POLL if remaining is None else min(CANCEL_POLL, remaining)
            if step <= 0:
                return self.is_set()
            self._second.wait(step)
            if remaining is not None:
                remaining -= step
        return True


# ---------------------------------------------------------------------------------------------------- sources


class _Source(abc.ABC):
    """What upload_file reads parts from."""

    size: int = 0
    rereadable: bool = True
    name: Optional[str] = None

    @abc.abstractmethod
    def part(self, number: int, part_size: int) -> bytes:
        """The bytes of part number (from 1), when the parts are part_size bytes long."""

    def close(self) -> None:
        pass

    def _bounds(self, number: int, part_size: int) -> Tuple[int, int]:
        start = (number - 1) * part_size
        return (start, min(number * part_size, self.size))


def _changed() -> Exception:
    return invalid("The file changed while it was being uploaded: a part did not have the bytes its size says.")


class _PathSource(_Source):
    def __init__(self, path: Union[str, "os.PathLike[str]"]) -> None:
        self._path = os.fspath(path)
        self.size = os.stat(self._path).st_size
        self.name = os.path.basename(self._path) or None

    def part(self, number: int, part_size: int) -> bytes:
        start, end = self._bounds(number, part_size)
        with open(self._path, "rb") as file:
            file.seek(start)
            data = _read_exactly(file, end - start)
        if len(data) != end - start:
            raise _changed()
        return data


class _BytesSource(_Source):
    def __init__(self, data: Union[bytes, bytearray, memoryview]) -> None:
        self._view = memoryview(data).cast("B")
        self.size = self._view.nbytes

    def part(self, number: int, part_size: int) -> bytes:
        start, end = self._bounds(number, part_size)
        return bytes(self._view[start:end])


def _read_exactly(file: Any, count: int) -> bytes:
    """count bytes of a binary file, or fewer at its end: one read() may give less than it was asked for."""
    chunks: List[bytes] = []
    got = 0
    while got < count:
        chunk = file.read(count - got)
        if isinstance(chunk, str):
            raise invalid('upload_file reads bytes: open the file in binary mode, with open(path, "rb").')
        if not chunk:
            break
        chunks.append(bytes(chunk))
        got += len(chunk)
    return b"".join(chunks)


class _SeekableFile(_Source):
    def __init__(self, file: Any, name: Optional[str]) -> None:
        self._file = file
        self._start = file.tell()
        end = file.seek(0, os.SEEK_END)
        file.seek(self._start)
        self.size = end - self._start
        self.name = name

    def part(self, number: int, part_size: int) -> bytes:
        start, end = self._bounds(number, part_size)
        self._file.seek(self._start + start)
        data = _read_exactly(self._file, end - start)
        if len(data) != end - start:
            raise _changed()
        return data


class _StreamFile(_Source):
    """A file that cannot seek: its bytes are read in order, once. The bytes of a part the API already holds are
    read and dropped."""

    rereadable = False

    def __init__(self, file: Any, size: int, name: Optional[str]) -> None:
        self._file = file
        self.size = size
        self.name = name
        self._consumed = 0

    def part(self, number: int, part_size: int) -> bytes:
        start, end = self._bounds(number, part_size)
        if start < self._consumed:
            raise ValueError(f"Part {number} of a stream was asked for after its bytes were read.")
        skip = start - self._consumed
        while skip > 0:
            dropped = _read_exactly(self._file, min(skip, 1 << 20))
            if not dropped:
                raise invalid(f"The file ended after {self._consumed} bytes, and size_bytes is {self.size}.")
            self._consumed += len(dropped)
            skip -= len(dropped)
        data = _read_exactly(self._file, end - start)
        self._consumed += len(data)
        if len(data) < end - start:
            raise invalid(f"The file ended after {self._consumed} bytes, and size_bytes is {self.size}.")
        if end == self.size and _read_exactly(self._file, 1):
            raise invalid(f"The file has more bytes than size_bytes, {self.size}.")
        return data


def _name_of(file: Any) -> Optional[str]:
    """The name of a file opened from a path: its last part, such as interview.mp4."""
    name = getattr(file, "name", None)
    if not isinstance(name, str):
        return None
    return os.path.basename(name) or None


def _source_of(source: Any, size_bytes: Optional[int]) -> _Source:
    """What a source of upload_file is, checked before anything is read or sent."""
    if isinstance(source, (str, os.PathLike)):
        return _PathSource(source)
    if isinstance(source, (bytes, bytearray, memoryview)):
        return _BytesSource(source)
    if isinstance(source, io.TextIOBase):
        raise invalid('upload_file reads bytes: open the file in binary mode, with open(path, "rb").')
    if callable(getattr(source, "read", None)):
        seekable = getattr(source, "seekable", None)
        if callable(seekable) and seekable():
            return _SeekableFile(source, _name_of(source))
        if size_bytes is None:
            raise invalid("upload_file needs size_bytes for a file that cannot seek: the API asks for the size before the first byte.")
        return _StreamFile(source, size_bytes, _name_of(source))
    raise invalid('upload_file takes the path of a file, bytes, or a file opened in binary mode, such as open(path, "rb").')


# ----------------------------------------------------------------------------------------------------- upload


@dataclass(frozen=True)
class UploadContext:
    transport: Transport
    index: OperationIndex


@dataclass(frozen=True)
class _Upload:
    id: str
    part_size: int
    part_count: int
    received: Set[int]


def _bad_answer(spec: OperationSpec, message: str) -> GptVideoNetworkError:
    return GptVideoNetworkError(format_error_message("BAD_RESPONSE", message), code="BAD_RESPONSE", operation=spec["id"])


def _upload_in(body: Any, size: int, spec: OperationSpec) -> _Upload:
    """The upload an answer carries, checked: its parts must cover the file exactly."""
    upload = body.get("upload") if isinstance(body, dict) else None
    if not isinstance(upload, dict) or not isinstance(upload.get("id"), str) or not upload["id"]:
        raise _bad_answer(spec, TEXTS.missing_handle("upload"))
    part_size = upload.get("partSizeBytes")
    part_count = upload.get("partCount")
    whole = lambda value: isinstance(value, int) and not isinstance(value, bool)  # noqa: E731
    if not whole(part_size) or part_size <= 0 or not whole(part_count) or part_count != math.ceil(size / part_size):
        raise _bad_answer(spec, TEXTS.parts_mismatch(size, part_size, part_count))
    received = upload.get("receivedParts")
    numbers = {n for n in received if whole(n)} if isinstance(received, list) else set()
    return _Upload(id=upload["id"], part_size=part_size, part_count=part_count, received=numbers)


def _elsewhere(outcome: Failure) -> Optional[str]:
    """The sentence that says where else a video can be uploaded when uploads are turned off."""
    details = getattr(outcome, "details", None)
    if outcome.kind == "api" and outcome.code == "UNAVAILABLE" and isinstance(details, dict) and details.get("reason") == SWITCHED_OFF:
        return MESSAGES["upload_elsewhere"]
    return None


def _aborted(spec: OperationSpec) -> GptVideoNetworkError:
    return GptVideoNetworkError(format_error_message("ABORTED", MESSAGES["aborted"]), code="ABORTED", operation=spec["id"])


def upload_file(
    ctx: UploadContext,
    source: Any,
    *,
    filename: Optional[str] = None,
    content_type: Optional[str] = None,
    size_bytes: Optional[int] = None,
    title: Optional[str] = None,
    concurrency: int = UPLOAD_CONCURRENCY,
    on_progress: Optional[Callable[[UploadProgress], Any]] = None,
    cancel: Optional[Cancel] = None,
) -> Any:
    """upload_file(source): returns the answer of complete_upload, {asset}."""
    cancel = check_cancel(cancel)
    if on_progress is not None and not callable(on_progress):
        raise invalid("on_progress must be a function.")
    for name, value in (("filename", filename), ("content_type", content_type), ("title", title)):
        if value is not None and (not isinstance(value, str) or not value):
            raise invalid(f"{name} must be a non-empty string.")
    if not isinstance(concurrency, int) or isinstance(concurrency, bool) or not 1 <= concurrency <= UPLOAD_CONCURRENCY_MAX:
        raise invalid(f"concurrency must be a whole number from 1 to {UPLOAD_CONCURRENCY_MAX}.")
    if size_bytes is not None and (not isinstance(size_bytes, int) or isinstance(size_bytes, bool) or size_bytes < 1):
        raise invalid("size_bytes must be a whole number of bytes, 1 or more.")
    src = _source_of(source, size_bytes)
    try:
        if size_bytes is not None and size_bytes != src.size:
            raise invalid(f"size_bytes is {size_bytes}, and the file has {src.size} bytes.")
        if src.size == 0:
            raise invalid("The file is empty.")
        name = filename or src.name
        if not name:
            raise invalid("upload_file needs a filename, such as interview.mp4: the API reads the type of the video from it.")
        return _run(ctx, src, name, content_type, title, concurrency, on_progress, cancel)
    finally:
        src.close()


def _run(ctx: UploadContext, src: _Source, filename: str, content_type: Optional[str], title: Optional[str], concurrency: int, on_progress: Optional[Callable[[UploadProgress], Any]], cancel: Optional[Cancel]) -> Any:
    transport = ctx.transport
    complete_key = new_idempotency_key()
    create = ctx.index.operation("create_upload")
    part = ctx.index.operation("upload_part")
    read = ctx.index.operation("get_upload")
    complete = ctx.index.operation("complete_upload")
    cancel_op = ctx.index.operation("cancel_upload")
    with_cancel: Dict[str, Any] = {"cancel": cancel}

    fields: Dict[str, Any] = {"filename": filename, "sizeBytes": src.size}
    if content_type:
        fields["contentType"] = content_type
    created = transport.send(create, fields, with_cancel, None, SendHooks(explain=_elsewhere))
    opened = created.get("upload") if isinstance(created, dict) else None
    opened_id = opened.get("id") if isinstance(opened, dict) and isinstance(opened.get("id"), str) and opened.get("id") else None
    try:
        upload = _upload_in(created, src.size, create)
    except Exception:
        if opened_id is not None:
            _cancel_in_background(transport, cancel_op, opened_id)
        raise

    uploaded = [0]

    def received(count: int) -> None:
        uploaded[0] += count
        call_hook(on_progress, UploadProgress(uploaded_bytes=uploaded[0], total_bytes=src.size))

    def send_complete() -> Any:
        body: Dict[str, Any] = {"uploadId": upload.id}
        if title:
            body["title"] = title
        return transport.send(complete, body, {"idempotency_key": complete_key, "cancel": cancel})

    try:
        _send_parts(transport, part, upload, src, [n for n in range(1, upload.part_count + 1) if n not in upload.received], concurrency, cancel, received)
        try:
            return send_complete()
        except GptVideoApiError as refusal:
            if refusal.code != "CONFLICT" or not src.rereadable:
                raise
            try:
                again = _upload_in(transport.send(read, {"uploadId": upload.id}, with_cancel), src.size, read)
                missing = [n for n in range(1, again.part_count + 1) if n not in again.received]
            except Exception:
                # the upload cannot be read: the refusal of complete is the answer the caller needs
                raise refusal from None
            if not missing:
                raise
            # the progress goes back to what the API holds, and the parts sent again add up to the whole file
            uploaded[0] = src.size - sum(min(n * upload.part_size, src.size) - (n - 1) * upload.part_size for n in missing)
            _send_parts(transport, part, upload, src, missing, concurrency, cancel, received)
            return send_complete()
    except BaseException:
        _cancel_in_background(transport, cancel_op, upload.id)
        raise


def _cancel_in_background(transport: Transport, spec: OperationSpec, upload_id: str) -> None:
    """An open upload counts against the open uploads and the storage of the account until it expires: once an
    upload fails, it is cancelled in a background thread, without the caller's cancel event, and whatever the
    cancel answers is ignored. The failure that caused it reaches the caller at once."""

    def run() -> None:
        try:
            transport.send(spec, {"uploadId": upload_id}, {"deadline": CANCEL_DEADLINE, "max_retries": 1})
        except Exception:
            pass

    threading.Thread(target=run, name="gpt-video-cancel-upload", daemon=True).start()


def _send_parts(
    transport: Transport,
    spec: OperationSpec,
    upload: _Upload,
    src: _Source,
    numbers: List[int],
    concurrency: int,
    cancel: Optional[Cancel],
    received: Callable[[int], None],
) -> None:
    """Sends parts, at most concurrency at once, one at a time after a part timed out. The first part that fails
    stops the others and is the error."""
    stop = threading.Event()
    linked = _Linked(cancel, stop)
    max_retries = transport.defaults[0]
    limit = [concurrency]

    def on_failure(outcome: Failure) -> None:
        if outcome.code == "TIMEOUT":
            limit[0] = 1

    def send_part(number: int, data: bytes) -> int:
        timeout = part_timeout(len(data))
        transport.send(
            spec,
            {"uploadId": upload.id, "partNumber": number},
            {"cancel": linked, "timeout": timeout, "deadline": part_deadline(timeout, max_retries)},
            data,
            SendHooks(on_failure=on_failure),
        )
        return len(data)

    queue: Deque[int] = deque(numbers)
    in_flight: Dict["concurrent.futures.Future[int]", int] = {}
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=concurrency, thread_name_prefix="gpt-video-upload")
    try:
        while queue or in_flight:
            while queue and len(in_flight) < limit[0]:
                if linked.is_set():
                    raise _aborted(spec)
                number = queue.popleft()
                # the bytes are read here, in the caller's thread, just before they are sent
                data = src.part(number, upload.part_size)
                in_flight[pool.submit(send_part, number, data)] = number
            done, _ = concurrent.futures.wait(list(in_flight), return_when=concurrent.futures.FIRST_COMPLETED)
            for future in done:
                in_flight.pop(future)
                error = future.exception()
                if error is not None:
                    raise error
                received(future.result())
    finally:
        # the parts still in flight see the stop at their next read or block sent, and end
        stop.set()
        pool.shutdown(wait=False, cancel_futures=True)
