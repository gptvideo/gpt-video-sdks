"""Webhook verification: the vectors of the specification, the shared vectors every GPT-Video SDK runs, an
independent HMAC written here from hashlib, and the guards a functional test cannot see (no early exit)."""

import base64
import email.message
import hashlib
import inspect
import json
import os
import pickle
import re
import unittest
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Tuple

from gpt_video import webhooks
from gpt_video.errors import WEBHOOK_FAILURE_REASONS, GptVideoError
from gpt_video.webhooks import Webhook, WebhookVerificationError, construct_event, verify_webhook

from .support import api_key, read_vectors, secret_of

# The vectors of the JavaScript library of the specification: standard-webhooks/standard-webhooks, commit
# 4bcfffba157053dfe35bbcf4eb082a2e776e2825 (2026-08-28), libraries/javascript/src/webhook.test.ts.
# https://github.com/standard-webhooks/standard-webhooks/blob/4bcfffba157053dfe35bbcf4eb082a2e776e2825/libraries/javascript/src/webhook.test.ts
SPEC_SECRET = secret_of("MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw")
SPEC_ID = "msg_p5jXN8AQM9LWM0D4loKWxJek"
SPEC_TIMESTAMP = 1614265330
SPEC_PAYLOAD = '{"test": 2432232314}'
SPEC_SIGNATURE = "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE="
SPEC_WRONG = "Ceo5qEr07ixe2NLpvHk3FH9bwy/WavXrAFQ/9tdO6mc="
SPEC_INVALID = "v1,dawfeoifkpqwoekfpqoekf"
TOLERANCE = 300

VECTORS = read_vectors("webhooks.generated.json")


def spec_headers(**over: Any) -> Dict[str, Any]:
    headers: Dict[str, Any] = {"webhook-id": SPEC_ID, "webhook-timestamp": str(SPEC_TIMESTAMP), "webhook-signature": SPEC_SIGNATURE}
    headers.update({k.replace("_", "-"): v for k, v in over.items()})
    return headers


def independent_hmac(key: bytes, message: bytes) -> bytes:
    """HMAC-SHA256 as RFC 2104 writes it, from hashlib alone: a second implementation of what the SDK computes."""
    block = 64
    if len(key) > block:
        key = hashlib.sha256(key).digest()
    key = key.ljust(block, b"\0")
    inner = hashlib.sha256(bytes(b ^ 0x36 for b in key) + message).digest()
    return hashlib.sha256(bytes(b ^ 0x5C for b in key) + inner).digest()


def sign(secret: str, id: str, ts: int, body: bytes) -> bytes:
    return independent_hmac(base64.b64decode(secret[len("whsec_") :]), f"{id}.{ts}.".encode() + body)


class TestCaseWithRefusal(unittest.TestCase):
    def refused(self, call: Any, reason: str) -> WebhookVerificationError:
        with self.assertRaises(WebhookVerificationError) as caught:
            call()
        self.assertEqual(caught.exception.reason, reason)
        return caught.exception


class SpecificationVectors(TestCaseWithRefusal):
    """The vectors of the specification, run through the Standard Webhooks form."""

    def test_an_empty_secret_none_and_the_prefix_alone_are_refused_when_the_webhook_is_made(self) -> None:
        for secret in ("", None, "whsec_"):
            with self.assertRaises(WebhookVerificationError, msg=repr(secret)):
                Webhook(secret)  # type: ignore[arg-type]

    def test_a_missing_id_timestamp_or_signature_is_refused(self) -> None:
        for name in ("webhook-id", "webhook-timestamp", "webhook-signature"):
            headers = spec_headers()
            del headers[name]
            self.refused(lambda: verify_webhook(secret=SPEC_SECRET, headers=headers, body=SPEC_PAYLOAD, now=SPEC_TIMESTAMP), "missing_headers")

    def test_an_invalid_timestamp_is_refused(self) -> None:
        self.refused(lambda: verify_webhook(secret=SPEC_SECRET, headers=spec_headers(webhook_timestamp="hello"), body=SPEC_PAYLOAD, now=SPEC_TIMESTAMP), "bad_timestamp")

    def test_an_invalid_and_a_partial_signature_are_refused(self) -> None:
        for signature in (SPEC_INVALID, SPEC_SIGNATURE[:8], "v1,"):
            self.refused(lambda: verify_webhook(secret=SPEC_SECRET, headers=spec_headers(webhook_signature=signature), body=SPEC_PAYLOAD, now=SPEC_TIMESTAMP), "no_matching_signature")

    def test_a_valid_signature_returns_the_event(self) -> None:
        self.assertEqual(construct_event(secret=SPEC_SECRET, headers=spec_headers(), body=SPEC_PAYLOAD, now=SPEC_TIMESTAMP), {"test": 2432232314})

    def test_one_second_past_the_tolerance_fails_on_both_sides(self) -> None:
        for now in (SPEC_TIMESTAMP + TOLERANCE + 1, SPEC_TIMESTAMP - TOLERANCE - 1):
            self.refused(lambda: verify_webhook(secret=SPEC_SECRET, headers=spec_headers(), body=SPEC_PAYLOAD, now=now), "timestamp_outside_tolerance")

    def test_a_list_of_signatures_with_the_right_one_among_wrong_ones_is_valid(self) -> None:
        listed = " ".join([f"v1,{SPEC_WRONG}", f"v2,{SPEC_WRONG}", SPEC_SIGNATURE, f"v1,{SPEC_WRONG}"])
        self.assertEqual(construct_event(secret=SPEC_SECRET, headers=spec_headers(webhook_signature=listed), body=SPEC_PAYLOAD, now=SPEC_TIMESTAMP), {"test": 2432232314})

    def test_differs_from_the_library_on_purpose_a_secret_without_its_prefix_is_refused(self) -> None:
        with self.assertRaises(WebhookVerificationError):
            Webhook(SPEC_SECRET[len("whsec_") :])


