"""The errors of the GPT-Video SDK: the classes, the codes the SDK adds to the API's own, and the fixed sentences
an error can carry.

The sentences and the shape of the message are part of the public contract: people search for them, and the
JavaScript SDK says the same words, with its own names for the options (apiKey there, api_key here).

No error ever holds the API key, in any field. An error never carries the exception of the transport that caused
it, as its cause or as its context, because that exception can hold the request and its headers.
"""

import math
from types import MappingProxyType
from typing import Any, Dict, Mapping, Optional, Tuple

NETWORK_ERROR_CODES: Tuple[str, ...] = ("CONNECTION_FAILED", "TIMEOUT", "ABORTED", "BAD_RESPONSE")
"""The codes of a request that never got a readable answer from the API."""

JOB_ERROR_CODES: Tuple[str, ...] = ("JOB_FAILED", "JOB_CANCELLED", "WAIT_TIMEOUT")
"""The codes of a wait that ended without the result the caller asked for."""

INVALID_ARGUMENT = "INVALID_ARGUMENT"
"""The code of a mistake found before anything is sent: a missing or malformed key, a bad option."""

WEBHOOK_VERIFICATION_FAILED = "WEBHOOK_VERIFICATION_FAILED"
"""The code of every webhook that fails verification; reason says why."""

WEBHOOK_FAILURE_REASONS: Tuple[str, ...] = (
    "missing_headers",
    "bad_timestamp",
    "timestamp_outside_tolerance",
    "no_matching_signature",
    "bad_secret",
    "body_not_raw",
)
"""Why a webhook was refused."""

CONSOLE_URL = "https://www.gpt-video.com/app/developers"
"""Where API keys are created."""

MESSAGES: Mapping[str, str] = MappingProxyType(
    {
        # no api_key argument and no GPT_VIDEO_API_KEY in the environment
        "missing_api_key": f"Set GPT_VIDEO_API_KEY or pass api_key. Create a key at {CONSOLE_URL}.",
        # a key that does not start with gvk_ (the key itself is never repeated)
        "bad_api_key_prefix": f"This is not a GPT-Video API key: API keys start with gvk_. Create one at {CONSOLE_URL}.",
        # a webhook secret that does not start with whsec_
        "bad_webhook_secret": "The webhook signing secret must start with whsec_. Copy it from the webhook in the console.",
        # an API key passed where the webhook secret goes
        "api_key_as_webhook_secret": "This is an API key (gvk_), not a webhook signing secret. The signing secret starts with whsec_.",
        # a body that was already parsed into an object before verification
        "webhook_body_not_raw": "Verify the raw request body (a string or bytes), exactly as it arrived, before parsing it as JSON.",
        # an Idempotency-Key from the caller that the API would refuse
        "bad_idempotency_key": "idempotency_key must be 1 to 255 visible ASCII characters, with no spaces.",
        # a response whose body is not JSON: the status is said, the body never is
        "not_json": "The response is not JSON.",
        # a 3xx: following it would send the API key to another address
        "redirect": "The API answered with a redirect, which the SDK does not follow because it would send your API key to another address. Check base_url.",
        # appended to the message of a spend whose outcome is unknown
        "may_have_spent": "The request may have been charged. Call again with the same idempotency_key to get its answer without paying twice.",
        # an http:// base_url that is not this machine
        "insecure_base_url": "base_url must start with https://. http:// is accepted only for an address on this machine, such as localhost.",
        # an ssl.SSLCertVerificationError
        "python_tls": "Python cannot verify TLS certificates on this machine; on macOS run Install Certificates.command.",
        # a key with a space, a line break or another byte that cannot travel in a header (the key is never repeated)
        "bad_api_key_characters": f"The API key has a space, a line break or another character that cannot be sent in a header. Copy it again from {CONSOLE_URL}.",
        # CONNECTION_FAILED
        "connection_failed": "The connection to the API failed.",
        # ABORTED: the caller's cancel event
        "aborted": "The call was aborted.",
        # BAD_RESPONSE: JSON that is not the API's error body
        "not_api_error": "The response is not an error from the GPT-Video API.",
        # an API error body whose message is missing
        "no_server_message": "The API sent no message.",
        # BAD_RESPONSE from paginate: a cursor seen before
        "repeated_cursor": "The API sent a cursor it had sent before, so the list would never end.",
        # BAD_RESPONSE from paginate: hasMore without a cursor
        "missing_cursor": "The API said there are more items and sent no nextCursor.",
        # BAD_RESPONSE from paginate: not {data, hasMore, nextCursor}
        "not_a_page": "The answer is not a page of a list.",
        # appended to a create_upload refused because uploads are turned off
        "upload_elsewhere": "Upload the video in the GPT-Video app instead: it then shows in list_assets, and its id is the sourceAssetId of create_project.",
        # a download that answered with an error status
        "download_failed": "The download failed.",
        # a download refused by the server of the file: the link expired or is wrong
        "download_refused": "The download link was refused. A link expires after a while: read the export again for a new one.",
        # a download redirected to an address that is not https
        "download_insecure": "The download was redirected to an address that is not https, so it was stopped.",
    }
)
"""The fixed sentences. The JavaScript SDK has the same ones, with its own names for the options."""


