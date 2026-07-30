import { describe, expect, it } from "vitest";
import { summarizeFindings, type Finding } from "./website-analysis";

describe("summarizeFindings", () => {
  it("groups findings by severity", () => {
    const base = {
      category: "seo",
      page: "https://reelhaus.de/fr/",
      title: "Test",
      detail: "Test",
      evidence: "verified"
    } satisfies Omit<Finding, "severity">;

    expect(
      summarizeFindings([
        { ...base, severity: "critical" },
        { ...base, severity: "important" },
        { ...base, severity: "important" },
        { ...base, severity: "optional" }
      ])
    ).toEqual({ critical: 1, important: 2, optional: 1 });
  });

  it("returns zeroes for an empty report", () => {
    expect(summarizeFindings([])).toEqual({
      critical: 0,
      important: 0,
      optional: 0
    });
  });
});
