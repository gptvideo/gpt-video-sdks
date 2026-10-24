"""Every scenario of retry.json, the shared retry vectors, run on the real Transport with a scripted wire and a fake
clock: the requests sent, the Idempotency-Key of each, every pause (through on_retry), the time the call took, and
the result or the error, field by field. Each scenario runs three times, with the random draw of the backoff at 0,
0.5 and just under 1, so a backoff is checked at both ends of its range."""

import math
import re
import threading
import unittest
from typing import Any, Dict, List

from gpt_video._retry import BACKOFF_BASE_MS, BACKOFF_CAP_MS, DEADLINE, MAX_RETRIES, RETRY_AFTER_MAX_SEC, TIMEOUT
from gpt_video._transport import Transport, resolve_settings
from gpt_video.client import RETRYABLE_CODES
from gpt_video.errors import MESSAGES, GptVideoApiError, GptVideoError, GptVideoNetworkError

from .support import Events, FakeClock, FakeWire, api_key, expand, read_vectors

RETRY = read_vectors("retry.json")
KEYS = read_vectors("keys.json")
GENERATED_KEY = re.compile(KEYS["generators"]["python"]["pattern"])
API_KEY = api_key()
RANDOMS = (0.0, 0.5, 0.999999)


def _wall(iso: str) -> float:
    """2026-10-11T12:00:00.400Z as seconds since 1970."""
    from datetime import datetime, timezone

    return datetime.strptime(iso, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc).timestamp()


def spec_of(name: str) -> Dict[str, Any]:
    op = RETRY["operations"][name]
    return {
        "id": f"{name}_call",
        "name": f"{name}Call",
        "method": op["method"],
        "path": "/v1/things/{thingId}",
        "pathParams": ("thingId",),
        "inQuery": op["method"] == "GET",
        "binary": None,
        "effect": op["effect"],
        "idempotencyKey": op["idempotencyKey"],
        "retrySafe": op["retrySafe"],
        "async": None,
        "paginated": False,
        "successStatus": 200,
    }


def run(scenario: Dict[str, Any], random: float) -> Dict[str, Any]:
    clock = FakeClock(start_wall=_wall(scenario.get("now", RETRY["defaults"]["now"])), rand=random)
    wire = FakeWire(clock, expand(scenario["responses"]))
    events = Events()
    transport = Transport(
        resolve_settings(api_key=API_KEY, on_retry=events.retries.append, on_response=events.responses.append),
        RETRYABLE_CODES,
        wire=wire,
        clock=clock,
    )
    o = scenario.get("options", {})
    cancel = threading.Event()
    if o.get("abortedBeforeStart"):
        cancel.set()
    if "abortAfterMs" in o:
        clock.at(o["abortAfterMs"] / 1000, cancel.set)
    options: Dict[str, Any] = {"cancel": cancel}
    if "maxRetries" in o:
        options["max_retries"] = o["maxRetries"]
    if "timeoutMs" in o:
        options["timeout"] = o["timeoutMs"] / 1000
    if "deadlineMs" in o:
        options["deadline"] = o["deadlineMs"] / 1000
    if "idempotencyKey" in o:
        options["idempotency_key"] = o["idempotencyKey"]
    outcome: Dict[str, Any] = {"wire": wire, "events": events}
    try:
        outcome["value"] = transport.send(spec_of(scenario["operation"]), {"thingId": "thing_1"}, options)
    except GptVideoError as error:
        outcome["error"] = error
    outcome["elapsed_ms"] = round(clock.now * 1000)
    return outcome


