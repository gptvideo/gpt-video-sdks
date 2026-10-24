"""The wire: one HTTP request over urllib, bounded in time from end to end, that never follows a redirect.

What holds on every path through this file:

- the deadline of an attempt bounds everything after the name lookup: the connection, the TLS handshake, sending
  the request and reading the whole answer. urllib alone bounds each operation on the socket, not their sum, so a
  server that sent a byte now and then could hold a call for ever. Every read and every block sent asks the
  deadline how long it may take;
- a cancel event stops a request within CANCEL_POLL seconds while an answer is awaited or read, and between two
  blocks of a body being sent;
- a redirect is never followed: the opener has no error processor, so a 3xx comes back as an answer, which the
  engine refuses. urllib would carry the Authorization header to the new address;
- a request to this machine never goes through a proxy: a proxy could not reach it, and would see the request.

The name lookup (getaddrinfo) is the one step no deadline can stop: it ends when the system resolver gives up.
"""

import errno
import functools
import http.client
import io
import re
import socket
import ssl
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Mapping, Optional, Protocol, Tuple, Union

CANCEL_POLL = 0.2
"""How often, in seconds, a request that waits for the network looks at its cancel event."""

SEND_BLOCK = 64 * 1024
"""The bytes sent at once: between two blocks the deadline and the cancel event are read again."""


class Cancel(Protocol):
    """What a cancel option must be: a threading.Event, or anything with the same is_set and wait."""

    def is_set(self) -> bool: ...

    def wait(self, timeout: Optional[float] = None) -> bool: ...


class Stopped(Exception):
    """An attempt that reached its deadline (reason "timeout") or its cancel event (reason "aborted")."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class Deadline:
    """The end of an attempt on a monotonic clock, and the caller's cancel event."""

    def __init__(self, at: float, cancel: Optional[Cancel], clock: Callable[[], float] = time.monotonic) -> None:
        self.at = at
        self.cancel = cancel
        self.clock = clock

    def stop_reason(self) -> Optional[str]:
        """aborted when the cancel event is set, timeout when the deadline passed, else None."""
        if self.cancel is not None and self.cancel.is_set():
            return "aborted"
        if self.at - self.clock() <= 0:
            return "timeout"
        return None

    def remaining(self) -> float:
        """The seconds left, for a step that cannot be resumed once its timeout passes (a connection, a block
        sent). Raises Stopped when nothing is left."""
        reason = self.stop_reason()
        if reason is not None:
            raise Stopped(reason)
        return self.at - self.clock()

    def slice(self, started: float) -> float:
        """The timeout of the next read: what is left, cut to CANCEL_POLL when there is a cancel event to watch.
        A read that ends on such a slice is simply asked again."""
        left = self.remaining()
        return min(left, CANCEL_POLL) if self.cancel is not None else left


class Idle:
    """The time of each read of a body handed to the caller: no total, but no read waits longer than timeout."""

    def __init__(self, timeout: float, cancel: Optional[Cancel], clock: Callable[[], float] = time.monotonic) -> None:
        self.timeout = timeout
        self.cancel = cancel
        self.clock = clock

    def slice(self, started: float) -> float:
        if self.cancel is not None and self.cancel.is_set():
            raise Stopped("aborted")
        left = started + self.timeout - self.clock()
        if left <= 0:
            raise Stopped("timeout")
        return min(left, CANCEL_POLL) if self.cancel is not None else left


@dataclass(frozen=True)
class WireRequest:
    """A request as it goes out: the headers are the final ones, Authorization included when there is one."""

    method: str
    url: str
    headers: Mapping[str, str] = field(repr=False)
    body: Optional[bytes] = field(default=None, repr=False)


@dataclass(frozen=True)
class WireResponse:
    """An answer read whole: its status, its headers (lower-case names, repeated values joined by ", ") and body."""

    status: int
    headers: Mapping[str, str]
    body: bytes


@dataclass(frozen=True)
class WireFailure:
    """A request with no answer. kind is connection_failed, timeout or aborted; detail names the failure of a
    connection, and tls says it was a certificate this machine could not verify."""

    kind: str
    detail: Optional[str] = None
    tls: bool = False


class LiveResponse(Protocol):
    """An answer whose status and headers arrived, and whose body is still to read."""

    status: int
    headers: Mapping[str, str]

    def read(self, size: int) -> bytes: ...

    def idle(self, timeout: float, cancel: Optional[Cancel]) -> None:
        """From now on, no read of the body waits longer than timeout, and the cancel event stops it."""

    def close(self) -> None: ...


