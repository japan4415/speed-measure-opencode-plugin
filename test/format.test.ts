import { describe, expect, it } from "vitest";

import { formatSpeed, formatTTFT } from "../src/format.js";

describe("formatSpeed", () => {
  it.each([
    [58.3, "58.3 tok/s"],
    [999, "999 tok/s"],
    [1000, "1.0k tok/s"],
    [1200, "1.2k tok/s"],
    [9999, "10.0k tok/s"],
    [10000, "10k tok/s"],
    [12345, "12k tok/s"],
    [12600, "13k tok/s"],
    [1e9, "1000000k tok/s"],
  ])("formatSpeed(%d) = %s", (value, expected) => {
    expect(formatSpeed(value)).toBe(expected);
  });

  it.each([
    [-Number.MIN_VALUE, "-- tok/s"],
    [-Number.EPSILON, "-- tok/s"],
    [-0, "0 tok/s"],
    [0, "0 tok/s"],
  ])("honors the zero boundary for speed %s", (value, expected) => {
    expect(formatSpeed(value)).toBe(expected);
  });

  it.each([
    [58.34, "58.3 tok/s"],
    [58.36, "58.4 tok/s"],
    [1449, "1.4k tok/s"],
    [1451, "1.5k tok/s"],
    [10499, "10k tok/s"],
    [10501, "11k tok/s"],
    [999.94, "999.9 tok/s"],
    [999.95, "1.0k tok/s"],
    [999.99, "1.0k tok/s"],
    // Regression lock: this result intentionally follows binary floating-point
    // behavior in Number.prototype.toFixed(1), as documented in DESIGN.md §1.4.
    [9950, "9.9k tok/s"],
    [9999.4, "10.0k tok/s"],
    [9999.5, "10.0k tok/s"],
  ])("keeps unit transitions continuous at %d", (value, expected) => {
    expect(formatSpeed(value)).toBe(expected);
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -1,
    -0.5,
  ])(
    "returns the unavailable marker for invalid speed %s",
    (value) => {
      expect(formatSpeed(value)).toBe("-- tok/s");
    }
  );
});

describe("formatTTFT", () => {
  it.each([
    [340, "340 ms"],
    [340.1, "340 ms"],
    [340.4, "340 ms"],
    [340.5, "341 ms"],
    [340.6, "341 ms"],
    [1e9, "1000000000 ms"],
  ])("formatTTFT(%s) = %s", (value, expected) => {
    expect(formatTTFT(value)).toBe(expected);
  });

  it.each([
    [-Number.MIN_VALUE, "-- ms"],
    [-Number.EPSILON, "-- ms"],
    [-0, "0 ms"],
    [0, "0 ms"],
  ])("honors the zero boundary for TTFT %s", (value, expected) => {
    expect(formatTTFT(value)).toBe(expected);
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -1,
    -0.5,
  ])(
    "returns the unavailable marker for invalid TTFT %s",
    (value) => {
      expect(formatTTFT(value)).toBe("-- ms");
    }
  );
});
