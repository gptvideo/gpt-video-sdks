"""The saboteur's list for the Python SDK: the ways this package could charge twice, leak the key, accept a forged
webhook, or run for ever, each tried from a road the other tests do not take. Every test is written against an
invariant: one intention, one charge; the key goes nowhere but the Authorization header; a webhook is accepted
only when its bytes were signed with the secret, within the tolerance; every call, wait and list ends.
"""

import base64
import hashlib
import hmac
import io
import json
import pickle
import re
import threading
import unittest
from typing import Any, Dict, List, Optional

from gpt_video import GptVideo, GptVideoApiError, GptVideoJobError, GptVideoNetworkError
from gpt_video._retry import MAX_RETRIES, RETRY_AFTER_MAX_SEC
from gpt_video.errors import MESSAGES, GptVideoError
from gpt_video.webhooks import Webhook, WebhookVerificationError, construct_event, verify_webhook

from .support import FakeClock, FakeWire, api_key

KEY = api_key("G")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
PROJECT = "prj_7c2e9a4f1b3d4e8096a5"


def client(script: Any, **options: Any) -> "tuple[GptVideo, FakeWire, FakeClock]":
    clock = FakeClock()
    wire = FakeWire(clock, script)
    options.setdefault("api_key", KEY)
    return GptVideo._with_wire(wire, clock, **options), wire, clock


def api_error(code: str, status: int, headers: Optional[Dict[str, str]] = None, **more: Any) -> Dict[str, Any]:
    return {"status": status, "headers": headers or {}, "json": {"error": {"code": code, "message": f"{code} happened.", **more}}}


def accepted(replayed: bool = False) -> Dict[str, Any]:
    return {"status": 202, "headers": {"Idempotent-Replayed": "true"} if replayed else {}, "json": {"job": {"id": "job_1", "status": "queued", "finishedAt": None}}}


def keys_sent(wire: FakeWire) -> List[Optional[str]]:
    return [call.headers.get("idempotency-key") for call in wire.calls]


