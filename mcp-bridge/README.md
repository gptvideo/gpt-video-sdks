# gpt-video-mcp

Connect [GPT-Video](https://www.gpt-video.com) to any AI assistant that speaks MCP over **stdio**.

GPT-Video edits video for short-form platforms: it turns a long video into vertical clips with
captions and reframing, and it makes split screen, streamer, Reddit story and fake text videos,
voiceovers and more. Its MCP server is remote and speaks Streamable HTTP, which most assistants
connect to directly. This package is for the ones that cannot: it runs as a local process, reads
MCP messages on standard input, forwards them to GPT-Video over HTTPS, and writes the answers back
to standard output.

You need it for Zed, JetBrains IDEs, some Windsurf builds, self-hosted n8n, and any machine behind a
corporate proxy. If your assistant can add a remote MCP server by URL, you do not need this
package. An assistant that signs in by URL alone, such as Claude on the web, connects to the
directory address below. The full address takes only an API key in an `Authorization` header, so
it is for assistants that let you set one, such as Claude Code, Cursor and VS Code.

## Two editions

| Edition | Address | Tools |
| --- | --- | --- |
| Directory | `https://www.gpt-video.com/api/mcp` | 8 tools for Auto Clip: find clips, configure, export |
| Full | `https://api.gpt-video.com/mcp` | The whole catalogue, in toolsets you can pick |

The bridge connects to the directory edition unless you ask for the full one with `--edition full`.
Both take the same API key.

## Use it

Create an API key in GPT-Video on the **Developers** page, then:

```bash
GPT_VIDEO_API_KEY=gvk_… npx gpt-video-mcp --edition full
```

In an assistant's MCP configuration, that looks like:

```json
{
  "mcpServers": {
    "gpt-video": {
      "command": "npx",
      "args": ["-y", "gpt-video-mcp", "--edition", "full"],
      "env": { "GPT_VIDEO_API_KEY": "gvk_…" }
    }
  }
}
```

For the directory edition, leave out `--edition full`.

On Windows, some assistants cannot launch `npx` directly. Use `"command": "cmd"` and
`"args": ["/c", "npx", "-y", "gpt-video-mcp", "--edition", "full"]`.

Prefer the environment variable over `--api-key`: anything on a command line is readable by every
process on the same machine.

### Toolsets

An assistant that shows only a limited number of tools, such as Cursor or Windsurf, works better with
some of them. With the full edition, `--toolsets` picks which:

```bash
npx gpt-video-mcp --edition full --toolsets clips,studio
```

| Toolset | What it holds |
| --- | --- |
| `core` | Credits, settings, assets, exports and jobs. Always on |
| `clips` | Auto Clip: projects, analysis, clips, transcripts |
| `studio` | Split screen, streamer, Reddit story, fake text, voiceovers, audio tools |
| `editor` | Edit a finished video, the timeline, the Editor Assistant |
| `files` | Upload a video file of your own |

### Options

| Flag | Environment | Default |
| --- | --- | --- |
| `--api-key` | `GPT_VIDEO_API_KEY` | *required* |
| `--edition` | `GPT_VIDEO_EDITION` | `directory` |
| `--toolsets` | `GPT_VIDEO_TOOLSETS` | all (full edition only) |
| `--url` | `GPT_VIDEO_URL` | the address of the edition |
| `--version` | | |

`--url` takes the full endpoint. A URL that ends in `/api/mcp` is the directory edition, and one that
ends in `/mcp` or `/api/mcp-full` is the full edition. If `--edition` says otherwise, the bridge
stops and tells you. A bare site address such as `https://www.gpt-video.com` is completed with
`/api/mcp`, for the directory edition only. The URL must use `https://`; plain `http://` works
only for a server on your own machine, because the key travels with every request.

When something goes wrong, the bridge prints the reason GPT-Video gave, for example that the key
was revoked or that the plan cannot use the API.

## What it does, and what it does not

It forwards messages and nothing else. It does not cache, does not retry, does not rewrite request
or response bodies, and has **no dependencies**: it is a few hundred lines of JavaScript using only
what Node already ships. Your API key is sent to GPT-Video in an `Authorization` header and is never
written to standard output, to standard error, or to disk.

Diagnostics go to standard error, because standard output carries the protocol: a single stray line
there is enough to make an assistant drop the connection.

## Spending

Some tools spend credits or a daily allowance, and each one asks for `confirm: true`, so the
assistant asks you first. In the full edition they also ask for an `idempotencyKey`, and a retry
with the same key never pays twice. The two spending tools of the directory edition are safe to
retry without one.

Full documentation: <https://www.gpt-video.com/developers/mcp>

## Licence

MIT
