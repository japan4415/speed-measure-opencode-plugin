// @ts-expect-error untyped node module
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error untyped package
import { transformSync } from "@babel/core";
// @ts-expect-error untyped package
import solidPreset from "babel-preset-solid";
import * as solidJs from "solid-js";
import * as collectorModule from "../src/collector.js";
import * as formatModule from "../src/format.js";

let rootDisposeSpy: ReturnType<typeof vi.fn> | undefined;

vi.mock("solid-js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("solid-js")>();
  return {
    ...actual,
    createRoot: (fn: (dispose: () => void) => any) => {
      return actual.createRoot((dispose) => {
        const spy = vi.fn(dispose);
        rootDisposeSpy = spy;
        return fn(spy);
      });
    },
  };
});

import {
  MAX_PREFILL_TOK_PER_SEC,
  SpeedCollector,
  type CollectorState,
  type DoneState,
  type SessionMetrics,
} from "../src/collector.js";
import {
  CONFIG_PATH,
  DEFAULT_CONFIG,
  type DisplayExtras,
  type SessionAverages,
  type SpeedMeasureConfig,
  buildDisplayLines,
  calculateSessionAverages,
  loadConfig,
  parseConfig,
  scheduleV1Fallback,
} from "../src/index.js";
import plugin from "../src/index.js";

const SESSIONS = ["sess-A", "sess-B"] as const;
type TestSession = (typeof SESSIONS)[number];
const otherSession = (s: TestSession): TestSession =>
  s === "sess-A" ? "sess-B" : "sess-A";

const V2_EVENT_NAMES = [
  "session.next.step.started",
  "session.next.reasoning.started",
  "session.next.reasoning.delta",
  "session.next.text.started",
  "session.next.text.delta",
  "session.next.tool.called",
  "session.next.tool.success",
  "session.next.tool.failed",
  "session.next.step.ended",
  "session.next.step.failed",
  "session.status",
  "session.error",
] as const;

type EventHandler = (event: {
  type: string;
  properties: Record<string, any>;
}) => void;

type TestElement = {
  type: string;
  props: Record<string, unknown>;
  children: unknown[];
};

type SidebarRegistration = {
  order: number;
  slots: {
    sidebar_content: (
      context: { theme: { current: Record<string, unknown> } },
      props: { session_id: string },
    ) => TestElement;
  };
};

function createApiHarness(kvReady = true) {
  const handlers = new Map<string, Set<EventHandler>>();
  const unsubscribeSpies: Array<ReturnType<typeof vi.fn>> = [];
  const disposeCallbacks: Array<() => void | Promise<void>> = [];
  let registration: SidebarRegistration | undefined;

  const eventOn = vi.fn((type: string, handler: EventHandler) => {
    const current = handlers.get(type) ?? new Set<EventHandler>();
    current.add(handler);
    handlers.set(type, current);
    const unsubscribe = vi.fn(() => current.delete(handler));
    unsubscribeSpies.push(unsubscribe);
    return unsubscribe;
  });
  const register = vi.fn((value: SidebarRegistration) => {
    registration = value;
    return "speed-measure-test-slot";
  });
  const kvGet = vi.fn();
  const kvSet = vi.fn();
  const abortController = new AbortController();

  const api = {
    event: { on: eventOn },
    kv: { ready: kvReady, get: kvGet, set: kvSet },
    lifecycle: {
      signal: abortController.signal,
      onDispose: vi.fn((callback: () => void | Promise<void>) => {
        disposeCallbacks.push(callback);
        return vi.fn();
      }),
    },
    slots: { register },
  } as unknown as Parameters<typeof plugin.tui>[0];

  return {
    api,
    eventOn,
    handlers,
    unsubscribeSpies,
    register,
    kvGet,
    kvSet,
    registration: () => registration,
    emit(type: string, properties: Record<string, any>) {
      for (const handler of [...(handlers.get(type) ?? [])]) {
        handler({ type, properties });
      }
    },
    async dispose() {
      abortController.abort();
      for (const callback of disposeCallbacks) await callback();
    },
  };
}

function stubJsxRuntime() {
  vi.stubGlobal("React", {
    createElement(
      type: string,
      props: Record<string, unknown> | null,
      ...children: unknown[]
    ): TestElement {
      return { type, props: props ?? {}, children };
    },
  });
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || !("children" in value)) return "";
  return (value as TestElement).children.map(textContent).join("");
}

function sidebarRendered(
  registration: SidebarRegistration | undefined,
  sessionID: string = "sess-A",
  theme: { text: string; textMuted: string } = { text: "white", textMuted: "gray" },
): { tree: TestElement; lines: string[]; children: TestElement[] } {
  expect(registration).toBeDefined();
  stubJsxRuntime();
  const tree = registration!.slots.sidebar_content(
    { theme: { current: theme } },
    { session_id: sessionID },
  );
  expect(tree.type).toBe("box");
  expect(tree.props.flexDirection).toBe("column");
  const children = tree.children as TestElement[];
  expect(children).toHaveLength(3);
  expect(children[0].type).toBe("text");
  expect(children[0].props?.fg).toBe(theme.text);
  expect((children[0].children[0] as TestElement)?.type).toBe("b");
  expect(children[1].type).toBe("text");
  expect(children[1].props?.fg).toBe(theme.textMuted);
  expect(children[2].type).toBe("text");
  expect(children[2].props?.fg).toBe(theme.textMuted);
  return {
    tree,
    lines: children.map(textContent),
    children,
  };
}

function sidebarLines(
  registration: SidebarRegistration | undefined,
  sessionID: string = "sess-A",
  theme?: { text: string; textMuted: string },
): string[] {
  return sidebarRendered(registration, sessionID, theme).lines;
}

function emitCompletedV2(
  harness: ReturnType<typeof createApiHarness>,
  sessionID: string = "sess-A",
  tokens = {
    input: 100,
    output: 60,
    reasoning: 0,
    cache: { read: 25, write: 0 },
  },
  timestamps = { t0: 1_000, t1: 1_500, t2: 2_500 },
) {
  harness.emit("session.next.step.started", {
    sessionID,
    assistantMessageID: `message-${sessionID}`,
    timestamp: timestamps.t0,
  });
  harness.emit("session.next.text.started", {
    sessionID,
    assistantMessageID: `message-${sessionID}`,
    textID: `text-${sessionID}`,
    timestamp: timestamps.t1,
  });
  harness.emit("session.next.step.ended", {
    sessionID,
    assistantMessageID: `message-${sessionID}`,
    timestamp: timestamps.t2,
    finish: "stop",
    cost: 0,
    tokens,
  });
}

