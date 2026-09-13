import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.tsx"],
  format: ["esm"],
  splitting: false,
  clean: true,
  // OpenCode ランタイムが注入するので外部化（バンドルしない）
  external: [
    "@opentui/solid",
    "solid-js",
    "solid-js/store",
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
  outDir: ".tsup-out",
});
