"""Waiting for work that finishes later: the reads with ?wait=, the end of the work, the pauses, the slots."""

import threading
import time
import unittest
import urllib.parse
from typing import Any, Dict, List

from gpt_video import GptVideo, GptVideoApiError, GptVideoJobError, GptVideoNetworkError
from gpt_video.errors import GptVideoError
from gpt_video.waiting import EARLY_ANSWER_PAUSE, FINAL_STATUSES, READ_GRACE, WAIT_READ_SEC, WaitSlots, is_final, read_times

from .support import FakeClock, FakeWire, api_key

KEY = api_key()


def job(status: str, finished: bool = False, **more: Any) -> Dict[str, Any]:
    return {"job": {"id": "job_1", "status": status, "finishedAt": "2026-10-11T12:00:00.000Z" if finished else None, "errorMessage": None, **more}}


def held(body: Dict[str, Any], seconds: float = WAIT_READ_SEC) -> Dict[str, Any]:
    """An answer the API held for the whole ?wait=."""
    return {"status": 200, "json": body, "afterMs": seconds * 1000}


def client(script: List[Dict[str, Any]], **options: Any) -> "tuple[GptVideo, FakeWire, FakeClock]":
    clock = FakeClock()
    wire = FakeWire(clock, script)
    return GptVideo._with_wire(wire, clock, api_key=KEY, **options), wire, clock


def query(url: str) -> Dict[str, str]:
    return dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))


