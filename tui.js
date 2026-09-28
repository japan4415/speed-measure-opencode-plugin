/**
 * Literal TUI entrypoint for OpenCode v2 local plugin loading.
 *
 * OpenCode v2 resolves a local plugin directory as `<plugin dir>/tui`
 * (Bun.resolveSync on the literal path), so the package `exports` map alone
 * is not enough for local directory installs. This shim re-exports the
 * prebuilt bundle; npm installs resolve through `exports["./tui"]` instead
 * and do not use this file.
 */
export * from "./dist/index.js";
export { default } from "./dist/index.js";
