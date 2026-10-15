import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import { createLog, errorDetails } from "../src/log.ts";

test("appends timestamped JSONL with private file permissions", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-cpt-log-"));
  try {
    const path = join(dir, "logs", "pi-cpt.jsonl");
    const warning = vi.fn();
    const log = createLog(path, warning);
    log({ event: "first" });
    log({ event: "second" });
    const entries = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(entries.map((entry) => entry.event)).toEqual(["first", "second"]);
    expect(Number.isNaN(Date.parse(entries[0].timestamp))).toBe(false);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(warning).not.toHaveBeenCalled();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("log IO failures warn once and do not throw", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-cpt-log-"));
  try {
    const file = join(dir, "file");
    writeFileSync(file, "");
    const warning = vi.fn();
    const log = createLog(join(file, "log"), warning);
    expect(() => {
      log({ event: "first" });
      log({ event: "second" });
    }).not.toThrow();
    expect(warning).toHaveBeenCalledTimes(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("redacts common credentials from error messages", () => {
  expect(errorDetails(new Error("Rejected Bearer secret-token and sk-private-key"))).toEqual({
    name: "Error",
    message: "Rejected Bearer [REDACTED] and [REDACTED]",
  });
});
