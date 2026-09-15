# OpenCode Plugin API Local Research — speed-measure plugin

Investigated: 2026-09-14  
OpenCode version: 1.18.30  
All findings are **verified from local files** unless noted otherwise.

---

## 1. tui.jsonc / herdr-tui-session.js — TUI Plugin Hook

### File: `~/.config/opencode/tui.jsonc`
```jsonc
{ "plugin": ["./herdr-tui-session.js"] }
```
This config file registers TUI plugins. The `plugin` key is an array of relative paths (or npm specifiers). This is distinct from `opencode.jsonc` which registers server-side plugins.

### File: `~/.config/opencode/herdr-tui-session.js`

**Exported shape:**
```js
export default {
  id: "herdr.opencode.session-selection",  // optional; string id
  tui: async (api) => { ... },             // TUI entry point
};
```

This matches `TuiPluginModule` from `@opencode-ai/plugin/dist/tui.d.ts`:
```ts
export type TuiPlugin = (api: TuiPluginApi, options: PluginOptions | undefined, meta: TuiPluginMeta) => Promise<void>;
export type TuiPluginModule = { id?: string; tui: TuiPlugin; server?: never; };
```

**`api` object actually used in `herdr-tui-session.js`:**
- `api.route.current` (line 69) — current TUI route; shape `{ name, params }`. When `name === "session"`, `params.sessionID` is the active session.
- `api.state.session.get(sessionID)` (line 72) — returns `Session | undefined`; `session.parentID` is used to skip child sessions.
- `api.lifecycle.onDispose(fn)` (line 111) — registers cleanup; fn is called when plugin is torn down.

The plugin uses `setInterval` (line 110) to poll the route every 100 ms and report the selected session ID over a Unix socket (`HERDR_SOCKET_PATH`). **It does NOT use `api.slots`, `api.event`, or any sidebar rendering.**

---

## 2. herdr-agent-state.js — Server-Side Plugin Structure

### File: `~/.config/opencode/plugins/herdr-agent-state.js`

**Exported shape:**
```js
export const HerdrAgentStatePlugin = async () => {
  // returns Hooks or {}
  return {
    "chat.message": async ({ sessionID }) => { ... },
    event: async ({ event }) => { ... },
  };
};
```

This matches `Plugin` from `@opencode-ai/plugin/dist/index.d.ts`:
```ts
export type Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>;
```
(here `HerdrAgentStatePlugin` ignores `input` but is otherwise identical in return shape)

**Hooks used:**
- `event: async ({ event }) => void` — receives every event. The `event.type` values observed: `session.created`, `session.updated`, `session.status`, `tool.execute.before/after`, `permission.asked/replied`, `question.asked/replied/rejected`, `session.compacted`, `session.error`, `session.idle`, `session.deleted`. `event.properties.sessionID` holds the session; `event.properties.info` may hold a Session object.
- `"chat.message": async ({ sessionID }) => void` — fired when a new user message is received.

Server-side plugins are loaded via the `plugin` key in `opencode.jsonc` (global) or local `opencode.jsonc`.

---

## 3. @opencode-ai/plugin 1.18.30 — Type Definitions

### File: `~/.config/opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts`

#### `PluginInput`
```ts
export type PluginInput = {
    client: ReturnType<typeof createOpencodeClient>;
    project: Project;
    directory: string;
    worktree: string;
    experimental_workspace: {
        register(type: string, adapter: WorkspaceAdapter): void;
    };
    serverUrl: URL;
    $: BunShell;
};
```

#### `Plugin` and `PluginModule`
```ts
export type Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>;
export type PluginModule = { id?: string; server: Plugin; tui?: never; };
```

