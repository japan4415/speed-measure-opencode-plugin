/**
 * OpenCode speed measurement state machine.
 * Pure functions only: no side effects, no JSX.
 */

export type IdleState = { phase: "idle" };

export type PrefillingState = {
  phase: "prefilling";
  sessionID: string;
  assistantMessageID: string;
  t0: number;
};

/**
 * Execution interval of a single tool call.
 * `end` is absent while the tool is still running, so the interval is open.
 * The interval deliberately starts at `tool.called` (after tool-input generation)
 * so the argument generation time stays inside the decode window.
 */
export type ToolInterval = {
  callID: string;
  start: number;
  end?: number;
};

export type DecodingState = {
  phase: "decoding";
  sessionID: string;
  assistantMessageID: string;
  t0: number;
  t1: number;
  ttft: number;
  liveChars: number;
  liveEstimate: number | null;
  /** Present only once a tool call has been observed during this step. */
  toolIntervals?: ToolInterval[];
};

export type DoneState = {
  phase: "done";
  sessionID: string;
  ttft: number;
  prefillTokPerSec: number | null; // null = input/TTFT が非正または閾値超過
  decodeTokPerSec: number;
};

export type ErrorState = { phase: "error"; sessionID: string };

export type StepState =
  | IdleState
  | PrefillingState
  | DecodingState
  | DoneState
  | ErrorState;

export type SessionMetrics = {
  current: StepState;
  stepHistory: DoneState[]; // 同一 assistantMessageID 内の完了ステップ
};

export type CollectorState = Map<string, SessionMetrics>; // key = sessionID

/** Values above this limit are treated as implausible measurements. */
export const MAX_PREFILL_TOK_PER_SEC = 500_000;

export interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cache?: {
    read: number;
    write: number;
  };
}

export interface StepStartedProps {
  sessionID: string;
  assistantMessageID: string;
  timestamp: number;
  [key: string]: unknown;
}

export interface ReasoningStartedProps {
  sessionID: string;
  assistantMessageID?: string;
  reasoningID?: string;
  timestamp: number;
  [key: string]: unknown;
}

export interface ReasoningDeltaProps {
  sessionID: string;
  delta: string;
  assistantMessageID?: string;
  reasoningID?: string;
  timestamp?: number;
  [key: string]: unknown;
}

export interface TextStartedProps {
  sessionID: string;
  assistantMessageID?: string;
  textID?: string;
  timestamp: number;
  [key: string]: unknown;
}

export interface TextDeltaProps {
  sessionID: string;
  delta: string;
  assistantMessageID?: string;
  textID?: string;
  timestamp?: number;
  [key: string]: unknown;
}

export interface StepEndedProps {
  sessionID: string;
  timestamp: number;
  tokens: TokenUsage;
  assistantMessageID?: string;
  [key: string]: unknown;
}

export interface StepFailedProps {
  sessionID: string;
  assistantMessageID?: string;
  timestamp?: number;
  error?: unknown;
  [key: string]: unknown;
}

export interface ToolCalledProps {
  sessionID: string;
  callID: string;
  timestamp: number;
  assistantMessageID?: string;
  [key: string]: unknown;
}

export interface ToolEndedProps {
  sessionID: string;
  callID: string;
  timestamp: number;
  assistantMessageID?: string;
  [key: string]: unknown;
}

/**
 * Total wall-clock length covered by the union of tool execution intervals,
 * clamped to the decode window `[t1, endTs]`.
 *
 * Overlapping intervals (parallel tool calls) are merged so their shared span
 * is counted exactly once, and open intervals (no `end`) are clamped to `endTs`.
 */
