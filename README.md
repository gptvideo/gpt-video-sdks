# GPT-Video SDKs

The official libraries for the [GPT-Video API](https://www.gpt-video.com/developers). GPT-Video turns a long video into short vertical clips with captions and face framing: your program uploads a video, GPT-Video finds the moments that work as clips, and your program exports the ones it keeps as MP4 files.

| Folder | What it is | Install |
|---|---|---|
| [js](js) | The JavaScript and TypeScript SDK | `npm install gpt-video` |
| [python](python) | The Python SDK | `pip install gpt-video` |
| [n8n](n8n) | The GPT-Video node and trigger for n8n | `n8n-nodes-gpt-video`, from the Community Nodes of n8n |
| [postman](postman) | A Postman collection and environment | Import the two files in Postman |
| [mcp-bridge](mcp-bridge) | A local MCP server over stdio, for assistants that cannot connect to a remote one | `npx gpt-video-mcp` |
| [vectors](vectors) | The test vectors every SDK runs: requests, retries, Idempotency-Keys and webhook signatures | |

`js`, `python`, `n8n` and `postman` each have a README that takes you to a first call, and a CHANGELOG.

## How they behave

The JavaScript SDK, the Python SDK and the n8n nodes share one set of rules, written down as test vectors in `vectors` and run by each of them. The Postman collection makes its Idempotency-Keys in the format of the same vectors.

- A call that spends sends one Idempotency-Key, made before the first attempt and sent again on every retry, so a retry never pays twice. When such a call ends without a clear answer, its error says so and carries the key, and calling again with that key returns the answer of the first call if it succeeded, without paying again.
- Each attempt has a timeout and each call a deadline. A request is sent again only when that is safe, and a request that carries the API key never follows a redirect, because the redirect could take the key to another address.
- A webhook is checked on the raw bytes of the request, in constant time.
- The API key never appears in an error or in a printed client.

Files whose name contains `.generated.` or ends in `_generated.py` are made from the API reference and replaced whole at every release, so a change to one of them is lost. The API reference is at https://www.gpt-video.com/developers/api.

## Help

Questions and security reports: hello@gpt-video.com. Bugs: open an issue in this repository.

MIT license. See [LICENSE](LICENSE).
