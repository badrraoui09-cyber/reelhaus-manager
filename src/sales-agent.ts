import { Agent } from "agents";
import { analyzePublicBusinessWebsite } from "./browser-analysis";
import {
  draftHasRequiredOptOut,
  selectEmailProvider
} from "./email-provider";
import {
  calculateLeadScore,
  approvalIsUsable,
  canContact,
  canTransition,
  followUpAllowed,
  leadDedupeKey,
  normalizeEmail,
  normalizeUrl
} from "./sales-policy";
import {
  LEAD_CATEGORIES,
  LEAD_STATUSES,
  type EmailDraft,
  type Lead,
  type LeadInput,
  type LeadStatus,
  type ObservedIssue,
  type OutreachLanguage,
  type PublicWebsiteObservation
} from "./sales-types";
import type { AuditReport, ReportSummary } from "./website-analysis";
import { analyzeReelHaus } from "./website-analysis";

type SalesEnv = Env & {
  EMAIL_MODE?: "draft_only" | "mock" | "gmail";
  GMAIL_CLIENT_ID?: string;
  GMAIL_CLIENT_SECRET?: string;
  GMAIL_REFRESH_TOKEN?: string;
  MAX_DAILY_NEW_LEADS?: string;
  MAX_DAILY_SENDS?: string;
  MIN_FOLLOW_UP_DAYS?: string;
};

type SqlRow = Record<string, SqlStorageValue>;

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: JSON_HEADERS });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function boundedInt(value: string | undefined, fallback: number, max: number) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

function isPublicUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return false;
    const host = url.hostname.toLowerCase();
    return !(
      host === "localhost" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    );
  } catch {
    return false;
  }
}

function validateLeadInput(input: LeadInput): string | null {
  if (!input.businessName?.trim()) return "business_name is required";
  if (!LEAD_CATEGORIES.includes(input.category)) return "invalid category";
  if (!input.city?.trim()) return "city is required";
  if (input.country && input.country !== "MA") return "country must be MA";
  if (!input.sourceUrls?.length) return "at least one source URL is required";
  if (input.sourceUrls.some((url) => !isPublicUrl(url)))
    return "all source URLs must be public HTTP(S) URLs";
  if (input.websiteUrl && !isPublicUrl(input.websiteUrl))
    return "website_url must be a public HTTP(S) URL";
  if (input.mapsUrl && !isPublicUrl(input.mapsUrl))
    return "maps_url must be a public HTTP(S) URL";
  if (
    input.publicEmail &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(input.publicEmail))
  )
    return "public_email is invalid";
  return null;
}

function draftText(
  lead: Lead,
  language: OutreachLanguage,
  kind: EmailDraft["kind"]
): { subject: string; body: string } {
  const observation = lead.observedIssues.find((issue) => issue.verified)?.detail;
  if (!observation) {
    throw new Error("A verified observation is required before drafting outreach");
  }
  if (language === "ar") {
    const prefix =
      kind === "initial"
        ? `لاحظت أثناء مراجعة الحضور العام لـ ${lead.businessName}: ${observation}`
        : `أتابع رسالتي السابقة حول الحضور الرقمي لـ ${lead.businessName}.`;
    return {
      subject: `ملاحظة عملية حول حضور ${lead.businessName} على الإنترنت`,
      body: `${prefix}

أنا بدر من ReelHaus. نساعد المطاعم والمقاهي وأعمال الضيافة الصغيرة في المغرب على تحسين حضورها الرقمي بشكل عملي وواضح.

يمكن أن نبدأ بـ ReelScan: مراجعة محدودة ومنخفضة المخاطر للموقع وتجربة الهاتف ومعلومات التواصل، من دون أي التزام بتغييرات لاحقة.

إذا كان ذلك مناسباً، يسعدني إرسال التفاصيل. وإذا كنتم تفضلون عدم تلقي أي رسائل أخرى، يكفي الرد بذلك وسنوقف التواصل نهائياً.

مع التحية،
Badr
ReelHaus`
    };
  }
  const prefix =
    kind === "initial"
      ? `En consultant la présence publique de ${lead.businessName}, j’ai relevé un point concret : ${observation}`
      : `Je me permets un suivi au sujet de la présence numérique de ${lead.businessName}.`;
  return {
    subject: `Une observation concrète pour ${lead.businessName}`,
    body: `${prefix}

Je suis Badr de ReelHaus. Nous aidons les restaurants, cafés et petites structures d’hospitalité au Maroc à améliorer leur présence numérique de façon pratique.

Je vous propose de commencer par ReelScan : un diagnostic limité et sans risque de votre site, de l’expérience mobile et des informations de contact, sans engagement sur des changements.

Si cela vous semble utile, je peux vous transmettre les détails. Si vous préférez ne plus recevoir de message, répondez simplement en ce sens et nous arrêterons définitivement tout contact.

Bien cordialement,
Badr
ReelHaus`
  };
}

