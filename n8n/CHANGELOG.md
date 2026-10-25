# Changelog

## 1.0.1

No changes to the code. This version is published from GitHub Actions with npm Trusted Publishing, so npm shows where it was built.

## 1.0.0

The first version, for version 1 of the GPT-Video API.

- The GPT-Video node: one operation for each operation of the API, plus Upload a Video File and Download an Export, with Wait Until Finished for the work that runs as a job.
- The GPT-Video Trigger: starts a workflow on a signed webhook from GPT-Video.
- One Idempotency-Key per item and run, sent again by Retry On Fail.