#### `Hooks` interface (all hooks)
```ts
export interface Hooks {
    dispose?: () => Promise<void>;
    event?: (input: { event: Event }) => Promise<void>;
    config?: (input: Config) => Promise<void>;
    tool?: { [key: string]: ToolDefinition };
    auth?: AuthHook;
    provider?: ProviderHook;
    "chat.message"?: (input: { sessionID, agent?, model?, messageID?, variant? },
                      output: { message: UserMessage, parts: Part[] }) => Promise<void>;
    "chat.params"?: (input: { sessionID, agent, model, provider, message },
                     output: { temperature, topP, topK, maxOutputTokens, options }) => Promise<void>;
    "chat.headers"?: (input: { sessionID, agent, model, provider, message },
                      output: { headers }) => Promise<void>;
    "permission.ask"?: (input: Permission, output: { status: "ask"|"deny"|"allow" }) => Promise<void>;
    "command.execute.before"?: (input: { command, sessionID, arguments },
                                output: { parts: Part[] }) => Promise<void>;
    "tool.execute.before"?: (input: { tool, sessionID, callID }, output: { args }) => Promise<void>;
    "shell.env"?: (input: { cwd, sessionID?, callID? }, output: { env }) => Promise<void>;
    "tool.execute.after"?: (input: { tool, sessionID, callID, args },
                            output: { title, output, metadata }) => Promise<void>;
    "experimental.chat.messages.transform"?: (...) => Promise<void>;
    "experimental.chat.system.transform"?: (...) => Promise<void>;
    "experimental.provider.small_model"?: (...) => Promise<void>;
    "experimental.session.compacting"?: (input: { sessionID },
                                         output: { context, prompt? }) => Promise<void>;
    "experimental.compaction.autocontinue"?: (...) => Promise<void>;
    "experimental.text.complete"?: (input: { sessionID, messageID, partID },
                                    output: { text }) => Promise<void>;
    "tool.definition"?: (input: { toolID }, output: { description, parameters }) => Promise<void>;
}
```
Source: `dist/index.d.ts` lines 173–322.

No TUI-related hooks exist in `Hooks`. TUI plugins are entirely separate from server plugins.

---

## 4. @opencode-ai/sdk — Event Types and Timing/Token Data

Two SDK layers co-exist: v1 (`dist/gen/types.gen.d.ts`) and v2 (`dist/v2/gen/types.gen.d.ts`). The TUI plugin's `api.event` uses **v2** types; the server plugin `Hooks.event` uses **v1** types.

### v1 SDK: `AssistantMessage` (key fields for speed)
File: `~/.config/opencode/node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts` lines 98–127
```ts
type AssistantMessage = {
    id: string;
    sessionID: string;
    role: "assistant";
    time: { created: number; completed?: number; };  // unix-ms
    modelID: string;
    providerID: string;
    cost: number;
    tokens: {
        input: number;
        output: number;
        reasoning: number;
        cache: { read: number; write: number; };
    };
    finish?: string;
    // ...
};
```
`time.created` = when the assistant turn started (prompt submitted); `time.completed` = when the full response finished (populated on `message.updated` after completion).

### v1 SDK: `StepFinishPart` (per-step token breakdown)
File: lines 283–298
```ts
type StepFinishPart = {
    type: "step-finish";
    cost: number;
    tokens: {
        input: number; output: number; reasoning: number;
        cache: { read: number; write: number; };
    };
    reason: string;
    snapshot?: string;
};
```
No `time` field on `StepStartPart` or `StepFinishPart` in v1. **Cannot derive TTFT from v1 parts alone.**

### v1 SDK: `TextPart` (partial timing)
File: lines 142–157
```ts
type TextPart = {
    type: "text";
    text: string;
    time?: { start: number; end?: number; };  // unix-ms; optional
    // ...
};
```
`time.start` = first character of this text part; `time.end` = last character. These are set by the server. However they may not always be present (optional).

### v1 SDK: `Event` union (all event type names)
File: line 602
```
EventServerInstanceDisposed | EventInstallationUpdated | EventInstallationUpdateAvailable |
EventLspClientDiagnostics | EventLspUpdated |
EventMessageUpdated | EventMessageRemoved |
EventMessagePartUpdated | EventMessagePartRemoved |
EventPermissionUpdated | EventPermissionReplied |
EventSessionStatus | EventSessionIdle | EventSessionCompacted |
EventFileEdited | EventTodoUpdated | EventCommandExecuted |
EventSessionCreated | EventSessionUpdated | EventSessionDeleted | EventSessionDiff |
EventSessionError |
EventFileWatcherUpdated | EventVcsBranchUpdated |
EventTuiPromptAppend | EventTuiCommandExecute | EventTuiToastShow |
EventPtyCreated | EventPtyUpdated | EventPtyExited | EventPtyDeleted |
EventServerConnected
```

