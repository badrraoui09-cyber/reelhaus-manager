import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["validation/gastronomy-pilot-2.test.ts"],
    reporters: ["verbose"]
  }
});
