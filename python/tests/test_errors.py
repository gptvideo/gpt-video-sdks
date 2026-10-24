"""The errors: the one shape of the message, the fixed sentences, and the classes."""

import pickle
import unittest

from gpt_video import GptVideoApiError, GptVideoError, GptVideoJobError, GptVideoNetworkError
from gpt_video.errors import (
    CONSOLE_URL,
    INVALID_ARGUMENT,
    JOB_ERROR_CODES,
    MESSAGES,
    NETWORK_ERROR_CODES,
    SERVER_TEXT_MAX,
    TEXTS,
    WEBHOOK_VERIFICATION_FAILED,
    WebhookVerificationError,
    duration_text,
    format_error_message,
)
from gpt_video.webhooks import WebhookVerificationError as FromWebhooks


class MessageShape(unittest.TestCase):
    def test_is_code_status_message_hint_request_id_then_the_charge_sentence_then_the_note(self) -> None:
        text = format_error_message("INTERNAL", "It broke.", status=500, hint="Try again.", request_id="req_1", may_have_spent=True, note="One more thing.")
        self.assertEqual(text, f"INTERNAL (500): It broke. Hint: Try again. [request req_1] {MESSAGES['may_have_spent']} One more thing.")

    def test_leaves_out_a_part_that_has_no_value_with_its_label(self) -> None:
        self.assertEqual(format_error_message("TIMEOUT", "No answer within 60 seconds."), "TIMEOUT: No answer within 60 seconds.")
        self.assertEqual(format_error_message("CONFLICT", "Changed.", status=409, hint=None, request_id=""), "CONFLICT (409): Changed.")

    def test_cuts_a_server_text_longer_than_the_limit_and_never_a_sentence_of_the_sdk(self) -> None:
        long = "x" * (SERVER_TEXT_MAX + 50)
        text = format_error_message("INTERNAL", long, hint=long, may_have_spent=True)
        self.assertIn("x" * (SERVER_TEXT_MAX - 1) + "…", text)
        self.assertNotIn("x" * SERVER_TEXT_MAX, text)
        self.assertTrue(text.endswith(MESSAGES["may_have_spent"]))


class FixedSentences(unittest.TestCase):
    def test_say_after_an_unknown_outcome_that_it_may_be_charged_and_how_to_ask_again(self) -> None:
        self.assertIn("may have been charged", MESSAGES["may_have_spent"])
        self.assertIn("the same idempotency_key", MESSAGES["may_have_spent"])

    def test_say_where_keys_come_from_with_the_names_of_this_sdk(self) -> None:
        self.assertIn(CONSOLE_URL, MESSAGES["missing_api_key"])
        self.assertIn("GPT_VIDEO_API_KEY", MESSAGES["missing_api_key"])
        self.assertIn("api_key", MESSAGES["missing_api_key"])
        for text in MESSAGES.values():
            self.assertNotRegex(text, r"\b(apiKey|idempotencyKey|baseUrl|listAssets|createProject)\b", text)

    def test_are_frozen(self) -> None:
        with self.assertRaises(TypeError):
            MESSAGES["aborted"] = "changed"  # type: ignore[index]

    def test_say_durations_as_the_javascript_sdk_does(self) -> None:
        cases = {60: "60 seconds", 1: "1 second", 2.5: "2.5 seconds", 0.25: "0.3 seconds", 0.1: "0.1 seconds", 90: "90 seconds", 120: "2 minutes", 3600: "60 minutes", 150: "150 seconds", 600: "10 minutes"}
        for seconds, text in cases.items():
            self.assertEqual(duration_text(seconds), text, seconds)
        self.assertEqual(TEXTS.timeout(60), "No answer within 60 seconds.")
        self.assertEqual(TEXTS.wait_timeout("job_1", "running", 3600), "job_1 did not finish within 60 minutes. Its last status is running.")
        self.assertEqual(TEXTS.wait_timeout("job_1", None, 30), "job_1 did not finish within 30 seconds.")


class Classes(unittest.TestCase):
    def test_an_api_error_carries_what_the_api_said_and_its_place_in_the_hierarchy(self) -> None:
        error = GptVideoApiError("INTERNAL (500): x", code="INTERNAL", status=500, request_id="req_1", hint="h", details={"a": 1}, retry_after_sec=3, retryable=True, operation="get_me", idempotency_key="k", may_have_spent=True)
        self.assertIsInstance(error, GptVideoError)
        self.assertIsInstance(error, Exception)
        self.assertEqual(
            (error.code, error.status, error.request_id, error.hint, error.details, error.retry_after_sec, error.retryable, error.operation, error.idempotency_key, error.may_have_spent),
            ("INTERNAL", 500, "req_1", "h", {"a": 1}, 3, True, "get_me", "k", True),
        )
        self.assertEqual(str(error), "INTERNAL (500): x")
        self.assertEqual(error.message, "INTERNAL (500): x")

    def test_an_omitted_field_is_none_or_false_so_a_caller_can_test_it_without_guessing(self) -> None:
        network = GptVideoNetworkError("TIMEOUT: x", code="TIMEOUT")
        self.assertEqual((network.status, network.retry_after_sec, network.retryable, network.operation, network.idempotency_key, network.may_have_spent), (None, None, False, None, None, False))
        job = GptVideoJobError("JOB_FAILED: x", code="JOB_FAILED", handle={"id": "job_1"})
        self.assertEqual((job.handle, job.error_message), ({"id": "job_1"}, None))

    def test_keeps_its_fields_through_pickle_so_an_error_can_cross_processes(self) -> None:
        error = GptVideoApiError("CONFLICT (409): x", code="CONFLICT", status=409, details={"stale": True}, idempotency_key="k")
        copy = pickle.loads(pickle.dumps(error))
        self.assertIs(type(copy), GptVideoApiError)
        self.assertEqual((copy.message, copy.code, copy.status, copy.details, copy.idempotency_key), (error.message, "CONFLICT", 409, {"stale": True}, "k"))

    def test_a_webhook_error_has_one_code_and_a_reason_and_is_the_same_class_from_both_modules(self) -> None:
        error = WebhookVerificationError("WEBHOOK_VERIFICATION_FAILED: x", reason="bad_secret")
        self.assertEqual((error.code, error.reason), (WEBHOOK_VERIFICATION_FAILED, "bad_secret"))
        self.assertIs(FromWebhooks, WebhookVerificationError)

    def test_the_codes_of_the_sdk_are_distinct(self) -> None:
        own = [*NETWORK_ERROR_CODES, *JOB_ERROR_CODES, INVALID_ARGUMENT, WEBHOOK_VERIFICATION_FAILED]
        self.assertEqual(len(set(own)), len(own))
