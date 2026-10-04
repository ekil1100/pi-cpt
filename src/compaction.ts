import {
  compact,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";
import { Effect, Schema } from "effect";
import type { Config } from "./config.ts";

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
) =>
  Effect.tryPromise({
    try: async (): Promise<SessionBeforeCompactResult> => {
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
          const stream = ctx.modelRegistry.streamSimple(summaryModel, context, options);
          const response = await stream.result();
          // Check raw text before Pi appends file lists, which could mask an empty summary.
          if (
            response.stopReason === "aborted" ||
            !response.content.some((block) => block.type === "text" && block.text.trim().length > 0)
          ) {
            throw new Error("Compaction returned an incomplete summary");
          }
          return stream;
        },
      );
      if (event.signal.aborted) return { cancel: true };
      return {
        compaction: {
          ...result,
          details: {
            ...Schema.decodeUnknownSync(FileDetails)(result.details),
            owner: "pi-cpt",
            version: 1,
          },
        },
      };
    },
    catch: () => new Error("Dedicated compaction failed"),
  });
