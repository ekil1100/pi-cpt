import { Type, type TextContent } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vite-plus/test";
import { conversation, createHost, reply, summary } from "./host.ts";

const text = (value: string): TextContent[] => [{ type: "text", text: value }];

test("registered hooks preserve files and usage through dedicated -> default fallback -> dedicated", async () => {
  const preparations: SessionBeforeCompactEvent["preparation"][] = [];
  const host = await createHost((pi) => {
    pi.on("session_before_compact", (event) => {
      preparations.push(structuredClone(event.preparation));
    });
  });
  try {
    const { manager, session } = host;
    const appendBatch = (operations: [string, string][]) => {
      manager.appendMessage({ role: "user", content: "Perform file operations", timestamp: 1 });
      const calls = operations.map(([name, path], index) => ({
        type: "toolCall" as const,
        id: `call-${manager.getLeafId()}-${index}`,
        name,
        arguments: { path },
      }));
      manager.appendMessage(reply(conversation, calls, 1000));
      for (const call of calls) {
        manager.appendMessage({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: text("Offline file operation completed"),
          isError: false,
          timestamp: 1,
        });
      }
      // A final user boundary makes Pi retain only this message (no split summary).
      return manager.appendMessage({ role: "user", content: "Keep working", timestamp: 2 });
    };
    const compact = async (marker: string, totalTokens: number, fallback = false) => {
      const successful = reply(fallback ? conversation : summary, text(marker), totalTokens);
      if (fallback) {
        host.replies.push({
          ...reply(summary, [], 999),
          stopReason: "error",
          errorMessage: "Offline dedicated failure",
        });
      }
      host.replies.push(successful);
      const before = session.getSessionStats();
      const result = await session.compact("Preserve file history");
      const entry = manager.getBranch().at(-1);
      expect(entry?.type).toBe("compaction");
      if (entry?.type !== "compaction") throw new Error("Missing persisted compaction");
      expect(entry).toMatchObject({
        summary: result.summary,
        firstKeptEntryId: result.firstKeptEntryId,
        tokensBefore: result.tokensBefore,
        fromHook: !fallback,
        usage: successful.usage,
      });
      expect(entry.summary).toContain(marker);
      expect(result.usage).toEqual(successful.usage);
      expect(session.getSessionStats().tokens.total - before.tokens.total).toBe(totalTokens);
      expect(session.getSessionStats().cost - before.cost).toBeCloseTo(0.3);
      expect(host.status()).toBe("cpt · ? · summary");
      expect(session.model).toEqual(conversation);
      return entry;
    };

    const firstKept = appendBatch([
      ["read", "kept-read.ts"],
      ["read", "promoted.ts"],
      ["write", "old-write.ts"],
    ]);
    const first = await compact("Dedicated checkpoint one", 120);
    expect(first.firstKeptEntryId).toBe(firstKept);
    expect(first.details).toEqual({
      owner: "pi-cpt",
      version: 1,
      readFiles: ["kept-read.ts", "promoted.ts"],
      modifiedFiles: ["old-write.ts"],
    });

    const secondKept = appendBatch([
      ["read", "new-read.ts"],
      ["read", "old-write.ts"],
      ["edit", "promoted.ts"],
    ]);
    const second = await compact("Default fallback checkpoint", 240, true);
    expect(second.firstKeptEntryId).toBe(secondKept);
    expect(second.details).toEqual({
      readFiles: ["kept-read.ts", "new-read.ts"],
      modifiedFiles: ["old-write.ts", "promoted.ts"],
    });
    // The old read survives solely through the registered restoration hook:
    // its original tool call has already left the real host's summary input.
    expect(JSON.stringify(preparations[1].messagesToSummarize)).not.toContain("kept-read.ts");
    expect(preparations[1].fileOps.read.has("kept-read.ts")).toBe(true);
    expect(preparations[1].previousSummary).toBe(first.summary);
    expect(host.ui.notify).toHaveBeenCalledExactlyOnceWith(
      "pi-cpt: dedicated model failed; falling back to Pi default compaction.",
      "warning",
    );
    expect(
      host.ui.setStatus.mock.calls.some(([, status]) => status?.includes("default fallback")),
    ).toBe(true);

    const thirdKept = appendBatch([
      ["read", "latest.ts"],
      ["read", "promoted.ts"],
      ["write", "new-read.ts"],
      ["write", "newest.ts"],
    ]);
    const third = await compact("Dedicated checkpoint three", 360);
    expect(third.firstKeptEntryId).toBe(thirdKept);
    expect(third.details).toEqual({
      owner: "pi-cpt",
      version: 1,
      readFiles: ["kept-read.ts", "latest.ts"],
      modifiedFiles: ["new-read.ts", "newest.ts", "old-write.ts", "promoted.ts"],
    });
    expect(preparations[2].previousSummary).toBe(second.summary);
    expect(session.getSessionStats().tokens.total).toBe(3720);
    expect(session.getSessionStats().cost).toBeCloseTo(1.8);
    expect(host.requests.map(({ model }) => model.id)).toEqual([
      "summary",
      "summary",
      "conversation",
      "summary",
    ]);
    expect(manager.getBranch().filter((entry) => entry.type === "compaction")).toEqual([
      first,
      second,
      third,
    ]);
    expect(host.replies).toHaveLength(0);
    expect(host.errors).toEqual([]);
    expect(host.fetch).not.toHaveBeenCalled();
  } finally {
    await host.close();
  }
});