async function configuredPlugin(
  config: Record<string, unknown>,
  home = "/test-home",
) {
  vi.resetModules();
  const expectedPath = `${home}/.config/opencode/speed-measure.json`;
  const fileSpy = vi.fn((path: string) => {
    if (path === expectedPath) {
      return { text: async () => JSON.stringify(config) };
    }
    return {
      text: () =>
        Promise.reject(
          new Error(`ENOENT: config file not found at expected path: ${path}`),
        ),
    };
  });
  vi.stubGlobal("Bun", {
    env: { HOME: home },
    file: fileSpy,
  });
  const mod = await import("../src/index.js");
  expect(mod.default.id).toBe("speed-measure.sidebar");
  return mod.default;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("plugin metadata", () => {
  it("exports plugin with ID 'speed-measure.sidebar'", () => {
    expect(plugin.id).toBe("speed-measure.sidebar");
  });
});

describe("buildDisplayLines", () => {
  it("shows placeholders for an idle session", () => {
    expect(buildDisplayLines(new Map(), "sess-A")).toEqual({
      prefill: "Prefill: --",
      decode: "Decode:  --",
    });
  });

  it("shows a live estimate while decoding", () => {
    const state: CollectorState = new Map([
      [
        "sess-A",
        {
          current: {
            phase: "decoding",
            sessionID: "sess-A",
            assistantMessageID: "message-1",
            t0: 1_000,
            t1: 1_340,
            ttft: 340,
            liveChars: 30,
            liveEstimate: 45.2,
          },
          stepHistory: [],
        },
      ],
    ]);

    expect(buildDisplayLines(state, "sess-A")).toEqual({
      prefill: "Prefill: 340 ms",
      decode: "Decode:  ~45.2 chars/s",
    });
  });

  it("distinguishes live character throughput from final token throughput", () => {
    const live: CollectorState = new Map([
      [
        "sess-A",
        {
          current: {
            phase: "decoding",
            sessionID: "sess-A",
            assistantMessageID: "message-1",
            t0: 1_000,
            t1: 1_340,
            ttft: 340,
            liveChars: 120,
            liveEstimate: 120,
          },
          stepHistory: [],
        },
      ],
    ]);
    const done = {
      phase: "done" as const,
      sessionID: "sess-A",
      ttft: 340,
      prefillTokPerSec: 2_100,
      decodeTokPerSec: 30,
    };
    const complete: CollectorState = new Map([
      ["sess-A", { current: done, stepHistory: [done] }],
    ]);

    expect(buildDisplayLines(live, "sess-A").decode).toBe(
      "Decode:  ~120 chars/s",
    );
    expect(buildDisplayLines(complete, "sess-A").decode).toBe(
      "Decode:  30 tok/s",
    );
  });

  it("shows final values for a completed step", () => {
    const done = {
      phase: "done" as const,
      sessionID: "sess-A",
      ttft: 340,
      prefillTokPerSec: 2_100,
      decodeTokPerSec: 58.3,
    };
    const state: CollectorState = new Map([
      ["sess-A", { current: done, stepHistory: [done] }],
    ]);

    expect(buildDisplayLines(state, "sess-A")).toEqual({
      prefill: "Prefill: 340 ms │ 2.1k tok/s",
      decode: "Decode:  58.3 tok/s",
    });
  });

  it.each([
    [MAX_PREFILL_TOK_PER_SEC, `Prefill: 1000 ms │ 500k tok/s`],
    [MAX_PREFILL_TOK_PER_SEC + 1, "Prefill: 1000 ms"],
  ] as const)(
    "renders the expected Prefill line at the threshold boundary for %i tok/s",
    (inputTokens, expectedPrefill) => {
      const collector = new SpeedCollector();
      let state = collector.onStepStarted(new Map(), {
        sessionID: "sess-A",
        assistantMessageID: "message-1",
        timestamp: 0,
      });
      state = collector.onTextStarted(state, {
        sessionID: "sess-A",
        assistantMessageID: "message-1",
        timestamp: 1000,
      });
      state = collector.onStepEnded(state, {
        sessionID: "sess-A",
        assistantMessageID: "message-1",
        timestamp: 2000,
        tokens: {
          input: inputTokens,
          output: 1,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      });

      expect(buildDisplayLines(state, "sess-A").prefill).toBe(expectedPrefill);
    },
  );

  it("honors non-default cache and TTFT display gates", () => {
    const done = {
      phase: "done" as const,
      sessionID: "sess-A",
      ttft: 340,
      prefillTokPerSec: 2_100,
      decodeTokPerSec: 58.3,
    };
    const state: CollectorState = new Map([
      ["sess-A", { current: done, stepHistory: [done] }],
    ]);

    expect(
      buildDisplayLines(
        state,
        "sess-A",
        { ...DEFAULT_CONFIG, showCache: true },
        { cacheRead: 512 },
      ).prefill,
    ).toBe("Prefill: 340 ms │ 2.1k tok/s │ cache 512");
    expect(
      buildDisplayLines(
        state,
        "sess-A",
        { ...DEFAULT_CONFIG, showTTFT: false },
        { cacheRead: 512 },
      ).prefill,
    ).toBe("Prefill: 2.1k tok/s");
  });

  it("shows a placeholder when both TTFT and prefill speed are unavailable", () => {
    const done = {
      phase: "done" as const,
      sessionID: "sess-A",
      ttft: 19,
      prefillTokPerSec: null,
      decodeTokPerSec: 58.3,
    };
    const state: CollectorState = new Map([
      ["sess-A", { current: done, stepHistory: [done] }],
    ]);

    expect(
      buildDisplayLines(state, "sess-A", {
        ...DEFAULT_CONFIG,
        showTTFT: false,
      }).prefill,
    ).toBe("Prefill: --");
  });

  it("hides TTFT while decoding when showTTFT is false", () => {
    const state: CollectorState = new Map([
      [
        "sess-A",
        {
          current: {
            phase: "decoding",
            sessionID: "sess-A",
            assistantMessageID: "message-1",
            t0: 1_000,
            t1: 1_340,
            ttft: 340,
            liveChars: 30,
            liveEstimate: 45.2,
          },
          stepHistory: [],
        },
      ],
    ]);

    expect(
      buildDisplayLines(state, "sess-A", {
        ...DEFAULT_CONFIG,
        showTTFT: false,
      }).prefill,
    ).toBe("Prefill: --");
  });

  it("never leaks another session's measurements", () => {
    const done = {
      phase: "done" as const,
      sessionID: "subagent-session",
      ttft: 12,
      prefillTokPerSec: 9_999,
      decodeTokPerSec: 999,
    };
    const state: CollectorState = new Map([
      ["subagent-session", { current: done, stepHistory: [done] }],
    ]);

    expect(buildDisplayLines(state, "parent-session")).toEqual({
      prefill: "Prefill: --",
      decode: "Decode:  --",
    });
  });
});

describe("buildDisplayLines - config combinations × state cross-product matrix", () => {
  type ConfigFlags = Pick<
    SpeedMeasureConfig,
    "showTTFT" | "showAverages" | "showCache"
  >;
  type ConfigKey = `TTFT:${boolean}_Avg:${boolean}_Cache:${boolean}`;

  const CONFIG_COMBINATIONS: readonly ConfigFlags[] = [
    { showTTFT: false, showAverages: false, showCache: false },
    { showTTFT: false, showAverages: false, showCache: true },
    { showTTFT: false, showAverages: true, showCache: false },
    { showTTFT: false, showAverages: true, showCache: true },
    { showTTFT: true, showAverages: false, showCache: false },
    { showTTFT: true, showAverages: false, showCache: true },
    { showTTFT: true, showAverages: true, showCache: false },
    { showTTFT: true, showAverages: true, showCache: true },
  ] as const;

  const toKey = (cfg: ConfigFlags): ConfigKey =>
    `TTFT:${cfg.showTTFT}_Avg:${cfg.showAverages}_Cache:${cfg.showCache}`;

  interface MatrixScenario {
    name: string;
    sessionID?: string;
    state: CollectorState;
    extras?: DisplayExtras;
    expectedByConfig: Record<ConfigKey, { prefill: string; decode: string }>;
  }

  const defaultDoneState = {
    phase: "done" as const,
    sessionID: "sess-A",
    ttft: 340,
    prefillTokPerSec: 2_100,
    decodeTokPerSec: 58.3,
  };

  const doneStateNoPrefill = {
    phase: "done" as const,
    sessionID: "sess-A",
    ttft: 340,
    prefillTokPerSec: null,
    decodeTokPerSec: 58.3,
  };

  const sampleAverages: SessionAverages = {
    ttft: 300,
    prefillTokPerSec: 2_000,
    decodeTokPerSec: 50.0,
  };

  const sampleAveragesNoPrefill: SessionAverages = {
    ttft: 300,
    prefillTokPerSec: null,
    decodeTokPerSec: 50.0,
  };

  const SCENARIOS: MatrixScenario[] = [
    {
      name: "idle phase",
      state: new Map([
        ["sess-A", { current: { phase: "idle" }, stepHistory: [] }],
      ]),
      expectedByConfig: {
        "TTFT:false_Avg:false_Cache:false": { prefill: "Prefill: --", decode: "Decode:  --" },
        "TTFT:false_Avg:false_Cache:true": { prefill: "Prefill: --", decode: "Decode:  --" },
        "TTFT:false_Avg:true_Cache:false": { prefill: "Prefill: --", decode: "Decode:  --" },
        "TTFT:false_Avg:true_Cache:true": { prefill: "Prefill: --", decode: "Decode:  --" },
        "TTFT:true_Avg:false_Cache:false": { prefill: "Prefill: --", decode: "Decode:  --" },
        "TTFT:true_Avg:false_Cache:true": { prefill: "Prefill: --", decode: "Decode:  --" },
        "TTFT:true_Avg:true_Cache:false": { prefill: "Prefill: --", decode: "Decode:  --" },
        "TTFT:true_Avg:true_Cache:true": { prefill: "Prefill: --", decode: "Decode:  --" },
      },
    },
    {
      name: "prefilling phase",
      state: new Map([
        [
          "sess-A",
          {
            current: {
              phase: "prefilling",
              sessionID: "sess-A",
              assistantMessageID: "msg-1",
              t0: 1_000,
            },
            stepHistory: [],
          },
        ],
      ]),
      expectedByConfig: {
        "TTFT:false_Avg:false_Cache:false": { prefill: "Prefill: …", decode: "Decode:  --" },
        "TTFT:false_Avg:false_Cache:true": { prefill: "Prefill: …", decode: "Decode:  --" },
        "TTFT:false_Avg:true_Cache:false": { prefill: "Prefill: …", decode: "Decode:  --" },
        "TTFT:false_Avg:true_Cache:true": { prefill: "Prefill: …", decode: "Decode:  --" },
        "TTFT:true_Avg:false_Cache:false": { prefill: "Prefill: …", decode: "Decode:  --" },
        "TTFT:true_Avg:false_Cache:true": { prefill: "Prefill: …", decode: "Decode:  --" },
        "TTFT:true_Avg:true_Cache:false": { prefill: "Prefill: …", decode: "Decode:  --" },
        "TTFT:true_Avg:true_Cache:true": { prefill: "Prefill: …", decode: "Decode:  --" },
      },
    },
    {
      name: "decoding phase (with live estimate)",
      state: new Map([
        [
          "sess-A",
          {
            current: {
              phase: "decoding",
              sessionID: "sess-A",
              assistantMessageID: "msg-1",
              t0: 1_000,
              t1: 1_340,
              ttft: 340,
              liveChars: 30,
              liveEstimate: 45.2,
            },
            stepHistory: [],
          },
        ],
      ]),
      expectedByConfig: {
        "TTFT:false_Avg:false_Cache:false": { prefill: "Prefill: --", decode: "Decode:  ~45.2 chars/s" },
        "TTFT:false_Avg:false_Cache:true": { prefill: "Prefill: --", decode: "Decode:  ~45.2 chars/s" },
        "TTFT:false_Avg:true_Cache:false": { prefill: "Prefill: --", decode: "Decode:  ~45.2 chars/s" },
        "TTFT:false_Avg:true_Cache:true": { prefill: "Prefill: --", decode: "Decode:  ~45.2 chars/s" },
        "TTFT:true_Avg:false_Cache:false": { prefill: "Prefill: 340 ms", decode: "Decode:  ~45.2 chars/s" },
        "TTFT:true_Avg:false_Cache:true": { prefill: "Prefill: 340 ms", decode: "Decode:  ~45.2 chars/s" },
        "TTFT:true_Avg:true_Cache:false": { prefill: "Prefill: 340 ms", decode: "Decode:  ~45.2 chars/s" },
        "TTFT:true_Avg:true_Cache:true": { prefill: "Prefill: 340 ms", decode: "Decode:  ~45.2 chars/s" },
      },
    },
    {
      name: "decoding phase (without live estimate, null)",
      state: new Map([
        [
          "sess-A",
          {
            current: {
              phase: "decoding",
              sessionID: "sess-A",
              assistantMessageID: "msg-1",
              t0: 1_000,
              t1: 1_340,
              ttft: 340,
              liveChars: 0,
              liveEstimate: null,
            },
            stepHistory: [],
          },
        ],
      ]),
      expectedByConfig: {
        "TTFT:false_Avg:false_Cache:false": { prefill: "Prefill: --", decode: "Decode:  …" },
        "TTFT:false_Avg:false_Cache:true": { prefill: "Prefill: --", decode: "Decode:  …" },
        "TTFT:false_Avg:true_Cache:false": { prefill: "Prefill: --", decode: "Decode:  …" },
        "TTFT:false_Avg:true_Cache:true": { prefill: "Prefill: --", decode: "Decode:  …" },
        "TTFT:true_Avg:false_Cache:false": { prefill: "Prefill: 340 ms", decode: "Decode:  …" },
        "TTFT:true_Avg:false_Cache:true": { prefill: "Prefill: 340 ms", decode: "Decode:  …" },
        "TTFT:true_Avg:true_Cache:false": { prefill: "Prefill: 340 ms", decode: "Decode:  …" },
        "TTFT:true_Avg:true_Cache:true": { prefill: "Prefill: 340 ms", decode: "Decode:  …" },
      },
    },
    {
      name: "error phase",
      state: new Map([
        ["sess-A", { current: { phase: "error", sessionID: "sess-A" }, stepHistory: [] }],
      ]),
      expectedByConfig: {
        "TTFT:false_Avg:false_Cache:false": { prefill: "Prefill: error", decode: "Decode:  error" },
        "TTFT:false_Avg:false_Cache:true": { prefill: "Prefill: error", decode: "Decode:  error" },
        "TTFT:false_Avg:true_Cache:false": { prefill: "Prefill: error", decode: "Decode:  error" },
        "TTFT:false_Avg:true_Cache:true": { prefill: "Prefill: error", decode: "Decode:  error" },
        "TTFT:true_Avg:false_Cache:false": { prefill: "Prefill: error", decode: "Decode:  error" },
        "TTFT:true_Avg:false_Cache:true": { prefill: "Prefill: error", decode: "Decode:  error" },
        "TTFT:true_Avg:true_Cache:false": { prefill: "Prefill: error", decode: "Decode:  error" },
        "TTFT:true_Avg:true_Cache:true": { prefill: "Prefill: error", decode: "Decode:  error" },
      },
    },
    {
      name: "done (prefill 2.1k, cache 25, explicit averages)",
      state: new Map([
        ["sess-A", { current: defaultDoneState, stepHistory: [defaultDoneState] }],
      ]),
      extras: { cacheRead: 25, averages: sampleAverages },
      expectedByConfig: {
        "TTFT:false_Avg:false_Cache:false": {
          prefill: "Prefill: 2.1k tok/s",
          decode: "Decode:  58.3 tok/s",
        },
        "TTFT:false_Avg:false_Cache:true": {
          prefill: "Prefill: 2.1k tok/s │ cache 25",
          decode: "Decode:  58.3 tok/s",
        },
        "TTFT:false_Avg:true_Cache:false": {
          prefill: "Prefill: 2.1k (avg 2.0k) tok/s",
          decode: "Decode:  58.3 (avg 50) tok/s",
        },
        "TTFT:false_Avg:true_Cache:true": {
          prefill: "Prefill: 2.1k (avg 2.0k) tok/s │ cache 25",
          decode: "Decode:  58.3 (avg 50) tok/s",
        },
        "TTFT:true_Avg:false_Cache:false": {
          prefill: "Prefill: 340 ms │ 2.1k tok/s",
          decode: "Decode:  58.3 tok/s",
        },
        "TTFT:true_Avg:false_Cache:true": {
          prefill: "Prefill: 340 ms │ 2.1k tok/s │ cache 25",
          decode: "Decode:  58.3 tok/s",
        },
        "TTFT:true_Avg:true_Cache:false": {
          prefill: "Prefill: 340 ms (avg 300 ms)",
          decode: "Decode:  58.3 (avg 50) tok/s",
        },
        "TTFT:true_Avg:true_Cache:true": {
          prefill: "Prefill: 340 ms (avg 300 ms) │ cache 25",
          decode: "Decode:  58.3 (avg 50) tok/s",
        },
      },
    },
    {
      name: "done (prefill 2.1k, cache 0, explicit averages)",
      state: new Map([
        ["sess-A", { current: defaultDoneState, stepHistory: [defaultDoneState] }],
      ]),
      extras: { cacheRead: 0, averages: sampleAverages },
      expectedByConfig: {
        "TTFT:false_Avg:false_Cache:false": {
          prefill: "Prefill: 2.1k tok/s",
          decode: "Decode:  58.3 tok/s",
        },
        "TTFT:false_Avg:false_Cache:true": {
          prefill: "Prefill: 2.1k tok/s │ cache 0",
          decode: "Decode:  58.3 tok/s",
        },
        "TTFT:false_Avg:true_Cache:false": {
          prefill: "Prefill: 2.1k (avg 2.0k) tok/s",
          decode: "Decode:  58.3 (avg 50) tok/s",
        },
        "TTFT:false_Avg:true_Cache:true": {
          prefill: "Prefill: 2.1k (avg 2.0k) tok/s │ cache 0",
          decode: "Decode:  58.3 (avg 50) tok/s",
        },
        "TTFT:true_Avg:false_Cache:false": {
          prefill: "Prefill: 340 ms │ 2.1k tok/s",
          decode: "Decode:  58.3 tok/s",
        },
        "TTFT:true_Avg:false_Cache:true": {
          prefill: "Prefill: 340 ms │ 2.1k tok/s │ cache 0",
          decode: "Decode:  58.3 tok/s",
        },
        "TTFT:true_Avg:true_Cache:false": {
          prefill: "Prefill: 340 ms (avg 300 ms)",
          decode: "Decode:  58.3 (avg 50) tok/s",
        },
        "TTFT:true_Avg:true_Cache:true": {
          prefill: "Prefill: 340 ms (avg 300 ms) │ cache 0",
          decode: "Decode:  58.3 (avg 50) tok/s",
        },
      },
    },
    {
      name: "done (prefill 2.1k, cache undefined, explicit averages)",
      state: new Map([
        ["sess-A", { current: defaultDoneState, stepHistory: [defaultDoneState] }],
      ]),
      extras: { averages: sampleAverages },
      expectedByConfig: {
        "TTFT:false_Avg:false_Cache:false": {
          prefill: "Prefill: 2.1k tok/s",
          decode: "Decode:  58.3 tok/s",
        },
        "TTFT:false_Avg:false_Cache:true": {
          prefill: "Prefill: 2.1k tok/s",
          decode: "Decode:  58.3 tok/s",
        },
        "TTFT:false_Avg:true_Cache:false": {
          prefill: "Prefill: 2.1k (avg 2.0k) tok/s",
          decode: "Decode:  58.3 (avg 50) tok/s",
        },
        "TTFT:false_Avg:true_Cache:true": {
          prefill: "Prefill: 2.1k (avg 2.0k) tok/s",
          decode: "Decode:  58.3 (avg 50) tok/s",
        },
        "TTFT:true_Avg:false_Cache:false": {
          prefill: "Prefill: 340 ms │ 2.1k tok/s",
          decode: "Decode:  58.3 tok/s",
        },
        "TTFT:true_Avg:false_Cache:true": {
          prefill: "Prefill: 340 ms │ 2.1k tok/s",
          decode: "Decode:  58.3 tok/s",
        },
        "TTFT:true_Avg:true_Cache:false": {
          prefill: "Prefill: 340 ms (avg 300 ms)",
          decode: "Decode:  58.3 (avg 50) tok/s",
        },
        "TTFT:true_Avg:true_Cache:true": {
          prefill: "Prefill: 340 ms (avg 300 ms)",
          decode: "Decode:  58.3 (avg 50) tok/s",
        },
      },
    },
    {
      name: "done (prefill null, cache 25, explicit averages)",
      state: new Map([
        ["sess-A", { current: doneStateNoPrefill, stepHistory: [doneStateNoPrefill] }],
      ]),
      extras: { cacheRead: 25, averages: sampleAveragesNoPrefill },
      expectedByConfig: {
        "TTFT:false_Avg:false_Cache:false": {
          prefill: "Prefill: --",
          decode: "Decode:  58.3 tok/s",
        },
        "TTFT:false_Avg:false_Cache:true": {
          prefill: "Prefill: -- │ cache 25",
          decode: "Decode:  58.3 tok/s",
        },
        "TTFT:false_Avg:true_Cache:false": {
          prefill: "Prefill: --",
          decode: "Decode:  58.3 (avg 50) tok/s",
        },
        "TTFT:false_Avg:true_Cache:true": {
          prefill: "Prefill: -- │ cache 25",
          decode: "Decode:  58.3 (avg 50) tok/s",
        },
        "TTFT:true_Avg:false_Cache:false": {
          prefill: "Prefill: 340 ms",
          decode: "Decode:  58.3 tok/s",
        },
        "TTFT:true_Avg:false_Cache:true": {
          prefill: "Prefill: 340 ms │ cache 25",
          decode: "Decode:  58.3 tok/s",
        },
        "TTFT:true_Avg:true_Cache:false": {
          prefill: "Prefill: 340 ms (avg 300 ms)",
          decode: "Decode:  58.3 (avg 50) tok/s",
        },
        "TTFT:true_Avg:true_Cache:true": {
          prefill: "Prefill: 340 ms (avg 300 ms) │ cache 25",
          decode: "Decode:  58.3 (avg 50) tok/s",
        },
      },
    },
    {
      name: "done (prefill null, cache 0, explicit averages)",
      state: new Map([
        ["sess-A", { current: doneStateNoPrefill, stepHistory: [doneStateNoPrefill] }],
      ]),
      extras: { cacheRead: 0, averages: sampleAveragesNoPrefill },
      expectedByConfig: {
        "TTFT:false_Avg:false_Cache:false": {
          prefill: "Prefill: --",
          decode: "Decode:  58.3 tok/s",
        },
        "TTFT:false_Avg:false_Cache:true": {
          prefill: "Prefill: -- │ cache 0",
          decode: "Decode:  58.3 tok/s",
        },
        "TTFT:false_Avg:true_Cache:false": {
          prefill: "Prefill: --",
          decode: "Decode:  58.3 (avg 50) tok/s",
        },
        "TTFT:false_Avg:true_Cache:true": {
          prefill: "Prefill: -- │ cache 0",
          decode: "Decode:  58.3 (avg 50) tok/s",
        },
        "TTFT:true_Avg:false_Cache:false": {
          prefill: "Prefill: 340 ms",
          decode: "Decode:  58.3 tok/s",
        },
        "TTFT:true_Avg:false_Cache:true": {
          prefill: "Prefill: 340 ms │ cache 0",
          decode: "Decode:  58.3 tok/s",
        },
        "TTFT:true_Avg:true_Cache:false": {
          prefill: "Prefill: 340 ms (avg 300 ms)",
          decode: "Decode:  58.3 (avg 50) tok/s",
        },
        "TTFT:true_Avg:true_Cache:true": {
          prefill: "Prefill: 340 ms (avg 300 ms) │ cache 0",
          decode: "Decode:  58.3 (avg 50) tok/s",
        },
      },
    },
    {
      name: "done (prefill null, cache undefined, explicit averages)",
      state: new Map([
        ["sess-A", { current: doneStateNoPrefill, stepHistory: [doneStateNoPrefill] }],
      ]),
      extras: { averages: sampleAveragesNoPrefill },
      expectedByConfig: {
        "TTFT:false_Avg:false_Cache:false": {
          prefill: "Prefill: --",
          decode: "Decode:  58.3 tok/s",
        },
        "TTFT:false_Avg:false_Cache:true": {
          prefill: "Prefill: --",
          decode: "Decode:  58.3 tok/s",
        },
        "TTFT:false_Avg:true_Cache:false": {
          prefill: "Prefill: --",
          decode: "Decode:  58.3 (avg 50) tok/s",
        },
        "TTFT:false_Avg:true_Cache:true": {
          prefill: "Prefill: --",
          decode: "Decode:  58.3 (avg 50) tok/s",
        },
        "TTFT:true_Avg:false_Cache:false": {
          prefill: "Prefill: 340 ms",
          decode: "Decode:  58.3 tok/s",
        },
        "TTFT:true_Avg:false_Cache:true": {
          prefill: "Prefill: 340 ms",
          decode: "Decode:  58.3 tok/s",
        },
        "TTFT:true_Avg:true_Cache:false": {
          prefill: "Prefill: 340 ms (avg 300 ms)",
          decode: "Decode:  58.3 (avg 50) tok/s",
        },
        "TTFT:true_Avg:true_Cache:true": {
          prefill: "Prefill: 340 ms (avg 300 ms)",
          decode: "Decode:  58.3 (avg 50) tok/s",
        },
      },
    },
    {
      name: "done (prefill 2.1k, averages.prefillTokPerSec null, cache undefined)",
      state: new Map([
        ["sess-A", { current: defaultDoneState, stepHistory: [defaultDoneState] }],
      ]),
      extras: { averages: sampleAveragesNoPrefill },
      expectedByConfig: {
        "TTFT:false_Avg:false_Cache:false": {
          prefill: "Prefill: 2.1k tok/s",
          decode: "Decode:  58.3 tok/s",
        },
        "TTFT:false_Avg:false_Cache:true": {
          prefill: "Prefill: 2.1k tok/s",
          decode: "Decode:  58.3 tok/s",
        },
        "TTFT:false_Avg:true_Cache:false": {
          prefill: "Prefill: 2.1k tok/s",
          decode: "Decode:  58.3 (avg 50) tok/s",
        },
        "TTFT:false_Avg:true_Cache:true": {
          prefill: "Prefill: 2.1k tok/s",
          decode: "Decode:  58.3 (avg 50) tok/s",
        },
        "TTFT:true_Avg:false_Cache:false": {
          prefill: "Prefill: 340 ms │ 2.1k tok/s",
          decode: "Decode:  58.3 tok/s",
        },
        "TTFT:true_Avg:false_Cache:true": {
          prefill: "Prefill: 340 ms │ 2.1k tok/s",
          decode: "Decode:  58.3 tok/s",
        },
        "TTFT:true_Avg:true_Cache:false": {
          prefill: "Prefill: 340 ms (avg 300 ms)",
          decode: "Decode:  58.3 (avg 50) tok/s",
        },
        "TTFT:true_Avg:true_Cache:true": {
          prefill: "Prefill: 340 ms (avg 300 ms)",
          decode: "Decode:  58.3 (avg 50) tok/s",
        },
      },
    },
    {
      name: "done (prefill 2.1k, cache 25, averages auto-calculated from history)",
      state: new Map([
        ["sess-A", { current: defaultDoneState, stepHistory: [defaultDoneState] }],
      ]),
      extras: { cacheRead: 25 },
      expectedByConfig: {
        "TTFT:false_Avg:false_Cache:false": {
          prefill: "Prefill: 2.1k tok/s",
          decode: "Decode:  58.3 tok/s",
        },
        "TTFT:false_Avg:false_Cache:true": {
          prefill: "Prefill: 2.1k tok/s │ cache 25",
          decode: "Decode:  58.3 tok/s",
        },
        "TTFT:false_Avg:true_Cache:false": {
          prefill: "Prefill: 2.1k (avg 2.1k) tok/s",
          decode: "Decode:  58.3 (avg 58.3) tok/s",
        },
        "TTFT:false_Avg:true_Cache:true": {
          prefill: "Prefill: 2.1k (avg 2.1k) tok/s │ cache 25",
          decode: "Decode:  58.3 (avg 58.3) tok/s",
        },
        "TTFT:true_Avg:false_Cache:false": {
          prefill: "Prefill: 340 ms │ 2.1k tok/s",
          decode: "Decode:  58.3 tok/s",
        },
        "TTFT:true_Avg:false_Cache:true": {
          prefill: "Prefill: 340 ms │ 2.1k tok/s │ cache 25",
          decode: "Decode:  58.3 tok/s",
        },
        "TTFT:true_Avg:true_Cache:false": {
          prefill: "Prefill: 340 ms (avg 340 ms)",
          decode: "Decode:  58.3 (avg 58.3) tok/s",
        },
        "TTFT:true_Avg:true_Cache:true": {
          prefill: "Prefill: 340 ms (avg 340 ms) │ cache 25",
          decode: "Decode:  58.3 (avg 58.3) tok/s",
        },
      },
    },
    {
      name: "done (prefill null, cache undefined, no averages)",
      state: new Map([
        ["sess-A", { current: doneStateNoPrefill, stepHistory: [] }],
      ]),
      expectedByConfig: {
        "TTFT:false_Avg:false_Cache:false": { prefill: "Prefill: --", decode: "Decode:  58.3 tok/s" },
        "TTFT:false_Avg:false_Cache:true": { prefill: "Prefill: --", decode: "Decode:  58.3 tok/s" },
        "TTFT:false_Avg:true_Cache:false": { prefill: "Prefill: --", decode: "Decode:  58.3 (avg 58.3) tok/s" },
        "TTFT:false_Avg:true_Cache:true": { prefill: "Prefill: --", decode: "Decode:  58.3 (avg 58.3) tok/s" },
        "TTFT:true_Avg:false_Cache:false": { prefill: "Prefill: 340 ms", decode: "Decode:  58.3 tok/s" },
        "TTFT:true_Avg:false_Cache:true": { prefill: "Prefill: 340 ms", decode: "Decode:  58.3 tok/s" },
        "TTFT:true_Avg:true_Cache:false": { prefill: "Prefill: 340 ms (avg 340 ms)", decode: "Decode:  58.3 (avg 58.3) tok/s" },
        "TTFT:true_Avg:true_Cache:true": { prefill: "Prefill: 340 ms (avg 340 ms)", decode: "Decode:  58.3 (avg 58.3) tok/s" },
      },
    },
    {
      name: "unknown / absent session metrics",
      sessionID: "sess-absent",
      state: new Map(),
      expectedByConfig: {
        "TTFT:false_Avg:false_Cache:false": { prefill: "Prefill: --", decode: "Decode:  --" },
        "TTFT:false_Avg:false_Cache:true": { prefill: "Prefill: --", decode: "Decode:  --" },
        "TTFT:false_Avg:true_Cache:false": { prefill: "Prefill: --", decode: "Decode:  --" },
        "TTFT:false_Avg:true_Cache:true": { prefill: "Prefill: --", decode: "Decode:  --" },
        "TTFT:true_Avg:false_Cache:false": { prefill: "Prefill: --", decode: "Decode:  --" },
        "TTFT:true_Avg:false_Cache:true": { prefill: "Prefill: --", decode: "Decode:  --" },
        "TTFT:true_Avg:true_Cache:false": { prefill: "Prefill: --", decode: "Decode:  --" },
        "TTFT:true_Avg:true_Cache:true": { prefill: "Prefill: --", decode: "Decode:  --" },
      },
    },
  ];

  const MATRIX_CASES = SCENARIOS.flatMap((scenario) =>
    CONFIG_COMBINATIONS.map((config) => {
      const configKey = toKey(config);
      return {
        scenarioName: scenario.name,
        configKey,
        config,
        sessionID: scenario.sessionID ?? "sess-A",
        state: scenario.state,
        extras: scenario.extras ?? {},
        expected: scenario.expectedByConfig[configKey],
      };
    }),
  );

  it.each(MATRIX_CASES)(
    "$scenarioName [$configKey]",
    ({ config, sessionID, state, extras, expected }) => {
      const result = buildDisplayLines(
        state,
        sessionID,
        { ...DEFAULT_CONFIG, ...config },
        extras,
      );
      expect(result).toEqual(expected);
    },
  );
});

describe("parseConfig", () => {
  it("fixes the documented default slot order at 150", () => {
    expect(DEFAULT_CONFIG.order).toBe(150);
    expect(parseConfig("{}").order).toBe(150);
  });

  it("uses defaults when JSON parsing fails or input is malformed", () => {
    expect(parseConfig("{not valid json")).toEqual(DEFAULT_CONFIG);
    expect(parseConfig("")).toEqual(DEFAULT_CONFIG);
    expect(parseConfig("{")).toEqual(DEFAULT_CONFIG);
  });

  it("falls back to DEFAULT_CONFIG when root value is not a record", () => {
    expect(parseConfig("null")).toEqual(DEFAULT_CONFIG);
    expect(parseConfig("[]")).toEqual(DEFAULT_CONFIG);
    expect(parseConfig("[1, 2, 3]")).toEqual(DEFAULT_CONFIG);
    expect(parseConfig('"string"')).toEqual(DEFAULT_CONFIG);
    expect(parseConfig("123")).toEqual(DEFAULT_CONFIG);
    expect(parseConfig("true")).toEqual(DEFAULT_CONFIG);
    expect(parseConfig("false")).toEqual(DEFAULT_CONFIG);
  });

  it("validates showTTFT: accepts boolean, falls back to default (true) for non-boolean types", () => {
    // Valid booleans
    expect(parseConfig('{"showTTFT": false}').showTTFT).toBe(false);
    expect(parseConfig('{"showTTFT": true}').showTTFT).toBe(true);

    // Invalid non-boolean types -> falls back to DEFAULT_CONFIG.showTTFT (true)
    expect(parseConfig('{"showTTFT": "true"}').showTTFT).toBe(true);
    expect(parseConfig('{"showTTFT": "false"}').showTTFT).toBe(true);
    expect(parseConfig('{"showTTFT": 1}').showTTFT).toBe(true);
    expect(parseConfig('{"showTTFT": 0}').showTTFT).toBe(true);
    expect(parseConfig('{"showTTFT": null}').showTTFT).toBe(true);
    expect(parseConfig('{"showTTFT": []}').showTTFT).toBe(true);
    expect(parseConfig('{"showTTFT": {}}').showTTFT).toBe(true);
  });

  it("validates showAverages: accepts boolean, falls back to default (false) for non-boolean types", () => {
    // Valid booleans
    expect(parseConfig('{"showAverages": true}').showAverages).toBe(true);
    expect(parseConfig('{"showAverages": false}').showAverages).toBe(false);

    // Invalid non-boolean types -> falls back to DEFAULT_CONFIG.showAverages (false)
    expect(parseConfig('{"showAverages": "true"}').showAverages).toBe(false);
    expect(parseConfig('{"showAverages": "false"}').showAverages).toBe(false);
    expect(parseConfig('{"showAverages": 1}').showAverages).toBe(false);
    expect(parseConfig('{"showAverages": 0}').showAverages).toBe(false);
    expect(parseConfig('{"showAverages": null}').showAverages).toBe(false);
    expect(parseConfig('{"showAverages": []}').showAverages).toBe(false);
    expect(parseConfig('{"showAverages": {}}').showAverages).toBe(false);
  });

  it("validates showCache: accepts boolean, falls back to default (false) for non-boolean types", () => {
    // Valid booleans
    expect(parseConfig('{"showCache": true}').showCache).toBe(true);
    expect(parseConfig('{"showCache": false}').showCache).toBe(false);

    // Invalid non-boolean types -> falls back to DEFAULT_CONFIG.showCache (false)
    expect(parseConfig('{"showCache": "true"}').showCache).toBe(false);
    expect(parseConfig('{"showCache": "false"}').showCache).toBe(false);
    expect(parseConfig('{"showCache": 1}').showCache).toBe(false);
    expect(parseConfig('{"showCache": 0}').showCache).toBe(false);
    expect(parseConfig('{"showCache": null}').showCache).toBe(false);
    expect(parseConfig('{"showCache": []}').showCache).toBe(false);
    expect(parseConfig('{"showCache": {}}').showCache).toBe(false);
  });

  it("validates liveIntervalMs: accepts finite numbers > 0, falls back to default (150) otherwise", () => {
    // Valid finite numbers > 0
    expect(parseConfig('{"liveIntervalMs": 200}').liveIntervalMs).toBe(200);
    expect(parseConfig('{"liveIntervalMs": 1}').liveIntervalMs).toBe(1);
    expect(parseConfig('{"liveIntervalMs": 50.5}').liveIntervalMs).toBe(50.5);
    expect(parseConfig('{"liveIntervalMs": 0.1}').liveIntervalMs).toBe(0.1);

    // Invalid: non-number types -> falls back to 150
    expect(parseConfig('{"liveIntervalMs": "150"}').liveIntervalMs).toBe(150);
    expect(parseConfig('{"liveIntervalMs": "200"}').liveIntervalMs).toBe(150);
    expect(parseConfig('{"liveIntervalMs": null}').liveIntervalMs).toBe(150);
    expect(parseConfig('{"liveIntervalMs": []}').liveIntervalMs).toBe(150);
    expect(parseConfig('{"liveIntervalMs": {}}').liveIntervalMs).toBe(150);
    expect(parseConfig('{"liveIntervalMs": true}').liveIntervalMs).toBe(150);

    // Invalid: non-positive numbers (<= 0) -> falls back to 150
    expect(parseConfig('{"liveIntervalMs": 0}').liveIntervalMs).toBe(150);
    expect(parseConfig('{"liveIntervalMs": -1}').liveIntervalMs).toBe(150);
    expect(parseConfig('{"liveIntervalMs": -0.5}').liveIntervalMs).toBe(150);
    expect(parseConfig('{"liveIntervalMs": -100}').liveIntervalMs).toBe(150);

    // Invalid: non-finite numbers (Infinity, -Infinity, NaN) -> falls back to 150
    expect(parseConfig('{"liveIntervalMs": 1e1000}').liveIntervalMs).toBe(150);
    expect(parseConfig('{"liveIntervalMs": -1e1000}').liveIntervalMs).toBe(150);

    const jsonParseSpy = vi.spyOn(JSON, "parse");
    jsonParseSpy.mockReturnValueOnce({ liveIntervalMs: NaN });
    expect(parseConfig("{}").liveIntervalMs).toBe(150);
    jsonParseSpy.mockReturnValueOnce({ liveIntervalMs: Infinity });
    expect(parseConfig("{}").liveIntervalMs).toBe(150);
    jsonParseSpy.mockReturnValueOnce({ liveIntervalMs: -Infinity });
    expect(parseConfig("{}").liveIntervalMs).toBe(150);
    jsonParseSpy.mockRestore();
  });

  it("validates order: accepts finite numbers (including 0, negative, float), falls back to default (150) for non-numbers or non-finite", () => {
    // Valid finite numbers
    expect(parseConfig('{"order": 0}').order).toBe(0);
    expect(parseConfig('{"order": -10}').order).toBe(-10);
    expect(parseConfig('{"order": -0.5}').order).toBe(-0.5);
    expect(parseConfig('{"order": 42.5}').order).toBe(42.5);
    expect(parseConfig('{"order": 200}').order).toBe(200);

    // Invalid non-number types -> falls back to 150
    expect(parseConfig('{"order": "150"}').order).toBe(150);
    expect(parseConfig('{"order": "0"}').order).toBe(150);
    expect(parseConfig('{"order": "-10"}').order).toBe(150);
    expect(parseConfig('{"order": null}').order).toBe(150);
    expect(parseConfig('{"order": []}').order).toBe(150);
    expect(parseConfig('{"order": {}}').order).toBe(150);
    expect(parseConfig('{"order": true}').order).toBe(150);
    expect(parseConfig('{"order": false}').order).toBe(150);

    // Invalid: non-finite numbers (Infinity, -Infinity, NaN) -> falls back to 150
    expect(parseConfig('{"order": 1e1000}').order).toBe(150);
    expect(parseConfig('{"order": -1e1000}').order).toBe(150);

    const jsonParseSpy = vi.spyOn(JSON, "parse");
    jsonParseSpy.mockReturnValueOnce({ order: NaN });
    expect(parseConfig("{}").order).toBe(150);
    jsonParseSpy.mockReturnValueOnce({ order: Infinity });
    expect(parseConfig("{}").order).toBe(150);
    jsonParseSpy.mockReturnValueOnce({ order: -Infinity });
    expect(parseConfig("{}").order).toBe(150);
    jsonParseSpy.mockRestore();
  });

  it("ignores unknown keys and only returns known config properties", () => {
    const parsed = parseConfig(
      JSON.stringify({
        unknownKey: "value",
        anotherExtra: 12345,
        showTTFT: false,
      }),
    );
    expect(parsed).toEqual({
      showTTFT: false,
      showAverages: false,
      showCache: false,
      liveIntervalMs: 150,
      order: 150,
    });
    expect(Object.keys(parsed).sort()).toEqual(
      ["showTTFT", "showAverages", "showCache", "liveIntervalMs", "order"].sort(),
    );
  });

  it("accepts valid fields and defaults invalid field values independently", () => {
    expect(
      parseConfig(
        JSON.stringify({
          showTTFT: false,
          showAverages: true,
          showCache: true,
          liveIntervalMs: -1,
          order: 175,
        }),
      ),
    ).toEqual({
      showTTFT: false,
      showAverages: true,
      showCache: true,
      liveIntervalMs: 150,
      order: 175,
    });

    expect(
      parseConfig(
        JSON.stringify({
          showTTFT: "invalid",
          showAverages: "invalid",
          showCache: "invalid",
          liveIntervalMs: 250,
          order: "invalid",
        }),
      ),
    ).toEqual({
      showTTFT: true,
      showAverages: false,
      showCache: false,
      liveIntervalMs: 250,
      order: 150,
    });
  });
});

describe("calculateSessionAverages", () => {
  it("returns undefined when metrics is undefined", () => {
    expect(calculateSessionAverages(undefined)).toBeUndefined();
  });

  it("returns undefined when stepHistory is empty and current phase is not done", () => {
    expect(
      calculateSessionAverages({
        stepHistory: [],
        current: { phase: "idle" },
      }),
    ).toBeUndefined();

    expect(
      calculateSessionAverages({
        stepHistory: [],
        current: {
          phase: "prefilling",
          sessionID: "sess-A",
          assistantMessageID: "msg-1",
          t0: 1000,
        },
      }),
    ).toBeUndefined();

    expect(
      calculateSessionAverages({
        stepHistory: [],
        current: {
          phase: "decoding",
          sessionID: "sess-A",
          assistantMessageID: "msg-1",
          t0: 1000,
          t1: 1200,
          ttft: 200,
          liveChars: 10,
          liveEstimate: null,
        },
      }),
    ).toBeUndefined();

    expect(
      calculateSessionAverages({
        stepHistory: [],
        current: { phase: "error", sessionID: "sess-A" },
      }),
    ).toBeUndefined();
  });

  it("falls back to current when stepHistory is empty and current phase is done", () => {
    const averagesWithPrefill = calculateSessionAverages({
      stepHistory: [],
      current: {
        phase: "done",
        sessionID: "sess-A",
        ttft: 250,
        decodeTokPerSec: 60,
        prefillTokPerSec: 120,
      },
    });
    expect(averagesWithPrefill).toEqual({
      ttft: 250,
      decodeTokPerSec: 60,
      prefillTokPerSec: 120,
    });

    const averagesWithoutPrefill = calculateSessionAverages({
      stepHistory: [],
      current: {
        phase: "done",
        sessionID: "sess-A",
        ttft: 300,
        decodeTokPerSec: 40,
        prefillTokPerSec: null,
      },
    });
    expect(averagesWithoutPrefill).toEqual({
      ttft: 300,
      decodeTokPerSec: 40,
      prefillTokPerSec: null,
    });
  });

  it("calculates averages correctly when stepHistory has a single step", () => {
    const averages = calculateSessionAverages({
      stepHistory: [
        {
          phase: "done",
          sessionID: "sess-A",
          ttft: 180,
          decodeTokPerSec: 55,
          prefillTokPerSec: 110,
        },
      ],
      current: { phase: "idle" },
    });
    expect(averages).toEqual({
      ttft: 180,
      decodeTokPerSec: 55,
      prefillTokPerSec: 110,
    });
  });

  it("calculates averages across multiple steps with all non-null prefill speeds", () => {
    const averages = calculateSessionAverages({
      stepHistory: [
        {
          phase: "done",
          sessionID: "sess-A",
          ttft: 100,
          decodeTokPerSec: 40,
          prefillTokPerSec: 100,
        },
        {
          phase: "done",
          sessionID: "sess-A",
          ttft: 300,
          decodeTokPerSec: 80,
          prefillTokPerSec: 200,
        },
      ],
      current: { phase: "idle" },
    });
    expect(averages).toEqual({
      ttft: 200,
      decodeTokPerSec: 60,
      prefillTokPerSec: 150,
    });
  });

  it("excludes null prefillTokPerSec and does NOT include null as 0 in prefill average", () => {
    // 3 steps: step 1 = 100, step 2 = null, step 3 = 300
    // Non-null prefill values: [100, 300] -> mean = 200
    // If null was treated as 0: [100, 0, 300] -> mean = 133.333...
    const mixedMetrics: SessionMetrics = {
      stepHistory: [
        {
          phase: "done",
          sessionID: "sess-A",
          ttft: 100,
          decodeTokPerSec: 50,
          prefillTokPerSec: 100,
        },
        {
          phase: "done",
          sessionID: "sess-A",
          ttft: 200,
          decodeTokPerSec: 60,
          prefillTokPerSec: null,
        },
        {
          phase: "done",
          sessionID: "sess-A",
          ttft: 300,
          decodeTokPerSec: 70,
          prefillTokPerSec: 300,
        },
      ],
      current: { phase: "idle" },
    };
    const averages = calculateSessionAverages(mixedMetrics);
    expect(averages).toEqual({
      ttft: 200,
      decodeTokPerSec: 60,
      prefillTokPerSec: 200,
    });

    // 2 steps: step 1 = null, step 2 = 120
    // Non-null prefill: [120] -> mean = 120 (NOT (0 + 120) / 2 = 60)
    const nullFirstMetrics: SessionMetrics = {
      stepHistory: [
        {
          phase: "done",
          sessionID: "sess-A",
          ttft: 150,
          decodeTokPerSec: 40,
          prefillTokPerSec: null,
        },
        {
          phase: "done",
          sessionID: "sess-A",
          ttft: 250,
          decodeTokPerSec: 60,
          prefillTokPerSec: 120,
        },
      ],
      current: { phase: "idle" },
    };
    expect(calculateSessionAverages(nullFirstMetrics)?.prefillTokPerSec).toBe(120);

    // 2 steps: step 1 = 150, step 2 = null
    // Non-null prefill: [150] -> mean = 150 (NOT (150 + 0) / 2 = 75)
    const nullSecondMetrics: SessionMetrics = {
      stepHistory: [
        {
          phase: "done",
          sessionID: "sess-A",
          ttft: 150,
          decodeTokPerSec: 40,
          prefillTokPerSec: 150,
        },
        {
          phase: "done",
          sessionID: "sess-A",
          ttft: 250,
          decodeTokPerSec: 60,
          prefillTokPerSec: null,
        },
      ],
      current: { phase: "idle" },
    };
    expect(calculateSessionAverages(nullSecondMetrics)?.prefillTokPerSec).toBe(150);
  });

  it("returns prefillTokPerSec as null when all steps have null prefillTokPerSec", () => {
    const allNullMetrics: SessionMetrics = {
      stepHistory: [
        {
          phase: "done",
          sessionID: "sess-A",
          ttft: 120,
          decodeTokPerSec: 40,
          prefillTokPerSec: null,
        },
        {
          phase: "done",
          sessionID: "sess-A",
          ttft: 180,
          decodeTokPerSec: 60,
          prefillTokPerSec: null,
        },
      ],
      current: { phase: "idle" },
    };
    const averages = calculateSessionAverages(allNullMetrics);
    expect(averages).toEqual({
      ttft: 150,
      decodeTokPerSec: 50,
      prefillTokPerSec: null,
    });
  });
});

describe("loadConfig", () => {
  it("loads config by default from ~/.config/opencode/speed-measure.json expanded to os.homedir()", async () => {
    vi.resetModules();
    // @ts-expect-error node:os has no types without @types/node
    const { homedir } = (await import("node:os")) as { homedir: () => string };
    const homeDir = homedir();
    const expectedPath = `${homeDir}/.config/opencode/speed-measure.json`;
    const fileSpy = vi.fn((path: string) => {
      if (path === expectedPath) {
        return {
          text: async () =>
            JSON.stringify({
              showTTFT: false,
              showAverages: true,
              showCache: true,
              liveIntervalMs: 250,
              order: 200,
            }),
        };
      }
      return {
        text: () =>
          Promise.reject(new Error(`ENOENT: unexpected config path ${path}`)),
      };
    });
    vi.stubGlobal("Bun", {
      env: { HOME: homeDir },
      file: fileSpy,
    });
    const mod = await import("../src/index.js");
    const config = await mod.loadConfig();

    expect(fileSpy).toHaveBeenCalledOnce();
    expect(fileSpy).toHaveBeenCalledWith(expectedPath);
    expect(mod.CONFIG_PATH).toBe(expectedPath);
    expect(config).toEqual({
      showTTFT: false,
      showAverages: true,
      showCache: true,
      liveIntervalMs: 250,
      order: 200,
    });
  });

  it("resolves default path using Bun.env.HOME (/Users/discord4415) and verifies file argument", async () => {
    vi.resetModules();
    const homeDir = "/Users/discord4415";
    const expectedPath = "/Users/discord4415/.config/opencode/speed-measure.json";
    const fileSpy = vi.fn((path: string) => {
      expect(path).toBe(expectedPath);
      return {
        text: async () => JSON.stringify({ showAverages: true }),
      };
    });
    vi.stubGlobal("Bun", {
      env: { HOME: homeDir },
      file: fileSpy,
    });
    const mod = await import("../src/index.js");
    const config = await mod.loadConfig();

    expect(fileSpy).toHaveBeenCalledWith(expectedPath);
    expect(mod.CONFIG_PATH).toBe(expectedPath);
    expect(config.showAverages).toBe(true);
  });

  it("does not load config and returns default config when reading from a non-matching path", async () => {
    vi.resetModules();
    const homeDir = "/Users/discord4415";
    const expectedPath = `${homeDir}/.config/opencode/speed-measure.json`;
    const fileSpy = vi.fn((path: string) => {
      if (path === expectedPath) {
        return {
          text: async () => JSON.stringify({ order: 999 }),
        };
      }
      return {
        text: () => Promise.reject(new Error(`ENOENT: no such file: ${path}`)),
      };
    });
    vi.stubGlobal("Bun", {
      env: { HOME: homeDir },
      file: fileSpy,
    });
    const mod = await import("../src/index.js");
    const config = await mod.loadConfig(
      `${homeDir}/.config/opencode/speed-measure-typo.json`,
    );
    expect(fileSpy).toHaveBeenCalledWith(
      `${homeDir}/.config/opencode/speed-measure-typo.json`,
    );
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("reads from custom path when explicitly passed to loadConfig", async () => {
    vi.resetModules();
    const customPath = "/custom/path/custom-config.json";
    const fileSpy = vi.fn((path: string) => {
      expect(path).toBe(customPath);
      return {
        text: async () => JSON.stringify({ order: 500 }),
      };
    });
    vi.stubGlobal("Bun", {
      env: { HOME: "/test-home" },
      file: fileSpy,
    });
    const mod = await import("../src/index.js");
    const config = await mod.loadConfig(customPath);
    expect(fileSpy).toHaveBeenCalledWith(customPath);
    expect(config.order).toBe(500);
  });

  it("returns default config when file read rejects or throws (file absent, permission error)", async () => {
    vi.resetModules();
    const homeDir = "/test-home";
    const expectedPath = `${homeDir}/.config/opencode/speed-measure.json`;
    const fileSpy = vi.fn((path: string) => {
      expect(path).toBe(expectedPath);
      return {
        text: vi.fn().mockRejectedValue(new Error("ENOENT: no such file or directory")),
      };
    });
    vi.stubGlobal("Bun", {
      env: { HOME: homeDir },
      file: fileSpy,
    });
    const mod = await import("../src/index.js");
    const config = await mod.loadConfig();
    expect(fileSpy).toHaveBeenCalledWith(expectedPath);
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("returns default config when Bun.file synchronously throws", async () => {
    vi.resetModules();
    const homeDir = "/test-home";
    const expectedPath = `${homeDir}/.config/opencode/speed-measure.json`;
    const fileSpy = vi.fn((path: string) => {
      expect(path).toBe(expectedPath);
      throw new Error("EACCES: permission denied");
    });
    vi.stubGlobal("Bun", {
      env: { HOME: homeDir },
      file: fileSpy,
    });
    const mod = await import("../src/index.js");
    const config = await mod.loadConfig();
    expect(fileSpy).toHaveBeenCalledWith(expectedPath);
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("returns default config when runtimeBun is undefined", async () => {
    vi.stubGlobal("Bun", undefined);
    const config = await loadConfig();
    expect(config).toEqual(DEFAULT_CONFIG);
  });
});

describe("scheduleV1Fallback", () => {
  it("activates v1 only after two seconds without a v2 step", () => {
    vi.useFakeTimers();
    const activate = vi.fn();
    scheduleV1Fallback(activate);

    vi.advanceTimersByTime(1_999);
    expect(activate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(activate).toHaveBeenCalledOnce();
  });

  it("does not activate v1 when a v2 step arrives within two seconds", () => {
    vi.useFakeTimers();
    const activate = vi.fn();
    const fallback = scheduleV1Fallback(activate);

    vi.advanceTimersByTime(1_500);
    fallback.markV2Seen();
    vi.advanceTimersByTime(1_000);
    expect(activate).not.toHaveBeenCalled();
  });
});

describe("plugin.tui - event isolation cross-product matrix", () => {
  type EventMatrixCase = {
    name: string;
    isV1?: boolean;
    setup?: (
      harness: ReturnType<typeof createApiHarness>,
      target: TestSession,
      other: TestSession,
    ) => void;
    emit: (
      harness: ReturnType<typeof createApiHarness>,
      target: TestSession,
    ) => void;
    postAdvanceMs?: number;
    expectedTarget: { prefill: string; decode: string };
    expectedOther: { prefill: string; decode: string };
    postCheck?: (
      harness: ReturnType<typeof createApiHarness>,
      target: TestSession,
      other: TestSession,
    ) => void;
  };

  const V2_ISOLATION_CASES: EventMatrixCase[] = [
    {
      name: "v2 session.next.step.started",
      emit: (harness, target) => {
        harness.emit("session.next.step.started", {
          sessionID: target,
          assistantMessageID: `msg-${target}`,
          timestamp: 1_000,
        });
      },
      expectedTarget: { prefill: "Prefill: …", decode: "Decode:  --" },
      expectedOther: { prefill: "Prefill: --", decode: "Decode:  --" },
    },
    {
      name: "v2 session.next.reasoning.started",
      setup: (harness, target, other) => {
        for (const s of [target, other]) {
          harness.emit("session.next.step.started", {
            sessionID: s,
            assistantMessageID: `msg-${s}`,
            timestamp: 1_000,
          });
        }
      },
      emit: (harness, target) => {
        harness.emit("session.next.reasoning.started", {
          sessionID: target,
          assistantMessageID: `msg-${target}`,
          reasoningID: `reason-${target}`,
          timestamp: 1_250,
        });
      },
      expectedTarget: { prefill: "Prefill: 250 ms", decode: "Decode:  …" },
      expectedOther: { prefill: "Prefill: …", decode: "Decode:  --" },
    },
    {
      name: "v2 session.next.reasoning.delta",
      setup: (harness, target, other) => {
        vi.setSystemTime(10_000);
        for (const s of [target, other]) {
          harness.emit("session.next.step.started", {
            sessionID: s,
            assistantMessageID: `msg-${s}`,
            timestamp: 10_000,
          });
          harness.emit("session.next.reasoning.started", {
            sessionID: s,
            assistantMessageID: `msg-${s}`,
            reasoningID: `reason-${s}`,
            timestamp: 10_000,
          });
        }
      },
      emit: (harness, target) => {
        harness.emit("session.next.reasoning.delta", {
          sessionID: target,
          delta: "12345678901234567890", // 20 chars
        });
      },
      postAdvanceMs: 150,
      expectedTarget: { prefill: "Prefill: 0 ms", decode: "Decode:  ~133.3 chars/s" },
      expectedOther: { prefill: "Prefill: 0 ms", decode: "Decode:  ~0 chars/s" },
    },
    {
      name: "v2 session.next.text.started",
      setup: (harness, target, other) => {
        for (const s of [target, other]) {
          harness.emit("session.next.step.started", {
            sessionID: s,
            assistantMessageID: `msg-${s}`,
            timestamp: 1_000,
          });
        }
      },
      emit: (harness, target) => {
        harness.emit("session.next.text.started", {
          sessionID: target,
          assistantMessageID: `msg-${target}`,
          textID: `text-${target}`,
          timestamp: 1_400,
        });
      },
      expectedTarget: { prefill: "Prefill: 400 ms", decode: "Decode:  …" },
      expectedOther: { prefill: "Prefill: …", decode: "Decode:  --" },
    },
    {
      name: "v2 session.next.text.delta",
      setup: (harness, target, other) => {
        vi.setSystemTime(10_000);
        for (const s of [target, other]) {
          harness.emit("session.next.step.started", {
            sessionID: s,
            assistantMessageID: `msg-${s}`,
            timestamp: 10_000,
          });
          harness.emit("session.next.text.started", {
            sessionID: s,
            assistantMessageID: `msg-${s}`,
            textID: `text-${s}`,
            timestamp: 10_000,
          });
        }
      },
      emit: (harness, target) => {
        harness.emit("session.next.text.delta", {
          sessionID: target,
          delta: "123456789012345678901234567890", // 30 chars
        });
      },
      postAdvanceMs: 150,
      expectedTarget: { prefill: "Prefill: 0 ms", decode: "Decode:  ~200 chars/s" },
      expectedOther: { prefill: "Prefill: 0 ms", decode: "Decode:  ~0 chars/s" },
    },
    {
      name: "v2 session.next.step.ended",
      setup: (harness, target, other) => {
        for (const s of [target, other]) {
          harness.emit("session.next.step.started", {
            sessionID: s,
            assistantMessageID: `msg-${s}`,
            timestamp: 1_000,
          });
          harness.emit("session.next.text.started", {
            sessionID: s,
            assistantMessageID: `msg-${s}`,
            textID: `text-${s}`,
            timestamp: 1_500,
          });
        }
      },
      emit: (harness, target) => {
        harness.emit("session.next.step.ended", {
          sessionID: target,
          assistantMessageID: `msg-${target}`,
          timestamp: 2_500,
          tokens: { input: 100, output: 60, reasoning: 0, cache: { read: 0, write: 0 } },
        });
      },
      expectedTarget: { prefill: "Prefill: 500 ms │ 200 tok/s", decode: "Decode:  60 tok/s" },
      expectedOther: { prefill: "Prefill: 500 ms", decode: "Decode:  …" },
    },
    {
      name: "v2 session.next.step.failed",
      setup: (harness, target, other) => {
        for (const s of [target, other]) {
          harness.emit("session.next.step.started", {
            sessionID: s,
            assistantMessageID: `msg-${s}`,
            timestamp: 1_000,
          });
        }
      },
      emit: (harness, target) => {
        harness.emit("session.next.step.failed", {
          sessionID: target,
          assistantMessageID: `msg-${target}`,
          error: new Error("step failed"),
        });
      },
      expectedTarget: { prefill: "Prefill: error", decode: "Decode:  error" },
      expectedOther: { prefill: "Prefill: …", decode: "Decode:  --" },
    },
    {
      name: "v2 session.status (idle)",
      setup: (harness, target, other) => {
        for (const s of [target, other]) {
          harness.emit("session.next.step.started", {
            sessionID: s,
            assistantMessageID: `msg-${s}`,
            timestamp: 1_000,
          });
        }
      },
      emit: (harness, target) => {
        harness.emit("session.status", {
          sessionID: target,
          status: { type: "idle" },
        });
      },
      expectedTarget: { prefill: "Prefill: --", decode: "Decode:  --" },
      expectedOther: { prefill: "Prefill: …", decode: "Decode:  --" },
    },
    {
      name: "v2 session.error (targeted sessionID)",
      setup: (harness, target, other) => {
        for (const s of [target, other]) {
          harness.emit("session.next.step.started", {
            sessionID: s,
            assistantMessageID: `msg-${s}`,
            timestamp: 1_000,
          });
        }
      },
      emit: (harness, target) => {
        harness.emit("session.error", {
          sessionID: target,
          error: "targeted session error",
        });
      },
      expectedTarget: { prefill: "Prefill: error", decode: "Decode:  error" },
      expectedOther: { prefill: "Prefill: …", decode: "Decode:  --" },
    },
  ];

  const V1_ISOLATION_CASES: EventMatrixCase[] = [
    {
      name: "v1 message.part.updated (step-start)",
      isV1: true,
      emit: (harness, target) => {
        harness.emit("message.part.updated", {
          part: {
            type: "step-start",
            sessionID: target,
            messageID: `msg-${target}`,
          },
        });
      },
      expectedTarget: { prefill: "Prefill: …", decode: "Decode:  --" },
      expectedOther: { prefill: "Prefill: --", decode: "Decode:  --" },
    },
    {
      name: "v1 message.part.delta (text)",
      isV1: true,
      setup: (harness, target, other) => {
        vi.setSystemTime(10_000);
        for (const s of [target, other]) {
          harness.emit("message.part.updated", {
            part: {
              type: "step-start",
              sessionID: s,
              messageID: `msg-${s}`,
            },
          });
        }
        vi.advanceTimersByTime(340);
      },
      emit: (harness, target) => {
        harness.emit("message.part.delta", {
          sessionID: target,
          messageID: `msg-${target}`,
          partID: `text-${target}`,
          field: "text",
          delta: "forty characters are enough for a sample",
        });
      },
      expectedTarget: { prefill: "Prefill: 340 ms", decode: "Decode:  …" },
      expectedOther: { prefill: "Prefill: …", decode: "Decode:  --" },
    },
    {
      name: "v1 message.part.updated (step-finish)",
      isV1: true,
      setup: (harness, target, other) => {
        vi.setSystemTime(10_000);
        for (const s of [target, other]) {
          harness.emit("message.part.updated", {
            part: {
              type: "step-start",
              sessionID: s,
              messageID: `msg-${s}`,
            },
          });
        }
        vi.advanceTimersByTime(340);
        for (const s of [target, other]) {
          harness.emit("message.part.delta", {
            sessionID: s,
            messageID: `msg-${s}`,
            partID: `text-${s}`,
            field: "text",
            delta: "forty characters are enough for a sample",
          });
        }
        vi.advanceTimersByTime(1_000);
      },
      emit: (harness, target) => {
        harness.emit("message.part.updated", {
          part: {
            type: "step-finish",
            sessionID: target,
            messageID: `msg-${target}`,
            tokens: {
              input: 714,
              output: 60,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
          },
        });
      },
      expectedTarget: { prefill: "Prefill: 340 ms │ 2.1k tok/s", decode: "Decode:  60 tok/s" },
      expectedOther: { prefill: "Prefill: 340 ms", decode: "Decode:  ~41.7 chars/s" },
    },
    {
      name: "v1 message.part.delta (non-text field ignored)",
      isV1: true,
      setup: (harness, target, other) => {
        vi.setSystemTime(10_000);
        for (const s of [target, other]) {
          harness.emit("message.part.updated", {
            part: {
              type: "step-start",
              sessionID: s,
              messageID: `msg-${s}`,
            },
          });
        }
        vi.advanceTimersByTime(200);
      },
      emit: (harness, target) => {
        harness.emit("message.part.delta", {
          sessionID: target,
          messageID: `msg-${target}`,
          partID: `thought-${target}`,
          field: "thought",
          delta: "thinking ignored tokens",
        });
      },
      expectedTarget: { prefill: "Prefill: …", decode: "Decode:  --" },
      expectedOther: { prefill: "Prefill: …", decode: "Decode:  --" },
      postCheck: (harness, target, other) => {
        harness.emit("message.part.delta", {
          sessionID: target,
          messageID: `msg-${target}`,
          partID: `text-${target}`,
          field: "text",
          delta: "forty characters are enough for a sample",
        });
        const targetLines = sidebarLines(harness.registration(), target);
        const otherLines = sidebarLines(harness.registration(), other);
        expect(targetLines[1]).toBe("Prefill: 200 ms");
        expect(otherLines[1]).toBe("Prefill: …");
      },
    },
  ];

  const CROSS_PRODUCT_CASES = [
    ...V2_ISOLATION_CASES.flatMap((c) =>
      SESSIONS.map((target) => ({
        ...c,
        target,
        other: otherSession(target),
      })),
    ),
    ...V1_ISOLATION_CASES.flatMap((c) =>
      SESSIONS.map((target) => ({
        ...c,
        target,
        other: otherSession(target),
      })),
    ),
  ];

  it.each(CROSS_PRODUCT_CASES)(
    "$name: targets $target while $other remains unchanged",
    async ({
      isV1,
      setup,
      emit,
      postAdvanceMs,
      expectedTarget,
      expectedOther,
      postCheck,
      target,
      other,
    }) => {
      vi.useFakeTimers();
      const harness = createApiHarness();
      await plugin.tui(harness.api);

      if (isV1) {
        vi.advanceTimersByTime(2_000);
      }

      if (setup) {
        setup(harness, target, other);
      }

      emit(harness, target);

      if (postAdvanceMs) {
        vi.advanceTimersByTime(postAdvanceMs);
      }

      const linesTarget = sidebarLines(harness.registration(), target);
      const linesOther = sidebarLines(harness.registration(), other);

      expect(linesTarget[1]).toBe(expectedTarget.prefill);
      expect(linesTarget[2]).toBe(expectedTarget.decode);

      expect(linesOther[1]).toBe(expectedOther.prefill);
      expect(linesOther[2]).toBe(expectedOther.decode);

      if (postCheck) {
        postCheck(harness, target, other);
      }

      await harness.dispose();
    },
  );

  it("v2 session.error with absent sessionID transitions ALL in-flight sessions to error", async () => {
    vi.useFakeTimers();
    const harness = createApiHarness();
    await plugin.tui(harness.api);

    harness.emit("session.next.step.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-A",
      timestamp: 1_000,
    });
    harness.emit("session.next.step.started", {
      sessionID: "sess-B",
      assistantMessageID: "msg-B",
      timestamp: 2_000,
    });

    expect(sidebarLines(harness.registration(), "sess-A")[1]).toBe("Prefill: …");
    expect(sidebarLines(harness.registration(), "sess-B")[1]).toBe("Prefill: …");

    harness.emit("session.error", {
      error: "Global process crash",
    });

    expect(sidebarLines(harness.registration(), "sess-A")).toEqual([
      "Speed",
      "Prefill: error",
      "Decode:  error",
    ]);
    expect(sidebarLines(harness.registration(), "sess-B")).toEqual([
      "Speed",
      "Prefill: error",
      "Decode:  error",
    ]);

    await harness.dispose();
  });
});

describe("plugin.tui - generalized multi-session lifecycle and configuration", () => {
  it("registers one default-order sidebar slot and all twelve v2 events for all sessions", async () => {
    vi.useFakeTimers();
    const harness = createApiHarness();

    await plugin.tui(harness.api);

    expect(harness.register).toHaveBeenCalledOnce();
    expect(harness.registration()?.order).toBe(150);
    expect(harness.registration()?.slots.sidebar_content).toBeTypeOf("function");
    expect(harness.eventOn.mock.calls.map(([name]) => name)).toEqual(
      V2_EVENT_NAMES,
    );
    expect(sidebarLines(harness.registration(), "sess-A")).toEqual([
      "Speed",
      "Prefill: --",
      "Decode:  --",
    ]);
    expect(sidebarLines(harness.registration(), "sess-B")).toEqual([
      "Speed",
      "Prefill: --",
      "Decode:  --",
    ]);

    await harness.dispose();
  });

  it("activates and renders the v1 fallback with Date.now timestamps across distinct sessions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const harness = createApiHarness();
    await plugin.tui(harness.api);

    vi.advanceTimersByTime(1_999);
    expect(harness.handlers.has("message.part.updated")).toBe(false);
    vi.advanceTimersByTime(1);
    expect(harness.eventOn.mock.calls.slice(-2).map(([name]) => name)).toEqual([
      "message.part.updated",
      "message.part.delta",
    ]);

    // sess-A starts
    harness.emit("message.part.updated", {
      part: {
        type: "step-start",
        sessionID: "sess-A",
        messageID: "message-A",
      },
    });
    expect(sidebarLines(harness.registration(), "sess-A").slice(1)).toEqual([
      "Prefill: …",
      "Decode:  --",
    ]);
    expect(sidebarLines(harness.registration(), "sess-B").slice(1)).toEqual([
      "Prefill: --",
      "Decode:  --",
    ]);

    vi.advanceTimersByTime(340);
    harness.emit("message.part.delta", {
      sessionID: "sess-A",
      messageID: "message-A",
      partID: "text-A",
      field: "text",
      delta: "forty characters are enough for a sample",
    });
    expect(sidebarLines(harness.registration(), "sess-A").slice(1)).toEqual([
      "Prefill: 340 ms",
      "Decode:  …",
    ]);
    expect(sidebarLines(harness.registration(), "sess-B").slice(1)).toEqual([
      "Prefill: --",
      "Decode:  --",
    ]);

    vi.advanceTimersByTime(250);
    expect(sidebarLines(harness.registration(), "sess-A").slice(1)).toEqual([
      "Prefill: 340 ms",
      "Decode:  ~190.5 chars/s",
    ]);
    expect(sidebarLines(harness.registration(), "sess-B").slice(1)).toEqual([
      "Prefill: --",
      "Decode:  --",
    ]);

    vi.advanceTimersByTime(750);
    harness.emit("message.part.updated", {
      part: {
        type: "step-finish",
        sessionID: "sess-A",
        messageID: "message-A",
        tokens: {
          input: 714,
          output: 60,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      },
    });
    expect(sidebarLines(harness.registration(), "sess-A").slice(1)).toEqual([
      "Prefill: 340 ms │ 2.1k tok/s",
      "Decode:  60 tok/s",
    ]);
    expect(sidebarLines(harness.registration(), "sess-B").slice(1)).toEqual([
      "Prefill: --",
      "Decode:  --",
    ]);

    // sess-B starts and completes independently
    harness.emit("message.part.updated", {
      part: {
        type: "step-start",
        sessionID: "sess-B",
        messageID: "message-B",
      },
    });
    expect(sidebarLines(harness.registration(), "sess-B").slice(1)).toEqual([
      "Prefill: …",
      "Decode:  --",
    ]);
    expect(sidebarLines(harness.registration(), "sess-A").slice(1)).toEqual([
      "Prefill: 340 ms │ 2.1k tok/s",
      "Decode:  60 tok/s",
    ]);

    await harness.dispose();
  });

  it("does not subscribe to v1 events when v2 is selected in time", async () => {
    vi.useFakeTimers();
    const harness = createApiHarness();
    await plugin.tui(harness.api);

    vi.advanceTimersByTime(1_999);
    harness.emit("session.next.step.started", {
      sessionID: "sess-A",
      assistantMessageID: "message-A",
      timestamp: 1_000,
    });
    vi.advanceTimersByTime(2_000);

    expect(harness.eventOn).toHaveBeenCalledTimes(12);
    expect(harness.handlers.has("message.part.updated")).toBe(false);
    expect(harness.handlers.has("message.part.delta")).toBe(false);
    expect(sidebarLines(harness.registration(), "sess-A")[1]).toBe("Prefill: …");
    expect(sidebarLines(harness.registration(), "sess-B")[1]).toBe("Prefill: --");

    await harness.dispose();
  });

  it("does not persist averages with the default showAverages=false", async () => {
    vi.useFakeTimers();
    const harness = createApiHarness(true);
    await plugin.tui(harness.api);

    emitCompletedV2(harness, "sess-A");
    emitCompletedV2(harness, "sess-B");

    expect(harness.kvSet).not.toHaveBeenCalled();
    sidebarLines(harness.registration(), "sess-A");
    sidebarLines(harness.registration(), "sess-B");
    expect(harness.kvGet).not.toHaveBeenCalled();
    await harness.dispose();
  });

  it("persists averages under speed-measure keys when enabled and ready for multiple sessions", async () => {
    vi.useFakeTimers();
    const configured = await configuredPlugin({ showAverages: true });
    const harness = createApiHarness(true);
    await configured.tui(harness.api);

    emitCompletedV2(harness, "sess-A");
    emitCompletedV2(
      harness,
      "sess-B",
      { input: 200, output: 80, reasoning: 0, cache: { read: 50, write: 0 } },
      { t0: 2_000, t1: 2_400, t2: 3_200 },
    );

    expect(harness.kvSet.mock.calls).toEqual([
      ["speed-measure:avg:sess-A:ttft", 500],
      ["speed-measure:avg:sess-A:decode", 60],
      ["speed-measure:avg:sess-A:prefill", 200],
      ["speed-measure:avg:sess-B:ttft", 400],
      ["speed-measure:avg:sess-B:decode", 100],
      ["speed-measure:avg:sess-B:prefill", 500],
    ]);
    await harness.dispose();
  });

  it("does not persist averages until api.kv is ready", async () => {
    vi.useFakeTimers();
    const configured = await configuredPlugin({ showAverages: true });
    const harness = createApiHarness(false);
    await configured.tui(harness.api);

    emitCompletedV2(harness, "sess-A");
    emitCompletedV2(harness, "sess-B");

    expect(harness.kvSet).not.toHaveBeenCalled();
    await harness.dispose();
  });

  it("clears both timers and every v1/v2 subscription on dispose with active sessions", async () => {
    vi.useFakeTimers();
    const beforeFallback = createApiHarness();
    await plugin.tui(beforeFallback.api);

    expect(vi.getTimerCount()).toBe(2);
    await beforeFallback.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(beforeFallback.unsubscribeSpies).toHaveLength(12);
    expect(
      beforeFallback.unsubscribeSpies.every(
        (unsubscribe) => unsubscribe.mock.calls.length === 1,
      ),
    ).toBe(true);

    const afterFallback = createApiHarness();
    await plugin.tui(afterFallback.api);
    vi.advanceTimersByTime(2_000);
    expect(afterFallback.unsubscribeSpies).toHaveLength(14);
    harnessEmitBoth(afterFallback);

    await afterFallback.dispose();

    expect(vi.getTimerCount()).toBe(0);
    expect(
      afterFallback.unsubscribeSpies.every(
        (unsubscribe) => unsubscribe.mock.calls.length === 1,
      ),
    ).toBe(true);
    expect(
      [...afterFallback.handlers.values()].every(
        (callbacks) => callbacks.size === 0,
      ),
    ).toBe(true);
  });

  it("calls Solid root dispose when onDispose is triggered with multiple active sessions", async () => {
    vi.useFakeTimers();
    rootDisposeSpy = undefined;

    const harness = createApiHarness();
    await plugin.tui(harness.api);

    harnessEmitBoth(harness);

    expect(rootDisposeSpy).toBeDefined();
    expect(rootDisposeSpy).not.toHaveBeenCalled();

    await harness.dispose();

    expect(rootDisposeSpy).toHaveBeenCalledOnce();
  });

  it("initializes with default config without throwing when config file read rejects", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const expectedPath = "/test-home/.config/opencode/speed-measure.json";
    const fileSpy = vi.fn((path: string) => {
      expect(path).toBe(expectedPath);
      return {
        text: vi.fn().mockRejectedValue(new Error("ENOENT: file not found")),
      };
    });
    vi.stubGlobal("Bun", {
      env: { HOME: "/test-home" },
      file: fileSpy,
    });
    const freshPlugin = (await import("../src/index.js")).default;
    const harness = createApiHarness();
    await expect(freshPlugin.tui(harness.api)).resolves.not.toThrow();
    expect(fileSpy).toHaveBeenCalledWith(expectedPath);

    expect(harness.registration()?.order).toBe(150);
    expect(sidebarLines(harness.registration(), "sess-A")).toEqual([
      "Speed",
      "Prefill: --",
      "Decode:  --",
    ]);
    expect(sidebarLines(harness.registration(), "sess-B")).toEqual([
      "Speed",
      "Prefill: --",
      "Decode:  --",
    ]);

    await harness.dispose();
  });

  it("applies custom configuration (order and liveIntervalMs) maintaining session isolation", async () => {
    vi.useFakeTimers();
    const configured = await configuredPlugin({
      order: 250,
      liveIntervalMs: 300,
    });
    const harness = createApiHarness();
    await configured.tui(harness.api);

    expect(harness.registration()?.order).toBe(250);

    vi.setSystemTime(10_000);
    harness.emit("session.next.step.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-A",
      timestamp: 10_000,
    });
    harness.emit("session.next.text.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-A",
      timestamp: 10_000,
    });
    harness.emit("session.next.text.delta", {
      sessionID: "sess-A",
      delta: "123456789012345678901234567890",
    });

    vi.advanceTimersByTime(250);
    expect(sidebarLines(harness.registration(), "sess-A")[2]).toBe("Decode:  …");
    expect(sidebarLines(harness.registration(), "sess-B")[1]).toBe("Prefill: --");

    vi.advanceTimersByTime(50);
    expect(sidebarLines(harness.registration(), "sess-A")[2]).toBe("Decode:  ~100 chars/s");
    expect(sidebarLines(harness.registration(), "sess-B")[1]).toBe("Prefill: --");

    await harness.dispose();
  });

  it("handles session.status: resets in-flight steps to idle and preserves done/error steps across multiple sessions", async () => {
    vi.useFakeTimers();
    const harness = createApiHarness();
    await plugin.tui(harness.api);

    // 1. sess-A prefilling -> idle, while sess-B is decoding
    harness.emit("session.next.step.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-A1",
      timestamp: 1_000,
    });
    harness.emit("session.next.step.started", {
      sessionID: "sess-B",
      assistantMessageID: "msg-B1",
      timestamp: 1_000,
    });
    harness.emit("session.next.text.started", {
      sessionID: "sess-B",
      assistantMessageID: "msg-B1",
      timestamp: 1_200,
    });

    expect(sidebarLines(harness.registration(), "sess-A")[1]).toBe("Prefill: …");
    expect(sidebarLines(harness.registration(), "sess-B")[1]).toBe("Prefill: 200 ms");

    harness.emit("session.status", {
      sessionID: "sess-A",
      status: { type: "running" },
    });
    expect(sidebarLines(harness.registration(), "sess-A")[1]).toBe("Prefill: …");

    harness.emit("session.status", {
      sessionID: "sess-A",
      status: { type: "idle" },
    });
    expect(sidebarLines(harness.registration(), "sess-A")).toEqual([
      "Speed",
      "Prefill: --",
      "Decode:  --",
    ]);
    // sess-B remains untouched
    expect(sidebarLines(harness.registration(), "sess-B")[1]).toBe("Prefill: 200 ms");

    // 2. sess-B decoding -> idle
    harness.emit("session.status", {
      sessionID: "sess-B",
      status: { type: "idle" },
    });
    expect(sidebarLines(harness.registration(), "sess-B")).toEqual([
      "Speed",
      "Prefill: --",
      "Decode:  --",
    ]);

    // 3. done -> stays done on idle
    emitCompletedV2(harness, "sess-A");
    expect(sidebarLines(harness.registration(), "sess-A")).toEqual([
      "Speed",
      "Prefill: 500 ms │ 200 tok/s",
      "Decode:  60 tok/s",
    ]);
    harness.emit("session.status", {
      sessionID: "sess-A",
      status: { type: "idle" },
    });
    expect(sidebarLines(harness.registration(), "sess-A")).toEqual([
      "Speed",
      "Prefill: 500 ms │ 200 tok/s",
      "Decode:  60 tok/s",
    ]);

    // 4. error -> stays error on idle
    harness.emit("session.next.step.started", {
      sessionID: "sess-B",
      assistantMessageID: "msg-B2",
      timestamp: 5_000,
    });
    harness.emit("session.next.step.failed", {
      sessionID: "sess-B",
      assistantMessageID: "msg-B2",
      error: "failed",
    });
    expect(sidebarLines(harness.registration(), "sess-B")).toEqual([
      "Speed",
      "Prefill: error",
      "Decode:  error",
    ]);
    harness.emit("session.status", {
      sessionID: "sess-B",
      status: { type: "idle" },
    });
    expect(sidebarLines(harness.registration(), "sess-B")).toEqual([
      "Speed",
      "Prefill: error",
      "Decode:  error",
    ]);

    await harness.dispose();
  });

  it("records and displays cache read count per session when showCache is enabled", async () => {
    vi.useFakeTimers();
    const configured = await configuredPlugin({ showCache: true });
    const harness = createApiHarness();
    await configured.tui(harness.api);

    emitCompletedV2(
      harness,
      "sess-A",
      { input: 100, output: 60, reasoning: 0, cache: { read: 512, write: 0 } },
    );
    emitCompletedV2(
      harness,
      "sess-B",
      { input: 100, output: 60, reasoning: 0, cache: { read: 1024, write: 0 } },
    );

    const lines1 = sidebarLines(harness.registration(), "sess-A");
    expect(lines1[1]).toBe("Prefill: 500 ms │ 200 tok/s │ cache 512");

    const lines2 = sidebarLines(harness.registration(), "sess-B");
    expect(lines2[1]).toBe("Prefill: 500 ms │ 200 tok/s │ cache 1024");

    const lines3 = sidebarLines(harness.registration(), "sess-C");
    expect(lines3[1]).toBe("Prefill: --");

    await harness.dispose();
  });

  it("reads and displays persisted averages from api.kv with strict session isolation", async () => {
    vi.useFakeTimers();
    const configured = await configuredPlugin({ showAverages: true });
    const harness = createApiHarness(true);

    harness.kvGet.mockImplementation((key: string) => {
      if (key === "speed-measure:avg:sess-A:ttft") return 250;
      if (key === "speed-measure:avg:sess-A:decode") return 75;
      if (key === "speed-measure:avg:sess-A:prefill") return 1_500;
      if (key === "speed-measure:avg:sess-B:ttft") return 400;
      if (key === "speed-measure:avg:sess-B:decode") return 120;
      if (key === "speed-measure:avg:sess-B:prefill") return 3_000;
      return undefined;
    });

    await configured.tui(harness.api);

    emitCompletedV2(harness, "sess-A");
    emitCompletedV2(harness, "sess-B");

    const lines1 = sidebarLines(harness.registration(), "sess-A");
    expect(lines1[1]).toContain("(avg 250 ms)");
    expect(lines1[2]).toContain("(avg 75) tok/s");

    const lines2 = sidebarLines(harness.registration(), "sess-B");
    expect(lines2[1]).toContain("(avg 400 ms)");
    expect(lines2[2]).toContain("(avg 120) tok/s");

    expect(harness.kvGet).toHaveBeenCalledWith("speed-measure:avg:sess-A:ttft");
    expect(harness.kvGet).toHaveBeenCalledWith("speed-measure:avg:sess-A:decode");
    expect(harness.kvGet).toHaveBeenCalledWith("speed-measure:avg:sess-A:prefill");
    expect(harness.kvGet).toHaveBeenCalledWith("speed-measure:avg:sess-B:ttft");
    expect(harness.kvGet).toHaveBeenCalledWith("speed-measure:avg:sess-B:decode");
    expect(harness.kvGet).toHaveBeenCalledWith("speed-measure:avg:sess-B:prefill");

    await harness.dispose();
  });

  it("displays both cache read and averages when showCache and showAverages are simultaneously enabled", async () => {
    vi.useFakeTimers();
    const configured = await configuredPlugin({
      showCache: true,
      showAverages: true,
    });
    const harness = createApiHarness();
    await configured.tui(harness.api);

    emitCompletedV2(
      harness,
      "sess-A",
      { input: 100, output: 60, reasoning: 0, cache: { read: 512, write: 0 } },
    );
    emitCompletedV2(
      harness,
      "sess-B",
      { input: 100, output: 60, reasoning: 0, cache: { read: 0, write: 0 } },
    );

    const linesA = sidebarLines(harness.registration(), "sess-A");
    expect(linesA[1]).toBe("Prefill: 500 ms (avg 500 ms) │ cache 512");
    expect(linesA[2]).toBe("Decode:  60 (avg 60) tok/s");

    const linesB = sidebarLines(harness.registration(), "sess-B");
    expect(linesB[1]).toBe("Prefill: 500 ms (avg 500 ms) │ cache 0");
    expect(linesB[2]).toBe("Decode:  60 (avg 60) tok/s");

    await harness.dispose();
  });

  it("displays prefill speed with average when showTTFT is false and showAverages is true", async () => {
    vi.useFakeTimers();
    const configured = await configuredPlugin({
      showTTFT: false,
      showAverages: true,
    });
    const harness = createApiHarness();
    await configured.tui(harness.api);

    emitCompletedV2(harness, "sess-A");

    const lines = sidebarLines(harness.registration(), "sess-A");
    expect(lines[1]).toBe("Prefill: 200 (avg 200) tok/s");
    expect(lines[1]).not.toBe("Prefill: --");
    expect(lines[2]).toBe("Decode:  60 (avg 60) tok/s");

    await harness.dispose();
  });

  it("combines prefill speed average and cache display when showTTFT is false, showAverages is true, and showCache is true", async () => {
    vi.useFakeTimers();
    const configured = await configuredPlugin({
      showTTFT: false,
      showAverages: true,
      showCache: true,
    });
    const harness = createApiHarness();
    await configured.tui(harness.api);

    emitCompletedV2(
      harness,
      "sess-A",
      { input: 100, output: 60, reasoning: 0, cache: { read: 256, write: 0 } },
    );

    const lines = sidebarLines(harness.registration(), "sess-A");
    expect(lines[1]).toBe("Prefill: 200 (avg 200) tok/s │ cache 256");
    expect(lines[2]).toBe("Decode:  60 (avg 60) tok/s");

    await harness.dispose();
  });

  it("unsubscribes v1 handlers when a v2 step arrives after fallback activation", async () => {
    vi.useFakeTimers();
    const harness = createApiHarness();
    await plugin.tui(harness.api);

    vi.advanceTimersByTime(2_000);
    expect(harness.handlers.get("message.part.updated")?.size).toBe(1);
    expect(harness.handlers.get("message.part.delta")?.size).toBe(1);

    harness.emit("session.next.step.started", {
      sessionID: "sess-A",
      assistantMessageID: "message-A",
      timestamp: 3_000,
    });

    expect(harness.handlers.get("message.part.updated")?.size).toBe(0);
    expect(harness.handlers.get("message.part.delta")?.size).toBe(0);
    expect(sidebarLines(harness.registration(), "sess-A")[1]).toBe("Prefill: …");
    expect(sidebarLines(harness.registration(), "sess-B")[1]).toBe("Prefill: --");

    await harness.dispose();
  });

  it("ignores non-text deltas in v1 fallback mode without incrementing live chars across sessions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const harness = createApiHarness();
    await plugin.tui(harness.api);

    vi.advanceTimersByTime(2_000);

    harness.emit("message.part.updated", {
      part: {
        type: "step-start",
        sessionID: "sess-A",
        messageID: "message-A",
      },
    });
    harness.emit("message.part.updated", {
      part: {
        type: "step-start",
        sessionID: "sess-B",
        messageID: "message-B",
      },
    });
    expect(sidebarLines(harness.registration(), "sess-A").slice(1)).toEqual([
      "Prefill: …",
      "Decode:  --",
    ]);
    expect(sidebarLines(harness.registration(), "sess-B").slice(1)).toEqual([
      "Prefill: …",
      "Decode:  --",
    ]);

    vi.advanceTimersByTime(200);
    harness.emit("message.part.delta", {
      sessionID: "sess-A",
      messageID: "message-A",
      partID: "thought-A",
      field: "thought",
      delta: "internal thinking output that should be ignored",
    });

    // Both should remain in prefilling phase
    expect(sidebarLines(harness.registration(), "sess-A").slice(1)).toEqual([
      "Prefill: …",
      "Decode:  --",
    ]);
    expect(sidebarLines(harness.registration(), "sess-B").slice(1)).toEqual([
      "Prefill: …",
      "Decode:  --",
    ]);

    vi.advanceTimersByTime(300);
    expect(sidebarLines(harness.registration(), "sess-A").slice(1)).toEqual([
      "Prefill: …",
      "Decode:  --",
    ]);

    // Now emit text delta for sess-A only
    harness.emit("message.part.delta", {
      sessionID: "sess-A",
      messageID: "message-A",
      partID: "text-A",
      field: "text",
      delta: "forty characters are enough for a sample",
    });

    expect(sidebarLines(harness.registration(), "sess-A")[1]).toBe("Prefill: 500 ms");
    expect(sidebarLines(harness.registration(), "sess-B")[1]).toBe("Prefill: …");

    await harness.dispose();
  });

  it("does not query api.kv for persisted averages when api.kv.ready is false", async () => {
    vi.useFakeTimers();
    const configured = await configuredPlugin({ showAverages: true });
    const harness = createApiHarness(false);
    await configured.tui(harness.api);

    emitCompletedV2(harness, "sess-A");
    emitCompletedV2(harness, "sess-B");

    const linesA = sidebarLines(harness.registration(), "sess-A");
    const linesB = sidebarLines(harness.registration(), "sess-B");
    expect(harness.kvGet).not.toHaveBeenCalled();
    expect(linesA).toEqual([
      "Speed",
      "Prefill: 500 ms (avg 500 ms)",
      "Decode:  60 (avg 60) tok/s",
    ]);
    expect(linesB).toEqual([
      "Speed",
      "Prefill: 500 ms (avg 500 ms)",
      "Decode:  60 (avg 60) tok/s",
    ]);

    await harness.dispose();
  });

  it("renders header with theme.text and data rows with theme.textMuted across sessions", async () => {
    vi.useFakeTimers();
    const harness = createApiHarness();
    await plugin.tui(harness.api);

    const customTheme = {
      text: "rgba(250, 250, 250, 1)",
      textMuted: "rgba(100, 100, 100, 1)",
    };
    for (const s of SESSIONS) {
      const rendered = sidebarRendered(
        harness.registration(),
        s,
        customTheme,
      );
      expect(rendered.children[0].props.fg).toBe("rgba(250, 250, 250, 1)");
      expect(rendered.children[1].props.fg).toBe("rgba(100, 100, 100, 1)");
      expect(rendered.children[2].props.fg).toBe("rgba(100, 100, 100, 1)");
    }

    await harness.dispose();
  });

  it("strictly isolates all state, live streaming, and rendering across multiple concurrent sessions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const harness = createApiHarness();
    await plugin.tui(harness.api);

    // sess-A starts
    harness.emit("session.next.step.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-A",
      timestamp: 10_000,
    });
    expect(sidebarLines(harness.registration(), "sess-A")[1]).toBe("Prefill: …");
    expect(sidebarLines(harness.registration(), "sess-B")[1]).toBe("Prefill: --");

    // sess-B starts
    harness.emit("session.next.step.started", {
      sessionID: "sess-B",
      assistantMessageID: "msg-B",
      timestamp: 10_100,
    });
    // sess-A starts reasoning
    harness.emit("session.next.reasoning.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-A",
      timestamp: 10_200,
    });
    expect(sidebarLines(harness.registration(), "sess-A")[1]).toBe("Prefill: 200 ms");
    expect(sidebarLines(harness.registration(), "sess-B")[1]).toBe("Prefill: …");

    // sess-B starts text directly
    harness.emit("session.next.text.started", {
      sessionID: "sess-B",
      assistantMessageID: "msg-B",
      timestamp: 10_400,
    });
    expect(sidebarLines(harness.registration(), "sess-B")[1]).toBe("Prefill: 300 ms");

    // sess-A finishes step
    harness.emit("session.next.step.ended", {
      sessionID: "sess-A",
      assistantMessageID: "msg-A",
      timestamp: 11_000,
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    expect(sidebarLines(harness.registration(), "sess-A")[1]).toBe("Prefill: 200 ms │ 500 tok/s");
    expect(sidebarLines(harness.registration(), "sess-A")[2]).toBe("Decode:  62.5 tok/s");
    expect(sidebarLines(harness.registration(), "sess-B")[1]).toBe("Prefill: 300 ms");

    // sess-B fails
    harness.emit("session.next.step.failed", {
      sessionID: "sess-B",
      assistantMessageID: "msg-B",
      error: "sess-B error",
    });
    expect(sidebarLines(harness.registration(), "sess-B")).toEqual([
      "Speed",
      "Prefill: error",
      "Decode:  error",
    ]);
    expect(sidebarLines(harness.registration(), "sess-A")[1]).toBe("Prefill: 200 ms │ 500 tok/s");

    await harness.dispose();
  });

  it("v1 fallback ignores non-step message.part.updated events (text, tool, etc.) preserving idle, prefilling, decoding, and done states", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const harness = createApiHarness();
    await plugin.tui(harness.api);

    // Advance 2s to activate v1 fallback
    vi.advanceTimersByTime(2_000);

    // 1. Idle state: non-step part.updated should NOT transition to prefilling
    for (const nonStepType of ["text", "tool", "reasoning", "custom"]) {
      harness.emit("message.part.updated", {
        part: {
          type: nonStepType,
          sessionID: "sess-A",
          messageID: "msg-A",
        },
      });
      expect(sidebarLines(harness.registration(), "sess-A")).toEqual([
        "Speed",
        "Prefill: --",
        "Decode:  --",
      ]);
    }

    // 2. Start prefilling at t0 = 12_000
    harness.emit("message.part.updated", {
      part: {
        type: "step-start",
        sessionID: "sess-A",
        messageID: "msg-A",
      },
    });
    expect(sidebarLines(harness.registration(), "sess-A")[1]).toBe("Prefill: …");

    // Advance 200ms to 12_200. Emitting non-step updates must NOT reset t0!
    vi.advanceTimersByTime(200);
    for (const nonStepType of ["text", "tool", "thought"]) {
      harness.emit("message.part.updated", {
        part: {
          type: nonStepType,
          sessionID: "sess-A",
          messageID: "msg-A",
        },
      });
      // Remains in prefilling
      expect(sidebarLines(harness.registration(), "sess-A")[1]).toBe("Prefill: …");
    }

    // Advance 300ms to 12_500. Now emit first text delta.
    // If t0 was reset to 12_200, TTFT would be 300 ms.
    // Since t0 must stay at 12_000, TTFT must be exactly 500 ms (12_500 - 12_000).
    vi.advanceTimersByTime(300);
    harness.emit("message.part.delta", {
      sessionID: "sess-A",
      messageID: "msg-A",
      field: "text",
      delta: "forty characters sample for testing TTFT",
    });
    expect(sidebarLines(harness.registration(), "sess-A")[1]).toBe("Prefill: 500 ms");

    // 3. Decoding state: non-step updates must NOT reset back to prefilling
    for (const nonStepType of ["text", "tool", "action"]) {
      harness.emit("message.part.updated", {
        part: {
          type: nonStepType,
          sessionID: "sess-A",
          messageID: "msg-A",
        },
      });
      expect(sidebarLines(harness.registration(), "sess-A")[1]).toBe("Prefill: 500 ms");
    }

    // 4. Complete step at 13_500
    vi.advanceTimersByTime(1_000);
    harness.emit("message.part.updated", {
      part: {
        type: "step-finish",
        sessionID: "sess-A",
        messageID: "msg-A",
        tokens: {
          input: 100,
          output: 50,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      },
    });
    expect(sidebarLines(harness.registration(), "sess-A")).toEqual([
      "Speed",
      "Prefill: 500 ms │ 200 tok/s",
      "Decode:  50 tok/s",
    ]);

    // 5. Done state: non-step updates must NOT reset done back to prefilling
    for (const nonStepType of ["text", "tool", "status"]) {
      harness.emit("message.part.updated", {
        part: {
          type: nonStepType,
          sessionID: "sess-A",
          messageID: "msg-A",
        },
      });
      expect(sidebarLines(harness.registration(), "sess-A")).toEqual([
        "Speed",
        "Prefill: 500 ms │ 200 tok/s",
        "Decode:  50 tok/s",
      ]);
    }

    await harness.dispose();
  });

  it("v2: resets stepHistory across different assistantMessageIDs (turns) within the same session while preserving history in multi-step turns", async () => {
    vi.useFakeTimers();
    const configured = await configuredPlugin({ showAverages: true });
    const harness = createApiHarness(true);
    await configured.tui(harness.api);

    // --- Turn 1: msg-turn-1, Step 1 ---
    harness.emit("session.next.step.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-turn-1",
      timestamp: 10_000,
    });
    harness.emit("session.next.text.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-turn-1",
      timestamp: 10_500,
    });
    harness.emit("session.next.step.ended", {
      sessionID: "sess-A",
      assistantMessageID: "msg-turn-1",
      timestamp: 11_500,
      tokens: { input: 100, output: 60, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    expect(sidebarLines(harness.registration(), "sess-A")).toEqual([
      "Speed",
      "Prefill: 500 ms (avg 500 ms)",
      "Decode:  60 (avg 60) tok/s",
    ]);

    // --- Turn 1: msg-turn-1, Step 2 (Same assistantMessageID -> history preserved) ---
    harness.emit("session.next.step.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-turn-1",
      timestamp: 12_000,
    });
    harness.emit("session.next.text.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-turn-1",
      timestamp: 12_300,
    });
    harness.emit("session.next.step.ended", {
      sessionID: "sess-A",
      assistantMessageID: "msg-turn-1",
      timestamp: 13_300,
      tokens: { input: 100, output: 40, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    // Avg TTFT = (500 + 300) / 2 = 400 ms
    // Avg Decode = (60 + 40) / 2 = 50 tok/s
    expect(sidebarLines(harness.registration(), "sess-A")).toEqual([
      "Speed",
      "Prefill: 300 ms (avg 400 ms)",
      "Decode:  40 (avg 50) tok/s",
    ]);

    // --- Turn 2: msg-turn-2, Step 1 (Different assistantMessageID -> history MUST reset) ---
    harness.emit("session.next.step.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-turn-2",
      timestamp: 20_000,
    });
    harness.emit("session.next.text.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-turn-2",
      timestamp: 20_800,
    });
    harness.emit("session.next.step.ended", {
      sessionID: "sess-A",
      assistantMessageID: "msg-turn-2",
      timestamp: 21_800,
      tokens: { input: 100, output: 80, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    // Turn 1 history is cleared! Only Turn 2 Step 1 is in history:
    // Avg TTFT = 800 ms (NOT (500 + 300 + 800)/3 = 533 ms)
    // Avg Decode = 80 tok/s (NOT (60 + 40 + 80)/3 = 60 tok/s)
    expect(sidebarLines(harness.registration(), "sess-A")).toEqual([
      "Speed",
      "Prefill: 800 ms (avg 800 ms)",
      "Decode:  80 (avg 80) tok/s",
    ]);

    await harness.dispose();
  });

  it("v1 fallback: resets stepHistory across different messageIDs (turns) within the same session while preserving history in multi-step turns", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const configured = await configuredPlugin({ showAverages: true });
    const harness = createApiHarness(true);
    await configured.tui(harness.api);

    // Activate v1 fallback
    vi.advanceTimersByTime(2_000);

    // --- Turn 1: msg-v1-turn-1, Step 1 ---
    harness.emit("message.part.updated", {
      part: {
        type: "step-start",
        sessionID: "sess-A",
        messageID: "msg-v1-turn-1",
      },
    });
    vi.advanceTimersByTime(500); // 12_500
    harness.emit("message.part.delta", {
      sessionID: "sess-A",
      messageID: "msg-v1-turn-1",
      field: "text",
      delta: "sample chunk",
    });
    vi.advanceTimersByTime(1_000); // 13_500
    harness.emit("message.part.updated", {
      part: {
        type: "step-finish",
        sessionID: "sess-A",
        messageID: "msg-v1-turn-1",
        tokens: { input: 100, output: 60, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    });
    expect(sidebarLines(harness.registration(), "sess-A")).toEqual([
      "Speed",
      "Prefill: 500 ms (avg 500 ms)",
      "Decode:  60 (avg 60) tok/s",
    ]);

    // --- Turn 1: msg-v1-turn-1, Step 2 (Same messageID -> history preserved) ---
    vi.advanceTimersByTime(500); // 14_000
    harness.emit("message.part.updated", {
      part: {
        type: "step-start",
        sessionID: "sess-A",
        messageID: "msg-v1-turn-1",
      },
    });
    vi.advanceTimersByTime(300); // 14_300
    harness.emit("message.part.delta", {
      sessionID: "sess-A",
      messageID: "msg-v1-turn-1",
      field: "text",
      delta: "sample chunk 2",
    });
    vi.advanceTimersByTime(1_000); // 15_300
    harness.emit("message.part.updated", {
      part: {
        type: "step-finish",
        sessionID: "sess-A",
        messageID: "msg-v1-turn-1",
        tokens: { input: 100, output: 40, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    });
    // Avg TTFT = (500 + 300) / 2 = 400 ms
    // Avg Decode = (60 + 40) / 2 = 50 tok/s
    expect(sidebarLines(harness.registration(), "sess-A")).toEqual([
      "Speed",
      "Prefill: 300 ms (avg 400 ms)",
      "Decode:  40 (avg 50) tok/s",
    ]);

    // --- Turn 2: msg-v1-turn-2, Step 1 (Different messageID -> history MUST reset) ---
    vi.advanceTimersByTime(5_000); // 20_300
    harness.emit("message.part.updated", {
      part: {
        type: "step-start",
        sessionID: "sess-A",
        messageID: "msg-v1-turn-2",
      },
    });
    vi.advanceTimersByTime(800); // 21_100
    harness.emit("message.part.delta", {
      sessionID: "sess-A",
      messageID: "msg-v1-turn-2",
      field: "text",
      delta: "turn 2 sample",
    });
    vi.advanceTimersByTime(1_000); // 22_100
    harness.emit("message.part.updated", {
      part: {
        type: "step-finish",
        sessionID: "sess-A",
        messageID: "msg-v1-turn-2",
        tokens: { input: 100, output: 80, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    });
    // Turn 1 history is cleared!
    // Avg TTFT = 800 ms (NOT 533 ms)
    // Avg Decode = 80 tok/s (NOT 60 tok/s)
    expect(sidebarLines(harness.registration(), "sess-A")).toEqual([
      "Speed",
      "Prefill: 800 ms (avg 800 ms)",
      "Decode:  80 (avg 80) tok/s",
    ]);

    await harness.dispose();
  });

  it("distinguishes payload fields across multiple values and handles branch matches and non-matches", async () => {
    vi.useFakeTimers();
    const configured = await configuredPlugin({ showCache: true, showAverages: false });
    const harness = createApiHarness(true);
    await configured.tui(harness.api);

    // 1. Verify tokens.cache.read variation: cache read = 77
    harness.emit("session.next.step.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-tokens-1",
      timestamp: 1_000,
    });
    harness.emit("session.next.text.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-tokens-1",
      timestamp: 1_200,
    });
    harness.emit("session.next.step.ended", {
      sessionID: "sess-A",
      assistantMessageID: "msg-tokens-1",
      timestamp: 2_200,
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 77, write: 0 } },
    });
    expect(sidebarLines(harness.registration(), "sess-A")[1]).toContain("cache 77");

    // 2. Verify tokens.cache.read variation: cache read = 99 on sess-B
    harness.emit("session.next.step.started", {
      sessionID: "sess-B",
      assistantMessageID: "msg-tokens-2",
      timestamp: 3_000,
    });
    harness.emit("session.next.text.started", {
      sessionID: "sess-B",
      assistantMessageID: "msg-tokens-2",
      timestamp: 3_400,
    });
    harness.emit("session.next.step.ended", {
      sessionID: "sess-B",
      assistantMessageID: "msg-tokens-2",
      timestamp: 4_400,
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 99, write: 0 } },
    });
    expect(sidebarLines(harness.registration(), "sess-B")[1]).toContain("cache 99");

    // 3. session.status: match ("idle") vs non-match ("busy", "paused")
    // Start step on sess-A
    harness.emit("session.next.step.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-tokens-3",
      timestamp: 5_000,
    });
    expect(sidebarLines(harness.registration(), "sess-A")[1]).toBe("Prefill: …");

    // Non-matching statuses: "busy", "paused" -> does NOT reset to idle
    harness.emit("session.status", { sessionID: "sess-A", status: { type: "busy" } });
    expect(sidebarLines(harness.registration(), "sess-A")[1]).toBe("Prefill: …");
    harness.emit("session.status", { sessionID: "sess-A", status: { type: "paused" } });
    expect(sidebarLines(harness.registration(), "sess-A")[1]).toBe("Prefill: …");

    // Matching status: "idle" -> resets in-flight step to idle
    harness.emit("session.status", { sessionID: "sess-A", status: { type: "idle" } });
    expect(sidebarLines(harness.registration(), "sess-A")).toEqual([
      "Speed",
      "Prefill: --",
      "Decode:  --",
    ]);

    await harness.dispose();
  });

  it("completes multiple steps in the same session, verifying calculateSessionAverages in the live plugin flow with mixed null prefill and KV persistence", async () => {
    vi.useFakeTimers();
    const configured = await configuredPlugin({
      showAverages: true,
      showTTFT: false,
    });
    const harness = createApiHarness(true);
    await configured.tui(harness.api);

    // Step 1: sess-A, msg-multi-1
    // t0 = 1000, t1 = 1200 (prefillDuration = 200ms, input = 100 -> prefill = 500 tok/s)
    // t_end = 2200, output = 60, decodeDuration = 1000ms -> decode = 60 tok/s, ttft = 200ms
    harness.emit("session.next.step.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-multi-1",
      timestamp: 1_000,
    });
    harness.emit("session.next.text.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-multi-1",
      timestamp: 1_200,
    });
    harness.emit("session.next.step.ended", {
      sessionID: "sess-A",
      assistantMessageID: "msg-multi-1",
      timestamp: 2_200,
      tokens: { input: 100, output: 60, reasoning: 0, cache: { read: 0, write: 0 } },
    });

    // Step 1 display (showTTFT: false, showAverages: true)
    // Prefill: current (avg average) tok/s -> "Prefill: 500 (avg 500) tok/s"
    // Decode: current (avg average) tok/s -> "Decode:  60 (avg 60) tok/s"
    expect(sidebarLines(harness.registration(), "sess-A")).toEqual([
      "Speed",
      "Prefill: 500 (avg 500) tok/s",
      "Decode:  60 (avg 60) tok/s",
    ]);
    expect(harness.api.kv.set).toHaveBeenCalledWith("speed-measure:avg:sess-A:ttft", 200);
    expect(harness.api.kv.set).toHaveBeenCalledWith("speed-measure:avg:sess-A:decode", 60);
    expect(harness.api.kv.set).toHaveBeenCalledWith("speed-measure:avg:sess-A:prefill", 500);

    // Step 2: sess-A, msg-multi-1 (same messageID -> accumulates into stepHistory)
    // With text.started but tokens.input = 0 -> prefillTokPerSec is null!
    // t0 = 3000, t1 = 3500 (ttft = 500ms)
    // t_end = 4500, output = 40, decodeDuration = 1000ms -> decode = 40 tok/s
    harness.emit("session.next.step.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-multi-1",
      timestamp: 3_000,
    });
    harness.emit("session.next.text.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-multi-1",
      timestamp: 3_500,
    });
    harness.emit("session.next.step.ended", {
      sessionID: "sess-A",
      assistantMessageID: "msg-multi-1",
      timestamp: 4_500,
      tokens: { input: 0, output: 40, reasoning: 0, cache: { read: 0, write: 0 } },
    });

    // History has [step1, step2]
    // ttft avg = (200 + 500) / 2 = 350 ms
    // decode avg = (60 + 40) / 2 = 50 tok/s
    // prefill avg = [500] -> 500 tok/s (null is excluded, NOT treated as 0!)
    expect(harness.api.kv.set).toHaveBeenCalledWith("speed-measure:avg:sess-A:ttft", 350);
    expect(harness.api.kv.set).toHaveBeenCalledWith("speed-measure:avg:sess-A:decode", 50);
    expect(harness.api.kv.set).toHaveBeenCalledWith("speed-measure:avg:sess-A:prefill", 500);

    // Step 3: sess-A, msg-multi-1 (same messageID -> 3rd step)
    // t0 = 5000, t1 = 5400 (ttft = 400ms, input = 100, prefill = 100 / 0.4 = 250 tok/s)
    // t_end = 6400, output = 80, decodeDuration = 1000ms -> decode = 80 tok/s
    harness.emit("session.next.step.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-multi-1",
      timestamp: 5_000,
    });
    harness.emit("session.next.text.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-multi-1",
      timestamp: 5_400,
    });
    harness.emit("session.next.step.ended", {
      sessionID: "sess-A",
      assistantMessageID: "msg-multi-1",
      timestamp: 6_400,
      tokens: { input: 100, output: 80, reasoning: 0, cache: { read: 0, write: 0 } },
    });

    // History has [step1, step2, step3]
    // decode avg = (60 + 40 + 80) / 3 = 60 tok/s
    // prefill avg = (500 + 250) / 2 = 375 tok/s (step2 null excluded! If treated as 0, would be 250)
    expect(sidebarLines(harness.registration(), "sess-A")).toEqual([
      "Speed",
      "Prefill: 250 (avg 375) tok/s",
      "Decode:  80 (avg 60) tok/s",
    ]);
    expect(harness.api.kv.set).toHaveBeenCalledWith("speed-measure:avg:sess-A:decode", 60);
    expect(harness.api.kv.set).toHaveBeenCalledWith("speed-measure:avg:sess-A:prefill", 375);

    await harness.dispose();
  });
});

