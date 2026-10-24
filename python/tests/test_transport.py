"""The settings of a client, the request of a call, what an answer means, and where the key may go."""

import copy
import json
import pickle
import re
import threading
import unittest
import urllib.parse
import warnings
from typing import Any, Dict, List

from gpt_video import GptVideo, GptVideoApiError, GptVideoError, GptVideoNetworkError
from gpt_video._generated import CONVENTIONS, OPERATIONS
from gpt_video._redact import REDACTED, Secret
from gpt_video._retry import DEADLINE, MAX_RETRIES, TIMEOUT
from gpt_video._table import UNSET
from gpt_video._transport import MAX_DURATION, OperationIndex, resolve_base_url, resolve_settings
from gpt_video._version import VERSION
from gpt_video.errors import MESSAGES

from .support import Events, FakeClock, FakeWire, api_key

KEY = api_key()


def client(script: Any = None, **options: Any) -> "tuple[GptVideo, FakeWire]":
    clock = FakeClock()
    wire = FakeWire(clock, script if script is not None else [{"status": 200, "json": {}}] * 10)
    options.setdefault("api_key", KEY)
    return GptVideo._with_wire(wire, clock, **options), wire


class Settings(unittest.TestCase):
    def invalid(self, message_part: str, **options: Any) -> GptVideoError:
        with self.assertRaises(GptVideoError) as caught:
            resolve_settings(**options)
        self.assertEqual(caught.exception.code, "INVALID_ARGUMENT")
        self.assertIn(message_part, caught.exception.message)
        return caught.exception

    def test_reads_the_key_from_the_environment_when_api_key_is_not_given(self) -> None:
        self.assertEqual(resolve_settings(environ={"GPT_VIDEO_API_KEY": KEY}).api_key.reveal(), KEY)
        self.assertEqual(resolve_settings(api_key=KEY, environ={}).api_key.reveal(), KEY)
        self.assertEqual(CONVENTIONS["apiKeyEnv"], "GPT_VIDEO_API_KEY")

    def test_says_where_keys_come_from_when_there_is_none(self) -> None:
        for env in ({}, {"GPT_VIDEO_API_KEY": ""}):
            self.invalid(MESSAGES["missing_api_key"], environ=env)
        self.invalid(MESSAGES["missing_api_key"], api_key="", environ={"GPT_VIDEO_API_KEY": KEY})

    def test_refuses_a_value_that_is_not_a_key_and_never_repeats_it(self) -> None:
        for value in ("sk_live_" + "x" * 30, "whsec_abcdefgh", "gv_" + "y" * 30, 42):
            error = self.invalid(MESSAGES["bad_api_key_prefix"], api_key=value)
            if isinstance(value, str):
                self.assertNotIn(value[4:], error.message)

    def test_refuses_a_key_with_a_space_or_a_line_break_and_never_repeats_it(self) -> None:
        for value in (KEY + "\n", " " + KEY, KEY[:10] + " " + KEY[10:], KEY + "é"):
            error = self.invalid(MESSAGES["bad_api_key_characters"], api_key=value)
            self.assertNotIn(KEY[4:], error.message)

    def test_checks_every_number(self) -> None:
        for value in (-1, 1.5, True, "2", 2**53):
            self.invalid("max_retries must be a whole number, 0 or more.", api_key=KEY, max_retries=value)
        for name in ("timeout", "deadline"):
            for value in (0, -1, float("inf"), float("nan"), True, "60", MAX_DURATION * 2):
                self.invalid(f"{name} must be a number of seconds, more than 0 and at most {MAX_DURATION}.", api_key=KEY, **{name: value})
        settings = resolve_settings(api_key=KEY, max_retries=0, timeout=0.5, deadline=MAX_DURATION)
        self.assertEqual((settings.max_retries, settings.timeout, settings.deadline), (0, 0.5, MAX_DURATION))

    def test_has_the_defaults_of_retry_json_and_the_base_url_of_the_documentation(self) -> None:
        settings = resolve_settings(api_key=KEY)
        self.assertEqual((settings.max_retries, settings.timeout, settings.deadline), (MAX_RETRIES, TIMEOUT, DEADLINE))
        self.assertEqual(settings.origin.base_url, CONVENTIONS["baseUrl"])

    def test_adds_a_suffix_to_the_user_agent_only_in_visible_ascii(self) -> None:
        self.assertEqual(resolve_settings(api_key=KEY).user_agent, f"gpt-video-python/{VERSION}")
        self.assertEqual(resolve_settings(api_key=KEY, user_agent_suffix="my-app/2.1 (build 7)").user_agent, f"gpt-video-python/{VERSION} my-app/2.1 (build 7)")
        for suffix in ("", " x", "x ", "a\nb", "caffè", "x" * 257, 3):
            self.invalid("user_agent_suffix must be 1 to 256 visible ASCII characters", api_key=KEY, user_agent_suffix=suffix)
        self.assertRegex(resolve_settings(api_key=KEY).user_agent, r"^gpt-?video-", "the request log of the API counts it as an SDK")

    def test_refuses_hooks_that_are_not_functions(self) -> None:
        self.invalid("on_response must be a function.", api_key=KEY, on_response="print")
        self.invalid("on_retry must be a function.", api_key=KEY, on_retry=3)


