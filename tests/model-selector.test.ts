import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vite-plus/test";
import { selectModel } from "../src/model-selector.ts";

test("model picker searches, selects and cancels", async () => {
  let component: {
    handleInput(data: string): void;
    render(width: number): string[];
    focused: boolean;
  };
  const ctx = {
    modelRegistry: {
      getAvailable: () => [
        { provider: "one", id: "alpha", name: "Alpha" },
        { provider: "two", id: "beta", name: "Beta" },
      ],
    },
    ui: {
      custom: (factory: (...args: any[]) => typeof component) =>
        new Promise((done) => {
          component = factory(
            { requestRender: vi.fn(), terminal: { rows: 24 } },
            { fg: (_color: string, text: string) => text },
            { matches: (data: string, key: string) => data === key },
            done,
          );
        }),
    },
  } as unknown as ExtensionContext;
  const selected = selectModel(ctx);
  component!.focused = true;
  expect(component!.focused).toBe(true);
  component!.handleInput("beta");
  expect(component!.render(40).join("\n")).toContain("beta");
  component!.handleInput("tui.select.confirm");
  expect(await selected).toEqual({ provider: "two", id: "beta" });
  const cancelled = selectModel(ctx);
  component!.handleInput("tui.select.cancel");
  expect(await cancelled).toBeUndefined();
});

test("model picker bounds long rows and keeps selection visible after resize and navigation", async () => {
  let component: {
    handleInput(data: string): void;
    render(width: number): string[];
  };
  const terminal = { rows: 24 };
  const models = Array.from({ length: 10 }, (_, index) => ({
    provider: "provider-with-a-long-name",
    id: `model-${index}-${"long-模型-identifier-".repeat(4)}`,
    name: `Model ${index}`,
  }));
  const ctx = {
    modelRegistry: { getAvailable: () => models },
    ui: {
      custom: (factory: (...args: any[]) => typeof component) =>
        new Promise((done) => {
          component = factory(
            { requestRender: vi.fn(), terminal },
            { fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[0m` },
            { matches: (data: string, key: string) => data === key },
            done,
          );
        }),
    },
  } as unknown as ExtensionContext;
  const selected = selectModel(ctx);
  const checkViewport = (index: number, width = 38) => {
    const lines = component!.render(width);
    expect(lines.length).toBeLessThanOrEqual(terminal.rows - 3);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    expect(lines[0]).toContain("Compact");
    expect(lines[1]).toContain(">");
    expect(lines.at(-1)).toContain("Search");
    expect(lines.filter((line) => line.includes("→"))).toHaveLength(1);
    expect(lines.find((line) => line.includes("→"))).toContain(`model-${index}`);
    return lines;
  };
  expect(checkViewport(0)).toHaveLength(13);
  for (let index = 1; index < 10; index++) {
    component!.handleInput("tui.select.down");
    checkViewport(index);
  }
  terminal.rows = 10;
  expect(checkViewport(9)).toHaveLength(7);
  component!.handleInput("tui.select.down");
  checkViewport(0);
  component!.handleInput("tui.select.up");
  checkViewport(9);
  for (let index = 8; index >= 0; index--) {
    component!.handleInput("tui.select.up");
    checkViewport(index);
  }
  terminal.rows = 7;
  expect(checkViewport(0, 12)).toHaveLength(4);
  terminal.rows = 24;
  expect(checkViewport(0)).toHaveLength(13);
  component!.handleInput("tui.select.confirm");
  expect(await selected).toEqual({ provider: models[0]!.provider, id: models[0]!.id });

  const cancelled = selectModel(ctx);
  component!.handleInput("no-matching-model");
  const emptyLines = component!.render(38);
  expect(emptyLines).toHaveLength(4);
  expect(emptyLines[2]).toContain("No matching models.");
  for (const line of emptyLines) expect(visibleWidth(line)).toBeLessThanOrEqual(38);
  component!.handleInput("tui.select.cancel");
  expect(await cancelled).toBeUndefined();
});
