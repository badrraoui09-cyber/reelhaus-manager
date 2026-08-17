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
  /**
   * Best-effort request for constrained output (e.g. `{ type: "json_object" }`).
   * Not every model enforces this — callers that need guaranteed structure
   * must still validate the parsed response themselves.
   */
  responseFormat?: { type: string; json_schema?: unknown };
}

export interface AiTextPromptResult {
  model: string;
  response: string;
}

export interface AiStructuredPromptResult {
  model: string;
  /** Whatever the model returned: a JSON string, or an already-parsed object/array. */
  response: unknown;
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

// Task #1's text path — unchanged. Requires `.response` to be a string and
// rejects anything else, including a structured object, rather than
// silently coercing it.
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

// Structured (JSON Mode) path — Workers AI can return `.response` as either
// a JSON string or an already-parsed object/array, depending on the model
// and response_format. Extracted as-is; never stringified-and-reparsed.
function normalizeAiStructuredOutput(output: unknown): unknown {
  if (typeof output === "string") return output;
  if (output && typeof output === "object" && "response" in output) {
    const response = (output as { response: unknown }).response;
    if (
      typeof response === "string" ||
      (response !== null && typeof response === "object")
    )
      return response;
  }
  throw new Error("Unexpected Workers AI response shape");
}

export class WorkersAiService {
  constructor(
    private readonly ai: WorkersAiBinding | undefined,
    private readonly model: string = AI_TEXT_MODEL
  ) {}

  private async run(
    inputs: Record<string, unknown>,
    timeoutMs: number
  ): Promise<unknown> {
    if (!this.ai) throw new Error("Workers AI binding is not configured");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.ai.run(this.model, inputs, {
        signal: controller.signal
      });
    } catch (error) {
      throw new Error(`Workers AI request failed: ${errorMessage(error)}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async execute(
    inputs: Record<string, unknown>,
    timeoutMs: number
  ): Promise<AiTextPromptResult> {
    const output = await this.run(inputs, timeoutMs);
    return { model: this.model, response: normalizeAiTextOutput(output) };
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
        max_tokens: options.maxTokens,
        response_format: options.responseFormat
      },
      timeoutMs
    );
  }

  /**
   * For callers that requested structured/JSON-mode output and need the
   * raw parsed value (string or object) rather than a coerced string.
   * Callers remain responsible for validating the shape themselves —
   * provider-side JSON Schema is best-effort, not a guarantee.
   */
  async runStructuredPrompt(
    messages: AiChatMessage[],
    options: AiChatOptions = {},
    timeoutMs = DEFAULT_TIMEOUT_MS
  ): Promise<AiStructuredPromptResult> {
    const output = await this.run(
      {
        messages,
        temperature: options.temperature,
        max_tokens: options.maxTokens,
        response_format: options.responseFormat
      },
      timeoutMs
    );
    return { model: this.model, response: normalizeAiStructuredOutput(output) };
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
