"""Downloading the file behind a signed link, on a scripted wire: no key ever, only safe addresses, retries before
the body, and a body read within its idle time."""

import io
import os
import tempfile
import threading
import unittest
from typing import Any, Dict, List

from gpt_video import GptVideo, GptVideoNetworkError, RetryEvent
from gpt_video.errors import MESSAGES, GptVideoError

from .support import FakeClock, FakeWire, api_key

KEY = api_key()
LINK = "https://www.gpt-video.com/api/v1/files/exp_1.mp4?exp=1&sig=abc"


def client(script: List[Dict[str, Any]], **options: Any) -> "tuple[GptVideo, FakeWire, FakeClock]":
    clock = FakeClock()
    wire = FakeWire(clock, script)
    return GptVideo._with_wire(wire, clock, api_key=KEY, **options), wire, clock


class Download(unittest.TestCase):
    def test_writes_the_body_and_sends_no_key_even_to_the_host_of_the_api(self) -> None:
        gv, wire, _ = client([{"status": 200, "chunks": [b"abc", b"def"]}], base_url="https://www.gpt-video.com/api/v1")
        out = io.BytesIO()
        self.assertEqual(gv.download(LINK, out), 6)
        self.assertEqual(out.getvalue(), b"abcdef")
        self.assertEqual(wire.calls[0].url, LINK)
        self.assertNotIn("authorization", wire.calls[0].headers)
        self.assertTrue(wire.calls[0].headers["user-agent"].startswith("gpt-video-python/"))
        self.assertTrue(wire.opened[0].closed)

    def test_opens_only_https_links_and_http_to_this_machine(self) -> None:
        gv, wire, _ = client([{"status": 200, "chunks": [b"x"]}])
        self.assertEqual(gv.download("http://127.0.0.1:9000/f.mp4", io.BytesIO()), 1)
        cases = {
            "http://www.gpt-video.com/f.mp4": "download takes an https:// link",
            "ftp://www.gpt-video.com/f.mp4": "download takes an absolute link",
            "/files/f.mp4": "download takes an absolute link",
            "https://user:pass@www.gpt-video.com/f.mp4": "must not hold a user name or a password",
            "https://www.gpt-video.com/a b.mp4": "download takes an absolute link",
        }
        for url, part in cases.items():
            with self.assertRaises(GptVideoError, msg=url) as caught:
                gv.download(url, io.BytesIO())
            self.assertIn(part, caught.exception.message)
        with self.assertRaises(GptVideoError):
            gv.download(42, io.BytesIO())  # type: ignore[arg-type]
        with self.assertRaises(GptVideoError) as caught:
            gv.download(LINK, 42)
        self.assertIn("download takes a destination", caught.exception.message)
        self.assertEqual(len(wire.calls), 1)

    def test_stops_a_redirect_to_an_address_that_is_not_https_and_follows_one_that_is_still_without_the_key(self) -> None:
        gv, wire, _ = client([{"status": 302, "headers": {"Location": "http://cdn.example.com/f.mp4"}, "text": ""}])
        with self.assertRaises(GptVideoNetworkError) as caught:
            gv.download(LINK, io.BytesIO())
        self.assertIn(MESSAGES["download_insecure"], caught.exception.message)
        self.assertEqual(len(wire.calls), 1)
        gv, wire, _ = client([{"status": 307, "headers": {"Location": "https://cdn.example.com/f.mp4?t=1"}, "text": ""}, {"status": 200, "chunks": [b"ok"]}])
        out = io.BytesIO()
        gv.download(LINK, out)
        self.assertEqual(out.getvalue(), b"ok")
        self.assertEqual([c.url for c in wire.calls], [LINK, "https://cdn.example.com/f.mp4?t=1"])
        self.assertTrue(all("authorization" not in c.headers for c in wire.calls))

    def test_says_the_link_was_refused_on_403_and_does_not_retry_it(self) -> None:
        gv, wire, _ = client([{"status": 403, "text": "<Error>Expired</Error>"}])
        with self.assertRaises(GptVideoNetworkError) as caught:
            gv.download(LINK, io.BytesIO())
        error = caught.exception
        self.assertEqual((error.code, error.status, error.retryable, error.operation), ("BAD_RESPONSE", 403, False, "download"))
        self.assertIn(MESSAGES["download_refused"], error.message)
        self.assertNotIn("Expired", error.message)
        self.assertEqual(len(wire.calls), 1)

    def test_retries_a_503_and_a_failed_connection_before_the_body_and_tells_on_retry(self) -> None:
        retries: List[RetryEvent] = []
        gv, wire, clock = client([{"status": 503, "headers": {"Retry-After": "2"}, "text": ""}, {"network": "connection_failed"}, {"status": 200, "chunks": [b"x"]}], on_retry=retries.append)
        self.assertEqual(gv.download(LINK, io.BytesIO()), 1)
        self.assertEqual([(r.operation, r.attempt, r.code) for r in retries], [("download", 1, "BAD_RESPONSE"), ("download", 2, "CONNECTION_FAILED")])
        self.assertEqual(retries[0].delay, 2.0)
        self.assertEqual(len(wire.calls), 3)

    def test_times_out_an_attempt_that_gets_no_headers_and_gives_up_at_the_deadline(self) -> None:
        gv, wire, clock = client([{"network": "hang"}] * 5)
        with self.assertRaises(GptVideoNetworkError) as caught:
            gv.download(LINK, io.BytesIO(), timeout=10, deadline=25)
        self.assertEqual((caught.exception.code, caught.exception.retryable), ("TIMEOUT", True))
        self.assertAlmostEqual(clock.now, 25, delta=0.001)

    def test_reads_the_body_within_its_idle_time_and_a_cancel_event_stops_it(self) -> None:
        gv, _, clock = client([{"status": 200, "chunks": [b"abc", "stall"]}])
        out = io.BytesIO()
        with self.assertRaises(GptVideoNetworkError) as caught:
            gv.download(LINK, out, timeout=7)
        self.assertEqual(caught.exception.code, "TIMEOUT")
        self.assertEqual(out.getvalue(), b"abc", "a file object keeps the bytes it got")
        gv, _, clock = client([{"status": 200, "chunks": [b"abc", "stall"]}])
        cancel = threading.Event()
        clock.at(3, cancel.set)
        with self.assertRaises(GptVideoNetworkError) as caught:
            gv.download(LINK, io.BytesIO(), cancel=cancel)
        self.assertEqual((caught.exception.code, clock.now), ("ABORTED", 3))

    def test_a_path_is_written_whole_or_left_as_it_was(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "clip.mp4")
            gv, _, _ = client([{"status": 200, "chunks": [b"new ", b"file"]}, {"status": 200, "chunks": [b"partial", "reset"]}])
            self.assertEqual(gv.download(LINK, path), 8)
            with open(path, "rb") as f:
                self.assertEqual(f.read(), b"new file")
            with self.assertRaises(GptVideoNetworkError) as caught:
                gv.download(LINK, path)
            self.assertEqual(caught.exception.code, "CONNECTION_FAILED")
            with open(path, "rb") as f:
                self.assertEqual(f.read(), b"new file")
            self.assertEqual(os.listdir(folder), ["clip.mp4"])
