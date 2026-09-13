# OpenCode Speed-Measure Plugin: Research Findings

**Date**: 2026-09-14  
**Repo examined**: `anomalyco/opencode` (latest: v1.18.30)  
**Spec file**: `packages/opencode/specs/tui-plugins.md` (verified)  
**Plugin types**: `packages/plugin/src/tui.ts` (verified)  
**Built-in sidebar**: `packages/tui/src/feature-plugins/sidebar/context.tsx` (verified)

---

## 1. Plugin Registration Mechanism

### Config Files

**`tui.json` / `tui.jsonc`** (in `~/.config/opencode/` or `.opencode/`) is the TUI-specific config.

Example (verified from spec):
```json
{
  "$schema": "https://opencode.ai/tui.json",
  "theme": "smoke-theme",
  "leader_timeout": 2000,
  "keybinds": { "leader": "ctrl+x" },
  "plugin": [
    "@acme/opencode-plugin@1.2.3",
    ["./plugins/demo.tsx", { "label": "demo" }]
  ],
  "plugin_enabled": { "acme.demo": false }
}
```

Key rules (from spec):
- `plugin` entries: string spec OR `[spec, options]` tuple
- Specs can be: npm specs, `file://` URLs, relative paths, absolute paths
- Relative paths resolved relative to the config file
- A **file module** in `tui.json` must be a TUI module (`default export { id?, tui }`) and must NOT export `server`
- Duplicate npm plugins deduped by package name; duplicate file plugins deduped by resolved path
- `plugin_enabled` keyed by plugin id (not spec)

### Directory-Based Loading

- **Project-level server plugins**: `.opencode/plugins/` (auto-loaded — for **server** plugins only)
- **Global server plugins**: `~/.config/opencode/plugins/` (auto-loaded — for **server** plugins only)
- **TUI plugins**: must be explicitly listed in `tui.json`; **no directory auto-discovery**

### `opencode.json` `plugin` Array

Used for **server-side** plugins (not TUI plugins). TUI plugins live in `tui.json`.

### Install Command

```bash
opencode plugin @foo/opencode-plugin --global   # installs to global config
opencode plugin ./my-plugin.tsx                  # installs to local .opencode
```

Or alias `opencode plug`. Install writes to `opencode.json` (server target) and/or `tui.json` (TUI target), depending on `package.json` exports.

---

## 2. TUI Plugin API

### Module Shape (verified from spec + `packages/plugin/src/tui.ts`)

```tsx
/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

const tui: TuiPlugin = async (api, options, meta) => {
  // api is TuiPluginApi
  // options is PluginOptions | undefined (from tui.json tuple second element)
  // meta is TuiPluginMeta (state: "first"|"updated"|"same", id, source, etc.)
}

const plugin: TuiPluginModule & { id: string } = {
  id: "myplugin.id",
  tui,
}
export default plugin
```

### `TuiPluginApi` — Complete Type (verified from `packages/plugin/src/tui.ts`)

```typescript
type TuiPluginApi = {
  app: { readonly version: string }
  attention: TuiAttention                    // notify, soundboard
  command?: TuiCommandApi                    // DEPRECATED — was removed in v1.14.42
  keys: TuiKeys                              // formatSequence, formatBindings
  keymap: TuiKeymap                          // registerLayer({ commands, bindings })
  mode: { current(): string; push(mode: string): () => void }
  route: {
    register(routes: TuiRouteDefinition[]): () => void
    navigate(name: string, params?: Record<string, unknown>): void
    readonly current: TuiRouteCurrent
  }
  ui: {
    Dialog, DialogAlert, DialogConfirm, DialogPrompt, DialogSelect
    Slot: <Name extends string>(props: TuiSlotProps<Name>) => JSX.Element | null
    Prompt: (props: TuiPromptProps) => JSX.Element
    toast: (input: TuiToast) => void
    dialog: TuiDialogStack
  }
  readonly tuiConfig: Frozen<TuiConfigView>
  kv: { get, set, readonly ready }           // shared KV store (state/kv.json), NOT namespaced
  state: TuiState                            // live synced state
  theme: TuiTheme                            // .current (token object), .selected, .set, .mode(), etc.
  client: OpencodeClient                     // always reflects current runtime client
  event: TuiEventBus                         // api.event.on(type, handler) => unsubscribe fn
  renderer: CliRenderer
  slots: TuiSlots                            // api.slots.register(plugin) => host-assigned id
  plugins: { list, activate, deactivate, add, install }
  lifecycle: { readonly signal: AbortSignal; onDispose(fn): () => void }
}
```