export class ReelHausManager extends Agent<SalesEnv, Record<string, never>> {
  constructor(ctx: DurableObjectState, env: SalesEnv) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
        summary_json TEXT NOT NULL, report_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS leads (
        id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE,
        business_name TEXT NOT NULL, category TEXT NOT NULL, city TEXT NOT NULL,
        country TEXT NOT NULL CHECK(country = 'MA'), website_url TEXT,
        maps_url TEXT, public_email TEXT, phone TEXT, whatsapp TEXT,
        discovered_at TEXT NOT NULL, source_urls_json TEXT NOT NULL,
        observed_issues_json TEXT NOT NULL, recommended_service TEXT,
        status TEXT NOT NULL, score INTEGER NOT NULL,
        score_reasons_json TEXT NOT NULL, language TEXT NOT NULL,
        last_contacted_at TEXT, next_follow_up_at TEXT,
        do_not_contact INTEGER NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS drafts (
        id TEXT PRIMARY KEY, lead_id TEXT NOT NULL, language TEXT NOT NULL,
        subject TEXT NOT NULL, body TEXT NOT NULL, kind TEXT NOT NULL,
        status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
        provider_draft_id TEXT, provider_thread_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY (lead_id) REFERENCES leads(id)
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY, draft_id TEXT NOT NULL UNIQUE,
        draft_version INTEGER NOT NULL, approved_by TEXT NOT NULL,
        approved_at TEXT NOT NULL, consumed_at TEXT,
        FOREIGN KEY (draft_id) REFERENCES drafts(id)
      );
      CREATE TABLE IF NOT EXISTS outreach_events (
        id TEXT PRIMARY KEY, lead_id TEXT NOT NULL, draft_id TEXT,
        event_type TEXT NOT NULL, occurred_at TEXT NOT NULL,
        provider_message_id TEXT, provider_thread_id TEXT, subject TEXT,
        approved_by TEXT, metadata_json TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY (lead_id) REFERENCES leads(id)
      );
      CREATE TABLE IF NOT EXISTS daily_usage (
        day TEXT PRIMARY KEY, new_leads INTEGER NOT NULL DEFAULT 0,
        sent_messages INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS discovery_queue (
        id TEXT PRIMARY KEY, input_json TEXT NOT NULL, queued_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued', error TEXT
      );
      CREATE INDEX IF NOT EXISTS leads_status ON leads(status);
      CREATE INDEX IF NOT EXISTS drafts_lead ON drafts(lead_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS events_lead ON outreach_events(lead_id, occurred_at);
    `);
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/scan")
        return await this.runGuardianScan();
      if (request.method === "GET" && url.pathname === "/reports")
        return this.listReports();
      if (request.method === "GET" && url.pathname.startsWith("/reports/"))
        return this.getReport(url.pathname.slice(9));
      if (request.method === "GET" && url.pathname === "/sales")
        return this.salesSnapshot();
      if (request.method === "POST" && url.pathname === "/discovery/queue")
        return await this.queueLead(request);
      if (request.method === "POST" && url.pathname === "/discovery/run")
        return await this.runDiscovery();
      if (request.method === "PATCH" && /^\/leads\/[^/]+$/.test(url.pathname))
        return await this.updateLead(url.pathname.split("/")[2], request);
      if (request.method === "POST" && /\/leads\/[^/]+\/draft$/.test(url.pathname))
        return await this.createDraft(url.pathname.split("/")[2], request);
      if (request.method === "POST" && /\/leads\/[^/]+\/events$/.test(url.pathname))
        return await this.recordInboundEvent(url.pathname.split("/")[2], request);
      if (
        request.method === "POST" &&
        /\/leads\/[^/]+\/do-not-contact$/.test(url.pathname)
      )
        return this.doNotContact(url.pathname.split("/")[2]);
      if (request.method === "PATCH" && /^\/drafts\/[^/]+$/.test(url.pathname))
        return await this.editDraft(url.pathname.split("/")[2], request);
      if (request.method === "POST" && /\/drafts\/[^/]+\/approve$/.test(url.pathname))
        return this.approveDraft(url.pathname.split("/")[2], request);
      if (request.method === "POST" && /\/drafts\/[^/]+\/reject$/.test(url.pathname))
        return this.rejectDraft(url.pathname.split("/")[2]);
      if (request.method === "POST" && /\/drafts\/[^/]+\/send$/.test(url.pathname))
        return await this.sendApprovedDraft(url.pathname.split("/")[2]);
      return json({ error: "Not found" }, 404);
    } catch (error) {
      console.error("ReelHaus Manager request failed", {
        method: request.method,
        path: url.pathname,
        error: message(error)
      });
      return json({ error: message(error) }, 500);
    }
  }

  private usage(day = new Date().toISOString().slice(0, 10)) {
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO daily_usage(day) VALUES (?)",
      day
    );
    return this.ctx.storage.sql
      .exec<{ new_leads: number; sent_messages: number }>(
        "SELECT new_leads, sent_messages FROM daily_usage WHERE day = ?",
        day
      )
      .one();
  }

  private async queueLead(request: Request) {
    const input = (await request.json()) as LeadInput;
    const validation = validateLeadInput(input);
    if (validation) return json({ error: validation }, 400);
    const id = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      "INSERT INTO discovery_queue(id, input_json, queued_at) VALUES (?, ?, ?)",
      id,
      JSON.stringify(input),
      new Date().toISOString()
    );
    return json({ id, status: "queued" }, 201);
  }

  private async runDiscovery() {
    const limit = boundedInt(this.env.MAX_DAILY_NEW_LEADS, 20, 100);
    const usage = this.usage();
    const remaining = Math.max(0, limit - usage.new_leads);
    if (!remaining) return json({ processed: 0, reason: "daily limit reached" });
    const queued = this.ctx.storage.sql
      .exec<{ id: string; input_json: string }>(
        "SELECT id, input_json FROM discovery_queue WHERE status = 'queued' ORDER BY queued_at LIMIT ?",
        remaining
      )
      .toArray();
    let created = 0;
    let duplicates = 0;
    let failed = 0;
    for (const item of queued) {
      try {
        const input = parseJson<LeadInput>(item.input_json);
        const result = await this.discoverLead(input);
        result.created ? created++ : duplicates++;
        this.ctx.storage.sql.exec(
          "UPDATE discovery_queue SET status = ? WHERE id = ?",
          result.created ? "completed" : "duplicate",
          item.id
        );
      } catch (error) {
        failed++;
        this.ctx.storage.sql.exec(
          "UPDATE discovery_queue SET status = 'failed', error = ? WHERE id = ?",
          message(error).slice(0, 500),
          item.id
        );
      }
    }
    console.log("Discovery batch completed", { created, duplicates, failed });
    return json({ processed: queued.length, created, duplicates, failed });
  }

  private async discoverLead(input: LeadInput) {
    const key = leadDedupeKey(input);
    const existing = this.ctx.storage.sql
      .exec<{ id: string }>("SELECT id FROM leads WHERE dedupe_key = ?", key)
      .toArray()[0];
    if (existing) return { created: false, id: existing.id };

    let observation: PublicWebsiteObservation | undefined;
    if (input.websiteUrl) {
      observation = await analyzePublicBusinessWebsite(
        this.env.BROWSER,
        input.websiteUrl
      );
    }
    const issues = [...(input.observedIssues || []), ...(observation?.issues || [])];
    const publicEmail =
      normalizeEmail(input.publicEmail) ||
      normalizeEmail(observation?.publicEmails[0]) ||
      null;
    const score = calculateLeadScore({
      websiteUrl: input.websiteUrl,
      publicEmail: publicEmail || undefined,
      category: input.category,
      city: input.city,
      issues
    });
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      `INSERT INTO leads (
        id, dedupe_key, business_name, category, city, country, website_url,
        maps_url, public_email, phone, whatsapp, discovered_at, source_urls_json,
        observed_issues_json, recommended_service, status, score,
        score_reasons_json, language, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'MA', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      key,
      input.businessName.trim(),
      input.category,
      input.city.trim(),
      normalizeUrl(input.websiteUrl) || null,
      normalizeUrl(input.mapsUrl) || observation?.mapsLinks[0] || null,
      publicEmail,
      input.phone || observation?.phones[0] || null,
      input.whatsapp || observation?.whatsappLinks[0] || null,
      now,
      JSON.stringify([...new Set([...input.sourceUrls, ...(observation ? [observation.sourceUrl] : [])])]),
      JSON.stringify(issues),
      input.recommendedService || "ReelScan",
      score.score >= 50 && publicEmail ? "qualified" : "discovered",
      score.score,
      JSON.stringify(score.reasons),
      input.language || "fr",
      input.notes || "",
      now,
      now
    );
    this.ctx.storage.sql.exec(
      "UPDATE daily_usage SET new_leads = new_leads + 1 WHERE day = ?",
      now.slice(0, 10)
    );
    return { created: true, id };
  }

  private salesSnapshot() {
    const leads = this.ctx.storage.sql
      .exec<SqlRow>("SELECT * FROM leads ORDER BY created_at DESC LIMIT 200")
      .toArray()
      .map((row) => this.mapLead(row));
    const drafts = this.ctx.storage.sql
      .exec<SqlRow>("SELECT * FROM drafts ORDER BY created_at DESC LIMIT 200")
      .toArray()
      .map((row) => this.mapDraft(row));
    return json({
      mode: this.env.EMAIL_MODE || "draft_only",
      limits: {
        newLeadsPerDay: boundedInt(this.env.MAX_DAILY_NEW_LEADS, 20, 100),
        sendsPerDay: boundedInt(this.env.MAX_DAILY_SENDS, 5, 25)
      },
      usage: this.usage(),
      leads,
      drafts
    });
  }

  private mapLead(row: SqlRow): Lead {
    return {
      id: String(row.id),
      businessName: String(row.business_name),
      category: String(row.category) as Lead["category"],
      city: String(row.city),
      country: "MA",
      websiteUrl: row.website_url ? String(row.website_url) : undefined,
      mapsUrl: row.maps_url ? String(row.maps_url) : undefined,
      publicEmail: row.public_email ? String(row.public_email) : undefined,
      phone: row.phone ? String(row.phone) : undefined,
      whatsapp: row.whatsapp ? String(row.whatsapp) : undefined,
      discoveredAt: String(row.discovered_at),
      sourceUrls: parseJson<string[]>(String(row.source_urls_json)),
      observedIssues: parseJson<ObservedIssue[]>(String(row.observed_issues_json)),
      recommendedService: row.recommended_service
        ? String(row.recommended_service)
        : undefined,
      score: Number(row.score),
      scoreReasons: parseJson<string[]>(String(row.score_reasons_json)),
      status: String(row.status) as LeadStatus,
      language: String(row.language) as OutreachLanguage,
      lastContactedAt: row.last_contacted_at
        ? String(row.last_contacted_at)
        : null,
      nextFollowUpAt: row.next_follow_up_at ? String(row.next_follow_up_at) : null,
      doNotContact: Boolean(row.do_not_contact),
      notes: String(row.notes || ""),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  private mapDraft(row: SqlRow): EmailDraft {
    return {
      id: String(row.id),
      leadId: String(row.lead_id),
      language: String(row.language) as OutreachLanguage,
      subject: String(row.subject),
      body: String(row.body),
      kind: String(row.kind) as EmailDraft["kind"],
      status: String(row.status) as EmailDraft["status"],
      version: Number(row.version),
      providerDraftId: row.provider_draft_id ? String(row.provider_draft_id) : null,
      providerThreadId: row.provider_thread_id
        ? String(row.provider_thread_id)
        : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  private lead(id: string): Lead | null {
    const row = this.ctx.storage.sql
      .exec<SqlRow>("SELECT * FROM leads WHERE id = ?", id)
      .toArray()[0];
    return row ? this.mapLead(row) : null;
  }

  private draft(id: string): EmailDraft | null {
    const row = this.ctx.storage.sql
      .exec<SqlRow>("SELECT * FROM drafts WHERE id = ?", id)
      .toArray()[0];
    return row ? this.mapDraft(row) : null;
  }

  private async updateLead(id: string, request: Request) {
    const lead = this.lead(id);
    if (!lead) return json({ error: "Lead not found" }, 404);
    const body = (await request.json()) as {
      status?: LeadStatus;
      notes?: string;
      nextFollowUpAt?: string | null;
    };
    if (body.status) {
      if (!LEAD_STATUSES.includes(body.status)) return json({ error: "Invalid status" }, 400);
      if (!canTransition(lead.status, body.status))
        return json({ error: "Invalid status transition" }, 409);
    }
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `UPDATE leads SET status = ?, notes = ?, next_follow_up_at = ?,
       updated_at = ? WHERE id = ?`,
      body.status || lead.status,
      body.notes ?? lead.notes,
      body.nextFollowUpAt === undefined ? lead.nextFollowUpAt : body.nextFollowUpAt,
      now,
      id
    );
    return json(this.lead(id));
  }

  private async createDraft(id: string, request: Request) {
    const lead = this.lead(id);
    if (!lead) return json({ error: "Lead not found" }, 404);
    if (!canContact(lead)) return json({ error: "Lead must not be contacted" }, 409);
    if (!["qualified", "draft_ready", "contacted"].includes(lead.status))
      return json({ error: "Lead must be qualified before drafting" }, 409);
    if (!lead.publicEmail) return json({ error: "No public business email" }, 409);
    const body = (await request.json().catch(() => ({}))) as {
      language?: OutreachLanguage;
      kind?: EmailDraft["kind"];
    };
    const kind = body.kind || "initial";
    if (!["initial", "follow_up_1", "follow_up_2"].includes(kind))
      return json({ error: "Invalid draft kind" }, 400);
    const followUps = this.ctx.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM drafts WHERE lead_id = ? AND kind LIKE 'follow_up_%'",
        id
      )
      .one().count;
    if (
      kind !== "initial" &&
      !followUpAllowed({
        lead,
        existingFollowUps: followUps,
        now: new Date(),
        minimumDays: boundedInt(this.env.MIN_FOLLOW_UP_DAYS, 7, 30)
      })
    )
      return json({ error: "Follow-up is not allowed yet" }, 409);
    const text = draftText(lead, body.language || lead.language || "fr", kind);
    const now = new Date().toISOString();
    const draftId = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      `INSERT INTO drafts (
        id, lead_id, language, subject, body, kind, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'draft_ready', ?, ?)`,
      draftId,
      id,
      body.language || lead.language || "fr",
      text.subject,
      text.body,
      kind,
      now,
      now
    );
    if (lead.status === "qualified")
      this.ctx.storage.sql.exec(
        "UPDATE leads SET status = 'draft_ready', updated_at = ? WHERE id = ?",
        now,
        id
      );
    return json(this.draft(draftId), 201);
  }

  private async editDraft(id: string, request: Request) {
    const draft = this.draft(id);
    if (!draft) return json({ error: "Draft not found" }, 404);
    if (draft.status === "sent") return json({ error: "Sent draft is immutable" }, 409);
    const body = (await request.json()) as { subject?: string; body?: string };
    const subject = body.subject?.trim() || draft.subject;
    const content = body.body?.trim() || draft.body;
    if (!draftHasRequiredOptOut({ body: content }))
      return json({ error: "A polite opt-out sentence is required" }, 400);
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `UPDATE drafts SET subject = ?, body = ?, version = version + 1,
       status = 'draft_ready', provider_draft_id = NULL, updated_at = ? WHERE id = ?`,
      subject,
      content,
      now,
      id
    );
    this.ctx.storage.sql.exec("DELETE FROM approvals WHERE draft_id = ?", id);
    return json(this.draft(id));
  }

  private approveDraft(id: string, request: Request) {
    const draft = this.draft(id);
    if (!draft) return json({ error: "Draft not found" }, 404);
    const lead = this.lead(draft.leadId);
    if (!lead || !canContact(lead)) return json({ error: "Lead must not be contacted" }, 409);
    if (draft.status !== "draft_ready") return json({ error: "Draft is not ready" }, 409);
    if (!draftHasRequiredOptOut(draft)) return json({ error: "Opt-out is missing" }, 409);
    const approvedBy =
      request.headers.get("x-reelhaus-approver");
    if (!approvedBy) return json({ error: "Approver identity is required" }, 401);
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO approvals (
        id, draft_id, draft_version, approved_by, approved_at
      ) VALUES (?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      id,
      draft.version,
      approvedBy,
      now
    );
    this.ctx.storage.sql.exec(
      "UPDATE drafts SET status = 'approved', updated_at = ? WHERE id = ?",
      now,
      id
    );
    this.ctx.storage.sql.exec(
      "UPDATE leads SET status = 'approved', updated_at = ? WHERE id = ?",
      now,
      draft.leadId
    );
    return json({ approved: true, approvedBy, approvedAt: now });
  }

  private rejectDraft(id: string) {
    const draft = this.draft(id);
    if (!draft) return json({ error: "Draft not found" }, 404);
    if (draft.status === "sent") return json({ error: "Sent draft is immutable" }, 409);
    this.ctx.storage.sql.exec("DELETE FROM approvals WHERE draft_id = ?", id);
    this.ctx.storage.sql.exec(
      "UPDATE drafts SET status = 'rejected', updated_at = ? WHERE id = ?",
      new Date().toISOString(),
      id
    );
    return json({ rejected: true });
  }

  private doNotContact(id: string) {
    const lead = this.lead(id);
    if (!lead) return json({ error: "Lead not found" }, 404);
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `UPDATE leads SET do_not_contact = 1, status = 'do_not_contact',
       next_follow_up_at = NULL, updated_at = ? WHERE id = ?`,
      now,
      id
    );
    this.ctx.storage.sql.exec(
      "UPDATE drafts SET status = 'rejected', updated_at = ? WHERE lead_id = ? AND status != 'sent'",
      now,
      id
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM approvals WHERE draft_id IN (SELECT id FROM drafts WHERE lead_id = ? AND status != 'sent')",
      id
    );
    this.recordEvent(id, null, "do_not_contact", { source: "dashboard" });
    return json({ doNotContact: true });
  }

  private async sendApprovedDraft(id: string) {
    if ((this.env.EMAIL_MODE || "draft_only") === "draft_only")
      return json({ error: "EMAIL_MODE is draft_only; sending is disabled" }, 409);
    const draft = this.draft(id);
    if (!draft || draft.status !== "approved")
      return json({ error: "Exactly one current approval is required" }, 409);
    const lead = this.lead(draft.leadId);
    if (!lead || !lead.publicEmail || !canContact(lead))
      return json({ error: "Lead is not contactable" }, 409);
    const approval = this.ctx.storage.sql
      .exec<{
        draft_version: number;
        approved_by: string;
        consumed_at: string | null;
      }>("SELECT draft_version, approved_by, consumed_at FROM approvals WHERE draft_id = ?", id)
      .toArray()[0];
    if (!approval)
      return json({ error: "Approval is missing, consumed, or stale" }, 409);
    if (
      !approvalIsUsable({
        draftStatus: draft.status,
        draftVersion: draft.version,
        approvedVersion: approval.draft_version,
        consumedAt: approval.consumed_at,
        contactAllowed: canContact(lead)
      })
    )
      return json({ error: "Approval is missing, consumed, or stale" }, 409);
    const maxSends = boundedInt(this.env.MAX_DAILY_SENDS, 5, 25);
    if (this.usage().sent_messages >= maxSends)
      return json({ error: "Daily send limit reached" }, 429);

    const attemptStartedAt = new Date().toISOString();
    const claim = this.ctx.storage.sql.exec(
      `UPDATE approvals SET consumed_at = ?
       WHERE draft_id = ? AND consumed_at IS NULL`,
      `attempt:${attemptStartedAt}`,
      id
    );
    if (claim.rowsWritten !== 1)
      return json({ error: "Approval was already consumed" }, 409);

    const provider = selectEmailProvider(this.env.EMAIL_MODE, this.env);
    let providerDraft: Awaited<ReturnType<typeof provider.createDraft>>;
    let delivery: Awaited<ReturnType<typeof provider.sendDraft>>;
    try {
      providerDraft = await provider.createDraft({
        to: lead.publicEmail,
        subject: draft.subject,
        body: draft.body,
        threadId: draft.providerThreadId
      });
      delivery = await provider.sendDraft(providerDraft.draftId);
    } catch (error) {
      console.error("Approved outreach provider attempt failed", {
        leadId: lead.id,
        draftId: id,
        error: message(error)
      });
      throw new Error(
        "Email provider attempt failed; approval was consumed to prevent duplicate sending"
      );
    }
    const now = delivery.sentAt;
    this.ctx.storage.sql.exec(
      "UPDATE approvals SET consumed_at = ? WHERE draft_id = ? AND consumed_at IS NULL",
      now,
      id
    );
    this.ctx.storage.sql.exec(
      `UPDATE drafts SET status = 'sent', provider_draft_id = ?,
       provider_thread_id = ?, updated_at = ? WHERE id = ?`,
      providerDraft.draftId,
      delivery.threadId || providerDraft.threadId,
      now,
      id
    );
    this.ctx.storage.sql.exec(
      `UPDATE leads SET status = 'contacted', last_contacted_at = ?,
       next_follow_up_at = ?, updated_at = ? WHERE id = ?`,
      now,
      new Date(
        new Date(now).getTime() +
          boundedInt(this.env.MIN_FOLLOW_UP_DAYS, 7, 30) * 86_400_000
      ).toISOString(),
      now,
      lead.id
    );
    this.ctx.storage.sql.exec(
      "UPDATE daily_usage SET sent_messages = sent_messages + 1 WHERE day = ?",
      now.slice(0, 10)
    );
    this.recordEvent(lead.id, id, "sent", {
      provider: delivery.provider,
      messageId: delivery.messageId,
      threadId: delivery.threadId,
      subject: draft.subject,
      approvedBy: approval.approved_by
    });
    console.log("Approved outreach sent", {
      leadId: lead.id,
      draftId: id,
      provider: delivery.provider
    });
    return json({ sent: true, sentAt: now, provider: delivery.provider });
  }

  private async recordInboundEvent(id: string, request: Request) {
    const lead = this.lead(id);
    if (!lead) return json({ error: "Lead not found" }, 404);
    const body = (await request.json()) as {
      type: "reply" | "bounce" | "opt_out";
      providerThreadId?: string;
      note?: string;
    };
    if (!["reply", "bounce", "opt_out"].includes(body.type))
      return json({ error: "Invalid event type" }, 400);
    const now = new Date().toISOString();
    const stop = body.type === "bounce" || body.type === "opt_out";
    this.ctx.storage.sql.exec(
      `UPDATE leads SET status = ?, do_not_contact = ?,
       next_follow_up_at = NULL, updated_at = ? WHERE id = ?`,
      stop ? "do_not_contact" : "replied",
      stop ? 1 : 0,
      now,
      id
    );
    this.ctx.storage.sql.exec(
      "UPDATE drafts SET status = 'rejected', updated_at = ? WHERE lead_id = ? AND status IN ('draft_ready', 'approved')",
      now,
      id
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM approvals WHERE draft_id IN (SELECT id FROM drafts WHERE lead_id = ? AND status != 'sent')",
      id
    );
    this.recordEvent(id, null, body.type, {
      providerThreadId: body.providerThreadId,
      note: body.note?.slice(0, 500)
    });
    return json({ recorded: true, followUpsStopped: true });
  }

  private recordEvent(
    leadId: string,
    draftId: string | null,
    type: string,
    metadata: Record<string, unknown>
  ) {
    this.ctx.storage.sql.exec(
      `INSERT INTO outreach_events (
        id, lead_id, draft_id, event_type, occurred_at, provider_message_id,
        provider_thread_id, subject, approved_by, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      leadId,
      draftId,
      type,
      new Date().toISOString(),
      metadata.messageId ? String(metadata.messageId) : null,
      metadata.threadId
        ? String(metadata.threadId)
        : metadata.providerThreadId
          ? String(metadata.providerThreadId)
          : null,
      metadata.subject ? String(metadata.subject) : null,
      metadata.approvedBy ? String(metadata.approvedBy) : null,
      JSON.stringify(metadata)
    );
  }

  private async runGuardianScan() {
    const report = await analyzeReelHaus(fetch);
    this.ctx.storage.sql.exec(
      "INSERT INTO reports VALUES (?, ?, ?, ?)",
      report.id,
      report.createdAt,
      JSON.stringify(report.summary),
      JSON.stringify(report)
    );
    return json(report, 201);
  }

  private listReports() {
    const reports = this.ctx.storage.sql
      .exec<{ id: string; created_at: string; summary_json: string }>(
        "SELECT id, created_at, summary_json FROM reports ORDER BY created_at DESC LIMIT 50"
      )
      .toArray()
      .map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        summary: parseJson<ReportSummary>(row.summary_json)
      }));
    return json({ reports });
  }

  private getReport(id: string) {
    const row = this.ctx.storage.sql
      .exec<{ report_json: string }>("SELECT report_json FROM reports WHERE id = ?", id)
      .toArray()[0];
    return row
      ? json(parseJson<AuditReport>(row.report_json))
      : json({ error: "Report not found" }, 404);
  }
}
