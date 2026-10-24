"""Every item of a list, page after page: for project in client.paginate("list_projects").

Each page is one call with its own retries; the next page is asked for only when the items of this one are used up.
The loop follows nextCursor while hasMore is true, and stops with BAD_RESPONSE on a cursor it has already seen,
which would never end. A CONFLICT of list_clips (the list changed under the cursor) reaches the caller as it is:
reading on would skip or repeat clips.
"""

from typing import Any, Dict, Iterator, Mapping, Optional, Set

from ._table import UNSET, OperationSpec
from ._transport import OperationIndex, Transport, invalid
from .errors import MESSAGES, GptVideoNetworkError, format_error_message

PAGINATE_OPTIONS = ("timeout", "deadline", "max_retries", "cancel")
"""The options of paginate, passed to the call of every page."""


def paginate(transport: Transport, index: OperationIndex, operation: Any, params: Optional[Mapping[str, Any]], fields: Mapping[str, Any], options: Mapping[str, Any]) -> Iterator[Any]:
    """The items of a list. Mistakes in the arguments raise here, at the call, not at the first item."""
    spec = index.by_id(operation) if isinstance(operation, str) else None
    if spec is None or not spec["paginated"]:
        name = operation if isinstance(operation, str) else "This"
        raise invalid(f"{name} is not a list. The lists are: {', '.join(index.list_ids)}.")
    input = merged_input(spec, params, fields)
    o = {name: value for name, value in options.items() if value is not None}
    for name in o:
        if name not in PAGINATE_OPTIONS:
            raise invalid(f"paginate has no option {name}. Its options are: {', '.join(PAGINATE_OPTIONS)}.", spec["id"])
    # the values are checked now, as every page will send them, so a mistake is not found at the first page
    transport.call_options(spec, o)
    return _items(transport, spec, input, o)


def merged_input(spec: OperationSpec, params: Optional[Mapping[str, Any]], fields: Mapping[str, Any]) -> Dict[str, Any]:
    """The input of a call given as one dict or as keyword arguments, not both."""
    given = {name: value for name, value in fields.items() if value is not UNSET}
    if params is not None:
        if not isinstance(params, Mapping):
            raise invalid(f"The input of {spec['id']} must be a dict.", spec["id"])
        if given:
            raise invalid(f"Pass the fields of {spec['id']} as one dict or as keyword arguments, not both.", spec["id"])
        return dict(params)
    return given


def _items(transport: Transport, spec: OperationSpec, input: Dict[str, Any], options: Dict[str, Any]) -> Iterator[Any]:
    seen: Set[str] = set()
    cursor = input.get("cursor")
    if isinstance(cursor, str):
        seen.add(cursor)
    page = input
    while True:
        answer = transport.send(spec, page, options)
        if not isinstance(answer, dict) or not isinstance(answer.get("data"), list) or not isinstance(answer.get("hasMore"), bool):
            raise _bad_page(spec, MESSAGES["not_a_page"])
        yield from answer["data"]
        if not answer["hasMore"]:
            return
        following = answer.get("nextCursor")
        if not isinstance(following, str) or not following:
            raise _bad_page(spec, MESSAGES["missing_cursor"])
        if following in seen:
            raise _bad_page(spec, MESSAGES["repeated_cursor"])
        seen.add(following)
        page = {**input, "cursor": following}


def _bad_page(spec: OperationSpec, message: str) -> GptVideoNetworkError:
    return GptVideoNetworkError(format_error_message("BAD_RESPONSE", message), code="BAD_RESPONSE", operation=spec["id"])
