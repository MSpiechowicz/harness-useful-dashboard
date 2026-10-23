# Copilot Chat fixtures

`otlp/traces-8-rounds.json` is a merged OTLP/HTTP trace export of one eight-round Copilot Chat turn (main agent plus title and helper calls). `otlp/logs.json` and `otlp/metrics.json` are single real log and metric exports.
All prompt, message, tool and reasoning content is replaced by `SENTINEL_CONTENT_<n>` and repository identifiers are invented. Ids, models, token counts, credits and timings are as captured.
`User/` mimics a VS Code user directory with synthetic chat session files (`prompt one` style text, invented ids): a workspace folder, a `.code-workspace`, a `vscode-remote://` folder and an empty window session with a mid-file snapshot, an unknown kind and a truncated last line.
The session `a3dd1178-...` matches the trace. File tool call ids carry a `__vscode-<n>` suffix after the OTel call id, as in real files.
