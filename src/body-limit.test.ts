import { describe, expect, it } from "vitest";
import { readPublicRequestBody } from "./body-limit";

function jsonRequest(body: string, headers: Record<string, string> = {}) {
  return new Request("https://reelhaus-manager.example/api/public/reelscan", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body
  });
}

describe("readPublicRequestBody", () => {
  it("accepts a small JSON body", async () => {
    const request = jsonRequest('{"a":1}');
    const result = await readPublicRequestBody(request, 1024);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toBe('{"a":1}');
  });

  it("rejects the wrong content type", async () => {
    const request = new Request("https://reelhaus-manager.example/api/public/reelscan", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello"
    });
    const result = await readPublicRequestBody(request, 1024);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("wrong_content_type");
  });

  it("rejects an oversized declared Content-Length immediately", async () => {
    const request = jsonRequest('{"a":1}', { "content-length": "999999" });
    const result = await readPublicRequestBody(request, 1024);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("content_length_too_large");
  });

  it("enforces the cap against actual streamed bytes, even without a Content-Length header", async () => {
    // Requests built with a plain string body typically get an automatic
    // Content-Length; force a stream-based body instead so none is set,
    // proving the byte-count enforcement doesn't depend on the header.
    const bigPayload = `{"a":"${"x".repeat(5000)}"}`;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(bigPayload));
        controller.close();
      }
    });
    const request = new Request(
      "https://reelhaus-manager.example/api/public/reelscan",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        // @ts-expect-error - duplex is required by the runtime for streaming bodies
        duplex: "half",
        body: stream
      }
    );
    expect(request.headers.get("content-length")).toBeNull();
    const result = await readPublicRequestBody(request, 1024);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("body_too_large");
  });

  it("rejects an empty body", async () => {
    const request = new Request(
      "https://reelhaus-manager.example/api/public/reelscan",
      {
        method: "POST",
        headers: { "content-type": "application/json" }
      }
    );
    const result = await readPublicRequestBody(request, 1024);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("empty_body");
  });

  it("uses the centralized default limit when none is supplied", async () => {
    const request = jsonRequest(`{"a":"${"x".repeat(20_000)}"}`);
    const result = await readPublicRequestBody(request);
    expect(result.ok).toBe(false);
  });
});