def duration_text(seconds: float) -> str:
    """A duration as the messages say it: whole minutes from two minutes up, seconds below or in between."""
    ms = int(math.floor(seconds * 1000 + 0.5))
    if ms >= 120_000 and ms % 60_000 == 0:
        return f"{ms // 60_000} minutes"
    tenths = int(math.floor(ms / 100 + 0.5))
    text = str(tenths // 10) if tenths % 10 == 0 else f"{tenths // 10}.{tenths % 10}"
    return f"{text} {'second' if tenths == 10 else 'seconds'}"


class _Texts:
    """The sentences that carry a value. The JavaScript SDK says the same words."""

    @staticmethod
    def timeout(seconds: float) -> str:
        """TIMEOUT: the attempt ran out of time."""
        return f"No answer within {duration_text(seconds)}."

    @staticmethod
    def connection_failed(code: str) -> str:
        """CONNECTION_FAILED with the name of the failure (ECONNREFUSED, ConnectionResetError...)."""
        return f"The connection to the API failed ({code})."

    @staticmethod
    def job_failed(id: str) -> str:
        """JOB_FAILED."""
        return f"{id} failed."

    @staticmethod
    def job_cancelled(id: str) -> str:
        """JOB_CANCELLED."""
        return f"{id} was cancelled."

    @staticmethod
    def wait_timeout(id: str, status: Optional[str], seconds: float) -> str:
        """WAIT_TIMEOUT; status is None when no read came back before the end."""
        last = f" Its last status is {status}." if status else ""
        return f"{id} did not finish within {duration_text(seconds)}.{last}"

    @staticmethod
    def missing_handle(field: str) -> str:
        """BAD_RESPONSE from a wait: the read did not carry the object it follows."""
        return f"The answer has no {field} object."

    @staticmethod
    def parts_mismatch(size_bytes: int, part_size_bytes: Any, part_count: Any) -> str:
        """BAD_RESPONSE from upload_file: the parts the API asks for do not cover the file."""
        return f"The API split a file of {size_bytes} bytes into {part_count} parts of {part_size_bytes} bytes, which does not cover it."


TEXTS = _Texts()

SERVER_TEXT_MAX = 1000
"""The longest server-provided text (message or hint) an error repeats."""


def _clip(text: str) -> str:
    return f"{text[: SERVER_TEXT_MAX - 1]}…" if len(text) > SERVER_TEXT_MAX else text


def format_error_message(
    code: str,
    message: str,
    *,
    status: Optional[int] = None,
    hint: Optional[str] = None,
    request_id: Optional[str] = None,
    may_have_spent: bool = False,
    note: Optional[str] = None,
) -> str:
    """The one shape of a message: ``<CODE> (<status>): <message> Hint: <hint> [request <requestId>]``, then the
    sentence about a possible charge when the outcome of a spend is unknown, then ``note``, a sentence of this SDK
    about what the caller can do instead. A part with no value is left out, with its label. The server's texts are
    cut at SERVER_TEXT_MAX; the SDK's own sentences never are."""
    text = f"{code}{f' ({status})' if isinstance(status, int) else ''}: {_clip(message)}"
    if hint:
        text += f" Hint: {_clip(hint)}"
    if request_id:
        text += f" [request {_clip(request_id)}]"
    if may_have_spent:
        text += f" {MESSAGES['may_have_spent']}"
    if note:
        text += f" {note}"
    return text


def _rebuild(cls: type, message: str, state: Dict[str, Any]) -> "GptVideoError":
    error = cls.__new__(cls)
    Exception.__init__(error, message)
    error.__dict__.update(state)
    return error


class GptVideoError(Exception):
    """The base of every error the SDK raises.

    code is the API's code, or one of the SDK's (NETWORK_ERROR_CODES, JOB_ERROR_CODES, INVALID_ARGUMENT,
    WEBHOOK_VERIFICATION_FAILED). retryable says whether sending the same call again, with the same
    idempotency_key, can succeed. idempotency_key is the Idempotency-Key of the call, to send again after a crash.
    may_have_spent is True when a call that spends ended without a clear answer.
    """

    code: str
    retryable: bool
    operation: Optional[str]
    idempotency_key: Optional[str]
    may_have_spent: bool

    def __init__(
        self,
        message: str,
        *,
        code: str,
        retryable: bool = False,
        operation: Optional[str] = None,
        idempotency_key: Optional[str] = None,
        may_have_spent: bool = False,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        self.operation = operation
        self.idempotency_key = idempotency_key
        self.may_have_spent = may_have_spent

    @property
    def message(self) -> str:
        """The message of the error, in the shape of format_error_message."""
        return str(self.args[0]) if self.args else ""

    def __reduce__(self) -> Tuple[Any, ...]:
        # pickled with its fields, so an error that crosses processes keeps them; a field never holds the key
        return (_rebuild, (type(self), self.message, dict(self.__dict__)))


class GptVideoApiError(GptVideoError):
    """An error the API answered with its JSON error body: status, request_id, hint, details, retry_after_sec."""

    status: int
    request_id: Optional[str]
    hint: Optional[str]
    details: Any
    retry_after_sec: Optional[int]

    def __init__(
        self,
        message: str,
        *,
        code: str,
        status: int,
        request_id: Optional[str] = None,
        hint: Optional[str] = None,
        details: Any = None,
        retry_after_sec: Optional[int] = None,
        retryable: bool = False,
        operation: Optional[str] = None,
        idempotency_key: Optional[str] = None,
        may_have_spent: bool = False,
    ) -> None:
        super().__init__(message, code=code, retryable=retryable, operation=operation, idempotency_key=idempotency_key, may_have_spent=may_have_spent)
        self.status = status
        self.request_id = request_id
        self.hint = hint
        self.details = details
        self.retry_after_sec = retry_after_sec


class GptVideoNetworkError(GptVideoError):
    """A request with no readable answer: the connection failed, the attempt timed out, the caller aborted, or
    something that is not the API answered (BAD_RESPONSE, with the HTTP status when there was one)."""

    status: Optional[int]
    retry_after_sec: Optional[int]

    def __init__(
        self,
        message: str,
        *,
        code: str,
        status: Optional[int] = None,
        retry_after_sec: Optional[int] = None,
        retryable: bool = False,
        operation: Optional[str] = None,
        idempotency_key: Optional[str] = None,
        may_have_spent: bool = False,
    ) -> None:
        super().__init__(message, code=code, retryable=retryable, operation=operation, idempotency_key=idempotency_key, may_have_spent=may_have_spent)
        self.status = status
        self.retry_after_sec = retry_after_sec


class GptVideoJobError(GptVideoError):
    """A wait that ended without success: the work failed or was cancelled, or the wait ran out of time. handle is
    the last object read (the job, export, tool run or turn), error_message what the API said went wrong."""

    handle: Any
    error_message: Optional[str]

    def __init__(
        self,
        message: str,
        *,
        code: str,
        handle: Any,
        error_message: Optional[str] = None,
        retryable: bool = False,
        operation: Optional[str] = None,
        idempotency_key: Optional[str] = None,
        may_have_spent: bool = False,
    ) -> None:
        super().__init__(message, code=code, retryable=retryable, operation=operation, idempotency_key=idempotency_key, may_have_spent=may_have_spent)
        self.handle = handle
        self.error_message = error_message


class WebhookVerificationError(GptVideoError):
    """A webhook that failed verification, or a verification called the wrong way. reason says why, from
    WEBHOOK_FAILURE_REASONS."""

    reason: str

    def __init__(self, message: str, *, reason: str) -> None:
        super().__init__(message, code=WEBHOOK_VERIFICATION_FAILED)
        self.reason = reason
