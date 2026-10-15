import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Log = (entry: Record<string, unknown>) => void;

export const errorDetails = (error: unknown): { name: string; message: string } => ({
  name: error instanceof Error ? error.name : "Error",
  message: (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[\w-]+/g, "[REDACTED]"),
});

export const createLog = (path: string, onError: () => void): Log => {
  let warned = false;
  return (entry) => {
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      appendFileSync(
        path,
        `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`,
        {
          mode: 0o600,
        },
      );
    } catch {
      // A full disk or unwritable log must not trigger a second model request.
      if (!warned) {
        warned = true;
        onError();
      }
    }
  };
};
