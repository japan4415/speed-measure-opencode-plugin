import { afterEach, describe, expect, it, vi } from "vitest";

import plugin, { type SessionAverages } from "../src/index.js";

type V2EventHandler = (event: {
  type: string;
  created: number;
  data: any;
}) => void;

type TestElement = {
  type: string;
  props: Record<string, unknown>;
  children: unknown[];
};

type SlotClaim = {
  append: string;
  render: (input: { sessionID: string }) => unknown;
};

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

function createV2Harness() {
  const handlers = new Map<string, Set<V2EventHandler>>();
  const unsubscribeSpies: Array<ReturnType<typeof vi.fn>> = [];
  let claim: SlotClaim | undefined;

  const dataOn = vi.fn((type: string, handler: V2EventHandler) => {
    const current = handlers.get(type) ?? new Set<V2EventHandler>();
    current.add(handler);
    handlers.set(type, current);
    const unsubscribe = vi.fn(() => current.delete(handler));
    unsubscribeSpies.push(unsubscribe);
    return unsubscribe;
  });

  const slot = vi.fn((value: SlotClaim) => {
    claim = value;
    return vi.fn();
  });

  const averagesStore: Record<string, SessionAverages> = {};
  const memory = vi.fn((_key: string, options: { initial: object }) => {
    Object.assign(averagesStore, options.initial);
    return [
      averagesStore,
      (mutation: (draft: Record<string, SessionAverages>) => void) => {
        mutation(averagesStore);
      },
    ] as const;
  });

  const theme = { text: { base: "white", muted: "gray" } };
  const context = {
    data: { on: dataOn },
    storage: { memory },
    ui: { slot },
    theme,
  };

  return {
    context,
    dataOn,
    slot,
    unsubscribeSpies,
    averagesStore,
    claim: () => claim,
    emit(type: string, data: any, created = 0) {
      for (const handler of [...(handlers.get(type) ?? [])]) {
        handler({ type, created, data });
      }
    },
    render(sessionID = "sess-A"): TestElement {
      expect(claim).toBeDefined();
      stubJsxRuntime();
      const tree = claim!.render({ sessionID }) as TestElement;
      expect(tree.type).toBe("box");
      expect(tree.props.flexDirection).toBe("column");
      return tree;
    },
    children(sessionID = "sess-A"): TestElement[] {
      const tree = this.render(sessionID);
      const children = tree.children as TestElement[];
      expect(children).toHaveLength(3);
      expect(children[0].props?.fg).toBe(theme.text.base);
      expect(children[1].props?.fg).toBe(theme.text.muted);
      expect(children[2].props?.fg).toBe(theme.text.muted);
      return children;
    },
    lines(sessionID = "sess-A"): string[] {
      return this.children(sessionID).map(textContent);
    },
  };
}

function emitCompletedStep(
  harness: ReturnType<typeof createV2Harness>,
  sessionID = "sess-A",
  options: { withStreamed?: boolean; withTools?: boolean; output?: number } = {},
) {
  const { withStreamed = true, withTools = true, output = 96 } = options;
  harness.emit(
    "session.step.started",
    { sessionID, assistantMessageID: `message-${sessionID}`, started: 1_000 },
    1_000,
  );
  harness.emit(
    "session.text.started",
    { sessionID, assistantMessageID: `message-${sessionID}`, ordinal: 0 },
    1_340,
  );
  harness.emit(
    "session.text.delta",
    { sessionID, assistantMessageID: `message-${sessionID}`, ordinal: 0, delta: "x" },
    1_350,
  );
  if (withTools) {
    harness.emit(
      "session.tool.called",
      { sessionID, assistantMessageID: `message-${sessionID}`, id: "call-1", input: {} },
      1_400,
    );
    harness.emit(
      "session.tool.success",
      {
        sessionID,
        assistantMessageID: `message-${sessionID}`,
        id: "call-1",
        content: [{ type: "text", text: "ok" }],
      },
      2_200,
    );
  }
  if (withStreamed) {
    harness.emit(
      "session.step.streamed",
      { sessionID, assistantMessageID: `message-${sessionID}` },
      2_300,
    );
  }
  harness.emit(
    "session.step.ended",
    {
      sessionID,
      assistantMessageID: `message-${sessionID}`,
      finish: "stop",
      cost: 0,
      tokens: { input: 100, output, reasoning: 0, cache: { read: 25, write: 0 } },
    },
    2_500,
  );
}

