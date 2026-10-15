import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { decodeConfig, loadConfig, type Config } from "./config.ts";
import { compactWithModel, restoreFiles } from "./compaction.ts";
import { formatStatus, type Phase } from "./status.ts";
import { createLog } from "./log.ts";
import { selectModel } from "./model-selector.ts";

export default function piCpt(pi: ExtensionAPI): void {
  const configPath = join(getAgentDir(), "pi-cpt.json");
  let config: Config | undefined;
  let enabled = true;
  let phase: Phase = "idle";

  const render = (ctx: ExtensionContext): void => {
    if (ctx.mode === "tui") {
      ctx.ui.setStatus(
        "pi-cpt",
        enabled && config?.showStatus
          ? formatStatus(ctx.getContextUsage(), phase, config.model, ctx.ui.theme, config.status)
          : undefined,
      );
    }
  };
  const reset = (ctx: ExtensionContext): void => {
    phase = "idle";
    render(ctx);
  };
  const notify = (ctx: ExtensionContext, message: string): void => {
    if (ctx.hasUI) ctx.ui.notify(message, "warning");
  };

  pi.registerCommand("cpt", {
    description: "Toggle dedicated compaction, or choose its model with /cpt model",
    getArgumentCompletions: (prefix) => {
      const matches = ["model"].filter((value) => value.startsWith(prefix.trim()));
      return matches.length ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim();
      if (action !== "" && action !== "model") {
        notify(ctx, "Usage: /cpt or /cpt model");
        return;
      }
      await ctx.waitForIdle();
      if (action === "") {
        if (!config) {
          notify(ctx, "pi-cpt: choose a compaction model with /cpt model first.");
          return;
        }
        enabled = !enabled;
        render(ctx);
        ctx.ui.notify(`pi-cpt ${enabled ? "enabled" : "disabled"} for this session.`, "info");
        return;
      }
      if (ctx.mode !== "tui") {
        notify(ctx, "/cpt model requires an interactive terminal.");
        return;
      }
      try {
        const selected = await selectModel(ctx, config);
        if (!selected) return;
        // Read the file again to preserve other settings and reject malformed configuration.
        const saved = await Effect.runPromise(loadConfig(configPath));
        const next = await Effect.runPromise(
          decodeConfig(
            JSON.stringify({
              ...saved,
              provider: selected.provider,
              model: selected.id,
            }),
          ),
        );
        await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
        config = next;
        render(ctx);
        ctx.ui.notify(`Compaction model saved: ${next.provider}/${next.model}.`, "info");
      } catch {
        notify(
          ctx,
          "pi-cpt: could not load or save the compaction model; current setting unchanged. Check pi-cpt.json and provider credentials.",
        );
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    enabled = true;
    config = await Effect.runPromise(
      loadConfig(configPath).pipe(
        Effect.catchAll(() => {
          notify(
            ctx,
            "pi-cpt: invalid or unreadable pi-cpt.json; using Pi default compaction. Fix the file and /reload.",
          );
          return Effect.succeed(undefined);
        }),
      ),
    );
    reset(ctx);
  });

  pi.on("session_before_compact", async (event, ctx) => {
    restoreFiles(event);
    if (event.signal.aborted) return { cancel: true };
    if (!enabled || !config) return;
    phase = "compacting";
    render(ctx);
    return Effect.runPromise(
      compactWithModel(
        event,
        ctx,
        config,
        createLog(join(getAgentDir(), "logs", "pi-cpt.jsonl"), () =>
          notify(ctx, "pi-cpt: could not write compaction log."),
        ),
      ).pipe(
        Effect.catchAll(() => {
          if (event.signal.aborted)
            return Effect.succeed<SessionBeforeCompactResult>({ cancel: true });
          phase = "fallback";
          render(ctx);
          notify(ctx, "pi-cpt: dedicated model failed; falling back to Pi default compaction.");
          return Effect.succeed(undefined);
        }),
      ),
    );
  });

  pi.on("session_compact", (_event, ctx) => reset(ctx));
  pi.on("session_compact_failed", (_event, ctx) => reset(ctx));
  pi.on("session_tree", (_event, ctx) => reset(ctx));
  pi.on("model_select", (_event, ctx) => render(ctx));
  // Pi 1.0.1 emits message_end before persistence. These events see the saved
  // assistant usage before tools run, then saved tool results before the next turn.
  pi.on("tool_execution_start", (_event, ctx) => render(ctx));
  pi.on("turn_end", (_event, ctx) => render(ctx));
  pi.on("agent_end", (_event, ctx) => render(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    phase = "idle";
    if (ctx.mode === "tui") ctx.ui.setStatus("pi-cpt", undefined);
  });
}
