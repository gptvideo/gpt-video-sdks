"""The generated module, run: every type resolves, the table has the shape the engine reads and cannot change,
and every method sends its own operation with the arguments in their place."""

import inspect
import re
import typing
import unittest
from types import MappingProxyType
from typing import Any, Dict, List, Optional, Tuple

from gpt_video import _generated as generated
from gpt_video import types as public_types
from gpt_video._table import UNSET, ApiContract, Conventions, OperationSpec
from gpt_video.client import GptVideo

ROWS = generated.OPERATIONS
OPTIONS = ["timeout", "deadline", "max_retries", "cancel"]
HELPERS = {"wait", "paginate", "upload_file", "download", "wait_for_job", "wait_for_export", "wait_for_tool_run", "wait_for_assistant_turn", "base_url"}


def pascal(id: str) -> str:
    return "".join(word[:1].upper() + word[1:] for word in id.split("_"))


class Recording(generated.GptVideoOperations):
    """The mixin with a _send_operation that records what each method sends."""

    __slots__ = ("sent",)

    def __init__(self) -> None:
        self.sent: List[Tuple[str, Any, Dict[str, Any], Dict[str, Any], Any]] = []

    def _send_operation(self, operation: str, params: Any, fields: Any, options: Any, body: Any = None) -> Any:
        self.sent.append((operation, params, dict(fields), dict(options), body))
        return {"answered": operation}


class Types(unittest.TestCase):
    def test_every_public_name_exists_and_every_type_resolves_without_postponed_annotations(self) -> None:
        resolved = 0
        for name in generated.__all__:
            value = getattr(generated, name)
            if typing.is_typeddict(value):
                typing.get_type_hints(value)
                resolved += 1
        self.assertGreater(resolved, 150)
        for name, function in vars(generated.GptVideoOperations).items():
            if inspect.isfunction(function):
                typing.get_type_hints(function)

    def test_the_types_module_exports_every_type(self) -> None:
        self.assertEqual(public_types.__all__, generated.__all__)
        for name in generated.__all__:
            self.assertIs(getattr(public_types, name), getattr(generated, name))

    def test_each_operation_has_its_input_and_its_answer_and_the_input_has_the_fields_of_the_method(self) -> None:
        for row in ROWS:
            source = getattr(generated, f"{pascal(row['id'])}Input")
            output = getattr(generated, f"{pascal(row['id'])}Output")
            self.assertTrue(typing.is_typeddict(source) and typing.is_typeddict(output), row["id"])
            parameters = inspect.signature(getattr(generated.GptVideoOperations, row["id"])).parameters
            keywords = [p.name for p in parameters.values() if p.kind is inspect.Parameter.KEYWORD_ONLY]
            fields = [k for k in keywords if k not in OPTIONS and k != "idempotency_key"]
            # the TypedDict lists its required keys first, in a base class: the order of the keys is not the point
            self.assertEqual(sorted(fields), sorted(typing.get_type_hints(source)), row["id"])
            for path_param in row["pathParams"]:
                self.assertIn(path_param, source.__required_keys__, row["id"])


class Table(unittest.TestCase):
    def test_every_row_has_exactly_the_fields_of_the_table_in_its_order(self) -> None:
        fields = list(typing.get_type_hints(OperationSpec))
        self.assertGreaterEqual(len(ROWS), 60)
        for row in ROWS:
            self.assertEqual(list(row), fields, row["id"])
        self.assertEqual(list(generated.CONVENTIONS), list(typing.get_type_hints(Conventions)))
        self.assertEqual(list(generated.API_CONTRACT), list(typing.get_type_hints(ApiContract)))
        self.assertRegex(generated.API_CONTRACT["fingerprint"], r"^[0-9a-f]{64}$")

    def test_cannot_change_while_the_sdk_runs(self) -> None:
        for table in (ROWS[0], generated.CONVENTIONS, generated.CONVENTIONS["headers"], generated.API_CONTRACT, generated.API_ERRORS, generated.API_ERRORS["INTERNAL"]):
            self.assertIsInstance(table, MappingProxyType)
            with self.assertRaises(TypeError):
                table["retrySafe"] = False  # type: ignore[index]
        self.assertIsInstance(ROWS, tuple)
        self.assertIsInstance(ROWS[0]["pathParams"], tuple)
        self.assertIsInstance(generated.CONVENTIONS["finalStatuses"], tuple)

    def test_keeps_the_rules_the_engine_relies_on(self) -> None:
        for row in ROWS:
            if row["effect"] == "spend":
                self.assertEqual((row["idempotencyKey"], row["retrySafe"], row["method"]), ("required", True, "POST"), row["id"])
            if row["method"] == "GET":
                self.assertEqual(row["idempotencyKey"], "none", row["id"])
            self.assertTrue(row["path"].startswith("/v1/"), row["id"])
            self.assertEqual(re.findall(r"\{(\w+)\}", row["path"]), list(row["pathParams"]), row["id"])