class G1OneIntentionOneCharge(unittest.TestCase):
    def test_one_key_on_every_attempt_and_every_wait_and_the_wait_never_uses_up_a_retry(self) -> None:
        gv, wire, _ = client([
            api_error("INTERNAL", 500),
            api_error("IDEMPOTENCY_IN_PROGRESS", 409, {"Retry-After": "2"}),
            api_error("IDEMPOTENCY_IN_PROGRESS", 409, {"Retry-After": "2"}),
            api_error("UPSTREAM_FAILED", 502),
            accepted(True),
        ])
        self.assertEqual(gv.analyze_project(projectId=PROJECT)["job"]["id"], "job_1")
        keys = keys_sent(wire)
        self.assertEqual(len(keys), 5)
        self.assertRegex(keys[0] or "", UUID)
        self.assertEqual(len(set(keys)), 1, "one key for the whole call")
        self.assertEqual(MAX_RETRIES, 2, "two failures used up the retries, so the two waits did not count")
        for call in wire.calls:
            self.assertEqual((call.method, call.url, call.body), ("POST", f"https://api.gpt-video.com/v1/projects/{PROJECT}/analyze", None))

    def test_a_handler_slower_than_the_attempt_is_waited_for_and_answered_with_the_same_key(self) -> None:
        gv, wire, clock = client([{**accepted(), "afterMs": 61_000}, api_error("IDEMPOTENCY_IN_PROGRESS", 409, {"Retry-After": "5"}), accepted(True)])
        self.assertEqual(gv.create_export(compositionId="cmp_1")["job"]["id"], "job_1")
        self.assertEqual(len(set(keys_sent(wire))), 1)
        self.assertEqual(wire.calls[2].at - wire.calls[1].at, 5.0, "the wait follows Retry-After")

    def test_a_cancel_while_the_spend_runs_says_it_may_have_charged_and_the_key_brings_the_answer_back(self) -> None:
        cancel = threading.Event()
        gv, wire, clock = client([{"network": "hang"}])
        clock.at(1.0, cancel.set)
        with self.assertRaises(GptVideoNetworkError) as caught:
            gv.analyze_project(projectId=PROJECT, cancel=cancel)
        error = caught.exception
        self.assertEqual((error.code, error.may_have_spent, error.retryable), ("ABORTED", True, False))
        self.assertEqual(error.idempotency_key, wire.calls[0].headers["idempotency-key"])
        self.assertIn(MESSAGES["may_have_spent"], error.message)
        # after a crash: the same call with the key of the error, from a new client
        again, wire2, _ = client([accepted(True)])
        again.analyze_project(projectId=PROJECT, idempotency_key=error.idempotency_key)
        self.assertEqual(keys_sent(wire2), [error.idempotency_key])

    def test_a_key_the_api_says_was_reused_is_a_refusal_sent_once_never_a_call_with_a_fresh_key(self) -> None:
        gv, wire, _ = client([api_error("IDEMPOTENCY_KEY_REUSED", 422)])
        with self.assertRaises(GptVideoApiError) as caught:
            gv.analyze_project(projectId=PROJECT, idempotency_key="order-42")
        error = caught.exception
        self.assertEqual((error.code, error.status, error.retryable, error.may_have_spent, error.idempotency_key), ("IDEMPOTENCY_KEY_REUSED", 422, False, False, "order-42"))
        self.assertEqual(keys_sent(wire), ["order-42"])

    def test_a_key_of_the_caller_the_api_would_refuse_stops_the_call_before_anything_is_sent(self) -> None:
        gv, wire, _ = client([accepted()])
        for key in ("", "k" * 256, "order 42", "order-42\n", 42):
            with self.assertRaises(GptVideoError, msg=repr(key)) as caught:
                gv.analyze_project(projectId=PROJECT, idempotency_key=key)  # type: ignore[arg-type]
            self.assertEqual(caught.exception.code, "INVALID_ARGUMENT")
            self.assertIn(MESSAGES["bad_idempotency_key"], caught.exception.message)
        self.assertEqual(wire.calls, [])
        gv.analyze_project(projectId=PROJECT, idempotency_key="k" * 255)
        self.assertEqual(keys_sent(wire), ["k" * 255])

    def test_two_calls_are_two_intentions_and_the_sdk_remembers_no_key_between_them(self) -> None:
        gv, wire, _ = client([accepted(), accepted()])
        gv.analyze_project(projectId=PROJECT)
        gv.analyze_project(projectId=PROJECT)
        a, b = keys_sent(wire)
        self.assertRegex(a or "", UUID)
        self.assertRegex(b or "", UUID)
        self.assertNotEqual(a, b)


