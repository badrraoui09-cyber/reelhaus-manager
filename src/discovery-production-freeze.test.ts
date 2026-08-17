import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Task #6B0: autonomous OSM/Wikidata candidate collection must stay off
// while Step #6 privacy/legal hardening is incomplete. sales-agent.ts's
// runDiscovery() gates the entire OSM+Wikidata research block on exactly
// this env var (`this.env.DISCOVERY_OSM_ENABLED === "true"`), so flipping
// it to "false" in the deployed config is sufficient to stop that path —
// this test guards against it silently drifting back to "true".
describe("Discovery production freeze", () => {
  it("keeps DISCOVERY_OSM_ENABLED off in the deployed wrangler config", () => {
    const wranglerConfig = JSON.parse(
      readFileSync(resolve(__dirname, "../wrangler.jsonc"), "utf8")
    ) as { vars?: Record<string, string> };
    expect(wranglerConfig.vars?.DISCOVERY_OSM_ENABLED).toBe("false");
  });
});
