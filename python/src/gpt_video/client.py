"""GptVideo, the client: one method for each operation of the API (generated, in _generated.py) and the helpers
written by hand on top of them: wait, the four wait_for forms, paginate, upload_file, download. Every call goes
through one Transport, which holds the API key in a Secret."""

from typing import Any, Callable, Dict, Iterator, Mapping, NoReturn, Optional, Set, Union

from ._generated import API_ERRORS, OPERATIONS, AssistantTurn, CompleteUploadOutput, Export, GptVideoOperations, Job, ToolRun
from ._http import Cancel, UrllibWire, Wire
from ._redact import REDACTED
from ._transport import Clock, OperationIndex, ResponseEvent, RetryEvent, Transport, invalid, resolve_settings
from .downloads import DownloadContext, download
from .pagination import merged_input, paginate
from .uploads import UPLOAD_CONCURRENCY, UploadContext, UploadProgress, upload_file
from .waiting import WAITS_PER_CLIENT, WaitContext, WaitSlots, wait_for_handle, wait_on

OPERATION_INDEX = OperationIndex(OPERATIONS)
"""The operation table of this version, indexed once when the package loads."""

RETRYABLE_CODES: Set[str] = {code for code, error in API_ERRORS.items() if error["retryable"]}
"""The API's retryable error codes, from the generated error table."""