class BaseUrl(unittest.TestCase):
    def test_sends_the_same_request_with_or_without_its_final_v1(self) -> None:
        for raw in ("https://api.gpt-video.com/v1", "https://api.gpt-video.com/v1/", "https://api.gpt-video.com", "https://api.gpt-video.com/", "https://API.gpt-video.com:443/v1"):
            origin = resolve_base_url(raw)
            self.assertEqual((origin.root, origin.base_url), ("https://api.gpt-video.com", "https://api.gpt-video.com/v1"), raw)
        local = resolve_base_url("http://127.0.0.1:8080/api/v1")
        self.assertEqual((local.root, local.base_url, local.use_proxies), ("http://127.0.0.1:8080/api", "http://127.0.0.1:8080/api/v1", False))

    def test_never_doubles_v1_in_the_request(self) -> None:
        for base in ("https://www.gpt-video.com/api/v1", "https://www.gpt-video.com/api"):
            gv, wire = client([{"status": 200, "json": {}}], base_url=base)
            gv.get_me()
            self.assertEqual(wire.calls[0].url, "https://www.gpt-video.com/api/v1/me")

    def test_takes_http_only_for_this_machine(self) -> None:
        for raw in ("http://localhost:3000/api/v1", "http://app.localhost/v1", "http://127.0.0.1/v1", "http://127.9.9.9:1/v1", "http://[::1]:8000/v1"):
            self.assertFalse(resolve_base_url(raw).use_proxies, raw)
        self.assertTrue(resolve_base_url("https://api.gpt-video.com/v1").use_proxies)
        for raw in ("http://api.gpt-video.com/v1", "http://192.168.1.10/v1", "http://localhost.example.com/v1", "http://127.0.0.1.example.com/v1"):
            with self.assertRaises(GptVideoError, msg=raw) as caught:
                resolve_base_url(raw)
            self.assertIn(MESSAGES["insecure_base_url"], caught.exception.message)

    def test_refuses_what_is_not_a_plain_base_url(self) -> None:
        cases = {
            "https://user:pass@api.gpt-video.com/v1": "must not hold a user name or a password",
            "https://api.gpt-video.com/v1?x=1": "must not have a query or a fragment",
            "https://api.gpt-video.com/v1#top": "must not have a query or a fragment",
            "api.gpt-video.com/v1": "is not an absolute URL",
            "ftp://api.gpt-video.com/v1": "is not an absolute URL",
            "https://api.gpt-video.com/v 1": "is not an absolute URL",
            "https://api.gpt-video.com:99999/v1": "is not an absolute URL",
        }
        for raw, part in cases.items():
            with self.assertRaises(GptVideoError, msg=raw) as caught:
                resolve_base_url(raw)
            self.assertIn(part, caught.exception.message, raw)
        with self.assertRaises(GptVideoError):
            resolve_base_url(42)


