"""Every item of a list, page after page."""

import threading
import unittest
import urllib.parse
from typing import Any, Dict, List

from gpt_video import GptVideo, GptVideoApiError, GptVideoNetworkError
from gpt_video.errors import MESSAGES, GptVideoError

from .support import FakeClock, FakeWire, api_key

KEY = api_key()


def page(items: List[Any], cursor: Any = None, more: Any = None) -> Dict[str, Any]:
    return {"status": 200, "json": {"data": items, "hasMore": cursor is not None if more is None else more, "nextCursor": cursor}}


def client(script: List[Dict[str, Any]], **options: Any) -> "tuple[GptVideo, FakeWire]":
    clock = FakeClock()
    wire = FakeWire(clock, script)
    return GptVideo._with_wire(wire, clock, api_key=KEY, **options), wire


def query(url: str) -> Dict[str, str]:
    return dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query, keep_blank_values=True))


class Paginate(unittest.TestCase):
    def test_yields_every_item_page_after_page_following_next_cursor_while_has_more(self) -> None:
        gv, wire = client([page([1, 2], "c1"), page([3], "c2"), page([4])])
        self.assertEqual(list(gv.paginate("list_projects")), [1, 2, 3, 4])
        self.assertEqual([query(c.url) for c in wire.calls], [{}, {"cursor": "c1"}, {"cursor": "c2"}])

    def test_starts_from_the_cursor_of_the_input_and_keeps_its_other_fields_on_every_page(self) -> None:
        gv, wire = client([page(["a"], "c2"), page(["b"])])
        self.assertEqual(list(gv.paginate("list_clips", projectId="prj_1", status="accepted", cursor="c1", limit=50)), ["a", "b"])
        self.assertEqual([urllib.parse.urlsplit(c.url).path for c in wire.calls], ["/v1/projects/prj_1/clips"] * 2)
        self.assertEqual([query(c.url) for c in wire.calls], [{"status": "accepted", "cursor": "c1", "limit": "50"}, {"status": "accepted", "cursor": "c2", "limit": "50"}])
        gv, wire = client([page(["a"])])
        self.assertEqual(list(gv.paginate("list_clips", {"projectId": "prj_1", "limit": 5})), ["a"])
        self.assertEqual(query(wire.calls[0].url), {"limit": "5"})

    def test_asks_for_a_page_only_when_the_items_of_the_one_before_are_used_up(self) -> None:
        gv, wire = client([page([1, 2], "c1"), page([3])])
        items = gv.paginate("list_projects")
        self.assertEqual(len(wire.calls), 0, "nothing is sent before the first item is asked for")
        self.assertEqual(next(items), 1)
        self.assertEqual(next(items), 2)
        self.assertEqual(len(wire.calls), 1)
        self.assertEqual(next(items), 3)
        self.assertEqual(len(wire.calls), 2)

    def test_stops_with_bad_response_on_a_cursor_it_has_seen_the_one_before_or_any_earlier(self) -> None:
        for script in ([page([1], "c1"), page([2], "c1")], [page([1], "c1"), page([2], "c2"), page([3], "c1")]):
            gv, _ = client(script)
            with self.assertRaises(GptVideoNetworkError) as caught:
                list(gv.paginate("list_projects"))
            self.assertEqual(caught.exception.code, "BAD_RESPONSE")
            self.assertIn(MESSAGES["repeated_cursor"], caught.exception.message)
        gv, _ = client([page([1], "start")])
        with self.assertRaises(GptVideoNetworkError):
            list(gv.paginate("list_projects", cursor="start"))

    def test_stops_with_bad_response_when_there_are_more_items_and_no_cursor_or_the_answer_is_not_a_page(self) -> None:
        cases = ((page([1], None, True), MESSAGES["missing_cursor"]), (page([1], "", True), MESSAGES["missing_cursor"]), ({"status": 200, "json": {"items": []}}, MESSAGES["not_a_page"]), ({"status": 200, "json": {"data": [], "hasMore": "no"}}, MESSAGES["not_a_page"]))
        for entry, message in cases:
            gv, _ = client([entry])
            with self.assertRaises(GptVideoNetworkError, msg=message) as caught:
                list(gv.paginate("list_projects"))
            self.assertIn(message, caught.exception.message)
            self.assertEqual(caught.exception.operation, "list_projects")

    def test_hands_a_conflict_of_list_clips_to_the_caller_as_it_is(self) -> None:
        conflict = {"status": 409, "json": {"error": {"code": "CONFLICT", "message": "The clips changed since the cursor was made."}}}
        gv, wire = client([page([1], "c1"), conflict])
        items = gv.paginate("list_clips", projectId="prj_1")
        self.assertEqual(next(items), 1)
        with self.assertRaises(GptVideoApiError) as caught:
            next(items)
        self.assertEqual(caught.exception.code, "CONFLICT")
        self.assertEqual(len(wire.calls), 2)

    def test_says_which_operations_are_lists_at_the_call_and_not_at_the_first_item(self) -> None:
        gv, wire = client([])
        for operation in ("get_project", "listProjects", "nothing", 3):
            with self.assertRaises(GptVideoError, msg=repr(operation)) as caught:
                gv.paginate(operation)  # type: ignore[call-overload]
            self.assertIn("is not a list. The lists are: list_ledger_entries, list_assets, list_projects", caught.exception.message)
        with self.assertRaises(GptVideoError) as caught:
            gv.paginate("list_clips", {"projectId": "prj_1"}, limit=5)
        self.assertIn("as one dict or as keyword arguments, not both", caught.exception.message)
        self.assertEqual(wire.calls, [])

    def test_checks_the_value_of_every_option_at_the_call_too(self) -> None:
        gv, wire = client([])
        for options in ({"timeout": 0}, {"deadline": -1}, {"max_retries": -1}, {"cancel": "stop"}):
            with self.assertRaises(GptVideoError, msg=repr(options)):
                gv.paginate("list_projects", **options)  # type: ignore[call-overload]
        self.assertEqual(wire.calls, [])

    def test_sends_every_page_with_the_options_it_was_given(self) -> None:
        clock = FakeClock()
        wire = FakeWire(clock, [{"network": "connection_failed"}, page([1], "c1"), {"network": "connection_failed"}, {"network": "connection_failed"}])
        gv = GptVideo._with_wire(wire, clock, api_key=KEY)
        items = gv.paginate("list_projects", max_retries=1)
        self.assertEqual(next(items), 1)
        with self.assertRaises(GptVideoNetworkError) as caught:
            next(items)
        self.assertEqual(caught.exception.code, "CONNECTION_FAILED")
        self.assertEqual(len(wire.calls), 4, "one retry for each page, as max_retries says")
        cancel = threading.Event()
        cancel.set()
        with self.assertRaises(GptVideoNetworkError) as caught:
            next(gv.paginate("list_projects", cancel=cancel))
        self.assertEqual(caught.exception.code, "ABORTED")
