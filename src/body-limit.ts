// Application-level request body cap for the public ReelScan intake,
// enforced BEFORE JSON.parse — Cloudflare's platform-level request body
// limit is not relied on here (it exists for a different purpose and is
// far larger than this tiny payload needs to be).
import { MAX_PUBLIC_BODY_BYTES } from "./public-intake-config";

export type BodyLimitRejectionReason =
  | "wrong_content_type"
  | "content_length_too_large"
  | "body_too_large"
  | "empty_body";

export type BodyLimitResult =
  | { ok: true; text: string }
  | { ok: false; reason: BodyLimitRejectionReason };

const REQUIRED_CONTENT_TYPE = "application/json";

/**
 * Reads a Request's body as text, enforcing both a Content-Length
 * pre-check AND a running total against the actual bytes streamed — a
 * missing or dishonest Content-Length header cannot bypass the cap, the
 * same defense-in-depth safe-fetch.ts already applies to fetched target
 * content.
 */
export async function readPublicRequestBody(
  request: Request,
  maxBytes: number = MAX_PUBLIC_BODY_BYTES
): Promise<BodyLimitResult> {
  const contentType = (request.headers.get("content-type") || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (contentType !== REQUIRED_CONTENT_TYPE)
    return { ok: false, reason: "wrong_content_type" };

  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > maxBytes)
    return { ok: false, reason: "content_length_too_large" };

  if (!request.body) return { ok: false, reason: "empty_body" };
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return { ok: false, reason: "body_too_large" };
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();

  if (!text.trim()) return { ok: false, reason: "empty_body" };
  return { ok: true, text };
}
