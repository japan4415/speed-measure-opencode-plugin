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

export type DecodingState = {
  phase: "decoding";
  sessionID: string;
  assistantMessageID: string;
  t0: number;
  t1: number;
  ttft: number;
  liveChars: number;
  liveEstimate: number | null;
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
      const decodeTimeSec = (stepEndedTs - t1) / 1000;

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
   */
  tick(state: CollectorState, now: number = Date.now()): CollectorState {
    let hasChanges = false;
    const updated = new Map(state);

    for (const [sid, m] of state) {
      if (m.current.phase !== "decoding") continue;
      hasChanges = true;
      const elapsed = (now - m.current.t1) / 1000;
      const est = elapsed > 0.1 ? m.current.liveChars / elapsed : null;
      updated.set(sid, {
        ...m,
        current: {
          ...m.current,
          liveEstimate: est,
        },
      });
    }

    return hasChanges ? updated : state;
  }
}
