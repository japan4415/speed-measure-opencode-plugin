import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.tsx"],
  format: ["esm"],
  // OpenCode ランタイムが注入するので外部化（バンドルしない）
  external: [
    "@opentui/solid",
    "@opentui/solid/store",
    "solid-js",
    "@opencode-ai/plugin",
    "@opencode-ai/sdk",
  ],
  esbuildOptions(options) {
    // Babel's Solid universal transform runs after bundling. Keeping JSX here
    // prevents esbuild from eagerly evaluating signal reads in JSX props.
    options.jsx = "preserve";
    options.logOverride = {
      ...options.logOverride,
      "unsupported-jsx-comment": "silent",
    };
  },
  target: "esnext",
  outDir: "dist",
});