def bodies_of(case: Dict[str, Any]) -> List[Tuple[str, Any]]:
    if case["body"] is not None:
        return [("text", case["body"]), ("bytes", case["body"].encode("utf-8"))]
    if case["bodyBase64"] is not None:
        return [("bytes", base64.b64decode(case["bodyBase64"]))]
    return [("parsed", case["bodyParsed"])]


def secrets_of(case: Dict[str, Any]) -> Dict[str, Any]:
    if case["secretText"] is not None:
        return {"secret": case["secretText"]}
    names = case["secretNames"]
    whole = [VECTORS["secretPrefix"] + VECTORS["secrets"][n] for n in names]
    return {"secret": whole[0]} if len(whole) == 1 else {"secrets": whole}


class SharedVectors(TestCaseWithRefusal):
    def test_the_file_has_many_cases_each_reason_from_the_closed_list(self) -> None:
        self.assertGreater(len(VECTORS["cases"]), 40)
        self.assertEqual(VECTORS["defaultToleranceSec"], webhooks.DEFAULT_TOLERANCE_SEC)
        for case in VECTORS["cases"]:
            if not case["expect"]["ok"]:
                self.assertIn(case["expect"]["reason"], WEBHOOK_FAILURE_REASONS, case["name"])

    def check(self, case: Dict[str, Any], body: Any) -> None:
        options: Dict[str, Any] = {**secrets_of(case), "headers": case["headers"], "body": body, "now": case["nowSec"]}
        if case["toleranceSec"] is not None:
            options["tolerance_sec"] = case["toleranceSec"]
        if case["expect"]["ok"]:
            verified = verify_webhook(**options)
            self.assertEqual((verified.id, verified.timestamp), (case["expect"]["id"], case["expect"]["timestamp"]))
        else:
            self.refused(lambda: verify_webhook(**options), case["expect"]["reason"])

    def test_every_accepted_case_is_accepted_by_the_standard_webhooks_form_against_the_clock(self) -> None:
        ran = 0
        for case in VECTORS["cases"]:
            if not case["expect"]["ok"]:
                continue
            secrets = secrets_of(case)
            tolerance = case["toleranceSec"]
            wh = Webhook(secrets.get("secret") or secrets["secrets"], tolerance_sec=tolerance)
            for _, body in bodies_of(case):
                raw = body.encode("utf-8") if isinstance(body, str) else body
                original = webhooks.time.time
                webhooks.time.time = lambda: float(case["nowSec"])  # type: ignore[assignment]
                try:
                    try:
                        expected = json.loads(raw)
                    except ValueError:
                        with self.assertRaises(ValueError, msg=case["name"]):
                            wh.verify(body, case["headers"])
                    else:
                        self.assertEqual(wh.verify(body, case["headers"]), expected, case["name"])
                finally:
                    webhooks.time.time = original  # type: ignore[assignment]
                ran += 1
        self.assertGreater(ran, 20)

    def test_construct_event_returns_the_event_of_a_delivery_as_the_server_sends_it(self) -> None:
        case = next(c for c in VECTORS["cases"] if c["name"] == "a delivery as the server sends it")
        event = construct_event(**secrets_of(case), headers=case["headers"], body=case["body"], now=case["nowSec"])
        self.assertEqual(event, json.loads(case["body"]))
        self.assertEqual(sorted(event), ["data", "timestamp", "type"])


