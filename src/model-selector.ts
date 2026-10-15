import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Input, TruncatedText, fuzzyFilter } from "@earendil-works/pi-tui";

export const selectModel = async (
  ctx: ExtensionContext,
  current?: { provider: string; model: string },
) => {
  const models = ctx.modelRegistry
    .getAvailable()
    .map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
    }))
    .sort(
      (a, b) =>
        Number(b.provider === current?.provider && b.id === current.model) -
          Number(a.provider === current?.provider && a.id === current.model) ||
        a.provider.localeCompare(b.provider),
    );
  return ctx.ui.custom<{ provider: string; id: string } | undefined>((tui, theme, keys, done) => {
    const input = new Input();
    let filtered = models;
    let selected = 0;
    return new (class extends Container {
      get focused() {
        return input.focused;
      }
      set focused(value: boolean) {
        input.focused = value;
      }
      handleInput(data: string) {
        if (keys.matches(data, "tui.select.cancel")) {
          done(undefined);
          return;
        }
        if (keys.matches(data, "tui.select.confirm")) {
          const model = filtered[selected];
          if (model) done({ provider: model.provider, id: model.id });
          return;
        }
        if (keys.matches(data, "tui.select.up"))
          selected = (selected + filtered.length - 1) % Math.max(1, filtered.length);
        else if (keys.matches(data, "tui.select.down"))
          selected = (selected + 1) % Math.max(1, filtered.length);
        else {
          input.handleInput(data);
          filtered = fuzzyFilter(
            models,
            input.getValue(),
            (model) => `${model.provider}/${model.id} ${model.name}`,
          );
          selected = 0;
        }
        tui.requestRender();
      }
      render(width: number) {
        this.clear();
        this.addChild(new TruncatedText(theme.fg("accent", "Compaction model"), 0, 0));
        this.addChild(input);
        // Reserve three rows for title/input/hint and three for Pi's footer.
        const visibleRows = Math.max(1, Math.min(10, tui.terminal.rows - 6));
        const start = Math.max(
          0,
          Math.min(selected - Math.floor(visibleRows / 2), filtered.length - visibleRows),
        );
        for (const [index, model] of filtered.slice(start, start + visibleRows).entries()) {
          const active = start + index === selected;
          this.addChild(
            new TruncatedText(
              theme.fg(
                active ? "accent" : "text",
                stripVTControlCharacters(
                  `${active ? "→" : " "} ${model.id} [${model.provider}]`,
                  // Model identifiers can contain terminal control characters.
                  // eslint-disable-next-line no-control-regex
                ).replace(/[\u0000-\u001f\u007f-\u009f]/g, " "),
              ),
              0,
              0,
            ),
          );
        }
        if (!filtered.length)
          this.addChild(
            new TruncatedText("No matching models. Use /login to configure providers.", 0, 0),
          );
        this.addChild(
          new TruncatedText(
            theme.fg("dim", "Search models · Select to save · Cancel to keep current model"),
            0,
            0,
          ),
        );
        return super.render(width);
      }
    })();
  });
};
