"""Uploading a file in parts: the part size of the API, the parts in parallel, a slow part, a failed part, a
complete that finds parts missing, and the cancel of an upload that failed."""

import io
import json
import os
import tempfile
import threading
import time
import unittest
import urllib.parse
from typing import Any, Callable, Dict, List, Optional

from gpt_video import GptVideo, GptVideoApiError, GptVideoNetworkError, UploadProgress
from gpt_video.errors import MESSAGES, GptVideoError
from gpt_video.uploads import PART_TIMEOUT_MAX, PART_TIMEOUT_MIN, part_deadline, part_timeout

from .support import FakeClock, FakeWire, Recorded, api_key

KEY = api_key()
ASSET = {"asset": {"id": "ast_1", "kind": "video"}}


class UploadApi:
    """The upload operations of the API, enough for upload_file: it remembers the parts it received."""

    def __init__(self, part_size: int = 4, received: List[int] = [], complete: Optional[List[Dict[str, Any]]] = None) -> None:
        self.part_size = part_size
        self.first_received = list(received)
        self.parts: Dict[int, bytes] = {}
        self.complete_answers = list(complete or [])
        self.cancelled = threading.Event()
        self.size = 0
        self.on_part: Optional[Callable[[int, int], Optional[Dict[str, Any]]]] = None
        self.count = 0
        self.create_answer: Optional[Dict[str, Any]] = None
        self.lock = threading.Lock()

    def upload(self, received: List[int]) -> Dict[str, Any]:
        count = -(-self.size // self.part_size)
        return {"upload": {"id": "upl_1", "filename": "talk.mp4", "contentType": "video/mp4", "sizeBytes": self.size, "partSizeBytes": self.part_size, "partCount": count, "receivedParts": received}}

    def __call__(self, call: Recorded, index: int) -> Dict[str, Any]:
        path = urllib.parse.urlsplit(call.url).path
        if call.method == "POST" and path == "/v1/uploads":
            self.size = json.loads(call.body or b"{}")["sizeBytes"]
            return self.create_answer or {"status": 201, "json": self.upload(self.first_received)}
        if call.method == "PUT":
            number = int(path.rsplit("/", 1)[1])
            with self.lock:
                self.count += 1
                attempt = self.count
            if self.on_part is not None:
                instead = self.on_part(number, attempt)
                if instead is not None:
                    return instead
            with self.lock:
                self.parts[number] = call.body or b""
            return {"status": 200, "json": self.upload(sorted(self.parts))}
        if call.method == "POST" and path.endswith("/complete"):
            return self.complete_answers.pop(0) if self.complete_answers else {"status": 201, "json": ASSET}
        if call.method == "GET":
            return {"status": 200, "json": self.upload(sorted(self.parts))}
        if call.method == "DELETE":
            self.cancelled.set()
            return {"status": 200, "json": self.upload([])}
        raise AssertionError(f"unexpected {call.method} {path}")

    def joined(self) -> bytes:
        return b"".join(self.parts[n] for n in sorted(self.parts))


def client(api: UploadApi, **options: Any) -> "tuple[GptVideo, FakeWire]":
    clock = FakeClock()
    wire = FakeWire(clock, api)
    return GptVideo._with_wire(wire, clock, api_key=KEY, **options), wire


def calls(wire: FakeWire, method: str, ending: str = "") -> List[Recorded]:
    return [c for c in wire.calls if c.method == method and urllib.parse.urlsplit(c.url).path.endswith(ending)]


class Stream(io.RawIOBase):
    """A file that cannot seek, read in chunks of a few bytes."""

    def __init__(self, data: bytes, chunk: int = 3) -> None:
        self._data = data
        self._at = 0
        self._chunk = chunk

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return False

    def read(self, size: int = -1) -> bytes:
        n = self._chunk if size < 0 else min(size, self._chunk)
        out = self._data[self._at : self._at + n]
        self._at += len(out)
        return out


class UploadFile(unittest.TestCase):
    def test_opens_the_upload_sends_every_part_with_its_bytes_completes_once_and_returns_the_asset(self) -> None:
        api = UploadApi(part_size=4)
        gv, wire = client(api)
        progress: List[UploadProgress] = []
        data = b"0123456789"
        self.assertEqual(gv.upload_file(data, filename="talk.mp4", title="A talk", on_progress=progress.append), ASSET)
        create = calls(wire, "POST", "/v1/uploads")[0]
        self.assertEqual(json.loads(create.body or b""), {"filename": "talk.mp4", "sizeBytes": 10})
        self.assertEqual(api.joined(), data)
        self.assertEqual({n: len(b) for n, b in api.parts.items()}, {1: 4, 2: 4, 3: 2})
        complete = calls(wire, "POST", "/complete")
        self.assertEqual(len(complete), 1)
        self.assertEqual(json.loads(complete[0].body or b""), {"title": "A talk"})
        self.assertRegex(complete[0].headers["idempotency-key"], r"^[0-9a-f-]{36}$")
        sent = [p.uploaded_bytes for p in progress]
        self.assertEqual(sorted(b - a for a, b in zip([0, *sent], sent)), [2, 4, 4], "one step per part, of its size, in any order")
        self.assertEqual(sent[-1], 10)
        self.assertTrue(all(p.total_bytes == 10 for p in progress))
        for part in calls(wire, "PUT"):
            self.assertNotIn("idempotency-key", part.headers)
            self.assertEqual(part.headers["content-type"], "application/octet-stream")

    def test_reads_a_path_a_part_at_a_time_and_takes_its_name(self) -> None:
        api = UploadApi(part_size=5)
        gv, wire = client(api)
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "founder talk.mp4")
            with open(path, "wb") as f:
                f.write(b"abcdefghijklmnopq")
            gv.upload_file(path, content_type="video/mp4")
        self.assertEqual(json.loads(calls(wire, "POST", "/v1/uploads")[0].body or b""), {"filename": "founder talk.mp4", "sizeBytes": 17, "contentType": "video/mp4"})
        self.assertEqual(api.joined(), b"abcdefghijklmnopq")

    def test_reads_a_file_object_from_where_it_stands_and_a_stream_in_order(self) -> None:
        api = UploadApi(part_size=4)
        gv, _ = client(api)
        source = io.BytesIO(b"HEADER0123456789")
        source.seek(6)
        gv.upload_file(source, filename="talk.mp4")
        self.assertEqual(api.joined(), b"0123456789")
        api = UploadApi(part_size=4)
        gv, _ = client(api)
        gv.upload_file(Stream(b"0123456789"), filename="talk.mp4", size_bytes=10)
        self.assertEqual(api.joined(), b"0123456789")

    def test_uses_the_part_size_the_api_answers_and_skips_the_parts_it_already_holds(self) -> None:
        api = UploadApi(part_size=3, received=[2])
        gv, wire = client(api)
        gv.upload_file(b"aaabbbcc", filename="talk.mp4")
        self.assertEqual(sorted(api.parts), [1, 3])
        self.assertEqual((api.parts[1], api.parts[3]), (b"aaa", b"cc"))
        api = UploadApi(part_size=3, received=[1])
        gv, _ = client(api)
        gv.upload_file(Stream(b"aaabbbcc"), filename="talk.mp4", size_bytes=8)
        self.assertEqual((api.parts[2], api.parts[3]), (b"bbb", b"cc"), "the bytes of a part the API holds are read and dropped")

    def test_refuses_a_stream_shorter_or_longer_than_size_bytes_and_cancels_the_upload_it_opened(self) -> None:
        for data, part in ((b"0123456", "The file ended after"), (b"0123456789xy", "The file has more bytes than size_bytes, 10.")):
            api = UploadApi(part_size=4)
            gv, _ = client(api)
            with self.assertRaises(GptVideoError) as caught:
                gv.upload_file(Stream(data), filename="talk.mp4", size_bytes=10)
            self.assertIn(part, caught.exception.message)
            self.assertTrue(api.cancelled.wait(5), "the upload is cancelled")

    def test_holds_at_most_concurrency_parts_in_flight(self) -> None:
        api = UploadApi(part_size=2)
        in_flight = [0]
        most = [0]

        def hold(number: int, attempt: int) -> None:
            with api.lock:
                in_flight[0] += 1
                most[0] = max(most[0], in_flight[0])
            time.sleep(0.03)
            with api.lock:
                in_flight[0] -= 1
            return None

        api.on_part = hold  # type: ignore[assignment]
        gv, _ = client(api)
        gv.upload_file(b"x" * 20, filename="talk.mp4", concurrency=3)
        self.assertEqual(most[0], 3)
        self.assertEqual(len(api.parts), 10)

    def test_retries_a_slow_part_on_its_own_never_restarts_the_others_and_goes_one_part_at_a_time_after(self) -> None:
        api = UploadApi(part_size=2)
        in_flight = [0]
        timed_out = threading.Event()
        crowded_after: List[int] = []

        def slow(number: int, attempt: int) -> Optional[Dict[str, Any]]:
            if number == 2 and not timed_out.is_set():
                timed_out.set()
                return {"network": "timeout"}
            with api.lock:
                in_flight[0] += 1
                if timed_out.is_set() and number > 5:
                    crowded_after.append(in_flight[0])
            time.sleep(0.02)
            with api.lock:
                in_flight[0] -= 1
            return None

        api.on_part = slow
        gv, wire = client(api)
        gv.upload_file(b"y" * 20, filename="talk.mp4", concurrency=4)
        self.assertEqual(api.joined(), b"y" * 20)
        sent = [int(urllib.parse.urlsplit(c.url).path.rsplit("/", 1)[1]) for c in calls(wire, "PUT")]
        self.assertEqual(sent.count(2), 2, "the slow part is sent again")
        self.assertEqual(sorted(set(sent)), list(range(1, 11)))
        self.assertTrue(all(n == 1 for n in crowded_after), f"after a timeout one part at a time: {crowded_after}")

    def test_stops_the_other_parts_when_one_fails_gives_that_failure_and_cancels_the_upload(self) -> None:
        api = UploadApi(part_size=1)
        api.on_part = lambda number, attempt: {"status": 400, "json": {"error": {"code": "VALIDATION_FAILED", "message": "Part 3 is wrong."}}} if number == 3 else None
        gv, wire = client(api)
        with self.assertRaises(GptVideoApiError) as caught:
            gv.upload_file(b"z" * 40, filename="talk.mp4", concurrency=2)
        self.assertEqual(caught.exception.code, "VALIDATION_FAILED")
        self.assertTrue(api.cancelled.wait(5))
        self.assertLess(len(calls(wire, "PUT")), 40, "the parts after the failure are not sent")
        self.assertEqual(calls(wire, "POST", "/complete"), [])

    def test_sends_again_the_parts_a_complete_finds_missing_and_asks_again_with_the_same_key(self) -> None:
        conflict = {"status": 409, "json": {"error": {"code": "CONFLICT", "message": "Part 2 is missing."}}}
        api = UploadApi(part_size=4, complete=[conflict])
        progress: List[int] = []
        lost = [False]

        def lose_two(number: int, attempt: int) -> Optional[Dict[str, Any]]:
            if number == 2 and not lost[0]:
                lost[0] = True
                return {"status": 200, "json": api.upload([])}
            return None

        api.on_part = lose_two
        gv, wire = client(api)
        self.assertEqual(gv.upload_file(b"0123456789", filename="talk.mp4", on_progress=lambda p: progress.append(p.uploaded_bytes)), ASSET)
        completes = calls(wire, "POST", "/complete")
        self.assertEqual(len(completes), 2)
        self.assertEqual(completes[0].headers["idempotency-key"], completes[1].headers["idempotency-key"])
        self.assertEqual(api.joined(), b"0123456789")
        self.assertEqual(progress[-1], 10, "the progress ends at the whole file")
        self.assertEqual(len(calls(wire, "GET")), 1)

    def test_gives_the_refusal_of_a_complete_when_nothing_is_missing_and_cancels_the_upload(self) -> None:
        conflict = {"status": 409, "json": {"error": {"code": "CONFLICT", "message": "The upload is being completed."}}}
        api = UploadApi(part_size=4, complete=[conflict])
        gv, wire = client(api)
        with self.assertRaises(GptVideoApiError) as caught:
            gv.upload_file(b"0123456789", filename="talk.mp4")
        self.assertEqual(caught.exception.code, "CONFLICT")
        self.assertTrue(api.cancelled.wait(5))

    def test_cannot_send_the_parts_of_a_stream_again_the_refusal_of_a_complete_comes_back_as_it_is(self) -> None:
        conflict = {"status": 409, "json": {"error": {"code": "CONFLICT", "message": "Part 2 is missing."}}}
        api = UploadApi(part_size=4, complete=[conflict])
        gv, wire = client(api)
        with self.assertRaises(GptVideoApiError):
            gv.upload_file(Stream(b"0123456789"), filename="talk.mp4", size_bytes=10)
        self.assertEqual(calls(wire, "GET"), [])

    def test_says_where_else_to_upload_when_uploads_are_turned_off_and_has_nothing_to_cancel(self) -> None:
        api = UploadApi()
        api.create_answer = {"status": 503, "json": {"error": {"code": "UNAVAILABLE", "message": "Uploads are turned off.", "details": {"reason": "switched_off"}}}}
        gv, wire = client(api)
        with self.assertRaises(GptVideoApiError) as caught:
            gv.upload_file(b"0123", filename="talk.mp4")
        self.assertTrue(caught.exception.message.endswith(MESSAGES["upload_elsewhere"]))
        self.assertFalse(caught.exception.retryable)
        time.sleep(0.05)
        self.assertEqual(calls(wire, "DELETE"), [])
        self.assertEqual(len(wire.calls), 1, "a switched-off operation is not retried")

    def test_refuses_an_answer_whose_parts_do_not_cover_the_file_and_cancels_that_upload(self) -> None:
        api = UploadApi(part_size=4)
        wrong = api.upload([])
        wrong["upload"]["partCount"] = 1
        wrong["upload"]["sizeBytes"] = 10
        api.size = 10
        api.create_answer = {"status": 201, "json": wrong}
        gv, wire = client(api)
        with self.assertRaises(GptVideoNetworkError) as caught:
            gv.upload_file(b"0123456789", filename="talk.mp4")
        self.assertEqual(caught.exception.code, "BAD_RESPONSE")
        self.assertIn("The API split a file of 10 bytes into 1 parts of 4 bytes, which does not cover it.", caught.exception.message)
        self.assertTrue(api.cancelled.wait(5))
        self.assertEqual(calls(wire, "PUT"), [])

    def test_stops_on_the_cancel_event_and_still_cancels_the_upload(self) -> None:
        api = UploadApi(part_size=1)
        cancel = threading.Event()

        def stop(number: int, attempt: int) -> None:
            if number == 3:
                cancel.set()
            return None

        api.on_part = stop  # type: ignore[assignment]
        gv, wire = client(api)
        with self.assertRaises(GptVideoNetworkError) as caught:
            gv.upload_file(b"c" * 50, filename="talk.mp4", concurrency=1, cancel=cancel)
        self.assertEqual(caught.exception.code, "ABORTED")
        self.assertTrue(api.cancelled.wait(5))
        self.assertLess(len(calls(wire, "PUT")), 50)

    def test_checks_its_arguments_before_anything_is_sent(self) -> None:
        api = UploadApi()
        gv, wire = client(api)
        cases = [
            ((42,), {}, "upload_file takes the path of a file, bytes, or a file opened in binary mode"),
            ((b"",), {"filename": "a.mp4"}, "The file is empty."),
            ((b"x",), {}, "upload_file needs a filename"),
            ((b"x",), {"filename": "a.mp4", "concurrency": 0}, "concurrency must be a whole number from 1 to 16."),
            ((b"x",), {"filename": "a.mp4", "concurrency": 17}, "concurrency must be a whole number from 1 to 16."),
            ((b"x",), {"filename": "a.mp4", "concurrency": True}, "concurrency must be a whole number from 1 to 16."),
            ((b"x",), {"filename": "a.mp4", "size_bytes": 2}, "size_bytes is 2, and the file has 1 bytes."),
            ((b"x",), {"filename": "a.mp4", "size_bytes": 0}, "size_bytes must be a whole number of bytes, 1 or more."),
            ((b"x",), {"filename": ""}, "filename must be a non-empty string."),
            ((b"x",), {"filename": "a.mp4", "content_type": 3}, "content_type must be a non-empty string."),
            ((b"x",), {"filename": "a.mp4", "on_progress": "print"}, "on_progress must be a function."),
            ((Stream(b"x"),), {"filename": "a.mp4"}, "upload_file needs size_bytes for a file that cannot seek"),
            ((io.StringIO("text"),), {"filename": "a.mp4"}, "open the file in binary mode"),
            ((b"x",), {"filename": "a.mp4", "cancel": "stop"}, "cancel must be a threading.Event"),
        ]
        for args, options, part in cases:
            with self.assertRaises(GptVideoError, msg=part) as caught:
                gv.upload_file(*args, **options)
            self.assertEqual(caught.exception.code, "INVALID_ARGUMENT")
            self.assertIn(part, caught.exception.message)
        self.assertEqual(wire.calls, [])


class PartTime(unittest.TestCase):
    def test_grows_with_its_size_from_one_minute_at_100_kb_a_second_up_to_ten(self) -> None:
        self.assertEqual(part_timeout(0), PART_TIMEOUT_MIN)
        self.assertEqual(part_timeout(6_000_000), 60.0)
        self.assertEqual(part_timeout(8 * 1024 * 1024), 83.887)
        self.assertEqual(part_timeout(10**9), PART_TIMEOUT_MAX)

    def test_has_a_deadline_that_fits_every_attempt_with_its_whole_timeout_and_every_pause_at_its_longest(self) -> None:
        self.assertEqual(part_deadline(60, 2), 3 * 60 + 2 * 60)
        self.assertEqual(part_deadline(600, 0), 600)