def _add_case(index: int, case: Dict[str, Any]) -> None:
    for form, body in bodies_of(case):
        name = f"test_case_{index:02d}_" + re.sub(r"\W+", "_", case["name"]).strip("_") + f"__body_as_{form}"

        def test(self: SharedVectors, case: Dict[str, Any] = case, body: Any = body) -> None:
            self.check(case, body)

        test.__doc__ = f"{case['name']} (body as {form})"
        setattr(SharedVectors, name, test)


for _index, _case in enumerate(VECTORS["cases"]):
    _add_case(_index, _case)


class IndependentHmac(TestCaseWithRefusal):
    """Bytes, against an HMAC written here from hashlib alone."""

    secret = secret_of(base64.b64encode(os.urandom(24)).decode())
    id = "msg_independent"
    ts = 1_800_000_000

    def headers(self, signature: bytes) -> Dict[str, str]:
        return {"webhook-id": self.id, "webhook-timestamp": str(self.ts), "webhook-signature": "v1," + base64.b64encode(signature).decode()}

    def test_the_independent_hmac_is_the_standard_one(self) -> None:
        import hmac

        key, message = os.urandom(32), os.urandom(100)
        self.assertEqual(independent_hmac(key, message), hmac.new(key, message, hashlib.sha256).digest())

    def test_accepts_random_bodies_of_random_bytes_as_bytes_bytearray_and_memoryview(self) -> None:
        for n in range(20):
            body = os.urandom(n * 13)
            headers = self.headers(sign(self.secret, self.id, self.ts, body))
            for form in (body, bytearray(body), memoryview(body)):
                self.assertEqual(verify_webhook(secret=self.secret, headers=headers, body=form, now=self.ts), webhooks.VerifiedWebhook(self.id, self.ts))

    def test_verifies_only_the_bytes_a_view_shows(self) -> None:
        whole = b'PREFIX{"a":1}SUFFIX'
        view = memoryview(whole)[6:13]
        headers = self.headers(sign(self.secret, self.id, self.ts, bytes(view)))
        self.assertEqual(construct_event(secret=self.secret, headers=headers, body=view, now=self.ts), {"a": 1})

    def test_refuses_every_one_bit_change_of_the_signature(self) -> None:
        body = b'{"flip":true}'
        good = sign(self.secret, self.id, self.ts, body)
        for bit in range(256):
            bad = bytearray(good)
            bad[bit >> 3] ^= 1 << (bit & 7)
            self.refused(lambda: verify_webhook(secret=self.secret, headers=self.headers(bytes(bad)), body=body, now=self.ts), "no_matching_signature")

    def test_refuses_every_one_bit_change_of_the_body(self) -> None:
        body = b'{"x":1}'
        headers = self.headers(sign(self.secret, self.id, self.ts, body))
        for bit in range(len(body) * 8):
            changed = bytearray(body)
            changed[bit >> 3] ^= 1 << (bit & 7)
            self.refused(lambda: verify_webhook(secret=self.secret, headers=headers, body=bytes(changed), now=self.ts), "no_matching_signature")


