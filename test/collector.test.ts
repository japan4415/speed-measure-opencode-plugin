import { describe, expect, it } from "vitest";
import type { Event } from "@opencode-ai/sdk/v2";

import {
  SpeedCollector,
  type CollectorState,
  type ReasoningDeltaProps,
  type ReasoningStartedProps,
  type StepEndedProps,
  type TextDeltaProps,
  type TextStartedProps,
} from "../src/collector.js";
import reasoningFixture from "./fixtures/reasoning.json";
import simpleTextFixture from "./fixtures/simple-text.json";
import toolCallFixture from "./fixtures/tool-call.json";

type EventProperties<T extends Event["type"]> = Extract<
  Event,
  { type: T }
>["properties"];

const ev = {
  stepStarted: (
    sessionID: string,
    timestamp: number,
    assistantMessageID = "msg1"
  ): EventProperties<"session.next.step.started"> => ({
    sessionID,
    assistantMessageID,
    timestamp,
    agent: "default",
    model: { id: "deepseek-v4.1-flash", providerID: "vllm" },
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
  stepFailed: (
    sessionID = "s1"
  ): EventProperties<"session.next.step.failed"> => ({
    sessionID,
    assistantMessageID: "msg1",
    timestamp: 1500,
    error: { type: "unknown", message: "failed" },
  }),
};

const fixtureEventTypes = [
  "session.next.step.started",
  "session.next.reasoning.started",
  "session.next.reasoning.delta",
  "session.next.text.started",
  "session.next.text.delta",
  "session.next.step.ended",
] as const;

type FixtureEventType = (typeof fixtureEventTypes)[number];
type FixtureEvent = Extract<Event, { type: FixtureEventType }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertString(
  value: unknown,
  path: string
): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`${path} must be a string`);
  }
}

function assertNumber(
  value: unknown,
  path: string
): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
}

function isFixtureEventType(value: unknown): value is FixtureEventType {
  return (
    typeof value === "string" &&
    fixtureEventTypes.some((type) => type === value)
  );
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  path: string
): void {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      throw new Error(`${path}.${key} is not defined by the SDK event type`);
    }
  }
}

function assertOptionalString(
  value: Record<string, unknown>,
  key: string,
  path: string
): void {
  if (key in value) {
    assertString(value[key], `${path}.${key}`);
  }
}