class GptVideo(GptVideoOperations):
    """A client of the GPT-Video API.

    client = GptVideo()  # reads GPT_VIDEO_API_KEY
    upload = client.upload_file("talk.mp4")

    A call that spends sends an Idempotency-Key, made once for the call and sent again on every retry, so a retry
    never pays twice. When a call that spends ends without a clear answer, its error says so in may_have_spent and
    carries the key in idempotency_key: call again with that key to get the answer without paying twice.

    Every argument is checked here: a mistake raises GptVideoError with INVALID_ARGUMENT before anything is sent.
    api_key defaults to the GPT_VIDEO_API_KEY environment variable. base_url is the base URL of the documentation,
    with or without its final /v1, https://api.gpt-video.com/v1 by default. max_retries (2) counts the failed
    attempts sent again; timeout (60 seconds) is the time of one attempt and deadline (180 seconds) the time of a
    whole call, its pauses included. on_response is told of every answer and on_retry of every pause; what they
    raise is ignored. user_agent_suffix is added after gpt-video-python/<version> in the User-Agent.
    """

    __slots__ = ("_transport", "_wait_context", "_upload_context", "_download_context")

    def __init__(
        self,
        *,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        max_retries: Optional[int] = None,
        timeout: Optional[float] = None,
        deadline: Optional[float] = None,
        on_response: Optional[Callable[[ResponseEvent], Any]] = None,
        on_retry: Optional[Callable[[RetryEvent], Any]] = None,
        user_agent_suffix: Optional[str] = None,
    ) -> None:
        self._setup(
            dict(
                api_key=api_key,
                base_url=base_url,
                max_retries=max_retries,
                timeout=timeout,
                deadline=deadline,
                on_response=on_response,
                on_retry=on_retry,
                user_agent_suffix=user_agent_suffix,
            ),
            None,
            None,
        )

    @classmethod
    def _with_wire(cls, wire: Wire, clock: Optional[Clock] = None, **options: Any) -> "GptVideo":
        """A client that sends with the given wire and reads the given clock: how the tests drive the engine."""
        client = cls.__new__(cls)
        client._setup(options, wire, clock)
        return client

    def _setup(self, options: Dict[str, Any], wire: Optional[Wire], clock: Optional[Clock]) -> None:
        settings = resolve_settings(**options)

        def wire_for(use_proxies: bool) -> Wire:
            return wire if wire is not None else UrllibWire(use_proxies=use_proxies)

        transport = Transport(settings, RETRYABLE_CODES, wire=wire_for(settings.origin.use_proxies), clock=clock)
        self._transport = transport
        self._wait_context = WaitContext(transport=transport, index=OPERATION_INDEX, slots=WaitSlots(WAITS_PER_CLIENT))
        self._upload_context = UploadContext(transport=transport, index=OPERATION_INDEX)
        self._download_context = DownloadContext(transport=transport, wire_for=wire_for)

    @property
    def base_url(self) -> str:
        """The base URL the client calls, with /v1, as the documentation writes it."""
        return self._transport.base_url

    # ------------------------------------------------------------------- what the generated methods call

    def _send_operation(self, operation: str, params: Optional[Mapping[str, Any]], fields: Mapping[str, Any], options: Mapping[str, Any], body: Any = None) -> Any:
        spec = OPERATION_INDEX.by_id(operation)
        if spec is None:
            raise invalid(f"This version of the SDK has no operation {operation}.")
        return self._transport.send(spec, merged_input(spec, params, fields), options, body)

    def _wait(self, result: Any, options: Mapping[str, Any]) -> Any:
        return wait_on(self._wait_context, result, options)

    def _paginate(self, operation: str, params: Optional[Mapping[str, Any]], fields: Mapping[str, Any], options: Mapping[str, Any]) -> Iterator[Any]:
        return paginate(self._transport, OPERATION_INDEX, operation, params, fields, options)

    # ---------------------------------------------------------------------------------- the long waits

    def wait_for_job(
        self,
        job: Union[str, Mapping[str, Any]],
        *,
        timeout: Optional[float] = None,
        on_progress: Optional[Callable[[Job], object]] = None,
        throw_on_failure: bool = True,
        cancel: Optional[Cancel] = None,
    ) -> Job:
        """Waits for a job until it is done, failed or cancelled. Takes the job id, the job, or the answer that
        carries it. The options are those of wait()."""
        options = {"timeout": timeout, "on_progress": on_progress, "throw_on_failure": throw_on_failure, "cancel": cancel}
        result: Job = wait_for_handle(self._wait_context, "job", job, options, "wait_for_job")
        return result

    def wait_for_export(
        self,
        exported: Union[str, Mapping[str, Any]],
        *,
        timeout: Optional[float] = None,
        on_progress: Optional[Callable[[Export], object]] = None,
        throw_on_failure: bool = True,
        cancel: Optional[Cancel] = None,
    ) -> Export:
        """Waits for an export until it is done, failed or cancelled; the export it returns has its downloadUrl.
        Takes the export id, the export, or the answer that carries it. The options are those of wait()."""
        options = {"timeout": timeout, "on_progress": on_progress, "throw_on_failure": throw_on_failure, "cancel": cancel}
        result: Export = wait_for_handle(self._wait_context, "export", exported, options, "wait_for_export")
        return result

    def wait_for_tool_run(
        self,
        tool_run: Union[str, Mapping[str, Any]],
        *,
        timeout: Optional[float] = None,
        on_progress: Optional[Callable[[ToolRun], object]] = None,
        throw_on_failure: bool = True,
        cancel: Optional[Cancel] = None,
    ) -> ToolRun:
        """Waits for a tool run until it is done or failed. Takes the run id, the run, or the answer that carries
        it. The options are those of wait()."""
        options = {"timeout": timeout, "on_progress": on_progress, "throw_on_failure": throw_on_failure, "cancel": cancel}
        result: ToolRun = wait_for_handle(self._wait_context, "toolRun", tool_run, options, "wait_for_tool_run")
        return result

    def wait_for_assistant_turn(
        self,
        turn: Union[str, Mapping[str, Any]],
        *,
        timeout: Optional[float] = None,
        on_progress: Optional[Callable[[AssistantTurn], object]] = None,
        throw_on_failure: bool = True,
        cancel: Optional[Cancel] = None,
    ) -> AssistantTurn:
        """Waits for an Editor Assistant turn until it is done, failed or cancelled. Takes the turn id, the turn,
        or the answer that carries it. The options are those of wait()."""
        options = {"timeout": timeout, "on_progress": on_progress, "throw_on_failure": throw_on_failure, "cancel": cancel}
        result: AssistantTurn = wait_for_handle(self._wait_context, "turn", turn, options, "wait_for_assistant_turn")
        return result

    # ------------------------------------------------------------------------------- files in and out

    def upload_file(
        self,
        source: Any,
        *,
        filename: Optional[str] = None,
        content_type: Optional[str] = None,
        size_bytes: Optional[int] = None,
        title: Optional[str] = None,
        concurrency: int = UPLOAD_CONCURRENCY,
        on_progress: Optional[Callable[[UploadProgress], Any]] = None,
        cancel: Optional[Cancel] = None,
    ) -> CompleteUploadOutput:
        """Uploads a video in parts and returns the answer of complete_upload, {"asset": ...}: pass the asset id to
        create_project as sourceAssetId.

        source is the path of a file, bytes, or a file opened in binary mode; a file that cannot seek needs
        size_bytes. filename defaults to the name of the file, and the API reads the type of the video from it
        unless content_type says it. concurrency parts (4, at most 16) go out at once, each one read just before it
        is sent, so the file is never held in memory whole. on_progress is told after every part the API received.
        If the upload fails, the SDK cancels it.
        """
        result: CompleteUploadOutput = upload_file(
            self._upload_context,
            source,
            filename=filename,
            content_type=content_type,
            size_bytes=size_bytes,
            title=title,
            concurrency=concurrency,
            on_progress=on_progress,
            cancel=cancel,
        )
        return result

    def download(
        self,
        url: str,
        destination: Any,
        *,
        timeout: Optional[float] = None,
        deadline: Optional[float] = None,
        max_retries: Optional[int] = None,
        cancel: Optional[Cancel] = None,
    ) -> int:
        """Downloads the file behind a signed link, such as the downloadUrl of an export, into destination: the path
        of a file to write, or a file opened in binary mode. Returns how many bytes were written.

        The request never carries the API key: the link is its own credential. Failures before the body starts
        are retried within deadline; once it starts, each read of the body waits at most timeout. When the download
        fails, a path is left as it was, and a file object keeps the bytes it got.
        """
        return download(self._download_context, url, destination, timeout=timeout, deadline=deadline, max_retries=max_retries, cancel=cancel)

    # --------------------------------------------------------------------------------------- printing

    def __repr__(self) -> str:
        return f"GptVideo(base_url={self.base_url!r}, api_key={REDACTED!r})"

    def __reduce__(self) -> NoReturn:
        raise TypeError("A GptVideo client cannot be pickled or copied: it holds the API key. Create a client where it is needed.")