class HeaderForms(TestCaseWithRefusal):
    def test_reads_an_email_message_whatever_the_case_of_the_names(self) -> None:
        message = email.message.Message()
        message["Webhook-Id"] = SPEC_ID
        message["WEBHOOK-TIMESTAMP"] = str(SPEC_TIMESTAMP)
        message["webhook-signature"] = f"v1,{SPEC_WRONG}"
        message["Webhook-Signature"] = SPEC_SIGNATURE
        self.assertEqual(verify_webhook(secret=SPEC_SECRET, headers=message, body=SPEC_PAYLOAD, now=SPEC_TIMESTAMP).id, SPEC_ID)

    def test_reads_a_list_of_pairs_and_a_mapping_of_lists(self) -> None:
        class Pairs:
            def items(self) -> List[Tuple[str, str]]:
                return [("Webhook-Id", SPEC_ID), ("Webhook-Timestamp", str(SPEC_TIMESTAMP)), ("Webhook-Signature", f"v1,{SPEC_WRONG}"), ("Webhook-Signature", SPEC_SIGNATURE)]

        self.assertEqual(verify_webhook(secret=SPEC_SECRET, headers=Pairs(), body=SPEC_PAYLOAD, now=SPEC_TIMESTAMP).id, SPEC_ID)
        listed = spec_headers(webhook_signature=[f"v1,{SPEC_WRONG}", SPEC_SIGNATURE])
        self.assertEqual(verify_webhook(secret=SPEC_SECRET, headers=listed, body=SPEC_PAYLOAD, now=SPEC_TIMESTAMP).id, SPEC_ID)

    def test_refuses_headers_that_are_not_there(self) -> None:
        for headers in (None, "webhook-id: x", {}, 42):
            self.refused(lambda: verify_webhook(secret=SPEC_SECRET, headers=headers, body=SPEC_PAYLOAD, now=SPEC_TIMESTAMP), "missing_headers")

    def test_the_same_id_twice_is_one_id_and_two_different_ones_a_refusal(self) -> None:
        same = spec_headers(webhook_id=[SPEC_ID, SPEC_ID])
        self.assertEqual(verify_webhook(secret=SPEC_SECRET, headers=same, body=SPEC_PAYLOAD, now=SPEC_TIMESTAMP).id, SPEC_ID)
        both = {**spec_headers(), "Webhook-Id": SPEC_ID + "x"}
        self.refused(lambda: verify_webhook(secret=SPEC_SECRET, headers=both, body=SPEC_PAYLOAD, now=SPEC_TIMESTAMP), "missing_headers")


class WrongCalls(TestCaseWithRefusal):
    base: Dict[str, Any] = {"secret": SPEC_SECRET, "headers": spec_headers(), "body": SPEC_PAYLOAD, "now": SPEC_TIMESTAMP}

    def test_refuses_a_parsed_body_as_body_not_raw(self) -> None:
        for body in ({"test": 2432232314}, None, 42, [1, 2]):
            self.refused(lambda: verify_webhook(**{**self.base, "headers": {}, "body": body}), "body_not_raw")
        self.refused(lambda: Webhook(SPEC_SECRET).verify({"test": 1}, spec_headers()), "body_not_raw")

    def test_refuses_an_api_key_a_secret_that_is_not_standard_base64_and_a_list_with_a_bad_secret(self) -> None:
        key = api_key("A")
        error = self.refused(lambda: verify_webhook(**{**self.base, "secret": key}), "bad_secret")
        self.assertIn("This is an API key (gvk_), not a webhook signing secret.", error.message)
        self.assertNotIn(key[4:], error.message)
        for secret in ("whsec_abc-def_", "whsec_abcd efgh", "whsec_abcde", "whsec_ab==cd", SPEC_SECRET + "\n"):
            self.refused(lambda: verify_webhook(**{**self.base, "secret": secret}), "bad_secret")
        newline = self.refused(lambda: verify_webhook(**{**self.base, "secret": SPEC_SECRET + "\n"}), "bad_secret")
        self.assertIn("line break", newline.message)
        self.assertNotIn(SPEC_SECRET[len("whsec_") :], newline.message)
        self.refused(lambda: verify_webhook(**{**self.base, "secret": None, "secrets": [SPEC_SECRET, 7]}), "bad_secret")
        self.refused(lambda: verify_webhook(**{**self.base, "secret": None, "secrets": []}), "bad_secret")
        self.refused(lambda: verify_webhook(**{**self.base, "secret": None}), "bad_secret")

    def test_a_bad_secret_is_refused_even_without_headers(self) -> None:
        self.refused(lambda: verify_webhook(**{**self.base, "headers": {}, "secret": "not a secret"}), "bad_secret")

    def test_options_that_would_turn_a_check_off_are_invalid_arguments(self) -> None:
        for tolerance in (float("inf"), float("nan"), -1, "300", True):
            with self.assertRaises(GptVideoError) as caught:
                verify_webhook(**{**self.base, "tolerance_sec": tolerance})
            self.assertNotIsInstance(caught.exception, WebhookVerificationError)
            self.assertEqual(caught.exception.code, "INVALID_ARGUMENT")
        for now in (float("nan"), "now", datetime(2026, 1, 1)):
            with self.assertRaises(GptVideoError) as caught:
                verify_webhook(**{**self.base, "now": now})
            self.assertEqual(caught.exception.code, "INVALID_ARGUMENT")
        with self.assertRaises(GptVideoError) as caught:
            verify_webhook(**{**self.base, "secrets": [SPEC_SECRET]})
        self.assertEqual(caught.exception.code, "INVALID_ARGUMENT")
        with self.assertRaises(GptVideoError):
            Webhook(SPEC_SECRET, tolerance_sec=float("inf"))

    def test_takes_now_as_a_datetime_and_a_tolerance_of_zero_accepts_only_the_same_second(self) -> None:
        at = datetime.fromtimestamp(SPEC_TIMESTAMP, tz=timezone.utc)
        self.assertEqual(verify_webhook(**{**self.base, "now": at}).timestamp, SPEC_TIMESTAMP)
        verify_webhook(**{**self.base, "now": SPEC_TIMESTAMP + 0.999, "tolerance_sec": 0})
        self.refused(lambda: verify_webhook(**{**self.base, "now": SPEC_TIMESTAMP + 1, "tolerance_sec": 0}), "timestamp_outside_tolerance")
        self.refused(lambda: verify_webhook(**{**self.base, "now": at + timedelta(seconds=301)}), "timestamp_outside_tolerance")

    def test_a_timestamp_longer_than_python_turns_into_an_int_is_a_refusal_never_a_value_error(self) -> None:
        # int() refuses more than 4300 digits: the receiver catches WebhookVerificationError, not ValueError
        for digits in ("9" * 5000, "1" + "0" * 400, "9" * 401):
            self.refused(lambda: verify_webhook(**{**self.base, "headers": spec_headers(webhook_timestamp=digits)}), "timestamp_outside_tolerance")
        # leading zeros count for nothing, however many, and the content is signed with the number
        padded = "0" * 5000 + str(SPEC_TIMESTAMP)
        self.assertEqual(verify_webhook(**{**self.base, "headers": spec_headers(webhook_timestamp=padded)}).timestamp, SPEC_TIMESTAMP)

    def test_compares_whole_seconds_the_clock_rounded_down(self) -> None:
        verify_webhook(**{**self.base, "now": SPEC_TIMESTAMP + 300.999})
        self.refused(lambda: verify_webhook(**{**self.base, "now": SPEC_TIMESTAMP + 301}), "timestamp_outside_tolerance")
        verify_webhook(**{**self.base, "now": SPEC_TIMESTAMP - 300})
        self.refused(lambda: verify_webhook(**{**self.base, "now": SPEC_TIMESTAMP - 300.001}), "timestamp_outside_tolerance")