function harnessEmitBoth(harness: ReturnType<typeof createApiHarness>) {
  for (const s of SESSIONS) {
    harness.emit("session.next.step.started", {
      sessionID: s,
      assistantMessageID: `msg-${s}`,
      timestamp: 1_000,
    });
  }
}

describe("SolidJS reactivity verification (BB1)", () => {
  async function loadReactivePlugin() {
    // @ts-expect-error untyped internal module
    const solidDev = (await import("solid-js/dist/dev.js")) as any;
    const srcUrl = new URL("../src/index.tsx", import.meta.url);
    const srcCode = fs.readFileSync(srcUrl, "utf8");

    const transformed = transformSync(srcCode, {
      configFile: false,
      babelrc: false,
      presets: [
        ["@babel/preset-typescript", { jsxPragma: "preserve" }],
        [solidPreset, { moduleName: "@opentui/solid", generate: "universal" }],
      ],
      filename: "src/index.tsx",
    });

    const cjs = transformSync(transformed!.code!, {
      configFile: false,
      babelrc: false,
      plugins: [
        ["@babel/plugin-transform-modules-commonjs", { importInterop: "none" }],
      ],
      filename: "src/index.js",
    });

    const opentuiSolid: any = {
      render(code: () => any, element: any) {
        let disposer: any;
        solidDev.createRoot((dispose: any) => {
          disposer = dispose;
          opentuiSolid.insert(element, code());
        });
        return disposer;
      },
      insert(parent: any, accessor: any) {
        if (typeof accessor !== "function") {
          parent.children.push(accessor);
          return;
        }
        const textNode = { type: "#text", value: "" };
        parent.children.push(textNode);
        solidDev.createEffect(() => {
          textNode.value = String(accessor() ?? "");
        });
      },
      effect(fn: (prev: any) => any, initial: any) {
        let prev = initial;
        solidDev.createEffect(() => {
          prev = fn(prev);
        });
      },
      createElement(type: string) {
        return { type, props: {}, children: [] as any[], parent: null };
      },
      createTextNode(value: string | number) {
        return { type: "#text", value: String(value), children: [] as any[], parent: null };
      },
      insertNode(parent: any, node: any) {
        node.parent = parent;
        parent.children.push(node);
      },
      setProp(node: any, name: string, value: any) {
        node.props[name] = value;
        return value;
      },
      spread() {},
      mergeProps: solidDev.mergeProps,
      memo: solidDev.createMemo,
      createComponent: solidDev.createComponent,
      use(fn: any, element: any, arg: any) {
        return fn(element, arg);
      },
    };

    const customRequire = (specifier: string) => {
      if (specifier === "solid-js") return solidDev;
      if (specifier === "@opentui/solid") return opentuiSolid;
      if (specifier === "./collector.js") return collectorModule;
      if (specifier === "./format.js") return formatModule;
      throw new Error(`Cannot resolve ${specifier}`);
    };

    const moduleObj = { exports: {} as any };
    const fn = new Function("exports", "require", "module", cjs!.code!);
    fn(moduleObj.exports, customRequire, moduleObj);

    return {
      plugin: moduleObj.exports.default as typeof plugin,
      solid: solidDev,
    };
  }

  function flatten(node: any, out: string[] = []): string[] {
    if (node.type === "#text") out.push(node.value);
    for (const c of node.children ?? []) flatten(c, out);
    return out;
  }

  function renderSlotOnce(
    solidDev: any,
    slotFn: (ctx: any, props: any) => any,
    ctx: any,
    sessionID: string | (() => string) | { get session_id(): string },
  ) {
    const root: { type: string; props: Record<string, unknown>; children: any[]; parent: null } = {
      type: "root",
      props: {},
      children: [],
      parent: null,
    };
    let disposeRender!: () => void;
    solidDev.createRoot((dispose: any) => {
      disposeRender = dispose;
      const props =
        typeof sessionID === "string"
          ? {
              get session_id() {
                return sessionID;
              },
            }
          : typeof sessionID === "function"
            ? {
                get session_id() {
                  return sessionID();
                },
              }
            : sessionID;
      const element = slotFn(ctx, props);
      root.children.push(element);
    });
    return { root, dispose: disposeRender };
  }

  it("updates the same rendered tree when signals change without re-calling sidebar_content across multiple sessions", async () => {
    const { plugin: reactivePlugin, solid: solidDev } = await loadReactivePlugin();
    const harness = createApiHarness();
    await reactivePlugin.tui(harness.api);

    const ctx = { theme: { current: { text: "white", textMuted: "gray" } } };
    const slotFn = harness.registration()!.slots.sidebar_content;

    // Render ONCE inside createRoot for sess-A and sess-B
    const viewA = renderSlotOnce(solidDev, slotFn, ctx, "sess-A");
    const viewB = renderSlotOnce(solidDev, slotFn, ctx, "sess-B");
    await Promise.resolve();

    // Initial state (idle)
    expect(flatten(viewA.root)).toEqual(["Speed", "Prefill: --", "Decode:  --"]);
    expect(flatten(viewB.root)).toEqual(["Speed", "Prefill: --", "Decode:  --"]);

    // Step started for sess-A -> prefilling
    harness.emit("session.next.step.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-1",
      timestamp: 1_000,
    });
    await Promise.resolve();
    expect(flatten(viewA.root)).toEqual(["Speed", "Prefill: …", "Decode:  --"]);
    expect(flatten(viewB.root)).toEqual(["Speed", "Prefill: --", "Decode:  --"]);

    // Text started for sess-A -> decoding
    harness.emit("session.next.text.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-1",
      textID: "txt-1",
      timestamp: 1_250,
    });
    await Promise.resolve();
    expect(flatten(viewA.root)).toEqual(["Speed", "Prefill: 250 ms", "Decode:  …"]);
    expect(flatten(viewB.root)).toEqual(["Speed", "Prefill: --", "Decode:  --"]);

    // Step ended for sess-A -> done
    harness.emit("session.next.step.ended", {
      sessionID: "sess-A",
      assistantMessageID: "msg-1",
      timestamp: 2_250,
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    await Promise.resolve();
    const doneTextA = flatten(viewA.root);
    expect(doneTextA[0]).toBe("Speed");
    expect(doneTextA[1]).toMatch(/^Prefill: 250 ms/);
    expect(doneTextA[2]).toBe("Decode:  50 tok/s");
    expect(flatten(viewB.root)).toEqual(["Speed", "Prefill: --", "Decode:  --"]);

    // Now advance sess-B independently
    harness.emit("session.next.step.started", {
      sessionID: "sess-B",
      assistantMessageID: "msg-B1",
      timestamp: 3_000,
    });
    harness.emit("session.next.text.started", {
      sessionID: "sess-B",
      assistantMessageID: "msg-B1",
      timestamp: 3_100,
    });
    harness.emit("session.next.step.ended", {
      sessionID: "sess-B",
      assistantMessageID: "msg-B1",
      timestamp: 4_100,
      tokens: { input: 100, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    await Promise.resolve();
    const doneTextB = flatten(viewB.root);
    expect(doneTextB[1]).toMatch(/^Prefill: 100 ms/);
    expect(doneTextB[2]).toBe("Decode:  100 tok/s");

    // viewA remains done with 50 tok/s
    expect(flatten(viewA.root)[2]).toBe("Decode:  50 tok/s");

    viewA.dispose();
    viewB.dispose();
    await harness.dispose();
  });

  it("reactively updates theme colors on existing trees without re-calling sidebar_content across multiple sessions", async () => {
    const { plugin: reactivePlugin, solid: solidDev } = await loadReactivePlugin();
    const harness = createApiHarness();
    await reactivePlugin.tui(harness.api);

    const [theme, setTheme] = solidDev.createSignal({ text: "white", textMuted: "gray" });
    const ctx = {
      theme: {
        get current() {
          return theme();
        },
      },
    };
    const slotFn = harness.registration()!.slots.sidebar_content;

    // Render ONCE inside createRoot for both sess-A and sess-B
    const viewA = renderSlotOnce(solidDev, slotFn, ctx, "sess-A");
    const viewB = renderSlotOnce(solidDev, slotFn, ctx, "sess-B");
    await Promise.resolve();

    const boxA = viewA.root.children[0] as any;
    expect(boxA.type).toBe("box");
    expect(boxA.children.map((c: any) => c.props.fg)).toEqual(["white", "gray", "gray"]);

    const boxB = viewB.root.children[0] as any;
    expect(boxB.type).toBe("box");
    expect(boxB.children.map((c: any) => c.props.fg)).toEqual(["white", "gray", "gray"]);

    // Update theme reactively
    setTheme({ text: "cyan", textMuted: "darkgray" });
    await Promise.resolve();
    expect(boxA.children.map((c: any) => c.props.fg)).toEqual(["cyan", "darkgray", "darkgray"]);
    expect(boxB.children.map((c: any) => c.props.fg)).toEqual(["cyan", "darkgray", "darkgray"]);

    viewA.dispose();
    viewB.dispose();
    await harness.dispose();
  });

  it("reactively updates cache read counts without re-calling sidebar_content under showCache: true across multiple sessions", async () => {
    vi.stubGlobal("Bun", {
      env: { HOME: "/custom" },
      file: () => ({
        text: () => Promise.resolve(JSON.stringify({ showCache: true })),
      }),
    });

    const { plugin: reactivePlugin, solid: solidDev } = await loadReactivePlugin();
    const harness = createApiHarness();
    await reactivePlugin.tui(harness.api);

    const ctx = { theme: { current: { text: "white", textMuted: "gray" } } };
    const slotFn = harness.registration()!.slots.sidebar_content;

    // Render ONCE for sess-A and sess-B
    const viewA = renderSlotOnce(solidDev, slotFn, ctx, "sess-A");
    const viewB = renderSlotOnce(solidDev, slotFn, ctx, "sess-B");
    await Promise.resolve();

    expect(flatten(viewA.root)).toEqual(["Speed", "Prefill: --", "Decode:  --"]);
    expect(flatten(viewB.root)).toEqual(["Speed", "Prefill: --", "Decode:  --"]);

    // Complete step for sess-A with cache.read = 25
    harness.emit("session.next.step.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-A1",
      timestamp: 1_000,
    });
    harness.emit("session.next.text.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-A1",
      timestamp: 1_200,
    });
    harness.emit("session.next.step.ended", {
      sessionID: "sess-A",
      assistantMessageID: "msg-A1",
      timestamp: 2_200,
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 25, write: 0 } },
    });
    await Promise.resolve();

    // viewA must reactively show "│ cache 25"
    expect(flatten(viewA.root)[1]).toMatch(/│ cache 25$/);
    // viewB remains idle
    expect(flatten(viewB.root)).toEqual(["Speed", "Prefill: --", "Decode:  --"]);

    // Complete step for sess-B with cache.read = 42
    harness.emit("session.next.step.started", {
      sessionID: "sess-B",
      assistantMessageID: "msg-B1",
      timestamp: 3_000,
    });
    harness.emit("session.next.text.started", {
      sessionID: "sess-B",
      assistantMessageID: "msg-B1",
      timestamp: 3_100,
    });
    harness.emit("session.next.step.ended", {
      sessionID: "sess-B",
      assistantMessageID: "msg-B1",
      timestamp: 4_100,
      tokens: { input: 100, output: 60, reasoning: 0, cache: { read: 42, write: 0 } },
    });
    await Promise.resolve();

    expect(flatten(viewA.root)[1]).toMatch(/│ cache 25$/);
    expect(flatten(viewB.root)[1]).toMatch(/│ cache 42$/);

    // Update sess-A again with cache.read = 80
    harness.emit("session.next.step.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-A2",
      timestamp: 5_000,
    });
    harness.emit("session.next.text.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-A2",
      timestamp: 5_150,
    });
    harness.emit("session.next.step.ended", {
      sessionID: "sess-A",
      assistantMessageID: "msg-A2",
      timestamp: 6_150,
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 80, write: 0 } },
    });
    await Promise.resolve();

    expect(flatten(viewA.root)[1]).toMatch(/│ cache 80$/);
    expect(flatten(viewB.root)[1]).toMatch(/│ cache 42$/);

    // Step ending with cache omitted under showCache displays cache 0
    harness.emit("session.next.step.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-A3",
      timestamp: 7_000,
    });
    harness.emit("session.next.text.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-A3",
      timestamp: 7_150,
    });
    harness.emit("session.next.step.ended", {
      sessionID: "sess-A",
      assistantMessageID: "msg-A3",
      timestamp: 8_150,
      tokens: { input: 100, output: 50, reasoning: 0 }, // cache omitted!
    });
    await Promise.resolve();

    expect(flatten(viewA.root)[1]).toMatch(/│ cache 0$/);

    viewA.dispose();
    viewB.dispose();
    await harness.dispose();
  });

  it("reactively updates persisted averages without re-calling sidebar_content under showAverages: true across multiple sessions", async () => {
    vi.stubGlobal("Bun", {
      env: { HOME: "/custom" },
      file: () => ({
        text: () => Promise.resolve(JSON.stringify({ showAverages: true, showTTFT: true })),
      }),
    });

    const kvStore = new Map<string, unknown>();
    // Pre-populate with stale initial values
    kvStore.set("speed-measure:avg:sess-A:ttft", 9000);
    kvStore.set("speed-measure:avg:sess-A:decode", 9000);
    kvStore.set("speed-measure:avg:sess-B:ttft", 8000);
    kvStore.set("speed-measure:avg:sess-B:decode", 8000);

    const { plugin: reactivePlugin, solid: solidDev } = await loadReactivePlugin();
    const harness = createApiHarness();
    harness.kvGet.mockImplementation((k: string) => kvStore.get(k));
    harness.kvSet.mockImplementation((k: string, v: unknown) => kvStore.set(k, v));
    await reactivePlugin.tui(harness.api);

    const ctx = { theme: { current: { text: "white", textMuted: "gray" } } };
    const slotFn = harness.registration()!.slots.sidebar_content;

    // Render ONCE for sess-A and sess-B
    const viewA = renderSlotOnce(solidDev, slotFn, ctx, "sess-A");
    const viewB = renderSlotOnce(solidDev, slotFn, ctx, "sess-B");
    await Promise.resolve();

    // Initial state is idle
    expect(flatten(viewA.root)).toEqual(["Speed", "Prefill: --", "Decode:  --"]);
    expect(flatten(viewB.root)).toEqual(["Speed", "Prefill: --", "Decode:  --"]);

    // Complete a step for sess-A: ttft = 500ms, decode = 50 tok/s
    harness.emit("session.next.step.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-A1",
      timestamp: 1_000,
    });
    harness.emit("session.next.text.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-A1",
      timestamp: 1_500,
    });
    harness.emit("session.next.step.ended", {
      sessionID: "sess-A",
      assistantMessageID: "msg-A1",
      timestamp: 2_500,
      tokens: { input: 100, output: 50, reasoning: 0 },
    });
    await Promise.resolve();

    // PersistAverages updated kvStore to ttft: 500, decode: 50
    // viewA must reactively show "avg 500 ms" and "avg 50", NOT the stale 9000
    const linesA = flatten(viewA.root);
    expect(linesA[1]).toContain("(avg 500 ms)");
    expect(linesA[1]).not.toContain("9000");
    expect(linesA[2]).toBe("Decode:  50 (avg 50) tok/s");
    expect(linesA[2]).not.toContain("9000");

    // viewB remains idle
    expect(flatten(viewB.root)).toEqual(["Speed", "Prefill: --", "Decode:  --"]);

    // Complete a step for sess-B: ttft = 200ms, decode = 80 tok/s
    harness.emit("session.next.step.started", {
      sessionID: "sess-B",
      assistantMessageID: "msg-B1",
      timestamp: 3_000,
    });
    harness.emit("session.next.text.started", {
      sessionID: "sess-B",
      assistantMessageID: "msg-B1",
      timestamp: 3_200,
    });
    harness.emit("session.next.step.ended", {
      sessionID: "sess-B",
      assistantMessageID: "msg-B1",
      timestamp: 4_200,
      tokens: { input: 100, output: 80, reasoning: 0 },
    });
    await Promise.resolve();

    const linesB = flatten(viewB.root);
    expect(linesB[1]).toContain("(avg 200 ms)");
    expect(linesB[1]).not.toContain("8000");
    expect(linesB[2]).toBe("Decode:  80 (avg 80) tok/s");
    expect(linesB[2]).not.toContain("8000");

    // Verify viewA is still showing its own average, not affected by sess-B
    const linesA2 = flatten(viewA.root);
    expect(linesA2[1]).toContain("(avg 500 ms)");
    expect(linesA2[2]).toBe("Decode:  50 (avg 50) tok/s");

    viewA.dispose();
    viewB.dispose();
    await harness.dispose();
  });

  it("reactively detects api.kv.ready transitioning from false to true without re-calling sidebar_content", async () => {
    vi.stubGlobal("Bun", {
      env: { HOME: "/custom" },
      file: () => ({
        text: () => Promise.resolve(JSON.stringify({ showAverages: true, showTTFT: true })),
      }),
    });

    const kvStore = new Map<string, unknown>();
    const { plugin: reactivePlugin, solid: solidDev } = await loadReactivePlugin();
    const harness = createApiHarness(false); // kvReady starts FALSE!
    harness.kvGet.mockImplementation((k: string) => kvStore.get(k));
    // Do not overwrite pre-existing averages in kvStore so we can distinguish KV vs memory fallback
    harness.kvSet.mockImplementation((_k: string, _v: unknown) => {});
    await reactivePlugin.tui(harness.api);

    const ctx = { theme: { current: { text: "white", textMuted: "gray" } } };
    const slotFn = harness.registration()!.slots.sidebar_content;

    // Render ONCE while kv.ready is false
    const viewA = renderSlotOnce(solidDev, slotFn, ctx, "sess-A");
    const viewB = renderSlotOnce(solidDev, slotFn, ctx, "sess-B");
    await Promise.resolve();

    // Now kv becomes ready, and KV store has persisted averages: 500 ms / 50 tok/s
    (harness.api.kv as any).ready = true;
    kvStore.set("speed-measure:avg:sess-A:ttft", 500);
    kvStore.set("speed-measure:avg:sess-A:decode", 50);
    kvStore.set("speed-measure:avg:sess-B:ttft", 300);
    kvStore.set("speed-measure:avg:sess-B:decode", 80);

    // Complete a step for sess-A with different single-step metrics (ttft: 100ms, decode: 10 tok/s)
    harness.emit("session.next.step.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-A1",
      timestamp: 1_000,
    });
    harness.emit("session.next.text.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-A1",
      timestamp: 1_100,
    });
    harness.emit("session.next.step.ended", {
      sessionID: "sess-A",
      assistantMessageID: "msg-A1",
      timestamp: 2_100,
      tokens: { input: 100, output: 10, reasoning: 0 },
    });
    await Promise.resolve();

    // If api.kv.ready was hoisted, it would still see false, returning undefined for persistedAverages,
    // which falls back to in-memory calculateSessionAverages (showing "avg 100 ms" and "avg 10").
    // With proper reactivity, it must show KV averages: "avg 500 ms" and "avg 50".
    const linesA = flatten(viewA.root);
    expect(linesA[1]).toContain("(avg 500 ms)");
    expect(linesA[1]).not.toContain("(avg 100 ms)");
    expect(linesA[2]).toBe("Decode:  10 (avg 50) tok/s");

    // Also verify sess-B with different metrics (ttft: 150ms, decode: 20 tok/s)
    harness.emit("session.next.step.started", {
      sessionID: "sess-B",
      assistantMessageID: "msg-B1",
      timestamp: 3_000,
    });
    harness.emit("session.next.text.started", {
      sessionID: "sess-B",
      assistantMessageID: "msg-B1",
      timestamp: 3_150,
    });
    harness.emit("session.next.step.ended", {
      sessionID: "sess-B",
      assistantMessageID: "msg-B1",
      timestamp: 4_150,
      tokens: { input: 100, output: 20, reasoning: 0 },
    });
    await Promise.resolve();

    const linesB = flatten(viewB.root);
    expect(linesB[1]).toContain("(avg 300 ms)");
    expect(linesB[1]).not.toContain("(avg 150 ms)");
    expect(linesB[2]).toBe("Decode:  20 (avg 80) tok/s");

    viewA.dispose();
    viewB.dispose();
    await harness.dispose();
  });

  it("reactively updates display when showTTFT is false across multiple sessions", async () => {
    vi.stubGlobal("Bun", {
      env: { HOME: "/custom" },
      file: () => ({
        text: () => Promise.resolve(JSON.stringify({ showTTFT: false })),
      }),
    });

    const { plugin: reactivePlugin, solid: solidDev } = await loadReactivePlugin();
    const harness = createApiHarness();
    await reactivePlugin.tui(harness.api);

    const ctx = { theme: { current: { text: "white", textMuted: "gray" } } };
    const slotFn = harness.registration()!.slots.sidebar_content;

    const viewA = renderSlotOnce(solidDev, slotFn, ctx, "sess-A");
    const viewB = renderSlotOnce(solidDev, slotFn, ctx, "sess-B");
    await Promise.resolve();

    expect(flatten(viewA.root)).toEqual(["Speed", "Prefill: --", "Decode:  --"]);

    // Complete a step with prefill tok/s
    harness.emit("session.next.step.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-A1",
      timestamp: 1_000,
    });
    harness.emit("session.next.text.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-A1",
      timestamp: 1_200,
    });
    harness.emit("session.next.step.ended", {
      sessionID: "sess-A",
      assistantMessageID: "msg-A1",
      timestamp: 2_200,
      tokens: { input: 100, output: 50, reasoning: 0 },
    });
    await Promise.resolve();

    const linesA = flatten(viewA.root);
    // Under showTTFT: false, prefill shows prefillTokPerSec
    expect(linesA[1]).toMatch(/^Prefill: \d+ tok\/s$/);
    expect(linesA[2]).toBe("Decode:  50 tok/s");
    expect(flatten(viewB.root)).toEqual(["Speed", "Prefill: --", "Decode:  --"]);

    viewA.dispose();
    viewB.dispose();
    await harness.dispose();
  });

  it("reactively updates the same rendered tree when props.session_id changes without re-calling sidebar_content (DD1)", async () => {
    const { plugin: reactivePlugin, solid: solidDev } = await loadReactivePlugin();
    const harness = createApiHarness();
    await reactivePlugin.tui(harness.api);

    const ctx = { theme: { current: { text: "white", textMuted: "gray" } } };
    const slotFn = harness.registration()!.slots.sidebar_content;

    // Seed different metrics for sess-A (ttft 250ms, decode 50 tok/s) and sess-B (ttft 100ms, decode 80 tok/s)
    harness.emit("session.next.step.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-A1",
      timestamp: 1_000,
    });
    harness.emit("session.next.text.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-A1",
      textID: "txt-A1",
      timestamp: 1_250,
    });
    harness.emit("session.next.step.ended", {
      sessionID: "sess-A",
      assistantMessageID: "msg-A1",
      timestamp: 2_250,
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
    });

    harness.emit("session.next.step.started", {
      sessionID: "sess-B",
      assistantMessageID: "msg-B1",
      timestamp: 3_000,
    });
    harness.emit("session.next.text.started", {
      sessionID: "sess-B",
      assistantMessageID: "msg-B1",
      textID: "txt-B1",
      timestamp: 3_100,
    });
    harness.emit("session.next.step.ended", {
      sessionID: "sess-B",
      assistantMessageID: "msg-B1",
      timestamp: 4_100,
      tokens: { input: 100, output: 80, reasoning: 0, cache: { read: 0, write: 0 } },
    });

    // Reactive props with getter delegating to Solid signal (matching OpenTUI splitProps contract)
    const [currentSessionId, setCurrentSessionId] = solidDev.createSignal("sess-A");
    const reactiveProps = {
      get session_id() {
        return currentSessionId();
      },
    };

    let callCount = 0;
    const trackingSlotFn = (c: any, p: any) => {
      callCount++;
      return slotFn(c, p);
    };

    // Render ONCE inside createRoot
    const view = renderSlotOnce(solidDev, trackingSlotFn, ctx, reactiveProps);
    await Promise.resolve();

    expect(callCount).toBe(1);
    const initialLines = flatten(view.root);
    expect(initialLines[0]).toBe("Speed");
    expect(initialLines[1]).toMatch(/^Prefill: 250 ms/);
    expect(initialLines[2]).toBe("Decode:  50 tok/s");

    // Switch session_id to sess-B on the same rendered tree
    setCurrentSessionId("sess-B");
    await Promise.resolve();

    // Verify tree updated to sess-B without re-calling sidebar_content
    expect(callCount).toBe(1);
    const switchedLines = flatten(view.root);
    expect(switchedLines[0]).toBe("Speed");
    expect(switchedLines[1]).toMatch(/^Prefill: 100 ms/);
    expect(switchedLines[2]).toBe("Decode:  80 tok/s");

    // Switch back to sess-A
    setCurrentSessionId("sess-A");
    await Promise.resolve();

    expect(callCount).toBe(1);
    const switchedBackLines = flatten(view.root);
    expect(switchedBackLines[1]).toMatch(/^Prefill: 250 ms/);
    expect(switchedBackLines[2]).toBe("Decode:  50 tok/s");

    // Switch to an idle/unseeded session
    setCurrentSessionId("sess-C");
    await Promise.resolve();

    expect(callCount).toBe(1);
    expect(flatten(view.root)).toEqual(["Speed", "Prefill: --", "Decode:  --"]);

    view.dispose();
    await harness.dispose();
  });

  it("reactively updates cache read counts on the same rendered tree when props.session_id changes under showCache: true (DD1)", async () => {
    vi.stubGlobal("Bun", {
      env: { HOME: "/custom" },
      file: () => ({
        text: () => Promise.resolve(JSON.stringify({ showCache: true })),
      }),
    });

    const { plugin: reactivePlugin, solid: solidDev } = await loadReactivePlugin();
    const harness = createApiHarness();
    await reactivePlugin.tui(harness.api);

    const ctx = { theme: { current: { text: "white", textMuted: "gray" } } };
    const slotFn = harness.registration()!.slots.sidebar_content;

    // sess-A: cache read 15
    harness.emit("session.next.step.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-A1",
      timestamp: 1_000,
    });
    harness.emit("session.next.text.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-A1",
      timestamp: 1_100,
    });
    harness.emit("session.next.step.ended", {
      sessionID: "sess-A",
      assistantMessageID: "msg-A1",
      timestamp: 2_100,
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 15, write: 0 } },
    });

    // sess-B: cache read 42
    harness.emit("session.next.step.started", {
      sessionID: "sess-B",
      assistantMessageID: "msg-B1",
      timestamp: 3_000,
    });
    harness.emit("session.next.text.started", {
      sessionID: "sess-B",
      assistantMessageID: "msg-B1",
      timestamp: 3_100,
    });
    harness.emit("session.next.step.ended", {
      sessionID: "sess-B",
      assistantMessageID: "msg-B1",
      timestamp: 4_100,
      tokens: { input: 100, output: 80, reasoning: 0, cache: { read: 42, write: 0 } },
    });

    const [currentSessionId, setCurrentSessionId] = solidDev.createSignal("sess-A");
    const reactiveProps = {
      get session_id() {
        return currentSessionId();
      },
    };

    let callCount = 0;
    const trackingSlotFn = (c: any, p: any) => {
      callCount++;
      return slotFn(c, p);
    };

    const view = renderSlotOnce(solidDev, trackingSlotFn, ctx, reactiveProps);
    await Promise.resolve();

    expect(callCount).toBe(1);
    expect(flatten(view.root)[1]).toContain("│ cache 15");
    expect(flatten(view.root)[1]).not.toContain("cache 42");

    // Switch to sess-B
    setCurrentSessionId("sess-B");
    await Promise.resolve();

    expect(callCount).toBe(1);
    expect(flatten(view.root)[1]).toContain("│ cache 42");
    expect(flatten(view.root)[1]).not.toContain("cache 15");

    // Switch back to sess-A
    setCurrentSessionId("sess-A");
    await Promise.resolve();

    expect(callCount).toBe(1);
    expect(flatten(view.root)[1]).toContain("│ cache 15");

    view.dispose();
    await harness.dispose();
  });

  it("reactively updates persisted averages on the same rendered tree when props.session_id changes under showAverages: true (DD1)", async () => {
    vi.stubGlobal("Bun", {
      env: { HOME: "/custom" },
      file: () => ({
        text: () => Promise.resolve(JSON.stringify({ showAverages: true, showTTFT: true })),
      }),
    });

    const kvStore = new Map<string, unknown>();
    const harness = createApiHarness(true);
    harness.kvGet.mockImplementation((k: string) => kvStore.get(k));
    // Do not overwrite pre-existing averages in kvStore so we can verify persisted KV values
    harness.kvSet.mockImplementation((_k: string, _v: unknown) => {});

    kvStore.set("speed-measure:avg:sess-A:ttft", 200);
    kvStore.set("speed-measure:avg:sess-A:decode", 30);
    kvStore.set("speed-measure:avg:sess-A:prefill", 150);

    kvStore.set("speed-measure:avg:sess-B:ttft", 500);
    kvStore.set("speed-measure:avg:sess-B:decode", 90);
    kvStore.set("speed-measure:avg:sess-B:prefill", 600);

    const { plugin: reactivePlugin, solid: solidDev } = await loadReactivePlugin();
    await reactivePlugin.tui(harness.api);

    const ctx = { theme: { current: { text: "white", textMuted: "gray" } } };
    const slotFn = harness.registration()!.slots.sidebar_content;

    // Both sessions have completed a step
    harness.emit("session.next.step.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-A1",
      timestamp: 1_000,
    });
    harness.emit("session.next.text.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-A1",
      timestamp: 1_200,
    });
    harness.emit("session.next.step.ended", {
      sessionID: "sess-A",
      assistantMessageID: "msg-A1",
      timestamp: 2_200,
      tokens: { input: 100, output: 20, reasoning: 0 },
    });

    harness.emit("session.next.step.started", {
      sessionID: "sess-B",
      assistantMessageID: "msg-B1",
      timestamp: 3_000,
    });
    harness.emit("session.next.text.started", {
      sessionID: "sess-B",
      assistantMessageID: "msg-B1",
      timestamp: 3_100,
    });
    harness.emit("session.next.step.ended", {
      sessionID: "sess-B",
      assistantMessageID: "msg-B1",
      timestamp: 4_100,
      tokens: { input: 100, output: 40, reasoning: 0 },
    });

    const [currentSessionId, setCurrentSessionId] = solidDev.createSignal("sess-A");
    const reactiveProps = {
      get session_id() {
        return currentSessionId();
      },
    };

    let callCount = 0;
    const trackingSlotFn = (c: any, p: any) => {
      callCount++;
      return slotFn(c, p);
    };

    const view = renderSlotOnce(solidDev, trackingSlotFn, ctx, reactiveProps);
    await Promise.resolve();

    expect(callCount).toBe(1);
    const linesA = flatten(view.root);
    expect(linesA[1]).toContain("(avg 200 ms)");
    expect(linesA[2]).toBe("Decode:  20 (avg 30) tok/s");

    // Switch to sess-B
    setCurrentSessionId("sess-B");
    await Promise.resolve();

    expect(callCount).toBe(1);
    const linesB = flatten(view.root);
    expect(linesB[1]).toContain("(avg 500 ms)");
    expect(linesB[2]).toBe("Decode:  40 (avg 90) tok/s");

    // Switch back to sess-A
    setCurrentSessionId("sess-A");
    await Promise.resolve();

    expect(callCount).toBe(1);
    const linesA2 = flatten(view.root);
    expect(linesA2[1]).toContain("(avg 200 ms)");
    expect(linesA2[2]).toBe("Decode:  20 (avg 30) tok/s");

    view.dispose();
    await harness.dispose();
  });

  it("reactively switches in-flight phases (prefilling/decoding) on the same rendered tree when props.session_id changes (DD1)", async () => {
    const { plugin: reactivePlugin, solid: solidDev } = await loadReactivePlugin();
    const harness = createApiHarness();
    await reactivePlugin.tui(harness.api);

    const ctx = { theme: { current: { text: "white", textMuted: "gray" } } };
    const slotFn = harness.registration()!.slots.sidebar_content;

    // sess-A: decoding
    harness.emit("session.next.step.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-A1",
      timestamp: 1_000,
    });
    harness.emit("session.next.text.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-A1",
      timestamp: 1_200,
    });

    // sess-B: prefilling
    harness.emit("session.next.step.started", {
      sessionID: "sess-B",
      assistantMessageID: "msg-B1",
      timestamp: 2_000,
    });

    const [currentSessionId, setCurrentSessionId] = solidDev.createSignal("sess-A");
    const reactiveProps = {
      get session_id() {
        return currentSessionId();
      },
    };

    const view = renderSlotOnce(solidDev, slotFn, ctx, reactiveProps);
    await Promise.resolve();

    const linesA = flatten(view.root);
    expect(linesA[1]).toMatch(/^Prefill: 200 ms/);
    expect(linesA[2]).toBe("Decode:  …");

    // Switch to sess-B
    setCurrentSessionId("sess-B");
    await Promise.resolve();

    const linesB = flatten(view.root);
    expect(linesB[1]).toBe("Prefill: …");
    expect(linesB[2]).toBe("Decode:  --");

    // Switch back to sess-A
    setCurrentSessionId("sess-A");
    await Promise.resolve();

    const linesA2 = flatten(view.root);
    expect(linesA2[1]).toMatch(/^Prefill: 200 ms/);
    expect(linesA2[2]).toBe("Decode:  …");

    view.dispose();
    await harness.dispose();
  });
});

