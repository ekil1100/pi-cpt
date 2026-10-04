import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai/compat";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import piCpt from "../src/index.ts";
import { compactWithModel, restoreFiles } from "../src/compaction.ts";
import { decodeConfig, loadConfig } from "../src/config.ts";
import { formatStatus } from "../src/status.ts";

const config = {
  provider: "test",
  model: "summary",
  thinkingLevel: "low",
  showStatus: true,
  status: ["percent", "used"],
} as const;
const model: Model<"openai-completions"> = {
  id: "summary",
  name: "Summary",
  api: "openai-completions",
  provider: "test",
  baseUrl: "https://example.invalid",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 8192,
};
const response = (): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text: "## Goal\nKeep working" }],
  api: "openai-completions",
  provider: "test",
  model: "summary",
  stopReason: "stop",
  timestamp: 0,
  usage: {
    input: 100,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 120,
    cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
  },
});
const event = (signal = new AbortController().signal): SessionBeforeCompactEvent => ({
  type: "session_before_compact",
  reason: "manual",
  willRetry: false,
  signal,
  branchEntries: [],
  customInstructions: "Preserve decisions",
  preparation: {
    firstKeptEntryId: "keep",
    messagesToSummarize: [{ role: "user", content: "Build it", timestamp: 0 }],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 40000,
    fileOps: { read: new Set(["current.ts"]), edited: new Set(), written: new Set() },
    settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
  },
});
const fixture = (reply = response()) => {
  const streamSimple = vi.fn(() => ({ result: () => Promise.resolve(reply) }));
  const ctx = {
    mode: "tui",
    hasUI: true,
    modelRegistry: { find: vi.fn(() => model), streamSimple },
    getContextUsage: () => ({ tokens: 10000, contextWindow: 100000, percent: 10 }),
    ui: {
      setStatus: vi.fn(),
      notify: vi.fn(),
      theme: { fg: vi.fn((_color: string, text: string) => text) },
    },
  };
  return { ctx: ctx as unknown as ExtensionContext, raw: ctx, streamSimple };
};
const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const temp = async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cpt-test-"));
  dirs.push(dir);
  return dir;
};

describe("configuration", () => {
  test("validates strictly and defaults thinking to off", async () => {
    expect(await Effect.runPromise(decodeConfig('{"provider":"test","model":"summary"}'))).toEqual({
      ...config,
      thinkingLevel: "off",
    });
    for (const value of [
      "{}",
      "{",
      '{"provider":" ","model":"x"}',
      JSON.stringify({ ...config, extra: true }),
      JSON.stringify({ ...config, thinkingLevel: "invalid" }),
    ]) {
      expect(await Effect.runPromise(Effect.isFailure(decodeConfig(value)))).toBe(true);
    }
  });
  test("missing file is disabled; malformed and unreadable files fail", async () => {
    const dir = await temp();
    expect(await Effect.runPromise(loadConfig(join(dir, "missing")))).toBeUndefined();
    await writeFile(join(dir, "bad"), "{");
    expect(await Effect.runPromise(Effect.isFailure(loadConfig(join(dir, "bad"))))).toBe(true);
    expect(await Effect.runPromise(Effect.isFailure(loadConfig(dir)))).toBe(true);
  });
});

describe("native compaction", () => {
  test("preserves instructions, boundaries, usage, thinking and registry routing", async () => {
    const { ctx, streamSimple } = fixture();
    const input = event();
    const result = await Effect.runPromise(compactWithModel(input, ctx, config));
    expect(result.compaction).toMatchObject({
      firstKeptEntryId: "keep",
      tokensBefore: 40000,
      usage: response().usage,
      details: { owner: "pi-cpt", version: 1, readFiles: ["current.ts"] },
    });
    const call = streamSimple.mock.calls[0] as unknown as [
      unknown,
      unknown,
      Record<string, unknown>,
    ];
    expect(call[0]).toBe(model);
    expect(JSON.stringify(call[1])).toContain("Preserve decisions");
    expect(call[2]).toMatchObject({
      reasoning: "low",
      signal: input.signal,
      cacheRetention: "none",
      maxTokens: 8192,
    });
  });
  test("split turns aggregate usage", async () => {
    const { ctx, streamSimple } = fixture();
    const input = event();
    input.preparation.isSplitTurn = true;
    input.preparation.turnPrefixMessages = [{ role: "user", content: "Continue", timestamp: 1 }];
    const result = await Effect.runPromise(compactWithModel(input, ctx, config));
    expect(streamSimple).toHaveBeenCalledTimes(2);
    expect(result.compaction?.usage?.totalTokens).toBe(240);
  });
  test.each(["length", "error", "aborted"] as const)("rejects %s responses", async (stopReason) => {
    const { ctx } = fixture({ ...response(), stopReason });
    expect(await Effect.runPromise(Effect.isFailure(compactWithModel(event(), ctx, config)))).toBe(
      true,
    );
  });
  test("missing models and tool-call summaries fail safely", async () => {
    const missing = fixture();
    vi.spyOn(missing.ctx.modelRegistry, "find").mockReturnValue(undefined);
    expect(
      await Effect.runPromise(Effect.isFailure(compactWithModel(event(), missing.ctx, config))),
    ).toBe(true);
    expect(missing.streamSimple).not.toHaveBeenCalled();
    const reply = response();
    reply.content.push({ type: "toolCall", id: "call", name: "read", arguments: {} });
    const { ctx } = fixture(reply);
    expect(await Effect.runPromise(Effect.isFailure(compactWithModel(event(), ctx, config)))).toBe(
      true,
    );
  });
  test("rejects empty text even when files could mask it", async () => {
    const { ctx } = fixture({ ...response(), content: [{ type: "text", text: " " }] });
    expect(await Effect.runPromise(Effect.isFailure(compactWithModel(event(), ctx, config)))).toBe(
      true,
    );
  });
  test("honors cancellation before and after the request", async () => {
    const controller = new AbortController();
    const { ctx, streamSimple } = fixture();
    controller.abort();
    expect(
      await Effect.runPromise(compactWithModel(event(controller.signal), ctx, config)),
    ).toEqual({ cancel: true });
    expect(streamSimple).not.toHaveBeenCalled();
    const active = new AbortController();
    streamSimple.mockImplementation(() => ({
      result: () => {
        active.abort();
        return Promise.resolve(response());
      },
    }));
    expect(await Effect.runPromise(compactWithModel(event(active.signal), ctx, config))).toEqual({
      cancel: true,
    });
  });
  test("restores only the latest owned compaction's file lists", async () => {
    const { ctx } = fixture();
    const first = await Effect.runPromise(compactWithModel(event(), ctx, config));
    const second = event();
    second.preparation.fileOps.read.clear();
    second.branchEntries.push({
      ...first.compaction!,
      type: "compaction",
      id: "previous",
      parentId: null,
      timestamp: "",
      fromHook: true,
    });
    restoreFiles(second);
    const result = await Effect.runPromise(compactWithModel(second, ctx, config));
    expect(result.compaction?.details).toMatchObject({ readFiles: ["current.ts"] });
    second.branchEntries.push({
      ...first.compaction!,
      type: "compaction",
      id: "foreign",
      parentId: "previous",
      timestamp: "",
      fromHook: true,
      details: { owner: "other" },
    });
    second.preparation.fileOps.read.clear();
    restoreFiles(second);
    expect(second.preparation.fileOps.read.size).toBe(0);
  });
});

