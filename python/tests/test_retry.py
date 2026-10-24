"""The rules of one call, as pure functions: the Idempotency-Key (keys.json), Retry-After, the backoff, which
outcomes are retried and which may have spent."""

import re
import unittest
from typing import Any, Dict

from gpt_video._retry import (
    MAX_SAFE_INTEGER,
    Answer,
    ApiFailure,
    NetworkFailure,
    RateLimit,
    backoff_ms,
    is_idempotency_key,
    may_have_spent,
    new_idempotency_key,
    policy_of,
    retry_after_sec,
)
from gpt_video.client import RETRYABLE_CODES

from .support import read_vectors

KEYS = read_vectors("keys.json")
NOW = 1_791_720_000.0  # Sun, 11 Oct 2026 12:00:00 GMT
ANSWER = Answer(status=0, retry_after=None, request_id=None, replayed=False, rate_limit=RateLimit(None, None, None))


def api(code: str, status: int, details: Any = None) -> ApiFailure:
    return ApiFailure(code=code, status=status, message="", hint=None, details=details, request_id=None, answer=ANSWER)


def network(code: str, status: Any = None) -> NetworkFailure:
    return NetworkFailure(code=code, status=status, text="", answer=None)


SAFE: Dict[str, Any] = {"retrySafe": True, "effect": "spend"}
UNSAFE: Dict[str, Any] = {"retrySafe": False, "effect": "write"}


class IdempotencyKey(unittest.TestCase):
    def test_accepts_every_valid_key_of_keys_json_and_refuses_every_invalid_one(self) -> None:
        for entry in KEYS["valid"]:
            self.assertTrue(is_idempotency_key(entry["key"]), entry["why"])
        for entry in KEYS["invalid"]:
            self.assertFalse(is_idempotency_key(entry["key"]), entry["why"])
        self.assertFalse(is_idempotency_key(None))
        self.assertFalse(is_idempotency_key(42))

    def test_the_accepted_pattern_is_the_one_keys_json_writes(self) -> None:
        pattern = re.compile(KEYS["accepted"]["pattern"].lstrip("^").rstrip("$"))
        for entry in KEYS["valid"] + KEYS["invalid"]:
            self.assertEqual(pattern.fullmatch(entry["key"]) is not None, is_idempotency_key(entry["key"]), entry["why"])

    def test_is_made_as_keys_json_says_for_python_and_never_twice_the_same(self) -> None:
        pattern = re.compile(KEYS["generators"]["python"]["pattern"])
        made = [new_idempotency_key() for _ in range(2000)]
        for key in made:
            self.assertRegex(key, pattern)
            self.assertTrue(is_idempotency_key(key))
        self.assertEqual(len(set(made)), len(made))


class RetryAfter(unittest.TestCase):
    def test_reads_seconds_and_imf_fixdates(self) -> None:
        self.assertEqual(retry_after_sec("5", NOW), 5)
        self.assertEqual(retry_after_sec("0", NOW), 0)
        self.assertEqual(retry_after_sec(" \t3\t ", NOW), 3)
        self.assertEqual(retry_after_sec("Sun, 11 Oct 2026 12:00:07 GMT", NOW), 7)
        self.assertEqual(retry_after_sec("Sun, 11 Oct 2026 12:00:07 GMT", NOW + 0.4), 7, "6.6 seconds rounds up")
        self.assertEqual(retry_after_sec("Sun, 11 Oct 2026 12:00:00 GMT", NOW), 0)
        self.assertEqual(retry_after_sec("Mon, 11 Oct 2026 12:00:07 GMT", NOW), 7, "the weekday name is not checked")
        self.assertIsNotNone(retry_after_sec("Tue, 29 Feb 2028 12:00:00 GMT", NOW), "29 February of a leap year exists")

    def test_reads_digits_too_many_to_count_as_the_largest_safe_number_never_as_absent(self) -> None:
        self.assertEqual(retry_after_sec("9" * 30, NOW), MAX_SAFE_INTEGER)
        self.assertEqual(retry_after_sec(str(MAX_SAFE_INTEGER), NOW), MAX_SAFE_INTEGER)
        self.assertEqual(retry_after_sec(str(MAX_SAFE_INTEGER + 1), NOW), MAX_SAFE_INTEGER)

    def test_reads_more_digits_than_python_turns_into_an_int_without_raising(self) -> None:
        # int() refuses more than 4300 digits: a ValueError would escape send() with no idempotency_key
        self.assertEqual(retry_after_sec("9" * 5000, NOW), MAX_SAFE_INTEGER)
        self.assertEqual(retry_after_sec("0" * 5000 + "5", NOW), 5, "leading zeros count for nothing, as Number() reads them")
        self.assertEqual(retry_after_sec("0" * 5000, NOW), 0)

    def test_counts_everything_else_as_absent(self) -> None:
        for raw in (None, "", "-1", "abc", "1e9", "1.5", "+5", "5s", "Sunday, 11-Oct-26 12:00:07 GMT", "Sun Oct 11 12:00:07 2026", "Sun, 11 Oct 2026 11:59:59 GMT", "Tue, 31 Nov 2026 12:00:00 GMT", "Sun, 11 Oct 2026 24:00:00 GMT", "Sun, 11 Oct 2026 12:60:00 GMT", "Sun, 11 Oct 2026 12:00:60 GMT", "Sun, 29 Feb 2027 12:00:00 GMT", "Sun, 11 Oct 0000 12:00:00 GMT", "Sun, 11 Oct 2026 12:00:07 UTC", "\n5"):
            self.assertIsNone(retry_after_sec(raw, NOW), repr(raw))