### `api.state` (TuiState) — Key Fields

```typescript
type TuiState = {
  readonly ready: boolean
  readonly config: SdkConfig
  readonly provider: ReadonlyArray<Provider>
  readonly path: { state, config, worktree, directory }
  readonly vcs?: { branch?, default_branch? }
  session: {
    count(): number
    get(sessionID): Session | undefined
    diff(sessionID): ReadonlyArray<TuiSidebarFileItem>
    todo(sessionID): ReadonlyArray<TuiSidebarTodoItem>
    messages(sessionID): ReadonlyArray<Message>
    status(sessionID): SessionStatus | undefined
    permission(sessionID): ReadonlyArray<PermissionRequest>
    question(sessionID): ReadonlyArray<QuestionRequest>
  }
  part(messageID): ReadonlyArray<Part>
  lsp(): ReadonlyArray<TuiSidebarLspItem>
  mcp(): ReadonlyArray<TuiSidebarMcpItem>
}
```

### `api.theme.current` (TuiThemeCurrent) — Color Tokens

Includes: `primary`, `secondary`, `accent`, `error`, `warning`, `success`, `info`, `text`, `textMuted`, `selectedListItemText`, `background`, `backgroundPanel`, `backgroundElement`, `backgroundMenu`, `border`, `borderActive`, `borderSubtle`, plus diff/markdown/syntax colors and `thinkingOpacity`.

### BREAKING CHANGE in v1.14.42

`api.command.register`, `api.command.trigger`, `api.command.show` were **silently removed** (no deprecation cycle). Now marked `@deprecated` in types with shim. Replacement:

```typescript
api.keymap.registerLayer({
  commands: [{
    name: "myplugin.show",
    title: "My Plugin",
    category: "Plugin",
    namespace: "palette",
    slashName: "myplugin",
    run() { api.route.navigate("myplugin") },
  }],
  bindings: [{ key: "ctrl+shift+m", cmd: "myplugin.show", desc: "Open my plugin" }],
})
```

---

## 3. Sidebar Slots

### Host Slot Names (verified from `packages/plugin/src/tui.ts`)

```typescript
type TuiHostSlotMap = {
  app: {}
  app_bottom: {}
  home_logo: {}
  home_prompt: { ref? }
  home_prompt_right: {}
  session_prompt: { session_id, visible?, disabled?, on_submit?, ref? }
  session_prompt_right: { session_id }
  home_bottom: {}
  home_footer: {}
  sidebar_title: { session_id, title, share_url? }
  sidebar_content: { session_id }    // ← USE THIS for speed metrics
  sidebar_footer: { session_id }
}
```

**`sidebar_content` with props `{ session_id: string }`** is the slot for the plugin to use.

### Slot Context

```typescript
type TuiSlotContext = {
  theme: TuiTheme
}
```

Note: **Slot context currently exposes only `theme`**. The full `api` object must be closed over from the `tui(api)` function scope.

### Slot Modes

- `sidebar_content` uses the **slot library default mode** (append — contributions stacked after fallback)
- `sidebar_title`, `sidebar_footer`: `single_winner` mode
- `home_logo`, `home_prompt`, `session_prompt`: `replace` mode

### Slot Registration

```typescript
api.slots.register({
  order: 150,   // insertion order; built-ins: context=100, mcp=200, lsp=300, todo=400, files=500
  slots: {
    sidebar_content(_ctx, props) {
      // props.session_id is available
      // Return a SolidJS JSX element
      return <box>...</box>
    }
  }
})
// Returns host-assigned id string (e.g. "myplugin:0")
// No unregister function returned
```

### Built-in Sidebar Plugins (verified from spec)

Internal plugin IDs and their order:
- `internal:sidebar-context` — order 100 (tokens, % context used, cost)
- `internal:sidebar-mcp` — order 200
- `internal:sidebar-lsp` — order 300
- `internal:sidebar-todo` — order 400
- `internal:sidebar-files` — order 500

The built-in context block shows: Context (bold header), token count, % used, $ spent.

### Built-in Sidebar Context Source (verified from `packages/tui/src/feature-plugins/sidebar/context.tsx`)

```tsx
// Uses api.state.session.messages(session_id) to find last assistant message
// Uses api.state.provider to look up model limits
// Displays: tokens, percent used, cost (USD)
// Token formula: input + output + reasoning + cache.read + cache.write
```

---