function assertStringArray(
  value: unknown,
  path: string
): asserts value is string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array`);
  }
  value.forEach((item, index) => assertString(item, `${path}[${index}]`));
}

function assertFixtureEvent(
  value: unknown,
  fixtureName: string,
  index: number
): asserts value is FixtureEvent {
  const eventPath = `${fixtureName}[${index}]`;
  if (!isRecord(value)) {
    throw new Error(`${eventPath} must be an object`);
  }

  assertExactKeys(value, ["id", "type", "properties"], eventPath);
  assertString(value.id, `${eventPath}.id`);
  if (!isFixtureEventType(value.type)) {
    throw new Error(`${eventPath}.type is not a supported SDK event type`);
  }
  if (!isRecord(value.properties)) {
    throw new Error(`${eventPath}.properties must be an object`);
  }

  const properties = value.properties;
  assertNumber(properties.timestamp, `${eventPath}.properties.timestamp`);
  assertString(properties.sessionID, `${eventPath}.properties.sessionID`);
  assertString(
    properties.assistantMessageID,
    `${eventPath}.properties.assistantMessageID`
  );

  switch (value.type) {
    case "session.next.step.started": {
      assertExactKeys(
        properties,
        [
          "timestamp",
          "sessionID",
          "assistantMessageID",
          "agent",
          "model",
          "snapshot",
        ],
        `${eventPath}.properties`
      );
      assertString(properties.agent, `${eventPath}.properties.agent`);
      if (!isRecord(properties.model)) {
        throw new Error(`${eventPath}.properties.model must be an object`);
      }
      assertExactKeys(
        properties.model,
        ["id", "providerID", "variant"],
        `${eventPath}.properties.model`
      );
      assertString(properties.model.id, `${eventPath}.properties.model.id`);
      assertString(
        properties.model.providerID,
        `${eventPath}.properties.model.providerID`
      );
      assertOptionalString(
        properties.model,
        "variant",
        `${eventPath}.properties.model`
      );
      assertOptionalString(properties, "snapshot", `${eventPath}.properties`);
      break;
    }
    case "session.next.step.ended": {
      assertExactKeys(
        properties,
        [
          "timestamp",
          "sessionID",
          "assistantMessageID",
          "finish",
          "cost",
          "tokens",
          "snapshot",
          "files",
        ],
        `${eventPath}.properties`
      );
      assertString(properties.finish, `${eventPath}.properties.finish`);
      assertNumber(properties.cost, `${eventPath}.properties.cost`);
      if (!isRecord(properties.tokens)) {
        throw new Error(`${eventPath}.properties.tokens must be an object`);
      }
      const tokens = properties.tokens;
      assertExactKeys(
        tokens,
        ["input", "output", "reasoning", "cache"],
        `${eventPath}.properties.tokens`
      );
      assertNumber(tokens.input, `${eventPath}.properties.tokens.input`);
      assertNumber(tokens.output, `${eventPath}.properties.tokens.output`);
      assertNumber(tokens.reasoning, `${eventPath}.properties.tokens.reasoning`);
      if (!isRecord(tokens.cache)) {
        throw new Error(`${eventPath}.properties.tokens.cache must be an object`);
      }
      assertExactKeys(
        tokens.cache,
        ["read", "write"],
        `${eventPath}.properties.tokens.cache`
      );
      assertNumber(tokens.cache.read, `${eventPath}.properties.tokens.cache.read`);
      assertNumber(tokens.cache.write, `${eventPath}.properties.tokens.cache.write`);
      assertOptionalString(properties, "snapshot", `${eventPath}.properties`);
      if ("files" in properties) {
        assertStringArray(properties.files, `${eventPath}.properties.files`);
      }
      break;
    }
    case "session.next.reasoning.started": {
      assertExactKeys(
        properties,
        [
          "timestamp",
          "sessionID",
          "assistantMessageID",
          "reasoningID",
          "providerMetadata",
        ],
        `${eventPath}.properties`
      );
      assertString(
        properties.reasoningID,
        `${eventPath}.properties.reasoningID`
      );
      if ("providerMetadata" in properties) {
        if (!isRecord(properties.providerMetadata)) {
          throw new Error(
            `${eventPath}.properties.providerMetadata must be an object`
          );
        }
        for (const [provider, metadata] of Object.entries(
          properties.providerMetadata
        )) {
          if (!isRecord(metadata)) {
            throw new Error(
              `${eventPath}.properties.providerMetadata.${provider} must be an object`
            );
          }
        }
      }
      break;
    }
    case "session.next.reasoning.delta":
      assertExactKeys(
        properties,
        [
          "timestamp",
          "sessionID",
          "assistantMessageID",
          "reasoningID",
          "delta",
        ],
        `${eventPath}.properties`
      );
      assertString(
        properties.reasoningID,
        `${eventPath}.properties.reasoningID`
      );
      assertString(properties.delta, `${eventPath}.properties.delta`);
      break;
    case "session.next.text.started":
      assertExactKeys(
        properties,
        ["timestamp", "sessionID", "assistantMessageID", "textID"],
        `${eventPath}.properties`
      );
      assertString(properties.textID, `${eventPath}.properties.textID`);
      break;
    case "session.next.text.delta":
      assertExactKeys(
        properties,
        ["timestamp", "sessionID", "assistantMessageID", "textID", "delta"],
        `${eventPath}.properties`
      );
      assertString(properties.textID, `${eventPath}.properties.textID`);
      assertString(properties.delta, `${eventPath}.properties.delta`);
      break;
  }
}

function validateFixture(value: unknown, fixtureName: string): FixtureEvent[] {
  if (!Array.isArray(value)) {
    throw new Error(`${fixtureName} must be an array`);
  }

  const events: FixtureEvent[] = [];
  value.forEach((event, index) => {
    assertFixtureEvent(event, fixtureName, index);
    events.push(event);
  });
  return events;
}

function replayFixture(events: FixtureEvent[]): CollectorState {
  const collector = new SpeedCollector();
  let state: CollectorState = new Map();

  for (const event of events) {
    switch (event.type) {
      case "session.next.step.started":
        state = collector.onStepStarted(state, event.properties);
        break;
      case "session.next.reasoning.started":
        state = collector.onReasoningStarted(state, event.properties);
        break;
      case "session.next.reasoning.delta":
        state = collector.onReasoningDelta(state, event.properties);
        break;
      case "session.next.text.started":
        state = collector.onTextStarted(state, event.properties);
        break;
      case "session.next.text.delta":
        state = collector.onTextDelta(state, event.properties);
        break;
      case "session.next.step.ended":
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

  it("preserves error after session.status idle", () => {
    const collector = new SpeedCollector();
    let state = collector.onStepFailed(new Map(), ev.stepFailed());
    state = collector.onIdle(state, "s1");

    expect(state.get("s1")?.current.phase).toBe("error");
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

    expect(state.get("s1")?.current).toMatchObject({
      phase: "error",
      sessionID: "s1",
    });
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

  it("applies a scoped session.error only to the specified session", () => {
    const collector = new SpeedCollector();
    let state: CollectorState = new Map();
    state = collector.onStepStarted(state, ev.stepStarted("target", 1000));
    state = collector.onStepStarted(state, ev.stepStarted("other", 1000));

    state = collector.onSessionError(state, "target");

    expect(state.get("target")?.current.phase).toBe("error");
    expect(state.get("other")?.current.phase).toBe("prefilling");
  });

  it.each([
    ["step.failed", (collector: SpeedCollector, state: CollectorState) =>
      collector.onStepFailed(state, ev.stepFailed())],
    ["session.error", (collector: SpeedCollector, state: CollectorState) =>
      collector.onSessionError(state, "s1")],
  ])("starts prefilling after %s", (_source, makeError) => {
    const collector = new SpeedCollector();
    let state = makeError(collector, new Map());
    state = collector.onStepStarted(state, ev.stepStarted("s1", 2000, "msg2"));

    expect(state.get("s1")?.current).toMatchObject({
      phase: "prefilling",
      assistantMessageID: "msg2",
      t0: 2000,
    });
  });

  it("keeps reasoning and completion events isolated by sessionID", () => {
    const collector = new SpeedCollector();
    const prefilling = collector.onStepStarted(
      new Map(),
      ev.stepStarted("s1", 1000)
    );

    expect(
      collector.onReasoningStarted(prefilling, ev.reasoningStarted(1200, "s2"))
    ).toBe(prefilling);

    const decoding = collector.onReasoningStarted(
      prefilling,
      ev.reasoningStarted(1200)
    );
    expect(
      collector.onReasoningDelta(decoding, ev.reasoningDelta("other", "s2"))
    ).toBe(decoding);
    expect(collector.onTextDelta(decoding, ev.textDelta("other", "s2"))).toBe(
      decoding
    );
    expect(collector.onStepEnded(decoding, ev.stepEnded(2200, 10, 0, 100, "s2"))).toBe(
      decoding
    );
    expect(decoding.has("s2")).toBe(false);

    const completed = collector.onStepEnded(
      decoding,
      ev.stepEnded(2200, 10, 0, 100, "s1")
    );
    const failedOther = collector.onStepFailed(completed, ev.stepFailed("s2"));
    expect(failedOther.get("s1")).toEqual(completed.get("s1"));
    expect(failedOther.get("s2")).toEqual({
      current: { phase: "error", sessionID: "s2" },
      stepHistory: [],
    });
  });

  it("keeps stepHistory for the same assistant message and resets it for a new one", () => {
    const collector = new SpeedCollector();
    let state = collector.onStepStarted(new Map(), ev.stepStarted("s1", 1000, "msg1"));
    state = collector.onTextStarted(state, ev.textStarted(1200));
    state = collector.onStepEnded(state, ev.stepEnded(2200, 10));
    expect(state.get("s1")?.stepHistory).toHaveLength(1);

    state = collector.onStepStarted(state, ev.stepStarted("s1", 3000, "msg1"));
    expect(state.get("s1")?.stepHistory).toHaveLength(1);
    state = collector.onTextStarted(state, ev.textStarted(3200));
    state = collector.onStepEnded(state, ev.stepEnded(4200, 10));
    expect(state.get("s1")?.stepHistory).toHaveLength(2);

    state = collector.onStepStarted(state, ev.stepStarted("s1", 5000, "msg2"));
    expect(state.get("s1")?.stepHistory).toHaveLength(0);
  });

  it("uses stepHistory message identity after a prefilling step returns to idle", () => {
    const collector = new SpeedCollector();
    let state = collector.onStepStarted(new Map(), ev.stepStarted("s1", 1000, "msg1"));
    state = collector.onTextStarted(state, ev.textStarted(1200));
    state = collector.onStepEnded(state, ev.stepEnded(2200, 10));

    state = collector.onStepStarted(state, ev.stepStarted("s1", 3000, "msg1"));
    state = collector.onStepEnded(state, ev.stepEnded(3200, 0));
    expect(state.get("s1")?.current.phase).toBe("idle");
    expect(state.get("s1")?.stepHistory).toHaveLength(1);

    const sameMessage = collector.onStepStarted(
      state,
      ev.stepStarted("s1", 4000, "msg1")
    );
    expect(sameMessage.get("s1")?.stepHistory).toHaveLength(1);

    const newMessage = collector.onStepStarted(
      state,
      ev.stepStarted("s1", 4000, "msg2")
    );
    expect(newMessage.get("s1")?.stepHistory).toHaveLength(0);
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

  it("includes reasoning.delta characters in the live estimate", () => {
    const collector = new SpeedCollector();
    let state = collector.onStepStarted(new Map(), ev.stepStarted("s1", 1000));
    state = collector.onReasoningStarted(state, ev.reasoningStarted(1200));
    state = collector.onReasoningDelta(state, ev.reasoningDelta("1234567890"));

    expect(state.get("s1")?.current).toMatchObject({ liveChars: 10 });
    const ticked = collector.tick(state, 1400);
    const current = ticked.get("s1")?.current;
    expect(current?.phase === "decoding" && current.liveEstimate).toBeCloseTo(50);
  });

  it.each(["reasoning", "text"] as const)(
    "keeps liveChars when a runtime %s delta is undefined",
    (kind) => {
      const collector = new SpeedCollector();
      let state = collector.onStepStarted(new Map(), ev.stepStarted("s1", 1000));
      state = collector.onReasoningStarted(state, ev.reasoningStarted(1200));

      expect(() => {
        state = kind === "reasoning"
          ? collector.onReasoningDelta(
              state,
              ev.reasoningDelta(undefined as unknown as string)
            )
          : collector.onTextDelta(
              state,
              ev.textDelta(undefined as unknown as string)
            );
      }).not.toThrow();
      expect(state.get("s1")?.current).toMatchObject({ liveChars: 0 });
    }
  );

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

  it("validates optional SDK fields when they are present", () => {
    const events = structuredClone(simpleTextFixture) as unknown[];
    const first = events[0] as { properties: Record<string, unknown> };
    first.properties.snapshot = 123;

    expect(() => validateFixture(events, "invalid-snapshot.json")).toThrow(
      "properties.snapshot must be a string"
    );
  });

  it("allows empty delta strings required by the SDK types", () => {
    const textEvents = structuredClone(simpleTextFixture) as unknown[];
    const textDelta = textEvents.find(
      (event) =>
        (event as { type?: unknown }).type === "session.next.text.delta"
    ) as { properties: Record<string, unknown> };
    textDelta.properties.delta = "";

    const reasoningEvents = structuredClone(reasoningFixture) as unknown[];
    const reasoningDelta = reasoningEvents.find(
      (event) =>
        (event as { type?: unknown }).type === "session.next.reasoning.delta"
    ) as { properties: Record<string, unknown> };
    reasoningDelta.properties.delta = "";

    expect(() => validateFixture(textEvents, "empty-text-delta.json")).not.toThrow();
    expect(() =>
      validateFixture(reasoningEvents, "empty-reasoning-delta.json")
    ).not.toThrow();
  });

  it("rejects fields that are absent from the SDK event type", () => {
    const events = structuredClone(simpleTextFixture) as unknown[];
    const first = events[0] as { properties: Record<string, unknown> };
    first.properties.bogusFieldNotInSdk = 123;

    expect(() => validateFixture(events, "unknown-field.json")).toThrow(
      "properties.bogusFieldNotInSdk is not defined by the SDK event type"
    );
  });

  it("replays the simple-text fixture", () => {
    const state = replayFixture(validateFixture(simpleTextFixture, "simple-text.json"));
    expect(state.get("simple-session")?.current).toMatchObject({
      phase: "done",
      ttft: 340,
      decodeTokPerSec: 40,
    });
    const current = state.get("simple-session")?.current;
    expect(current?.phase === "done" && current.prefillTokPerSec).toBeCloseTo(200);
  });

  it("replays a multi-step tool-call fixture", () => {
    const state = replayFixture(validateFixture(toolCallFixture, "tool-call.json"));
    expect(state.get("tool-session")?.current).toMatchObject({
      phase: "done",
      ttft: 250,
      prefillTokPerSec: 600,
      decodeTokPerSec: 50,
    });
    expect(state.get("tool-session")?.stepHistory).toHaveLength(1);
  });

  it("replays a reasoning-first fixture", () => {
    const state = replayFixture(validateFixture(reasoningFixture, "reasoning.json"));
    expect(state.get("reasoning-session")?.current).toMatchObject({
      phase: "done",
      ttft: 200,
      prefillTokPerSec: 500,
      decodeTokPerSec: 50,
    });
  });

  it.todo("tests v1 fallback after Issue #7 implements the plugin entry and 2s timeout");
});