Key event payloads:
- `message.updated` → `{ info: Message }` — fired on every update to a message; when `info.role === "assistant"` and `info.time.completed` is populated, generation is complete.
- `message.part.updated` → `{ part: Part; delta?: string }` — fired per-part; `part` may be a `TextPart` with `time?.start`/`time?.end`.
- `session.status` → `{ sessionID, status: SessionStatus }` — status = `{ type: "idle" | "busy" | "retry" }`.
- `session.idle` → `{ sessionID }` — session has returned to idle.
- `session.error` → `{ sessionID?, error? }`.

### v2 SDK: Richer timing events (used in TUI)
File: `~/.config/opencode/node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts`

The v2 SDK adds granular per-step/per-text events with millisecond `timestamp` fields:

**`EventSessionNextStepStarted`** (line 5433)
```ts
{ id, type: "session.next.step.started",
  properties: { timestamp: number, sessionID, assistantMessageID, agent, model: ModelRef, snapshot? } }
```
`timestamp` = when the LLM call was initiated (start of prefill).

**`EventSessionNextTextStarted`** (line 5477)
```ts
{ id, type: "session.next.text.started",
  properties: { timestamp: number, sessionID, assistantMessageID, textID } }
```
`timestamp` = when the first text token arrived. **This is the TTFT marker.**

**`EventSessionNextTextDelta`** (line 5487)
```ts
{ id, type: "session.next.text.delta",
  properties: { timestamp: number, sessionID, assistantMessageID, textID, delta: string } }
```

**`EventSessionNextTextEnded`** (line 5498)
```ts
{ id, type: "session.next.text.ended",
  properties: { timestamp: number, sessionID, assistantMessageID, textID, text: string } }
```
`timestamp` = when the last token of this text segment was received.

**`EventSessionNextStepEnded`** (line 5445)
```ts
{ id, type: "session.next.step.ended",
  properties: { timestamp: number, sessionID, assistantMessageID,
                finish: string, cost: number,
                tokens: { input, output, reasoning, cache: { read, write } },
                snapshot?, files? } }
```
`tokens.output` = total output tokens for this step; `timestamp` = when the step finished.

**Speed formula derivable from v2 events:**
```
TTFT (ms)        = first_token.timestamp - step_started.timestamp
Decode time (ms) = step_ended.timestamp - first_token.timestamp - tool_busy
Decode speed (tok/s) = (tokens.output + tokens.reasoning) / (decode_time / 1000)
```
`first_token` is the earlier of `text.started` / `reasoning.started`. `tokens.output` only arrives with
`step.ended`, so the decode window opens at the first token and closes at `step.ended`, not at `text.ended`.

**Why `text_ended.timestamp - text_started.timestamp` alone is not usable:**

- OpenCode publishes `session.next.step.ended` only after every tool fiber in the step has settled, so the raw `step_ended.timestamp - t1` span includes the whole tool execution time and heavily underestimates decode speed.
- `text.ended` is not a reliable last-token marker either: on a real database, `msg_09343c1fd001yR6FUYmoOtaZ39` has a text span in which 3 tools executed, and `text.time.end` was recorded right after the last tool finished — the span already contains the tool execution time.

The implementation therefore subtracts the union of tool execution intervals, clamped to `[t1, step_ended.timestamp]`:

- `tool_busy` = total length of the merged (union) tool intervals, so overlapping parallel tool calls are subtracted once.
- interval start = `session.next.tool.called` (after tool-input generation; the argument generation time stays inside the decode window because `tokens.output` includes tool-call argument tokens); interval end = `session.next.tool.success` / `session.next.tool.failed`.
- If `decode_time <= 0`, decode speed is 0.

**Full v2 Event type** is a large union (line 4): includes all the `session.next.*` events above plus `message.part.delta`, `session.error`, `session.status`, `session.idle`, and many others.

---

## 5. TUI-Plugin Related Types: sidebar / slot / SolidJS

