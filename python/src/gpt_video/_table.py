"""The shape of the operation table: one row per REST operation of the GPT-Video API.

The rows are generated from the API catalogue into ``_generated.py``, which exports them as
``OPERATIONS: Tuple[OperationSpec, ...]`` next to ``API_CONTRACT: ApiContract``. The engine (requests,
retries, waits, pages, uploads) reads only these fields. The JavaScript SDK reads the same fields, with the same
names, from the ``table.mjs`` of its sources: the names are the wire's (camelCase), so a row reads the
same in both languages. The functional ``TypedDict`` form is used because ``async`` is a Python keyword.

Every rule the engine follows comes from a field here, never from the name of an operation.
"""

from typing import Any, Literal, Mapping, Optional, Tuple, TypedDict

HttpMethod = Literal["GET", "POST", "PUT", "PATCH", "DELETE"]

Effect = Literal["read", "write", "spend"]
"""What an operation does: reads, writes, or spends credits or a daily allowance."""

IdempotencyKeyPolicy = Literal["required", "auto", "none"]
"""Whether the call sends an Idempotency-Key.

``required``: a spend; the API refuses it without one, and the SDK always sends one. ``auto``: a POST
that writes; the SDK sends one so the call can be retried. ``none``: the API does not read the header,
and the SDK does not send it.
"""

AsyncHandle = Literal["job", "export", "toolRun", "turn"]
"""The four kinds of work that finish later, by the field of the response that carries them."""

AsyncSpec = TypedDict("AsyncSpec", {"handle": AsyncHandle, "waitWith": str})
"""An operation that starts work: the response field to follow (``{"job": ...}``) and the id of the read
that follows it with ``?wait=``."""

BinarySpec = TypedDict("BinarySpec", {"contentType": str, "maxBytes": int})
"""A body of bytes instead of JSON (the part of an upload). Its other input fields go in the query."""

OperationSpec = TypedDict(
    "OperationSpec",
    {
        # the operation id, "analyze_project": the method name in Python
        "id": str,
        # the JavaScript method name, "analyzeProject"
        "name": str,
        "method": HttpMethod,
        # the catalogue path, starting with /v1/, with {camelCase} parameters
        "path": str,
        # the input fields that fill the path, in order of appearance
        "pathParams": Tuple[str, ...],
        # True when the input fields that are not in the path go in the query string; False when they are the JSON body
        "inQuery": bool,
        "binary": Optional[BinarySpec],
        "effect": Effect,
        "idempotencyKey": IdempotencyKeyPolicy,
        # True when sending the call twice cannot do the work twice: a GET, an operation the API makes
        # idempotent, or one that carries an Idempotency-Key
        "retrySafe": bool,
        "async": Optional[AsyncSpec],
        # True for a list that answers {data, hasMore, nextCursor} and reads cursor
        "paginated": bool,
        "successStatus": Literal[200, 201, 202],
    },
)

ApiContract = TypedDict("ApiContract", {"apiVersion": str, "fingerprint": str})
"""The version of the contract the table was generated from: info.version of the OpenAPI document and
the SHA-256 of the generator's model."""

Conventions = TypedDict(
    "Conventions",
    {
        "baseUrl": str,
        "apiKeyEnv": str,
        "headers": Mapping[str, str],
        "finalStatuses": Tuple[str, ...],
        "waitMaxSec": int,
        "switchedOffReason": str,
        "idempotencyRetentionHours": int,
        "idempotencyKeyMaxLength": int,
    },
)
"""What the engine reads besides the rows: the base URL, the names of the headers, the statuses that end
work, the longest ``?wait=``, the reason of an operation turned off, and the limits of the Idempotency-Key."""

ApiErrorSpec = TypedDict("ApiErrorSpec", {"status": int, "retryable": bool})
"""An error code of the API: its HTTP status, and whether the same request can be sent again after it."""


class _Unset:
    """The value of a keyword argument that was left out, so that None can still be sent as null."""

    __slots__ = ()

    def __repr__(self) -> str:
        return "UNSET"

    def __bool__(self) -> bool:
        return False

    def __reduce__(self) -> str:
        return "UNSET"


UNSET: Any = _Unset()
"""The default of every field of a generated method: a field left at UNSET is not sent, and None is sent as null."""