## 4. Events and Timing Data

### Event Bus

```typescript
api.event.on(type, handler)  // returns unsubscribe fn
```

Event type is the string union from `@opencode-ai/sdk/v2` `Event` type.

### Key Event Types for Speed Measurement (verified from `packages/sdk/js/src/v2/gen/types.gen.ts`)

**`message.part.updated`** — fires when a part is created/updated:
```typescript
{
  id: string
  type: "message.part.updated"
  properties: {
    sessionID: string
    part: Part       // includes StepStartPart and StepFinishPart
    time: number     // Unix timestamp ms
  }
}
```

**`message.part.delta`** — fires per streaming chunk:
```typescript
{
  id: string
  type: "message.part.delta"
  properties: {
    sessionID: string
    messageID: string
    partID: string
    field: string    // "text" for text content
    delta: string    // the new characters/tokens
  }
}
```

**`message.updated`** — fires when full message metadata is updated:
```typescript
{
  id: string
  type: "message.updated"
  properties: {
    sessionID: string
    info: Message    // AssistantMessage with .tokens and .time
  }
}
```

**`session.status`** — fires on session busy/idle state changes:
```typescript
// properties.status.type: "busy" | "idle"
```

### Key Part Types (verified from SDK types)

**`StepStartPart`**:
```typescript
{
  id: string
  sessionID: string
  messageID: string
  type: "step-start"
  snapshot?: string
}
```

**`StepFinishPart`** (most authoritative for tokens):
```typescript
{
  id: string
  sessionID: string
  messageID: string
  type: "step-finish"
  reason: string      // "stop" | "tool-calls"
  snapshot?: string
  cost: number
  tokens: {
    total?: number
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
}
```

**`TextPart`** (has time boundaries):
```typescript
{
  id: string
  sessionID: string
  messageID: string
  type: "text"
  text: string
  synthetic?: boolean
  time?: {
    start: number   // Unix ms — when text generation started (first token)
    end?: number    // Unix ms — when text generation ended
  }
}
```

**`AssistantMessage`** (authoritative totals):
```typescript
{
  id: string
  role: "assistant"
  time: {
    created: number      // Unix ms — message creation time (= request sent)
    completed?: number   // Unix ms — message completion time
  }
  tokens: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
  cost: number
  ...
}
```

### Timing Strategy for Prefill and Decode

**Prefill Speed (PP) = input tokens / prefill time**

- `prefillTime` = `firstTokenTime - stepStartTime`
- `stepStartTime`: client-side timestamp when `message.part.updated` fires with `part.type === "step-start"`  
  (no server timestamp on step-start; must be measured client-side via `Date.now()`)
- `firstTokenTime`: client-side timestamp when first `message.part.delta` fires with `field === "text"`
- `inputTokens`: from `StepFinishPart.tokens.input` (authoritative, arrives at step-finish)

**Alternative**: TextPart has `time.start` (server-side, first token) but it only arrives at end via `message.part.updated`. The client-side approach is required for **live/streaming** display.

**Decode Speed (TG) = output tokens / generation time**

- `generationTime` = `stepFinishTime - firstTokenTime`
- `stepFinishTime`: client-side `Date.now()` when `message.part.updated` fires with `part.type === "step-finish"`
- `outputTokens`: from `StepFinishPart.tokens.output` (authoritative)

**Live estimate during streaming**: `liveOutputChars / elapsed` (chars ≈ tokens, rough approximation)

**TTFT (time-to-first-token)**:
- Cannot be directly derived from server-emitted data alone (step-start has no server timestamp)
- Must be measured **client-side** by recording `Date.now()` at step-start and at first text delta
- Alternatively: `TextPart.time.start - AssistantMessage.time.created` gives server-side TTFT when both are available (at end of generation)

### New Event Types in v1.15+ (`EventSessionNext*`)

The SDK also exports a newer `EventSessionNext*` family (e.g. `EventSessionNextStepStarted`, `EventSessionNextStepEnded`, `EventSessionNextTextStarted`, `EventSessionNextTextDelta`, `EventSessionNextTextEnded`). These may provide richer streaming granularity but are in a separate namespace and may require `session.next.*` event type strings (to be confirmed against actual event type string values).

---

## 5. Prior Art: Existing TPS/Speed Plugins

