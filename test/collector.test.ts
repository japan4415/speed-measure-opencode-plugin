import { describe, expect, it } from "vitest";

import {
  SpeedCollector,
  type CollectorState,
  type ReasoningDeltaProps,
  type ReasoningStartedProps,
  type StepEndedProps,
  type StepFailedProps,
  type StepStartedProps,
  type TextDeltaProps,
  type TextStartedProps,
} from "../src/collector.js";
import reasoningFixture from "./fixtures/reasoning.json";
import simpleTextFixture from "./fixtures/simple-text.json";
import toolCallFixture from "./fixtures/tool-call.json";

const ev = {
  stepStarted: (
    sessionID: string,
    timestamp: number,
    assistantMessageID = "msg1"
  ): StepStartedProps => ({
    sessionID,
    assistantMessageID,
    timestamp,
    agent: "default",
    model: { id: "deepseek-v4.1-flash" },
  }),
  reasoningStarted: (
    timestamp: number,
    sessionID = "s1"
  ): ReasoningStartedProps => ({
    sessionID,
    assistantMessageID: "msg1",
    timestamp,
    reasoningID: "r1",
  }),
  reasoningDelta: (
    delta: string,
    sessionID = "s1"
  ): ReasoningDeltaProps => ({
    sessionID,
    assistantMessageID: "msg1",
    reasoningID: "r1",
    delta,
  }),
  textStarted: (timestamp: number, sessionID = "s1"): TextStartedProps => ({
    sessionID,
    assistantMessageID: "msg1",
    timestamp,
    textID: "t1",
  }),
  textDelta: (delta: string, sessionID = "s1"): TextDeltaProps => ({
    sessionID,
    assistantMessageID: "msg1",
    textID: "t1",
    delta,
  }),
  stepEnded: (
    timestamp: number,
    output: number,
    reasoning = 0,
    input = 100,
    sessionID = "s1"
  ): StepEndedProps => ({
    sessionID,
    assistantMessageID: "msg1",
    timestamp,
    finish: "stop",
    cost: 0,
    tokens: {
      input,
      output,
      reasoning,
      cache: { read: 0, write: 0 },
    },
  }),
  stepFailed: (sessionID = "s1"): StepFailedProps => ({
    sessionID,
    assistantMessageID: "msg1",
    timestamp: 1500,
    error: { name: "UnknownError", data: { message: "failed" } },
  }),
};

type FixtureEvent =
  | { type: "step.started"; properties: StepStartedProps }
  | { type: "reasoning.started"; properties: ReasoningStartedProps }
  | { type: "reasoning.delta"; properties: ReasoningDeltaProps }
  | { type: "text.started"; properties: TextStartedProps }
  | { type: "text.delta"; properties: TextDeltaProps }
  | { type: "step.ended"; properties: StepEndedProps };

function replayFixture(events: FixtureEvent[]): CollectorState {
  const collector = new SpeedCollector();
  let state: CollectorState = new Map();

  for (const event of events) {
    switch (event.type) {
      case "step.started":
        state = collector.onStepStarted(state, event.properties);
        break;
      case "reasoning.started":
        state = collector.onReasoningStarted(state, event.properties);
        break;
      case "reasoning.delta":
        state = collector.onReasoningDelta(state, event.properties);
        break;
      case "text.started":
        state = collector.onTextStarted(state, event.properties);
        break;
      case "text.delta":
        state = collector.onTextDelta(state, event.properties);
        break;
      case "step.ended":
        state = collector.onStepEnded(state, event.properties);
        break;
    }
  }

  return state;
}

function stateSnapshot(state: CollectorState): unknown {
  return structuredClone(Array.from(state.entries()));
}

function expectPureCall(
  state: CollectorState,
  invoke: (input: CollectorState) => CollectorState
): CollectorState {
  const before = stateSnapshot(state);
  const result = invoke(state);
  expect(stateSnapshot(state)).toEqual(before);
  return result;
}