async function configuredPlugin(config: Record<string, unknown>) {
  vi.resetModules();
  vi.stubGlobal("Bun", {
    env: { HOME: "/test-home" },
    file: (path: string) => {
      if (path === "/test-home/.config/opencode/speed-measure.json") {
        return { text: async () => JSON.stringify(config) };
      }
      return {
        text: () =>
          Promise.reject(new Error(`ENOENT: config file not found at expected path: ${path}`)),
      };
    },
  });
  const mod = await import("../src/index.js");
  return mod.default;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("plugin.setup - OpenCode v2 entry", () => {
  it("satisfies the v2 loader contract ({ id, setup })", () => {
    expect(typeof plugin.id).toBe("string");
    expect(plugin.id.length).toBeGreaterThan(0);
    expect(typeof plugin.setup).toBe("function");
  });

  it("registers one sidebar.content claim and no legacy slot registration", async () => {
    const harness = createV2Harness();
    await plugin.setup(harness.context as any);

    expect(harness.slot).toHaveBeenCalledTimes(1);
    const claim = harness.claim();
    expect(claim!.append).toBe("sidebar.content");
    expect(typeof claim!.render).toBe("function");
  });

  it("computes TTFT from the request dispatch time and decode from the streamed boundary", async () => {
    const harness = createV2Harness();
    await plugin.setup(harness.context as any);

    expect(harness.lines()).toEqual(["Speed", "Prefill: --", "Decode:  --"]);

    emitCompletedStep(harness);

    // TTFT: 1340 - 1000 (the `started` dispatch time) = 340 ms;
    // prefill: 100 tokens / 0.34 s = 294.1 tok/s.
    // Decode: 96 tokens / ((2300 - 1340) / 1000) = 100 tok/s — the tool
    // interval (1400..2200) lies outside the streamed window.
    expect(harness.lines()).toEqual([
      "Speed",
      "Prefill: 340 ms │ 294.1 tok/s",
      "Decode:  100 tok/s",
    ]);
  });

  it("falls back to step.ended minus tool intervals when no streamed boundary arrives", async () => {
    const harness = createV2Harness();
    await plugin.setup(harness.context as any);

    emitCompletedStep(harness, "sess-A", { withStreamed: false });

    // (2500 - 1340 - 800) ms → 96 / 0.36 = 266.7 tok/s
    expect(harness.lines()).toEqual([
      "Speed",
      "Prefill: 340 ms │ 294.1 tok/s",
      "Decode:  266.7 tok/s",
    ]);
  });

  it("takes t1 from reasoning.started and does not overwrite it with a later text.started", async () => {
    const harness = createV2Harness();
    await plugin.setup(harness.context as any);

    harness.emit(
      "session.step.started",
      { sessionID: "sess-A", assistantMessageID: "msg-A1", started: 1_000 },
      1_000,
    );
    harness.emit(
      "session.reasoning.started",
      { sessionID: "sess-A", assistantMessageID: "msg-A1", ordinal: 0 },
      1_200,
    );
    harness.emit(
      "session.reasoning.delta",
      { sessionID: "sess-A", assistantMessageID: "msg-A1", ordinal: 0, delta: "hmm" },
      1_250,
    );
    harness.emit(
      "session.text.started",
      { sessionID: "sess-A", assistantMessageID: "msg-A1", ordinal: 0 },
      1_600,
    );
    harness.emit(
      "session.step.streamed",
      { sessionID: "sess-A", assistantMessageID: "msg-A1" },
      2_200,
    );
    harness.emit(
      "session.step.ended",
      {
        sessionID: "sess-A",
        assistantMessageID: "msg-A1",
        finish: "stop",
        cost: 0,
        tokens: { input: 100, output: 30, reasoning: 70, cache: { read: 0, write: 0 } },
      },
      2_400,
    );

    // TTFT = 1200 - 1000 = 200 ms; prefill = 100 / 0.2 = 500 tok/s;
    // decode = (30 + 70) / ((2200 - 1200) / 1000) = 100 tok/s.
    expect(harness.lines()).toEqual([
      "Speed",
      "Prefill: 200 ms │ 500 tok/s",
      "Decode:  100 tok/s",
    ]);
  });

  it("freezes the live estimate after the streamed boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    const harness = createV2Harness();
    await plugin.setup(harness.context as any);

    harness.emit(
      "session.step.started",
      { sessionID: "sess-A", assistantMessageID: "msg-A1", started: 1_000 },
      1_000,
    );
    harness.emit(
      "session.text.started",
      { sessionID: "sess-A", assistantMessageID: "msg-A1", ordinal: 0 },
      1_340,
    );
    harness.emit(
      "session.text.delta",
      {
        sessionID: "sess-A",
        assistantMessageID: "msg-A1",
        ordinal: 0,
        delta: "a".repeat(150),
      },
      1_350,
    );
    await vi.advanceTimersByTimeAsync(150);
    expect(harness.lines()).toEqual([
      "Speed",
      "Prefill: 340 ms",
      "Decode:  ~185.2 chars/s",
    ]);

    harness.emit(
      "session.tool.called",
      { sessionID: "sess-A", assistantMessageID: "msg-A1", id: "call-1", input: {} },
      2_100,
    );
    harness.emit(
      "session.tool.success",
      {
        sessionID: "sess-A",
        assistantMessageID: "msg-A1",
        id: "call-1",
        content: [{ type: "text", text: "ok" }],
      },
      2_300,
    );
    harness.emit(
      "session.step.streamed",
      { sessionID: "sess-A", assistantMessageID: "msg-A1" },
      2_400,
    );
    vi.setSystemTime(9_000);
    await vi.advanceTimersByTimeAsync(150);

    // No deltas can arrive after the streamed boundary, so the last live
    // value holds instead of decaying across the tool settlement gap.
    expect(harness.lines()).toEqual([
      "Speed",
      "Prefill: 340 ms",
      "Decode:  ~185.2 chars/s",
    ]);
  });

  it("does not leak subagent sessions into the parent sidebar", async () => {
    const harness = createV2Harness();
    await plugin.setup(harness.context as any);

    emitCompletedStep(harness, "sess-B");
    expect(harness.lines("sess-B")).toEqual([
      "Speed",
      "Prefill: 340 ms │ 294.1 tok/s",
      "Decode:  100 tok/s",
    ]);
    expect(harness.lines("sess-A")).toEqual(["Speed", "Prefill: --", "Decode:  --"]);
  });

  it("marks error on session.execution.failed and returns to idle on session.status idle", async () => {
    const harness = createV2Harness();
    await plugin.setup(harness.context as any);

    harness.emit(
      "session.step.started",
      { sessionID: "sess-A", assistantMessageID: "msg-A1", started: 1_000 },
      1_000,
    );
    harness.emit("session.execution.failed", { sessionID: "sess-A", error: {} }, 1_100);
    expect(harness.lines()).toEqual(["Speed", "Prefill: error", "Decode:  error"]);

    harness.emit(
      "session.step.started",
      { sessionID: "sess-A", assistantMessageID: "msg-A2", started: 2_000 },
      2_000,
    );
    expect(harness.lines()).toEqual(["Speed", "Prefill: …", "Decode:  --"]);

    harness.emit(
      "session.status",
      { sessionID: "sess-A", status: { type: "idle" } },
      2_100,
    );
    expect(harness.lines()).toEqual(["Speed", "Prefill: --", "Decode:  --"]);
  });

  it("persists session averages through the storage memory store", async () => {
    const configured = await configuredPlugin({ showAverages: true });
    const harness = createV2Harness();
    await configured.setup(harness.context as any);

    emitCompletedStep(harness, "sess-A", { withTools: false, output: 60 });

    // decode = 60 / ((2300 - 1340) / 1000) = 62.5 tok/s
    expect(harness.averagesStore["sess-A"]).toEqual({
      ttft: 340,
      prefillTokPerSec: 100 / 0.34,
      decodeTokPerSec: 62.5,
    });
    expect(harness.lines()).toEqual([
      "Speed",
      "Prefill: 340 ms (avg 340 ms)",
      "Decode:  62.5 (avg 62.5) tok/s",
    ]);
  });

  it("unsubscribes every listener and stops updating on cleanup", async () => {
    const harness = createV2Harness();
    const cleanup = await plugin.setup(harness.context as any);
    expect(typeof cleanup).toBe("function");

    cleanup();
    harness.unsubscribeSpies.forEach((spy) => expect(spy).toHaveBeenCalled());

    emitCompletedStep(harness);
    expect(harness.lines()).toEqual(["Speed", "Prefill: --", "Decode:  --"]);
  });
});