class Backoff(unittest.TestCase):
    def test_is_drawn_from_zero_to_min_8000_and_500_times_two_to_the_attempt_minus_one_in_whole_milliseconds(self) -> None:
        for attempt in range(1, 12):
            cap = min(8000, 500 * 2 ** (attempt - 1))
            self.assertEqual(backoff_ms(attempt, lambda: 0.0), 0)
            self.assertEqual(backoff_ms(attempt, lambda: 0.999999), cap - 1)
            self.assertEqual(backoff_ms(attempt, lambda: 0.5), cap // 2)
            self.assertIsInstance(backoff_ms(attempt, lambda: 0.123456), int)


class Policy(unittest.TestCase):
    def test_waits_for_in_progress_without_using_up_a_retry_and_counts_every_other_failure(self) -> None:
        self.assertEqual(policy_of(api("IDEMPOTENCY_IN_PROGRESS", 409), SAFE, RETRYABLE_CODES), (True, False))
        for code, status in (("INTERNAL", 500), ("UPSTREAM_FAILED", 502), ("NOT_READY", 409), ("UNAVAILABLE", 503), ("RATE_LIMITED", 429)):
            self.assertEqual(policy_of(api(code, status), SAFE, RETRYABLE_CODES), (True, True), code)
        for code in ("CONNECTION_FAILED", "TIMEOUT"):
            self.assertEqual(policy_of(network(code), SAFE, RETRYABLE_CODES), (True, True), code)
        self.assertEqual(policy_of(network("BAD_RESPONSE", 502), SAFE, RETRYABLE_CODES), (True, True))

    def test_never_retries_conflict_a_switched_off_operation_an_abort_a_4xx_bad_response_or_an_unknown_code(self) -> None:
        self.assertEqual(policy_of(api("CONFLICT", 409), SAFE, RETRYABLE_CODES), (False, False))
        self.assertEqual(policy_of(api("IDEMPOTENCY_KEY_REUSED", 422), SAFE, RETRYABLE_CODES), (False, False))
        self.assertEqual(policy_of(api("UNAVAILABLE", 503, {"reason": "switched_off"}), SAFE, RETRYABLE_CODES), (False, False))
        self.assertEqual(policy_of(api("SOMETHING_NEW", 500), SAFE, RETRYABLE_CODES), (False, False))
        self.assertEqual(policy_of(network("ABORTED"), SAFE, RETRYABLE_CODES), (False, False))
        self.assertEqual(policy_of(network("BAD_RESPONSE", 403), SAFE, RETRYABLE_CODES), (False, True))
        self.assertEqual(policy_of(network("BAD_RESPONSE", None), SAFE, RETRYABLE_CODES), (False, True))

    def test_retries_a_call_that_is_not_retry_safe_only_on_rate_limited(self) -> None:
        self.assertEqual(policy_of(api("RATE_LIMITED", 429), UNSAFE, RETRYABLE_CODES), (True, True))
        for failure in (api("INTERNAL", 500), api("IDEMPOTENCY_IN_PROGRESS", 409), network("CONNECTION_FAILED"), network("TIMEOUT"), network("BAD_RESPONSE", 502)):
            self.assertFalse(policy_of(failure, UNSAFE, RETRYABLE_CODES)[0], failure.code)

    def test_says_a_spend_may_have_been_charged_only_when_the_outcome_leaves_it_unknown(self) -> None:
        spend: Dict[str, Any] = {"retrySafe": True, "effect": "spend"}
        write: Dict[str, Any] = {"retrySafe": True, "effect": "write"}
        for failure in (network("CONNECTION_FAILED"), network("TIMEOUT"), network("ABORTED"), network("BAD_RESPONSE", 200), network("BAD_RESPONSE", 502), api("INTERNAL", 500), api("IDEMPOTENCY_IN_PROGRESS", 409), api("SOMETHING_NEW", 500)):
            self.assertTrue(may_have_spent(failure, spend, True), failure.code)
            self.assertFalse(may_have_spent(failure, spend, False), f"{failure.code} with nothing sent")
            self.assertFalse(may_have_spent(failure, write, True), f"{failure.code} on a write")
        for failure in (network("BAD_RESPONSE", 403), network("BAD_RESPONSE", 302), api("CONFLICT", 409), api("INSUFFICIENT_CREDITS", 402), api("UNAVAILABLE", 503, {"reason": "switched_off"})):
            self.assertFalse(may_have_spent(failure, spend, True), failure.code)
        self.assertFalse(may_have_spent(api("RATE_LIMITED", 429), spend, True))
        self.assertTrue(may_have_spent(api("RATE_LIMITED", 429), spend, True, True), "a 429 after an unknown outcome says nothing of it")