### `TuiPluginApi` — complete surface (tui.d.ts lines 459–504)
```ts
type TuiPluginApi = {
    app: TuiApp;
    attention: TuiAttention;
    command?: TuiCommandApi;          // deprecated
    keys: TuiKeys;
    keymap: TuiKeymap;
    mode: TuiModeApi;
    route: { register, navigate, current: TuiRouteCurrent };
    ui: { Dialog, DialogAlert, DialogConfirm, DialogPrompt, DialogSelect,
          Slot, Prompt, toast, dialog };
    readonly tuiConfig: Frozen<TuiConfigView>;
    kv: TuiKV;
    state: TuiState;
    theme: TuiTheme;
    client: OpencodeClient;   // v2 OpencodeClient
    event: TuiEventBus;       // uses v2 Event types
    renderer: CliRenderer;
    slots: TuiSlots;
    plugins: { list, activate, deactivate, add, install };
    lifecycle: TuiLifecycle;
};
```

### `TuiState` — available session data (tui.d.ts lines 287–314)
```ts
type TuiState = {
    session: {
        count: () => number;
        get: (sessionID: string) => Session | undefined;
        diff: (sessionID: string) => ReadonlyArray<TuiSidebarFileItem>;
        todo: (sessionID: string) => ReadonlyArray<TuiSidebarTodoItem>;
        messages: (sessionID: string) => ReadonlyArray<Message>;
        status: (sessionID: string) => SessionStatus | undefined;
        permission: (sessionID: string) => ReadonlyArray<PermissionRequest>;
        question: (sessionID: string) => ReadonlyArray<QuestionRequest>;
    };
    part: (messageID: string) => ReadonlyArray<Part>;
    lsp: () => ReadonlyArray<TuiSidebarLspItem>;
    mcp: () => ReadonlyArray<TuiSidebarMcpItem>;
    // ...
};
```

### `TuiEventBus` (tui.d.ts lines 407–411)
```ts
type TuiEventBus = {
    on: <Type extends Event["type"]>(
        type: Type,
        handler: (event: Extract<Event, { type: Type }>) => void
    ) => () => void;   // returns unsubscribe fn
};
```
`Event` here is imported from `@opencode-ai/sdk/v2` — so all `session.next.*` events are subscribed with `api.event.on("session.next.step.started", handler)`.

### Sidebar Slot API — VERIFIED OFFICIAL

**`TuiHostSlotMap`** (tui.d.ts lines 355–386):
```ts
type TuiHostSlotMap = {
    app: {};
    app_bottom: {};
    home_logo: {};
    home_prompt: { ref? };
    home_prompt_right: {};
    session_prompt: { session_id, visible?, disabled?, on_submit?, ref? };
    session_prompt_right: { session_id };
    home_bottom: {};
    home_footer: {};
    sidebar_title:   { session_id: string; title: string; share_url?: string; };
    sidebar_content: { session_id: string; };
    sidebar_footer:  { session_id: string; };
};
```
`sidebar_content` and `sidebar_footer` exist and take `session_id` as a prop.

**`TuiSlots`** (tui.d.ts lines 401–406):
```ts
type TuiSlots = {
    register: (plugin: TuiSlotPlugin) => string;
};
```

**`TuiSlotPlugin`** (tui.d.ts lines 397–400):
```ts
type TuiSlotPlugin<Slots = {}> = Omit<SolidPlugin<TuiSlotMap<Slots>, TuiSlotContext>, "id"> & { id?: never };
```
Where `SolidPlugin` is from `@opentui/solid`. **`@opentui` is NOT installed in `~/.config/opencode/node_modules/`** — it is provided by the OpenCode binary at runtime. Plugins that need to render UI must author SolidJS components, but the JSX runtime is injected by OpenCode.

**`TuiSlotContext`** (tui.d.ts line 394–396):
```ts
type TuiSlotContext = { theme: TuiTheme; };
```

---

## 6. Sidebar API — Concrete Answer

**YES, there is an official API to add content to the TUI sidebar.**

The mechanism is `api.slots.register()` called from within the `tui` function. The plugin must provide a `TuiSlotPlugin` — a SolidJS plugin object (from `@opentui/solid`) that renders a component when the matching slot name is requested.

