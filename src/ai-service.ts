// Centralized so the model can change later without touching business logic.
export const AI_TEXT_MODEL = "@cf/meta/llama-3.2-1b-instruct";

const DEFAULT_TIMEOUT_MS = 10_000;
const SMOKE_TEST_MARKER = "REELHAUS_AI_OK";
const SMOKE_TEST_MESSAGES: AiChatMessage[] = [
  {
    role: "system",
    content: `You are a deterministic health-check responder. Reply with exactly "${SMOKE_TEST_MARKER}" and nothing else: no punctuation, no quotes, no explanation, no extra words.`
  },
  {
    role: "user",
    content: "Return the health-check token."
  }
];
const SMOKE_TEST_OPTIONS: AiChatOptions = { temperature: 0, maxTokens: 10 };

export interface WorkersAiBinding {
  run(
    model: string,
    inputs: Record<string, unknown>,
    options?: { signal?: AbortSignal }
  ): Promise<unknown>;
}

export interface AiChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiChatOptions {
  temperature?: number;
  maxTokens?: number;
}

export interface AiTextPromptResult {
  model: string;
  response: string;
}

export interface AiHealthResult {
  ok: boolean;
  provider: "cloudflare-workers-ai";
  model: string;
  response?: string;
  error?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function normalizeAiTextOutput(output: unknown): string {
  if (typeof output === "string") return output.trim();
  if (
    output &&
    typeof output === "object" &&
    "response" in output &&
    typeof (output as { response: unknown }).response === "string"
  )
    return (output as { response: string }).response.trim();
  throw new Error("Unexpected Workers AI response shape");
}

export class WorkersAiService {
  constructor(
    private readonly ai: WorkersAiBinding | undefined,
    private readonly model: string = AI_TEXT_MODEL
  ) {}

  private async execute(
    inputs: Record<string, unknown>,
    timeoutMs: number
  ): Promise<AiTextPromptResult> {
    if (!this.ai) throw new Error("Workers AI binding is not configured");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const output = await this.ai.run(this.model, inputs, {
        signal: controller.signal
      });
      return { model: this.model, response: normalizeAiTextOutput(output) };
    } catch (error) {
      throw new Error(`Workers AI request failed: ${errorMessage(error)}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  async runTextPrompt(
    prompt: string,
    timeoutMs = DEFAULT_TIMEOUT_MS
  ): Promise<AiTextPromptResult> {
    return this.execute({ prompt }, timeoutMs);
  }

  async runChatPrompt(
    messages: AiChatMessage[],
    options: AiChatOptions = {},
    timeoutMs = DEFAULT_TIMEOUT_MS
  ): Promise<AiTextPromptResult> {
    return this.execute(
      {
        messages,
        temperature: options.temperature,
        max_tokens: options.maxTokens
      },
      timeoutMs
    );
  }
}

export async function checkAiHealth(
  ai: WorkersAiBinding | undefined,
  model: string = AI_TEXT_MODEL
): Promise<AiHealthResult> {
  try {
    const result = await new WorkersAiService(ai, model).runChatPrompt(
      SMOKE_TEST_MESSAGES,
      SMOKE_TEST_OPTIONS
    );
    const normalized = result.response.trim();
    return {
      ok: normalized === SMOKE_TEST_MARKER,
      provider: "cloudflare-workers-ai",
      model,
      response: normalized
    };
  } catch (error) {
    return {
      ok: false,
      provider: "cloudflare-workers-ai",
      model,
      error: errorMessage(error)
    };
  }
}
