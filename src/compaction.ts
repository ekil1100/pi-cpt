import { randomUUID } from "node:crypto";
import {
  compact,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";
import { Effect, Schema } from "effect";
import type { Config } from "./config.ts";
import { errorDetails, type Log } from "./log.ts";

const FileDetails = Schema.Struct({
  readFiles: Schema.Array(Schema.String),
  modifiedFiles: Schema.Array(Schema.String),
});
const Details = Schema.Struct({
  owner: Schema.Literal("pi-cpt"),
  version: Schema.Literal(1),
  readFiles: Schema.Array(Schema.String),
  modifiedFiles: Schema.Array(Schema.String),
});

// Pi skips fromHook file lists. Restore ours before any fallback uses preparation.
export const restoreFiles = (event: SessionBeforeCompactEvent): void => {
  const previous = event.branchEntries.findLast((entry) => entry.type === "compaction");
  if (!previous?.fromHook || !Schema.is(Details)(previous.details)) return;
  for (const path of previous.details.readFiles) event.preparation.fileOps.read.add(path);
  for (const path of previous.details.modifiedFiles) event.preparation.fileOps.edited.add(path);
};

export const compactWithModel = (
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  config: Config,
  log: Log = () => {},
) =>
  Effect.tryPromise({
    try: async (): Promise<SessionBeforeCompactResult> => {
      const compactionId = randomUUID();
      const started = performance.now();
      const record: Log = (entry) => log({ compactionId, ...entry });
      record({
        event: "compaction_start",
        provider: config.provider,
        model: config.model,
        reason: event.reason,
        tokensBefore: event.preparation.tokensBefore,
      });
      let outcome = "cancelled";
      try {
        if (event.signal.aborted) return { cancel: true };
        const model = ctx.modelRegistry.find(config.provider, config.model);
        if (!model) throw new Error("Compaction model is unavailable");
        const result = await compact(
          event.preparation,
          model,
          undefined,
          undefined,
          event.customInstructions,
          event.signal,
          config.thinkingLevel,
          async (summaryModel, context, options) => {
            const requestId = randomUUID();
            const requestStarted = performance.now();
            record({
              event: "request_start",
              requestId,
              provider: summaryModel.provider,
              model: summaryModel.id,
              messageCount: context.messages.length,
              thinkingLevel: config.thinkingLevel,
              maxTokens: options?.maxTokens,
            });
            try {
              const stream = ctx.modelRegistry.streamSimple(summaryModel, context, options);
              const response = await stream.result();
              record({
                event: "request_end",
                requestId,
                durationMs: performance.now() - requestStarted,
                stopReason: response.stopReason,
                usage: response.usage,
                ...(response.errorMessage
                  ? { error: errorDetails(new Error(response.errorMessage)) }
                  : {}),
              });
              if (response.stopReason === "error" || response.stopReason === "length") {
                throw new Error(
                  response.errorMessage || `Compaction response stopped: ${response.stopReason}`,
                );
              }
              // Check raw text before Pi appends file lists, which could mask an empty summary.
              if (
                response.stopReason === "aborted" ||
                !response.content.some(
                  (block) => block.type === "text" && block.text.trim().length > 0,
                )
              ) {
                throw new Error("Compaction returned an incomplete summary");
              }
              return stream;
            } catch (error) {
              record({
                event: "request_failed",
                requestId,
                durationMs: performance.now() - requestStarted,
                cancelled: event.signal.aborted,
                error: errorDetails(error),
              });
              throw error;
            }
          },
        );
        if (event.signal.aborted) return { cancel: true };
        outcome = "success";
        return {
          compaction: {
            ...result,
            details: {
              ...Schema.decodeUnknownSync(FileDetails)(result.details),
              owner: "pi-cpt",
              version: 1,
              durationMs: performance.now() - started,
            },
          },
        };
      } catch (error) {
        outcome = event.signal.aborted ? "cancelled" : "failed";
        record({
          event: "compaction_error",
          error: errorDetails(error),
          fallback: !event.signal.aborted,
        });
        throw error;
      } finally {
        record({ event: "compaction_end", outcome, durationMs: performance.now() - started });
      }
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  });