test("status uses accent for cpt and dim for percentage, model, and activity", () => {
  const fg = vi.fn((color: string, text: string) => `<${color}>${text}</${color}>`);
  expect(
    formatStatus(
      { tokens: 37000, percent: 37, contextWindow: 100000 },
      "idle",
      "deepseek-flash",
      { fg },
      config.status,
    ),
  ).toBe("<accent>cpt</accent><dim> · 37% · deepseek-flash</dim>");
  expect(fg.mock.calls).toEqual([
    ["accent", "cpt"],
    ["dim", " · 37% · deepseek-flash"],
  ]);
  expect(formatStatus(undefined, "idle", "summary", { fg }, config.status)).toBe(
    "<accent>cpt</accent><dim> · ? · summary</dim>",
  );
  expect(
    formatStatus(
      { tokens: null, percent: null, contextWindow: 100000 },
      "idle",
      "summary",
      { fg },
      config.status,
    ),
  ).toBe("<accent>cpt</accent><dim> · ? · summary</dim>");
  for (const [phase, suffix] of [
    ["compacting", "compacting"],
    ["fallback", "default fallback"],
  ] as const) {
    expect(
      formatStatus(
        { tokens: 0, percent: 0, contextWindow: 100000 },
        phase,
        "summary",
        { fg },
        config.status,
      ),
    ).toBe(`<accent>cpt</accent><dim> · 0% · summary · ${suffix}</dim>`);
  }
});

test("registered hooks fall back on failure, cancel without fallback and clear terminal status", async () => {
  const dir = await temp();
  vi.stubEnv("PI_CODING_AGENT_DIR", dir);
  await writeFile(join(dir, "pi-cpt.json"), JSON.stringify(config));
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  piCpt({
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
      handlers.set(name, handler);
      return () => {};
    },
  } as unknown as ExtensionAPI);
  const { ctx, raw, streamSimple } = fixture();
  await handlers.get("session_start")!({}, ctx);
  streamSimple.mockImplementation(() => {
    throw new Error("SECRET provider failure");
  });
  expect(await handlers.get("session_before_compact")!(event(), ctx)).toBeUndefined();
  expect(raw.ui.notify).toHaveBeenCalledWith(expect.stringContaining("falling back"), "warning");
  expect(JSON.stringify(raw.ui.notify.mock.calls)).not.toContain("SECRET");
  for (const terminal of ["session_compact", "session_compact_failed"]) {
    await handlers.get(terminal)!({}, ctx);
    expect(raw.ui.setStatus).toHaveBeenLastCalledWith("pi-cpt", "cpt · 10% · summary");
    expect(raw.ui.theme.fg).toHaveBeenCalledWith("accent", "cpt");
    expect(raw.ui.theme.fg).toHaveBeenLastCalledWith("dim", " · 10% · summary");
  }
  const controller = new AbortController();
  controller.abort();
  raw.ui.notify.mockClear();
  expect(await handlers.get("session_before_compact")!(event(controller.signal), ctx)).toEqual({
    cancel: true,
  });
  expect(raw.ui.notify).not.toHaveBeenCalled();
  const interrupted = new AbortController();
  streamSimple.mockImplementation(() => {
    interrupted.abort();
    throw new Error("Aborted request");
  });
  expect(await handlers.get("session_before_compact")!(event(interrupted.signal), ctx)).toEqual({
    cancel: true,
  });
  expect(raw.ui.notify).not.toHaveBeenCalled();
  await handlers.get("session_compact_failed")!({}, ctx);
  await handlers.get("session_shutdown")!({}, ctx);
  expect(raw.ui.setStatus).toHaveBeenLastCalledWith("pi-cpt", undefined);
});