class Wire(Protocol):
    """What the engine sends with: the real one is UrllibWire, a test passes its own. send reads the whole
    answer within the deadline; open stops at the headers, and raises what the request raised."""

    def send(self, request: WireRequest, deadline: Deadline) -> Union[WireResponse, WireFailure]: ...

    def open(self, request: WireRequest, deadline: Deadline) -> LiveResponse: ...


_NAME = re.compile(r"[A-Za-z][A-Za-z0-9_]{1,40}")


def _failure_name(error: BaseException) -> Optional[str]:
    """The name of a failed connection worth repeating: the errno name (ECONNREFUSED), else the class name."""
    number = getattr(error, "errno", None)
    if isinstance(number, int) and number in errno.errorcode:
        return errno.errorcode[number]
    name = type(error).__name__
    return name if _NAME.fullmatch(name) else None


def headers_of(message: Any) -> Dict[str, str]:
    """The headers of an answer with lower-case names; a header sent twice is joined by ", ", as fetch does."""
    out: Dict[str, str] = {}
    for name, value in message.items():
        key = str(name).lower()
        out[key] = f"{out[key]}, {value}" if key in out else str(value)
    return out


# ------------------------------------------------------------------------------------------------- the socket


def _connect(address: Tuple[str, int], timeout: Any, source_address: Any = None, *, gv_deadline: Deadline) -> socket.socket:
    """socket.create_connection with the deadline: each address gets what is left of it, not a whole timeout."""
    host, port = address
    last: Optional[OSError] = None
    for family, kind, proto, _, where in socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM):
        sock = socket.socket(family, kind, proto)
        try:
            sock.settimeout(gv_deadline.remaining())
            if source_address:
                sock.bind(source_address)
            sock.connect(where)
            # the TLS handshake that may follow has what is left, as one operation
            sock.settimeout(gv_deadline.remaining())
            return sock
        except BaseException as error:
            sock.close()
            if not isinstance(error, OSError):
                raise
            last = error
    if last is not None:
        raise last
    raise OSError("the name of the host has no address")


class _Reader(io.RawIOBase):
    """The bytes of an answer, read straight from the socket, each read bounded by the policy of the moment: the
    deadline of the attempt, or the idle time of a body handed to the caller. It holds the file the socket gave
    the answer (raw), which keeps the socket open until the answer is closed."""

    def __init__(self, sock: socket.socket, raw: Any, policy: Union[Deadline, Idle]) -> None:
        super().__init__()
        self._sock = sock
        self._raw = raw
        self.policy = policy

    def readable(self) -> bool:
        return True

    def readinto(self, buffer: Any) -> int:
        started = self.policy.clock()
        while True:
            self._sock.settimeout(self.policy.slice(started))
            try:
                return self._sock.recv_into(buffer)
            except TimeoutError:
                # a slice ended: the policy says on the next turn whether time is up or the call was cancelled
                continue

    def close(self) -> None:
        if not self.closed:
            try:
                self._raw.close()
            finally:
                super().close()


class _Response(http.client.HTTPResponse):
    """An answer whose every read goes through a _Reader."""

    def __init__(self, sock: socket.socket, debuglevel: int = 0, method: Optional[str] = None, url: Optional[str] = None, *, gv_deadline: Deadline) -> None:
        super().__init__(sock, debuglevel, method=method, url=url)
        self.gv_reader = _Reader(sock, self.fp.detach(), gv_deadline)
        self.fp = io.BufferedReader(self.gv_reader)


class _Sending:
    """Sends a request in blocks, each one with what is left of the deadline."""

    sock: Any
    auto_open: int
    _gv_deadline: Deadline

    def send(self, data: Any) -> None:
        if self.sock is None:
            if self.auto_open:
                self.connect()  # type: ignore[attr-defined]
            else:
                raise http.client.NotConnected()
        if isinstance(data, str):
            data = data.encode("iso-8859-1")
        view = memoryview(data).cast("B")
        for start in range(0, len(view), SEND_BLOCK):
            self.sock.settimeout(self._gv_deadline.remaining())
            self.sock.sendall(view[start : start + SEND_BLOCK])


def _arm(connection: http.client.HTTPConnection, deadline: Deadline) -> None:
    setattr(connection, "_gv_deadline", deadline)
    setattr(connection, "_create_connection", functools.partial(_connect, gv_deadline=deadline))
    setattr(connection, "response_class", functools.partial(_Response, gv_deadline=deadline))


