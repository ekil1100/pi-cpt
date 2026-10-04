# pi-cpt

Dedicated compaction model and custom context status for Pi.

A small, functional TypeScript extension built with Effect, Vite+, and Bun. Pi owns compaction timing, cut points, retained messages, and summary prompts. `pi-cpt` selects the summary model and displays an independent `cpt` status segment. It leaves the default footer and the conversation model in place.

## Requirements

- Pi 1.0.1 (the tested host version).
- A compaction model registered in Pi, with authentication configured through Pi.
- Bun 1.4.2 for dependency management and development scripts.
- Node `^22.18.0 || ^24.11.0 || >=26.0.0` for the Vite+ CLI and tests. Development was verified on Node 24.21.0. The extension runs inside the Pi host process, not in a separate Bun process.

## Install from this checkout

```sh
bun install
bun run build
```

Disable or remove the previous compaction extension before loading this one. Multiple `session_before_compact` handlers can overwrite each other's results and issue extra model requests.

For a personal installation:

```sh
# If installed under this exact source:
pi remove npm:pi-custom-compaction
pi install /absolute/path/to/pi-cpt
```

Use `pi list` to check the previous package's actual source. Restart Pi or use `/reload` after changing installed extensions. These commands change your personal Pi configuration; building this repository does not.

For a one-session trial, after disabling the old extension:

```sh
pi --extension ./dist/index.mjs
```

For installation from npm, after disabling the old compaction extension:

```sh
pi install npm:pi-cpt
```

## Configuration

Create `~/.pi/agent/pi-cpt.json`, or `pi-cpt.json` inside the directory selected by `PI_CODING_AGENT_DIR`:

```json
{
  "provider": "deepseek",
  "model": "deepseek-flash",
  "thinkingLevel": "low",
  "showStatus": true,
  "status": ["percent", "used"]
}
```

`pi-cpt.example.json` contains this example. Provider and model must match your Pi model registry exactly. This extension does not read the previous `compaction-policy.json` or copy credentials.

| Field           | Required | Default | Meaning                                                      |
| --------------- | -------- | ------- | ------------------------------------------------------------ |
| `provider`      | Yes      | —       | Pi provider ID                                               |
| `model`         | Yes      | —       | Model ID within that provider; may contain slashes           |
| `thinkingLevel` | No       | `off`   | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |
| `showStatus`    | No       | `true`  | Show an independent `cpt` status segment in TUI mode         |

`status` is optional and defaults to `["percent", "used"]`. The first item is `percent` or `number`; the second is `left` or `used`. For a 100k-token window with 37k tokens used:

| `status`              | Display                      |
| --------------------- | ---------------------------- |
| `["percent", "used"]` | `cpt · 37% · deepseek-flash` |
| `["percent", "left"]` | `cpt · 63% · deepseek-flash` |
| `["number", "used"]`  | `cpt · 37k · deepseek-flash` |
| `["number", "left"]`  | `cpt · 63k · deepseek-flash` |

Number mode shows token counts, using `k` for thousands with up to one decimal place. Remaining context is the model's context window minus current usage, not the budget before automatic compaction. Remaining values have a minimum of zero. Unknown usage stays `?` in every mode. `showStatus` still controls visibility.

The thinking value is passed to Pi's built-in helper. The provider and model determine the effective supported reasoning level; non-reasoning models ignore it. Configuration rejects unknown fields and invalid values. There are no project overrides, profiles, templates, custom triggers, retention ratios, or model chains.

Configuration is read on `session_start`, including `/reload`. A missing file leaves Pi's default compaction active and hides the status segment. An invalid or unreadable file does the same and produces a warning where a UI is available.

## Behavior

Use native `/compact [instructions]` or let Pi trigger automatic compaction.

1. Pi prepares the summary input and retained-message boundary.
2. `pi-cpt` finds the dedicated model and calls Pi's native `compact()` with the configured thinking level and event cancellation signal.
3. Requests go through `ctx.modelRegistry.streamSimple()`, so Pi handles registered providers, authentication, provider headers, base URLs, and environment settings. Secrets are not stored in this extension's config or included in its failure notifications.
4. Successful results preserve boundaries, usage, and file details. A small ownership marker lets later compactions restore cumulative file lists that Pi skips for extension-generated entries.
5. A dedicated-model error, missing model, empty summary, aborted provider response, truncated output, or tool-call response causes a warning and hands control back to Pi's default compaction. This can issue another billable request using the conversation model. There is no extension-level retry or fallback model chain.
6. User cancellation returns `{ cancel: true }` and never requests a default fallback.

The status segment looks like `cpt · 37% · deepseek-flash`. The `cpt` label uses the theme's `accent` color; the separators, context value, and configured compaction model ID use `dim`. It adds `compacting` while the dedicated model runs and `default fallback` after a failure, also in `dim`. Terminal success/failure events clear the activity indicator. Context usage refreshes after Pi persists the assistant message, before tool execution, and after it persists tool results, at turn end. Unknown usage is shown as `cpt · ? · deepseek-flash` (using the configured model ID), including when Pi has no new usage estimate after compaction. JSON and print modes perform compaction without terminal UI calls.

