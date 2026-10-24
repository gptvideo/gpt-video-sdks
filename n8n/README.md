# n8n-nodes-gpt-video

The GPT-Video nodes for [n8n](https://n8n.io).

GPT-Video turns a long video into short vertical clips with captions and face framing. With these nodes a workflow uploads a video, has GPT-Video find the moments that work as clips, exports the ones it keeps as MP4 files, and starts when a job or an export ends.

- **GPT-Video** has one operation for each operation of the [GPT-Video API](https://www.gpt-video.com/developers/api), plus Upload a Video File and Download an Export, which take a whole file in one step.
- **GPT-Video Trigger** starts a workflow when GPT-Video sends a webhook: a job or an export that ended, or a test event.

## Install

In n8n, open Settings, then Community Nodes, select Install, and enter `n8n-nodes-gpt-video`. [Install community nodes](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n documentation has the details.

## Credentials

**GPT-Video API**, for the GPT-Video node:

1. Create a GPT-Video account and confirm your email address.
2. Open the Developers page of the app, https://www.gpt-video.com/app/developers, and create an API key with the scopes `clips:read`, `clips:write` and `spend`. The key is shown once, so copy it then.
3. Paste it in API Key. Leave Base URL as it is.

Saving the credential calls Get the Current Key, which uses no credits, to check that the key works.

**GPT-Video Webhook API**, for the GPT-Video Trigger: the signing secret of the webhook, which starts with `whsec_`. The next section says where to find it.

## A first workflow

1. Read a video file into a binary field, for example with the Read/Write Files from Disk node or an HTTP Request node.
2. **GPT-Video**, Upload, Upload a Video File. Input Binary Field is the field that holds the video, `data` by default. The node sends the file in parts and returns the video as `asset`, whose `id` the next step needs.
3. **GPT-Video**, Project, Create a Project, with that id in Source Asset ID. Auto Clip has no default settings: under Additional Fields, set Settings to the JSON of every setting, such as `{"language": "auto", "clipCount": 3, "minDurationSec": 15, "maxDurationSec": 60, "objective": "viral", "captionStyle": "word-pop", "reframe": "face"}`. The analysis starts only when `missingSettings` is empty.
4. **GPT-Video**, Project, Estimate the Credits of an Analysis or a Build, to see the price. It uses no credits.
5. **GPT-Video**, Project, Analyze a Project, with Wait Until Finished on. This spends credits: one per started minute of the video.
6. **GPT-Video**, Clip, List the Clips of a Project, then Accept a Clip on the clip you want.
7. **GPT-Video**, Export, Export a Composition, with Wait Until Finished on. This uses one export of the daily allowance. While the face framing of the accepted clip is computed, the API answers `NOT_READY`: the node waits the seconds the API asks and sends it again twice, and stops with `NOT_READY` when the framing takes longer. Then put a Wait node of a minute before it, or turn on Retry On Fail, which sends the same Idempotency-Key.
8. **GPT-Video**, Export, Download an Export, which puts the MP4 file in a binary field.

Every operation that spends shows its cost in the node. [API pricing](https://www.gpt-video.com/developers/pricing) has the API bonus, the plans and the daily limits.

## Waiting for work

Analyze a Project, Export a Composition and the other operations that start work have Wait Until Finished. With it on, the node reads the work again until it ends and returns it finished, or stops with an error after Wait Timeout (5 minutes by default, 120 at most). The work goes on after the timeout. A failed or cancelled job is an error of the node.

An analysis can take longer than an n8n execution should wait. For long work, turn Wait Until Finished off and start a second workflow from the GPT-Video Trigger when the job ends.

## The GPT-Video Trigger

1. Add the GPT-Video Trigger to a workflow and copy its production URL.
2. On the Developers page of the GPT-Video app, add a webhook with that URL. The page shows its signing secret.
3. Put the signing secret in a GPT-Video Webhook API credential, and choose the events, or none for every event.
4. Activate the workflow.

The trigger checks the signature of every delivery on the bytes that arrived, and answers 401 without starting the workflow when it does not match. The GPT-Video API has no call that registers a webhook, so the address is added by hand.

The events: Export Cancelled, Export Completed, Export Failed, Job Cancelled, Job Completed, Job Failed, and Test Event. [Webhooks](https://www.gpt-video.com/developers/webhooks) describes them.

## Retries and the Idempotency-Key

A request that fails on the network or with a temporary error of the API is sent again by the node. An operation that writes or spends carries an Idempotency-Key: a request sent again with the same key gets the answer of the first one when it succeeded, and never pays twice.

The node makes the key from the n8n instance, the workflow, the execution, the node, the run and the item. Retry On Fail of n8n sends the same key again; another item, another run or another execution gets a new one.

When the node stops with an error that says the request may have been charged, the error shows the key it sent. To send that request again from a new execution without paying twice, set Options, Idempotency Key, to that key. With several items, use an expression that gives each item its own key.

## As a tool of an AI Agent

The GPT-Video node can be a tool of the n8n AI Agent. On a self-hosted n8n, community nodes work as tools only when the environment variable `N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE` is `true`. When the agent sends the same tool call again in the same execution, with the same arguments, it gets the same key.

## Versions

Version 1.0.0 of the nodes calls version 1 of the GPT-Video API. They need n8n with Node.js 20.19 or later. [CHANGELOG.md](CHANGELOG.md) lists the changes.

Questions: hello@gpt-video.com. The API documentation: https://www.gpt-video.com/developers.

MIT license.
