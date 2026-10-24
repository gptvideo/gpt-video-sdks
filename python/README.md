# gpt-video

The official Python SDK for the GPT-Video API.

GPT-Video turns a long video into short vertical clips with captions and face framing. Your program uploads a video, GPT-Video finds the moments that work as clips, and your program exports the ones it keeps as MP4 files.

- One method for each of the 67 operations of the API, with the names of the [API reference](https://www.gpt-video.com/developers/api): `analyze_project`.
- Retries that never pay twice: a call that spends sends the same Idempotency-Key on every attempt.
- Helpers for the work that takes more than one request: `upload_file`, `wait`, `paginate`, `download`, and webhook verification.
- Python 3.10 or later, the standard library only, and typed (`py.typed`).

## Install

```sh
pip install gpt-video
```

The package is `gpt_video`.

## Your first clip

1. Create a GPT-Video account and confirm your email address.
2. Open the Developers page of the app, https://www.gpt-video.com/app/developers, and create an API key with the scopes `clips:read`, `clips:write` and `spend`. The key is shown once, so copy it then.
3. Put the key in the environment, where the SDK reads it, and run the quickstart on a video of yours:

```sh
export GPT_VIDEO_API_KEY=gvk_...
python quickstart.py talk.mp4
```

The program below is `examples/quickstart.py`. It checks the key, uploads the video, shows the price, analyzes the video, accepts the first clip, exports it and saves it as `clip.mp4`. Our test suite runs this file, unchanged, against a test server of the API.

```python
"""GPT-Video quickstart: from a video file to a vertical clip on your disk.

    pip install gpt-video
    export GPT_VIDEO_API_KEY=gvk_...
    python quickstart.py talk.mp4

Steps 1 to 4 use no credits. Step 5 spends credits: one per started minute of the video.
Step 7 uses one export of your daily allowance, and one API bonus credit while the bonus pays.
"""

import os
import sys

from gpt_video import GptVideo, GptVideoError


def spend_once(call):
    """A call that spends and ends without a clear answer (the network failed, or the time ran out) may have been
    charged. Calling again with the same idempotency_key returns the first answer and never pays twice."""
    try:
        return call(None)
    except GptVideoError as error:
        if not error.may_have_spent:
            raise
        print(f"No clear answer ({error.code}). Asking again with the same Idempotency-Key.")
        return call(error.idempotency_key)


def main(path):
    gv = GptVideo()  # reads GPT_VIDEO_API_KEY

    # 1. Check the key.
    me = gv.get_me()
    print(f"Key {me['key']['id']} works. Scopes: {', '.join(me['key']['scopes'])}. Plan: {me['account']['plan']}.")

    # 2. Upload the video. The SDK sends it in parts and reads one part at a time from the disk.
    asset = gv.upload_file(path, on_progress=lambda p: print(f"Uploaded {round(100 * p.uploaded_bytes / p.total_bytes)}%"))["asset"]
    print(f"Video {asset['id']} is ready.")

    # 3. Create an Auto Clip project. Auto Clip has no default settings: the analysis starts only when
    # missingSettings is empty, so choose every one of them.
    project = gv.create_project(
        sourceAssetId=asset["id"],
        title=os.path.basename(path),
        settings={
            "language": "auto",
            "clipCount": 3,
            "minDurationSec": 15,
            "maxDurationSec": 60,
            "objective": "viral",
            "captionStyle": "word-pop",
            "reframe": "face",
        },
    )["project"]
    if project["missingSettings"]:
        raise SystemExit(f"Settings still to choose: {', '.join(project['missingSettings'])}")

    # 4. Ask the price of the analysis.
    estimate = gv.estimate_analysis(projectId=project["id"])["estimate"]
    print(f"The analysis costs {estimate['creditsToCharge']} credits.")
    if not estimate["enough"]:
        raise SystemExit("The account cannot pay for it. See https://www.gpt-video.com/developers/pricing")

    # 5. Analyze the video, and wait until its clips are found.
    analysis = spend_once(lambda key: gv.analyze_project(projectId=project["id"], idempotency_key=key))
    print(f"Analysis started ({analysis['creditsCharged']} credits charged). Waiting for job {analysis['job']['id']}.")
    gv.wait(analysis)

    # 6. Read the clips in the order the analysis ranked them, and accept the first one. Accepting makes a
    # composition, whose framing follows the face of the speaker; it can be exported once its framing job is done.
    clips = list(gv.paginate("list_clips", projectId=project["id"], status="proposed"))
    for clip in clips:
        print(f"{clip['rank'] + 1}. {clip['title']} ({clip['startSec']}s to {clip['endSec']}s, score {clip['score']})")
    if not clips:
        raise SystemExit("The analysis found no clips in this video.")
    composition = gv.accept_clip(clipId=clips[0]["id"])["composition"]
    if composition["framing"]["jobId"]:
        gv.wait_for_job(composition["framing"]["jobId"])

    # 7. Export the composition to an MP4 file, wait for it, and download it. The download link is its own
    # credential: the SDK never sends your API key to it.
    exported = spend_once(lambda key: gv.create_export(compositionId=composition["id"], idempotency_key=key))
    done = gv.wait(exported)
    size = gv.download(done["downloadUrl"], "clip.mp4")
    print(f"Saved clip.mp4 ({size} bytes).")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python quickstart.py <video file>")
    main(sys.argv[1])
```

## Arguments

The fields of a call keep the names of the API, in camelCase: `projectId`, `sourceAssetId`. Pass them as keyword arguments, `gv.analyze_project(projectId="prj_...")`, or as one dict, `gv.analyze_project({"projectId": "prj_..."})`, but not both in the same call. The options of the SDK are keyword arguments in snake_case: `idempotency_key`, `timeout`, `deadline`, `max_retries`, `cancel`.

Every answer is the JSON body of the API as a dict, as the API sent it.

## What uses credits

- `get_me`, `upload_file`, `create_project`, `estimate_analysis`, `list_clips`, `accept_clip` and every other read use no credits. An upload counts toward the storage of the account.
- `analyze_project` charges one credit per started minute of the source video when the analysis starts. The credits are not returned if the analysis fails, and analyzing again is charged again.
- `create_export` uses one export of the daily allowance, which starts again at 00:00 UTC. While the API bonus pays, it also uses one bonus credit.

Every method links to its page of the API reference, which says what it costs. [API pricing](https://www.gpt-video.com/developers/pricing) has the API bonus, the plans and the daily limits.

## When a call fails

Every error the SDK raises is a `GptVideoError`, with these fields:

| Field | What it says |
|---|---|
| `code` | The code of the API, such as `NOT_READY`, or one of the SDK's: `CONNECTION_FAILED`, `TIMEOUT`, `ABORTED`, `BAD_RESPONSE`, `INVALID_ARGUMENT`, `JOB_FAILED`, `JOB_CANCELLED`, `WAIT_TIMEOUT`, `WEBHOOK_VERIFICATION_FAILED` |
| `retryable` | Whether the same call, sent again with the same `idempotency_key`, can succeed |
| `operation` | The operation of the call, such as `analyze_project` |
| `idempotency_key` | The Idempotency-Key the call sent, or None for a call that sends none |
| `may_have_spent` | True when a call that spends ended without a clear answer |

`GptVideoApiError` is an error the API answered, with `status`, `request_id`, `hint`, `details` and `retry_after_sec`. `GptVideoNetworkError` is a request that got no usable answer. `GptVideoJobError` is work that `wait` was following and that failed, was cancelled or ran past the time of the wait: `handle` is the job, the export, the tool run or the turn as the last read gave it, and `error_message` says why the work failed. The message of an error has the form `NOT_READY (409): message of the API Hint: what to do [request req_...]`. The API key never appears in an error.

When Python cannot check the TLS certificate of the API, the error is `CONNECTION_FAILED` and says so. On macOS, run `Install Certificates.command` from the folder of your Python version.

### Retries

The SDK sends a call again after a failure only when that is safe: a read, a PATCH, PUT or DELETE, which has the same effect when sent twice, or a POST that carries an Idempotency-Key. It retries `CONNECTION_FAILED`, `TIMEOUT`, `NOT_READY`, `INTERNAL`, `UPSTREAM_FAILED`, `UNAVAILABLE` (unless the API is switched off) and a `BAD_RESPONSE` with a 5xx status, up to `max_retries` times (2). It waits the seconds of `Retry-After` when the API sends it, and otherwise a growing pause with jitter. A `Retry-After` longer than 60 seconds, or longer than the time the call has left, ends the call, and the error carries it in `retry_after_sec`. `RATE_LIMITED` is retried for every call, because the API refuses it before running anything. `on_retry` is told before every pause.

`IDEMPOTENCY_IN_PROGRESS` means the first request with the same key is still running on the server. The SDK waits and asks again with the same key until it gets the answer, and this does not count toward `max_retries`.

`timeout` (60 seconds) is the time of one attempt, and `deadline` (180 seconds) the time of the whole call, pauses included.

### A call that may have spent

A call that spends gets an Idempotency-Key made once for the call, before the first attempt, and sent again on every retry. For 24 hours the API answers a key whose request succeeded with that same answer, marked replayed, and does not run the call again. A key whose request ended in an error can be sent again: the request runs again, and a charge it already made is not made a second time.

When a call that spends ends without a clear answer after its retries, its error has `may_have_spent` set to True: the API may have charged it. Call again with `idempotency_key=error.idempotency_key`. If the first request ran, you get its answer and pay nothing more; if it did not, it runs now. The `spend_once` function of the quickstart does this. A new key would be a new request, charged again.

Every POST that writes or spends sends a key, and you can pass one of your own as `idempotency_key`: 1 to 255 visible ASCII characters, with no spaces. A PATCH, PUT or DELETE takes none.

### CONFLICT

A `CONFLICT` is never retried. When it says that the revision you sent is no longer the current one, read the composition or the timeline again and decide from what it holds now. A change you sent as a new call, after an earlier call of the same change ended in an error, may already be in it: to send a change again, pass the `idempotency_key` of that error, and if the first one was written you get its answer.

### NOT_READY after accept_clip

When the project follows the face of the speaker, `accept_clip` starts a framing job on the new composition, and `composition["framing"]["jobId"]` is that job. Until it is done, `create_export` answers `NOT_READY`; the SDK waits the seconds of `Retry-After` and sends it again with the same key, up to `max_retries` times. The quickstart waits for the framing job with `wait_for_job` first, so the export starts at once.

## Waiting for work

`analyze_project`, `create_export`, the tools and the Editor Assistant start work and answer at once with the job, the export, the tool run or the turn. `gv.wait(answer)` takes that answer and reads the work again until it is done, failed or cancelled. Each read waits on the server for up to 25 seconds, so a wait sends few requests.

- `timeout` is 3600 seconds. A longer wait raises `WAIT_TIMEOUT`, with the last object read. Ending a wait never stops the work: waiting again picks it up.
- Work that failed or was cancelled raises `GptVideoJobError`. With `throw_on_failure=False` the wait returns the object instead.
- `on_progress` is told of every read, and `cancel`, a `threading.Event`, stops the wait.
- `wait_for_job`, `wait_for_export`, `wait_for_tool_run` and `wait_for_assistant_turn` take an id or an object.

## Lists

The nine list methods answer one page at a time. `gv.paginate` follows `nextCursor` for you, and asks for a page only when the items before it are used up:

- `gv.paginate("list_projects", limit=100)` goes through every project.
- `gv.paginate("list_clips", projectId=project_id, status="proposed")` goes through the clips of a project, in the order the analysis ranked them.

## Uploads and downloads

`upload_file` takes the path of a file, bytes, or a file opened in binary mode. A file that cannot seek needs `size_bytes`. The SDK reads each part right before it sends it and never holds the whole file in memory.

- The API takes MP4, MOV, MKV, WebM, AVI and MPEG-TS files up to 8 GB, and chooses the size of the parts.
- Four parts travel at once (`concurrency`, up to 16), and each part is retried on its own.
- Each part has its own timeout: 60 seconds, or longer for a part that needs it at 100 KB a second, up to 10 minutes. After a part times out, the rest go one at a time.
- If the upload fails, the SDK cancels it.
- `on_progress` is told after every part the API received.

An upload takes as long as your connection needs to send the file. 1 GB is 8,000 megabits, so on a 10 Mbit/s upload link it takes at least 800 seconds, about 13 minutes.

`download(url, destination)` writes the file behind a signed link, such as the `downloadUrl` of a finished export, to a path or to a file opened in binary mode, and returns how many bytes it wrote. It never sends your API key, accepts only `https` links, and retries a failure that comes before the answer, as it does for a read. When a download fails, a path is left as it was. A link expires after a while: read the export again with `get_export` for a new one.

## Webhooks

GPT-Video can call your server when a job or an export ends. You add the address on the Developers page of the app, which shows the signing secret of the webhook. It starts with `whsec_`. [Webhooks](https://www.gpt-video.com/developers/webhooks) describes the events.

`gpt_video.webhooks` checks a delivery on the raw request body, before you parse it as JSON:

- `verify_webhook(headers=..., body=..., secret=...)` checks it and returns the `id` and `timestamp` of the delivery.
- `construct_event(headers=..., body=..., secret=...)` checks it and returns the event.
- `Webhook(secret).verify(body, headers)` has the form of the Standard Webhooks libraries, so a receiver that uses one of them changes only its import.

A delivery that does not check out raises `WebhookVerificationError`, whose `reason` says why. A timestamp more than 300 seconds from your clock is refused (`tolerance_sec`).

## Options

`GptVideo(...)` checks every option before anything is sent.

| Option | Default | What it does |
|---|---|---|
| `api_key` | `GPT_VIDEO_API_KEY` | The API key. It starts with `gvk_`. |
| `base_url` | `https://api.gpt-video.com/v1` | The address of the API, with or without `/v1` |
| `max_retries` | 2 | Failures retried after the first attempt |
| `timeout` | 60 | The seconds of one attempt |
| `deadline` | 180 | The seconds of a whole call, pauses included |
| `on_response` | None | Told of every answer, with its status and rate limit |
| `on_retry` | None | Told before every pause, with the code and the delay |
| `user_agent_suffix` | None | Added after `gpt-video-python/<version>` in the User-Agent |

The SDK sends requests with `urllib`. For an address that is not this machine it uses the proxy the environment sets, such as HTTPS_PROXY, read once when the client is made. It never follows a redirect with your API key.

## From MCP to the SDK

If you used GPT-Video through its MCP server, most tools there have a method here that does the same work, with the same name, such as `get_credits`. These tools have another name here:

| MCP tool | SDK method | How they relate |
|---|---|---|
| `create_auto_clip_project` | `create_project` | The same operation |
| `configure_project` | `update_project` | Close work with other arguments |
| `find_clips` | `analyze_project` | Close work with other arguments |
| `export_clip` | `accept_clip` | Close work with other arguments |
| `export_clip` | `create_export` | Close work with other arguments |
| `wait_for_job` | `get_job` | The same operation |

For close work, read the page of the method before you switch.

The first tools of the MCP server were written by hand before the API, and five of them share a name with a method here but have arguments and answers of their own: `list_projects`, `create_project`, `get_project`, `list_clips` and `get_job`. On MCP, `create_project` makes an empty project for a video the user uploads in the app; `create_project` here takes the video in `sourceAssetId`. Read the page of the method for these too.

On MCP a tool that spends needs `confirm: true`. The SDK has no such argument: calling the method is the decision.

## Versions

Version 1.0.0 of the SDK calls version 1 of the API. The answers come back as the API sends them, so a field the API adds reaches your code before the SDK knows it. [CHANGELOG.md](CHANGELOG.md) lists the changes.

Questions: hello@gpt-video.com. The API documentation: https://www.gpt-video.com/developers.

MIT license.