### `opencode-plugin-tps` by jimicze (BEST REFERENCE)
- **URL**: https://github.com/jimicze/opencode-plugin-tps
- **Source verified**: `.opencode/plugins/tps-plugin.tsx` (457 lines, SolidJS/TSX, no build step)
- **What it does**: PP (prompt processing) speed and TG (token generation) speed in the sidebar
- **Slot**: `sidebar_content` at order 150
- **Events used**: `message.part.updated`, `message.part.delta`, `session.status`, `message.updated`
- **Prefill**: `client-side startTime` at step-start → `firstTokenTime` at first text delta
- **Decode live**: rolling char count / elapsed seconds (updates every `liveIntervalMs` default 150ms)
- **Decode final**: `StepFinishPart.tokens.output / (now - firstTokenTime)` 
- **PP speed**: `StepFinishPart.tokens.input / (firstTokenTime - startTime)`
- **Display**: "PP: X.X tok/s (avg)", "TG: X.X tok/s (cur|avg)"
- **Config**: optional `./tps-config.json` with `showTotal`, `showPpSpeed`, `showTgSpeed`, `showCache`, `showReasoning`, `liveIntervalMs`
- **Tests**: 163 vitest tests

### `opencode-tps` by williamcr01
- **URL**: https://github.com/williamcr01/opencode-tps
- **Files**: `tui.tsx`, `package.json` — 5-second rolling window TPS meter in bottom-right corner
- **Source not confirmed** (GitHub shows README only)

### `oc-tps` by Tarquinen  
- **URL**: https://github.com/Tarquinen/oc-tps
- **Files**: `tui.tsx` — shows live TPS, average TPS, and average TTFT in the session prompt
- **Source not confirmed**

### `opencode-throughput`
- **URL**: https://npmx.dev/package/opencode-throughput
- **What it does**: TTFT, TPS, latency, token usage, cost per model in TUI sidebar
- **Source not confirmed** (npmx returned 403)

### `@sirtenzin/opencode-tps` 
- **URL**: https://npmx.dev/package/@sirtenzin/opencode-tps
- **What it does**: TPS for active session and each subagent; sidebar section listing per-subagent TPS
- **Source not confirmed**

### `opencode-tps-meter` (by johannus22 et al.)
- **URL**: https://www.npmjs.com/package/@johannus22/opencode-tps-meter
- **Version**: 0.1.2, frozen since April 2026; 5-second rolling window; visual bar indicator
- **npm package returned 403** — source not confirmed directly

### `opencode-ai-usagebar` by neoscaler
- **URL**: https://github.com/neoscaler/opencode-ai-usagebar
- **What it does**: Provider quota/balance sidebar — polls `ai-usagebar usage --json` on interval
- **Config**: `["./plugin/ai-usagebar-sidebar.tsx", { "command": "ai-usagebar", "interval": 60, ... }]`
- **Installs to**: `~/.config/opencode/plugin/`

### `opencode-better-sidebar` by streetturtle
- **URL**: https://github.com/streetturtle/opencode-better-sidebar
- **Includes**: context progress bar, session token totals, open-in editor buttons, recap

### Built-in TUI Display Style (from `context.tsx`)
```tsx
<box>
  <text fg={theme().text}><b>Context</b></text>
  <text fg={theme().textMuted}>{tokens.toLocaleString()} tokens</text>
  <text fg={theme().textMuted}>{percent}% used</text>
  <text fg={theme().textMuted}>{money.format(cost)} spent</text>
</box>
```
Uses `<box>` container (column layout), bold section header with `theme.text`, detail rows with `theme.textMuted`.

---

## 6. Changelog: v1.14–v1.18 (TUI Plugin Relevant)

| Version | Entry |
|---------|-------|
| v1.14.42 | `api.command.*` silently removed; replaced by `api.keymap.registerLayer`. Simplified TUI keybinding config into flat format. |
| v1.15.0 | Added Effect-based core event system for more complete event delivery |
| v1.15.5 | Reduced missed `/event` updates caused by a subscription race |
| v1.15.6 | Plugin file load errors no longer break rest of plugin loading |
| v1.16.0 | Skill discovery and file-based agent loading; improved startup time |
| v1.17.12 | Yolo mode (auto-approve permissions) |

No changelog entries explicitly mention new TUI plugin **slots API** additions between v1.14–v1.18. The slots system appears to have been present before v1.14 and evolved gradually. The `tui-plugins.md` spec is the canonical reference.

---

## 7. TUI Source File Map

