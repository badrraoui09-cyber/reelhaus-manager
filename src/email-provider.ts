import type { EmailDraft } from "./sales-types";

export interface SendableEmail {
  to: string;
  subject: string;
  body: string;
  threadId?: string | null;
}

export interface EmailDelivery {
  provider: "mock" | "gmail";
  messageId: string;
  threadId: string | null;
  sentAt: string;
}

export interface EmailProvider {
  createDraft(message: SendableEmail): Promise<{
    draftId: string;
    threadId: string | null;
  }>;
  sendDraft(draftId: string): Promise<EmailDelivery>;
}

export class MockEmailProvider implements EmailProvider {
  async createDraft(_message: SendableEmail) {
    return {
      draftId: `mock-draft-${crypto.randomUUID()}`,
      threadId: null
    };
  }

  async sendDraft(draftId: string): Promise<EmailDelivery> {
    return {
      provider: "mock",
      messageId: `mock-message-${draftId}`,
      threadId: null,
      sentAt: new Date().toISOString()
    };
  }
}

interface GmailSecrets {
  GMAIL_CLIENT_ID?: string;
  GMAIL_CLIENT_SECRET?: string;
  GMAIL_REFRESH_TOKEN?: string;
}

function base64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function cleanHeader(value: string): string {
  return value.replace(/[\r\n]/g, " ").trim();
}

export class GmailEmailProvider implements EmailProvider {
  private readonly secrets: GmailSecrets;

  constructor(secrets: GmailSecrets) {
    this.secrets = secrets;
  }

  private async accessToken(): Promise<string> {
    const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } =
      this.secrets;
    if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
      throw new Error("Gmail OAuth secrets are incomplete");
    }
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GMAIL_CLIENT_ID,
        client_secret: GMAIL_CLIENT_SECRET,
        refresh_token: GMAIL_REFRESH_TOKEN,
        grant_type: "refresh_token"
      })
    });
    if (!response.ok) {
      throw new Error(`Gmail OAuth token exchange failed: HTTP ${response.status}`);
    }
    const payload = (await response.json()) as { access_token?: string };
    if (!payload.access_token) throw new Error("Gmail OAuth returned no access token");
    return payload.access_token;
  }

  async createDraft(message: SendableEmail) {
    const token = await this.accessToken();
    const mime = [
      `To: ${cleanHeader(message.to)}`,
      `Subject: ${cleanHeader(message.subject)}`,
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      message.body
    ].join("\r\n");
    const response = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/drafts",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          message: {
            raw: base64Url(mime),
            ...(message.threadId ? { threadId: message.threadId } : {})
          }
        })
      }
    );
    if (!response.ok) {
      throw new Error(`Gmail draft creation failed: HTTP ${response.status}`);
    }
    const payload = (await response.json()) as {
      id?: string;
      message?: { threadId?: string };
    };
    if (!payload.id) throw new Error("Gmail returned no draft id");
    return {
      draftId: payload.id,
      threadId: payload.message?.threadId || null
    };
  }

  async sendDraft(draftId: string): Promise<EmailDelivery> {
    const token = await this.accessToken();
    const response = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/drafts/send",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ id: draftId })
      }
    );
    if (!response.ok) {
      throw new Error(`Gmail draft send failed: HTTP ${response.status}`);
    }
    const payload = (await response.json()) as { id?: string; threadId?: string };
    if (!payload.id) throw new Error("Gmail returned no sent message id");
    return {
      provider: "gmail",
      messageId: payload.id,
      threadId: payload.threadId || null,
      sentAt: new Date().toISOString()
    };
  }
}

export function selectEmailProvider(
  mode: string | undefined,
  secrets: GmailSecrets
): EmailProvider {
  return mode === "gmail"
    ? new GmailEmailProvider(secrets)
    : new MockEmailProvider();
}

export function draftHasRequiredOptOut(draft: Pick<EmailDraft, "body">): boolean {
  const body = draft.body.toLowerCase();
  return (
    body.includes("ne plus recevoir") ||
    body.includes("aucun autre message") ||
    body.includes("عدم تلقي") ||
    body.includes("عدم التواصل")
  );
}
