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
  jsx: "preserve", // SolidJS JSX の変換を @opentui/solid ランタイムに委ねる
  target: "esnext",
  outDir: "dist",
});
