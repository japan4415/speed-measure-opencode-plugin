import { afterEach, describe, expect, it, vi } from "vitest";

import type { CollectorState } from "../src/collector.js";
import {
  DEFAULT_CONFIG,
  buildDisplayLines,
  parseConfig,
  scheduleV1Fallback,
} from "../src/index.js";

afterEach(() => {
  vi.useRealTimers();
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
