import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vite-plus/test";
import piCpt from "../src/index.ts";

test.each(["missing", "invalid", "headless"])(
  "handles %s configuration/UI lifecycle",
  async (scenario) => {
    const dir = await mkdtemp(join(tmpdir(), "pi-cpt-lifecycle-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", dir);
    try {
      if (scenario !== "missing") {
        await writeFile(
          join(dir, "pi-cpt.json"),
          scenario === "invalid" ? "{" : JSON.stringify({ provider: "test", model: "summary" }),
        );
      }
      const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
      piCpt({
        on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
          handlers.set(name, handler);
          return () => {};
        },
      } as unknown as ExtensionAPI);
      const ui = { setStatus: vi.fn(), notify: vi.fn() };
      const ctx = {
        mode: scenario === "headless" ? "print" : "tui",
        hasUI: scenario !== "headless",
        ui,
        getContextUsage: () => undefined,
      } as unknown as ExtensionContext;
      await handlers.get("session_start")!({}, ctx);
      if (scenario === "headless") {
        await handlers.get("agent_end")!({}, ctx);
        await handlers.get("session_shutdown")!({}, ctx);
        expect(ui.setStatus).not.toHaveBeenCalled();
        expect(ui.notify).not.toHaveBeenCalled();
      } else {
        expect(ui.setStatus).toHaveBeenLastCalledWith("pi-cpt", undefined);
        expect(ui.notify).toHaveBeenCalledTimes(scenario === "invalid" ? 1 : 0);
        expect(
          await handlers.get("session_before_compact")!(
            { branchEntries: [], signal: new AbortController().signal },
            ctx,
          ),
        ).toBeUndefined();
      }
    } finally {
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