class _Connection(_Sending, http.client.HTTPConnection):
    def __init__(self, host: str, *, gv_deadline: Deadline, **kwargs: Any) -> None:
        kwargs.pop("timeout", None)
        super().__init__(host, **kwargs)
        _arm(self, gv_deadline)


class _TlsConnection(_Sending, http.client.HTTPSConnection):
    def __init__(self, host: str, *, gv_deadline: Deadline, **kwargs: Any) -> None:
        kwargs.pop("timeout", None)
        super().__init__(host, **kwargs)
        _arm(self, gv_deadline)


# ------------------------------------------------------------------------------------------------- the opener


class _Request(urllib.request.Request):
    gv_deadline: Deadline


class _HttpHandler(urllib.request.HTTPHandler):
    def http_open(self, req: Any) -> Any:
        return self.do_open(functools.partial(_Connection, gv_deadline=req.gv_deadline), req)


class _HttpsHandler(urllib.request.HTTPSHandler):
    def https_open(self, req: Any) -> Any:
        return self.do_open(functools.partial(_TlsConnection, gv_deadline=req.gv_deadline), req, context=getattr(self, "_context"))


class _RefuseRedirects(urllib.request.HTTPRedirectHandler):
    """Refuses every redirect. The opener has no error processor, so nothing calls it today; it is here so that a
    handler added later could still never send the Authorization header to another address."""

    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:
        return None


def _opener(use_proxies: bool, context: ssl.SSLContext) -> urllib.request.OpenerDirector:
    opener = urllib.request.OpenerDirector()
    for handler in (urllib.request.ProxyHandler(None if use_proxies else {}), _HttpHandler(), _HttpsHandler(context=context), _RefuseRedirects()):
        opener.add_handler(handler)
    return opener


class _Live:
    """The answer of UrllibWire.open."""

    def __init__(self, response: _Response) -> None:
        self._response = response
        self.status: int = response.status
        self.headers: Mapping[str, str] = headers_of(response.headers)

    def read(self, size: int) -> bytes:
        data = self._response.read(size)
        # http.client ends a body that stops before its Content-Length as if it were whole; a download cut in the
        # middle must not look like a finished one
        left = self._response.length
        if not data and size and left:
            raise http.client.IncompleteRead(b"", left)
        return data

    def idle(self, timeout: float, cancel: Optional[Cancel]) -> None:
        self._response.gv_reader.policy = Idle(timeout, cancel)

    def close(self) -> None:
        self._response.close()


class UrllibWire:
    """Sends requests with urllib. The proxies of the environment are read once, when the wire is built, and only
    for an address that is not this machine."""

    def __init__(self, *, use_proxies: bool, context: Optional[ssl.SSLContext] = None) -> None:
        self._opener = _opener(use_proxies, context if context is not None else ssl.create_default_context())

    def _open(self, request: WireRequest, deadline: Deadline) -> _Response:
        req = _Request(request.url, data=request.body, headers=dict(request.headers), method=request.method)
        req.gv_deadline = deadline
        response: _Response = self._opener.open(req, timeout=deadline.remaining())
        return response

    def open(self, request: WireRequest, deadline: Deadline) -> LiveResponse:
        """The answer once its status and headers arrived, its body still to read. Raises what urllib raises."""
        return _Live(self._open(request, deadline))

    def send(self, request: WireRequest, deadline: Deadline) -> Union[WireResponse, WireFailure]:
        """One request and its whole answer, within the deadline."""
        try:
            response = self._open(request, deadline)
            try:
                body = response.read()
                return WireResponse(status=response.status, headers=headers_of(response.headers), body=body)
            finally:
                response.close()
        except Exception as error:
            return failure_of(error, deadline)


def failure_of(error: BaseException, deadline: Union[Deadline, Idle]) -> WireFailure:
    """What a request that raised ended with. Only names are kept: never the request, never a header."""
    if isinstance(error, urllib.error.URLError) and not isinstance(error, urllib.error.HTTPError) and isinstance(error.reason, BaseException):
        error = error.reason
    if isinstance(error, Stopped):
        return WireFailure(error.reason)
    if deadline.cancel is not None and deadline.cancel.is_set():
        return WireFailure("aborted")
    if isinstance(error, TimeoutError) or (isinstance(deadline, Deadline) and deadline.stop_reason() == "timeout"):
        return WireFailure("timeout")
    if isinstance(error, ssl.SSLCertVerificationError):
        return WireFailure("connection_failed", type(error).__name__, tls=True)
    return WireFailure("connection_failed", _failure_name(error))