class G2TheKeyStaysHome(unittest.TestCase):
    def echoing(self) -> Dict[str, Any]:
        return {
            "status": 500,
            "headers": {"X-Request-Id": f"req_{KEY}"},
            "json": {"error": {"code": "INTERNAL", "message": f"Bad key {KEY}.", "hint": f"Try {KEY} again.", "details": {"token": KEY, KEY: [KEY, {"deep": KEY}]}}},
        }

    def test_the_key_is_in_no_field_text_or_printed_form_of_an_error_even_when_the_server_sends_it_back(self) -> None:
        seen: List[Any] = []
        gv, wire, _ = client([self.echoing()] * 3, on_response=seen.append, on_retry=seen.append)
        with self.assertRaises(GptVideoApiError) as caught:
            gv.analyze_project(projectId=PROJECT)
        error = caught.exception
        texts = [error.message, str(error), repr(error), error.hint or "", error.request_id or "", json.dumps(error.details), repr(seen), repr(pickle.loads(pickle.dumps(error)))]
        for text in texts:
            self.assertNotIn(KEY[4:], text)
        self.assertEqual(error.details["token"], "[redacted]")
        self.assertEqual(list(error.details), ["token", "[redacted]"])
        self.assertEqual(len(seen), 5)

    def test_the_key_is_in_no_printed_form_of_a_client_and_never_in_a_url_or_a_body(self) -> None:
        gv, wire, _ = client([{"status": 200, "json": {}}])
        gv.update_project(projectId=PROJECT, title="x")
        for text in (repr(gv), str(gv), repr(getattr(gv, '__dict__', {})), repr([getattr(gv, name, None) for name in getattr(type(gv), '__slots__', ())])):
            self.assertNotIn(KEY[4:], text)
        with self.assertRaises(TypeError):
            pickle.dumps(gv)
        call = wire.calls[0]
        self.assertNotIn(KEY[4:], call.url)
        self.assertNotIn(KEY[4:].encode(), call.body or b"")
        self.assertEqual(call.headers["authorization"], f"Bearer {KEY}")

    def test_plain_http_goes_only_to_this_machine(self) -> None:
        for base_url in ("http://api.gpt-video.com/v1", "http://example.com", "http://127.0.0.1.example.com/v1", "http://localhost.example.com"):
            with self.assertRaises(GptVideoError, msg=base_url) as caught:
                client([], base_url=base_url)
            self.assertIn(MESSAGES["insecure_base_url"], caught.exception.message)
        for base_url in ("http://localhost:3000/v1", "http://127.0.0.1:3000", "http://[::1]:3000/v1", "http://app.localhost/v1", "https://api.gpt-video.com/v1"):
            client([], base_url=base_url)

    def test_a_redirect_is_never_followed_and_a_spend_sent_into_one_is_not_a_charge(self) -> None:
        gv, wire, _ = client([{"status": 307, "headers": {"Location": "https://evil.example.com/v1/projects/x/analyze"}, "text": ""}])
        with self.assertRaises(GptVideoNetworkError) as caught:
            gv.analyze_project(projectId=PROJECT)
        error = caught.exception
        self.assertEqual((error.code, error.status, error.may_have_spent, error.retryable), ("BAD_RESPONSE", 307, False, False))
        self.assertIn(MESSAGES["redirect"], error.message)
        self.assertEqual(len(wire.calls), 1)

    def test_a_download_carries_no_key_even_from_the_host_of_the_api_and_refuses_plain_http_elsewhere(self) -> None:
        gv, wire, _ = client([{"status": 200, "text": "bytes"}])
        sink = io.BytesIO()
        self.assertEqual(gv.download("https://api.gpt-video.com/v1/exports/exp_1/file?sig=abc", sink), 5)
        self.assertEqual(sink.getvalue(), b"bytes")
        self.assertNotIn("authorization", wire.calls[0].headers)
        self.assertNotIn(KEY[4:], repr(wire.calls[0].headers))
        with self.assertRaises(GptVideoError) as caught:
            gv.download("http://cdn.example.com/file.mp4", io.BytesIO())
        self.assertEqual(caught.exception.code, "INVALID_ARGUMENT")
        self.assertEqual(len(wire.calls), 1)

    def test_a_certificate_python_cannot_verify_is_said_with_the_cure_and_without_the_key(self) -> None:
        gv, wire, _ = client([{"network": "tls"}] * 3)
        with self.assertRaises(GptVideoNetworkError) as caught:
            gv.get_me()
        self.assertEqual(caught.exception.code, "CONNECTION_FAILED")
        self.assertIn(MESSAGES["python_tls"], caught.exception.message)
        self.assertNotIn(KEY[4:], caught.exception.message)


_SECRET_BYTES = b"abcdefghijklmnopqrstuvwxyz012345"
_ID = "wev_32aeca77d094a0e08a11"
_TIMESTAMP = 1767225600


def _body_of(n: int) -> str:
    return '{"type":"job.completed","data":{"jobId":"job_%d"}}' % n


def _signature_of(n: int) -> str:
    return base64.b64encode(hmac.new(_SECRET_BYTES, f"{_ID}.{_TIMESTAMP}.{_body_of(n)}".encode(), hashlib.sha256).digest()).decode()


# a body whose signature holds a + or a /, so its base64url form differs from the standard one beyond the padding
_NONCE = next(n for n in range(10_000) if re.search(r"[+/]", _signature_of(n)))


