import { join } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { loadConfig, type Config } from "./config.ts";
import { compactWithModel, restoreFiles } from "./compaction.ts";
import { formatStatus, type Phase } from "./status.ts";

export default function piCpt(pi: ExtensionAPI): void {
  let config: Config | undefined;
  let phase: Phase = "idle";

  const render = (ctx: ExtensionContext): void => {
    if (ctx.mode === "tui") {
      ctx.ui.setStatus(
        "pi-cpt",
        config?.showStatus
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

  pi.on("session_start", async (_event, ctx) => {
    config = await Effect.runPromise(
      loadConfig(join(getAgentDir(), "pi-cpt.json")).pipe(
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
    if (!config) return;
    phase = "compacting";
    render(ctx);
    return Effect.runPromise(
      compactWithModel(event, ctx, config).pipe(
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
