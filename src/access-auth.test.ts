import { afterEach, describe, expect, it, vi } from "vitest";
import {
  accessDiagnostic,
  validateCloudflareAccess
} from "./access-auth";

const configured = {
  CF_ACCESS_TEAM_DOMAIN: "https://reelhaus-test.cloudflareaccess.com",
  CF_ACCESS_AUD: "test-audience"
};

function encode(value: unknown): string {
  return btoa(JSON.stringify(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function requestWithToken(token?: string): Request {
  return new Request("https://example.com/api/sales", {
    headers: token ? { "cf-access-jwt-assertion": token } : undefined
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Cloudflare Access authentication", () => {
  it("distinguishes missing configuration from a missing JWT", async () => {
    await expect(validateCloudflareAccess(requestWithToken(), {})).resolves.toEqual(
      { status: "not_configured" }
    );
    await expect(
      validateCloudflareAccess(requestWithToken(), configured)
    ).resolves.toEqual({ status: "missing_jwt" });
  });

  it("rejects malformed or invalid JWTs", async () => {
    await expect(
      validateCloudflareAccess(requestWithToken("not-a-jwt"), configured)
    ).resolves.toEqual({ status: "rejected" });

    const invalid = `${encode({ alg: "none", kid: "test" })}.${encode({
      email: "owner@example.com"
    })}.signature`;
    await expect(
      validateCloudflareAccess(requestWithToken(invalid), configured)
    ).resolves.toEqual({ status: "rejected" });
  });

  it("accepts a correctly signed JWT for the configured application", async () => {
    const keys = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256"
      },
      true,
      ["sign", "verify"]
    );
    const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
    const header = encode({ alg: "RS256", kid: "test-key" });
    const payload = encode({
      aud: configured.CF_ACCESS_AUD,
      email: "owner@example.com",
      exp: Math.floor(Date.now() / 1000) + 300,
      iss: configured.CF_ACCESS_TEAM_DOMAIN
    });
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        keys.privateKey,
        new TextEncoder().encode(`${header}.${payload}`)
      )
    );
    const encodedSignature = btoa(String.fromCharCode(...signature))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ keys: [{ ...publicKey, kid: "test-key" }] })
    );

    await expect(
      validateCloudflareAccess(
        requestWithToken(`${header}.${payload}.${encodedSignature}`),
        configured
      )
    ).resolves.toEqual({
      status: "authenticated",
      identity: "owner@example.com"
    });
  });

  it("returns only the approved diagnostic fields", () => {
    const diagnostic = accessDiagnostic(requestWithToken("present"), {
      ...configured,
      EMAIL_MODE: "mock",
      OUTREACH_ENABLED: "false"
    });

    expect(diagnostic).toEqual({
      accessConfigured: true,
      accessJwtPresent: true,
      emailMode: "mock",
      outreachEnabled: false
    });
    expect(Object.keys(diagnostic).sort()).toEqual([
      "accessConfigured",
      "accessJwtPresent",
      "emailMode",
      "outreachEnabled"
    ]);
  });
});
