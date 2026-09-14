import { describe, expect, it, vi } from "vitest";
import type { Event } from "@opencode-ai/sdk/v2";

import {
  MAX_PREFILL_TOK_PER_SEC,
  SpeedCollector,
  type CollectorState,
  type DoneState,
  type StepState,
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
  ): EventProperties<"session.next.reasoning.started"> => ({
    sessionID,
    assistantMessageID: "msg1",
    timestamp,
    reasoningID: "r1",
  }),
  reasoningDelta: (
    delta: string,
    sessionID = "s1",
    timestamp = 1300
  ): EventProperties<"session.next.reasoning.delta"> => ({
    sessionID,
    assistantMessageID: "msg1",
    reasoningID: "r1",
    timestamp,
    delta,
  }),
  textStarted: (
    timestamp: number,
    sessionID = "s1"
  ): EventProperties<"session.next.text.started"> => ({
    sessionID,
    assistantMessageID: "msg1",
    timestamp,
    textID: "t1",
  }),
  textDelta: (
    delta: string,
    sessionID = "s1",
    timestamp = 1300
  ): EventProperties<"session.next.text.delta"> => ({
    sessionID,
    assistantMessageID: "msg1",
    textID: "t1",
    timestamp,
    delta,
  }),
  stepEnded: (
    timestamp: number,
    output: number,
    reasoning = 0,
    input = 100,
    sessionID = "s1"
  ): EventProperties<"session.next.step.ended"> => ({
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

type RegisteredPhase = StepState["phase"];
type MatrixPhase = RegisteredPhase | "unregistered";

const registeredPhases: RegisteredPhase[] = [
  "idle",
  "prefilling",
  "decoding",
  "done",
  "error",
];
const matrixPhases: MatrixPhase[] = ["unregistered", ...registeredPhases];

function stateAtPhase(
  phase: MatrixPhase,
  sessionID = "target"
): CollectorState {
  if (phase === "unregistered") return new Map();

  const historyEntry: DoneState & { assistantMessageID: string } = {
    phase: "done",
    sessionID,
    ttft: 111,
    prefillTokPerSec: 222,
    decodeTokPerSec: 333,
    assistantMessageID: "msg1",
  };

  const current: StepState = (() => {
    switch (phase) {
      case "idle":
        return { phase: "idle" };
      case "prefilling":
        return {
          phase: "prefilling",
          sessionID,
          assistantMessageID: "msg1",
          t0: 1000,
        };
      case "decoding":
        return {
          phase: "decoding",
          sessionID,
          assistantMessageID: "msg1",
          t0: 1000,
          t1: 1200,
          ttft: 200,
          liveChars: 5,
          liveEstimate: null,
        };
      case "done":
        return {
          phase: "done",
          sessionID,
          ttft: 200,
          prefillTokPerSec: 500,
          decodeTokPerSec: 10,
        };
      case "error":
        return { phase: "error", sessionID };
    }
  })();

  return new Map([[sessionID, { current, stepHistory: [historyEntry] }]]);
}

function stateWithTwoHistoryEntries(
  phase: RegisteredPhase,
  sessionID = "target"
): CollectorState {
  const state = stateAtPhase(phase, sessionID);
  const metrics = state.get(sessionID);
  if (!metrics) throw new Error("registered phase fixture must exist");

  const stepHistory: Array<DoneState & { assistantMessageID: string }> = [
    {
      phase: "done",
      sessionID,
      ttft: 101,
      prefillTokPerSec: 11,
      decodeTokPerSec: 21,
      assistantMessageID: "msg1",
    },
    {
      phase: "done",
      sessionID,
      ttft: 202,
      prefillTokPerSec: 12,
      decodeTokPerSec: 22,
      assistantMessageID: "msg1",
    },
  ];

  state.set(sessionID, { ...metrics, stepHistory });
  return state;
}

const coexistingSessionIDs = [
  "observer-done",
  "observer-decoding",
  "observer-prefilling",
  "observer-error",
] as const;

function stateAtPhaseWithCoexistingSessions(
  phase: MatrixPhase
): CollectorState {
  const state = stateWithTwoHistoryEntries("done", "observer-done");
  const target = stateAtPhase(phase).get("target");
  if (target) state.set("target", target);

  for (const observerPhase of ["decoding", "prefilling", "error"] as const) {
    const sessionID = `observer-${observerPhase}`;
    const observer = stateWithTwoHistoryEntries(observerPhase, sessionID).get(
      sessionID
    );
    if (!observer) throw new Error(`${observerPhase} observer must exist`);
    state.set(sessionID, observer);
  }

  return state;
}

function currentPhase(state: CollectorState, sessionID = "target"):
  | RegisteredPhase
  | "unregistered" {
  return state.get(sessionID)?.current.phase ?? "unregistered";
}

type HandlerMatrixCase = {
  name: string;
  expected: Record<MatrixPhase, MatrixPhase>;
  changesFrom: readonly MatrixPhase[];
  invoke: (collector: SpeedCollector, state: CollectorState) => CollectorState;
};

const preserveAll: Record<MatrixPhase, MatrixPhase> = {
  unregistered: "unregistered",
  idle: "idle",
  prefilling: "prefilling",
  decoding: "decoding",
  done: "done",
  error: "error",
};

const handlerPhaseMatrix: HandlerMatrixCase[] = [
  {
    name: "onStepStarted(same assistant message)",
    expected: Object.fromEntries(
      matrixPhases.map((phase) => [phase, "prefilling"])
    ) as Record<MatrixPhase, MatrixPhase>,
    changesFrom: matrixPhases,
    invoke: (collector, state) =>
      collector.onStepStarted(state, ev.stepStarted("target", 2000, "msg1")),
  },
  {
    name: "onStepStarted(new assistant message)",
    expected: Object.fromEntries(
      matrixPhases.map((phase) => [phase, "prefilling"])
    ) as Record<MatrixPhase, MatrixPhase>,
    changesFrom: matrixPhases,
    invoke: (collector, state) =>
      collector.onStepStarted(state, ev.stepStarted("target", 2000, "msg2")),
  },
  {
    name: "onReasoningStarted",
    expected: { ...preserveAll, prefilling: "decoding" },
    changesFrom: ["prefilling"],
    invoke: (collector, state) =>
      collector.onReasoningStarted(state, ev.reasoningStarted(1250, "target")),
  },
  {
    name: "onReasoningDelta",
    expected: preserveAll,
    changesFrom: ["decoding"],
    invoke: (collector, state) =>
      collector.onReasoningDelta(state, ev.reasoningDelta("abc", "target")),
  },
  {
    name: "onTextStarted",
    expected: { ...preserveAll, prefilling: "decoding" },
    changesFrom: ["prefilling"],
    invoke: (collector, state) =>
      collector.onTextStarted(state, ev.textStarted(1250, "target")),
  },
  {
    name: "onTextDelta",
    expected: preserveAll,
    changesFrom: ["decoding"],
    invoke: (collector, state) =>
      collector.onTextDelta(state, ev.textDelta("abcd", "target")),
  },
  {
    name: "onStepEnded",
    expected: { ...preserveAll, prefilling: "idle", decoding: "done" },
    changesFrom: ["prefilling", "decoding"],
    invoke: (collector, state) =>
      collector.onStepEnded(state, ev.stepEnded(2200, 10, 2, 100, "target")),
  },
  {
    name: "onStepFailed",
    expected: Object.fromEntries(
      matrixPhases.map((phase) => [phase, "error"])
    ) as Record<MatrixPhase, MatrixPhase>,
    changesFrom: matrixPhases,
    invoke: (collector, state) =>
      collector.onStepFailed(state, ev.stepFailed("target")),
  },
  {
    name: "onIdle",
    expected: {
      ...preserveAll,
      prefilling: "idle",
      decoding: "idle",
    },
    changesFrom: ["prefilling", "decoding"],
    invoke: (collector, state) => collector.onIdle(state, "target"),
  },
  {
    name: "onSessionError(scoped)",
    expected: Object.fromEntries(
      matrixPhases.map((phase) => [phase, "error"])
    ) as Record<MatrixPhase, MatrixPhase>,
    changesFrom: matrixPhases,
    invoke: (collector, state) => collector.onSessionError(state, "target"),
  },
  {
    name: "tick",
    expected: preserveAll,
    changesFrom: matrixPhases,
    invoke: (collector, state) => collector.tick(state, 1500),
  },
];

const handlerPhaseCases = handlerPhaseMatrix.flatMap((handler) =>
  matrixPhases.map((phase) => ({ handler, phase }))
);

function expectedMatrixState(
  handlerName: string,
  phase: MatrixPhase
): CollectorState {
  const initial = stateAtPhase(phase);
  const stepHistory = initial.get("target")?.stepHistory ?? [];
  const withCurrent = (current: StepState): CollectorState =>
    new Map([["target", { current, stepHistory }]]);

  if (handlerName.startsWith("onStepStarted")) {
    const assistantMessageID = handlerName.includes("new") ? "msg2" : "msg1";
    return new Map([
      [
        "target",
        {
          current: {
            phase: "prefilling",
            sessionID: "target",
            assistantMessageID,
            t0: 2000,
          },
          stepHistory: assistantMessageID === "msg1" ? stepHistory : [],
        },
      ],
    ]);
  }
  if (
    (handlerName === "onReasoningStarted" || handlerName === "onTextStarted") &&
    phase === "prefilling"
  ) {
    return withCurrent({
      phase: "decoding",
      sessionID: "target",
      assistantMessageID: "msg1",
      t0: 1000,
      t1: 1250,
      ttft: 250,
      liveChars: 0,
      liveEstimate: null,
    });
  }
  if (handlerName === "onReasoningDelta" && phase === "decoding") {
    return withCurrent({
      phase: "decoding",
      sessionID: "target",
      assistantMessageID: "msg1",
      t0: 1000,
      t1: 1200,
      ttft: 200,
      liveChars: 8,
      liveEstimate: null,
    });
  }
  if (handlerName === "onTextDelta" && phase === "decoding") {
    return withCurrent({
      phase: "decoding",
      sessionID: "target",
      assistantMessageID: "msg1",
      t0: 1000,
      t1: 1200,
      ttft: 200,
      liveChars: 9,
      liveEstimate: null,
    });
  }
  if (handlerName === "tick" && phase === "decoding") {
    return withCurrent({
      phase: "decoding",
      sessionID: "target",
      assistantMessageID: "msg1",
      t0: 1000,
      t1: 1200,
      ttft: 200,
      liveChars: 5,
      liveEstimate: 5 / ((1500 - 1200) / 1000),
    });
  }
  if (handlerName === "onStepEnded" && phase === "prefilling") {
    return withCurrent({ phase: "idle" });
  }
  if (handlerName === "onStepEnded" && phase === "decoding") {
    const completed: DoneState & { assistantMessageID: string } = {
      phase: "done",
      sessionID: "target",
      ttft: 200,
      prefillTokPerSec: 500,
      decodeTokPerSec: 12,
      assistantMessageID: "msg1",
    };
    return new Map([
      [
        "target",
        { current: completed, stepHistory: [...stepHistory, completed] },
      ],
    ]);
  }
  if (
    handlerName === "onStepFailed" ||
    handlerName === "onSessionError(scoped)"
  ) {
    return withCurrent({ phase: "error", sessionID: "target" });
  }
  if (
    handlerName === "onIdle" &&
    (phase === "prefilling" || phase === "decoding")
  ) {
    return withCurrent({ phase: "idle" });
  }
  return initial;
}

describe("SpeedCollector", () => {
  describe("handler × starting phase transition matrix", () => {
    it.each(handlerPhaseCases)(
      "$handler.name: $phase -> expected phase with coexisting sessions",
      ({ handler, phase }) => {
        const collector = new SpeedCollector();
        const initial = stateAtPhaseWithCoexistingSessions(phase);
        const initialSnapshot = stateSnapshot(initial);
        const keysBefore = [...initial.keys()];
        const observersBefore = new Map(
          coexistingSessionIDs.map((sessionID) => [
            sessionID,
            structuredClone(initial.get(sessionID)!),
          ])
        );
        const expectedTarget = expectedMatrixState(handler.name, phase).get(
          "target"
        );
        const result = handler.invoke(collector, initial);

        expect(currentPhase(result)).toBe(handler.expected[phase]);

        if (!handler.changesFrom.includes(phase)) {
          expect(result).toBe(initial);
        }
        const target = result.get("target");
        expect(target).toEqual(expectedTarget);
        expect(target?.current).toEqual(expectedTarget?.current);
        expect(target?.stepHistory).toEqual(expectedTarget?.stepHistory);
        if (expectedTarget) {
          expect(target?.stepHistory).toHaveLength(
            expectedTarget.stepHistory.length
          );
        }
        expect([...result.keys()]).toEqual(
          expectedTarget && !keysBefore.includes("target")
            ? [...keysBefore, "target"]
            : keysBefore
        );
        for (const [sessionID, before] of observersBefore) {
          const observer = result.get(sessionID);
          const expectedCurrent =
            handler.name === "tick" && before.current.phase === "decoding"
              ? {
                  ...before.current,
                  liveEstimate:
                    before.current.liveChars /
                    ((1500 - before.current.t1) / 1000),
                }
              : before.current;
          expect(observer, `${sessionID} must remain registered`).toBeDefined();
          expect(observer?.current).toEqual(expectedCurrent);
          expect(observer?.stepHistory).toHaveLength(before.stepHistory.length);
          expect(observer?.stepHistory).toEqual(before.stepHistory);
        }
        expect(stateSnapshot(initial)).toEqual(initialSnapshot);
      }
    );
  });

  describe("stepHistory preservation across SessionMetrics reconstruction", () => {
    const cases: Array<{
      name: string;
      phase: RegisteredPhase;
      appendedEntries?: number;
      invoke: (collector: SpeedCollector, state: CollectorState) => CollectorState;
    }> = [
      {
        name: "onStepStarted (same assistant message)",
        phase: "idle",
        invoke: (collector, state) =>
          collector.onStepStarted(state, ev.stepStarted("target", 2000, "msg1")),
      },
      {
        name: "onReasoningStarted",
        phase: "prefilling",
        invoke: (collector, state) =>
          collector.onReasoningStarted(state, ev.reasoningStarted(1250, "target")),
      },
      {
        name: "onReasoningDelta",
        phase: "decoding",
        invoke: (collector, state) =>
          collector.onReasoningDelta(state, ev.reasoningDelta("abc", "target")),
      },
      {
        name: "onTextStarted",
        phase: "prefilling",
        invoke: (collector, state) =>
          collector.onTextStarted(state, ev.textStarted(1250, "target")),
      },
      {
        name: "onTextDelta",
        phase: "decoding",
        invoke: (collector, state) =>
          collector.onTextDelta(state, ev.textDelta("abcd", "target")),
      },
      {
        name: "onStepEnded (prefilling)",
        phase: "prefilling",
        invoke: (collector, state) =>
          collector.onStepEnded(state, ev.stepEnded(2200, 10, 0, 100, "target")),
      },
      {
        name: "onStepEnded (decoding)",
        phase: "decoding",
        appendedEntries: 1,
        invoke: (collector, state) =>
          collector.onStepEnded(state, ev.stepEnded(2200, 10, 2, 100, "target")),
      },
      {
        name: "onStepFailed",
        phase: "prefilling",
        invoke: (collector, state) =>
          collector.onStepFailed(state, ev.stepFailed("target")),
      },
      {
        name: "onIdle (prefilling)",
        phase: "prefilling",
        invoke: (collector, state) => collector.onIdle(state, "target"),
      },
      {
        name: "onIdle (decoding)",
        phase: "decoding",
        invoke: (collector, state) => collector.onIdle(state, "target"),
      },
      {
        name: "onSessionError (scoped)",
        phase: "prefilling",
        invoke: (collector, state) => collector.onSessionError(state, "target"),
      },
      {
        name: "onSessionError (unscoped)",
        phase: "decoding",
        invoke: (collector, state) => collector.onSessionError(state),
      },
      {
        name: "tick",
        phase: "decoding",
        invoke: (collector, state) => collector.tick(state, 1500),
      },
    ];

    it.each(cases)("preserves every prior entry through $name", ({
      phase,
      appendedEntries = 0,
      invoke,
    }) => {
      const collector = new SpeedCollector();
      const initial = stateWithTwoHistoryEntries(phase);
      const historyBefore = structuredClone(
        initial.get("target")?.stepHistory ?? []
      );

      const result = invoke(collector, initial);
      const historyAfter = result.get("target")?.stepHistory;

      expect(historyAfter?.slice(0, historyBefore.length)).toEqual(historyBefore);
      expect(historyAfter).toHaveLength(historyBefore.length + appendedEntries);
    });
  });

  describe("duplicate event delivery", () => {
    const idempotentCases: Array<{
      name: string;
      initialPhase: MatrixPhase;
      invoke: (collector: SpeedCollector, state: CollectorState) => CollectorState;
    }> = [
      {
        name: "step.started",
        initialPhase: "done",
        invoke: (collector, state) =>
          collector.onStepStarted(state, ev.stepStarted("target", 2000)),
      },
      {
        name: "reasoning.started",
        initialPhase: "prefilling",
        invoke: (collector, state) =>
          collector.onReasoningStarted(
            state,
            ev.reasoningStarted(1250, "target")
          ),
      },
      {
        name: "text.started",
        initialPhase: "prefilling",
        invoke: (collector, state) =>
          collector.onTextStarted(state, ev.textStarted(1250, "target")),
      },
      {
        name: "step.ended",
        initialPhase: "decoding",
        invoke: (collector, state) =>
          collector.onStepEnded(
            state,
            ev.stepEnded(2200, 10, 2, 100, "target")
          ),
      },
      {
        name: "step.failed",
        initialPhase: "prefilling",
        invoke: (collector, state) =>
          collector.onStepFailed(state, ev.stepFailed("target")),
      },
      {
        name: "session.status idle",
        initialPhase: "decoding",
        invoke: (collector, state) => collector.onIdle(state, "target"),
      },
      {
        name: "session.error",
        initialPhase: "decoding",
        invoke: (collector, state) => collector.onSessionError(state, "target"),
      },
    ];

    it.each(idempotentCases)(
      "keeps the complete state stable after duplicate $name",
      ({ initialPhase, invoke }) => {
        const collector = new SpeedCollector();
        const first = invoke(collector, stateAtPhase(initialPhase));
        const afterFirst = stateSnapshot(first);

        const second = invoke(collector, first);

        expect(stateSnapshot(second)).toEqual(afterFirst);
      }
    );

    it.each([
      [
        "reasoning.delta",
        (collector: SpeedCollector, state: CollectorState) =>
          collector.onReasoningDelta(
            state,
            ev.reasoningDelta("abc", "target")
          ),
        11,
      ],
      [
        "text.delta",
        (collector: SpeedCollector, state: CollectorState) =>
          collector.onTextDelta(state, ev.textDelta("abcd", "target")),
        13,
      ],
    ] as const)(
      "counts each delivered %s exactly once without resetting measurements",
      (_name, invoke, expectedLiveChars) => {
        const collector = new SpeedCollector();
        const initial = stateAtPhase("decoding");
        const expectedHistory = initial.get("target")?.stepHistory;

        const first = invoke(collector, initial);
        const second = invoke(collector, first);

        expect(second.get("target")).toEqual({
          current: {
            phase: "decoding",
            sessionID: "target",
            assistantMessageID: "msg1",
            t0: 1000,
            t1: 1200,
            ttft: 200,
            liveChars: expectedLiveChars,
            liveEstimate: null,
          },
          stepHistory: expectedHistory,
        });
      }
    );
  });

  describe("delta string input classes", () => {
    const deltaCases = [
      ["ordinary text", "abc", 3],
      ["whitespace only", " \n\t", 3],
      ["empty", "", 0],
      ["embedded newline and tab", "a\n\tb", 4],
      ["multibyte BMP characters", "日本語", 3],
      ["surrogate-pair emoji", "😀", 2],
      ["joined emoji sequence", "👨‍👩‍👧‍👦", 11],
    ] as const;
    const handlers = [
      [
        "reasoning.delta",
        (collector: SpeedCollector, state: CollectorState, delta: string) =>
          collector.onReasoningDelta(
            state,
            ev.reasoningDelta(delta, "target")
          ),
      ],
      [
        "text.delta",
        (collector: SpeedCollector, state: CollectorState, delta: string) =>
          collector.onTextDelta(state, ev.textDelta(delta, "target")),
      ],
    ] as const;

    it.each(
      handlers.flatMap(([handler, invoke]) =>
        deltaCases.map(([inputClass, delta, expectedLength]) => ({
          handler,
          invoke,
          inputClass,
          delta,
          expectedLength,
        }))
      )
    )(
      "$handler counts $inputClass by JavaScript UTF-16 length",
      ({ invoke, delta, expectedLength }) => {
        const collector = new SpeedCollector();
        const initial = stateAtPhase("decoding");
        const expectedHistory = initial.get("target")?.stepHistory;

        const result = invoke(collector, initial, delta);

        expect(result.get("target")).toEqual({
          current: {
            phase: "decoding",
            sessionID: "target",
            assistantMessageID: "msg1",
            t0: 1000,
            t1: 1200,
            ttft: 200,
            liveChars: 5 + expectedLength,
            liveEstimate: null,
          },
          stepHistory: expectedHistory,
        });
      }
    );
  });

  it("tick updates every decoding session and preserves non-decoding sessions", () => {
    const collector = new SpeedCollector();
    const state = stateAtPhase("decoding", "decode-first");
    const second = stateAtPhase("decoding", "decode-second").get("decode-second");
    const prefilling = stateAtPhase("prefilling", "prefilling").get("prefilling");
    const done = stateAtPhase("done", "done").get("done");
    const error = stateAtPhase("error", "error").get("error");
    if (!second || !prefilling || !done || !error) {
      throw new Error("multi-session fixtures must exist");
    }
    if (second.current.phase !== "decoding") {
      throw new Error("second fixture must be decoding");
    }
    second.current = { ...second.current, liveChars: 10 };
    state.set("decode-second", second);
    state.set("prefilling", prefilling);
    state.set("done", done);
    state.set("error", error);
    const keysBefore = [...state.keys()];
    const historiesBefore = new Map(
      [...state].map(([sessionID, metrics]) => [
        sessionID,
        structuredClone(metrics.stepHistory),
      ])
    );
    const nonDecodingBefore = stateSnapshot(
      new Map([
        ["prefilling", prefilling],
        ["done", done],
        ["error", error],
      ])
    );

    const ticked = collector.tick(state, 1400);

    expect(ticked.get("decode-first")?.current).toMatchObject({
      phase: "decoding",
      liveEstimate: 25,
    });
    expect(ticked.get("decode-second")?.current).toMatchObject({
      phase: "decoding",
      liveEstimate: 50,
    });
    expect([...ticked.keys()]).toEqual(keysBefore);
    for (const [sessionID, historyBefore] of historiesBefore) {
      expect(ticked.get(sessionID)?.stepHistory).toHaveLength(
        historyBefore.length
      );
      expect(ticked.get(sessionID)?.stepHistory).toEqual(historyBefore);
    }
    expect(
      stateSnapshot(
        new Map(
          ["prefilling", "done", "error"].map((sessionID) => [
            sessionID,
            ticked.get(sessionID)!,
          ])
        )
      )
    ).toEqual(nonDecodingBefore);
  });

  it("tick continues past a completed session that is first in Map order", () => {
    const collector = new SpeedCollector();
    let state = collector.onStepStarted(
      new Map(),
      ev.stepStarted("completed-first", -200)
    );
    state = collector.onTextStarted(
      state,
      ev.textStarted(0, "completed-first")
    );
    state = collector.onStepEnded(
      state,
      ev.stepEnded(1000, 10, 0, 100, "completed-first")
    );
    state = collector.onStepStarted(
      state,
      ev.stepStarted("decoding-second", 0)
    );
    state = collector.onTextStarted(
      state,
      ev.textStarted(100, "decoding-second")
    );
    state = collector.onTextDelta(
      state,
      ev.textDelta("1234567890", "decoding-second")
    );

    expect([...state.keys()]).toEqual(["completed-first", "decoding-second"]);
    const ticked = collector.tick(state, 1100);

    expect(ticked.get("completed-first")?.current.phase).toBe("done");
    expect(ticked.get("decoding-second")?.current).toMatchObject({
      phase: "decoding",
      liveEstimate: 10,
    });
  });

  it("preserves accumulated characters across chained ticks and an interleaved delta", () => {
    const collector = new SpeedCollector();
    let state = collector.onStepStarted(
      new Map(),
      ev.stepStarted("s1", -200)
    );
    state = collector.onTextStarted(state, ev.textStarted(0));
    state = collector.onTextDelta(state, ev.textDelta("1234567890"));

    state = collector.tick(state, 1000);
    expect(state.get("s1")?.current).toMatchObject({
      phase: "decoding",
      liveChars: 10,
      liveEstimate: 10,
    });

    state = collector.tick(state, 2000);
    expect(state.get("s1")?.current).toMatchObject({
      phase: "decoding",
      liveChars: 10,
      liveEstimate: 5,
    });

    state = collector.onTextDelta(state, ev.textDelta("12345"));
    state = collector.tick(state, 3000);
    expect(state.get("s1")?.current).toMatchObject({
      phase: "decoding",
      liveChars: 15,
      liveEstimate: 5,
    });
  });

  it("chains ticks and deltas independently across concurrent sessions", () => {
    const collector = new SpeedCollector();
    let state: CollectorState = new Map();
    state = collector.onStepStarted(state, ev.stepStarted("text", -200));
    state = collector.onTextStarted(state, ev.textStarted(0, "text"));
    state = collector.onTextDelta(
      state,
      ev.textDelta("1234567890", "text")
    );
    state = collector.onStepStarted(
      state,
      ev.stepStarted("reasoning", 300)
    );
    state = collector.onReasoningStarted(
      state,
      ev.reasoningStarted(500, "reasoning")
    );
    state = collector.onReasoningDelta(
      state,
      ev.reasoningDelta("123456789", "reasoning")
    );

    state = collector.tick(state, 1000);
    expect(state.get("text")?.current).toMatchObject({
      phase: "decoding",
      liveChars: 10,
      liveEstimate: 10,
    });
    expect(state.get("reasoning")?.current).toMatchObject({
      phase: "decoding",
      liveChars: 9,
      liveEstimate: 18,
    });

    state = collector.onTextDelta(state, ev.textDelta("12345", "text"));
    state = collector.onReasoningDelta(
      state,
      ev.reasoningDelta("123", "reasoning")
    );
    state = collector.tick(state, 2000);

    expect(state.get("text")?.current).toMatchObject({
      phase: "decoding",
      liveChars: 15,
      liveEstimate: 7.5,
    });
    expect(state.get("reasoning")?.current).toMatchObject({
      phase: "decoding",
      liveChars: 12,
      liveEstimate: 8,
    });
  });

  it("onIdle selects the requested session even when another session is first", () => {
    const collector = new SpeedCollector();
    const other = stateAtPhase("prefilling", "map-first").get("map-first");
    const target = stateAtPhase("decoding", "target").get("target");
    if (!other || !target) throw new Error("idle fixtures must exist");
    other.stepHistory = [
      {
        phase: "done",
        sessionID: "map-first-history",
        ttft: 1,
        prefillTokPerSec: 2,
        decodeTokPerSec: 3,
      },
    ];
    target.stepHistory = [
      {
        phase: "done",
        sessionID: "target-history",
        ttft: 4,
        prefillTokPerSec: 5,
        decodeTokPerSec: 6,
      },
    ];
    const targetHistoryBefore = structuredClone(target.stepHistory);
    const state: CollectorState = new Map([
      ["map-first", other],
      ["target", target],
    ]);

    const idled = collector.onIdle(state, "target");

    expect(idled.get("target")?.current.phase).toBe("idle");
    expect(idled.get("target")?.stepHistory).toEqual(targetHistoryBefore);
    expect(idled.get("map-first")).toEqual(other);
  });

  it("unscoped session.error changes every in-flight session and no terminal session", () => {
    const collector = new SpeedCollector();
    const state: CollectorState = new Map();
    for (const phase of registeredPhases) {
      const sessionID = `phase-${phase}`;
      const metrics = stateAtPhase(phase, sessionID).get(sessionID);
      if (!metrics) throw new Error(`${phase} fixture must exist`);
      state.set(sessionID, metrics);
    }
    const idleBefore = structuredClone(state.get("phase-idle"));
    const doneBefore = structuredClone(state.get("phase-done"));
    const errorBefore = structuredClone(state.get("phase-error"));
    const historiesBefore = new Map(
      [...state].map(([sessionID, metrics]) => [
        sessionID,
        structuredClone(metrics.stepHistory),
      ])
    );
    const keysBefore = [...state.keys()];
    const stateBefore = stateSnapshot(state);

    const failed = collector.onSessionError(state);

    expect(failed.get("phase-prefilling")?.current).toEqual({
      phase: "error",
      sessionID: "phase-prefilling",
    });
    expect(failed.get("phase-decoding")?.current).toEqual({
      phase: "error",
      sessionID: "phase-decoding",
    });
    expect(failed.get("phase-idle")).toEqual(idleBefore);
    expect(failed.get("phase-done")).toEqual(doneBefore);
    expect(failed.get("phase-error")).toEqual(errorBefore);
    expect([...failed.keys()]).toEqual(keysBefore);
    for (const [sessionID, historyBefore] of historiesBefore) {
      expect(failed.get(sessionID)?.stepHistory).toHaveLength(
        historyBefore.length
      );
      expect(failed.get(sessionID)?.stepHistory).toEqual(historyBefore);
    }
    expect(stateSnapshot(state)).toEqual(stateBefore);
  });

  it.each([undefined, null, ""])(
    "treats %s session.error scope as unscoped",
    (sessionID) => {
      const collector = new SpeedCollector();
      const state = stateAtPhase("prefilling");

      expect(collector.onSessionError(state, sessionID).get("target")?.current).toEqual({
        phase: "error",
        sessionID: "target",
      });
    }
  );

  it.each([undefined, null, ""])(
    "returns the original map for %s unscoped error with no in-flight session",
    (sessionID) => {
      const collector = new SpeedCollector();
      const state = stateAtPhase("done");

      expect(collector.onSessionError(state, sessionID)).toBe(state);
    }
  );

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

  it("subtracts positive cache.read tokens from the prefill numerator", () => {
    const collector = new SpeedCollector();
    let state = collector.onStepStarted(new Map(), ev.stepStarted("s1", 1000));
    state = collector.onTextStarted(state, ev.textStarted(1500));
    const ended = ev.stepEnded(2500, 10, 0, 100);
    ended.tokens.cache.read = 40;
    state = collector.onStepEnded(state, ended);

    expect(state.get("s1")?.current).toMatchObject({
      phase: "done",
      prefillTokPerSec: 120,
    });
  });

  it.each([100, 101])(
    "returns null when cache.read %i leaves no effective input tokens",
    (cacheRead) => {
      const collector = new SpeedCollector();
      let state = collector.onStepStarted(new Map(), ev.stepStarted("s1", 1000));
      state = collector.onTextStarted(state, ev.textStarted(1500));
      const ended = ev.stepEnded(2500, 10, 0, 100);
      ended.tokens.cache.read = cacheRead;
      state = collector.onStepEnded(state, ended);

      expect(state.get("s1")?.current).toMatchObject({
        phase: "done",
        prefillTokPerSec: null,
      });
    },
  );

  it.each(["zero", "unreported"] as const)(
    "uses all input tokens when cache.read is %s",
    (cacheRead) => {
      const collector = new SpeedCollector();
      let state = collector.onStepStarted(new Map(), ev.stepStarted("s1", 1000));
      state = collector.onTextStarted(state, ev.textStarted(1500));
      const ended = structuredClone(
        ev.stepEnded(2500, 10, 0, 100),
      ) as unknown as Parameters<SpeedCollector["onStepEnded"]>[1];
      if (cacheRead === "unreported") delete ended.tokens.cache;
      state = collector.onStepEnded(state, ended);

      expect(state.get("s1")?.current).toMatchObject({
        phase: "done",
        prefillTokPerSec: 200,
      });
    },
  );

  it.each([
    ["just below", MAX_PREFILL_TOK_PER_SEC - 1, MAX_PREFILL_TOK_PER_SEC - 1],
    ["at", MAX_PREFILL_TOK_PER_SEC, MAX_PREFILL_TOK_PER_SEC],
    ["just above", MAX_PREFILL_TOK_PER_SEC + 1, null],
  ] as const)(
    "applies the prefill plausibility threshold %s the boundary",
    (_label, inputTokens, expected) => {
      const collector = new SpeedCollector();
      let state = collector.onStepStarted(new Map(), ev.stepStarted("s1", 0));
      state = collector.onTextStarted(state, ev.textStarted(1000));
      state = collector.onStepEnded(
        state,
        ev.stepEnded(2000, 1, 0, inputTokens),
      );

      expect(state.get("s1")?.current).toMatchObject({
        phase: "done",
        prefillTokPerSec: expected,
      });
    },
  );

  it.each([
    ["ttft just below zero", -Number.MIN_VALUE, 1, null],
    ["ttft at zero", 0, 1, null],
    ["smallest positive ttft", Number.MIN_VALUE, 1, null],
    ["positive sub-millisecond ttft", Number.EPSILON, 1, null],
    ["ordinary positive ttft with one token", 200, 1, 5],
    ["input just below zero", 1, -Number.MIN_VALUE, null],
    ["input at zero", 1, 0, null],
    ["smallest positive input", 1, Number.MIN_VALUE, Number.MIN_VALUE * 1000],
    ["one input token", 1, 1, 1000],
  ] as const)(
    "locks the prefill guard at zero for %s",
    (_label, ttft, inputTokens, expected) => {
      const collector = new SpeedCollector();
      let state = collector.onStepStarted(
        new Map(),
        ev.stepStarted("s1", 0)
      );
      state = collector.onTextStarted(state, ev.textStarted(ttft));
      state = collector.onStepEnded(
        state,
        ev.stepEnded(ttft + 1000, 1, 0, inputTokens)
      );

      const current = state.get("s1")?.current;
      expect(current?.phase).toBe("done");
      if (current?.phase !== "done") return;
      expect(current.ttft).toBe(ttft);
      if (expected === null) {
        expect(current.prefillTokPerSec).toBe(expected);
      } else {
        expect(current.prefillTokPerSec).not.toBeNull();
        if (!Number.isFinite(expected)) {
          expect(current.prefillTokPerSec).toBe(expected);
          return;
        }
        expect(current.prefillTokPerSec).toBeCloseTo(expected, 12);
      }
    }
  );

  it.each([
    [
      "reasoning.started",
      (collector: SpeedCollector, state: CollectorState) =>
        collector.onReasoningStarted(state, ev.reasoningStarted(1100)),
    ],
    [
      "text.started",
      (collector: SpeedCollector, state: CollectorState) =>
        collector.onTextStarted(state, ev.textStarted(1100)),
    ],
  ] as const)("preserves a negative TTFT through %s", (_source, startDecoding) => {
    const collector = new SpeedCollector();
    let state = collector.onStepStarted(new Map(), ev.stepStarted("s1", 1200));
    state = startDecoding(collector, state);
    state = collector.onStepEnded(state, ev.stepEnded(2000, 9, 0, 100));

    expect(state.get("s1")?.current).toMatchObject({
      phase: "done",
      sessionID: "s1",
      ttft: -100,
      prefillTokPerSec: null,
      decodeTokPerSec: 10,
    });
  });

  it.each([
    ["tokens", 0, null],
    ["output", 2, 500],
    ["reasoning", 10, 500],
    ["input", 12, null],
  ] as const)(
    "uses safe defaults when runtime step.ended omits %s",
    (omitted, expectedDecode, expectedPrefill) => {
      const collector = new SpeedCollector();
      let state = collector.onStepStarted(new Map(), ev.stepStarted("s1", 1000));
      state = collector.onTextStarted(state, ev.textStarted(1200));
      const props = structuredClone(ev.stepEnded(2200, 10, 2, 100)) as unknown as
        Record<string, unknown>;
      if (omitted === "tokens") {
        delete props.tokens;
      } else {
        delete (props.tokens as Record<string, unknown>)[omitted];
      }

      state = collector.onStepEnded(
        state,
        props as unknown as Parameters<SpeedCollector["onStepEnded"]>[1]
      );

      expect(state.get("s1")?.current).toMatchObject({
        phase: "done",
        decodeTokPerSec: expectedDecode,
        prefillTokPerSec: expectedPrefill,
      });
    }
  );

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

  it.each([
    [
      "step.failed",
      (collector: SpeedCollector, state: CollectorState) =>
        collector.onStepFailed(state, ev.stepFailed("s1")),
    ],
    [
      "session.status idle",
      (collector: SpeedCollector, state: CollectorState) =>
        collector.onIdle(state, "s1"),
    ],
  ] as const)(
    "preserves stepHistory across %s and same-message resumption",
    (_interruption, interrupt) => {
      const collector = new SpeedCollector();
      let state = collector.onStepStarted(
        new Map(),
        ev.stepStarted("s1", 1000, "msg1")
      );
      state = collector.onTextStarted(state, ev.textStarted(1200));
      state = collector.onStepEnded(state, ev.stepEnded(2200, 10));
      expect(state.get("s1")?.stepHistory).toHaveLength(1);

      state = collector.onStepStarted(
        state,
        ev.stepStarted("s1", 3000, "msg1")
      );
      state = interrupt(collector, state);
      expect(state.get("s1")?.stepHistory).toHaveLength(1);

      state = collector.onStepStarted(
        state,
        ev.stepStarted("s1", 4000, "msg1")
      );
      state = collector.onTextStarted(state, ev.textStarted(4200));
      state = collector.onStepEnded(state, ev.stepEnded(5200, 20));

      expect(state.get("s1")?.stepHistory).toHaveLength(2);
      expect(
        state.get("s1")?.stepHistory.map((step) => step.decodeTokPerSec)
      ).toEqual([10, 20]);
    }
  );

  it("updates liveEstimate only after more than 0.1 seconds", () => {
    const collector = new SpeedCollector();
    let state = collector.onStepStarted(new Map(), ev.stepStarted("s1", -200));
    state = collector.onTextStarted(state, ev.textStarted(0));
    state = collector.onTextDelta(state, ev.textDelta("1234567890"));

    const atBoundary = collector.tick(state, 100);
    expect(atBoundary.get("s1")?.current).toMatchObject({ liveEstimate: null });

    const immediatelyAfterBoundary = 100.00000000000001;
    expect(immediatelyAfterBoundary).toBeGreaterThan(100);
    const afterBoundary = collector.tick(state, immediatelyAfterBoundary);
    const current = afterBoundary.get("s1")?.current;
    expect(current?.phase === "decoding" && current.liveEstimate).toBeCloseTo(100);
  });

  it("uses Date.now for liveEstimate when tick omits now", () => {
    vi.useFakeTimers();
    try {
      const now = Date.parse("2026-09-14T00:00:00.000Z");
      vi.setSystemTime(now);

      const collector = new SpeedCollector();
      let state = collector.onStepStarted(
        new Map(),
        ev.stepStarted("s1", now - 400)
      );
      state = collector.onTextStarted(state, ev.textStarted(now - 200));
      state = collector.onTextDelta(state, ev.textDelta("1234567890"));

      const ticked = collector.tick(state);
      const current = ticked.get("s1")?.current;
      expect(current?.phase === "decoding" && current.liveEstimate).toBeCloseTo(50);
    } finally {
      vi.useRealTimers();
    }
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

    let zeroPrefill = collector.onStepStarted(new Map(), ev.stepStarted("s1", 1200));
    zeroPrefill = collector.onTextStarted(zeroPrefill, ev.textStarted(1200));
    zeroPrefill = collector.onStepEnded(zeroPrefill, ev.stepEnded(2200, 10));
    expect(zeroPrefill.get("s1")?.current).toMatchObject({
      phase: "done",
      prefillTokPerSec: null,
    });

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

  it("calculates decode speed at the smallest positive elapsed time", () => {
    const collector = new SpeedCollector();
    const smallestPositiveDecodeTimeSec = Number.MIN_VALUE;
    let state = collector.onStepStarted(new Map(), ev.stepStarted("s1", -1));
    state = collector.onTextStarted(state, ev.textStarted(0));
    state = collector.onStepEnded(
      state,
      ev.stepEnded(
        smallestPositiveDecodeTimeSec * 1000,
        smallestPositiveDecodeTimeSec
      )
    );

    expect(state.get("s1")?.current).toMatchObject({
      phase: "done",
      decodeTokPerSec: 1,
    });
  });

  it.each([
    ["just below zero", -Number.MIN_VALUE, 0],
    ["at zero", 0, 0],
    ["ordinary positive", 1, 2],
  ] as const)(
    "locks the decode-time guard %s",
    (_label, decodeTimeSec, expected) => {
      const collector = new SpeedCollector();
      let state = collector.onStepStarted(new Map(), ev.stepStarted("s1", -1));
      state = collector.onTextStarted(state, ev.textStarted(0));
      state = collector.onStepEnded(
        state,
        ev.stepEnded(decodeTimeSec * 1000, 2)
      );

      expect(state.get("s1")?.current).toMatchObject({
        phase: "done",
        decodeTokPerSec: expected,
      });
    }
  );

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
});