describe("in-memory session averages separation (BB2)", () => {
  it("uses requested session's own averages from memory when extras.averages is undefined", () => {
    const state: CollectorState = new Map([
      [
        "sess-A",
        {
          current: {
            phase: "done" as const,
            sessionID: "sess-A",
            ttft: 100,
            prefillTokPerSec: 200,
            decodeTokPerSec: 10,
          },
          stepHistory: [
            {
              phase: "done" as const,
              sessionID: "sess-A",
              ttft: 100,
              prefillTokPerSec: 200,
              decodeTokPerSec: 10,
            },
          ],
        },
      ],
      [
        "sess-B",
        {
          current: {
            phase: "done" as const,
            sessionID: "sess-B",
            ttft: 900,
            prefillTokPerSec: 200,
            decodeTokPerSec: 90,
          },
          stepHistory: [
            {
              phase: "done" as const,
              sessionID: "sess-B",
              ttft: 900,
              prefillTokPerSec: 200,
              decodeTokPerSec: 90,
            },
          ],
        },
      ],
    ]) as unknown as CollectorState;

    const config: SpeedMeasureConfig = {
      ...DEFAULT_CONFIG,
      showAverages: true,
      showTTFT: true,
    };

    // extras.averages is undefined -> calculateSessionAverages(state.get(sessionID))
    const linesB = buildDisplayLines(state, "sess-B", config, {});
    expect(linesB.decode).toBe("Decode:  90 (avg 90) tok/s");
    expect(linesB.prefill).toContain("900 ms (avg 900 ms)");

    const linesA = buildDisplayLines(state, "sess-A", config, {});
    expect(linesA.decode).toBe("Decode:  10 (avg 10) tok/s");
    expect(linesA.prefill).toContain("100 ms (avg 100 ms)");
  });

  it("separates session averages in plugin UI when api.kv is not ready", async () => {
    vi.stubGlobal("Bun", {
      env: { HOME: "/Users/discord4415" },
      file: () => ({
        text: () =>
          Promise.resolve(JSON.stringify({ showAverages: true, showTTFT: true })),
      }),
    });

    const harness = createApiHarness(false); // kvReady = false
    await plugin.tui(harness.api);

    // Complete a step for sess-A
    harness.emit("session.next.step.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-A",
      timestamp: 1_000,
    });
    harness.emit("session.next.text.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-A",
      textID: "txt-A",
      timestamp: 1_100,
    });
    harness.emit("session.next.step.ended", {
      sessionID: "sess-A",
      assistantMessageID: "msg-A",
      timestamp: 2_100,
      tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
    });

    // Complete a step for sess-B
    harness.emit("session.next.step.started", {
      sessionID: "sess-B",
      assistantMessageID: "msg-B",
      timestamp: 3_000,
    });
    harness.emit("session.next.text.started", {
      sessionID: "sess-B",
      assistantMessageID: "msg-B",
      textID: "txt-B",
      timestamp: 3_900,
    });
    harness.emit("session.next.step.ended", {
      sessionID: "sess-B",
      assistantMessageID: "msg-B",
      timestamp: 4_900,
      tokens: { input: 100, output: 90, reasoning: 0, cache: { read: 0, write: 0 } },
    });

    // Both sessions should display their OWN average
    const linesB = sidebarLines(harness.registration(), "sess-B");
    expect(linesB[2]).toBe("Decode:  90 (avg 90) tok/s");
    expect(linesB[1]).toContain("900 ms (avg 900 ms)");

    const linesA = sidebarLines(harness.registration(), "sess-A");
    expect(linesA[2]).toBe("Decode:  10 (avg 10) tok/s");
    expect(linesA[1]).toContain("100 ms (avg 100 ms)");

    await harness.dispose();
  });
});

