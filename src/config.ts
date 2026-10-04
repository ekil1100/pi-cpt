import { readFile } from "node:fs/promises";
import { Effect, Schema } from "effect";

const NonBlank = Schema.String.pipe(Schema.filter((value) => value.trim().length > 0));
export const ConfigSchema = Schema.Struct({
  provider: NonBlank,
  model: NonBlank,
  thinkingLevel: Schema.optionalWith(
    Schema.Literal("off", "minimal", "low", "medium", "high", "xhigh", "max"),
    { default: () => "off" as const },
  ),
  showStatus: Schema.optionalWith(Schema.Boolean, { default: () => true }),
  status: Schema.optionalWith(
    Schema.Tuple(Schema.Literal("percent", "number"), Schema.Literal("left", "used")),
    { default: () => ["percent", "used"] as const },
  ),
});
export type Config = typeof ConfigSchema.Type;

export const decodeConfig = (text: string) =>
  Schema.decodeUnknown(Schema.parseJson(ConfigSchema))(text, { onExcessProperty: "error" });

export const loadConfig = (path: string) =>
  Effect.tryPromise({ try: () => readFile(path, "utf8"), catch: (error) => error }).pipe(
    Effect.catchIf(
      (error) =>
        typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT",
      () => Effect.succeed(undefined),
    ),
    Effect.flatMap((text) => (text === undefined ? Effect.succeed(undefined) : decodeConfig(text))),
  );
