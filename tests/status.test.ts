import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { decodeConfig, type Config } from "../src/config.ts";
import piCpt from "../src/index.ts";
import { formatStatus } from "../src/status.ts";

const theme = { fg: (_color: string, text: string) => text };
const modes = [
  ["percent", "used", "37%"],
  ["percent", "left", "63%"],
  ["number", "used", "37k"],
  ["number", "left", "63k"],
] as const;

test.each(modes)(
  "loads and renders status [%s, %s] as %s through registered hooks",
  async (format, direction, expected) => {
    const dir = await mkdtemp(join(tmpdir(), "pi-cpt-status-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", dir);
    try {
      const value = { provider: "deepseek", model: "deepseek-flash", status: [format, direction] };
      expect((await Effect.runPromise(decodeConfig(JSON.stringify(value)))).status).toEqual(
        value.status,
      );
      await writeFile(join(dir, "pi-cpt.json"), JSON.stringify(value));
      const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
      piCpt({
        registerCommand: vi.fn(),
        on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
          handlers.set(name, handler);
          return () => {};
        },
      } as unknown as ExtensionAPI);
      const setStatus = vi.fn();
      const ctx = {
        mode: "tui",
        hasUI: true,
        ui: { theme, setStatus, notify: vi.fn() },
        getContextUsage: () => ({ tokens: 37000, percent: 37, contextWindow: 100000 }),
      } as unknown as ExtensionContext;
      await handlers.get("session_start")!({}, ctx);
      expect(setStatus).toHaveBeenLastCalledWith("pi-cpt", `cpt · ${expected} · deepseek-flash`);
    } finally {
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("rejects malformed status tuples", async () => {
  for (const status of [
    null,
    "percent",
    [],
    ["percent"],
    ["used", "percent"],
    ["percent", "remaining"],
    ["tokens", "used"],
    ["number", "left", "extra"],
  ]) {
    const result = decodeConfig(JSON.stringify({ provider: "test", model: "summary", status }));
    expect(await Effect.runPromise(Effect.isFailure(result))).toBe(true);
  }
});

test("preserves unknown usage and handles empty, full, and overflowing context", () => {
  for (const [format, direction] of modes) {
    const status: Config["status"] = [format, direction];
    for (const usage of [undefined, { tokens: null, percent: null, contextWindow: 100000 }]) {
      expect(formatStatus(usage, "idle", "summary", theme, status)).toBe("cpt · ? · summary");
    }
    for (const tokens of [0, 100000, 120000]) {
      const usage = { tokens, percent: tokens / 1000, contextWindow: 100000 };
      const number = direction === "used" ? tokens : Math.max(0, 100000 - tokens);
      const expected =
        format === "percent" ? `${number / 1000}%` : number === 0 ? "0" : `${number / 1000}k`;
      expect(formatStatus(usage, "idle", "summary", theme, status)).toBe(
        `cpt · ${expected} · summary`,
      );
    }
  }
});

test("formats token counts compactly and computes remaining values before rounding", () => {
  expect(
    formatStatus(
      { tokens: 12345, percent: 12.345, contextWindow: 100000 },
      "idle",
      "summary",
      theme,
      ["number", "used"],
    ),
  ).toBe("cpt · 12.3k · summary");
  expect(
    formatStatus({ tokens: 37, percent: 37, contextWindow: 100 }, "idle", "summary", theme, [
      "number",
      "left",
    ]),
  ).toBe("cpt · 63 · summary");
  expect(
    formatStatus({ tokens: 37.6, percent: 37.6, contextWindow: 100 }, "idle", "summary", theme, [
      "percent",
      "left",
    ]),
  ).toBe("cpt · 62% · summary");
});