class Request(unittest.TestCase):
    def test_a_read_carries_the_key_in_authorization_json_in_accept_the_sdk_in_user_agent_and_nothing_else(self) -> None:
        gv, wire = client()
        gv.get_project(projectId="prj_1")
        call = wire.calls[0]
        self.assertEqual(call.method, "GET")
        self.assertEqual(call.url, "https://api.gpt-video.com/v1/projects/prj_1")
        self.assertEqual(call.headers, {"accept": "application/json", "user-agent": f"gpt-video-python/{VERSION}", "authorization": f"Bearer {KEY}"})
        self.assertIsNone(call.body)

    def test_puts_the_fields_of_a_spend_in_the_json_body_and_its_key_in_idempotency_key(self) -> None:
        gv, wire = client()
        gv.create_export({"compositionId": "cmp_1", "note": "caffè"})
        call = wire.calls[0]
        self.assertEqual(call.url, "https://api.gpt-video.com/v1/compositions/cmp_1/exports")
        self.assertEqual(call.headers["content-type"], "application/json")
        self.assertEqual(json.loads(call.body or b""), {"note": "caffè"})
        self.assertRegex(call.headers["idempotency-key"], r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")

    def test_sends_no_body_at_all_when_no_field_goes_in_it(self) -> None:
        gv, wire = client()
        gv.analyze_project(projectId="prj_1")
        call = wire.calls[0]
        self.assertIsNone(call.body)
        self.assertNotIn("content-type", call.headers)

    def test_makes_a_key_for_a_post_that_writes_and_never_sends_one_where_the_api_does_not_read_it(self) -> None:
        gv, wire = client()
        gv.accept_clip(clipId="clp_1")
        gv.update_project(projectId="prj_1", title="t")
        gv.cancel_upload(uploadId="upl_1")
        self.assertIn("idempotency-key", wire.calls[0].headers)
        self.assertNotIn("idempotency-key", wire.calls[1].headers)
        self.assertNotIn("idempotency-key", wire.calls[2].headers)
        for row in OPERATIONS:
            if row["method"] == "GET":
                self.assertEqual(row["idempotencyKey"], "none", row["id"])
            if row["effect"] == "spend":
                self.assertEqual((row["idempotencyKey"], row["retrySafe"]), ("required", True), row["id"])

    def test_refuses_a_key_where_the_api_does_not_read_one_and_a_malformed_one_before_sending(self) -> None:
        gv, wire = client()
        with self.assertRaises(TypeError):
            gv.get_me(idempotency_key="k")  # type: ignore[call-arg]
        transport = gv._transport
        spec = next(row for row in OPERATIONS if row["id"] == "get_me")
        with self.assertRaises(GptVideoError) as caught:
            transport.send(spec, {}, {"idempotency_key": "k"})
        self.assertIn("get_me takes no idempotency_key", caught.exception.message)
        for bad in ("order 42", "", "x" * 256, "caffè", "a\n"):
            with self.assertRaises(GptVideoError, msg=repr(bad)) as caught:
                gv.analyze_project(projectId="prj_1", idempotency_key=bad)
            self.assertEqual(caught.exception.code, "INVALID_ARGUMENT")
            self.assertIn(MESSAGES["bad_idempotency_key"], caught.exception.message)
        self.assertEqual(wire.calls, [])

    def test_writes_query_values_in_the_forms_the_api_reads_and_refuses_what_it_cannot_write(self) -> None:
        gv, wire = client()
        gv.list_clips(projectId="prj_1", limit=7, status="accepted")
        gv.get_transcript(assetId="ast_1", words=False)
        self.assertEqual(urllib.parse.urlsplit(wire.calls[0].url).query, "status=accepted&limit=7")
        self.assertEqual(urllib.parse.urlsplit(wire.calls[1].url).query, "words=false")
        for bad in (None, 1.5, -1, {"a": 1}, [1], 2**53):
            with self.assertRaises(GptVideoError, msg=repr(bad)) as caught:
                gv.list_clips(projectId="prj_1", limit=bad)
            self.assertIn("limit must be a string, True or False, or a whole number 0 or more: list_clips sends it in the URL.", caught.exception.message)
        self.assertEqual(len(wire.calls), 2)

    def test_percent_encodes_a_query_value_whole_a_space_as_20_and_a_plus_as_2b(self) -> None:
        gv, wire = client()
        gv.list_ledger_entries(cursor="a b+c/d&e=f?g#h%")
        self.assertEqual(urllib.parse.urlsplit(wire.calls[0].url).query, "cursor=a%20b%2Bc%2Fd%26e%3Df%3Fg%23h%25")

    def test_encodes_path_values_and_refuses_the_two_that_a_url_parser_would_walk_with(self) -> None:
        gv, wire = client()
        gv.get_project(projectId="a/b c")
        self.assertEqual(wire.calls[0].url, "https://api.gpt-video.com/v1/projects/a%2Fb%20c")
        for bad, part in ((".", 'projectId cannot be "."'), ("..", 'projectId cannot be ".."'), ("", "get_project needs projectId."), (None, "get_project needs projectId."), (True, "projectId must be a non-empty string or a whole number."), (1.5, "projectId must be a non-empty string or a whole number.")):
            with self.assertRaises(GptVideoError, msg=repr(bad)) as caught:
                gv.get_project(projectId=bad)
            self.assertIn(part, caught.exception.message)
        with self.assertRaises(GptVideoError) as caught:
            gv.get_project()
        self.assertIn("get_project needs projectId.", caught.exception.message)
        self.assertEqual(len(wire.calls), 1)

    def test_refuses_text_with_a_lone_surrogate_in_the_url_and_escapes_it_in_a_json_body(self) -> None:
        gv, wire = client()
        for call in (lambda: gv.get_project(projectId="a\ud800"), lambda: gv.list_ledger_entries(cursor="\udfff")):
            with self.assertRaises(GptVideoError) as caught:
                call()
            self.assertIn("is not well-formed text: it has a lone surrogate.", caught.exception.message)
        self.assertEqual(wire.calls, [])
        gv.update_project(projectId="prj_1", title="a\ud800")
        self.assertIn(b'"title":"a\\ud800"', wire.calls[0].body or b"")

    def test_refuses_an_input_that_is_not_a_dict_and_a_body_json_cannot_write(self) -> None:
        gv, wire = client()
        for params in ("prj_1", ["prj_1"], 3):
            with self.assertRaises(GptVideoError) as caught:
                gv.get_project(params)  # type: ignore[arg-type]
            self.assertIn("The input of get_project must be a dict.", caught.exception.message)
        for title in (float("nan"), object(), {1, 2}):
            with self.assertRaises(GptVideoError) as caught:
                gv.update_project(projectId="prj_1", title=title)
            self.assertIn("The input of update_project cannot be written as JSON", caught.exception.message)
        with self.assertRaises(GptVideoError) as caught:
            gv.update_project({1: "x", "projectId": "prj_1"})  # type: ignore[dict-item]
        self.assertIn("must be named with strings", caught.exception.message)
        self.assertEqual(wire.calls, [])

    def test_takes_the_input_as_one_dict_or_as_keyword_arguments_never_both(self) -> None:
        gv, wire = client()
        gv.update_project({"projectId": "prj_1", "title": "a"})
        gv.update_project(projectId="prj_1", title="a")
        self.assertEqual(wire.calls[0].url, wire.calls[1].url)
        self.assertEqual(wire.calls[0].body, wire.calls[1].body)
        with self.assertRaises(GptVideoError) as caught:
            gv.update_project({"projectId": "prj_1"}, title="a")
        self.assertIn("Pass the fields of update_project as one dict or as keyword arguments, not both.", caught.exception.message)
        with self.assertRaises(TypeError):
            gv.update_project(projectID="prj_1")  # type: ignore[call-arg]
        self.assertEqual(len(wire.calls), 2)

    def test_leaves_out_a_field_at_unset_and_sends_none_as_null(self) -> None:
        gv, wire = client()
        gv.update_project({"projectId": "prj_1", "title": UNSET, "settings": None})
        self.assertEqual(json.loads(wire.calls[0].body or b""), {"settings": None})

    def test_sends_the_bytes_of_an_operation_that_sends_bytes_with_its_content_type_and_checks_their_size(self) -> None:
        gv, wire = client()
        gv.upload_part({"uploadId": "upl_1", "partNumber": 2}, b"\x00\x01\x02")
        gv.upload_part(body=bytearray(b"abc"), uploadId="upl_1", partNumber=3)
        call = wire.calls[0]
        self.assertEqual(call.url, "https://api.gpt-video.com/v1/uploads/upl_1/parts/2")
        self.assertEqual((call.headers["content-type"], call.body), ("application/octet-stream", b"\x00\x01\x02"))
        self.assertEqual(wire.calls[1].body, b"abc")
        spec = next(row for row in OPERATIONS if row["id"] == "upload_part")
        cases = ((None, "upload_part sends bytes: pass bytes, a bytearray or a memoryview."), ("text", "upload_part sends bytes"), (b"x" * (spec["binary"]["maxBytes"] + 1), f"upload_part sends at most {spec['binary']['maxBytes']} bytes."))
        for body, part in cases:
            with self.assertRaises(GptVideoError) as caught:
                gv.upload_part({"uploadId": "upl_1", "partNumber": 1}, body)  # type: ignore[arg-type]
            self.assertIn(part, caught.exception.message)
        get_me = next(row for row in OPERATIONS if row["id"] == "get_me")
        with self.assertRaises(GptVideoError) as caught:
            gv._transport.send(get_me, {}, {}, b"x")
        self.assertIn("get_me sends no bytes.", caught.exception.message)
        self.assertEqual(len(wire.calls), 2)

    def test_refuses_call_options_it_does_not_have(self) -> None:
        gv, _ = client()
        spec = next(row for row in OPERATIONS if row["id"] == "get_me")
        with self.assertRaises(GptVideoError) as caught:
            gv._transport.send(spec, {}, {"signal": object()})
        self.assertIn("get_me has no option signal.", caught.exception.message)
        with self.assertRaises(GptVideoError) as caught:
            gv.get_me(cancel="stop")  # type: ignore[arg-type]
        self.assertIn("cancel must be a threading.Event", caught.exception.message)


class Answers(unittest.TestCase):
    def test_a_redirect_is_never_followed(self) -> None:
        gv, wire = client([{"status": 302, "headers": {"Location": "https://example.com/v1/me"}, "text": ""}])
        with self.assertRaises(GptVideoNetworkError) as caught:
            gv.get_me()
        self.assertEqual((caught.exception.code, caught.exception.status, caught.exception.retryable), ("BAD_RESPONSE", 302, False))
        self.assertIn(MESSAGES["redirect"], caught.exception.message)
        self.assertEqual(len(wire.calls), 1)

    def test_is_the_api_error_only_with_an_error_code_in_the_api_form(self) -> None:
        for body in ({"error": {"code": "not_a_code", "message": "x"}}, {"error": "INTERNAL"}, {"message": "x"}, [1]):
            gv, _ = client([{"status": 400, "json": body}])
            with self.assertRaises(GptVideoNetworkError, msg=repr(body)) as caught:
                gv.get_me()
            self.assertEqual(caught.exception.code, "BAD_RESPONSE")
            self.assertIn(MESSAGES["not_api_error"], caught.exception.message)
        gv, _ = client([{"status": 404, "json": {"error": {"code": "NOT_FOUND"}}}])
        with self.assertRaises(GptVideoApiError) as caught:
            gv.get_me()
        self.assertIn(MESSAGES["no_server_message"], caught.exception.message)

    def test_a_retry_after_of_thousands_of_digits_ends_a_spend_with_its_key_never_with_a_value_error(self) -> None:
        huge = {"Retry-After": "9" * 5000}
        gv, wire = client([{"status": 503, "headers": huge, "json": {"error": {"code": "UNAVAILABLE", "message": "Busy."}}}])
        with self.assertRaises(GptVideoApiError) as caught:
            gv.analyze_project(projectId="prj_1")
        error = caught.exception
        self.assertEqual((error.code, error.retry_after_sec, error.may_have_spent), ("UNAVAILABLE", 2**53 - 1, True))
        self.assertEqual(error.idempotency_key, wire.calls[0].headers["idempotency-key"])
        self.assertEqual(len(wire.calls), 1, "a pause longer than a minute is not waited")

    def test_takes_the_request_id_from_x_request_id_when_the_body_has_none(self) -> None:
        gv, _ = client([{"status": 409, "headers": {"X-Request-Id": "req_header"}, "json": {"error": {"code": "CONFLICT", "message": "Changed."}}}])
        with self.assertRaises(GptVideoApiError) as caught:
            gv.get_me()
        self.assertEqual(caught.exception.request_id, "req_header")

    def test_a_body_that_is_not_json_is_said_never_repeated(self) -> None:
        for text in ("<html>secret page</html>", "", "NaN", '{"a": Infinity}'):
            gv, _ = client([{"status": 200, "text": text}])
            with self.assertRaises(GptVideoNetworkError) as caught:
                gv.get_me()
            self.assertEqual((caught.exception.code, caught.exception.status), ("BAD_RESPONSE", 200))
            self.assertNotIn("secret page", caught.exception.message)
        gv, _ = client([{"status": 200, "text": "﻿{\"ok\": true}"}])
        self.assertEqual(gv.get_me(), {"ok": True}, "a byte order mark is dropped, as fetch drops it")

    def test_is_told_to_on_response_with_status_request_id_replay_and_rate_limit_and_no_header(self) -> None:
        events = Events()
        gv, _ = client([{"status": 200, "headers": {"X-Request-Id": "req_1", "Idempotent-Replayed": " TRUE ", "RateLimit-Limit": "120", "RateLimit-Remaining": "x", "RateLimit-Reset": " 30 "}, "json": {}}], on_response=events.responses.append)
        gv.get_me()
        event = events.responses[0]
        self.assertEqual((event.operation, event.status, event.request_id, event.attempt, event.replayed), ("get_me", 200, "req_1", 1, True))
        self.assertEqual((event.rate_limit.limit, event.rate_limit.remaining, event.rate_limit.reset_sec), (120, None, 30))
        self.assertEqual(sorted(vars(event) if hasattr(event, "__dict__") else event.__dataclass_fields__), ["attempt", "operation", "rate_limit", "replayed", "request_id", "status"])

    def test_says_the_name_of_a_failed_connection_and_how_to_fix_python_certificates(self) -> None:
        gv, _ = client([{"network": "connection_failed"}], max_retries=0)
        with self.assertRaises(GptVideoNetworkError) as caught:
            gv.get_me()
        self.assertIn("The connection to the API failed (ECONNREFUSED).", caught.exception.message)
        gv, _ = client([{"network": "tls"}], max_retries=0)
        with self.assertRaises(GptVideoNetworkError) as caught:
            gv.get_me()
        self.assertEqual(caught.exception.code, "CONNECTION_FAILED")
        self.assertIn(MESSAGES["python_tls"], caught.exception.message)

    def test_an_answer_that_arrives_at_the_timeout_is_a_timeout(self) -> None:
        clock = FakeClock()

        class Late(FakeWire):
            def send(self, request: Any, deadline: Any) -> Any:
                result = super().send(request, deadline)
                clock.advance(deadline.at)
                return result

        wire = Late(clock, [{"status": 200, "json": {}}])
        gv = GptVideo._with_wire(wire, clock, api_key=KEY, max_retries=0, timeout=5)
        with self.assertRaises(GptVideoNetworkError) as caught:
            gv.get_me()
        self.assertEqual(caught.exception.code, "TIMEOUT")
        self.assertIn("No answer within 5 seconds.", caught.exception.message)


class TheKey(unittest.TestCase):
    def test_never_comes_back_in_an_error_even_when_the_server_sends_it_back(self) -> None:
        other = api_key("Q")
        body = {"error": {"code": "UNAUTHORIZED", "message": f"Key {KEY} is wrong, {other} too.", "hint": f"Not {KEY}.", "requestId": f"req_{KEY}", "details": {KEY: [KEY, {"deep": other}]}}}
        gv, _ = client([{"status": 401, "json": body}])
        with self.assertRaises(GptVideoApiError) as caught:
            gv.get_me()
        error = caught.exception
        shown = f"{error.message}\n{error!r}\n{vars(error)!r}\n{pickle.loads(pickle.dumps(error))!r}"
        self.assertNotIn(KEY, shown)
        self.assertNotIn(other, shown)
        self.assertIn(REDACTED, error.message)
        self.assertEqual(error.details, {REDACTED: [REDACTED, {"deep": REDACTED}]})
        self.assertIsNone(error.__cause__)
        self.assertIsNone(error.__context__)

    def test_never_comes_back_in_on_response_or_on_retry(self) -> None:
        events = Events()
        gv, _ = client(
            [{"status": 500, "headers": {"X-Request-Id": f"req {KEY}"}, "json": {"error": {"code": "INTERNAL", "message": "x"}}}, {"status": 200, "headers": {"X-Request-Id": KEY}, "json": {}}],
            on_response=events.responses.append,
            on_retry=events.retries.append,
        )
        gv.get_me()
        self.assertNotIn(KEY, repr(events))
        self.assertEqual(events.responses[1].request_id, REDACTED)

    def test_is_printed_as_redacted_and_never_pickled_or_copied(self) -> None:
        gv, _ = client()
        self.assertEqual(repr(gv), f"GptVideo(base_url='https://api.gpt-video.com/v1', api_key='{REDACTED}')")
        self.assertEqual(str(gv), repr(gv))
        self.assertNotIn(KEY, repr(gv._transport))
        for value in (gv, gv._transport, Secret(KEY)):
            with self.assertRaises(TypeError):
                pickle.dumps(value)
            with self.assertRaises(TypeError):
                copy.copy(value)
            with self.assertRaises(TypeError):
                copy.deepcopy(value)
        self.assertFalse(hasattr(gv, "__dict__"), "a client has no attribute dict a debugger would dump")
        self.assertEqual(repr(Secret(KEY)), REDACTED)


class Hooks(unittest.TestCase):
    def test_a_hook_that_raises_never_changes_the_outcome_of_a_call(self) -> None:
        def boom(event: Any) -> None:
            raise RuntimeError("the logger broke")

        gv, wire = client([{"status": 500, "json": {"error": {"code": "INTERNAL", "message": "x"}}}, {"status": 202, "json": {"job": {"id": "job_1"}}}], on_response=boom, on_retry=boom)
        self.assertEqual(gv.analyze_project(projectId="prj_1"), {"job": {"id": "job_1"}})
        self.assertEqual(len(wire.calls), 2)

    def test_an_async_hook_is_closed_without_a_warning(self) -> None:
        async def hook(event: Any) -> None:
            raise RuntimeError("never awaited")

        gv, _ = client(on_response=hook)
        with warnings.catch_warnings():
            warnings.simplefilter("error")
            gv.get_me()


class Index(unittest.TestCase):
    def test_finds_rows_by_id_and_the_read_that_follows_each_kind_of_work(self) -> None:
        index = OperationIndex(OPERATIONS)
        self.assertEqual(index.by_id("get_me")["path"], "/v1/me")  # type: ignore[index]
        self.assertEqual({h: index.read_for(h)["id"] for h in index.handles}, {"job": "get_job", "export": "get_export", "toolRun": "get_tool_run", "turn": "get_assistant_turn"})  # type: ignore[index]
        self.assertEqual(index.list_ids, [row["id"] for row in OPERATIONS if row["paginated"]])

    def test_refuses_a_table_the_engine_could_not_trust(self) -> None:
        rows: List[Dict[str, Any]] = [dict(row) for row in OPERATIONS]
        with self.assertRaisesRegex(ValueError, "two rows for get_me"):
            OperationIndex([*rows, rows[0]])  # type: ignore[list-item]
        broken = [dict(row, method="POST") if row["id"] == "get_job" else row for row in rows]
        with self.assertRaisesRegex(ValueError, "which is not a GET of one id"):
            OperationIndex(broken)  # type: ignore[arg-type]
        twice = [dict(row, **{"async": {"handle": "job", "waitWith": "get_export"}}) if row["id"] == "analyze_project" else row for row in rows]
        with self.assertRaisesRegex(ValueError, "follows job with two reads"):
            OperationIndex(twice)  # type: ignore[arg-type]
