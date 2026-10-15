import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: { generator: "tsgo" },
    deps: { neverBundle: ["effect", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"] },
  },
  lint: { options: { typeAware: true, typeCheck: true } },
  fmt: {},
});
