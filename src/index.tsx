/** @jsxImportSource @opentui/solid */

import { createRoot, createSignal } from "solid-js";
import type { TuiPluginModule } from "@opencode-ai/plugin/tui";

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

export const CONFIG_PATH = `${runtimeBun()?.env.HOME ?? ""}/.config/opencode/speed-measure.json`;
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

const plugin = {
  id: "speed-measure.sidebar",
  tui: async (api) => {
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
          update((previous) =>
            collector.onTextDelta(previous, event.properties),
          ),
        ),
        api.event.on("session.next.tool.called", (event) =>
          update((previous) =>
            collector.onToolCalled(previous, event.properties),
          ),
        ),
        api.event.on("session.next.tool.success", (event) =>
          update((previous) =>
            collector.onToolEnded(previous, event.properties),
          ),
        ),
        api.event.on("session.next.tool.failed", (event) =>
          update((previous) =>
            collector.onToolEnded(previous, event.properties),
          ),
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
            const theme = () => ctx.theme.current;
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

            return (
              <box flexDirection="column">
                <text fg={theme().text}>
                  <b>Speed</b>
                </text>
                <text fg={theme().textMuted}>{lines().prefill}</text>
                <text fg={theme().textMuted}>{lines().decode}</text>
              </box>
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
  },
} satisfies TuiPluginModule;

export default plugin;