describe("v1-only server dispose cleanup (BB3)", () => {
  it("releases v1 subscriptions when disposed after fallback without any v2 events", async () => {
    vi.useFakeTimers();
    try {
      const harness = createApiHarness();
      await plugin.tui(harness.api);

      // No v2 events emitted at all. Let the 2,000 ms fallback gate expire.
      vi.advanceTimersByTime(2_000);

      // v1 fallback should now be active, registering message.part.updated and message.part.delta
      const updatedHandlers = harness.handlers.get("message.part.updated");
      const deltaHandlers = harness.handlers.get("message.part.delta");
      expect(updatedHandlers?.size).toBe(1);
      expect(deltaHandlers?.size).toBe(1);

      // Dispose while still in v1-only mode
      await harness.dispose();

      // Verify all unsubscriptions were called
      expect(updatedHandlers?.size).toBe(0);
      expect(deltaHandlers?.size).toBe(0);
      expect(
        harness.unsubscribeSpies.every((u) => u.mock.calls.length === 1),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("default cache value when tokens.cache is omitted (BB4)", () => {
  it("displays cache 0 when v2 step.ended omits tokens.cache under showCache", async () => {
    vi.stubGlobal("Bun", {
      env: { HOME: "/Users/discord4415" },
      file: () => ({
        text: () => Promise.resolve(JSON.stringify({ showCache: true })),
      }),
    });

    const harness = createApiHarness();
    await plugin.tui(harness.api);

    harness.emit("session.next.step.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-1",
      timestamp: 1_000,
    });
    harness.emit("session.next.text.started", {
      sessionID: "sess-A",
      assistantMessageID: "msg-1",
      textID: "txt-1",
      timestamp: 1_200,
    });
    harness.emit("session.next.step.ended", {
      sessionID: "sess-A",
      assistantMessageID: "msg-1",
      timestamp: 2_200,
      tokens: { input: 100, output: 50, reasoning: 0 }, // cache omitted!
    });

    const lines = sidebarLines(harness.registration(), "sess-A");
    expect(lines[1]).toMatch(/│ cache 0$/);

    await harness.dispose();
  });

  it("displays cache 0 when v1 step-finish omits tokens.cache under showCache", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("Bun", {
        env: { HOME: "/Users/discord4415" },
        file: () => ({
          text: () => Promise.resolve(JSON.stringify({ showCache: true })),
        }),
      });

      const harness = createApiHarness();
      await plugin.tui(harness.api);

      vi.advanceTimersByTime(2_000);

      harness.emit("message.part.updated", {
        part: {
          type: "step-start",
          sessionID: "sess-A",
          messageID: "msg-1",
        },
      });
      vi.advanceTimersByTime(200);
      harness.emit("message.part.delta", {
        sessionID: "sess-A",
        messageID: "msg-1",
        field: "text",
        delta: "hello world",
      });
      vi.advanceTimersByTime(800);
      harness.emit("message.part.updated", {
        part: {
          type: "step-finish",
          sessionID: "sess-A",
          messageID: "msg-1",
          tokens: { input: 100, output: 50, reasoning: 0 }, // cache omitted!
        },
      });

      const lines = sidebarLines(harness.registration(), "sess-A");
      expect(lines[1]).toMatch(/│ cache 0$/);

      await harness.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("tool execution time exclusion (v2 and v1 fallback)", () => {
  it("excludes the tool execution interval from v2 decode speed", async () => {
    vi.useFakeTimers();
    try {
      const harness = createApiHarness();
      await plugin.tui(harness.api);

      harness.emit("session.next.step.started", {
        sessionID: "sess-A",
        assistantMessageID: "msg-A",
        timestamp: 0,
      });
      harness.emit("session.next.text.started", {
        sessionID: "sess-A",
        assistantMessageID: "msg-A",
        textID: "text-A",
        timestamp: 500,
      });
      harness.emit("session.next.tool.called", {
        sessionID: "sess-A",
        assistantMessageID: "msg-A",
        timestamp: 1_000,
        callID: "call-1",
        tool: "bash",
        input: { command: "sleep 60" },
        provider: { executed: false },
      });
      harness.emit("session.next.tool.success", {
        sessionID: "sess-A",
        assistantMessageID: "msg-A",
        timestamp: 61_000,
        callID: "call-1",
        structured: {},
        content: [],
        provider: { executed: false },
      });
      harness.emit("session.next.step.ended", {
        sessionID: "sess-A",
        assistantMessageID: "msg-A",
        timestamp: 61_100,
        finish: "stop",
        cost: 0,
        tokens: {
          input: 120,
          output: 50,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      });

      const lines = sidebarLines(harness.registration(), "sess-A");
      // Decode window 61,100 - 500 = 60,600 ms; tool [1,000, 61,000] = 60,000 ms.
      // 50 tokens / 0.6 s = 83.3 tok/s (pre-fix this displayed 0.8 tok/s).
      expect(lines[1]).toBe("Prefill: 500 ms │ 240 tok/s");
      expect(lines[2]).toBe("Decode:  83.3 tok/s");

      await harness.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("excludes the tool execution interval from v1 fallback decode speed", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);
      const harness = createApiHarness();
      await plugin.tui(harness.api);

      // Let the 2,000 ms fallback gate expire (now = 12,000).
      vi.advanceTimersByTime(2_000);

      harness.emit("message.part.updated", {
        part: {
          type: "step-start",
          sessionID: "sess-A",
          messageID: "msg-A",
        },
      });

      // First text delta at 12,500 -> t1 = 12,500, TTFT = 500 ms.
      vi.advanceTimersByTime(500);
      harness.emit("message.part.delta", {
        sessionID: "sess-A",
        messageID: "msg-A",
        partID: "text-A",
        field: "text",
        delta: "calling the bash tool now",
      });

      // Tool runs from 13,000 to 73,000 (60,000 ms) inside the step span.
      harness.emit("message.part.updated", {
        part: {
          type: "tool",
          sessionID: "sess-A",
          messageID: "msg-A",
          callID: "call-1",
          tool: "bash",
          state: {
            status: "running",
            input: { command: "sleep 60" },
            time: { start: 13_000 },
          },
        },
      });
      harness.emit("message.part.updated", {
        part: {
          type: "tool",
          sessionID: "sess-A",
          messageID: "msg-A",
          callID: "call-1",
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "sleep 60" },
            output: "",
            title: "bash",
            metadata: {},
            time: { start: 13_000, end: 73_000 },
          },
        },
      });

      // step-finish at 73,100 -> raw window 60,600 ms minus tool 60,000 ms = 600 ms.
      vi.advanceTimersByTime(60_600);
      harness.emit("message.part.updated", {
        part: {
          type: "step-finish",
          sessionID: "sess-A",
          messageID: "msg-A",
          tokens: {
            input: 120,
            output: 50,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
      });

      const lines = sidebarLines(harness.registration(), "sess-A");
      expect(lines[1]).toBe("Prefill: 500 ms │ 240 tok/s");
      expect(lines[2]).toBe("Decode:  83.3 tok/s");

      await harness.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("freezes the v2 live estimate while a tool is running", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(100_000);
      const harness = createApiHarness();
      await plugin.tui(harness.api);

      harness.emit("session.next.step.started", {
        sessionID: "sess-A",
        assistantMessageID: "msg-A",
        timestamp: 100_000,
      });
      harness.emit("session.next.text.started", {
        sessionID: "sess-A",
        assistantMessageID: "msg-A",
        textID: "text-A",
        timestamp: 100_050,
      });
      harness.emit("session.next.text.delta", {
        sessionID: "sess-A",
        delta: "1234567890",
      });

      // Tick at 100,450 -> 10 chars / 0.4 s = 25 chars/s.
      vi.advanceTimersByTime(450);
      expect(sidebarLines(harness.registration(), "sess-A")[2]).toBe(
        "Decode:  ~25 chars/s",
      );

      harness.emit("session.next.tool.called", {
        sessionID: "sess-A",
        assistantMessageID: "msg-A",
        timestamp: 100_500,
        callID: "call-1",
        tool: "bash",
        input: { command: "sleep 60" },
        provider: { executed: false },
      });

      // 1.5 s pass while the tool runs; the frozen estimate must not decay.
      vi.advanceTimersByTime(1_500);
      expect(sidebarLines(harness.registration(), "sess-A")[2]).toBe(
        "Decode:  ~25 chars/s",
      );

      await harness.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
