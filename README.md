# pi-cpt

Use a dedicated model for Pi's context compaction, with a compact context status display.

```text
cpt · 37% · deepseek-flash
```

Your conversation model stays unchanged. Pi continues to manage when to compact, which recent messages to keep, and the summary format.

## Install

Requires Pi with your chosen compaction model and its authentication configured. Tested with Pi 1.0.1; the status display was also checked in Pi 1.0.2.

```sh
pi install npm:pi-cpt
```

Disable any other compaction extension first, then restart Pi or run `/reload`.

## Configure

Create `~/.pi/agent/pi-cpt.json`:

```json
{
  "provider": "deepseek",
  "model": "deepseek-flash",
  "thinkingLevel": "low",
  "showStatus": true,
  "status": ["percent", "used"]
}
```

Use the exact provider and model IDs registered in Pi. Authentication stays in Pi; this file only selects the model and display settings. If you use `PI_CODING_AGENT_DIR`, put the file in that directory instead.

| Option          | Default               | Description                                                                                           |
| --------------- | --------------------- | ----------------------------------------------------------------------------------------------------- |
| `provider`      | Required              | Provider ID.                                                                                          |
| `model`         | Required              | Compaction model ID.                                                                                  |
| `thinkingLevel` | `"off"`               | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; effective support depends on the model. |
| `showStatus`    | `true`                | Show the status segment.                                                                              |
| `status`        | `["percent", "used"]` | Display format and whether to show used or remaining context.                                         |

Run `/reload` after editing the file. A missing configuration leaves Pi's default compaction active. Invalid configuration also falls back to Pi's default and shows a warning.

### Status display

For a 100k-token context window with 37k tokens used:

| `status`              | Display                      |
| --------------------- | ---------------------------- |
| `["percent", "used"]` | `cpt · 37% · deepseek-flash` |
| `["percent", "left"]` | `cpt · 63% · deepseek-flash` |
| `["number", "used"]`  | `cpt · 37k · deepseek-flash` |
| `["number", "left"]`  | `cpt · 63k · deepseek-flash` |

The percentage or token count describes your conversation's context; the model name identifies the configured compaction model. Remaining context is measured against the full context window, rather than the automatic-compaction threshold. Token counts use `k` for thousands, with up to one decimal place. Unknown usage appears as `?`.

`cpt` uses the theme's accent color; the rest uses dim text. The segment adds `compacting` during compaction or `default fallback` when switching to Pi's default. Pi's existing footer stays visible.

## Use

- `/cpt` toggles dedicated compaction for the current session. Disabling it hides the cpt status and uses Pi's default compaction. A new session or `/reload` enables it again when a model is configured.
- `/cpt model` opens a searchable model picker in the interactive terminal. Type to filter, use the selection keys to navigate, confirm to save, or cancel to keep the current model. The configured model appears first. Only available authenticated chat models are listed.

The selected model is saved to `pi-cpt.json` and takes effect on the next compaction; other settings are preserved. Selecting a model leaves the current enable/disable state unchanged and never changes your conversation model. If no configuration exists, use `/cpt model` to create one. Commands wait for the current operation to finish before changing settings.

Automatic compaction works as usual. To compact manually:

```text
/compact
```

You can add instructions:

```text
/compact Preserve the implementation decisions and remaining tasks.
```

If the dedicated model fails, pi-cpt warns you and lets Pi retry with its default compaction model. This may incur an additional model request. Canceling compaction stops the attempt without a fallback request. Each dedicated-model compaction has a fixed 180-second total timeout, shared by all split-turn requests. On timeout, pi-cpt aborts the request and falls back to Pi's default model. This limit does not cover the subsequent default-model fallback. Providers receive an abort signal; remote processing may continue if a provider ignores cancellation.

Choose a compaction model with enough context capacity for your conversations. Successful compaction usage is included in Pi's session totals; failed dedicated-model attempts may incur costs that are absent from those totals.

### Compaction logs

Dedicated-model attempts are logged automatically to `~/.pi/agent/logs/pi-cpt.jsonl` (or `$PI_CODING_AGENT_DIR/logs/pi-cpt.jsonl`). Each line is a JSON object with a timestamp and a `compactionId`. Model requests also have a `requestId`; split-turn compaction can issue multiple requests.

- `compaction_start`: provider, model, trigger reason, and context token count.
- `request_start`: provider, model, message count, thinking level, and output token limit.
- `request_end`: response received, elapsed `durationMs`, stop reason, and token/cost usage. A rejected response also produces `request_failed`.
- `request_failed` and `compaction_error`: error name and message; the latter indicates whether fallback will be requested.
- `compaction_end`: elapsed `durationMs` and outcome (`success`, `failed`, `timeout`, or `cancelled`). Successful compaction entries also store `details.durationMs` in the session.

Timing covers the dedicated attempt, not Pi's subsequent default-model fallback. Default-model requests and attempts cancelled before entering the extension are outside this log's scope. Durations use a monotonic clock. `compaction_start` includes `timeoutMs`; timeout errors also record this limit and use the error name `TimeoutError`.

Logs omit prompts, summaries, request headers, and configured credentials. Common bearer tokens and `sk-` keys are redacted from error messages, but provider errors may contain other sensitive data; review logs before sharing them. New log files use owner-only permissions. Logs append without automatic rotation; delete or archive the file as needed. A log write failure shows a warning and leaves compaction behavior unchanged.
