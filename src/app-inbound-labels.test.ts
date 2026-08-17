// Pure-function regression coverage for the Manager UI's inbound-request
// status/link labels (app.tsx). The dashboard is one large, auth-gated
// React component with no existing component-test harness in this repo
// (no jsdom/testing-library dependency, vitest.config.ts runs a plain
// Node environment) — rather than bolt on a new rendering pipeline for one
// small addition, the human-readable label mapping (the part explicitly
// required to stay readable: "Needs target review", "Scanning", "Needs
// review", "Analysis failed", "Received / waiting") is exported and
// tested directly. The rendered view was also manually verified against a
// local dev server — see the Task #5A-fix completion report.
import { describe, expect, it } from "vitest";
import { inboundLinkLabel, inboundStatusLabel } from "./app";
import { REQUEST_STATUSES } from "./public-intake-store";
import type { SubmittedLinkKind } from "./link-classifier";

describe("inboundStatusLabel", () => {
  it("has a distinct, human-readable label for every request status", () => {
    const labels = REQUEST_STATUSES.map((status) => inboundStatusLabel(status));
    expect(new Set(labels).size).toBe(REQUEST_STATUSES.length);
    expect(labels.every((label) => /^[A-Z]/.test(label))).toBe(true);
  });

  it("marks a completed scan as Needs Review, never as approved", () => {
    const label = inboundStatusLabel("scan_ready_needs_review");
    expect(label).toBe("Needs review");
    expect(label.toLowerCase()).not.toContain("approved");
  });

  it("labels the other lifecycle states as documented", () => {
    expect(inboundStatusLabel("received")).toBe("Received / waiting");
    expect(inboundStatusLabel("needs_target_review")).toBe(
      "Needs target review"
    );
    expect(inboundStatusLabel("scanning")).toBe("Scanning");
    expect(inboundStatusLabel("analysis_failed")).toBe("Analysis failed");
  });
});

describe("inboundLinkLabel", () => {
  const kinds: SubmittedLinkKind[] = [
    "website",
    "instagram",
    "google_maps",
    "other_reference",
    "none"
  ];

  it("has a label for every submitted-link kind", () => {
    for (const kind of kinds) expect(inboundLinkLabel(kind)).toBeTruthy();
  });
});
