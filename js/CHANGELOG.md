# Changelog

## 1.0.0

The first version, for version 1 of the GPT-Video API.

- One method for each of the 67 operations of the API, with types for TypeScript.
- Retries with one Idempotency-Key per call, waits for `IDEMPOTENCY_IN_PROGRESS`, a timeout for each attempt and a deadline for the whole call.
- `wait` and the four `waitFor` methods, `paginate`, `uploadFile` and `download`.
- `gpt-video/webhooks`: `verifyWebhook`, `constructEvent` and `Webhook`.
