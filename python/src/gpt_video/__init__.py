"""The GPT-Video SDK for Python: one method for each operation of the GPT-Video API, and the helpers around them.

    from gpt_video import GptVideo

    client = GptVideo()  # reads GPT_VIDEO_API_KEY
    me = client.get_me()

A call that spends sends an Idempotency-Key, made once for the call and sent again on every retry, so a retry never
pays twice. Webhook verification is in gpt_video.webhooks, and the types of the API are in gpt_video.types.
"""

from ._retry import RateLimit
from ._transport import ResponseEvent, RetryEvent
from ._version import VERSION
from .client import GptVideo
from .errors import GptVideoApiError, GptVideoError, GptVideoJobError, GptVideoNetworkError
from .uploads import UploadProgress

__version__ = VERSION

__all__ = [
    "GptVideo",
    "GptVideoApiError",
    "GptVideoError",
    "GptVideoJobError",
    "GptVideoNetworkError",
    "RateLimit",
    "ResponseEvent",
    "RetryEvent",
    "UploadProgress",
    "VERSION",
    "__version__",
]
