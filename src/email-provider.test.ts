import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GmailEmailProvider,
  MockEmailProvider,
  draftHasRequiredOptOut
} from "./email-provider";

afterEach(() => vi.restoreAllMocks());

describe("email providers", () => {
  it("uses a mock provider without network or real email", async () => {
    const provider = new MockEmailProvider();
    const draft = await provider.createDraft({
      to: "public@example.ma",
      subject: "Test",
      body: "Test"
    });
    expect(draft.draftId).toMatch(/^mock-draft-/);
    expect((await provider.sendDraft(draft.draftId)).provider).toBe("mock");
  });

  it("rejects incomplete Gmail secrets before sending", async () => {
    const provider = new GmailEmailProvider({});
    await expect(
      provider.createDraft({ to: "public@example.ma", subject: "Test", body: "Test" })
    ).rejects.toThrow("incomplete");
  });

  it("surfaces Gmail API failures without logging message content", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: "temporary" }), { status: 200 })
        )
        .mockResolvedValueOnce(new Response("error", { status: 503 }))
    );
    const provider = new GmailEmailProvider({
      GMAIL_CLIENT_ID: "id",
      GMAIL_CLIENT_SECRET: "secret",
      GMAIL_REFRESH_TOKEN: "refresh"
    });
    await expect(
      provider.createDraft({ to: "public@example.ma", subject: "Test", body: "Test" })
    ).rejects.toThrow("HTTP 503");
  });

  it("requires a polite opt-out", () => {
    expect(
      draftHasRequiredOptOut({
        body: "Répondez si vous préférez ne plus recevoir de message."
      })
    ).toBe(true);
    expect(draftHasRequiredOptOut({ body: "Achetez maintenant." })).toBe(false);
  });
});
