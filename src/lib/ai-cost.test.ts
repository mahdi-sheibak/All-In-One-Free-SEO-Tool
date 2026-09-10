/**
 * Cost-path tests for custom providers (tasks 5.2).
 *
 * Custom `custom:<slug>` providers flow their free-text model id
 * straight into logAiCall → costMicros. That id will never be in the
 * published preset table (the user typed it), so the cost path MUST
 * fall back to the estimated rate rather than crashing or charging $0.
 * These tests pin that contract.
 */
import { describe, expect, it } from "vitest";
import {
  costMicros,
  isEstimatedRate,
  microsToDisplay,
  rateFor,
} from "./ai-cost";

describe("rateFor — custom / unknown model ids", () => {
  it("unknown model gets the mid-range estimate ($1 in / $4 out)", () => {
    // A user-typed model id like "qwen2.5-7b-instruct" is never in the
    // preset table — the fallback is the whole point.
    const r = rateFor("qwen2.5-7b-instruct");
    expect(r).toEqual({ inputPer1M: 1, outputPer1M: 4 });
  });

  it("null/undefined/empty model gets the same estimate", () => {
    expect(rateFor(null)).toEqual({ inputPer1M: 1, outputPer1M: 4 });
    expect(rateFor(undefined)).toEqual({ inputPer1M: 1, outputPer1M: 4 });
    expect(rateFor("")).toEqual({ inputPer1M: 1, outputPer1M: 4 });
  });

  it("known catalog model returns its published rates (not the estimate)", () => {
    // gemini-2.0-flash is the actual Gemini fallback model — its rates
    // must come from the preset, not the generic guess.
    const r = rateFor("gemini-2.0-flash");
    expect(r.inputPer1M).toBeGreaterThan(0);
    expect(r).not.toEqual({ inputPer1M: 1, outputPer1M: 4 });
  });
});

describe("isEstimatedRate — the '~' flag for the usage UI", () => {
  it("custom-typed model id is an estimate", () => {
    expect(isEstimatedRate("my-local-model")).toBe(true);
  });

  it("missing model id is an estimate", () => {
    expect(isEstimatedRate(null)).toBe(true);
    expect(isEstimatedRate(undefined)).toBe(true);
    expect(isEstimatedRate("")).toBe(true);
  });

  it("catalog model is NOT an estimate", () => {
    expect(isEstimatedRate("llama-3.3-70b-versatile")).toBe(false);
  });
});

describe("costMicros — estimate path math", () => {
  it("custom model: 10k in / 5k out at $1/$4 per 1M = $0.03 = 30000 micros", () => {
    // 10_000 * 1 / 1_000_000 = $0.01 in; 5_000 * 4 / 1_000_000 = $0.02 out.
    expect(costMicros("qwen2.5-7b-instruct", 10_000, 5_000)).toBe(30_000);
  });

  it("null model bills at the estimate instead of silently charging $0", () => {
    expect(costMicros(null, 1_000_000, 0)).toBe(1_000_000);
  });
});

describe("microsToDisplay — estimate presentation", () => {
  it("zero renders as $0; sub-cent renders as <$0.01", () => {
    expect(microsToDisplay(0)).toBe("$0");
    expect(microsToDisplay(5_000)).toBe("<$0.01");
  });

  it("sub-dollar and dollar values keep enough precision to audit", () => {
    expect(microsToDisplay(30_000)).toBe("$0.030");
    expect(microsToDisplay(1_500_000)).toBe("$1.50");
  });
});
