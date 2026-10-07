# Pricing

## Model pricing

| Model                                                                                                                                 | Base input tokens     | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens          |
| :------------------------------------------------------------------------------------------------------------------------------------ | :-------------------- | :-------------- | :-------------- | :----------------------- | :--------------------- |
| Claude Fable 5.1                                                                                                                      | $10 / MTok            | $12.50 / MTok   | $20 / MTok      | $0.25 / MTok<sup>1</sup> | $50 / MTok             |
| Claude Mythos 5.1 ([limited availability](https://support.claude.com/en/articles/14604842))                                           | $10 / MTok            | $12.50 / MTok   | $20 / MTok      | $0.25 / MTok<sup>1</sup> | $50 / MTok             |
| Claude Opus 5.5                                                                                                                       | $4 / MTok             | $5 / MTok       | $8 / MTok       | $0.20 / MTok<sup>2</sup> | $20 / MTok             |
| Claude Opus 5                                                                                                                         | $5 / MTok             | $6.25 / MTok    | $10 / MTok      | $0.50 / MTok             | $25 / MTok             |
| Claude Opus 4.8                                                                                                                       | $5 / MTok             | $6.25 / MTok    | $10 / MTok      | $0.50 / MTok             | $25 / MTok             |
| Claude Opus 4 ([retired, except on Google Cloud](https://platform.claude.com/docs/en/about-claude/model-deprecations))                | $15 / MTok            | $18.75 / MTok   | $30 / MTok      | $1.50 / MTok             | $75 / MTok             |
| Claude Sonnet 5.5                                                                                                                     | $2 / MTok             | $2.50 / MTok    | $4 / MTok       | $0.20 / MTok             | $10 / MTok             |
| Claude Haiku 4.5                                                                                                                      | $1 / MTok             | $1.25 / MTok    | $2 / MTok       | $0.10 / MTok             | $5 / MTok              |
| Claude Haiku 3.5 ([retired, except on Bedrock and Google Cloud](https://platform.claude.com/docs/en/about-claude/model-deprecations)) | $0.80 / MTok          | $1 / MTok       | $1.60 / MTok    | $0.08 / MTok             | $4 / MTok              |

*<sup>1 Cache hits and refreshes on Claude Fable 5.1 and Claude Mythos 5.1 are priced at 0.025x the base input price.</sup>*

*<sup>2 Cache hits and refreshes on Claude Opus 5.5 are priced at 0.05x the base input price.</sup>*

### Fast mode pricing

[Fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode), in research preview, provides significantly faster output for Claude Opus 5.5, Claude Opus 5, and Claude Opus 4.8 at premium pricing. Fast mode pricing applies across the full context window, including requests over 200k input tokens. Fast mode is available on the Claude API (first-party) only; it is not available on Claude Platform on AWS or partner-operated cloud platforms.

| Model                           | Input      | Output     |
| ------------------------------- | ---------- | ---------- |
| Claude Opus 5.5                 | $8 / MTok  | $40 / MTok |
| Claude Opus 5 / Claude Opus 4.8 | $10 / MTok | $50 / MTok |

Fast mode is not available on Claude Opus 4.7 (requests with `speed: "fast"` return an error) or Claude Opus 4.6 (requests run at standard speed and are billed at standard rates). See [Fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode#supported-models).

### Batch processing

| Model | Batch input | Batch output |
| :-- | :-- | :-- |
| Claude Opus 5.5 | $2 / MTok | $10 / MTok |
