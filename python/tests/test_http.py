"""The wire over real sockets, against servers on this machine: what goes out, a redirect never followed, a server
that drips its answer stopped at the deadline, a cancel event, proxies, and a download written whole or not at all."""

import json
import os
import socket
import ssl
import tempfile
import threading
import time
import unittest
from contextlib import contextmanager
from typing import Any, Callable, Dict, Iterator, List, Optional

from gpt_video import GptVideo, GptVideoNetworkError
from gpt_video._http import Deadline, UrllibWire, WireRequest, failure_of
from gpt_video.errors import MESSAGES

from .support import api_key

KEY = api_key()


class Server:
    """A server on this machine that hands every connection to handle, in its own thread, and records what each
    request carried."""

    def __init__(self, handle: Callable[["Server", socket.socket], None]) -> None:
        self.handle = handle
        self.requests: List[Dict[str, Any]] = []
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(16)
        self.port = self.sock.getsockname()[1]
        self.url = f"http://127.0.0.1:{self.port}"
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def _serve(self) -> None:
        while not self._stop.is_set():
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            threading.Thread(target=self._one, args=(conn,), daemon=True).start()

    def _one(self, conn: socket.socket) -> None:
        try:
            self.handle(self, conn)
        except OSError:
            pass
        finally:
            try:
                conn.close()
            except OSError:
                pass

    def read_request(self, conn: socket.socket) -> Dict[str, Any]:
        data = b""
        while b"\r\n\r\n" not in data:
            chunk = conn.recv(65536)
            if not chunk:
                break
            data += chunk
        head, _, rest = data.partition(b"\r\n\r\n")
        lines = head.decode("latin-1").split("\r\n")
        method, path, _ = lines[0].split(" ", 2)
        headers = {line.split(":", 1)[0].strip().lower(): line.split(":", 1)[1].strip() for line in lines[1:] if ":" in line}
        length = int(headers.get("content-length", "0"))
        while len(rest) < length:
            chunk = conn.recv(65536)
            if not chunk:
                break
            rest += chunk
        request = {"method": method, "path": path, "headers": headers, "body": rest}
        self.requests.append(request)
        return request

    def close(self) -> None:
        self._stop.set()
        self.sock.close()


def answer(conn: socket.socket, status: int, body: bytes = b"", headers: Optional[Dict[str, str]] = None) -> None:
    head = f"HTTP/1.1 {status} X\r\nContent-Length: {len(body)}\r\nConnection: close\r\n"
    for name, value in (headers or {}).items():
        head += f"{name}: {value}\r\n"
    conn.sendall(head.encode("latin-1") + b"\r\n" + body)


@contextmanager
def server(handle: Callable[[Server, socket.socket], None]) -> Iterator[Server]:
    s = Server(handle)
    try:
        yield s
    finally:
        s.close()


def json_server(status: int = 200, body: Any = None, headers: Optional[Dict[str, str]] = None) -> Callable[[Server, socket.socket], None]:
    def handle(s: Server, conn: socket.socket) -> None:
        s.read_request(conn)
        answer(conn, status, json.dumps({} if body is None else body).encode(), {"Content-Type": "application/json", **(headers or {})})

    return handle


@contextmanager
def environment(**values: Optional[str]) -> Iterator[None]:
    saved = {name: os.environ.get(name) for name in values}
    try:
        for name, value in values.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
        yield
    finally:
        for name, value in saved.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


def closed_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class WhatGoesOut(unittest.TestCase):
    def test_sends_the_method_the_path_the_headers_and_a_body_sent_in_blocks_and_reads_the_whole_answer(self) -> None:
        with server(json_server(200, {"ok": True})) as s:
            gv = GptVideo(api_key=KEY, base_url=f"{s.url}/api/v1")
            title = "x" * 300_000
            self.assertEqual(gv.update_project(projectId="prj_1", title=title), {"ok": True})
            request = s.requests[0]
            self.assertEqual((request["method"], request["path"]), ("PATCH", "/api/v1/projects/prj_1"))
            self.assertEqual(request["headers"]["authorization"], f"Bearer {KEY}")
            self.assertEqual(request["headers"]["content-type"], "application/json")
            self.assertTrue(request["headers"]["user-agent"].startswith("gpt-video-python/"))
            self.assertEqual(json.loads(request["body"]), {"title": title})

    def test_never_follows_a_redirect_so_the_key_never_reaches_another_address(self) -> None:
        with server(json_server(200)) as elsewhere:

            def redirect(s: Server, conn: socket.socket) -> None:
                s.read_request(conn)
                answer(conn, 307, b"", {"Location": f"{elsewhere.url}/api/v1/me"})

            with server(redirect) as s:
                gv = GptVideo(api_key=KEY, base_url=f"{s.url}/api/v1", max_retries=2)
                for call in (gv.get_me, lambda: gv.analyze_project(projectId="prj_1")):
                    with self.assertRaises(GptVideoNetworkError) as caught:
                        call()
                    self.assertEqual((caught.exception.code, caught.exception.status), ("BAD_RESPONSE", 307))
                    self.assertIn(MESSAGES["redirect"], caught.exception.message)
                self.assertEqual(len(s.requests), 2, "a redirect is not retried")
                self.assertEqual(elsewhere.requests, [])