class G3TheSignatureOfAWebhook(unittest.TestCase):
    SECRET_BYTES = _SECRET_BYTES
    SECRET = "whsec" + "_" + base64.b64encode(SECRET_BYTES).decode()
    OTHER = "whsec" + "_" + base64.b64encode(b"ABCDEFGHIJKLMNOPQRSTUVWXYZ543210").decode()
    ID = _ID
    TIMESTAMP = _TIMESTAMP
    BODY = _body_of(_NONCE)

    @classmethod
    def sign(cls, content: str, secret: Optional[str] = None) -> str:
        key = base64.b64decode((secret or cls.SECRET)[6:])
        return base64.b64encode(hmac.new(key, content.encode(), hashlib.sha256).digest()).decode()


    @classmethod
    def good(cls) -> str:
        return cls.sign(f"{cls.ID}.{cls.TIMESTAMP}.{cls.BODY}")

    def headers(self, **over: Any) -> Dict[str, Any]:
        out: Dict[str, Any] = {"webhook-id": self.ID, "webhook-timestamp": str(self.TIMESTAMP), "webhook-signature": f"v1,{self.good()}"}
        for name, value in over.items():
            key = name.replace("_", "-")
            if value is None:
                out.pop(key, None)
            else:
                out[key] = value
        return out

    def verify(self, headers: Optional[Dict[str, Any]] = None, body: Any = None, now: Optional[float] = None, secret: Optional[str] = None) -> Any:
        return verify_webhook(secret=secret or self.SECRET, headers=self.headers() if headers is None else headers, body=self.BODY if body is None else body, now=self.TIMESTAMP if now is None else now)

    def refused(self, reason: str, **kwargs: Any) -> WebhookVerificationError:
        with self.assertRaises(WebhookVerificationError, msg=repr(kwargs)) as caught:
            self.verify(**kwargs)
        self.assertEqual(caught.exception.reason, reason, repr(kwargs))
        self.assertNotIn(self.good(), caught.exception.message)
        return caught.exception

    def test_accepts_the_delivery_several_signatures_header_names_in_any_case_or_as_lists_and_a_signature_without_padding(self) -> None:
        good = self.good()
        self.assertTrue(good.endswith("="))
        verified = self.verify()
        self.assertEqual((verified.id, verified.timestamp), (self.ID, self.TIMESTAMP))
        self.verify(self.headers(webhook_signature=f"v1,{self.sign('x')} v2,{good} v1,{good} v1,{self.sign('y')}"))
        shouting = {"WEBHOOK-ID": self.ID, "Webhook-Timestamp": str(self.TIMESTAMP), "WEBHOOK-SIGNATURE": [f"v1,{self.sign('x')}", f"v1,{good}"]}
        self.verify(shouting)
        self.verify(self.headers(webhook_signature=f"v1,{good.rstrip('=')}"))
        self.verify(body=self.BODY.encode())
        self.assertEqual(construct_event(secret=self.SECRET, headers=self.headers(), body=self.BODY, now=self.TIMESTAMP)["type"], "job.completed")

    def test_refuses_what_was_not_signed_with_this_secret_over_these_bytes_with_the_reason(self) -> None:
        good = self.good()
        raw = base64.b64decode(good)
        cases: List[Any] = [
            ("another secret", "no_matching_signature", {"secret": self.OTHER}),
            ("one byte of the body", "no_matching_signature", {"body": self.BODY.replace("job_", "jb_")}),
            ("one byte of the id", "no_matching_signature", {"headers": self.headers(webhook_id=self.ID.replace("3", "4"))}),
            ("one byte of the timestamp", "no_matching_signature", {"headers": self.headers(webhook_timestamp=str(self.TIMESTAMP + 1))}),
            ("301 seconds later", "timestamp_outside_tolerance", {"now": self.TIMESTAMP + 301}),
            ("301 seconds earlier", "timestamp_outside_tolerance", {"now": self.TIMESTAMP - 301}),
            ("a timestamp that is not a number", "bad_timestamp", {"headers": self.headers(webhook_timestamp="soon")}),
            ("a timestamp with a space", "bad_timestamp", {"headers": self.headers(webhook_timestamp=f" {self.TIMESTAMP}")}),
            ("a timestamp with decimals", "bad_timestamp", {"headers": self.headers(webhook_timestamp=f"{self.TIMESTAMP}.0")}),
            ("no signature header", "missing_headers", {"headers": self.headers(webhook_signature=None)}),
            ("an empty id", "missing_headers", {"headers": self.headers(webhook_id="")}),
            ("the v1a scheme", "no_matching_signature", {"headers": self.headers(webhook_signature=f"v1a,{good}")}),
            ("the v2 scheme", "no_matching_signature", {"headers": self.headers(webhook_signature=f"v2,{good}")}),
            ("an empty signature", "no_matching_signature", {"headers": self.headers(webhook_signature="v1,")}),
            ("a truncated signature", "no_matching_signature", {"headers": self.headers(webhook_signature=f"v1,{good[:20]}")}),
            ("31 bytes", "no_matching_signature", {"headers": self.headers(webhook_signature="v1," + base64.b64encode(raw[:31]).decode())}),
            ("33 bytes", "no_matching_signature", {"headers": self.headers(webhook_signature="v1," + base64.b64encode(raw + b"\0").decode())}),
            ("several signatures, none right", "no_matching_signature", {"headers": self.headers(webhook_signature=" ".join(f"v1,{self.sign(c)}" for c in "abc"))}),
            ("base64url", "no_matching_signature", {"headers": self.headers(webhook_signature="v1," + base64.urlsafe_b64encode(raw).decode())}),
        ]
        for name, reason, kwargs in cases:
            with self.subTest(name):
                self.refused(reason, **kwargs)
        self.assertRegex(good, r"[+/]", "the base64url form differs for this signature beyond the padding, or the case proves nothing")

    def test_stops_on_a_parsed_body_a_secret_without_its_prefix_and_an_api_key_passed_as_the_secret(self) -> None:
        self.assertIn(MESSAGES["webhook_body_not_raw"], self.refused("body_not_raw", body=json.loads(self.BODY)).message)
        self.assertIn(MESSAGES["bad_webhook_secret"], self.refused("bad_secret", secret=base64.b64encode(self.SECRET_BYTES).decode()).message)
        error = self.refused("bad_secret", secret=KEY)
        self.assertIn(MESSAGES["api_key_as_webhook_secret"], error.message)
        self.assertNotIn(KEY[4:], error.message)
        with self.assertRaises(WebhookVerificationError) as caught:
            Webhook(KEY)
        self.assertEqual(caught.exception.reason, "bad_secret")


