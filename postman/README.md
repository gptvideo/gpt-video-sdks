# GPT-Video API for Postman

A Postman collection with every operation of the GPT-Video REST API, made from the [API reference](https://www.gpt-video.com/developers/api), and an environment for your API key.

GPT-Video turns a long video into short vertical clips with captions and face framing.

## The files

- `gpt-video.generated.postman_collection.json`: the collection, with a Quickstart folder and one folder for each part of the API.
- `gpt-video.generated.postman_environment.json`: the environment, with `apiKey`, `baseUrl` and `idempotencySalt`.

In Postman, select Import and drop both files.

## Before the first request

1. Create a GPT-Video account and confirm your email address.
2. Open the Developers page of the app, https://www.gpt-video.com/app/developers, and create an API key with the scopes `clips:read`, `clips:write` and `spend`. The key is shown once, so copy it then.
3. Select the GPT-Video environment and paste the key in the current value of `apiKey`. Leave its initial value empty: in a shared workspace, initial values are synced to the others.

## The Quickstart folder

Twelve requests take a video from your disk to a finished clip. Send them in order, or run the folder in the Collection Runner. Each one saves the id the next one needs in a collection variable.

- Set the collection variable `fileSizeBytes` to the exact size of your video in bytes, and in Send a part of an upload choose the file as the body.
- In Postman a video must fit in one part of the upload: 8388608 bytes (8 MiB) at most. For a longer video, use the JavaScript or the Python SDK, which send the parts for you.
- Two requests spend: Analyze a project charges credits, and Export a composition uses one export of the daily allowance. Estimate the credits of an analysis or a build shows the price first, and uses no credits.
- In the Collection Runner, the two wait steps are sent again until the job and the export finish, for up to 60 minutes each.
- Export a composition answers `NOT_READY` while the face framing of the accepted clip is computed, which starts when the clip is accepted. The Collection Runner stops there. Wait the seconds its `Retry-After` header gives, then send Export a composition again, and Get an export after it. Sending it again is safe: the API keeps no answer for a request that ended in an error, so the same Idempotency-Key runs it now, once.

[API pricing](https://www.gpt-video.com/developers/pricing) has the API bonus, the plans and the daily limits.

## The Idempotency-Key

Requests that write or spend carry an Idempotency-Key, which the pre-request script of the collection makes from the method, the path, the body and your `idempotencySalt`. The same request sent again carries the same key, so the API never runs it twice: for 24 hours, a request that succeeded is answered again, marked Idempotent-Replayed, and the console and the test results say so.

To send a new request, change the body or your `idempotencySalt`. The salt is made the first time a request needs it and stays in your environment; the environment file leaves it empty, so two people never share a key. A request with an Idempotency-Key header of its own keeps it.

To run the Quickstart again with the same video, change the filename in Start an upload or your `idempotencySalt` first.

## Versions

The collection is made for version 1 of the GPT-Video API. [CHANGELOG.md](CHANGELOG.md) lists the changes.

Questions: hello@gpt-video.com. The API documentation: https://www.gpt-video.com/developers.

MIT license.