describe("SpeedCollector", () => {
  it("calculates TTFT from text.started minus step.started", () => {
    const collector = new SpeedCollector();
    let state = collector.onStepStarted(new Map(), ev.stepStarted("s1", 1000));
    state = collector.onTextStarted(state, ev.textStarted(1340));

    expect(state.get("s1")?.current).toMatchObject({
      phase: "decoding",
      t1: 1340,
      ttft: 340,
    });
  });

  it("includes output and reasoning tokens in decode tok/s", () => {
    const collector = new SpeedCollector();
    let state = collector.onStepStarted(new Map(), ev.stepStarted("s1", 0));
    state = collector.onTextStarted(state, ev.textStarted(500));
    state = collector.onStepEnded(state, ev.stepEnded(2500, 80, 20));

    expect(state.get("s1")?.current).toMatchObject({ phase: "done" });
    const current = state.get("s1")?.current;
    expect(current?.phase === "done" && current.decodeTokPerSec).toBeCloseTo(50);
  });

  it("keeps reasoning.started as t1 when text.started arrives later", () => {
    const collector = new SpeedCollector();
    let state = collector.onStepStarted(new Map(), ev.stepStarted("s1", 1000));
    state = collector.onReasoningStarted(state, ev.reasoningStarted(1200));
    state = collector.onTextStarted(state, ev.textStarted(1500));

    expect(state.get("s1")?.current).toMatchObject({
      phase: "decoding",
      t1: 1200,
      ttft: 200,
    });
  });

  it("returns a step without generated text to idle", () => {
    const collector = new SpeedCollector();
    let state = collector.onStepStarted(new Map(), ev.stepStarted("s1", 1000));
    state = collector.onStepEnded(state, ev.stepEnded(1500, 0));

    expect(state.get("s1")?.current.phase).toBe("idle");
  });

  it("ignores events for a different session", () => {
    const collector = new SpeedCollector();
    let state = collector.onStepStarted(new Map(), ev.stepStarted("s1", 1000));
    state = collector.onTextStarted(state, ev.textStarted(1340, "s2"));

    expect(state.get("s1")?.current.phase).toBe("prefilling");
    expect(state.has("s2")).toBe(false);
  });

  it("preserves done after session.status idle", () => {
    const collector = new SpeedCollector();
    let state = collector.onStepStarted(new Map(), ev.stepStarted("s1", 0));
    state = collector.onTextStarted(state, ev.textStarted(500));
    state = collector.onStepEnded(state, ev.stepEnded(2500, 80, 20));
    state = collector.onIdle(state, "s1");

    expect(state.get("s1")?.current.phase).toBe("done");
  });

  it("moves an interrupted prefill or decode to idle", () => {
    const collector = new SpeedCollector();
    const prefilling = collector.onStepStarted(
      new Map(),
      ev.stepStarted("prefill", 1000)
    );
    expect(collector.onIdle(prefilling, "prefill").get("prefill")?.current.phase).toBe(
      "idle"
    );

    let decoding = collector.onStepStarted(new Map(), ev.stepStarted("decode", 1000));
    decoding = collector.onTextStarted(decoding, ev.textStarted(1200, "decode"));
    expect(collector.onIdle(decoding, "decode").get("decode")?.current.phase).toBe(
      "idle"
    );
  });

  it("moves step.failed to error", () => {
    const collector = new SpeedCollector();
    let state = collector.onStepStarted(new Map(), ev.stepStarted("s1", 1000));
    state = collector.onStepFailed(state, ev.stepFailed());

    expect(state.get("s1")?.current).toEqual({ phase: "error", sessionID: "s1" });
  });

  it("calculates prefill tok/s and returns null when input tokens are zero", () => {
    const collector = new SpeedCollector();
    let measured = collector.onStepStarted(new Map(), ev.stepStarted("s1", 1000));
    measured = collector.onTextStarted(measured, ev.textStarted(1500));
    measured = collector.onStepEnded(measured, ev.stepEnded(2500, 10, 0, 100));

    const measuredCurrent = measured.get("s1")?.current;
    expect(
      measuredCurrent?.phase === "done" && measuredCurrent.prefillTokPerSec
    ).toBeCloseTo(200);

    let zeroInput = collector.onStepStarted(new Map(), ev.stepStarted("s1", 1000));
    zeroInput = collector.onTextStarted(zeroInput, ev.textStarted(1500));
    zeroInput = collector.onStepEnded(zeroInput, ev.stepEnded(2500, 10, 0, 0));

    expect(zeroInput.get("s1")?.current).toMatchObject({
      phase: "done",
      prefillTokPerSec: null,
    });
  });

  it("applies an unscoped session.error only to in-flight sessions", () => {
    const collector = new SpeedCollector();
    let state: CollectorState = new Map();
    state = collector.onStepStarted(state, ev.stepStarted("prefill", 1000));
    state = collector.onStepStarted(state, ev.stepStarted("decode", 1000));
    state = collector.onTextStarted(state, ev.textStarted(1200, "decode"));
    state = collector.onStepStarted(state, ev.stepStarted("done", 1000));
    state = collector.onTextStarted(state, ev.textStarted(1200, "done"));
    state = collector.onStepEnded(state, ev.stepEnded(2200, 10, 0, 100, "done"));
    state = collector.onStepFailed(state, ev.stepFailed("already-error"));

    state = collector.onSessionError(state, undefined);

    expect(state.get("prefill")?.current.phase).toBe("error");
    expect(state.get("decode")?.current.phase).toBe("error");
    expect(state.get("done")?.current.phase).toBe("done");
    expect(state.get("already-error")?.current.phase).toBe("error");
  });

  it("updates liveEstimate only after more than 0.1 seconds", () => {
    const collector = new SpeedCollector();
    let state = collector.onStepStarted(new Map(), ev.stepStarted("s1", 1000));
    state = collector.onTextStarted(state, ev.textStarted(1200));
    state = collector.onTextDelta(state, ev.textDelta("1234567890"));

    const atBoundary = collector.tick(state, 1300);
    expect(atBoundary.get("s1")?.current).toMatchObject({ liveEstimate: null });

    const afterBoundary = collector.tick(state, 1400);
    const current = afterBoundary.get("s1")?.current;
    expect(current?.phase === "decoding" && current.liveEstimate).toBeCloseTo(50);
  });

  it("does not produce Infinity or NaN for zero or negative elapsed time", () => {
    const collector = new SpeedCollector();
    let zeroDecode = collector.onStepStarted(new Map(), ev.stepStarted("s1", 1000));
    zeroDecode = collector.onTextStarted(zeroDecode, ev.textStarted(1200));
    zeroDecode = collector.onStepEnded(zeroDecode, ev.stepEnded(1200, 10));
    const zeroCurrent = zeroDecode.get("s1")?.current;
    expect(zeroCurrent).toMatchObject({ phase: "done", decodeTokPerSec: 0 });
    expect(
      zeroCurrent?.phase === "done" && Number.isFinite(zeroCurrent.decodeTokPerSec)
    ).toBe(true);

    let negative = collector.onStepStarted(new Map(), ev.stepStarted("s1", 1200));
    negative = collector.onTextStarted(negative, ev.textStarted(1100));
    negative = collector.onTextDelta(negative, ev.textDelta("characters"));
    const negativeTick = collector.tick(negative, 1000);
    expect(negativeTick.get("s1")?.current).toMatchObject({ liveEstimate: null });
    negative = collector.onStepEnded(negative, ev.stepEnded(1000, 10));
    const negativeCurrent = negative.get("s1")?.current;
    expect(negativeCurrent).toMatchObject({
      phase: "done",
      prefillTokPerSec: null,
      decodeTokPerSec: 0,
    });
  });

  it("does not mutate the CollectorState passed to state-changing methods", () => {
    const collector = new SpeedCollector();
    let state: CollectorState = new Map();
    state = expectPureCall(state, (input) =>
      collector.onStepStarted(input, ev.stepStarted("s1", 1000))
    );
    state = expectPureCall(state, (input) =>
      collector.onReasoningStarted(input, ev.reasoningStarted(1200))
    );
    state = expectPureCall(state, (input) =>
      collector.onReasoningDelta(input, ev.reasoningDelta("think"))
    );
    state = expectPureCall(state, (input) =>
      collector.onTextDelta(input, ev.textDelta("answer"))
    );
    expectPureCall(state, (input) => collector.tick(input, 1500));
    const done = expectPureCall(state, (input) =>
      collector.onStepEnded(input, ev.stepEnded(2200, 10, 2))
    );
    expectPureCall(done, (input) => collector.onStepStarted(input, ev.stepStarted("s1", 3000)));
    expectPureCall(state, (input) => collector.onIdle(input, "s1"));
    expectPureCall(state, (input) => collector.onSessionError(input));
    expectPureCall(state, (input) => collector.onStepFailed(input, ev.stepFailed()));

    let textState = collector.onStepStarted(new Map(), ev.stepStarted("text", 1000));
    textState = expectPureCall(textState, (input) =>
      collector.onTextStarted(input, ev.textStarted(1200, "text"))
    );
    expectPureCall(textState, (input) =>
      collector.onTextDelta(input, ev.textDelta("delta", "text"))
    );
  });

  it("replays the simple-text fixture", () => {
    const state = replayFixture(simpleTextFixture as FixtureEvent[]);
    expect(state.get("simple-session")?.current).toMatchObject({
      phase: "done",
      ttft: 340,
      decodeTokPerSec: 40,
    });
    const current = state.get("simple-session")?.current;
    expect(current?.phase === "done" && current.prefillTokPerSec).toBeCloseTo(200);
  });

  it("replays a multi-step tool-call fixture", () => {
    const state = replayFixture(toolCallFixture as FixtureEvent[]);
    expect(state.get("tool-session")?.current).toMatchObject({
      phase: "done",
      ttft: 250,
      prefillTokPerSec: 600,
      decodeTokPerSec: 50,
    });
    expect(state.get("tool-session")?.stepHistory).toHaveLength(1);
  });

  it("replays a reasoning-first fixture", () => {
    const state = replayFixture(reasoningFixture as FixtureEvent[]);
    expect(state.get("reasoning-session")?.current).toMatchObject({
      phase: "done",
      ttft: 200,
      prefillTokPerSec: 500,
      decodeTokPerSec: 50,
    });
  });
});