class AWait(unittest.TestCase):
    def test_reads_the_job_with_wait_25_until_it_is_done_and_returns_it_as_the_last_read_gave_it(self) -> None:
        gv, wire, clock = client([held(job("queued")), held(job("running", progress=0.5)), {"status": 200, "json": job("done", True, progress=1)}])
        done = gv.wait({"job": {"id": "job_1", "status": "queued", "finishedAt": None}})
        self.assertEqual(done["status"], "done")
        self.assertEqual(done["progress"], 1)
        self.assertEqual([urllib.parse.urlsplit(c.url).path for c in wire.calls], ["/v1/jobs/job_1"] * 3)
        self.assertEqual([query(c.url) for c in wire.calls], [{"wait": "25"}] * 3)
        self.assertEqual(clock.sleeps, [], "a read held for its whole wait is followed at once")

    def test_keeps_waiting_on_an_export_that_is_rendering_and_returns_it_with_its_link(self) -> None:
        rendering = {"export": {"id": "exp_1", "status": "rendering", "finishedAt": None, "downloadUrl": None}}
        done = {"export": {"id": "exp_1", "status": "done", "finishedAt": "2026-10-11T12:00:00.000Z", "downloadUrl": "https://www.gpt-video.com/f"}}
        gv, wire, _ = client([held(rendering), {"status": 200, "json": done}])
        self.assertEqual(gv.wait({"export": {"id": "exp_1"}})["downloadUrl"], "https://www.gpt-video.com/f")
        self.assertEqual(urllib.parse.urlsplit(wire.calls[0].url).path, "/v1/exports/exp_1")

    def test_follows_a_tool_run_and_an_assistant_turn_with_their_own_reads(self) -> None:
        gv, wire, _ = client([{"status": 200, "json": {"toolRun": {"id": "trn_1", "status": "done", "finishedAt": "x"}}}, {"status": 200, "json": {"turn": {"id": "tur_1", "status": "done", "finishedAt": "x"}}}])
        gv.wait({"toolRun": {"id": "trn_1"}})
        gv.wait({"turn": {"id": "tur_1"}})
        self.assertEqual([urllib.parse.urlsplit(c.url).path for c in wire.calls], ["/v1/tool-runs/trn_1", "/v1/assistant/turns/tur_1"])

    def test_pauses_3_to_5_seconds_after_a_read_that_came_back_early_without_a_final_status(self) -> None:
        for draw in (0.0, 0.999999):
            gv, wire, clock = client([{"status": 200, "json": job("queued")}, {"status": 200, "json": job("done", True)}])
            clock.random_value = draw
            gv.wait({"job": {"id": "job_1"}})
            self.assertEqual(len(clock.sleeps), 1)
            self.assertGreaterEqual(clock.sleeps[0], EARLY_ANSWER_PAUSE[0])
            self.assertLess(clock.sleeps[0], EARLY_ANSWER_PAUSE[0] + EARLY_ANSWER_PAUSE[1])

    def test_ends_on_a_status_it_does_not_know_when_finished_at_is_set(self) -> None:
        gv, wire, _ = client([{"status": 200, "json": job("archived", True)}])
        self.assertEqual(gv.wait({"job": {"id": "job_1"}})["status"], "archived")
        self.assertEqual(len(wire.calls), 1)

    def test_without_a_final_status_or_finished_at_ends_at_its_time_with_wait_timeout_and_the_last_object(self) -> None:
        clock = FakeClock()
        # the API holds each read for the wait it asks for, and no longer
        wire = FakeWire(clock, lambda call, _: {"status": 200, "json": job("mystery", errorMessage="still thinking"), "afterMs": int(query(call.url)["wait"]) * 1000})
        gv = GptVideo._with_wire(wire, clock, api_key=KEY)
        with self.assertRaises(GptVideoJobError) as caught:
            gv.wait({"job": {"id": "job_1"}}, timeout=60)
        error = caught.exception
        self.assertEqual((error.code, error.retryable, error.operation), ("WAIT_TIMEOUT", True, "get_job"))
        self.assertEqual(error.handle["status"], "mystery")
        self.assertEqual(error.error_message, "still thinking")
        self.assertIn("job_1 did not finish within 60 seconds. Its last status is mystery.", error.message)
        self.assertAlmostEqual(clock.now, 60, delta=0.001)

    def test_raises_on_work_that_failed_with_the_object_and_what_went_wrong(self) -> None:
        gv, _, _ = client([{"status": 200, "json": job("failed", True, errorMessage="The video has no sound.")}])
        with self.assertRaises(GptVideoJobError) as caught:
            gv.wait({"job": {"id": "job_1"}})
        error = caught.exception
        self.assertEqual((error.code, error.error_message, error.handle["status"]), ("JOB_FAILED", "The video has no sound.", "failed"))
        self.assertEqual(error.message, "JOB_FAILED: job_1 failed. The video has no sound.")

    def test_raises_job_cancelled_and_returns_either_object_with_throw_on_failure_false(self) -> None:
        gv, _, _ = client([{"status": 200, "json": job("cancelled", True)}] * 3 + [{"status": 200, "json": job("failed", True)}])
        with self.assertRaises(GptVideoJobError) as caught:
            gv.wait({"job": {"id": "job_1"}})
        self.assertEqual(caught.exception.code, "JOB_CANCELLED")
        self.assertEqual(gv.wait({"job": {"id": "job_1"}}, throw_on_failure=False)["status"], "cancelled")
        self.assertEqual(gv.wait_for_job("job_1", throw_on_failure=False)["status"], "cancelled")
        self.assertEqual(gv.wait_for_job("job_1", throw_on_failure=False)["status"], "failed")

    def test_tells_on_progress_of_every_read_and_ignores_what_it_raises(self) -> None:
        seen: List[str] = []

        def progress(current: Dict[str, Any]) -> None:
            seen.append(current["status"])
            raise RuntimeError("the progress bar broke")

        gv, _, _ = client([held(job("queued")), held(job("running")), {"status": 200, "json": job("done", True)}])
        gv.wait({"job": {"id": "job_1"}}, on_progress=progress)
        self.assertEqual(seen, ["queued", "running", "done"])

    def test_stops_on_the_cancel_event_in_a_read_and_in_a_pause(self) -> None:
        gv, _, clock = client([{"network": "hang"}])
        cancel = threading.Event()
        clock.at(2, cancel.set)
        with self.assertRaises(GptVideoNetworkError) as caught:
            gv.wait({"job": {"id": "job_1"}}, cancel=cancel)
        self.assertEqual((caught.exception.code, clock.now), ("ABORTED", 2))
        gv, _, clock = client([{"status": 200, "json": job("queued")}])
        cancel = threading.Event()
        clock.at(1, cancel.set)
        with self.assertRaises(GptVideoNetworkError) as caught:
            gv.wait({"job": {"id": "job_1"}}, cancel=cancel)
        self.assertEqual((caught.exception.code, clock.now), ("ABORTED", 1))

    def test_never_lets_its_last_read_outlast_it_by_more_than_the_grace(self) -> None:
        gv, _, clock = client([{"network": "hang"}] * 5)
        with self.assertRaises(GptVideoError):
            gv.wait({"job": {"id": "job_1"}}, timeout=10)
        self.assertLessEqual(clock.now, 10 + READ_GRACE + 0.001)

    def test_ends_with_the_error_of_a_read_that_fails_after_its_own_retries_and_sends_no_more_reads(self) -> None:
        refused = {"status": 404, "json": {"error": {"code": "NOT_FOUND", "message": "There is no job job_1."}}}
        gv, wire, _ = client([refused])
        with self.assertRaises(GptVideoApiError) as caught:
            gv.wait({"job": {"id": "job_1"}})
        self.assertEqual(caught.exception.code, "NOT_FOUND")
        self.assertEqual(len(wire.calls), 1)

    def test_holds_its_reads_for_25_seconds_even_on_a_client_whose_calls_time_out_sooner(self) -> None:
        gv, wire, _ = client([held(job("running")), {"status": 200, "json": job("done", True)}], timeout=5, deadline=8)
        self.assertEqual(gv.wait({"job": {"id": "job_1"}})["status"], "done")
        self.assertEqual(len(wire.calls), 2)

    def test_gives_each_read_an_attempt_longer_than_its_wait_and_retries_that_end_with_the_wait(self) -> None:
        self.assertEqual(read_times((2, 60.0, 180.0), 25, 3600), (60.0, 180.0))
        self.assertEqual(read_times((2, 5.0, 8.0), 25, 3600), (35.0, 35.0))
        self.assertEqual(read_times((2, 60.0, 180.0), 3, 3.5), (60.0, 13.5))