function toolBusyMs(
  intervals: readonly ToolInterval[] | undefined,
  t1: number,
  endTs: number
): number {
  if (!intervals || intervals.length === 0) return 0;

  const clipped = intervals
    .map((interval) => ({
      start: Math.max(interval.start, t1),
      end: Math.min(interval.end ?? endTs, endTs),
    }))
    .filter((interval) => interval.end > interval.start)
    .sort((a, b) => a.start - b.start);

  let total = 0;
  let currentStart = 0;
  let currentEnd = 0;
  let hasGroup = false;

  for (const interval of clipped) {
    if (!hasGroup) {
      currentStart = interval.start;
      currentEnd = interval.end;
      hasGroup = true;
      continue;
    }
    if (interval.start > currentEnd) {
      total += currentEnd - currentStart;
      currentStart = interval.start;
      currentEnd = interval.end;
    } else if (interval.end > currentEnd) {
      currentEnd = interval.end;
    }
  }

  if (hasGroup) total += currentEnd - currentStart;
  return total;
}

export class SpeedCollector {
  /**
   * session.next.step.started
   * any -> prefilling
   */
  onStepStarted(state: CollectorState, props: StepStartedProps): CollectorState {
    const updated = new Map(state);
    const prev = updated.get(props.sessionID);

    let stepHistory: DoneState[] = [];
    if (prev) {
      const lastMsgId =
        (prev.current as { assistantMessageID?: string }).assistantMessageID ??
        (prev.stepHistory.length > 0
          ? (prev.stepHistory[prev.stepHistory.length - 1] as { assistantMessageID?: string })
              .assistantMessageID
          : undefined);

      if (!lastMsgId || lastMsgId === props.assistantMessageID) {
        stepHistory = prev.stepHistory;
      }
    }

    const current: PrefillingState = {
      phase: "prefilling",
      sessionID: props.sessionID,
      assistantMessageID: props.assistantMessageID,
      t0: props.timestamp,
    };

    updated.set(props.sessionID, {
      current,
      stepHistory,
    });
    return updated;
  }

  /**
   * session.next.reasoning.started
   * prefilling -> decoding (t1 = reasoning.started)
   */
  onReasoningStarted(
    state: CollectorState,
    props: ReasoningStartedProps
  ): CollectorState {
    const prev = state.get(props.sessionID);
    if (!prev || prev.current.phase !== "prefilling") {
      return state;
    }

    const updated = new Map(state);
    const t1 = props.timestamp;
    const ttft = t1 - prev.current.t0;
    const current: DecodingState = {
      phase: "decoding",
      sessionID: props.sessionID,
      assistantMessageID: prev.current.assistantMessageID,
      t0: prev.current.t0,
      t1,
      ttft,
      liveChars: 0,
      liveEstimate: null,
    };

    updated.set(props.sessionID, {
      ...prev,
      current,
    });
    return updated;
  }

  /**
   * session.next.reasoning.delta
   * decoding -> decoding (liveChars += delta.length)
   */
  onReasoningDelta(
    state: CollectorState,
    props: ReasoningDeltaProps
  ): CollectorState {
    const prev = state.get(props.sessionID);
    if (!prev || prev.current.phase !== "decoding") {
      return state;
    }

    const updated = new Map(state);
    const current: DecodingState = {
      ...prev.current,
      liveChars: prev.current.liveChars + (props.delta?.length ?? 0),
    };

    updated.set(props.sessionID, {
      ...prev,
      current,
    });
    return updated;
  }

  /**
   * session.next.text.started
   * prefilling -> decoding (t1 = text.started)
   * If already decoding (e.g. reasoning started earlier), t1 is not overwritten.
   */
  onTextStarted(state: CollectorState, props: TextStartedProps): CollectorState {
    const prev = state.get(props.sessionID);
    if (!prev || prev.current.phase !== "prefilling") {
      return state;
    }

    const updated = new Map(state);
    const t1 = props.timestamp;
    const ttft = t1 - prev.current.t0;
    const current: DecodingState = {
      phase: "decoding",
      sessionID: props.sessionID,
      assistantMessageID: prev.current.assistantMessageID,
      t0: prev.current.t0,
      t1,
      ttft,
      liveChars: 0,
      liveEstimate: null,
    };

    updated.set(props.sessionID, {
      ...prev,
      current,
    });
    return updated;
  }