class WhatItShows(TestCaseWithRefusal):
    def test_a_refusal_never_repeats_the_secret_the_signature_or_the_body(self) -> None:
        body = '{"private":"customer data"}'
        error = self.refused(lambda: verify_webhook(secret=SPEC_SECRET, headers=spec_headers(), body=body, now=SPEC_TIMESTAMP), "no_matching_signature")
        self.assertTrue(error.message.startswith("WEBHOOK_VERIFICATION_FAILED: No v1 signature"))
        self.assertEqual(error.code, "WEBHOOK_VERIFICATION_FAILED")
        shown = f"{error.message}\n{error!r}\n{vars(error)!r}\n{pickle.loads(pickle.dumps(error))!r}"
        for part in (SPEC_SECRET[len("whsec_") :], SPEC_SIGNATURE[3:20], "customer data"):
            self.assertNotIn(part, shown)

    def test_a_webhook_never_shows_its_secret_and_cannot_be_pickled(self) -> None:
        wh = Webhook(SPEC_SECRET)
        self.assertEqual(repr(wh), "Webhook(secret='[redacted]')")
        self.assertNotIn(SPEC_SECRET[len("whsec_") :], f"{wh!r}{wh}")
        with self.assertRaises(TypeError):
            pickle.dumps(wh)


class NoEarlyExit(unittest.TestCase):
    """The time a comparison takes cannot be tested reliably, so its shape is: every signature is compared with
    every secret, by hmac.compare_digest, with no exit inside the loops. Rewriting it with an early exit makes this
    red."""

    def test_verify_compares_every_signature_with_every_secret_with_no_exit_inside_the_loops(self) -> None:
        source = inspect.getsource(webhooks._verify)
        loops = source[source.index("matched = False") : source.index("if not matched")]
        self.assertRegex(loops, r"matched = hmac\.compare_digest\(received, mac\) \| matched")
        self.assertNotRegex(loops, r"\breturn\b|\bbreak\b|\bany\(|\ball\(|\bnext\(| or | and |==")

    def test_signatures_are_compared_as_decoded_bytes_never_as_base64_text(self) -> None:
        self.assertIn("_from_standard_base64(parts[1])", inspect.getsource(webhooks._signatures_of))