class LongForms(unittest.TestCase):
    def test_take_an_id_the_object_or_the_answer_that_carries_it(self) -> None:
        done = {"status": 200, "json": job("done", True)}
        gv, wire, _ = client([done] * 3)
        gv.wait_for_job("job_1")
        gv.wait_for_job({"id": "job_1"})
        gv.wait_for_job({"job": {"id": "job_1"}})
        self.assertEqual([urllib.parse.urlsplit(c.url).path for c in wire.calls], ["/v1/jobs/job_1"] * 3)
        gv, wire, _ = client([{"status": 200, "json": {"export": {"id": "exp_1", "status": "done", "finishedAt": "x"}}}])
        gv.wait_for_export({"export": {"id": "exp_1"}})
        self.assertEqual(urllib.parse.urlsplit(wire.calls[0].url).path, "/v1/exports/exp_1")

    def test_say_what_they_take_when_given_something_else(self) -> None:
        gv, wire, _ = client([])
        for target in (None, 3, "", {"id": ""}, {"job": {}}):
            with self.assertRaises(GptVideoError) as caught:
                gv.wait_for_job(target)  # type: ignore[arg-type]
            self.assertIn("wait_for_job takes an id, the job object, or the answer that carries it.", caught.exception.message)
        self.assertEqual(wire.calls, [])


class Wait(unittest.TestCase):
    def test_takes_only_the_answer_of_a_call_that_starts_work(self) -> None:
        gv, wire, _ = client([])
        for result in (None, "job_1", {}, {"job": "job_1"}, {"job": {"id": "a"}, "export": {"id": "b"}}):
            with self.assertRaises(GptVideoError, msg=repr(result)) as caught:
                gv.wait(result)  # type: ignore[arg-type]
            self.assertIn("wait takes the answer of a call that starts work: a dict with one of job, export, toolRun, turn.", caught.exception.message)
        with self.assertRaises(GptVideoError) as caught:
            gv.wait({"job": {"id": ""}})
        self.assertIn("job.id must be a non-empty string.", caught.exception.message)
        with self.assertRaises(GptVideoError):
            gv.wait({"job": {"id": "job_1"}}, timeout=0)
        self.assertEqual(wire.calls, [])


class Slots(unittest.TestCase):
    def test_hold_at_most_four_reads_and_hand_the_next_one_its_place_when_one_ends(self) -> None:
        slots = WaitSlots(4)
        for _ in range(4):
            self.assertTrue(slots.acquire(1, None))
        started = time.monotonic()
        self.assertFalse(slots.acquire(0.2, None))
        self.assertGreaterEqual(time.monotonic() - started, 0.15)
        threading.Timer(0.1, slots.release).start()
        self.assertTrue(slots.acquire(2, None))

    def test_give_up_the_place_in_line_when_the_cancel_event_is_set(self) -> None:
        slots = WaitSlots(1)
        self.assertTrue(slots.acquire(1, None))
        cancel = threading.Event()
        threading.Timer(0.1, cancel.set).start()
        started = time.monotonic()
        self.assertFalse(slots.acquire(10, cancel))
        self.assertLess(time.monotonic() - started, 2)
        slots.release()
        self.assertTrue(slots.acquire(1, None), "the place given up is not lost")


class TheEndOfWork(unittest.TestCase):
    def test_is_a_final_status_or_a_finished_at_whatever_the_status_says(self) -> None:
        for status in FINAL_STATUSES:
            self.assertTrue(is_final({"status": status, "finishedAt": None}), status)
        for status in ("queued", "running", "rendering", "new"):
            self.assertFalse(is_final({"status": status, "finishedAt": None}), status)
            self.assertTrue(is_final({"status": status, "finishedAt": "2026-10-11T12:00:00.000Z"}), status)
        self.assertEqual(FINAL_STATUSES, ("done", "failed", "cancelled"))
