import { describe, expect, it, vi } from "vitest";
import type { Event } from "@opencode-ai/sdk/v2";

import {
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
    name: "onStepStarted",
    expected: Object.fromEntries(
      matrixPhases.map((phase) => [phase, "prefilling"])
    ) as Record<MatrixPhase, MatrixPhase>,
    changesFrom: matrixPhases,
    invoke: (collector, state) =>
      collector.onStepStarted(state, ev.stepStarted("target", 2000)),
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

  if (handlerName === "onStepStarted") {
    return withCurrent({
      phase: "prefilling",
      sessionID: "target",
      assistantMessageID: "msg1",
      t0: 2000,
    });
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
      "$handler.name: $phase -> expected phase",
      ({ handler, phase }) => {
        const collector = new SpeedCollector();
        const initial = stateAtPhase(phase);
        const initialSnapshot = stateSnapshot(initial);
        const result = handler.invoke(collector, initial);

        expect(currentPhase(result)).toBe(handler.expected[phase]);

        if (!handler.changesFrom.includes(phase)) {
          expect(result).toBe(initial);
        }
        expect(stateSnapshot(result)).toEqual(
          stateSnapshot(expectedMatrixState(handler.name, phase))
        );
        expect(stateSnapshot(initial)).toEqual(initialSnapshot);
      }
    );
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

  describe("multiple-session isolation matrix", () => {
    const cases: Array<{
      name: string;
      targetPhase: RegisteredPhase;
      invoke: (collector: SpeedCollector, state: CollectorState) => CollectorState;
    }> = [
      {
        name: "onStepStarted",
        targetPhase: "done",
        invoke: (collector, state) =>
          collector.onStepStarted(state, ev.stepStarted("target", 2000)),
      },
      {
        name: "onReasoningStarted",
        targetPhase: "prefilling",
        invoke: (collector, state) =>
          collector.onReasoningStarted(state, ev.reasoningStarted(1250, "target")),
      },
      {
        name: "onReasoningDelta",
        targetPhase: "decoding",
        invoke: (collector, state) =>
          collector.onReasoningDelta(state, ev.reasoningDelta("abc", "target")),
      },
      {
        name: "onTextStarted",
        targetPhase: "prefilling",
        invoke: (collector, state) =>
          collector.onTextStarted(state, ev.textStarted(1250, "target")),
      },
      {
        name: "onTextDelta",
        targetPhase: "decoding",
        invoke: (collector, state) =>
          collector.onTextDelta(state, ev.textDelta("abc", "target")),
      },
      {
        name: "onStepEnded",
        targetPhase: "decoding",
        invoke: (collector, state) =>
          collector.onStepEnded(state, ev.stepEnded(2200, 10, 0, 100, "target")),
      },
      {
        name: "onStepFailed",
        targetPhase: "done",
        invoke: (collector, state) =>
          collector.onStepFailed(state, ev.stepFailed("target")),
      },
      {
        name: "onIdle",
        targetPhase: "decoding",
        invoke: (collector, state) => collector.onIdle(state, "target"),
      },
      {
        name: "onSessionError(scoped)",
        targetPhase: "done",
        invoke: (collector, state) => collector.onSessionError(state, "target"),
      },
    ];

    it.each(cases)("$name changes no session except its target", ({ targetPhase, invoke }) => {
      const collector = new SpeedCollector();
      const state = stateAtPhase(targetPhase);
      const observer = stateAtPhase("decoding", "observer").get("observer");
      if (!observer) throw new Error("observer fixture must exist");
      state.set("observer", observer);
      const observerBefore = structuredClone(observer);

      const result = invoke(collector, state);

      expect(result.get("observer")).toEqual(observerBefore);
      expect(result.has("target")).toBe(true);
      expect(result.size).toBe(2);
    });
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

    const failed = collector.onSessionError(state);

    expect(failed.get("phase-prefilling")?.current.phase).toBe("error");
    expect(failed.get("phase-decoding")?.current.phase).toBe("error");
    expect(failed.get("phase-idle")).toEqual(idleBefore);
    expect(failed.get("phase-done")).toEqual(doneBefore);
    expect(failed.get("phase-error")).toEqual(errorBefore);
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