  /**
   * session.next.text.delta
   * decoding -> decoding (liveChars += delta.length)
   */
  onTextDelta(state: CollectorState, props: TextDeltaProps): CollectorState {
    const prev = state.get(props.sessionID);
    if (!prev || prev.current.phase !== "decoding") {
      return state;
    }

    const updated = new Map(state);
    const current: DecodingState = {
      ...prev.current,
      liveChars: prev.current.liveChars + (props.delta?.length ?? 0),
    };

    updated.set(props.sessionID, {
      ...prev,
      current,
    });
    return updated;
  }

  /**
   * session.next.tool.called (v2) / ToolPart state.time.start (v1 fallback)
   * decoding -> decoding (opens a tool execution interval keyed by callID)
   * Any other phase is ignored: a step without textual output never records decode speed.
   */
  onToolCalled(state: CollectorState, props: ToolCalledProps): CollectorState {
    const prev = state.get(props.sessionID);
    if (!prev || prev.current.phase !== "decoding") {
      return state;
    }

    const existing = prev.current.toolIntervals ?? [];
    if (existing.some((interval) => interval.callID === props.callID)) {
      return state;
    }

    const updated = new Map(state);
    const current: DecodingState = {
      ...prev.current,
      toolIntervals: [
        ...existing,
        { callID: props.callID, start: props.timestamp },
      ],
    };

    updated.set(props.sessionID, {
      ...prev,
      current,
    });
    return updated;
  }

  /**
   * session.next.tool.success / session.next.tool.failed (v2)
   * ToolPart state.time.end (v1 fallback)
   * decoding -> decoding (closes the matching open tool execution interval)
   * Unknown callIDs and other phases are ignored.
   */
  onToolEnded(state: CollectorState, props: ToolEndedProps): CollectorState {
    const prev = state.get(props.sessionID);
    if (!prev || prev.current.phase !== "decoding") {
      return state;
    }

    const existing = prev.current.toolIntervals;
    if (!existing || existing.length === 0) {
      return state;
    }

    const index = existing.findIndex(
      (interval) =>
        interval.callID === props.callID && interval.end === undefined
    );
    if (index === -1) {
      return state;
    }

    const updated = new Map(state);
    const toolIntervals = existing.slice();
    toolIntervals[index] = { ...toolIntervals[index], end: props.timestamp };
    const current: DecodingState = {
      ...prev.current,
      toolIntervals,
    };

    updated.set(props.sessionID, {
      ...prev,
      current,
    });
    return updated;
  }

  /**
   * session.next.step.ended
   * decoding -> done (calculates decodeTokPerSec, appends to stepHistory)
   * prefilling -> idle (step without generating text, e.g. tool execution)
   */
  onStepEnded(state: CollectorState, props: StepEndedProps): CollectorState {
    const prev = state.get(props.sessionID);
    if (!prev) {
      return state;
    }

    if (prev.current.phase === "prefilling") {
      const updated = new Map(state);
      const current: IdleState = { phase: "idle" };
      updated.set(props.sessionID, {
        ...prev,
        current,
      });
      return updated;
    }

    if (prev.current.phase === "decoding") {
      const updated = new Map(state);
      const t1 = prev.current.t1;
      const ttft = prev.current.ttft;
      const stepEndedTs = props.timestamp;
      // OpenCode publishes step.ended only after every tool fiber has settled,
      // so the raw span includes tool execution. Subtract the union of the tool
      // execution intervals (tool-input generation stays inside the window).
      const toolBusy = toolBusyMs(prev.current.toolIntervals, t1, stepEndedTs);
      const decodeTimeSec = (stepEndedTs - t1 - toolBusy) / 1000;

      const outputTokens =
        (props.tokens?.output ?? 0) + (props.tokens?.reasoning ?? 0);
      const inputTokens = props.tokens?.input ?? 0;

      const decodeTokPerSec =
        decodeTimeSec > 0 ? outputTokens / decodeTimeSec : 0;
      const calculatedPrefillTokPerSec =
        ttft > 0 && inputTokens > 0
          ? inputTokens / (ttft / 1000)
          : null;
      const prefillTokPerSec =
        calculatedPrefillTokPerSec !== null &&
        calculatedPrefillTokPerSec <= MAX_PREFILL_TOK_PER_SEC
          ? calculatedPrefillTokPerSec
          : null;

      const doneState: DoneState & { assistantMessageID?: string } = {
        phase: "done",
        sessionID: props.sessionID,
        ttft,
        prefillTokPerSec,
        decodeTokPerSec,
        assistantMessageID: prev.current.assistantMessageID,
      };

      const stepHistory = [...prev.stepHistory, doneState];

      updated.set(props.sessionID, {
        current: doneState,
        stepHistory,
      });
      return updated;
    }

    return state;
  }