### Slot Names for Sidebar
- `sidebar_content` — main body of the right sidebar panel; receives `{ session_id }`.
- `sidebar_footer` — footer area of sidebar; receives `{ session_id }`.
- `sidebar_title` — title bar of sidebar; receives `{ session_id, title, share_url? }`.

### Conceptual API Shape (no example in local files)
```js
// tui plugin
export default {
  id: "my-speed-plugin",
  tui: async (api) => {
    api.slots.register({
      // SolidPlugin shape — exact JSX syntax depends on @opentui/solid runtime
      slots: {
        sidebar_content: (props) => {
          // props.session_id is the current session
          // Return a renderable (text, Solid JSX element, etc.)
          // ...
        },
      },
    });

    // Subscribe to timing events
    const unsubStepStart = api.event.on("session.next.step.started", (ev) => {
      // ev.properties.timestamp, ev.properties.assistantMessageID
    });
    const unsubTextStart = api.event.on("session.next.text.started", (ev) => {
      // TTFT = ev.properties.timestamp - stepStartTimestamp
    });
    const unsubStepEnd = api.event.on("session.next.step.ended", (ev) => {
      // ev.properties.tokens.output, ev.properties.timestamp
    });

    api.lifecycle.onDispose(() => {
      unsubStepStart();
      unsubTextStart();
      unsubStepEnd();
    });
  },
};
```

**The `herdr-tui-session.js` does NOT use the sidebar/slot API.** It only tracks the selected session via route polling and reports it to an external socket. The sidebar slot mechanism is fully documented in types but has no working local example to reference.

---

## 7. What Does NOT Exist in Local Files

- `@opentui/core`, `@opentui/keymap`, `@opentui/solid` packages — not installed locally; provided by OpenCode binary at runtime. Exact JSX syntax for slot components is **unverified** locally.
- A working example of `api.slots.register()` — no local plugin uses this API. **Assumed from type definitions only.**
- `SlotMode` from `@opentui/core` — imported in types but not accessible locally.
- Any documentation on how to structure `TuiSlotPlugin.slots` render functions — shape depends on `SolidPlugin<...>` from `@opentui/solid`, which is not available locally.

---

## Key Files

| File | Purpose |
|------|---------|
| `~/.config/opencode/tui.jsonc` | TUI plugin registration |
| `~/.config/opencode/herdr-tui-session.js` | TUI plugin example (route/session tracking) |
| `~/.config/opencode/plugins/herdr-agent-state.js` | Server-side plugin example (event hooks) |
| `~/.config/opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts` | `Plugin`, `Hooks`, `PluginInput` types |
| `~/.config/opencode/node_modules/@opencode-ai/plugin/dist/tui.d.ts` | `TuiPlugin`, `TuiPluginApi`, `TuiSlots`, `TuiHostSlotMap` |
| `~/.config/opencode/node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts` | v1 `Event`, `AssistantMessage`, `TextPart`, `StepFinishPart` |
| `~/.config/opencode/node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts` | v2 `Event`, `EventSessionNextStepStarted/Ended`, `EventSessionNextTextStarted/Ended/Delta` |

---

## Speed Measurement — Recommended Data Sources

### Option A: TUI Plugin + v2 event stream (preferred for real-time display)

Use `api.event.on()` in the TUI plugin with these event types:
1. `"session.next.step.started"` — record `timestamp` as T0 (prefill start)
2. `"session.next.text.started"` — record `timestamp` as T1 (first decode token = TTFT end)
3. `"session.next.text.ended"` — record `timestamp` as T2 (decode done)
4. `"session.next.step.ended"` — read `tokens.output` for decode token count

Metrics:
- **Prefill/TTFT** = T1 − T0 (ms)
- **Prompt processing rate** = cannot be computed directly (input tokens are known, but prefill time is T0→T1 and includes model batching, not just tokenization)
- **Decode speed (tok/s)** = `tokens.output / ((T2 − T1) / 1000)`

### Option B: v1 event hook + TextPart.time (server-side plugin)
Listen to `message.part.updated` and check if `part.type === "text"` and `part.time` is set. However `TextPart.time` is optional and may not always be populated.

### Option C: AssistantMessage.time (coarse-grained)
- `time.created` → turn started
- `time.completed` → turn fully done
- These give total turn duration, not TTFT or decode speed separately.