class G8EverythingEnds(unittest.TestCase):
    @staticmethod
    def page(ids: List[str], next_cursor: Optional[str]) -> Dict[str, Any]:
        return {"status": 200, "json": {"data": [{"id": i} for i in ids], "hasMore": next_cursor is not None, "nextCursor": next_cursor}}

    def test_a_list_whose_cursor_comes_back_stops_with_bad_response_after_the_items_it_has(self) -> None:
        gv, wire, _ = client([self.page(["a"], "c1"), self.page(["b"], "c2"), self.page(["c"], "c1")])
        got: List[str] = []
        with self.assertRaises(GptVideoNetworkError) as caught:
            for item in gv.paginate("list_projects"):
                got.append(item["id"])
        self.assertEqual(got, ["a", "b", "c"])
        self.assertEqual(caught.exception.code, "BAD_RESPONSE")
        self.assertIn(MESSAGES["repeated_cursor"], caught.exception.message)

    def test_a_proxy_html_page_with_a_retry_after_date_is_waited_out_on_a_read_and_a_4xx_page_is_not(self) -> None:
        import email.utils

        started = FakeClock().time()
        gv, wire, clock = client([
            {"status": 503, "headers": {"Content-Type": "text/html", "Retry-After": email.utils.formatdate(started + 7, usegmt=True)}, "text": "<html>busy</html>"},
            {"status": 200, "json": {"key": {}}},
        ])
        gv.get_me()
        self.assertEqual(wire.calls[1].at - wire.calls[0].at, 7.0)
        refused, wire2, _ = client([{"status": 403, "headers": {"Retry-After": "5"}, "text": "<html>no</html>"}])
        with self.assertRaises(GptVideoNetworkError) as caught:
            refused.get_me()
        self.assertEqual((caught.exception.code, caught.exception.status, caught.exception.retryable), ("BAD_RESPONSE", 403, False))
        self.assertNotIn("<html>", caught.exception.message)
        self.assertEqual(len(wire2.calls), 1)

    def test_an_unreadable_retry_after_is_a_backoff_and_one_past_the_ceiling_ends_the_call_with_retry_after_sec(self) -> None:
        import email.utils

        for raw in ("-1", "abc", "1e9", "1.5", ""):
            gv, wire, clock = client([api_error("UNAVAILABLE", 503, {"Retry-After": raw}), {"status": 200, "json": {"key": {}}}])
            clock.random_value = 0.5
            gv.get_me()
            self.assertEqual(wire.calls[1].at - wire.calls[0].at, 0.25, raw)
        gv, wire, clock = client([api_error("UNAVAILABLE", 503, {"Retry-After": email.utils.formatdate(0, usegmt=True)}), {"status": 200, "json": {"key": {}}}])
        clock.random_value = 0.5
        gv.get_me()
        self.assertEqual(wire.calls[1].at - wire.calls[0].at, 0.25, "a date in the past is absent")
        for raw in (str(RETRY_AFTER_MAX_SEC + 1), "9" * 400, "9" * 5000):
            gv, wire, _ = client([api_error("UNAVAILABLE", 503, {"Retry-After": raw})])
            with self.assertRaises(GptVideoApiError, msg=raw) as caught:
                gv.get_me()
            self.assertEqual((caught.exception.code, caught.exception.retryable), ("UNAVAILABLE", True))
            self.assertGreater(caught.exception.retry_after_sec or 0, RETRY_AFTER_MAX_SEC)
            self.assertEqual(len(wire.calls), 1)
        gv, wire, clock = client([api_error("UNAVAILABLE", 503, {"Retry-After": email.utils.formatdate(FakeClock().time() + 61, usegmt=True)})])
        with self.assertRaises(GptVideoApiError) as caught:
            gv.get_me()
        self.assertEqual(caught.exception.retry_after_sec, 61)
        self.assertEqual(len(wire.calls), 1)

    def test_a_status_nobody_knows_ends_the_wait_when_finished_at_is_set_and_at_the_end_of_the_time_when_it_is_not(self) -> None:
        def read(**job: Any) -> Dict[str, Any]:
            return {"status": 200, "json": {"job": {"id": "job_1", "errorMessage": None, **job}}}

        gv, wire, _ = client([read(status="archived", finishedAt="2026-10-11T12:00:30.000Z")])
        self.assertEqual(gv.wait({"job": {"id": "job_1", "status": "queued"}})["status"], "archived")
        self.assertEqual(len(wire.calls), 1)

        endless, wire2, _ = client(lambda call, _: {**read(status="archived", finishedAt=None), "afterMs": 25_000})
        with self.assertRaises(GptVideoJobError) as caught:
            endless.wait({"job": {"id": "job_1", "status": "queued"}}, timeout=100)
        error = caught.exception
        self.assertEqual((error.code, error.retryable, error.handle["status"]), ("WAIT_TIMEOUT", True, "archived"))
        self.assertIn("Its last status is archived.", error.message)
        self.assertEqual(len(wire2.calls), 4)

        rendering, wire3, _ = client([
            {"status": 200, "json": {"export": {"id": "exp_1", "status": "rendering", "finishedAt": None}}, "afterMs": 25_000},
            {"status": 200, "json": {"export": {"id": "exp_1", "status": "done", "finishedAt": "2026-10-11T12:00:30.000Z", "downloadUrl": "https://x/y"}}},
        ])
        self.assertEqual(rendering.wait({"export": {"id": "exp_1", "status": "rendering"}})["status"], "done")
        self.assertEqual(len(wire3.calls), 2)

    def test_a_base_url_written_with_or_without_v1_sends_one_and_the_same_request(self) -> None:
        for base_url in ("https://api.gpt-video.com/v1", "https://api.gpt-video.com", "https://api.gpt-video.com/v1/", "https://api.gpt-video.com/"):
            gv, wire, _ = client([{"status": 200, "json": {"key": {}}}], base_url=base_url)
            gv.get_me()
            self.assertEqual(wire.calls[0].url, "https://api.gpt-video.com/v1/me", base_url)
            self.assertEqual(gv.base_url, "https://api.gpt-video.com/v1", base_url)
        gv, wire, _ = client([{"status": 200, "json": {"key": {}}}], base_url="https://example.com/api/v1")
        gv.get_me()
        self.assertEqual(wire.calls[0].url, "https://example.com/api/v1/me")


if __name__ == "__main__":
    unittest.main()
