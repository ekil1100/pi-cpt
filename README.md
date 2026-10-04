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

Automatic compaction works as usual. To compact manually:

```text
/compact
```

You can add instructions:

```text
/compact Preserve the implementation decisions and remaining tasks.
```

If the dedicated model fails, pi-cpt warns you and lets Pi retry with its default compaction model. This may incur an additional model request. Canceling compaction stops the attempt without a fallback request.

Choose a compaction model with enough context capacity for your conversations. Successful compaction usage is included in Pi's session totals; failed dedicated-model attempts may incur costs that are absent from those totals.