  /**
   * session.next.step.failed
   * any -> error
   */
  onStepFailed(state: CollectorState, props: StepFailedProps): CollectorState {
    const updated = new Map(state);
    const prev = updated.get(props.sessionID) ?? {
      current: { phase: "idle" },
      stepHistory: [],
    };

    const current: ErrorState = {
      phase: "error",
      sessionID: props.sessionID,
    };

    updated.set(props.sessionID, {
      ...prev,
      current,
    });
    return updated;
  }

  /**
   * session.status (idle)
   * prefilling / decoding -> idle
   * done / error -> preserved until next step.started
   */
  onIdle(state: CollectorState, sessionID: string): CollectorState {
    const prev = state.get(sessionID);
    if (!prev) {
      return state;
    }

    if (
      prev.current.phase === "prefilling" ||
      prev.current.phase === "decoding"
    ) {
      const updated = new Map(state);
      const current: IdleState = { phase: "idle" };
      updated.set(sessionID, {
        ...prev,
        current,
      });
      return updated;
    }

    return state;
  }

  /**
   * session.error
   * If sessionID is specified: that session -> error (any -> error)
   * If sessionID is absent/null/undefined: all in-flight (prefilling/decoding) sessions -> error
   */
  onSessionError(
    state: CollectorState,
    sessionID?: string | null
  ): CollectorState {
    const updated = new Map(state);

    if (sessionID != null && sessionID !== "") {
      const prev = updated.get(sessionID) ?? {
        current: { phase: "idle" },
        stepHistory: [],
      };
      const current: ErrorState = {
        phase: "error",
        sessionID,
      };
      updated.set(sessionID, {
        ...prev,
        current,
      });
      return updated;
    }

    let hasChanges = false;
    for (const [sid, m] of state) {
      if (m.current.phase === "prefilling" || m.current.phase === "decoding") {
        hasChanges = true;
        const current: ErrorState = {
          phase: "error",
          sessionID: sid,
        };
        updated.set(sid, {
          ...m,
          current,
        });
      }
    }

    return hasChanges ? updated : state;
  }

  /**
   * tick
   * Updates liveEstimate for decoding sessions (liveChars / elapsed seconds).
   * If elapsed <= 0.1s, liveEstimate remains null.
   * While a tool is executing, the previous estimate is frozen so that a
   * growing elapsed time cannot drag chars/s down toward zero.
   * Once every tool interval is closed, the union of those intervals is
   * subtracted from the elapsed time, mirroring `onStepEnded` so the live
   * value cannot regress to counting tool execution as decode time.
   */
  tick(state: CollectorState, now: number = Date.now()): CollectorState {
    let hasChanges = false;
    const updated = new Map(state);

    for (const [sid, m] of state) {
      if (m.current.phase !== "decoding") continue;
      hasChanges = true;

      const running = (m.current.toolIntervals ?? []).some(
        (interval) => interval.end === undefined
      );
      const liveEstimate = running
        ? m.current.liveEstimate
        : (() => {
            const toolBusy = toolBusyMs(m.current.toolIntervals, m.current.t1, now);
            const elapsed = (now - m.current.t1 - toolBusy) / 1000;
            return elapsed > 0.1 ? m.current.liveChars / elapsed : null;
          })();

      updated.set(sid, {
        ...m,
        current: {
          ...m.current,
          liveEstimate,
        },
      });
    }

    return hasChanges ? updated : state;
  }
}
