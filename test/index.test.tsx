import { afterEach, describe, expect, it, vi } from "vitest";

import type { CollectorState } from "../src/collector.js";
import {
  DEFAULT_CONFIG,
  buildDisplayLines,
  parseConfig,
  scheduleV1Fallback,
} from "../src/index.js";
import plugin from "../src/index.js";

const V2_EVENT_NAMES = [
  "session.next.step.started",
  "session.next.reasoning.started",
  "session.next.reasoning.delta",
  "session.next.text.started",
  "session.next.text.delta",
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

function sidebarLines(
  registration: SidebarRegistration | undefined,
  sessionID = "session-1",
): string[] {
  expect(registration).toBeDefined();
  stubJsxRuntime();
  const tree = registration!.slots.sidebar_content(
    { theme: { current: { text: "white", textMuted: "gray" } } },
    { session_id: sessionID },
  );
  return tree.children.map(textContent);
}

function emitCompletedV2(
  harness: ReturnType<typeof createApiHarness>,
  sessionID = "session-1",
) {
  harness.emit("session.next.step.started", {
    sessionID,
    assistantMessageID: "message-1",
    timestamp: 1_000,
  });
  harness.emit("session.next.text.started", {
    sessionID,
    assistantMessageID: "message-1",
    textID: "text-1",
    timestamp: 1_500,
  });
  harness.emit("session.next.step.ended", {
    sessionID,
    assistantMessageID: "message-1",
    timestamp: 2_500,
    finish: "stop",
    cost: 0,
    tokens: {
      input: 100,
      output: 60,
      reasoning: 0,
      cache: { read: 25, write: 0 },
    },
  });
}

async function configuredPlugin(config: Record<string, unknown>) {
  vi.resetModules();
  vi.stubGlobal("Bun", {
    env: { HOME: "/test-home" },
    file: vi.fn(() => ({ text: async () => JSON.stringify(config) })),
  });
  return (await import("../src/index.js")).default;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("buildDisplayLines", () => {
  it("shows placeholders for an idle session", () => {
    expect(buildDisplayLines(new Map(), "session-1")).toEqual({
      prefill: "Prefill: --",
      decode: "Decode:  --",
    });
  });

  it("shows a live estimate while decoding", () => {
    const state: CollectorState = new Map([
      [
        "session-1",
        {
          current: {
            phase: "decoding",
            sessionID: "session-1",
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

    expect(buildDisplayLines(state, "session-1")).toEqual({
      prefill: "Prefill: 340 ms",
      decode: "Decode:  ~45.2 tok/s",
    });
  });

  it("shows final values for a completed step", () => {
    const done = {
      phase: "done" as const,
      sessionID: "session-1",
      ttft: 340,
      prefillTokPerSec: 2_100,
      decodeTokPerSec: 58.3,
    };
    const state: CollectorState = new Map([
      ["session-1", { current: done, stepHistory: [done] }],
    ]);

    expect(buildDisplayLines(state, "session-1")).toEqual({
      prefill: "Prefill: 340 ms │ 2.1k tok/s",
      decode: "Decode:  58.3 tok/s",
    });
  });

  it("honors non-default cache and TTFT display gates", () => {
    const done = {
      phase: "done" as const,
      sessionID: "session-1",
      ttft: 340,
      prefillTokPerSec: 2_100,
      decodeTokPerSec: 58.3,
    };
    const state: CollectorState = new Map([
      ["session-1", { current: done, stepHistory: [done] }],
    ]);

    expect(
      buildDisplayLines(
        state,
        "session-1",
        { ...DEFAULT_CONFIG, showCache: true },
        { cacheRead: 512 },
      ).prefill,
    ).toBe("Prefill: 340 ms │ 2.1k tok/s │ cache 512");
    expect(
      buildDisplayLines(
        state,
        "session-1",
        { ...DEFAULT_CONFIG, showTTFT: false },
        { cacheRead: 512 },
      ).prefill,
    ).toBe("Prefill: 2.1k tok/s");
  });

  it("hides TTFT while decoding when showTTFT is false", () => {
    const state: CollectorState = new Map([
      [
        "session-1",
        {
          current: {
            phase: "decoding",
            sessionID: "session-1",
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
      buildDisplayLines(state, "session-1", {
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

describe("parseConfig", () => {
  it("fixes the documented default slot order at 150", () => {
    expect(DEFAULT_CONFIG.order).toBe(150);
    expect(parseConfig("{}").order).toBe(150);
  });

  it("uses defaults when JSON parsing fails", () => {
    expect(parseConfig("{not valid json")).toEqual(DEFAULT_CONFIG);
  });

  it("accepts valid fields and defaults invalid field values", () => {
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

describe("plugin.tui", () => {
  it("registers one default-order sidebar slot and all nine v2 events", async () => {
    vi.useFakeTimers();
    const harness = createApiHarness();

    await plugin.tui(harness.api);

    expect(harness.register).toHaveBeenCalledOnce();
    expect(harness.registration()?.order).toBe(150);
    expect(harness.registration()?.slots.sidebar_content).toBeTypeOf("function");
    expect(harness.eventOn.mock.calls.map(([name]) => name)).toEqual(
      V2_EVENT_NAMES,
    );
    expect(sidebarLines(harness.registration())).toEqual([
      "Speed",
      "Prefill: --",
      "Decode:  --",
    ]);

    await harness.dispose();
  });

  it("activates and renders the v1 fallback with Date.now timestamps", async () => {
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

    harness.emit("message.part.updated", {
      part: {
        type: "step-start",
        sessionID: "session-1",
        messageID: "message-1",
      },
    });
    expect(sidebarLines(harness.registration()).slice(1)).toEqual([
      "Prefill: …",
      "Decode:  --",
    ]);

    vi.advanceTimersByTime(340);
    harness.emit("message.part.delta", {
      sessionID: "session-1",
      messageID: "message-1",
      partID: "text-1",
      field: "text",
      delta: "forty characters are enough for a sample",
    });
    expect(sidebarLines(harness.registration()).slice(1)).toEqual([
      "Prefill: 340 ms",
      "Decode:  …",
    ]);

    vi.advanceTimersByTime(1_000);
    harness.emit("message.part.updated", {
      part: {
        type: "step-finish",
        sessionID: "session-1",
        messageID: "message-1",
        tokens: {
          input: 714,
          output: 60,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      },
    });
    expect(sidebarLines(harness.registration()).slice(1)).toEqual([
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
      sessionID: "session-1",
      assistantMessageID: "message-1",
      timestamp: 1_000,
    });
    vi.advanceTimersByTime(2_000);

    expect(harness.eventOn).toHaveBeenCalledTimes(9);
    expect(harness.handlers.has("message.part.updated")).toBe(false);
    expect(harness.handlers.has("message.part.delta")).toBe(false);

    await harness.dispose();
  });

  it("does not persist averages with the default showAverages=false", async () => {
    vi.useFakeTimers();
    const harness = createApiHarness(true);
    await plugin.tui(harness.api);

    emitCompletedV2(harness);

    expect(harness.kvSet).not.toHaveBeenCalled();
    await harness.dispose();
  });

  it("persists averages under speed-measure keys when enabled and ready", async () => {
    vi.useFakeTimers();
    const configured = await configuredPlugin({ showAverages: true });
    const harness = createApiHarness(true);
    await configured.tui(harness.api);

    emitCompletedV2(harness);

    expect(harness.kvSet.mock.calls).toEqual([
      ["speed-measure:avg:session-1:ttft", 500],
      ["speed-measure:avg:session-1:decode", 60],
      ["speed-measure:avg:session-1:prefill", 200],
    ]);
    await harness.dispose();
  });

  it("does not persist averages until api.kv is ready", async () => {
    vi.useFakeTimers();
    const configured = await configuredPlugin({ showAverages: true });
    const harness = createApiHarness(false);
    await configured.tui(harness.api);

    emitCompletedV2(harness);

    expect(harness.kvSet).not.toHaveBeenCalled();
    await harness.dispose();
  });

  it("clears both timers and every v1/v2 subscription on dispose", async () => {
    vi.useFakeTimers();
    const beforeFallback = createApiHarness();
    await plugin.tui(beforeFallback.api);

    expect(vi.getTimerCount()).toBe(2);
    await beforeFallback.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(beforeFallback.unsubscribeSpies).toHaveLength(9);
    expect(
      beforeFallback.unsubscribeSpies.every(
        (unsubscribe) => unsubscribe.mock.calls.length === 1,
      ),
    ).toBe(true);

    const afterFallback = createApiHarness();
    await plugin.tui(afterFallback.api);
    vi.advanceTimersByTime(2_000);
    expect(afterFallback.unsubscribeSpies).toHaveLength(11);

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
});