test("real session refreshes status after assistant/tool persistence, before tools and the next turn", async () => {
  type Snapshot = {
    event: string;
    status: string | undefined;
    tokens: number | null | undefined;
    roles: string[];
    persisted?: boolean;
  };
  const snapshots: Snapshot[] = [];
  const capture = (event: string, ctx: ExtensionContext, message?: unknown) => {
    const entries = ctx.sessionManager.getBranch().filter((entry) => entry.type === "message");
    snapshots.push({
      event,
      status: host.status(),
      tokens: ctx.getContextUsage()?.tokens,
      roles: entries.map((entry) => entry.message.role),
      ...(message ? { persisted: entries.some((entry) => entry.message === message) } : {}),
    });
  };
  const host = await createHost((pi) => {
    pi.registerTool({
      name: "offline_probe",
      label: "Offline probe",
      description: "Return a large deterministic tool result",
      parameters: Type.Object({}),
      execute: async (_id, _params, _signal, _onUpdate, ctx) => {
        capture("tool:execute", ctx);
        return { content: text("x".repeat(8000)), details: {} };
      },
    });
    pi.on("message_end", (event, ctx) => {
      if (event.message.role === "assistant" || event.message.role === "toolResult") {
        capture(`message_end:${event.message.role}`, ctx, event.message);
      }
    });
    pi.on("tool_execution_start", (_event, ctx) => capture("tool_execution_start", ctx));
    pi.on("tool_execution_end", (_event, ctx) => capture("tool_execution_end", ctx));
    pi.on("turn_end", (event, ctx) => capture(`turn_end:${event.turnIndex}`, ctx, event.message));
    pi.on("turn_start", (event, ctx) => capture(`turn_start:${event.turnIndex}`, ctx));
    pi.on("agent_end", (_event, ctx) => capture("agent_end", ctx));
  });
  try {
    // Start with genuine compaction so usage is unknown until an assistant is persisted.
    host.manager.appendMessage({ role: "user", content: "Old task", timestamp: 0 });
    host.manager.appendMessage(reply(conversation, text("Old response"), 40000));
    host.manager.appendMessage({ role: "user", content: "Retained task", timestamp: 1 });
    host.replies.push(reply(summary, text("Earlier checkpoint"), 120));
    await host.session.compact();
    expect(host.status()).toBe("cpt · ? · summary");
    host.replies.push(
      reply(
        conversation,
        [{ type: "toolCall", id: "probe", name: "offline_probe", arguments: {} }],
        12000,
      ),
      reply(conversation, text("Finished"), 22000),
    );
    await host.session.prompt("Run the offline probe");
    expect(host.errors).toEqual([]);
    expect(snapshots.map(({ event }) => event)).toEqual([
      "turn_start:0",
      "message_end:assistant",
      "tool_execution_start",
      "tool:execute",
      "tool_execution_end",
      "message_end:toolResult",
      "turn_end:0",
      "turn_start:1",
      "message_end:assistant",
      "turn_end:1",
      "agent_end",
    ]);
    expect(snapshots[1]).toMatchObject({
      persisted: false,
      tokens: null,
      status: "cpt · ? · summary",
    });
    for (const index of [2, 3, 4, 5]) {
      expect(snapshots[index]).toMatchObject({ tokens: 12000, status: "cpt · 12% · summary" });
      expect(snapshots[index].roles.at(-1)).toBe("assistant");
    }
    expect(snapshots[5].persisted).toBe(false);
    for (const index of [6, 7, 8]) {
      expect(snapshots[index]).toMatchObject({ tokens: 14000, status: "cpt · 14% · summary" });
      expect(snapshots[index].roles.at(-1)).toBe("toolResult");
    }
    expect(snapshots[6].persisted).toBe(true);
    expect(snapshots[8].persisted).toBe(false);
    expect(snapshots[9]).toMatchObject({
      persisted: true,
      tokens: 22000,
      status: "cpt · 22% · summary",
    });
    expect(snapshots[10].status).toBe("cpt · 22% · summary");
    expect(host.replies).toHaveLength(0);
    expect(host.fetch).not.toHaveBeenCalled();
  } finally {
    await host.close();
  }
});
