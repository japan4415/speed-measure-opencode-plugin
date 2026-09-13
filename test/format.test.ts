import { describe, expect, it } from "vitest";

import { formatSpeed, formatTTFT } from "../src/format.js";

describe("formatSpeed", () => {
  it.each([
    [0, "0 tok/s"],
    [58.3, "58.3 tok/s"],
    [999, "999 tok/s"],
    [1000, "1.0k tok/s"],
    [1200, "1.2k tok/s"],
    [9999, "10.0k tok/s"],
    [10000, "10k tok/s"],
    [12345, "12k tok/s"],
    [12600, "13k tok/s"],
  ])("formatSpeed(%d) = %s", (value, expected) => {
    expect(formatSpeed(value)).toBe(expected);
  });

  it.each([
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

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1])(
    "returns the unavailable marker for invalid speed %s",
    (value) => {
      expect(formatSpeed(value)).toBe("-- tok/s");
    }
  );
});

describe("formatTTFT", () => {
  it("formats milliseconds as a rounded integer", () => {
    expect(formatTTFT(0)).toBe("0 ms");
    expect(formatTTFT(340)).toBe("340 ms");
    expect(formatTTFT(340.5)).toBe("341 ms");
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1])(
    "returns the unavailable marker for invalid TTFT %s",
    (value) => {
      expect(formatTTFT(value)).toBe("-- ms");
    }
  );
});
