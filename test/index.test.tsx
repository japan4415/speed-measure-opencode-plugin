import { afterEach, describe, expect, it, vi } from "vitest";

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

import type { CollectorState } from "../src/collector.js";
import {
  DEFAULT_CONFIG,
  buildDisplayLines,
  loadConfig,
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

describe("loadConfig", () => {
  it("returns default config when file read rejects or throws (file absent, permission error)", async () => {
    vi.stubGlobal("Bun", {
      env: { HOME: "/test-home" },
      file: vi.fn(() => ({
        text: vi.fn().mockRejectedValue(new Error("ENOENT: no such file or directory")),
      })),
    });
    const config = await loadConfig();
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("returns default config when Bun.file synchronously throws", async () => {
    vi.stubGlobal("Bun", {
      env: { HOME: "/test-home" },
      file: vi.fn(() => {
        throw new Error("EACCES: permission denied");
      }),
    });
    const config = await loadConfig();
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

  it("calls Solid root dispose when onDispose is triggered", async () => {
    vi.useFakeTimers();
    rootDisposeSpy = undefined;

    const harness = createApiHarness();
    await plugin.tui(harness.api);

    expect(rootDisposeSpy).toBeDefined();
    expect(rootDisposeSpy).not.toHaveBeenCalled();

    await harness.dispose();

    expect(rootDisposeSpy).toHaveBeenCalledOnce();
  });

  it("initializes with default config without throwing when config file read rejects", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("Bun", {
      env: { HOME: "/test-home" },
      file: vi.fn(() => ({
        text: vi.fn().mockRejectedValue(new Error("ENOENT: file not found")),
      })),
    });
    const harness = createApiHarness();
    await expect(plugin.tui(harness.api)).resolves.not.toThrow();

    expect(harness.registration()?.order).toBe(150);
    expect(sidebarLines(harness.registration())).toEqual([
      "Speed",
      "Prefill: --",
      "Decode:  --",
    ]);

    await harness.dispose();
  });

  it("applies custom configuration (order and liveIntervalMs)", async () => {
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
      sessionID: "session-1",
      assistantMessageID: "msg-1",
      timestamp: 10_000,
    });
    harness.emit("session.next.text.started", {
      sessionID: "session-1",
      assistantMessageID: "msg-1",
      timestamp: 10_000,
    });
    harness.emit("session.next.text.delta", {
      sessionID: "session-1",
      delta: "123456789012345678901234567890",
    });

    vi.advanceTimersByTime(250);
    expect(sidebarLines(harness.registration())[2]).toBe("Decode:  …");

    vi.advanceTimersByTime(50);
    expect(sidebarLines(harness.registration())[2]).toBe("Decode:  ~100 tok/s");

    await harness.dispose();
  });

  it("updates display to prefilling on session.next.step.started", async () => {
    vi.useFakeTimers();
    const harness = createApiHarness();
    await plugin.tui(harness.api);

    harness.emit("session.next.step.started", {
      sessionID: "session-1",
      assistantMessageID: "msg-1",
      timestamp: 1_000,
    });

    expect(sidebarLines(harness.registration())).toEqual([
      "Speed",
      "Prefill: …",
      "Decode:  --",
    ]);

    await harness.dispose();
  });

  it("transitions to decoding with reasoning timestamp on session.next.reasoning.started", async () => {
    vi.useFakeTimers();
    const harness = createApiHarness();
    await plugin.tui(harness.api);

    harness.emit("session.next.step.started", {
      sessionID: "session-1",
      assistantMessageID: "msg-1",
      timestamp: 1_000,
    });

    harness.emit("session.next.reasoning.started", {
      sessionID: "session-1",
      assistantMessageID: "msg-1",
      reasoningID: "reason-1",
      timestamp: 1_250,
    });

    expect(sidebarLines(harness.registration())).toEqual([
      "Speed",
      "Prefill: 250 ms",
      "Decode:  …",
    ]);

    await harness.dispose();
  });

  it("transitions to decoding on session.next.text.started", async () => {
    vi.useFakeTimers();
    const harness = createApiHarness();
    await plugin.tui(harness.api);

    harness.emit("session.next.step.started", {
      sessionID: "session-1",
      assistantMessageID: "msg-1",
      timestamp: 1_000,
    });

    harness.emit("session.next.text.started", {
      sessionID: "session-1",
      assistantMessageID: "msg-1",
      textID: "text-1",
      timestamp: 1_400,
    });

    expect(sidebarLines(harness.registration())).toEqual([
      "Speed",
      "Prefill: 400 ms",
      "Decode:  …",
    ]);

    await harness.dispose();
  });

  it("accumulates live chars and updates live estimate on session.next.reasoning.delta", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const harness = createApiHarness();
    await plugin.tui(harness.api);

    harness.emit("session.next.step.started", {
      sessionID: "session-1",
      assistantMessageID: "msg-1",
      timestamp: 10_000,
    });
    harness.emit("session.next.reasoning.started", {
      sessionID: "session-1",
      assistantMessageID: "msg-1",
      timestamp: 10_000,
    });

    harness.emit("session.next.reasoning.delta", {
      sessionID: "session-1",
      delta: "12345678901234567890", // 20 chars
    });

    expect(sidebarLines(harness.registration())[2]).toBe("Decode:  …");

    // Default liveIntervalMs is 150ms. At 150ms, elapsed = 0.15s: 20 chars / 0.15s = 133.3 tok/s
    vi.advanceTimersByTime(150);
    expect(sidebarLines(harness.registration())[2]).toBe("Decode:  ~133.3 tok/s");

    await harness.dispose();
  });

  it("accumulates live chars and updates live estimate on session.next.text.delta", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const harness = createApiHarness();
    await plugin.tui(harness.api);

    harness.emit("session.next.step.started", {
      sessionID: "session-1",
      assistantMessageID: "msg-1",
      timestamp: 10_000,
    });
    harness.emit("session.next.text.started", {
      sessionID: "session-1",
      assistantMessageID: "msg-1",
      timestamp: 10_000,
    });

    harness.emit("session.next.text.delta", {
      sessionID: "session-1",
      delta: "123456789012345678901234567890", // 30 chars
    });

    expect(sidebarLines(harness.registration())[2]).toBe("Decode:  …");

    // Default liveIntervalMs is 150ms. At 150ms, elapsed = 0.15s: 30 chars / 0.15s = 200 tok/s
    vi.advanceTimersByTime(150);
    expect(sidebarLines(harness.registration())[2]).toBe("Decode:  ~200 tok/s");

    await harness.dispose();
  });


  it("finalizes measurements on session.next.step.ended", async () => {
    vi.useFakeTimers();
    const harness = createApiHarness();
    await plugin.tui(harness.api);

    harness.emit("session.next.step.started", {
      sessionID: "session-1",
      assistantMessageID: "msg-1",
      timestamp: 1_000,
    });
    harness.emit("session.next.text.started", {
      sessionID: "session-1",
      assistantMessageID: "msg-1",
      timestamp: 1_500,
    });
    harness.emit("session.next.step.ended", {
      sessionID: "session-1",
      assistantMessageID: "msg-1",
      timestamp: 2_500,
      tokens: {
        input: 100,
        output: 60,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    });

    expect(sidebarLines(harness.registration())).toEqual([
      "Speed",
      "Prefill: 500 ms │ 200 tok/s",
      "Decode:  60 tok/s",
    ]);

    await harness.dispose();
  });

  it("transitions to error on session.next.step.failed", async () => {
    vi.useFakeTimers();
    const harness = createApiHarness();
    await plugin.tui(harness.api);

    harness.emit("session.next.step.started", {
      sessionID: "session-1",
      assistantMessageID: "msg-1",
      timestamp: 1_000,
    });

    harness.emit("session.next.step.failed", {
      sessionID: "session-1",
      assistantMessageID: "msg-1",
      error: new Error("step execution failed"),
    });

    expect(sidebarLines(harness.registration())).toEqual([
      "Speed",
      "Prefill: error",
      "Decode:  error",
    ]);

    await harness.dispose();
  });

  it("handles session.status: resets in-flight steps to idle and preserves done/error steps", async () => {
    vi.useFakeTimers();
    const harness = createApiHarness();
    await plugin.tui(harness.api);

    // 1. prefilling -> idle
    harness.emit("session.next.step.started", {
      sessionID: "session-1",
      assistantMessageID: "msg-1",
      timestamp: 1_000,
    });
    expect(sidebarLines(harness.registration())[1]).toBe("Prefill: …");

    harness.emit("session.status", {
      sessionID: "session-1",
      status: { type: "running" },
    });
    expect(sidebarLines(harness.registration())[1]).toBe("Prefill: …");

    harness.emit("session.status", {
      sessionID: "session-1",
      status: { type: "idle" },
    });
    expect(sidebarLines(harness.registration())).toEqual([
      "Speed",
      "Prefill: --",
      "Decode:  --",
    ]);

    // 2. decoding -> idle
    harness.emit("session.next.step.started", {
      sessionID: "session-1",
      assistantMessageID: "msg-2",
      timestamp: 2_000,
    });
    harness.emit("session.next.text.started", {
      sessionID: "session-1",
      assistantMessageID: "msg-2",
      timestamp: 2_300,
    });
    expect(sidebarLines(harness.registration())[1]).toBe("Prefill: 300 ms");

    harness.emit("session.status", {
      sessionID: "session-1",
      status: { type: "idle" },
    });
    expect(sidebarLines(harness.registration())).toEqual([
      "Speed",
      "Prefill: --",
      "Decode:  --",
    ]);

    // 3. done -> stays done on idle
    emitCompletedV2(harness, "session-1");
    expect(sidebarLines(harness.registration())).toEqual([
      "Speed",
      "Prefill: 500 ms │ 200 tok/s",
      "Decode:  60 tok/s",
    ]);
    harness.emit("session.status", {
      sessionID: "session-1",
      status: { type: "idle" },
    });
    expect(sidebarLines(harness.registration())).toEqual([
      "Speed",
      "Prefill: 500 ms │ 200 tok/s",
      "Decode:  60 tok/s",
    ]);

    // 4. error -> stays error on idle
    harness.emit("session.next.step.failed", {
      sessionID: "session-1",
      error: "failed",
    });
    expect(sidebarLines(harness.registration())).toEqual([
      "Speed",
      "Prefill: error",
      "Decode:  error",
    ]);
    harness.emit("session.status", {
      sessionID: "session-1",
      status: { type: "idle" },
    });
    expect(sidebarLines(harness.registration())).toEqual([
      "Speed",
      "Prefill: error",
      "Decode:  error",
    ]);

    await harness.dispose();
  });

  it("transitions to error on session.error for targeted session and all in-flight when sessionID is absent", async () => {
    vi.useFakeTimers();
    const harness = createApiHarness();
    await plugin.tui(harness.api);

    // 1. targeted sessionID
    harness.emit("session.next.step.started", {
      sessionID: "session-1",
      assistantMessageID: "msg-1",
      timestamp: 1_000,
    });
    expect(sidebarLines(harness.registration(), "session-1")[1]).toBe("Prefill: …");

    harness.emit("session.error", {
      sessionID: "session-1",
      error: "Network disconnect",
    });
    expect(sidebarLines(harness.registration(), "session-1")).toEqual([
      "Speed",
      "Prefill: error",
      "Decode:  error",
    ]);

    // 2. sessionID is undefined/null -> affects in-flight sessions
    harness.emit("session.next.step.started", {
      sessionID: "session-2",
      assistantMessageID: "msg-2",
      timestamp: 2_000,
    });
    expect(sidebarLines(harness.registration(), "session-2")[1]).toBe("Prefill: …");

    harness.emit("session.error", {
      error: "Global process crash",
    });
    expect(sidebarLines(harness.registration(), "session-2")).toEqual([
      "Speed",
      "Prefill: error",
      "Decode:  error",
    ]);

    await harness.dispose();
  });

  it("records and displays cache read count on step.ended when showCache is enabled", async () => {
    vi.useFakeTimers();
    const configured = await configuredPlugin({ showCache: true });
    const harness = createApiHarness();
    await configured.tui(harness.api);

    harness.emit("session.next.step.started", {
      sessionID: "session-1",
      assistantMessageID: "msg-1",
      timestamp: 1_000,
    });
    harness.emit("session.next.text.started", {
      sessionID: "session-1",
      assistantMessageID: "msg-1",
      timestamp: 1_500,
    });
    harness.emit("session.next.step.ended", {
      sessionID: "session-1",
      assistantMessageID: "msg-1",
      timestamp: 2_500,
      tokens: {
        input: 100,
        output: 60,
        reasoning: 0,
        cache: { read: 512, write: 0 },
      },
    });

    const lines = sidebarLines(harness.registration(), "session-1");
    expect(lines[1]).toBe("Prefill: 500 ms │ 200 tok/s │ cache 512");

    await harness.dispose();
  });

  it("reads and displays persisted averages from api.kv when showAverages is enabled", async () => {
    vi.useFakeTimers();
    const configured = await configuredPlugin({ showAverages: true });
    const harness = createApiHarness(true);

    harness.kvGet.mockImplementation((key: string) => {
      if (key === "speed-measure:avg:session-1:ttft") return 250;
      if (key === "speed-measure:avg:session-1:decode") return 75;
      if (key === "speed-measure:avg:session-1:prefill") return 1_500;
      return undefined;
    });

    await configured.tui(harness.api);

    emitCompletedV2(harness, "session-1");

    const lines = sidebarLines(harness.registration(), "session-1");
    expect(lines[1]).toContain("(avg 250 ms)");
    expect(lines[2]).toContain("(avg 75) tok/s");
    expect(harness.kvGet).toHaveBeenCalledWith("speed-measure:avg:session-1:ttft");
    expect(harness.kvGet).toHaveBeenCalledWith("speed-measure:avg:session-1:decode");
    expect(harness.kvGet).toHaveBeenCalledWith("speed-measure:avg:session-1:prefill");

    await harness.dispose();
  });
});



