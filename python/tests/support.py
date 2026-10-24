"""What the tests share: the vectors every GPT-Video SDK runs, a fake clock, and a fake wire that answers from a
script on that clock.

The vectors sit in the folder vectors beside the folder of this package, in the repository of the SDKs and where
they are developed alike. A test that cannot read them fails: it never passes on nothing.
"""

import errno
import heapq
import json
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple, Union

from gpt_video._http import Deadline, Stopped, WireFailure, WireRequest, WireResponse

VECTORS_DIR = Path(__file__).resolve().parent.parent.parent / "vectors"


def read_vectors(name: str) -> Any:
    """A file of the shared vectors, parsed."""
    path = VECTORS_DIR / name
    if not path.is_file():
        raise FileNotFoundError(f"{name} of the shared vectors was not found beside the package, in {VECTORS_DIR}.")
    return json.loads(path.read_text(encoding="utf-8"))


def api_key(letter: str = "T") -> str:
    """A key-shaped value, built at run time so that no file holds a string shaped like a real key."""
    return "gvk_" + letter * 43


def secret_of(base64_text: str) -> str:
    """A webhook signing secret, built at run time for the same reason."""
    return "whsec" + "_" + base64_text


class FakeClock:
    """A monotonic clock that moves only when the code under test waits, with events scheduled on it (a cancel
    event set at a given time). The wall clock is start_wall plus the monotonic time."""

    def __init__(self, start_wall: float = 1_791_720_000.0, rand: float = 0.0) -> None:
        self.now = 0.0
        self.start_wall = start_wall
        self.random_value = rand
        self.sleeps: List[float] = []
        self._events: List[Tuple[float, int, Callable[[], None]]] = []
        self._seq = 0
        # the parts of an upload move the clock from several threads
        self._lock = threading.RLock()

    def monotonic(self) -> float:
        return self.now

    def time(self) -> float:
        return self.start_wall + self.now

    def rand(self) -> float:
        return self.random_value

    def at(self, when: float, action: Callable[[], None]) -> None:
        """Runs action when the clock reaches when."""
        with self._lock:
            self._seq += 1
            heapq.heappush(self._events, (when, self._seq, action))

    def next_event(self) -> Optional[float]:
        with self._lock:
            return self._events[0][0] if self._events else None

    def advance(self, to: float) -> None:
        """Moves the clock to to, running every event on the way, in order."""
        with self._lock:
            while self._events and self._events[0][0] <= to:
                when, _, action = heapq.heappop(self._events)
                self.now = max(self.now, when)
                action()
            self.now = max(self.now, to)

    def sleep(self, seconds: float, cancel: Any) -> bool:
        with self._lock:
            self.sleeps.append(seconds)
            if cancel is not None and cancel.is_set():
                return False
            target = self.now + max(0.0, seconds)
            while True:
                upcoming = self.next_event()
                if upcoming is None or upcoming > target:
                    break
                self.advance(upcoming)
                if cancel is not None and cancel.is_set():
                    return False
            self.advance(target)
            return True

    def wait_until(self, deadline: Deadline, target: Optional[float] = None) -> Optional[str]:
        """Waits like a request: until target (an answer arriving), its deadline, or its cancel event. Returns
        timeout or aborted when the request ends that way, None when the answer arrives in time."""
        with self._lock:
            while True:
                upcoming = self.next_event()
                ends = deadline.at if target is None else min(target, deadline.at)
                if upcoming is not None and upcoming < ends:
                    self.advance(upcoming)
                    if deadline.cancel is not None and deadline.cancel.is_set():
                        return "aborted"
                    continue
                if deadline.cancel is not None and deadline.cancel.is_set():
                    return "aborted"
                if target is not None and target < deadline.at:
                    self.advance(target)
                    return None
                self.advance(max(self.now, deadline.at))
                return "aborted" if deadline.cancel is not None and deadline.cancel.is_set() else "timeout"


@dataclass
class Recorded:
    """What a request carried. Header names are lower case."""

    method: str
    url: str
    headers: Dict[str, str]
    body: Optional[bytes]
    at: float