class Deadlines(unittest.TestCase):
    def ends_by(self, call: Callable[[], Any], code: str, at_least: float, at_most: float) -> GptVideoNetworkError:
        started = time.monotonic()
        with self.assertRaises(GptVideoNetworkError) as caught:
            call()
        took = time.monotonic() - started
        self.assertEqual(caught.exception.code, code)
        self.assertGreaterEqual(took, at_least)
        self.assertLess(took, at_most, f"took {took:.2f} seconds")
        return caught.exception

    # Each server below would hold the request for 8 seconds or more: an upper bound of 4 seconds proves the deadline
    # of 1 second ended it, with room for a busy machine.

    def test_a_server_that_drips_the_body_is_stopped_at_the_timeout_of_the_attempt(self) -> None:
        def drip(s: Server, conn: socket.socket) -> None:
            s.read_request(conn)
            conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100000\r\n\r\n")
            for _ in range(400):
                conn.sendall(b" ")
                time.sleep(0.02)

        with server(drip) as s:
            gv = GptVideo(api_key=KEY, base_url=f"{s.url}/api/v1", timeout=1, max_retries=0)
            self.ends_by(gv.get_me, "TIMEOUT", 0.95, 4)

    def test_a_server_that_drips_the_headers_is_stopped_at_the_timeout_of_the_attempt(self) -> None:
        def drip(s: Server, conn: socket.socket) -> None:
            s.read_request(conn)
            conn.sendall(b"HTTP/1.1 200 OK\r\nX-Slow: ")
            for _ in range(400):
                conn.sendall(b"a")
                time.sleep(0.02)

        with server(drip) as s:
            gv = GptVideo(api_key=KEY, base_url=f"{s.url}/api/v1", timeout=1, max_retries=0)
            self.ends_by(gv.get_me, "TIMEOUT", 0.95, 4)

    def test_a_server_that_never_answers_is_a_timeout_and_a_cancel_event_stops_the_wait_at_once(self) -> None:
        def silent(s: Server, conn: socket.socket) -> None:
            s.read_request(conn)
            time.sleep(10)

        with server(silent) as s:
            gv = GptVideo(api_key=KEY, base_url=f"{s.url}/api/v1", timeout=1, max_retries=0)
            self.ends_by(gv.get_me, "TIMEOUT", 0.95, 4)
            cancel = threading.Event()
            threading.Timer(0.3, cancel.set).start()
            error = self.ends_by(lambda: gv.analyze_project(projectId="prj_1", timeout=10, cancel=cancel), "ABORTED", 0.25, 4)
            self.assertTrue(error.may_have_spent, "a spend aborted after it was sent may have been charged")
            self.assertIsNotNone(error.idempotency_key)

    def test_a_closed_port_is_a_failed_connection_with_the_name_of_the_failure(self) -> None:
        gv = GptVideo(api_key=KEY, base_url=f"http://127.0.0.1:{closed_port()}/api/v1", max_retries=0)
        with self.assertRaises(GptVideoNetworkError) as caught:
            gv.get_me()
        self.assertEqual(caught.exception.code, "CONNECTION_FAILED")
        self.assertRegex(caught.exception.message, r"The connection to the API failed \((ECONNREFUSED|WSAECONNREFUSED|ConnectionRefusedError)\)\.")
        self.assertIsNone(caught.exception.__cause__)
        self.assertIsNone(caught.exception.__context__)
        self.assertNotIn(KEY, caught.exception.message)

    def test_a_certificate_this_machine_cannot_verify_is_a_failed_connection_that_says_how_to_fix_it(self) -> None:
        deadline = Deadline(time.monotonic() + 1, None)
        failure = failure_of(ssl.SSLCertVerificationError(1, "certificate verify failed"), deadline)
        self.assertEqual((failure.kind, failure.tls), ("connection_failed", True))