class RetryVectors(unittest.TestCase):
    def test_the_file_has_the_scenarios_this_runner_expects(self) -> None:
        self.assertEqual(RETRY["version"], 1)
        self.assertGreaterEqual(len(RETRY["scenarios"]), 40)

    def test_the_defaults_are_the_engine_defaults(self) -> None:
        defaults = RETRY["defaults"]
        self.assertEqual(defaults["maxRetries"], MAX_RETRIES)
        self.assertEqual(defaults["timeoutMs"], TIMEOUT * 1000)
        self.assertEqual(defaults["deadlineMs"], DEADLINE * 1000)
        self.assertEqual(defaults["retryAfterMaxSec"], RETRY_AFTER_MAX_SEC)
        self.assertEqual(defaults["backoff"], {"baseMs": BACKOFF_BASE_MS, "capMs": BACKOFF_CAP_MS})

    def check(self, scenario: Dict[str, Any], random: float) -> None:
        got = run(scenario, random)
        want = scenario["expect"]
        o = scenario.get("options", {})
        wire: FakeWire = got["wire"]
        events: Events = got["events"]

        self.assertEqual(len(wire.calls), want["requests"], "requests")
        self.assertEqual(wire.left, 0, "answers left unused")
        keys = [call.headers.get("idempotency-key") for call in wire.calls]
        if want["requests"] > 0:
            if want["key"] == "none":
                self.assertTrue(all(k is None for k in keys), "no key on any request")
            else:
                self.assertEqual(len(set(keys)), 1, "one key on every request")
                if want["key"] == "caller":
                    self.assertEqual(keys[0], o["idempotencyKey"])
                else:
                    self.assertRegex(keys[0], GENERATED_KEY)
        for call in wire.calls:
            self.assertEqual(call.headers.get("authorization"), f"Bearer {API_KEY}")

        self.assertEqual([r.code for r in events.retries], [s["after"] for s in want["sleeps"]], "pauses")
        for i, pause in enumerate(want["sleeps"]):
            event = events.retries[i]
            self.assertEqual(event.attempt, i + 1, f"pause {i + 1} follows attempt {i + 1}")
            ms = pause["ms"] if "ms" in pause else math.floor(random * min(RETRY["defaults"]["backoff"]["capMs"], RETRY["defaults"]["backoff"]["baseMs"] * 2 ** pause["backoff"]))
            self.assertEqual(round(event.delay * 1000), ms, f"pause {i + 1}")
            self.assertEqual(event.operation, f"{scenario['operation']}_call")
        if "elapsedMs" in want:
            self.assertEqual(got["elapsed_ms"], want["elapsedMs"], "elapsedMs")

        if "result" in want:
            self.assertNotIn("error", got, "no error")
            self.assertEqual(events.responses[-1].status, want["result"]["status"], "status of the answer")
            self.assertEqual(got["value"], expand(scenario["responses"])[-1].get("json"))
            return

        e = want["error"]
        error = got.get("error")
        self.assertIsInstance(error, GptVideoError)
        assert isinstance(error, GptVideoError)
        if e["class"] == "api":
            self.assertIsInstance(error, GptVideoApiError)
        if e["class"] == "network":
            self.assertIsInstance(error, GptVideoNetworkError)
        if e["class"] == "local":
            self.assertNotIsInstance(error, (GptVideoApiError, GptVideoNetworkError))
        self.assertEqual(error.code, e["code"])
        self.assertEqual(getattr(error, "status", None), e["status"], "status")
        self.assertEqual(error.retryable, e["retryable"], "retryable")
        self.assertEqual(error.may_have_spent, e["mayHaveSpent"], "may_have_spent")
        self.assertEqual(getattr(error, "retry_after_sec", None), e["retryAfterSec"], "retry_after_sec")
        if "requestId" in e:
            self.assertEqual(getattr(error, "request_id", None), e["requestId"])
        if e["key"] is None:
            self.assertIsNone(error.idempotency_key)
        elif e["key"] == "caller":
            self.assertEqual(error.idempotency_key, o["idempotencyKey"])
        elif want["requests"] > 0:
            self.assertEqual(error.idempotency_key, keys[0])
        else:
            self.assertRegex(error.idempotency_key or "", GENERATED_KEY)
        self.assertTrue(error.message.startswith(e["code"]), error.message)
        self.assertEqual(MESSAGES["may_have_spent"] in error.message, e["mayHaveSpent"], "the charge sentence goes with may_have_spent")
        self.assertNotIn(API_KEY, error.message)
        self.assertNotIn(API_KEY, repr(vars(error)))


def _add(scenario: Dict[str, Any], random: float) -> None:
    name = "test_" + re.sub(r"\W", "_", scenario["name"]) + f"__random_{str(random).replace('.', '_')}"

    def test(self: RetryVectors) -> None:
        self.check(scenario, random)

    test.__doc__ = f"{scenario['name']} (random {random}): {scenario['why']}"
    setattr(RetryVectors, name, test)


for _scenario in RETRY["scenarios"]:
    for _random in RANDOMS:
        _add(_scenario, _random)
