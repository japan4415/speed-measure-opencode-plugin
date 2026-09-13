import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.tsx"],
  format: ["esm"],
  // OpenCode ランタイムが注入するので外部化（バンドルしない）
  external: [
    "@opentui/solid",
    "@opentui/solid/store",
    "@opentui/solid/jsx-runtime",
    "solid-js",
    "@opencode-ai/plugin",
    "@opencode-ai/sdk",
  ],
  esbuildOptions(options) {
    options.jsx = "automatic";
    options.jsxImportSource = "@opentui/solid";
  },
  target: "esnext",
  outDir: "dist",
});