class Methods(unittest.TestCase):
    def test_are_one_for_each_operation_in_the_order_of_the_table_and_none_has_the_name_of_a_helper(self) -> None:
        names = [name for name, value in vars(generated.GptVideoOperations).items() if inspect.isfunction(value) and not name.startswith("_") and name not in ("wait", "paginate")]
        self.assertEqual(names, [row["id"] for row in ROWS])
        self.assertEqual(HELPERS & set(names), set())
        for helper in HELPERS:
            self.assertTrue(hasattr(GptVideo, helper), helper)

    def test_take_a_dict_first_the_bytes_of_a_binary_operation_and_the_key_only_where_the_api_reads_it(self) -> None:
        for row in ROWS:
            parameters = list(inspect.signature(getattr(generated.GptVideoOperations, row["id"])).parameters.values())
            self.assertEqual((parameters[0].name, parameters[1].name, parameters[1].kind), ("self", "params", inspect.Parameter.POSITIONAL_ONLY), row["id"])
            self.assertEqual(parameters[2].name == "body", row["binary"] is not None, row["id"])
            keywords = [p.name for p in parameters if p.kind is inspect.Parameter.KEYWORD_ONLY]
            self.assertEqual("idempotency_key" in keywords, row["idempotencyKey"] != "none", row["id"])
            self.assertEqual(keywords[-4:], OPTIONS, row["id"])
            for p in parameters:
                if p.kind is inspect.Parameter.KEYWORD_ONLY and p.name not in OPTIONS and p.name != "idempotency_key":
                    self.assertIs(p.default, UNSET, f"{row['id']}.{p.name}")

    def test_send_their_own_operation_with_the_dict_the_keywords_the_options_and_the_bytes_in_their_place(self) -> None:
        ops = Recording()
        for row in ROWS:
            method = getattr(ops, row["id"])
            keywords = [p.name for p in inspect.signature(method).parameters.values() if p.kind is inspect.Parameter.KEYWORD_ONLY and p.name not in OPTIONS and p.name != "idempotency_key"]
            body = b"\x01\x02" if row["binary"] is not None else None
            extra = {"body": body} if body is not None else {}
            self.assertEqual(method({"marker": row["id"]}, **extra), {"answered": row["id"]})
            operation, params, fields, options, sent_body = ops.sent.pop()
            self.assertEqual((operation, params, sent_body), (row["id"], {"marker": row["id"]}, body))
            self.assertEqual(fields, {k: UNSET for k in keywords})
            self.assertEqual(options, {**({"idempotency_key": None} if row["idempotencyKey"] != "none" else {}), **{o: None for o in OPTIONS}})
            values = {k: f"{k}-value" for k in keywords}
            key = {"idempotency_key": "order-1"} if row["idempotencyKey"] != "none" else {}
            method(**values, **key, timeout=3.0, **extra)
            operation, params, fields, options, _ = ops.sent.pop()
            self.assertEqual((operation, params, fields), (row["id"], None, values))
            self.assertEqual(options.get("idempotency_key"), key.get("idempotency_key"))
            self.assertEqual(options["timeout"], 3.0)

    def test_have_docstrings_that_point_to_the_reference(self) -> None:
        for row in ROWS:
            doc = inspect.getdoc(getattr(generated.GptVideoOperations, row["id"])) or ""
            self.assertIn("Cost: ", doc, row["id"])
            self.assertRegex(doc, r"See https://www\.gpt-video\.com/developers/api/[a-z0-9-]+$", row["id"])
