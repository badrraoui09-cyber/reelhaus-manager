import { describe, expect, it } from "vitest";
import {
  AI_TEXT_MODEL,
  WorkersAiService,
  checkAiHealth,
  type WorkersAiBinding
} from "./ai-service";

const REELSCAN_TEST_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

function fakeAi(run: WorkersAiBinding["run"]): WorkersAiBinding {
  return { run };
}

describe("WorkersAiService", () => {
  it("normalizes a successful text generation call", async () => {
    const ai = fakeAi(async (model, inputs) => {
      expect(model).toBe(AI_TEXT_MODEL);
      expect(inputs).toEqual({ prompt: "hello" });
      return { response: " REELHAUS_AI_OK " };
    });
    const result = await new WorkersAiService(ai).runTextPrompt("hello");
    expect(result).toEqual({ model: AI_TEXT_MODEL, response: "REELHAUS_AI_OK" });
  });

  it("accepts a bare string output", async () => {
    const ai = fakeAi(async () => "plain string reply");
    const result = await new WorkersAiService(ai).runTextPrompt("hello");
    expect(result.response).toBe("plain string reply");
  });

  it("sends scoped chat messages with low-randomness options", async () => {
    const ai = fakeAi(async (model, inputs) => {
      expect(model).toBe(AI_TEXT_MODEL);
      expect(inputs.messages).toEqual([
        { role: "system", content: "be terse" },
        { role: "user", content: "say hi" }
      ]);
      expect(inputs.temperature).toBe(0);
      expect(inputs.max_tokens).toBe(10);
      return { response: "hi" };
    });
    const result = await new WorkersAiService(ai).runChatPrompt(
      [
        { role: "system", content: "be terse" },
        { role: "user", content: "say hi" }
      ],
      { temperature: 0, maxTokens: 10 }
    );
    expect(result.response).toBe("hi");
  });

  it("rejects when no binding is configured", async () => {
    await expect(
      new WorkersAiService(undefined).runTextPrompt("hello")
    ).rejects.toThrow("not configured");
  });

  it("wraps binding failures without leaking internals", async () => {
    const ai = fakeAi(async () => {
      throw new Error("upstream rate limited");
    });
    await expect(new WorkersAiService(ai).runTextPrompt("hello")).rejects.toThrow(
      "Workers AI request failed: upstream rate limited"
    );
  });

  it("rejects an unexpected response shape", async () => {
    const ai = fakeAi(async () => ({ unexpected: true }));
    await expect(new WorkersAiService(ai).runTextPrompt("hello")).rejects.toThrow(
      "Unexpected Workers AI response shape"
    );
  });

  it("rejects a structured object response on the text path instead of coercing it", async () => {
    // This is exactly the real Client #0 failure: Workers AI's JSON Mode can
    // return `.response` as an object. The text path must still reject it,
    // not silently stringify/coerce it.
    const ai = fakeAi(async () => ({ response: { findings: [] } }));
    await expect(
      new WorkersAiService(ai, REELSCAN_TEST_MODEL).runChatPrompt([
        { role: "user", content: "hi" }
      ])
    ).rejects.toThrow("Unexpected Workers AI response shape");
  });
});

describe("WorkersAiService.runStructuredPrompt", () => {
  it("accepts a structured object response (Workers AI JSON Schema mode)", async () => {
    const ai = fakeAi(async () => ({ response: { findings: [] } }));
    const result = await new WorkersAiService(
      ai,
      REELSCAN_TEST_MODEL
    ).runStructuredPrompt([{ role: "user", content: "hi" }]);
    expect(result.response).toEqual({ findings: [] });
  });

  it("accepts a JSON string response without stringifying/reparsing an object", async () => {
    const ai = fakeAi(async () => ({ response: '{"findings":[]}' }));
    const result = await new WorkersAiService(
      ai,
      REELSCAN_TEST_MODEL
    ).runStructuredPrompt([{ role: "user", content: "hi" }]);
    expect(result.response).toBe('{"findings":[]}');
  });

  it("sends the requested json_schema response_format", async () => {
    const schema = { type: "object", properties: {}, required: [] };
    const ai = fakeAi(async (_model, inputs) => {
      expect(inputs.response_format).toEqual({
        type: "json_schema",
        json_schema: schema
      });
      return { response: { findings: [] } };
    });
    await new WorkersAiService(ai, REELSCAN_TEST_MODEL).runStructuredPrompt(
      [{ role: "user", content: "hi" }],
      { responseFormat: { type: "json_schema", json_schema: schema } }
    );
  });

  it("still rejects a genuinely unexpected response shape", async () => {
    const ai = fakeAi(async () => ({ unexpected: true }));
    await expect(
      new WorkersAiService(ai, REELSCAN_TEST_MODEL).runStructuredPrompt([
        { role: "user", content: "hi" }
      ])
    ).rejects.toThrow("Unexpected Workers AI response shape");
  });
});

describe("checkAiHealth", () => {
  it("reports ok on an exact sentinel response", async () => {
    const ai = fakeAi(async () => ({ response: "REELHAUS_AI_OK" }));
    const health = await checkAiHealth(ai);
    expect(health).toEqual({
      ok: true,
      provider: "cloudflare-workers-ai",
      model: AI_TEXT_MODEL,
      response: "REELHAUS_AI_OK"
    });
  });

  it("reports ok when the sentinel has surrounding whitespace", async () => {
    const ai = fakeAi(async () => ({ response: "  REELHAUS_AI_OK\n" }));
    const health = await checkAiHealth(ai);
    expect(health.ok).toBe(true);
    expect(health.response).toBe("REELHAUS_AI_OK");
  });

  it("reports ok:false on an unexpected model response instead of accepting any text", async () => {
    const ai = fakeAi(async () => ({
      response: "What can I assist you with today?"
    }));
    const health = await checkAiHealth(ai);
    expect(health.ok).toBe(false);
    expect(health.response).toBe("What can I assist you with today?");
  });

  it("reports ok:false when the sentinel is only a substring of a longer reply", async () => {
    const ai = fakeAi(async () => ({
      response: "Sure! REELHAUS_AI_OK is the token you asked for."
    }));
    const health = await checkAiHealth(ai);
    expect(health.ok).toBe(false);
  });

  it("returns a safe structured error when the binding is missing", async () => {
    const health = await checkAiHealth(undefined);
    expect(health).toEqual({
      ok: false,
      provider: "cloudflare-workers-ai",
      model: AI_TEXT_MODEL,
      error: "Workers AI binding is not configured"
    });
  });

  it("returns a safe structured error when the AI call fails", async () => {
    const ai = fakeAi(async () => {
      throw new Error("network unreachable");
    });
    const health = await checkAiHealth(ai);
    expect(health.ok).toBe(false);
    expect(health.error).toBe(
      "Workers AI request failed: network unreachable"
    );
    expect(health.response).toBeUndefined();
  });

  it("sends the scoped system/user messages and deterministic options", async () => {
    const ai = fakeAi(async (model, inputs) => {
      expect(model).toBe(AI_TEXT_MODEL);
      const messages = inputs.messages as Array<{
        role: string;
        content: string;
      }>;
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe("system");
      expect(messages[0].content).toContain("REELHAUS_AI_OK");
      expect(messages[1].role).toBe("user");
      expect(inputs.temperature).toBe(0);
      expect(typeof inputs.max_tokens).toBe("number");
      return { response: "REELHAUS_AI_OK" };
    });
    const health = await checkAiHealth(ai);
    expect(health.ok).toBe(true);
  });
});