| File | Purpose |
|------|---------|
| `packages/tui/src/feature-plugins/sidebar/context.tsx` | Built-in Context sidebar block (tokens/cost) |
| `packages/tui/src/feature-plugins/sidebar/mcp.tsx` | Built-in MCP status |
| `packages/tui/src/feature-plugins/sidebar/lsp.tsx` | Built-in LSP status |
| `packages/tui/src/feature-plugins/sidebar/todo.tsx` | Built-in Todo list |
| `packages/tui/src/feature-plugins/sidebar/files.tsx` | Built-in file diff list |
| `packages/tui/src/plugin/api.ts` | Plugin API factory (`createTuiApi`, `createPluginRoutes`) |
| `packages/tui/src/plugin/slots.tsx` | Slot registry implementation |
| `packages/tui/src/plugin/runtime.tsx` | Plugin loader/activation/disposal |
| `packages/tui/src/plugin/command-shim.ts` | Legacy `api.command.*` compatibility shim |
| `packages/tui/src/context/event.ts` | `useEvent()` hook wrapping SDK event bus |
| `packages/plugin/src/tui.ts` | Public `TuiPlugin`, `TuiPluginApi`, etc. types |
| `packages/opencode/specs/tui-plugins.md` | Official TUI plugin spec (authoritative) |
| `packages/sdk/js/src/v2/gen/types.gen.ts` | `Event`, `Message`, `Part`, `StepFinishPart`, etc. |

---

## 8. Open Questions / Risks

1. **`TextPart.time.start` availability**: The `time.start` field on `TextPart` arrives via `message.part.updated` once the part exists. It may arrive on first text delta or only at completion. Need to confirm whether it's set on the first delta or only at `step-finish`. The `jimicze` plugin uses pure client-side `Date.now()` which avoids this ambiguity.

2. **`session.next.*` events**: The SDK exports `EventSessionNextTextDelta` etc. but the exact event type string (e.g. `"session.next.text.delta"`) is not confirmed — only the TypeScript type name was found in the union. These may provide finer-grained timing than `message.part.delta`. Needs verification against actual event wire format.

3. **Subagent step-finish races**: When subagents emit `step-finish` events, the `messageID` differs from the main thread. The `jimicze` plugin handles this by comparing `part.messageID !== currentMessageId` and calling `accumulateTokens()` instead of `endGeneration()`. This is a correctness risk that needs testing.

4. **Slot unregister**: `api.slots.register()` returns a string id, NOT an unregister function. Plugin cleanup is handled by the runtime on deactivation. This means slots cannot be dynamically added/removed within a single plugin session.

5. **No server-side timestamp on step-start**: `StepStartPart` has no `time` field in the SDK types. TTFT must be measured entirely client-side. This introduces network jitter if the TUI client has network latency to the OpenCode server.

6. **`api.kv` is not namespaced**: If multiple plugins use the same key names in `api.kv`, they will collide. Need to use plugin-specific key prefixes.

7. **API stability**: The spec file says "TUI plugin API" without a stability level marker. The breaking `api.command.*` removal in v1.14.42 with no deprecation suggests the API is not yet considered stable. The spec file itself is the most reliable source but may change without semver guarantees.

8. **No TTFT from server alone**: There is no single server-emitted event that directly provides prefill latency. `AssistantMessage.time.created` + `TextPart.time.start` gives a server-side TTFT proxy, but both arrive at end of generation. For live display, client-side measurement is the only option.

---

## Sources

- Official spec: `anomalyco/opencode` `packages/opencode/specs/tui-plugins.md` (fetched via GitHub API)
- Plugin types: `anomalyco/opencode` `packages/plugin/src/tui.ts` (fetched via GitHub API)
- Built-in sidebar: `anomalyco/opencode` `packages/tui/src/feature-plugins/sidebar/context.tsx`
- SDK event types: `anomalyco/opencode` `packages/sdk/js/src/v2/gen/types.gen.ts`
- Prior art (TPS): `jimicze/opencode-plugin-tps` `.opencode/plugins/tps-plugin.tsx` (full source verified)
- tui.json example: `jimicze/opencode-plugin-tps` `.opencode/tui.json` (verified)
- Web: https://opentui.com/docs/plugins/slots/
- Web: https://gist.github.com/rstacruz/946d02757525c9a0f49b25e316fbe715
- Web: https://github.com/anomalyco/opencode/issues/26557
- Web: https://github.com/anomalyco/opencode/issues/28902 (closed with "needs:compliance" label)
- Web: https://tokenade.net/en/articles/opencode-tokens-per-second
- Web: https://takopi.dev/reference/runners/opencode/stream-json-cheatsheet/