### Boundaries

- The extension delegates cut selection and output limits to Pi. It does not preflight the dedicated model's input window or split oversized inputs. Choose a model with sufficient context capacity; provider failures use the documented fallback.
- Registry routing preserves provider authentication behavior, but it is not the main conversation's complete stream wrapper. The dedicated path does not inherit every conversation-level timeout, retry, attribution-header, or header-hook setting.
- Successful summary usage is returned unchanged, including split-summary totals. Usage from a failed dedicated attempt is not persisted by this hook.
- File-list restoration covers consecutive `pi-cpt` compactions and default fallbacks while the extension remains loaded. After removal, Pi may skip deterministic file-list inheritance from earlier extension-generated entries; the summary text and original history remain stored.
- `/tree` branch summarization remains entirely managed by Pi.
- Offline tests use fake provider streams with Pi 1.0.1's real AgentSession, extension runner, compaction helper, and in-memory SessionManager. They cover dedicated compaction → actual default fallback → dedicated compaction, cumulative file lists, usage, and post-persistence status ordering. Real provider billing, authentication refresh, and terminal rendering need a live smoke test.

## Publishing with GitHub Actions OIDC

[`.github/workflows/publish.yml`](.github/workflows/publish.yml) publishes on pushed `v*` tags. It uses a GitHub-hosted runner, Node 24.21.0, npm 11.19.0, and the Bun version in `packageManager`. Actions are pinned to commit SHAs. No `NPM_TOKEN` or `NODE_AUTH_TOKEN` secret is required.

### One-time setup

1. Commit and push this project, including the workflow, to `ekil1100/pi-cpt` on GitHub.
2. Sign in to npm as a maintainer of [`pi-cpt`](https://www.npmjs.com/package/pi-cpt). Open the package's **Settings → Trusted Publisher** section and add **GitHub Actions** with these exact values:

   | Field                | Value                                                        |
   | -------------------- | ------------------------------------------------------------ |
   | Organization or user | `ekil1100`                                                   |
   | Repository           | `pi-cpt`                                                     |
   | Workflow filename    | `publish.yml`                                                |
   | Environment name     | Leave empty; this workflow does not use a GitHub environment |

3. Enable the allowed action **`npm publish`**. A stage-only configuration will reject this workflow's direct publish command.
4. Save the trusted publisher before pushing a release tag. GitHub login alone does not grant npm publishing access.

The package already exists on npm, so it can be linked directly. Trusted-publisher configuration is an npm-side action; adding the workflow file does not create that trust relationship. See the [npm trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).

### Release a new version

Update `package.json` to a new, unpublished version and commit it with the release changes. Then push the commit and a matching tag, for example after setting the version to `0.1.1`:

```sh
git tag v0.1.1
git push origin main v0.1.1
```

The workflow rejects a tag that does not exactly match `v` plus the package version. It installs dependencies with the frozen Bun lockfile, then calls `npm publish`. The existing `prepublishOnly` script runs formatting, lint, type checks, all tests, and the build before publication. npm obtains a short-lived OIDC credential and automatically generates provenance for trusted publishing from this public GitHub repository.

Inspect the result in the repository's **Actions** tab, then verify the published version:

```sh
npm view pi-cpt version
```

Version `0.1.0` is already published. Use a new version for the next release; npm versions cannot be overwritten. The workflow publishes the npm package only, without creating a GitHub Release or changing the version itself.

## Development

```sh
vp install           # Uses Bun from packageManager
vp check             # Formatting, lint, and type checks
vp test run          # Offline tests, one run
vp pack              # ESM extension and TypeScript declarations
bun run dev          # Watch the library build
```

`vp dev` starts Vite's application server; this package uses `vp pack --watch` instead. Runtime dependencies are external to the bundle. Pi is a host-provided peer dependency; Effect is the package's runtime dependency.

### Structure

- `src/config.ts`: strict Effect Schema decoding and effectful file loading.
- `src/compaction.ts`: dedicated-model operation and cumulative file tracking.
- `src/status.ts`: pure status formatting.
- `src/index.ts`: Pi lifecycle registration; mutable state is limited to the event adapter.
- `tests/index.test.ts` and `tests/lifecycle.test.ts`: offline configuration, real-helper, cancellation, accounting, and lifecycle tests.
- `tests/status.test.ts`: status configuration, four display combinations, and usage boundary cases.
- `tests/host.test.ts`: real-host compaction and event-ordering regressions.
- `tests/host.ts`: isolated host fixture. Narrow adapters use installed Pi 1.0.1 internal APIs to load inline extensions and construct a real ModelRuntime with only the fake provider. This avoids built-in provider discovery and ambient credentials; stores are in memory, configuration is temporary, and unexpected `fetch` calls fail. Recheck these adapters when changing the pinned host version.
