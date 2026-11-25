import { describe, it, expect } from "vitest";
import { calculateBackoff, computeNextRunAt } from "../src/lib/backoff.js";

describe("T2-R11: Exponential Backoff & Jitter Calculation", () => {
  const baseMs = 1000;
  const capMs = 30000;
  const jitterMs = 500;

  it("calculates exponential delays growing with attempt number", () => {
    // With 0 jitter for deterministic exponential check
    const delay0 = calculateBackoff(0, baseMs, capMs, 0);
    const delay1 = calculateBackoff(1, baseMs, capMs, 0);
    const delay2 = calculateBackoff(2, baseMs, capMs, 0);
    const delay3 = calculateBackoff(3, baseMs, capMs, 0);

    expect(delay0).toBe(1000);  // 1000 * 2^0
    expect(delay1).toBe(2000);  // 1000 * 2^1
    expect(delay2).toBe(4000);  // 1000 * 2^2
    expect(delay3).toBe(8000);  // 1000 * 2^3
  });

  it("strictly caps maximum delay to capMs (+ jitter)", () => {
    const hugeAttemptDelay = calculateBackoff(20, baseMs, capMs, 0);
    expect(hugeAttemptDelay).toBe(capMs);

    const hugeAttemptWithJitter = calculateBackoff(20, baseMs, capMs, jitterMs);
    expect(hugeAttemptWithJitter).toBeGreaterThanOrEqual(capMs);
    expect(hugeAttemptWithJitter).toBeLessThanOrEqual(capMs + jitterMs);
  });

  it("adds non-negative random jitter up to jitterMs", () => {
    for (let i = 0; i < 50; i++) {
      const delay = calculateBackoff(1, baseMs, capMs, jitterMs);
      const baseExpected = 2000;
      expect(delay).toBeGreaterThanOrEqual(baseExpected);
      expect(delay).toBeLessThanOrEqual(baseExpected + jitterMs);
    }
  });

  it("computes a valid future Date object for nextRunAt", () => {
    const before = Date.now();
    const nextRun = computeNextRunAt(2, baseMs, capMs, jitterMs);
    const after = Date.now();

    expect(nextRun).toBeInstanceOf(Date);
    expect(nextRun.getTime()).toBeGreaterThanOrEqual(before + 4000);
    expect(nextRun.getTime()).toBeLessThanOrEqual(after + 4000 + jitterMs);
  });
});