def expand(responses: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The entries of retry.json with repeat: n written out."""
    out: List[Dict[str, Any]] = []
    for entry in responses:
        one = {k: v for k, v in entry.items() if k != "repeat"}
        out.extend(dict(one) for _ in range(entry.get("repeat", 1)))
    return out


def _body_of(entry: Dict[str, Any]) -> Tuple[bytes, Dict[str, str]]:
    headers = {k.lower(): str(v) for k, v in (entry.get("headers") or {}).items()}
    if "json" in entry:
        headers.setdefault("content-type", "application/json")
        return json.dumps(entry["json"]).encode("utf-8"), headers
    if "bytes" in entry:
        return bytes(entry["bytes"]), headers
    return str(entry.get("text", "")).encode("utf-8"), headers


class FakeLive:
    """The answer of FakeWire.open: a status, headers and a body given in chunks. A chunk that is "stall" never
    arrives: the read ends at the idle time of the body, or on the cancel event."""

    def __init__(self, clock: FakeClock, status: int, headers: Dict[str, str], chunks: List[Union[bytes, str]]) -> None:
        self._clock = clock
        self.status = status
        self.headers = headers
        self._chunks = list(chunks)
        self._idle: Optional[Tuple[float, Any]] = None
        self.closed = False
        self.reads = 0

    def idle(self, timeout: float, cancel: Any) -> None:
        self._idle = (timeout, cancel)

    def read(self, size: int) -> bytes:
        self.reads += 1
        if not self._chunks:
            return b""
        chunk = self._chunks.pop(0)
        if chunk == "stall":
            timeout, cancel = self._idle if self._idle is not None else (60.0, None)
            reason = self._clock.wait_until(Deadline(self._clock.now + timeout, cancel, self._clock.monotonic))
            raise Stopped(reason or "timeout")
        if chunk == "reset":
            raise ConnectionResetError(errno.ECONNRESET, "the connection was reset")
        assert isinstance(chunk, bytes)
        return chunk

    def close(self) -> None:
        self.closed = True


class FakeWire:
    """A wire for tests: it answers from a script, a list answered in order or a function that answers each
    request, and records every request it was sent. Its time is the fake clock's.

    An entry is {status, json | text | bytes, headers, afterMs}, or {network: "connection_failed"}, which fails at
    once, or {network: "hang"}, which never answers and ends at the deadline or the cancel event of the request.
    For open (a download), an entry can give chunks of its body instead, and a chunk "stall" or "reset".
    """

    def __init__(self, clock: FakeClock, script: Union[List[Dict[str, Any]], Callable[[Recorded, int], Dict[str, Any]]]) -> None:
        self.clock = clock
        self._queue = None if callable(script) else list(script)
        self._script = script
        self.calls: List[Recorded] = []
        self.opened: List[FakeLive] = []
        self._lock = threading.Lock()

    @property
    def left(self) -> int:
        return len(self._queue) if self._queue is not None else 0

    def _entry(self, request: WireRequest) -> Tuple[Recorded, Dict[str, Any]]:
        with self._lock:
            recorded = Recorded(request.method, request.url, {k.lower(): v for k, v in request.headers.items()}, request.body, self.clock.now)
            self.calls.append(recorded)
            index = len(self.calls) - 1
            if self._queue is not None:
                if not self._queue:
                    raise AssertionError(f"the script has no answer for request {index + 1}: {request.method} {request.url}")
                return recorded, self._queue.pop(0)
        script = self._script
        assert callable(script)
        return recorded, script(recorded, index)

    def send(self, request: WireRequest, deadline: Deadline) -> Union[WireResponse, WireFailure]:
        _, entry = self._entry(request)
        network = entry.get("network")
        if network == "connection_failed":
            return WireFailure("connection_failed", "ECONNREFUSED")
        if network == "tls":
            return WireFailure("connection_failed", "SSLCertVerificationError", tls=True)
        if network == "hang":
            return WireFailure(self.clock.wait_until(deadline) or "timeout")
        if network == "timeout":
            # a request that ran out of time, told at once: the time it took does not matter to the test
            return WireFailure("timeout")
        after = entry.get("afterMs", 0) / 1000
        ended = self.clock.wait_until(deadline, self.clock.now + after)
        if ended is not None:
            return WireFailure(ended)
        body, headers = _body_of(entry)
        return WireResponse(status=entry.get("status", 200), headers=headers, body=body)

    def open(self, request: WireRequest, deadline: Deadline) -> FakeLive:
        _, entry = self._entry(request)
        network = entry.get("network")
        if network == "connection_failed":
            raise ConnectionRefusedError(errno.ECONNREFUSED, "the connection was refused")
        if network == "hang":
            raise Stopped(self.clock.wait_until(deadline) or "timeout")
        after = entry.get("afterMs", 0) / 1000
        ended = self.clock.wait_until(deadline, self.clock.now + after)
        if ended is not None:
            raise Stopped(ended)
        if "chunks" in entry:
            chunks = list(entry["chunks"])
            headers = {k.lower(): str(v) for k, v in (entry.get("headers") or {}).items()}
        else:
            body, headers = _body_of(entry)
            chunks = [body] if body else []
        live = FakeLive(self.clock, entry.get("status", 200), headers, chunks)
        self.opened.append(live)
        return live


@dataclass
class Events:
    """What the hooks of a client were told."""

    responses: List[Any] = field(default_factory=list)
    retries: List[Any] = field(default_factory=list)
