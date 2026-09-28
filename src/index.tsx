/** @jsxImportSource @opentui/solid */

import { createRoot, createSignal } from "solid-js";
import type { TuiPluginModule, TuiThemeCurrent } from "@opencode-ai/plugin/tui";

import {
  SpeedCollector,
  type CollectorState,
  type DoneState,
  type SessionMetrics,
  type StepState,
} from "./collector.js";
import { formatSpeed, formatTTFT } from "./format.js";

export interface SpeedMeasureConfig {
  showTTFT: boolean;
  showAverages: boolean;
  showCache: boolean;
  liveIntervalMs: number;
  order: number;
}

export const DEFAULT_CONFIG: Readonly<SpeedMeasureConfig> = Object.freeze({
  showTTFT: true,
  showAverages: false,
  showCache: false,
  liveIntervalMs: 150,
  order: 150,
});

interface BunRuntime {
  env: Record<string, string | undefined>;
  file: (path: string) => { text: () => Promise<string> };
}

function runtimeBun(): BunRuntime | undefined {
  return (globalThis as typeof globalThis & { Bun?: BunRuntime }).Bun;
}

export const CONFIG_PATH = `${
  runtimeBun()?.env.XDG_CONFIG_HOME ?? `${runtimeBun()?.env.HOME ?? ""}/.config`
}/opencode/speed-measure.json`;
const KV_PREFIX = "speed-measure:avg:";
const FALLBACK_DELAY_MS = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse user configuration without allowing malformed values to break startup. */
export function parseConfig(source: string): SpeedMeasureConfig {
  try {
    const value: unknown = JSON.parse(source);
    if (!isRecord(value)) return { ...DEFAULT_CONFIG };

    return {
      showTTFT:
        typeof value.showTTFT === "boolean"
          ? value.showTTFT
          : DEFAULT_CONFIG.showTTFT,
      showAverages:
        typeof value.showAverages === "boolean"
          ? value.showAverages
          : DEFAULT_CONFIG.showAverages,
      showCache:
        typeof value.showCache === "boolean"
          ? value.showCache
          : DEFAULT_CONFIG.showCache,
      liveIntervalMs:
        typeof value.liveIntervalMs === "number" &&
        Number.isFinite(value.liveIntervalMs) &&
        value.liveIntervalMs > 0
          ? value.liveIntervalMs
          : DEFAULT_CONFIG.liveIntervalMs,
      order:
        typeof value.order === "number" && Number.isFinite(value.order)
          ? value.order
          : DEFAULT_CONFIG.order,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function loadConfig(path = CONFIG_PATH): Promise<SpeedMeasureConfig> {
  try {
    const bun = runtimeBun();
    if (!bun) return { ...DEFAULT_CONFIG };
    return parseConfig(await bun.file(path).text());
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export interface SessionAverages {
  ttft: number;
  prefillTokPerSec: number | null;
  decodeTokPerSec: number;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function calculateSessionAverages(
  metrics: SessionMetrics | undefined,
): SessionAverages | undefined {
  if (!metrics) return undefined;

  const history =
    metrics.stepHistory.length > 0
      ? metrics.stepHistory
      : metrics.current.phase === "done"
        ? [metrics.current]
        : [];
  if (history.length === 0) return undefined;

  const ttft = mean(history.map((step) => step.ttft));
  const decode = mean(history.map((step) => step.decodeTokPerSec));
  if (ttft === null || decode === null) return undefined;

  return {
    ttft,
    prefillTokPerSec: mean(
      history.flatMap((step) =>
        step.prefillTokPerSec === null ? [] : [step.prefillTokPerSec],
      ),
    ),
    decodeTokPerSec: decode,
  };
}

export interface DisplayExtras {
  averages?: SessionAverages;
  cacheRead?: number;
}

export interface DisplayLines {
  prefill: string;
  decode: string;
}

function stripSpeedUnit(value: string): string {
  return value.replace(/ tok\/s$/, "");
}

function formatDonePrefill(
  state: DoneState,
  config: Readonly<SpeedMeasureConfig>,
  averages: SessionAverages | undefined,
): string {
  const values: string[] = [];

  if (config.showTTFT) {
    const average =
      config.showAverages && averages
        ? ` (avg ${formatTTFT(averages.ttft)})`
        : "";
    values.push(`${formatTTFT(state.ttft)}${average}`);
  }

  if (!config.showAverages && state.prefillTokPerSec !== null) {
    values.push(formatSpeed(state.prefillTokPerSec));
  } else if (!config.showTTFT && state.prefillTokPerSec !== null) {
    const current = stripSpeedUnit(formatSpeed(state.prefillTokPerSec));
    const average =
      averages?.prefillTokPerSec == null
        ? ""
        : ` (avg ${stripSpeedUnit(formatSpeed(averages.prefillTokPerSec))})`;
    values.push(`${current}${average} tok/s`);
  }

  return values.length > 0 ? values.join(" │ ") : "--";
}

function stateForSession(state: CollectorState, sessionID: string): StepState {
  return state.get(sessionID)?.current ?? { phase: "idle" };
}

/** Build only the requested session's two data rows. */
export function buildDisplayLines(
  state: CollectorState,
  sessionID: string,
  config: Readonly<SpeedMeasureConfig> = DEFAULT_CONFIG,
  extras: DisplayExtras = {},
): DisplayLines {
  const current = stateForSession(state, sessionID);
  const metrics = state.get(sessionID);
  const averages =
    extras.averages ??
    (config.showAverages ? calculateSessionAverages(metrics) : undefined);
  const cacheSuffix =
    config.showCache && extras.cacheRead !== undefined
      ? ` │ cache ${extras.cacheRead}`
      : "";

  switch (current.phase) {
    case "idle":
      return { prefill: "Prefill: --", decode: "Decode:  --" };
    case "prefilling":
      return { prefill: "Prefill: …", decode: "Decode:  --" };
    case "decoding":
      return {
        prefill: config.showTTFT
          ? `Prefill: ${formatTTFT(current.ttft)}`
          : "Prefill: --",
        decode:
          current.liveEstimate === null
            ? "Decode:  …"
            : `Decode:  ~${stripSpeedUnit(formatSpeed(current.liveEstimate))} chars/s`,
      };
    case "done": {
      const decodeCurrent = stripSpeedUnit(formatSpeed(current.decodeTokPerSec));
      const decodeAverage =
        config.showAverages && averages
          ? ` (avg ${stripSpeedUnit(formatSpeed(averages.decodeTokPerSec))})`
          : "";
      return {
        prefill: `Prefill: ${formatDonePrefill(current, config, averages)}${cacheSuffix}`,
        decode: `Decode:  ${decodeCurrent}${decodeAverage} tok/s`,
      };
    }
    case "error":
      return { prefill: "Prefill: error", decode: "Decode:  error" };
  }
}

export interface V1FallbackGate {
  markV2Seen: () => void;
  dispose: () => void;
}

/** Schedule feature detection separately so its exact two-second behavior is testable. */
export function scheduleV1Fallback(
  activate: () => void,
  delayMs = FALLBACK_DELAY_MS,
): V1FallbackGate {
  let disposed = false;
  let v2Seen = false;
  const timer = setTimeout(() => {
    if (!disposed && !v2Seen) activate();
  }, delayMs);

  return {
    markV2Seen() {
      v2Seen = true;
      clearTimeout(timer);
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
    },
  };
}

function numberFromKV(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// ---------------------------------------------------------------------------
// OpenCode v2 (>= 2.0) host contract
// ---------------------------------------------------------------------------

/**
 * Minimal structural types for the OpenCode v2 TUI plugin host. The v2 host
 * injects every service at runtime, so only the members below are consumed;
 * keeping them structural avoids pinning a v2 SDK version for type checking.
 */
type Unsubscribe = () => void;

/**
 * v2 events arrive as `{ type, created, data }`. `created` is the server-side
 * publish time in ms; payloads carry no timestamps of their own (the only
 * exception is `session.step.started`, whose `started` is the request
 * dispatch time before prefill). `data` stays `any` because the payload shape
 * is duck-typed at this boundary — spreading an index-signature type would
 * otherwise drop its properties from object literals.
 */
export interface V2Event {
  type: string;
  created: number;
  data: any;
}

/** Color token both hosts hand to `fg` (RGBA; same value type as 1.x). */
type ThemeColor = TuiThemeCurrent["text"];

export interface V2Context {
  data: {
    on: (type: string, handler: (event: V2Event) => void) => Unsubscribe;
  };
  storage: {
    memory: <Value extends object>(
      key: string,
      options: { initial: Value },
    ) => readonly [Value, (mutation: (draft: Value) => void) => void];
  };
  ui: {
    slot: (claim: {
      append: "sidebar.content";
      render: (input: { sessionID: string }) => unknown;
    }) => Unsubscribe;
  };
  theme: {
    text: { base: ThemeColor; muted: ThemeColor };
  };
}

/**
 * The sidebar block shared by both host contracts. Every value stays a
 * function and is read inside the JSX expressions: the Solid universal
 * transform only registers signal dependencies for reads that happen in
 * reactive scopes, which is what keeps the live rows and theme colors
 * updating without re-calling the slot render.
 */
function renderSpeedBlock(
  header: () => ThemeColor,
  muted: () => ThemeColor,
  lines: () => DisplayLines,
) {
  return (
    <box flexDirection="column">
      <text fg={header()}>
        <b>Speed</b>
      </text>
      <text fg={muted()}>{lines().prefill}</text>
      <text fg={muted()}>{lines().decode}</text>
    </box>
  );
}

/**
 * OpenCode v2 entry (`{ id, setup }` module contract).
 *
 * Subscribes to the v2 event names (`session.step.*`, `session.text.*`,
 * `session.reasoning.*`, `session.tool.*`). The 1.18.x `session.next.*` names
 * and the legacy `message.part.*` events no longer exist on v2, so there is
 * no fallback path here.
 */
async function setupV2(context: V2Context): Promise<() => void> {
  const config = await loadConfig();

  return createRoot((dispose) => {
    const collector = new SpeedCollector();
    const [sessionMetrics, setSessionMetrics] = createSignal<CollectorState>(
      new Map(),
    );
    const [cacheReads, setCacheReads] = createSignal<Map<string, number>>(
      new Map(),
    );
    const unsubs: Array<() => void> = [];

    // Session averages live in the host's shared memory store so they survive
    // plugin hot reloads, mirroring the 1.x api.kv behavior.
    const [averagesStore, mutateAverages] = context.storage.memory<
      Record<string, SessionAverages>
    >("speed-measure:averages", { initial: {} });

    const update = (
      transition: (previous: CollectorState) => CollectorState,
    ) => setSessionMetrics(transition);

    const persistAverages = (sessionID: string, state: CollectorState) => {
      if (!config.showAverages) return;
      const averages = calculateSessionAverages(state.get(sessionID));
      if (!averages) return;
      mutateAverages((draft) => {
        draft[sessionID] = averages;
      });
    };

    const recordStepEnd = (
      properties: Parameters<SpeedCollector["onStepEnded"]>[1],
    ) => {
      if (config.showCache) {
        setCacheReads((previous) => {
          const next = new Map(previous);
          next.set(properties.sessionID, properties.tokens.cache?.read ?? 0);
          return next;
        });
      }
      update((previous) => {
        const next = collector.onStepEnded(previous, properties);
        persistAverages(properties.sessionID, next);
        return next;
      });
    };

    unsubs.push(
      context.data.on("session.step.started", (event) =>
        update((previous) =>
          collector.onStepStarted(previous, {
            ...event.data,
            // `started` is the request dispatch time (before prefill), so the
            // v2 TTFT no longer collapses to ~0 like the 1.18.x step events.
            timestamp: event.data.started,
          }),
        ),
      ),
      context.data.on("session.text.started", (event) =>
        update((previous) =>
          collector.onTextStarted(previous, {
            ...event.data,
            timestamp: event.created,
          }),
        ),
      ),
      context.data.on("session.text.delta", (event) =>
        update((previous) => collector.onTextDelta(previous, event.data)),
      ),
      context.data.on("session.reasoning.started", (event) =>
        update((previous) =>
          collector.onReasoningStarted(previous, {
            ...event.data,
            timestamp: event.created,
          }),
        ),
      ),
      context.data.on("session.reasoning.delta", (event) =>
        update((previous) => collector.onReasoningDelta(previous, event.data)),
      ),
      context.data.on("session.tool.called", (event) =>
        update((previous) =>
          collector.onToolCalled(previous, {
            ...event.data,
            // v2 tool payloads identify calls as `id`, not `callID`.
            callID: event.data.id,
            timestamp: event.created,
          }),
        ),
      ),
      context.data.on("session.tool.success", (event) =>
        update((previous) =>
          collector.onToolEnded(previous, {
            ...event.data,
            callID: event.data.id,
            timestamp: event.created,
          }),
        ),
      ),
      context.data.on("session.tool.failed", (event) =>
        update((previous) =>
          collector.onToolEnded(previous, {
            ...event.data,
            callID: event.data.id,
            timestamp: event.created,
          }),
        ),
      ),
      context.data.on("session.step.streamed", (event) =>
        update((previous) =>
          collector.onStepStreamed(previous, {
            sessionID: event.data.sessionID,
            streamedAt: event.created,
          }),
        ),
      ),
      context.data.on("session.step.ended", (event) =>
        recordStepEnd({ ...event.data, timestamp: event.created }),
      ),
      context.data.on("session.step.failed", (event) =>
        update((previous) =>
          collector.onStepFailed(previous, {
            ...event.data,
            timestamp: event.created,
          }),
        ),
      ),
      context.data.on("session.status", (event) => {
        if (event.data.status?.type === "idle") {
          update((previous) =>
            collector.onIdle(previous, event.data.sessionID),
          );
        }
      }),
      context.data.on("session.execution.failed", (event) =>
        update((previous) =>
          collector.onSessionError(previous, event.data.sessionID),
        ),
      ),
      context.data.on("session.execution.interrupted", (event) =>
        update((previous) =>
          collector.onIdle(previous, event.data.sessionID),
        ),
      ),
    );

    const liveTimer = setInterval(
      () => update((previous) => collector.tick(previous)),
      config.liveIntervalMs,
    );

    context.ui.slot({
      // Claims coexist in plugin enable order; the builtin context block uses
      // the same anchor, so Speed renders after it. The 1.x `order` config has
      // no v2 equivalent.
      append: "sidebar.content",
      render: (props) => {
        const lines = () =>
          buildDisplayLines(sessionMetrics(), props.sessionID, config, {
            averages: config.showAverages
              ? averagesStore[props.sessionID]
              : undefined,
            cacheRead: cacheReads().get(props.sessionID),
          });
        return renderSpeedBlock(
          () => context.theme.text.base,
          () => context.theme.text.muted,
          lines,
        );
      },
    });

    return () => {
      unsubs.forEach((unsubscribe) => unsubscribe());
      clearInterval(liveTimer);
      dispose();
    };
  });
}

/**
 * OpenCode 1.15–1.x entry (`{ id, tui }` module contract). The v2
 * `session.step.*` events do not exist there, so the primary path listens on
 * `session.next.*` and falls back to the legacy `message.part.*` events when
 * none arrive within two seconds.
 */
async function setupLegacy(
  api: Parameters<TuiPluginModule["tui"]>[0],
): Promise<void> {
  const config = await loadConfig();

  createRoot((dispose) => {
    const collector = new SpeedCollector();
    const [sessionMetrics, setSessionMetrics] = createSignal<CollectorState>(
      new Map(),
    );
    const [cacheReads, setCacheReads] = createSignal<Map<string, number>>(
      new Map(),
    );
    const unsubs: Array<() => void> = [];
    let v1Unsubs: Array<() => void> = [];
    let v1Active = false;

    const update = (
      transition: (previous: CollectorState) => CollectorState,
    ) => setSessionMetrics(transition);

    const persistAverages = (sessionID: string, state: CollectorState) => {
      if (!config.showAverages || !api.kv.ready) return;
      const averages = calculateSessionAverages(state.get(sessionID));
      if (!averages) return;

      api.kv.set(`${KV_PREFIX}${sessionID}:ttft`, averages.ttft);
      api.kv.set(`${KV_PREFIX}${sessionID}:decode`, averages.decodeTokPerSec);
      if (averages.prefillTokPerSec !== null) {
        api.kv.set(
          `${KV_PREFIX}${sessionID}:prefill`,
          averages.prefillTokPerSec,
        );
      }
    };

    const recordStepEnd = (
      properties: Parameters<SpeedCollector["onStepEnded"]>[1],
    ) => {
      if (config.showCache) {
        setCacheReads((previous) => {
          const next = new Map(previous);
          next.set(properties.sessionID, properties.tokens.cache?.read ?? 0);
          return next;
        });
      }
      update((previous) => {
        const next = collector.onStepEnded(previous, properties);
        persistAverages(properties.sessionID, next);
        return next;
      });
    };

    const activateV1Fallback = () => {
      if (v1Active || api.lifecycle.signal.aborted) return;
      v1Active = true;

      v1Unsubs = [
        api.event.on("message.part.updated", (event) => {
          const part = event.properties.part;
          const now = Date.now();

          if (part.type === "step-start") {
            update((previous) =>
              collector.onStepStarted(previous, {
                sessionID: part.sessionID,
                assistantMessageID: part.messageID,
                timestamp: now,
              }),
            );
            return;
          }

          if (part.type === "step-finish") {
            recordStepEnd({
              sessionID: part.sessionID,
              assistantMessageID: part.messageID,
              timestamp: now,
              tokens: part.tokens,
            });
            return;
          }

          if (part.type === "tool") {
            // Runtime payloads may omit `state` entirely, so read it defensively.
            const toolState = part.state as
              | { time?: { start?: number; end?: number } }
              | undefined;
            const toolTime = toolState?.time;
            const sessionID = part.sessionID;
            const callID = part.callID;
            if (toolTime && typeof toolTime.start === "number") {
              const timestamp = toolTime.start;
              update((previous) =>
                collector.onToolCalled(previous, {
                  sessionID,
                  callID,
                  timestamp,
                }),
              );
            }
            if (toolTime && typeof toolTime.end === "number") {
              const timestamp = toolTime.end;
              update((previous) =>
                collector.onToolEnded(previous, {
                  sessionID,
                  callID,
                  timestamp,
                }),
              );
            }
          }
        }),
        api.event.on("message.part.delta", (event) => {
          if (event.properties.field !== "text") return;
          const { sessionID, messageID, delta } = event.properties;
          update((previous) => {
            let next = previous;
            if (previous.get(sessionID)?.current.phase === "prefilling") {
              next = collector.onTextStarted(previous, {
                sessionID,
                assistantMessageID: messageID,
                timestamp: Date.now(),
              });
            }
            return collector.onTextDelta(next, { sessionID, delta });
          });
        }),
      ];
    };

    const fallback = scheduleV1Fallback(activateV1Fallback);
    const selectV2 = () => {
      fallback.markV2Seen();
      if (!v1Active) return;
      v1Active = false;
      v1Unsubs.forEach((unsubscribe) => unsubscribe());
      v1Unsubs = [];
    };

    unsubs.push(
      api.event.on("session.next.step.started", (event) => {
        selectV2();
        update((previous) =>
          collector.onStepStarted(previous, event.properties),
        );
      }),
      api.event.on("session.next.reasoning.started", (event) =>
        update((previous) =>
          collector.onReasoningStarted(previous, event.properties),
        ),
      ),
      api.event.on("session.next.reasoning.delta", (event) =>
        update((previous) =>
          collector.onReasoningDelta(previous, event.properties),
        ),
      ),
      api.event.on("session.next.text.started", (event) =>
        update((previous) =>
          collector.onTextStarted(previous, event.properties),
        ),
      ),
      api.event.on("session.next.text.delta", (event) =>
        update((previous) => collector.onTextDelta(previous, event.properties)),
      ),
      api.event.on("session.next.tool.called", (event) =>
        update((previous) => collector.onToolCalled(previous, event.properties)),
      ),
      api.event.on("session.next.tool.success", (event) =>
        update((previous) => collector.onToolEnded(previous, event.properties)),
      ),
      api.event.on("session.next.tool.failed", (event) =>
        update((previous) => collector.onToolEnded(previous, event.properties)),
      ),
      api.event.on("session.next.step.ended", (event) =>
        recordStepEnd(event.properties),
      ),
      api.event.on("session.next.step.failed", (event) =>
        update((previous) =>
          collector.onStepFailed(previous, event.properties),
        ),
      ),
      api.event.on("session.status", (event) => {
        if (event.properties.status.type === "idle") {
          update((previous) =>
            collector.onIdle(previous, event.properties.sessionID),
          );
        }
      }),
      api.event.on("session.error", (event) =>
        update((previous) =>
          collector.onSessionError(
            previous,
            event.properties.sessionID ?? null,
          ),
        ),
      ),
    );

    const liveTimer = setInterval(
      () => update((previous) => collector.tick(previous)),
      config.liveIntervalMs,
    );

    api.slots.register({
      order: config.order,
      slots: {
        sidebar_content(ctx, props) {
          const persistedAverages = (): SessionAverages | undefined => {
            if (!config.showAverages || !api.kv.ready) return undefined;
            const ttft = numberFromKV(
              api.kv.get(`${KV_PREFIX}${props.session_id}:ttft`),
            );
            const decodeTokPerSec = numberFromKV(
              api.kv.get(`${KV_PREFIX}${props.session_id}:decode`),
            );
            if (ttft === undefined || decodeTokPerSec === undefined) {
              return undefined;
            }
            return {
              ttft,
              decodeTokPerSec,
              prefillTokPerSec:
                numberFromKV(
                  api.kv.get(`${KV_PREFIX}${props.session_id}:prefill`),
                ) ?? null,
            };
          };
          const lines = () =>
            buildDisplayLines(sessionMetrics(), props.session_id, config, {
              averages: persistedAverages(),
              cacheRead: cacheReads().get(props.session_id),
            });

          return renderSpeedBlock(
            () => ctx.theme.current.text,
            () => ctx.theme.current.textMuted,
            lines,
          );
        },
      },
    });

    api.lifecycle.onDispose(() => {
      fallback.dispose();
      v1Unsubs.forEach((unsubscribe) => unsubscribe());
      unsubs.forEach((unsubscribe) => unsubscribe());
      clearInterval(liveTimer);
      dispose();
    });
  });
}

const plugin = {
  id: "speed-measure.sidebar",
  /** OpenCode v2 (>= 2.0): the host requires `{ id, setup }` modules. */
  setup: (context: V2Context) => setupV2(context),
  /** OpenCode 1.15–1.x: the host requires `{ id, tui }` modules. */
  tui: async (api: Parameters<TuiPluginModule["tui"]>[0]) => setupLegacy(api),
} satisfies TuiPluginModule & {
  setup: (context: V2Context) => Promise<void | (() => void)>;
};

export default plugin;
