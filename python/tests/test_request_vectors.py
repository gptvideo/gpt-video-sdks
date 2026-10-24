"""Every vector of requests.generated.json, one of the shared vectors, run on the real client: one example of the API
reference each, generated from the catalogue. The request the client sends must be the one the vector writes
(method, path segment by segment, query parameter by parameter, JSON body, Idempotency-Key, bytes), and the one
response must become the result, or the error, the vector says."""

import json
import re
import unittest
import urllib.parse
from typing import Any, Dict, Optional

from gpt_video import GptVideo
from gpt_video._generated import API_CONTRACT, OPERATIONS
from gpt_video.errors import GptVideoApiError, GptVideoError, GptVideoNetworkError

from .support import FakeClock, FakeWire, Recorded, api_key, read_vectors

REQUESTS = read_vectors("requests.generated.json")
KEYS = read_vectors("keys.json")
GENERATED_KEY = re.compile(KEYS["generators"]["python"]["pattern"])
API_KEY = api_key("V")
SPECS = {row["id"]: row for row in OPERATIONS}


def run(vector: Dict[str, Any], response: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    answer = response if response is not None else vector["response"]
    clock = FakeClock()
    wire = FakeWire(clock, [{"status": answer["status"], "headers": answer.get("headers") or {}, "json": answer["body"]}])
    client = GptVideo._with_wire(wire, clock, api_key=API_KEY, base_url=REQUESTS["baseUrl"], max_retries=0)
    method = getattr(client, vector["operation"])
    options = {"idempotency_key": vector["options"]["idempotencyKey"]} if vector.get("options", {}).get("idempotencyKey") else {}
    out: Dict[str, Any] = {"wire": wire}
    try:
        if SPECS[vector["operation"]]["binary"] is not None:
            out["value"] = method(vector["input"], bytes(vector["bodyBytes"]), **options)
        else:
            out["value"] = method(vector["input"], **options)
    except GptVideoError as error:
        out["error"] = error
    return out


class RequestVectors(unittest.TestCase):
    def test_were_generated_from_the_contract_of_this_client(self) -> None:
        self.assertEqual(REQUESTS["contract"], dict(API_CONTRACT))
        self.assertGreaterEqual(len({v["operation"] for v in REQUESTS["vectors"]}), 60, "every operation has an example")

    def check_request(self, call: Recorded, want: Dict[str, Any], vector: Dict[str, Any]) -> None:
        self.assertEqual(call.method, want["method"])
        url = urllib.parse.urlsplit(call.url)
        base = urllib.parse.urlsplit(REQUESTS["baseUrl"])
        self.assertEqual((url.scheme, url.netloc), (base.scheme, base.netloc))
        self.assertTrue(url.path.startswith(base.path + "/"), url.path)
        segments = [urllib.parse.unquote(s) for s in url.path[len(base.path) + 1 :].split("/")]
        self.assertEqual(segments, want["segments"], "path, segment by segment")
        pairs = urllib.parse.parse_qsl(url.query, keep_blank_values=True)
        self.assertEqual(dict(pairs), want["query"], "query, parameter by parameter")
        self.assertEqual(len(pairs), len(want["query"]), "no query parameter twice")
        if "contentType" not in want:
            return
        if want["contentType"] is None:
            self.assertNotIn("content-type", call.headers)
        else:
            self.assertEqual(call.headers.get("content-type"), want["contentType"])
        if want["json"] is not None:
            self.assertEqual(json.loads(call.body or b""), want["json"])
        if want["bytes"] is not None:
            self.assertEqual(len(call.body or b""), want["bytes"])
        if want["json"] is None and want["bytes"] is None:
            self.assertIsNone(call.body, "no body")
        key = call.headers.get("idempotency-key")
        if want["idempotencyKey"] == "none":
            self.assertIsNone(key)
        elif want["idempotencyKey"] == "caller":
            self.assertEqual(key, vector["options"]["idempotencyKey"])
        else:
            self.assertRegex(key or "", GENERATED_KEY)

    def check_vector(self, vector: Dict[str, Any]) -> None:
        got = run(vector)
        wire: FakeWire = got["wire"]
        self.assertEqual(len(wire.calls), 1, "one request: max_retries is 0")
        call = wire.calls[0]
        self.check_request(call, vector["request"], vector)
        self.assertEqual(call.headers.get("authorization"), f"Bearer {API_KEY}")
        want = vector["outcome"]
        if want["kind"] == "result":
            self.assertNotIn("error", got, "no error")
            self.assertEqual(got["value"], vector["response"]["body"], "the body of the answer, unchanged")
            return
        e = want["error"]
        error = got.get("error")
        self.assertIsInstance(error, GptVideoError)
        assert isinstance(error, GptVideoError)
        if e["class"] == "api":
            self.assertIsInstance(error, GptVideoApiError)
        if e["class"] == "network":
            self.assertIsInstance(error, GptVideoNetworkError)
        self.assertEqual(error.code, e["code"])
        self.assertEqual(getattr(error, "status", None), e["status"])
        self.assertEqual(error.retryable, e["retryable"], "retryable")
        self.assertEqual(error.may_have_spent, e["mayHaveSpent"], "may_have_spent")
        self.assertEqual(getattr(error, "retry_after_sec", None), e["retryAfterSec"], "retry_after_sec")
        self.assertEqual(error.operation, vector["operation"])
        if "requestId" in e:
            self.assertEqual(getattr(error, "request_id", None), e["requestId"])
        if "hint" in e:
            self.assertEqual(getattr(error, "hint", None), e["hint"])
        if "details" in e:
            self.assertEqual(getattr(error, "details", None), e["details"])
        self.assertEqual(error.idempotency_key, call.headers.get("idempotency-key"), "the key of the call, to send again")

    def check_encoding(self, vector: Dict[str, Any]) -> None:
        got = run(vector, {"status": 200, "body": {}})
        self.check_request(got["wire"].calls[0], vector["request"], vector)


def _name(text: str) -> str:
    return re.sub(r"\W+", "_", text.encode("ascii", "backslashreplace").decode("ascii")).strip("_")


for _index, _vector in enumerate(REQUESTS["vectors"]):

    def _test(self: RequestVectors, vector: Dict[str, Any] = _vector) -> None:
        self.check_vector(vector)

    _test.__doc__ = _vector["name"]
    setattr(RequestVectors, f"test_{_index:03d}_{_name(_vector['name'])}", _test)

for _index, _vector in enumerate(REQUESTS["encoding"]):

    def _encoding(self: RequestVectors, vector: Dict[str, Any] = _vector) -> None:
        self.check_encoding(vector)

    _encoding.__doc__ = f"encoding: {_vector['name']}"
    setattr(RequestVectors, f"test_encoding_{_index:03d}_{_name(_vector['name'])}", _encoding)
