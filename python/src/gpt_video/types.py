"""The types of the GPT-Video API, for annotations: the input and the answer of each operation (AnalyzeProjectInput,
AnalyzeProjectOutput), the objects the API answers (Project, Job, Clip...), the webhook events (WebhookEvent) and
the answers wait() takes (AsyncResult). They are TypedDicts: at run time every value is a plain dict.

    from gpt_video.types import Project
"""

from ._generated import *  # noqa: F401,F403
from ._generated import __all__ as __all__