class Proxies(unittest.TestCase):
    def test_a_request_to_this_machine_never_goes_through_a_proxy(self) -> None:
        with server(json_server(502)) as proxy, server(json_server(200, {"ok": True})) as s:
            with environment(HTTP_PROXY=proxy.url, HTTPS_PROXY=proxy.url, http_proxy=proxy.url, https_proxy=proxy.url, NO_PROXY=None, no_proxy=None):
                self.assertEqual(GptVideo(api_key=KEY, base_url=f"{s.url}/api/v1").get_me(), {"ok": True})
                self.assertEqual((len(s.requests), proxy.requests), (1, []))
                # the same request through a wire that reads the proxies goes to the proxy, with every header
                wire = UrllibWire(use_proxies=True)
                wire.send(WireRequest("GET", f"{s.url}/api/v1/me", {"Authorization": "Bearer x"}), Deadline(time.monotonic() + 5, None))
                self.assertEqual(len(proxy.requests), 1)
                self.assertEqual(proxy.requests[0]["path"], f"{s.url}/api/v1/me")
                self.assertEqual(len(s.requests), 1)


class Downloads(unittest.TestCase):
    def test_follows_a_redirect_on_this_machine_and_never_sends_the_key(self) -> None:
        payload = os.urandom(3 * 1024 * 1024 + 17)

        def file(s: Server, conn: socket.socket) -> None:
            s.read_request(conn)
            answer(conn, 200, payload, {"Content-Type": "video/mp4"})

        with server(file) as target:

            def redirect(s: Server, conn: socket.socket) -> None:
                s.read_request(conn)
                answer(conn, 302, b"", {"Location": f"{target.url}/files/clip.mp4?sig=x"})

            with server(redirect) as link:
                gv = GptVideo(api_key=KEY, base_url=f"{link.url}/api/v1")
                with tempfile.TemporaryDirectory() as folder:
                    path = os.path.join(folder, "clip.mp4")
                    self.assertEqual(gv.download(f"{link.url}/media/x?exp=1", path), len(payload))
                    with open(path, "rb") as f:
                        self.assertEqual(f.read(), payload)
                    self.assertEqual(sorted(os.listdir(folder)), ["clip.mp4"], "no part file left behind")
                for request in link.requests + target.requests:
                    self.assertNotIn("authorization", request["headers"])

    def test_stops_a_redirect_to_an_address_that_is_not_https_before_opening_it(self) -> None:
        def redirect(s: Server, conn: socket.socket) -> None:
            s.read_request(conn)
            answer(conn, 302, b"", {"Location": "http://example.com/clip.mp4"})

        with server(redirect) as link:
            gv = GptVideo(api_key=KEY, base_url=f"{link.url}/api/v1")
            with tempfile.TemporaryDirectory() as folder:
                with self.assertRaises(GptVideoNetworkError) as caught:
                    gv.download(f"{link.url}/media/x", os.path.join(folder, "clip.mp4"))
                self.assertIn(MESSAGES["download_insecure"], caught.exception.message)
                self.assertEqual(os.listdir(folder), [])

    def test_a_body_cut_in_the_middle_leaves_the_path_as_it_was(self) -> None:
        def cut(s: Server, conn: socket.socket) -> None:
            s.read_request(conn)
            conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 1000000\r\n\r\n" + b"x" * 1000)

        with server(cut) as link:
            gv = GptVideo(api_key=KEY, base_url=f"{link.url}/api/v1")
            with tempfile.TemporaryDirectory() as folder:
                path = os.path.join(folder, "clip.mp4")
                with open(path, "wb") as f:
                    f.write(b"the old file")
                with self.assertRaises(GptVideoNetworkError) as caught:
                    gv.download(f"{link.url}/media/x", path)
                self.assertEqual(caught.exception.code, "CONNECTION_FAILED")
                with open(path, "rb") as f:
                    self.assertEqual(f.read(), b"the old file")
                self.assertEqual(os.listdir(folder), ["clip.mp4"])
