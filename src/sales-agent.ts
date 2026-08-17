import { Agent } from "agents";
import { checkAiHealth } from "./ai-service";
import { AuditLedgerService, SqlAuditLedgerStore } from "./audit-ledger";
import { analyzePublicBusinessWebsite } from "./browser-analysis";
import { QUEUE_BATCH_LIMIT, QUEUE_RETRY_DELAY_SECONDS } from "./public-intake-config";
import { handlePublicReelScanRequest } from "./public-intake-route";
import { PublicIntakeService, listInboundRequestsForManager } from "./public-intake-service";
import { SqlPublicIntakeStore } from "./public-intake-store";
import { runReelScanV1ClientZero } from "./reelscan";
import {
  BusinessAssistantAgent,
  EmailReviewAgent,
  EmailSalesAgent,
  QualificationAgent,
  ReelScanAuditAgent,
  type PeerDraftOpening
} from "./business-agents";
import {
  BUSINESS_INTELLIGENCE_WORKSPACE_VERSION,
  buildBusinessWorkspace,
  businessMatchesSearch,
  canonicalBusinessSearchResult
} from "./business-workspace";
import {
  AUTONOMOUS_DISCOVERY_VERSION,
  MAX_DISCOVERY_SOURCE_PAGES_PER_RUN,
  calculateDiscoveryPriority,
  discoveryCandidateCanBeApproved,
  discoveryCandidateIsCrmVisible,
  discoveryDedupeKey,
  discoveryLeadDedupeKey,
  discoveryIdentityKeys,
  discoveryLearningAdjustment,
  evaluateDiscoveryCandidate,
  mergeDiscoveryCandidates,
  normalizeDiscoveryCandidate,
  researchOpenStreetMapHospitality,
  researchPublicSource,
  researchWikidataHospitality
} from "./discovery-agent";
import { draftHasRequiredOptOut, selectEmailProvider } from "./email-provider";
import {
  approvalIsUsable,
  canContact,
  canTransition,
  followUpAllowed,
  leadDedupeKey,
  normalizeEmail,
  normalizeUrl,
  outreachIsEnabled
} from "./sales-policy";
import { REELHAUS_AI_VERSION } from "./reelhaus-principles";
import {
  LEAD_CATEGORIES,
  LEAD_STATUSES,
  type DiscoveryCandidate,
  type DiscoveryCandidateInput,
  type DiscoveryDecisionType,
  type DiscoveryStatus,
  type BusinessContactEvent,
  type BusinessFollowUp,
  type BusinessSearchResult,
  type EmailDraft,
  type EmailReview,
  type Lead,
  type LeadInput,
  type LeadQualityReview,
  type LeadStatus,
  type ObservedIssue,
  type OutreachLanguage,
  type PublicWebsiteObservation,
  type QualificationResult,
  type ReelScanLeadAudit
} from "./sales-types";
import type { AuditReport, ReportSummary } from "./website-analysis";
import { analyzeReelHaus } from "./website-analysis";

type SalesEnv = Env;

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
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(parsed, max)
    : fallback;
}

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
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

export class ReelHausManager extends Agent<SalesEnv, Record<string, never>> {
  private readonly auditLedger: AuditLedgerService;
  private readonly publicIntakeStore: SqlPublicIntakeStore;

  constructor(ctx: DurableObjectState, env: SalesEnv) {
    super(ctx, env);
    this.auditLedger = new AuditLedgerService(
      new SqlAuditLedgerStore(this.ctx.storage.sql)
    );
    this.publicIntakeStore = new SqlPublicIntakeStore(this.ctx.storage.sql);
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
      CREATE TABLE IF NOT EXISTS discovery_candidates (
        id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE,
        business_name TEXT NOT NULL, category TEXT NOT NULL, city TEXT NOT NULL,
        country TEXT NOT NULL CHECK(country = 'MA'), website_url TEXT,
        maps_url TEXT, public_email TEXT, phone TEXT, whatsapp TEXT,
        social_links_json TEXT NOT NULL DEFAULT '[]',
        booking_links_json TEXT NOT NULL DEFAULT '[]',
        source_urls_json TEXT NOT NULL, confidence TEXT NOT NULL,
        status TEXT NOT NULL, rejection_reason TEXT, discovered_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, language TEXT NOT NULL DEFAULT 'fr',
        is_pilot INTEGER NOT NULL DEFAULT 0, lead_id TEXT,
        FOREIGN KEY (lead_id) REFERENCES leads(id)
      );
      CREATE TABLE IF NOT EXISTS discovery_identities (
        identity_key TEXT PRIMARY KEY, candidate_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (candidate_id) REFERENCES discovery_candidates(id)
      );
      CREATE TABLE IF NOT EXISTS discovery_decisions (
        id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL,
        decision TEXT NOT NULL CHECK(decision IN ('approved', 'rejected', 'ignored')),
        actor TEXT NOT NULL, category TEXT NOT NULL, city TEXT NOT NULL,
        country TEXT NOT NULL, priority_score INTEGER NOT NULL,
        decided_at TEXT NOT NULL,
        FOREIGN KEY (candidate_id) REFERENCES discovery_candidates(id)
      );
      CREATE TABLE IF NOT EXISTS companies (
        id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE,
        business_name TEXT NOT NULL, category TEXT NOT NULL, city TEXT NOT NULL,
        country TEXT NOT NULL CHECK(country = 'MA'), website_url TEXT, maps_url TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audits (
        id TEXT PRIMARY KEY, lead_id TEXT NOT NULL,
        observations_json TEXT NOT NULL, priorities_json TEXT NOT NULL,
        recommended_service TEXT NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY (lead_id) REFERENCES leads(id)
      );
      CREATE TABLE IF NOT EXISTS qualification (
        id TEXT PRIMARY KEY, lead_id TEXT NOT NULL, score INTEGER NOT NULL,
        criteria_json TEXT NOT NULL, result_json TEXT NOT NULL,
        created_at TEXT NOT NULL, FOREIGN KEY (lead_id) REFERENCES leads(id)
      );
      CREATE TABLE IF NOT EXISTS email_drafts (
        id TEXT PRIMARY KEY, lead_id TEXT NOT NULL, language TEXT NOT NULL,
        subject TEXT NOT NULL, body TEXT NOT NULL, kind TEXT NOT NULL,
        status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
        provider_draft_id TEXT, provider_thread_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS email_reviews (
        id TEXT PRIMARY KEY, draft_id TEXT NOT NULL, draft_version INTEGER NOT NULL,
        score INTEGER NOT NULL, approved INTEGER NOT NULL,
        issues_json TEXT NOT NULL, rewritten_subject TEXT NOT NULL,
        rewritten_body TEXT NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY (draft_id) REFERENCES drafts(id)
      );
      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY, lead_id TEXT NOT NULL, kind TEXT NOT NULL,
        value TEXT NOT NULL, source_url TEXT NOT NULL, observed_at TEXT NOT NULL,
        is_public INTEGER NOT NULL CHECK(is_public = 1),
        FOREIGN KEY (lead_id) REFERENCES leads(id)
      );
      CREATE TABLE IF NOT EXISTS followups (
        id TEXT PRIMARY KEY, lead_id TEXT NOT NULL, draft_id TEXT,
        sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 2),
        status TEXT NOT NULL, scheduled_for TEXT, created_at TEXT NOT NULL,
        stopped_at TEXT, FOREIGN KEY (lead_id) REFERENCES leads(id)
      );
      CREATE TABLE IF NOT EXISTS activities (
        id TEXT PRIMARY KEY, lead_id TEXT, actor TEXT NOT NULL,
        action TEXT NOT NULL, details_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pilot_leads (
        lead_id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
        FOREIGN KEY (lead_id) REFERENCES leads(id)
      );
      CREATE TABLE IF NOT EXISTS lead_quality_reviews (
        id TEXT PRIMARY KEY, lead_id TEXT NOT NULL,
        real_opportunity INTEGER NOT NULL,
        observation_accuracy INTEGER NOT NULL CHECK(observation_accuracy BETWEEN 1 AND 5),
        email_personalization INTEGER NOT NULL CHECK(email_personalization BETWEEN 1 AND 5),
        score_usefulness INTEGER NOT NULL CHECK(score_usefulness BETWEEN 1 AND 5),
        relevance INTEGER NOT NULL CHECK(relevance BETWEEN 1 AND 5),
        notes TEXT NOT NULL DEFAULT '', reviewed_by TEXT NOT NULL,
        reviewed_at TEXT NOT NULL,
        FOREIGN KEY (lead_id) REFERENCES leads(id)
      );
      INSERT OR IGNORE INTO email_drafts
        SELECT id, lead_id, language, subject, body, kind, status, version,
          provider_draft_id, provider_thread_id, created_at, updated_at
        FROM drafts;
      CREATE TRIGGER IF NOT EXISTS mirror_drafts_insert
      AFTER INSERT ON drafts BEGIN
        INSERT OR REPLACE INTO email_drafts VALUES (
          NEW.id, NEW.lead_id, NEW.language, NEW.subject, NEW.body, NEW.kind,
          NEW.status, NEW.version, NEW.provider_draft_id, NEW.provider_thread_id,
          NEW.created_at, NEW.updated_at
        );
      END;
      CREATE TRIGGER IF NOT EXISTS mirror_drafts_update
      AFTER UPDATE ON drafts BEGIN
        INSERT OR REPLACE INTO email_drafts VALUES (
          NEW.id, NEW.lead_id, NEW.language, NEW.subject, NEW.body, NEW.kind,
          NEW.status, NEW.version, NEW.provider_draft_id, NEW.provider_thread_id,
          NEW.created_at, NEW.updated_at
        );
      END;
      CREATE INDEX IF NOT EXISTS leads_status ON leads(status);
      CREATE INDEX IF NOT EXISTS drafts_lead ON drafts(lead_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS events_lead ON outreach_events(lead_id, occurred_at);
      CREATE INDEX IF NOT EXISTS audits_lead ON audits(lead_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS qualification_lead
        ON qualification(lead_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS reviews_draft
        ON email_reviews(draft_id, draft_version DESC);
      CREATE INDEX IF NOT EXISTS activities_lead
        ON activities(lead_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS quality_reviews_lead
        ON lead_quality_reviews(lead_id, reviewed_at DESC);
      CREATE INDEX IF NOT EXISTS discovery_candidates_status
        ON discovery_candidates(status, discovered_at DESC);
      CREATE INDEX IF NOT EXISTS discovery_decisions_similarity
        ON discovery_decisions(category, city, country, decided_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS discovery_decisions_candidate
        ON discovery_decisions(candidate_id);
    `);
    this.ensureDiscoveryColumn("country_code", "TEXT NOT NULL DEFAULT 'MA'");
    this.ensureDiscoveryColumn("languages_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureDiscoveryColumn("latitude", "REAL");
    this.ensureDiscoveryColumn("longitude", "REAL");
    this.ensureDiscoveryColumn("discovery_source", "TEXT");
    this.ensureDiscoveryColumn("priority_score", "INTEGER NOT NULL DEFAULT 0");
    this.ensureDiscoveryColumn(
      "priority_reasons_json",
      "TEXT NOT NULL DEFAULT '[]'"
    );
    this.ensureDiscoveryColumn(
      "learning_adjustment",
      "INTEGER NOT NULL DEFAULT 0"
    );
    this.ensureDiscoveryColumn("scanned_at", "TEXT");
    this.ensureDiscoveryColumn("approved_at", "TEXT");
    this.ensureDiscoveryColumn("ignored_at", "TEXT");
    this.ensureDiscoveryColumn("decided_by", "TEXT");
  }

  private ensureDiscoveryColumn(column: string, definition: string) {
    const exists = this.ctx.storage.sql
      .exec<{ name: string }>("PRAGMA table_info(discovery_candidates)")
      .toArray()
      .some((item) => item.name === column);
    if (!exists)
      this.ctx.storage.sql.exec(
        `ALTER TABLE discovery_candidates ADD COLUMN ${column} ${definition}`
      );
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/scan")
        return await this.runGuardianScan();
      if (
        request.method === "POST" &&
        url.pathname === "/reelscan/v1/client-zero"
      )
        return await this.triggerReelScanV1ClientZero();
      if (request.method === "GET" && url.pathname === "/ai/health")
        return await this.aiHealthCheck();
      if (
        (request.method === "POST" || request.method === "OPTIONS") &&
        url.pathname === "/public-intake/submit"
      )
        return await this.handlePublicIntakeSubmit(request);
      if (request.method === "GET" && url.pathname === "/inbound-requests")
        return json(
          listInboundRequestsForManager(this.publicIntakeStore, this.auditLedger)
        );
      if (
        request.method === "GET" &&
        /^\/audit\/scans\/[^/]+$/.test(url.pathname)
      )
        return json(
          this.auditLedger.getScanAuditTrail(url.pathname.split("/")[3])
        );
      if (request.method === "GET" && url.pathname === "/reports")
        return this.listReports();
      if (request.method === "GET" && url.pathname.startsWith("/reports/"))
        return this.getReport(url.pathname.slice(9));
      if (request.method === "GET" && url.pathname === "/sales")
        return this.salesSnapshot();
      if (request.method === "GET" && url.pathname === "/businesses/search")
        return this.searchBusinesses(url.searchParams.get("q") || "");
      if (
        request.method === "GET" &&
        /^\/businesses\/[^/]+\/workspace$/.test(url.pathname)
      )
        return this.businessWorkspace(url.pathname.split("/")[2]);
      if (request.method === "GET" && url.pathname === "/reelscan/export")
        return this.exportReelScan(url.searchParams.get("format") || "csv");
      if (request.method === "POST" && url.pathname === "/discovery/queue")
        return await this.queueLead(request);
      if (request.method === "POST" && url.pathname === "/discovery/run")
        return await this.runDiscovery();
      if (
        request.method === "POST" &&
        /^\/discovery\/candidates\/[^/]+\/(?:scan|reelscan)$/.test(url.pathname)
      )
        return await this.sendCandidateToReelScan(
          url.pathname.split("/")[3],
          request
        );
      if (
        request.method === "POST" &&
        /^\/discovery\/candidates\/[^/]+\/decision$/.test(url.pathname)
      )
        return await this.recordCandidateDecision(
          url.pathname.split("/")[3],
          request
        );
      if (request.method === "PATCH" && /^\/leads\/[^/]+$/.test(url.pathname))
        return await this.updateLead(url.pathname.split("/")[2], request);
      if (
        request.method === "POST" &&
        /\/leads\/[^/]+\/audit$/.test(url.pathname)
      )
        return await this.auditLead(url.pathname.split("/")[2]);
      if (
        request.method === "POST" &&
        /\/leads\/[^/]+\/qualify$/.test(url.pathname)
      )
        return this.qualifyLead(url.pathname.split("/")[2]);
      if (
        request.method === "POST" &&
        /\/leads\/[^/]+\/draft$/.test(url.pathname)
      )
        return await this.createDraft(url.pathname.split("/")[2], request);
      if (
        request.method === "POST" &&
        /\/leads\/[^/]+\/quality-review$/.test(url.pathname)
      )
        return await this.reviewLeadQuality(
          url.pathname.split("/")[2],
          request
        );
      if (
        request.method === "POST" &&
        /\/leads\/[^/]+\/events$/.test(url.pathname)
      )
        return await this.recordInboundEvent(
          url.pathname.split("/")[2],
          request
        );
      if (
        request.method === "POST" &&
        /\/leads\/[^/]+\/do-not-contact$/.test(url.pathname)
      )
        return this.doNotContact(url.pathname.split("/")[2], request);
      if (request.method === "PATCH" && /^\/drafts\/[^/]+$/.test(url.pathname))
        return await this.editDraft(url.pathname.split("/")[2], request);
      if (
        request.method === "POST" &&
        /\/drafts\/[^/]+\/review$/.test(url.pathname)
      )
        return this.reviewDraft(url.pathname.split("/")[2]);
      if (
        request.method === "POST" &&
        /\/drafts\/[^/]+\/approve$/.test(url.pathname)
      )
        return this.approveDraft(url.pathname.split("/")[2], request);
      if (
        request.method === "POST" &&
        /\/drafts\/[^/]+\/reject$/.test(url.pathname)
      )
        return this.rejectDraft(url.pathname.split("/")[2], request);
      if (
        request.method === "POST" &&
        /\/drafts\/[^/]+\/send$/.test(url.pathname)
      )
        return await this.sendApprovedDraft(url.pathname.split("/")[2]);
      if (request.method === "POST" && url.pathname === "/assistant")
        return await this.businessAssistant(request);
      return json({ error: "Not found" }, 404);
    } catch (error) {
      console.error("ReelHaus Manager request failed", {
        method: request.method,
        path: url.pathname,
        error: message(error)
      });
      // Defense layer two for the public route: handlePublicReelScanRequest()
      // already catches everything it can throw and always returns the
      // generic public error contract itself (see public-intake-route.ts).
      // This branch exists only in case that layer is ever bypassed —
      // e.g. a bug introduced above this line, before dispatch even reaches
      // it — so the public path can never fall through to this catch's
      // normal { error: message(error) } shape, which is private-diagnostic
      // by design and would leak internal detail if it reached a public
      // caller.
      if (url.pathname === "/public-intake/submit")
        return json({ ok: false, error: "try_again_later" }, 503);
      return json({ error: message(error) }, 500);
    }
  }

  private async aiHealthCheck() {
    const health = await checkAiHealth(this.env.AI);
    return json(health, health.ok ? 200 : 503);
  }

  // Reached only via server.ts's fixed, hardcoded internal forward for the
  // one Access-bypassing public route — see routePublicReelScan() and
  // isPublicApiRoute(). All actual validation/Turnstile/CORS/rate-limit/
  // ReelScan logic lives in public-intake-route.ts, fully unit tested;
  // this is deliberately a one-line call, nothing DO-specific to test here.
  private async handlePublicIntakeSubmit(request: Request): Promise<Response> {
    return handlePublicReelScanRequest(request, {
      store: this.publicIntakeStore,
      auditLedger: this.auditLedger,
      ai: this.env.AI,
      fetcher: fetch,
      turnstileSecretKey: this.env.TURNSTILE_SECRET_KEY,
      rateLimitPepper: this.env.PUBLIC_RATE_LIMIT_PEPPER,
      callerIp: request.headers.get("cf-connecting-ip"),
      scheduleQueueProcessing: () => this.scheduleInboundScanQueue()
    });
  }

  // Task #5A-fix §5 — a tiny, free-first intake queue built on the agents
  // SDK's own schedule() (SQLite-backed, idempotent by callback+payload,
  // itself built on a single Durable Object alarm this class never touches
  // directly — see the PublicIntakeDeps.scheduleQueueProcessing doc
  // comment in public-intake-service.ts for why this mechanism was chosen
  // over a hand-rolled alarm() handler). idempotent:true means repeated
  // calls (once per accepted website submission) collapse onto the same
  // pending run instead of accumulating duplicate schedule rows.
  private async scheduleInboundScanQueue(): Promise<void> {
    await this.schedule(0, "processInboundScanQueue", undefined, { idempotent: true });
  }

  /**
   * The intake queue's scheduled callback (named exactly as passed to
   * schedule() above — the agents SDK invokes methods by name). All the
   * actual queue-processing logic (cooldown/reuse, in-flight-target dedup,
   * concurrency reservation, terminal-state guarantee) lives in
   * PublicIntakeService.processQueue(), fully unit tested without a
   * Durable Object; this method is deliberately a thin wrapper that also
   * decides whether to re-arm — the one piece that genuinely needs
   * this.schedule().
   */
  async processInboundScanQueue(): Promise<void> {
    const service = new PublicIntakeService({
      store: this.publicIntakeStore,
      auditLedger: this.auditLedger,
      ai: this.env.AI,
      fetcher: fetch,
      scheduleQueueProcessing: () => this.scheduleInboundScanQueue()
    });
    const { remainingQueued } = await service.processQueue(Date.now(), QUEUE_BATCH_LIMIT);
    if (remainingQueued)
      await this.schedule(QUEUE_RETRY_DELAY_SECONDS, "processInboundScanQueue", undefined, {
        idempotent: true
      });
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
    const input = normalizeDiscoveryCandidate(
      (await request.json()) as DiscoveryCandidateInput
    );
    const validation = validateLeadInput(input as LeadInput);
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
    if (!remaining)
      return json({ processed: 0, reason: "daily limit reached" });
    let created = 0;
    let duplicates = 0;
    let rejected = 0;
    let failed = 0;
    let sourcesChecked = 0;
    let sourcesSkipped = 0;

    const day = new Date().toISOString().slice(0, 10);
    const dayStart = `${day}T00:00:00.000Z`;
    const publicDiscoveryAlreadyChecked = Boolean(
      this.ctx.storage.sql
        .exec<{ id: string }>(
          `SELECT id FROM activities
           WHERE action = 'discovery.public_completed' AND created_at >= ?
           LIMIT 1`,
          dayStart
        )
        .toArray()[0]
    );
    if (
      this.env.DISCOVERY_OSM_ENABLED === "true" &&
      !publicDiscoveryAlreadyChecked &&
      created < remaining
    ) {
      const createdBeforePublicSources = created;
      const research = await researchOpenStreetMapHospitality();
      sourcesChecked++;
      if (research.skippedReason) {
        sourcesSkipped++;
        console.warn("OpenStreetMap discovery skipped", {
          city: research.city,
          reason: research.skippedReason
        });
      } else {
        for (const input of research.candidates) {
          if (created >= remaining) break;
          const result = this.storeDiscoveryCandidate(input);
          if (result.outcome === "created") created++;
          else if (result.outcome === "duplicate") duplicates++;
          else rejected++;
        }
      }
      let wikidataSkipped = false;
      let wikidataCandidates = 0;
      if (created === createdBeforePublicSources && created < remaining) {
        const wikidata = await researchWikidataHospitality();
        sourcesChecked++;
        wikidataCandidates = wikidata.candidates.length;
        if (wikidata.skippedReason) {
          wikidataSkipped = true;
          sourcesSkipped++;
          console.warn("Wikidata discovery skipped", {
            reason: wikidata.skippedReason
          });
        } else {
          for (const input of wikidata.candidates) {
            if (created >= remaining) break;
            const result = this.storeDiscoveryCandidate(input);
            if (result.outcome === "created") created++;
            else if (result.outcome === "duplicate") duplicates++;
            else rejected++;
          }
        }
      }
      const publicSourceSucceeded =
        !research.skippedReason || !wikidataSkipped;
      this.recordActivity(
        null,
        "system:discovery-agent",
        publicSourceSucceeded
          ? "discovery.public_completed"
          : "discovery.public_failed",
        {
          city: research.city,
          openStreetMapCandidates: research.candidates.length,
          wikidataCandidates,
          created: created - createdBeforePublicSources,
          skipped: !publicSourceSucceeded
        }
      );
    }

    const configuredSources = [
      ...new Set(
        (this.env.DISCOVERY_SOURCE_URLS || "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      )
    ]
      .filter(
        (source, index, all) =>
          all.findIndex((candidate) => {
            try {
              return new URL(candidate).hostname === new URL(source).hostname;
            } catch {
              return candidate === source;
            }
          }) === index
      )
      .slice(0, MAX_DISCOVERY_SOURCE_PAGES_PER_RUN);
    for (const sourceUrl of configuredSources) {
      if (created >= remaining) break;
      const research = await researchPublicSource(sourceUrl);
      sourcesChecked++;
      if (research.skippedReason) {
        sourcesSkipped++;
        console.warn("Discovery source skipped", {
          sourceUrl: research.sourceUrl,
          reason: research.skippedReason
        });
        continue;
      }
      for (const input of research.candidates) {
        if (created >= remaining) break;
        const result = this.storeDiscoveryCandidate(input);
        if (result.outcome === "created") created++;
        else if (result.outcome === "duplicate") duplicates++;
        else rejected++;
      }
    }

    const queueLimit = Math.max(0, remaining - created);
    const queued = this.ctx.storage.sql
      .exec<{ id: string; input_json: string }>(
        "SELECT id, input_json FROM discovery_queue WHERE status = 'queued' ORDER BY queued_at LIMIT ?",
        queueLimit
      )
      .toArray();
    for (const item of queued) {
      try {
        const input = parseJson<DiscoveryCandidateInput>(item.input_json);
        const result = this.storeDiscoveryCandidate(input);
        if (result.outcome === "created") created++;
        else if (result.outcome === "duplicate") duplicates++;
        else rejected++;
        this.ctx.storage.sql.exec(
          "UPDATE discovery_queue SET status = ? WHERE id = ?",
          result.outcome,
          item.id
        );
      } catch (error) {
        failed++;
        console.error("Discovery queue item failed", {
          queueId: item.id,
          error: message(error)
        });
        this.ctx.storage.sql.exec(
          "UPDATE discovery_queue SET status = 'failed', error = ? WHERE id = ?",
          message(error).slice(0, 500),
          item.id
        );
      }
    }
    console.log("Discovery batch completed", {
      sourcesChecked,
      sourcesSkipped,
      queuedProcessed: queued.length,
      created,
      duplicates,
      rejected,
      failed,
      dailyLimit: limit
    });
    return json({
      version: AUTONOMOUS_DISCOVERY_VERSION,
      processed: queued.length,
      sourcesChecked,
      sourcesSkipped,
      created,
      duplicates,
      rejected,
      failed,
      qualificationStarted: false,
      emailActionTaken: false
    });
  }

  private storeDiscoveryCandidate(input: DiscoveryCandidateInput): {
    outcome: "created" | "duplicate" | "rejected";
    id: string;
  } {
    const decision = evaluateDiscoveryCandidate(input);
    const candidate = decision.normalized;
    const key = discoveryDedupeKey(candidate);
    const existing = this.findDuplicateCandidate(candidate);
    const now = new Date().toISOString();
    if (existing) {
      const storedCandidate = this.mapCandidate(existing);
      const merged = mergeDiscoveryCandidates(storedCandidate, candidate);
      const learningAdjustment = this.discoveryLearningFor(merged);
      const priority = calculateDiscoveryPriority(
        merged,
        [],
        learningAdjustment
      );
      this.ctx.storage.sql.exec(
        `UPDATE discovery_candidates SET
          website_url = COALESCE(website_url, ?),
          maps_url = COALESCE(maps_url, ?),
          public_email = COALESCE(public_email, ?),
          phone = COALESCE(phone, ?),
          whatsapp = COALESCE(whatsapp, ?),
          source_urls_json = ?, social_links_json = ?, booking_links_json = ?,
          languages_json = ?, latitude = COALESCE(latitude, ?),
          longitude = COALESCE(longitude, ?),
          discovery_source = COALESCE(discovery_source, ?),
          priority_score = MAX(priority_score, ?), priority_reasons_json = ?,
          learning_adjustment = ?,
          updated_at = ? WHERE id = ?`,
        merged.websiteUrl || null,
        merged.mapsUrl || null,
        merged.publicEmail || null,
        merged.phone || null,
        merged.whatsapp || null,
        JSON.stringify(merged.sourceUrls),
        JSON.stringify(merged.socialLinks || []),
        JSON.stringify(merged.bookingLinks || []),
        JSON.stringify(merged.languagesDetected || []),
        merged.latitude ?? null,
        merged.longitude ?? null,
        merged.discoverySource || null,
        priority.score,
        JSON.stringify(priority.reasons),
        priority.learningAdjustment,
        now,
        String(existing.id)
      );
      this.registerDiscoveryIdentities(String(existing.id), merged, now);
      this.recordActivity(
        null,
        "system:autonomous-discovery-agent",
        "candidate.duplicate_skipped",
        {
          candidateId: String(existing.id),
          matchedIdentityCount: discoveryIdentityKeys(candidate).length,
          emailActionTaken: false
        }
      );
      return { outcome: "duplicate", id: String(existing.id) };
    }

    const existingLead = this.ctx.storage.sql
      .exec<{ id: string; business_name: string }>(
        "SELECT id, business_name FROM leads WHERE dedupe_key = ? LIMIT 1",
        discoveryLeadDedupeKey(candidate)
      )
      .toArray()[0];
    if (existingLead) {
      this.recordActivity(
        existingLead.id,
        "system:autonomous-discovery-agent",
        "candidate.duplicate_skipped",
        {
          canonicalLeadId: existingLead.id,
          canonicalBusinessName: existingLead.business_name,
          incomingBusinessName: candidate.businessName,
          matchedBy: discoveryLeadDedupeKey(candidate).split(":", 1)[0],
          qualificationStarted: false,
          emailActionTaken: false
        }
      );
      return { outcome: "duplicate", id: existingLead.id };
    }

    const id = crypto.randomUUID();
    const status: DiscoveryStatus = decision.accepted ? "new" : "rejected";
    const learningAdjustment = this.discoveryLearningFor(candidate);
    const priority = calculateDiscoveryPriority(
      candidate,
      [],
      learningAdjustment
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO discovery_candidates (
        id, dedupe_key, business_name, category, city, country, website_url,
        maps_url, public_email, phone, whatsapp, social_links_json,
        booking_links_json, source_urls_json, confidence, status,
        rejection_reason, discovered_at, updated_at, language, is_pilot,
        country_code, languages_json, latitude, longitude, discovery_source,
        priority_score, priority_reasons_json, learning_adjustment
      ) VALUES (?, ?, ?, ?, ?, 'MA', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      key,
      candidate.businessName || "Unclear public business",
      candidate.category,
      candidate.city || "Unknown",
      candidate.websiteUrl || null,
      candidate.mapsUrl || null,
      candidate.publicEmail || null,
      candidate.phone || null,
      candidate.whatsapp || null,
      JSON.stringify(candidate.socialLinks || []),
      JSON.stringify(candidate.bookingLinks || []),
      JSON.stringify(candidate.sourceUrls),
      decision.confidence,
      status,
      decision.reasons.join(" ") || null,
      now,
      now,
      candidate.language || "fr",
      candidate.pilot ? 1 : 0,
      candidate.country || "MA",
      JSON.stringify(candidate.languagesDetected || []),
      candidate.latitude ?? null,
      candidate.longitude ?? null,
      candidate.discoverySource || candidate.sourceUrls[0] || null,
      priority.score,
      JSON.stringify(priority.reasons),
      priority.learningAdjustment
    );
    this.registerDiscoveryIdentities(id, candidate, now);
    if (decision.accepted)
      this.ctx.storage.sql.exec(
        "UPDATE daily_usage SET new_leads = new_leads + 1 WHERE day = ?",
        now.slice(0, 10)
      );
    this.recordActivity(
      null,
      "system:autonomous-discovery-agent",
      decision.accepted ? "candidate.discovered" : "candidate.rejected",
      {
        candidateId: id,
        category: candidate.category,
        city: candidate.city,
        confidence: decision.confidence,
        priorityScore: priority.score,
        publicInformationOnly: true,
        qualificationStarted: false,
        emailActionTaken: false
      }
    );
    return {
      outcome: decision.accepted ? "created" : "rejected",
      id
    };
  }

  private findDuplicateCandidate(
    input: DiscoveryCandidateInput
  ): SqlRow | undefined {
    const keys = discoveryIdentityKeys(input);
    if (keys.length) {
      const placeholders = keys.map(() => "?").join(",");
      const matched = this.ctx.storage.sql
        .exec<SqlRow>(
          `SELECT discovery_candidates.* FROM discovery_identities
           JOIN discovery_candidates
             ON discovery_candidates.id = discovery_identities.candidate_id
           WHERE discovery_identities.identity_key IN (${placeholders})
           LIMIT 1`,
          ...keys
        )
        .toArray()[0];
      if (matched) return matched;
    }
    const requested = new Set(keys);
    return this.ctx.storage.sql
      .exec<SqlRow>(
        "SELECT * FROM discovery_candidates ORDER BY discovered_at DESC LIMIT 1000"
      )
      .toArray()
      .find((row) =>
        discoveryIdentityKeys(this.mapCandidate(row)).some((key) =>
          requested.has(key)
        )
      );
  }

  private registerDiscoveryIdentities(
    candidateId: string,
    input: DiscoveryCandidateInput,
    createdAt: string
  ) {
    for (const identityKey of discoveryIdentityKeys(input))
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO discovery_identities (
          identity_key, candidate_id, created_at
        ) VALUES (?, ?, ?)`,
        identityKey,
        candidateId,
        createdAt
      );
  }

  private discoveryLearningFor(input: DiscoveryCandidateInput): number {
    const candidate = normalizeDiscoveryCandidate(input);
    const readStats = (citySpecific: boolean) => {
      const rows = this.ctx.storage.sql
        .exec<{ decision: DiscoveryDecisionType; total: number }>(
          `SELECT decision, COUNT(*) AS total FROM discovery_decisions
           WHERE country = ? AND category = ?${citySpecific ? " AND city = ?" : ""}
           GROUP BY decision`,
          candidate.country || "MA",
          candidate.category,
          ...(citySpecific ? [candidate.city] : [])
        )
        .toArray();
      return {
        approved: rows.find((row) => row.decision === "approved")?.total || 0,
        rejected: rows.find((row) => row.decision === "rejected")?.total || 0,
        ignored: rows.find((row) => row.decision === "ignored")?.total || 0
      };
    };
    const cityStats = readStats(true);
    const cityTotal =
      cityStats.approved + cityStats.rejected + cityStats.ignored;
    return discoveryLearningAdjustment(
      cityTotal >= 3 ? cityStats : readStats(false)
    );
  }

  private async discoverLead(input: LeadInput) {
    input = {
      ...input,
      ...normalizeDiscoveryCandidate(input),
      country: "MA",
      observedIssues: input.observedIssues,
      recommendedService: input.recommendedService,
      notes: input.notes?.trim()
    };
    const key = leadDedupeKey(input);
    const existing = this.ctx.storage.sql
      .exec<{ id: string }>("SELECT id FROM leads WHERE dedupe_key = ?", key)
      .toArray()[0];
    if (existing) return { created: false, id: existing.id };

    let observation: PublicWebsiteObservation | undefined;
    const analysisIssues: ObservedIssue[] = [];
    if (input.websiteUrl) {
      try {
        observation = await analyzePublicBusinessWebsite(
          this.env.BROWSER,
          input.websiteUrl
        );
      } catch (error) {
        const analysisError = message(error);
        console.warn("Browser analysis did not complete", {
          reason: analysisError
        });
        let statusMatch = analysisError.match(/Website returned HTTP (\d{3})/);
        if (!statusMatch && /rate limit/i.test(analysisError)) {
          try {
            const response = await fetch(input.websiteUrl, {
              method: "HEAD",
              headers: { "user-agent": "ReelHaus-Manager/1.0" },
              signal: AbortSignal.timeout(8_000)
            });
            if (response.status >= 400)
              statusMatch = [String(response.status), String(response.status)];
          } catch {
            // A failed fallback is not evidence about the prospect's website.
          }
        }
        if (statusMatch)
          analysisIssues.push({
            code: "website_unavailable",
            detail: `Die öffentliche Website antwortete mit HTTP ${statusMatch[1]}.`,
            sourceUrl: input.websiteUrl,
            observedAt: new Date().toISOString(),
            verified: true,
            points: 25
          });
      }
    }
    const issues = [
      ...(input.observedIssues || []),
      ...(observation?.issues || []),
      ...analysisIssues
    ];
    const publicEmail =
      normalizeEmail(input.publicEmail) ||
      normalizeEmail(observation?.publicEmails[0]) ||
      null;
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const companyId = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO companies (
        id, dedupe_key, business_name, category, city, country, website_url,
        maps_url, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'MA', ?, ?, ?, ?)`,
      companyId,
      key,
      input.businessName.trim(),
      input.category,
      input.city.trim(),
      normalizeUrl(input.websiteUrl) || null,
      normalizeUrl(input.mapsUrl) || observation?.mapsLinks[0] || null,
      now,
      now
    );
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
      JSON.stringify([
        ...new Set([
          ...input.sourceUrls,
          ...(observation ? [observation.sourceUrl] : [])
        ])
      ]),
      JSON.stringify(issues),
      input.recommendedService || "ReelScan",
      "new",
      0,
      JSON.stringify([
        "Kein Opportunity Score: Gastronomie-Evidenz wird geprüft."
      ]),
      input.language || "fr",
      input.notes || "",
      now,
      now
    );
    if (input.pilot)
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO pilot_leads(lead_id, created_at) VALUES (?, ?)",
        id,
        now
      );
    const contactSource = input.sourceUrls[0] || input.websiteUrl || "";
    for (const [kind, value] of [
      ["email", publicEmail],
      ["phone", input.phone || observation?.phones[0] || null],
      ["whatsapp", input.whatsapp || observation?.whatsappLinks[0] || null]
    ] as const) {
      if (value)
        this.ctx.storage.sql.exec(
          `INSERT INTO contacts (
            id, lead_id, kind, value, source_url, observed_at, is_public
          ) VALUES (?, ?, ?, ?, ?, ?, 1)`,
          crypto.randomUUID(),
          id,
          kind,
          value,
          contactSource,
          now
        );
    }
    this.recordActivity(id, "system:discovery-agent", "lead.discovered", {
      sourceUrls: input.sourceUrls,
      publicInformationOnly: true,
      qualificationStarted: false,
      emailActionTaken: false
    });
    return { created: true, id };
  }

  private candidate(id: string): DiscoveryCandidate | null {
    const row = this.ctx.storage.sql
      .exec<SqlRow>("SELECT * FROM discovery_candidates WHERE id = ?", id)
      .toArray()[0];
    return row ? this.mapCandidate(row) : null;
  }

  private mapCandidate(row: SqlRow): DiscoveryCandidate {
    return {
      id: String(row.id),
      businessName: String(row.business_name),
      category: String(row.category) as DiscoveryCandidate["category"],
      city: String(row.city),
      country: String(row.country_code || row.country || "MA"),
      websiteUrl: row.website_url ? String(row.website_url) : undefined,
      mapsUrl: row.maps_url ? String(row.maps_url) : undefined,
      publicEmail: row.public_email ? String(row.public_email) : undefined,
      phone: row.phone ? String(row.phone) : undefined,
      whatsapp: row.whatsapp ? String(row.whatsapp) : undefined,
      socialLinks: parseJson<string[]>(String(row.social_links_json)),
      bookingLinks: parseJson<string[]>(String(row.booking_links_json)),
      languagesDetected: parseJson<string[]>(
        String(row.languages_json || "[]")
      ),
      latitude:
        row.latitude === null || row.latitude === undefined
          ? undefined
          : Number(row.latitude),
      longitude:
        row.longitude === null || row.longitude === undefined
          ? undefined
          : Number(row.longitude),
      discoverySource: row.discovery_source
        ? String(row.discovery_source)
        : undefined,
      sourceUrls: parseJson<string[]>(String(row.source_urls_json)),
      language: String(row.language) as OutreachLanguage,
      pilot: Boolean(row.is_pilot),
      confidence: String(row.confidence) as DiscoveryCandidate["confidence"],
      priorityScore: Number(row.priority_score || 0),
      priorityReasons: parseJson<string[]>(
        String(row.priority_reasons_json || "[]")
      ),
      learningAdjustment: Number(row.learning_adjustment || 0),
      status: String(row.status) as DiscoveryStatus,
      rejectionReason: row.rejection_reason
        ? String(row.rejection_reason)
        : null,
      discoveredAt: String(row.discovered_at),
      updatedAt: String(row.updated_at),
      leadId: row.lead_id ? String(row.lead_id) : null,
      scannedAt: row.scanned_at ? String(row.scanned_at) : null,
      approvedAt: row.approved_at ? String(row.approved_at) : null,
      ignoredAt: row.ignored_at ? String(row.ignored_at) : null,
      decidedBy: row.decided_by ? String(row.decided_by) : null
    };
  }

  private async sendCandidateToReelScan(id: string, request: Request) {
    const candidate = this.candidate(id);
    if (!candidate)
      return json({ error: "Discovery candidate not found" }, 404);
    if (["rejected", "ignored"].includes(candidate.status))
      return json(
        { error: "Rejected or ignored candidates cannot be scanned" },
        409
      );
    const body = (await request.json().catch(() => ({}))) as {
      force?: boolean;
    };
    if (candidate.leadId && !body.force)
      return json(
        {
          error:
            "Candidate was already scanned; an explicit manual rescan is required"
        },
        409
      );

    const now = new Date().toISOString();
    const previousStatus = candidate.status;
    this.ctx.storage.sql.exec(
      "UPDATE discovery_candidates SET status = 'analyzing', updated_at = ? WHERE id = ?",
      now,
      id
    );
    try {
      const result = candidate.leadId
        ? { created: false, id: candidate.leadId }
        : await this.discoverLead({
            businessName: candidate.businessName,
            category: candidate.category,
            city: candidate.city,
            country: "MA",
            websiteUrl: candidate.websiteUrl,
            mapsUrl: candidate.mapsUrl,
            publicEmail: candidate.publicEmail,
            phone: candidate.phone,
            whatsapp: candidate.whatsapp,
            sourceUrls: candidate.sourceUrls,
            language: candidate.language,
            pilot: candidate.pilot
          });
      if (!result.created && !candidate.leadId) {
        const duplicateAt = new Date().toISOString();
        this.ctx.storage.sql.exec(
          `UPDATE discovery_candidates SET status = 'ignored', lead_id = ?,
           rejection_reason = ?, ignored_at = ?, updated_at = ? WHERE id = ?`,
          result.id,
          "Merged with an existing canonical CRM business.",
          duplicateAt,
          duplicateAt,
          id
        );
        this.recordActivity(
          result.id,
          "system:autonomous-discovery-agent",
          "candidate.duplicate_skipped",
          {
            candidateId: id,
            canonicalLeadId: result.id,
            incomingBusinessName: candidate.businessName,
            detectedDuring: "reelscan_handoff",
            qualificationStarted: false,
            emailActionTaken: false
          }
        );
        return json({
          candidate: this.candidate(id),
          leadId: result.id,
          duplicateSkipped: true,
          reelScanCreated: false,
          qualificationRecommendationCreated: false,
          crmEntryCreated: false,
          emailActionTaken: false
        });
      }
      const auditResponse = await this.auditLead(result.id);
      if (!auditResponse.ok)
        throw new Error(`ReelScan returned HTTP ${auditResponse.status}`);
      const audit = (await auditResponse.json()) as ReelScanLeadAudit;
      const qualificationResponse = this.qualifyLead(result.id);
      if (!qualificationResponse.ok)
        throw new Error(
          `Qualification recommendation returned HTTP ${qualificationResponse.status}`
        );
      const completedAt = new Date().toISOString();
      const languageEvidence = audit.observations
        .filter((observation) => observation.signal === "languages")
        .flatMap(
          (observation) =>
            (observation.evidence || "").match(
              /\b[a-z]{2,3}(?:-[A-Z]{2})?\b/g
            ) || []
        );
      const languagesDetected = [
        ...new Set([
          ...(candidate.languagesDetected || []),
          ...languageEvidence.map((language) => language.toLocaleLowerCase())
        ])
      ];
      const learningAdjustment = this.discoveryLearningFor(candidate);
      const priority = calculateDiscoveryPriority(
        candidate,
        audit.observations,
        learningAdjustment
      );
      this.ctx.storage.sql.exec(
        `UPDATE discovery_candidates SET status = 'scanned',
         lead_id = ?, languages_json = ?, priority_score = ?,
         priority_reasons_json = ?, learning_adjustment = ?,
         scanned_at = ?, updated_at = ? WHERE id = ?`,
        result.id,
        JSON.stringify(languagesDetected),
        priority.score,
        JSON.stringify(priority.reasons),
        priority.learningAdjustment,
        completedAt,
        completedAt,
        id
      );
      this.recordActivity(
        result.id,
        request.headers.get("x-reelhaus-approver") || "authenticated-user",
        "candidate.scanned",
        {
          candidateId: id,
          manualRescan: Boolean(body.force),
          qualificationRecommendationCreated: true,
          crmEntryCreated: false,
          emailActionTaken: false
        }
      );
      return json(
        {
          candidate: this.candidate(id),
          leadId: result.id,
          reelScanCreated: true,
          qualificationRecommendationCreated: true,
          crmEntryCreated: false,
          emailActionTaken: false
        },
        201
      );
    } catch (error) {
      this.ctx.storage.sql.exec(
        "UPDATE discovery_candidates SET status = ?, updated_at = ? WHERE id = ?",
        previousStatus,
        new Date().toISOString(),
        id
      );
      throw error;
    }
  }

  private async recordCandidateDecision(id: string, request: Request) {
    const candidate = this.candidate(id);
    if (!candidate)
      return json({ error: "Discovery candidate not found" }, 404);
    const actor = request.headers.get("x-reelhaus-approver");
    if (!actor)
      return json({ error: "Authenticated human identity is required" }, 401);
    const body = (await request.json()) as { decision?: DiscoveryDecisionType };
    if (
      !body.decision ||
      !["approved", "rejected", "ignored"].includes(body.decision)
    )
      return json(
        { error: "decision must be approved, rejected or ignored" },
        400
      );
    if (body.decision === "approved") {
      const qualification = this.ctx.storage.sql
        .exec<{ id: string }>(
          "SELECT id FROM qualification WHERE lead_id = ? ORDER BY created_at DESC LIMIT 1",
          candidate.leadId || ""
        )
        .toArray()[0];
      if (!discoveryCandidateCanBeApproved(candidate, Boolean(qualification)))
        return json(
          { error: "Candidate must complete ReelScan and Qualification first" },
          409
        );
    }
    const decidedAt = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO discovery_decisions (
        id, candidate_id, decision, actor, category, city, country,
        priority_score, decided_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(candidate_id) DO UPDATE SET
        decision = excluded.decision, actor = excluded.actor,
        category = excluded.category, city = excluded.city,
        country = excluded.country, priority_score = excluded.priority_score,
        decided_at = excluded.decided_at`,
      crypto.randomUUID(),
      id,
      body.decision,
      actor,
      candidate.category,
      candidate.city,
      candidate.country,
      candidate.priorityScore,
      decidedAt
    );
    this.ctx.storage.sql.exec(
      `UPDATE discovery_candidates SET status = ?, rejection_reason = ?,
       approved_at = ?, ignored_at = ?, decided_by = ?, updated_at = ?
       WHERE id = ?`,
      body.decision,
      body.decision === "rejected"
        ? "Rejected by authenticated reviewer."
        : null,
      body.decision === "approved" ? decidedAt : null,
      body.decision === "ignored" ? decidedAt : null,
      actor,
      decidedAt,
      id
    );
    this.recordActivity(candidate.leadId, actor, `candidate.${body.decision}`, {
      candidateId: id,
      priorityScore: candidate.priorityScore,
      crmVisible: body.decision === "approved",
      emailActionTaken: false
    });
    return json({
      candidate: this.candidate(id),
      crmCreatedAutomatically: false
    });
  }

  private salesSnapshot() {
    const discoveryCandidates = this.ctx.storage.sql
      .exec<SqlRow>(
        "SELECT * FROM discovery_candidates ORDER BY discovered_at DESC LIMIT 300"
      )
      .toArray()
      .map((row) => this.mapCandidate(row));
    const allLeads = this.ctx.storage.sql
      .exec<SqlRow>(
        `SELECT leads.*,
          EXISTS(SELECT 1 FROM pilot_leads WHERE lead_id = leads.id) AS is_pilot
         FROM leads ORDER BY created_at DESC LIMIT 200`
      )
      .toArray()
      .map((row) => this.mapLead(row));
    const hiddenDiscoveryLeadIds = new Set(
      discoveryCandidates
        .filter(
          (candidate) =>
            candidate.leadId &&
            !discoveryCandidateIsCrmVisible(candidate.status)
        )
        .map((candidate) => candidate.leadId as string)
    );
    const leads = allLeads.filter(
      (lead) => !hiddenDiscoveryLeadIds.has(lead.id)
    );
    const drafts = this.ctx.storage.sql
      .exec<SqlRow>("SELECT * FROM drafts ORDER BY created_at DESC LIMIT 200")
      .toArray()
      .map((row) => this.mapDraft(row));
    const audits = this.ctx.storage.sql
      .exec<SqlRow>("SELECT * FROM audits ORDER BY created_at DESC LIMIT 200")
      .toArray()
      .map((row) => this.mapAudit(row));
    const qualifications = this.ctx.storage.sql
      .exec<SqlRow>(
        "SELECT * FROM qualification ORDER BY created_at DESC LIMIT 200"
      )
      .toArray()
      .map((row) => this.mapQualification(row));
    const emailReviews = this.ctx.storage.sql
      .exec<SqlRow>(
        "SELECT * FROM email_reviews ORDER BY created_at DESC LIMIT 200"
      )
      .toArray()
      .map((row) => this.mapEmailReview(row));
    const activities = this.ctx.storage.sql
      .exec<SqlRow>(
        "SELECT * FROM activities ORDER BY created_at DESC LIMIT 300"
      )
      .toArray()
      .map((row) => ({
        id: String(row.id),
        leadId: row.lead_id ? String(row.lead_id) : null,
        actor: String(row.actor),
        action: String(row.action),
        details: parseJson<Record<string, unknown>>(String(row.details_json)),
        createdAt: String(row.created_at)
      }));
    const qualityReviews = this.ctx.storage.sql
      .exec<SqlRow>(
        "SELECT * FROM lead_quality_reviews ORDER BY reviewed_at DESC LIMIT 300"
      )
      .toArray()
      .map((row) => this.mapQualityReview(row));
    const latestPilotReviews = leads
      .filter((lead) => lead.pilot)
      .map((lead) => qualityReviews.find((review) => review.leadId === lead.id))
      .filter((review): review is LeadQualityReview => Boolean(review));
    const average = (
      field: keyof Pick<
        LeadQualityReview,
        | "observationAccuracy"
        | "emailPersonalization"
        | "scoreUsefulness"
        | "relevance"
      >
    ) =>
      latestPilotReviews.length
        ? Number(
            (
              latestPilotReviews.reduce(
                (sum, review) => sum + review[field],
                0
              ) / latestPilotReviews.length
            ).toFixed(1)
          )
        : 0;
    const latestAuditsByLead = new Map<string, ReelScanLeadAudit>();
    for (const audit of audits)
      if (!latestAuditsByLead.has(audit.leadId))
        latestAuditsByLead.set(audit.leadId, audit);
    const latestAudits = [...latestAuditsByLead.values()];
    const latestReviewsByDraft = new Map<string, EmailReview>();
    for (const review of emailReviews)
      if (!latestReviewsByDraft.has(review.draftId))
        latestReviewsByDraft.set(review.draftId, review);
    const latestEmailReviews = [...latestReviewsByDraft.values()];
    const averageValue = (values: number[]) =>
      values.length
        ? Number(
            (
              values.reduce((sum, value) => sum + value, 0) / values.length
            ).toFixed(1)
          )
        : 0;
    const rejectedDraftIds = new Set([
      ...drafts
        .filter((draft) => draft.status === "rejected")
        .map((draft) => draft.id),
      ...latestEmailReviews
        .filter((review) => !review.approved)
        .map((review) => review.draftId)
    ]);
    return json({
      aiVersion: REELHAUS_AI_VERSION,
      discovery: {
        version: AUTONOMOUS_DISCOVERY_VERSION,
        candidates: discoveryCandidates,
        counts: Object.fromEntries(
          [
            "new",
            "queued",
            "analyzing",
            "scanned",
            "approved",
            "sent_to_reelscan",
            "rejected",
            "ignored",
            "qualified"
          ].map((status) => [
            status,
            discoveryCandidates.filter(
              (candidate) => candidate.status === status
            ).length
          ])
        ),
        metrics: {
          newToday: discoveryCandidates.filter(
            (candidate) =>
              candidate.discoveredAt.slice(0, 10) ===
              new Date().toISOString().slice(0, 10)
          ).length,
          queued: discoveryCandidates.filter((candidate) =>
            ["new", "queued"].includes(candidate.status)
          ).length,
          scanned: discoveryCandidates.filter((candidate) =>
            ["scanned", "sent_to_reelscan"].includes(candidate.status)
          ).length,
          approved: discoveryCandidates.filter((candidate) =>
            ["approved", "qualified"].includes(candidate.status)
          ).length,
          rejected: discoveryCandidates.filter(
            (candidate) => candidate.status === "rejected"
          ).length,
          ignored: discoveryCandidates.filter(
            (candidate) => candidate.status === "ignored"
          ).length,
          duplicatesSkipped: activities.filter(
            (activity) => activity.action === "candidate.duplicate_skipped"
          ).length
        },
        automaticQualification: false,
        qualificationRecommendationAfterScan: true,
        automaticCrmEntry: false,
        emailActionEnabled: false
      },
      mode: this.env.EMAIL_MODE || "draft_only",
      outreachEnabled: outreachIsEnabled(this.env.OUTREACH_ENABLED),
      limits: {
        newLeadsPerDay: boundedInt(this.env.MAX_DAILY_NEW_LEADS, 20, 100),
        sendsPerDay: boundedInt(this.env.MAX_DAILY_SENDS, 5, 25)
      },
      usage: this.usage(),
      metrics: {
        leadsFound: leads.length,
        analyzed: new Set(audits.map((audit) => audit.leadId)).size,
        qualified: qualifications.filter(
          (result) => result.recommendedStatus === "qualified"
        ).length,
        draftsWaiting: drafts.filter((draft) => draft.status === "draft_ready")
          .length,
        actionsNeeded:
          drafts.filter((draft) => draft.status === "draft_ready").length +
          qualifications.filter(
            (result) => result.recommendedStatus === "qualified"
          ).length
      },
      pilotMetrics: {
        pilotLeads: leads.filter((lead) => lead.pilot).length,
        reviewed: latestPilotReviews.length,
        realOpportunities: latestPilotReviews.filter(
          (review) => review.realOpportunity
        ).length,
        observationAccuracy: average("observationAccuracy"),
        emailPersonalization: average("emailPersonalization"),
        scoreUsefulness: average("scoreUsefulness"),
        relevance: average("relevance")
      },
      aiQuality: {
        averageObservationQuality: averageValue(
          latestAudits.map((audit) => audit.qualityMetrics.observationQuality)
        ),
        averagePersonalization: averageValue(
          latestEmailReviews.map((review) => review.personalization)
        ),
        rejectedDrafts: rejectedDraftIds.size,
        missingEvidence: latestAudits.reduce(
          (sum, audit) => sum + audit.qualityMetrics.missingEvidence,
          0
        )
      },
      leads,
      drafts,
      audits,
      qualifications,
      emailReviews,
      qualityReviews,
      activities
    });
  }

  private searchBusinesses(query: string) {
    const candidates = this.ctx.storage.sql
      .exec<SqlRow>(
        "SELECT * FROM discovery_candidates ORDER BY discovered_at DESC LIMIT 500"
      )
      .toArray()
      .map((row) => this.mapCandidate(row));
    const leads = this.ctx.storage.sql
      .exec<SqlRow>(
        `SELECT leads.*,
          EXISTS(SELECT 1 FROM pilot_leads WHERE lead_id = leads.id) AS is_pilot
         FROM leads ORDER BY discovered_at DESC LIMIT 500`
      )
      .toArray()
      .map((row) => this.mapLead(row));
    const leadsById = new Map(leads.map((lead) => [lead.id, lead]));
    const linkedLeadIds = new Set(
      candidates
        .map((candidate) => candidate.leadId)
        .filter((leadId): leadId is string => Boolean(leadId))
    );
    const candidateResults: BusinessSearchResult[] = candidates.map(
      (candidate) =>
        canonicalBusinessSearchResult(
          candidate,
          candidate.leadId ? leadsById.get(candidate.leadId) : undefined
        )
    );
    const standaloneLeadResults: BusinessSearchResult[] = leads
      .filter((lead) => !linkedLeadIds.has(lead.id))
      .map((lead) => ({
        id: lead.id,
        leadId: lead.id,
        candidateId: null,
        businessName: lead.businessName,
        category: lead.category,
        city: lead.city,
        country: lead.country,
        websiteUrl: lead.websiteUrl || null,
        status: lead.status,
        discoveredAt: lead.discoveredAt
      }));
    const results = [...candidateResults, ...standaloneLeadResults]
      .filter((result) => businessMatchesSearch(result, query))
      .sort((first, second) =>
        second.discoveredAt.localeCompare(first.discoveredAt)
      )
      .slice(0, 50);
    return json({
      version: BUSINESS_INTELLIGENCE_WORKSPACE_VERSION,
      query,
      results
    });
  }

  private businessWorkspace(id: string) {
    const candidateRow = this.ctx.storage.sql
      .exec<SqlRow>(
        "SELECT * FROM discovery_candidates WHERE id = ? OR lead_id = ? LIMIT 1",
        id,
        id
      )
      .toArray()[0];
    const candidate = candidateRow ? this.mapCandidate(candidateRow) : null;
    const leadId = candidate?.leadId || id;
    const lead = this.lead(leadId);
    if (!candidate && !lead)
      return json({ error: "Business profile not found" }, 404);
    const audits = lead
      ? this.ctx.storage.sql
          .exec<SqlRow>(
            "SELECT * FROM audits WHERE lead_id = ? ORDER BY created_at DESC LIMIT 50",
            lead.id
          )
          .toArray()
          .map((row) => this.mapAudit(row))
      : [];
    const qualifications = lead
      ? this.ctx.storage.sql
          .exec<SqlRow>(
            "SELECT * FROM qualification WHERE lead_id = ? ORDER BY created_at DESC LIMIT 50",
            lead.id
          )
          .toArray()
          .map((row) => this.mapQualification(row))
      : [];
    const drafts = lead
      ? this.ctx.storage.sql
          .exec<SqlRow>(
            "SELECT * FROM drafts WHERE lead_id = ? ORDER BY updated_at DESC LIMIT 50",
            lead.id
          )
          .toArray()
          .map((row) => this.mapDraft(row))
      : [];
    const reviews = lead
      ? this.ctx.storage.sql
          .exec<SqlRow>(
            `SELECT email_reviews.* FROM email_reviews
             JOIN drafts ON drafts.id = email_reviews.draft_id
             WHERE drafts.lead_id = ?
             ORDER BY email_reviews.created_at DESC LIMIT 100`,
            lead.id
          )
          .toArray()
          .map((row) => this.mapEmailReview(row))
      : [];
    const activityRows = this.ctx.storage.sql
      .exec<SqlRow>(
        `SELECT * FROM activities
         WHERE lead_id = ? OR lead_id IS NULL
         ORDER BY created_at DESC LIMIT 1000`,
        lead?.id || ""
      )
      .toArray();
    const activities = activityRows
      .map((row) => ({
        id: String(row.id),
        leadId: row.lead_id ? String(row.lead_id) : null,
        actor: String(row.actor),
        action: String(row.action),
        details: parseJson<Record<string, unknown>>(String(row.details_json)),
        createdAt: String(row.created_at)
      }))
      .filter(
        (activity) =>
          activity.leadId === lead?.id ||
          activity.details.candidateId === candidate?.id
      );
    const followUps: BusinessFollowUp[] = lead
      ? this.ctx.storage.sql
          .exec<SqlRow>(
            "SELECT * FROM followups WHERE lead_id = ? ORDER BY created_at DESC LIMIT 50",
            lead.id
          )
          .toArray()
          .map((row) => ({
            id: String(row.id),
            leadId: String(row.lead_id),
            draftId: row.draft_id ? String(row.draft_id) : null,
            sequence: Number(row.sequence),
            status: String(row.status),
            scheduledFor: row.scheduled_for ? String(row.scheduled_for) : null,
            createdAt: String(row.created_at),
            stoppedAt: row.stopped_at ? String(row.stopped_at) : null
          }))
      : [];
    const contactEvents: BusinessContactEvent[] = lead
      ? this.ctx.storage.sql
          .exec<SqlRow>(
            "SELECT * FROM outreach_events WHERE lead_id = ? ORDER BY occurred_at DESC LIMIT 100",
            lead.id
          )
          .toArray()
          .map((row) => ({
            id: String(row.id),
            leadId: String(row.lead_id),
            draftId: row.draft_id ? String(row.draft_id) : null,
            eventType: String(row.event_type),
            occurredAt: String(row.occurred_at),
            subject: row.subject ? String(row.subject) : null,
            approvedBy: row.approved_by ? String(row.approved_by) : null
          }))
      : [];
    return json({
      version: BUSINESS_INTELLIGENCE_WORKSPACE_VERSION,
      profile: buildBusinessWorkspace({
        lead,
        candidate,
        audits,
        qualifications,
        drafts,
        reviews,
        activities,
        followUps,
        contactEvents
      })
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
      observedIssues: parseJson<ObservedIssue[]>(
        String(row.observed_issues_json)
      ),
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
      nextFollowUpAt: row.next_follow_up_at
        ? String(row.next_follow_up_at)
        : null,
      doNotContact: Boolean(row.do_not_contact),
      notes: String(row.notes || ""),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      pilot: Boolean(row.is_pilot)
    };
  }

  private mapQualityReview(row: SqlRow): LeadQualityReview {
    return {
      id: String(row.id),
      leadId: String(row.lead_id),
      realOpportunity: Boolean(row.real_opportunity),
      observationAccuracy: Number(row.observation_accuracy),
      emailPersonalization: Number(row.email_personalization),
      scoreUsefulness: Number(row.score_usefulness),
      relevance: Number(row.relevance),
      notes: String(row.notes || ""),
      reviewedBy: String(row.reviewed_by),
      reviewedAt: String(row.reviewed_at)
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
      providerDraftId: row.provider_draft_id
        ? String(row.provider_draft_id)
        : null,
      providerThreadId: row.provider_thread_id
        ? String(row.provider_thread_id)
        : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  private mapAudit(row: SqlRow): ReelScanLeadAudit {
    const storedObservations = parseJson<ObservedIssue[]>(
      String(row.observations_json)
    );
    const lead = this.lead(String(row.lead_id));
    const rebuilt = lead
      ? ReelScanAuditAgent.analyze({
          ...lead,
          observedIssues: storedObservations
        })
      : null;
    return {
      id: String(row.id),
      leadId: String(row.lead_id),
      observations: rebuilt?.observations || [],
      framework:
        rebuilt?.framework ||
        ({
          guest_discovery: { label: "guest discovery", evaluations: [] },
          guest_decision: { label: "guest decision", evaluations: [] },
          guest_action: { label: "guest action", evaluations: [] }
        } satisfies ReelScanLeadAudit["framework"]),
      priorities:
        rebuilt?.priorities ||
        parseJson<ReelScanLeadAudit["priorities"]>(String(row.priorities_json)),
      recommendedService: String(
        row.recommended_service
      ) as ReelScanLeadAudit["recommendedService"],
      evidenceConfidence: rebuilt?.evidenceConfidence || "Low",
      verifiedOpportunityCount: rebuilt?.verifiedOpportunityCount || 0,
      opportunityScore: rebuilt?.opportunityScore ?? null,
      qualityMetrics:
        rebuilt?.qualityMetrics ||
        ({
          observationQuality: 0,
          businessRelevance: 0,
          personalization: 0,
          confidence: "Low",
          missingEvidence: 13
        } satisfies ReelScanLeadAudit["qualityMetrics"]),
      createdAt: String(row.created_at)
    };
  }

  private mapQualification(row: SqlRow): QualificationResult {
    const result = parseJson<{
      reasons: string[];
      recommendedStatus: QualificationResult["recommendedStatus"];
      opportunityScore?: number | null;
      evidenceConfidence?: QualificationResult["evidenceConfidence"];
      minimumEvidenceMet?: boolean;
    }>(String(row.result_json));
    return {
      id: String(row.id),
      leadId: String(row.lead_id),
      score: Number(row.score),
      opportunityScore: result.opportunityScore ?? null,
      evidenceConfidence: result.evidenceConfidence || "Low",
      minimumEvidenceMet: result.minimumEvidenceMet || false,
      criteria: parseJson<QualificationResult["criteria"]>(
        String(row.criteria_json)
      ),
      reasons: result.reasons,
      recommendedStatus: result.recommendedStatus,
      createdAt: String(row.created_at)
    };
  }

  private mapEmailReview(row: SqlRow): EmailReview {
    const draft = this.draft(String(row.draft_id));
    const lead = draft ? this.lead(draft.leadId) : null;
    const recalculated =
      draft && lead
        ? EmailReviewAgent.review(lead, draft, this.peerDraftOpenings(draft))
        : null;
    return {
      id: String(row.id),
      draftId: String(row.draft_id),
      draftVersion: Number(row.draft_version),
      score: Number(row.score),
      approved: Boolean(row.approved),
      personalization: recalculated?.personalization || 0,
      issues: parseJson<string[]>(String(row.issues_json)),
      rewrittenSubject: String(row.rewritten_subject),
      rewrittenBody: String(row.rewritten_body),
      createdAt: String(row.created_at)
    };
  }

  private lead(id: string): Lead | null {
    const row = this.ctx.storage.sql
      .exec<SqlRow>(
        `SELECT leads.*,
          EXISTS(SELECT 1 FROM pilot_leads WHERE lead_id = leads.id) AS is_pilot
         FROM leads WHERE leads.id = ?`,
        id
      )
      .toArray()[0];
    return row ? this.mapLead(row) : null;
  }

  private draft(id: string): EmailDraft | null {
    const row = this.ctx.storage.sql
      .exec<SqlRow>("SELECT * FROM drafts WHERE id = ?", id)
      .toArray()[0];
    return row ? this.mapDraft(row) : null;
  }

  private peerDraftOpenings(draft: EmailDraft): PeerDraftOpening[] {
    return this.ctx.storage.sql
      .exec<{
        body: string;
        business_name: string;
        city: string;
      }>(
        `SELECT drafts.body, leads.business_name, leads.city
         FROM drafts
         JOIN leads ON leads.id = drafts.lead_id
         WHERE drafts.id != ? AND drafts.lead_id != ?
         ORDER BY drafts.updated_at DESC
         LIMIT 100`,
        draft.id,
        draft.leadId
      )
      .toArray()
      .map((row) => ({
        businessName: row.business_name,
        city: row.city,
        firstParagraph: row.body.split(/\n\s*\n/, 1)[0].trim()
      }));
  }

  private async auditLead(id: string) {
    let lead = this.lead(id);
    if (!lead) return json({ error: "Lead not found" }, 404);
    if (lead.websiteUrl) {
      try {
        const observation = await analyzePublicBusinessWebsite(
          this.env.BROWSER,
          lead.websiteUrl
        );
        const mergedIssues = [
          ...lead.observedIssues,
          ...observation.issues
        ].filter(
          (issue, index, all) =>
            all.findIndex(
              (candidate) =>
                candidate.code === issue.code &&
                candidate.detail === issue.detail &&
                candidate.sourceUrl === issue.sourceUrl
            ) === index
        );
        const publicEmail =
          normalizeEmail(lead.publicEmail) ||
          normalizeEmail(observation.publicEmails[0]) ||
          null;
        const refreshedAt = new Date().toISOString();
        this.ctx.storage.sql.exec(
          `UPDATE leads SET observed_issues_json = ?, public_email = ?,
             score = ?, score_reasons_json = ?, updated_at = ? WHERE id = ?`,
          JSON.stringify(mergedIssues),
          publicEmail,
          0,
          JSON.stringify([
            "Kein Opportunity Score: aktualisierte Gastronomie-Evidenz wird geprüft."
          ]),
          refreshedAt,
          id
        );
        lead = this.lead(id);
        if (!lead) return json({ error: "Lead not found after refresh" }, 404);
      } catch (error) {
        console.warn("Lead website refresh did not complete", {
          leadId: id,
          reason: message(error)
        });
      }
    }
    if (!lead) return json({ error: "Lead not found after refresh" }, 404);
    const result = ReelScanAuditAgent.analyze(lead);
    const audit: ReelScanLeadAudit = {
      ...result,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString()
    };
    this.ctx.storage.sql.exec(
      `INSERT INTO audits (
        id, lead_id, observations_json, priorities_json,
        recommended_service, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      audit.id,
      audit.leadId,
      JSON.stringify(audit.observations),
      JSON.stringify(audit.priorities),
      audit.recommendedService,
      audit.createdAt
    );
    this.ctx.storage.sql.exec(
      "UPDATE leads SET recommended_service = ?, updated_at = ? WHERE id = ?",
      audit.recommendedService,
      audit.createdAt,
      id
    );
    this.recordActivity(id, "system:reelscan-audit-agent", "audit.completed", {
      auditId: audit.id,
      observationCount: audit.observations.length,
      qualityMetrics: audit.qualityMetrics,
      factsOnly: true
    });
    return json(audit, 201);
  }

  private qualifyLead(id: string) {
    const lead = this.lead(id);
    if (!lead) return json({ error: "Lead not found" }, 404);
    const auditRow = this.ctx.storage.sql
      .exec<SqlRow>(
        "SELECT * FROM audits WHERE lead_id = ? ORDER BY created_at DESC LIMIT 1",
        id
      )
      .toArray()[0];
    const result = QualificationAgent.qualify(
      lead,
      auditRow ? this.mapAudit(auditRow) : undefined
    );
    const qualification: QualificationResult = {
      ...result,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString()
    };
    this.ctx.storage.sql.exec(
      `INSERT INTO qualification (
        id, lead_id, score, criteria_json, result_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      qualification.id,
      id,
      qualification.score,
      JSON.stringify(qualification.criteria),
      JSON.stringify({
        reasons: qualification.reasons,
        recommendedStatus: qualification.recommendedStatus,
        opportunityScore: qualification.opportunityScore,
        evidenceConfidence: qualification.evidenceConfidence,
        minimumEvidenceMet: qualification.minimumEvidenceMet
      }),
      qualification.createdAt
    );
    this.ctx.storage.sql.exec(
      `UPDATE leads SET score = ?, score_reasons_json = ?, updated_at = ?
       WHERE id = ?`,
      qualification.score,
      JSON.stringify(qualification.reasons),
      qualification.createdAt,
      id
    );
    this.recordActivity(
      id,
      "system:qualification-agent",
      "qualification.recommended",
      {
        score: qualification.score,
        recommendedStatus: qualification.recommendedStatus,
        statusChanged: false
      }
    );
    return json(qualification, 201);
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
      if (!LEAD_STATUSES.includes(body.status))
        return json({ error: "Invalid status" }, 400);
      if (!canTransition(lead.status, body.status))
        return json({ error: "Invalid status transition" }, 409);
      if (body.status === "qualified") {
        const evidence = QualificationAgent.qualify(lead);
        if (!evidence.minimumEvidenceMet)
          return json(
            {
              error:
                "Lead cannot be qualified: minimum verified gastronomy evidence is not met"
            },
            409
          );
      }
    }
    const now = new Date().toISOString();
    const actor = request.headers.get("x-reelhaus-approver");
    if (!actor)
      return json({ error: "Authenticated human identity is required" }, 401);
    this.ctx.storage.sql.exec(
      `UPDATE leads SET status = ?, notes = ?, next_follow_up_at = ?,
       updated_at = ? WHERE id = ?`,
      body.status || lead.status,
      body.notes ?? lead.notes,
      body.nextFollowUpAt === undefined
        ? lead.nextFollowUpAt
        : body.nextFollowUpAt,
      now,
      id
    );
    if (body.status === "qualified")
      this.ctx.storage.sql.exec(
        `UPDATE discovery_candidates SET
         status = CASE WHEN status = 'approved' THEN 'approved' ELSE 'qualified' END,
         updated_at = ?
         WHERE lead_id = ?`,
        now,
        id
      );
    this.recordActivity(id, actor, "crm.updated", {
      previousStatus: lead.status,
      status: body.status || lead.status,
      notesChanged: body.notes !== undefined,
      nextActionChanged: body.nextFollowUpAt !== undefined
    });
    return json(this.lead(id));
  }

  private async createDraft(id: string, request: Request) {
    const lead = this.lead(id);
    if (!lead) return json({ error: "Lead not found" }, 404);
    if (!canContact(lead))
      return json({ error: "Lead must not be contacted" }, 409);
    if (!["qualified", "draft_ready", "contacted"].includes(lead.status))
      return json({ error: "Lead must be qualified before drafting" }, 409);
    if (!lead.publicEmail)
      return json({ error: "No public business email" }, 409);
    const evidence = QualificationAgent.qualify(lead);
    if (!evidence.minimumEvidenceMet)
      return json(
        {
          error:
            "Draft blocked: minimum verified gastronomy evidence is not met"
        },
        409
      );
    const actor = request.headers.get("x-reelhaus-approver");
    if (!actor)
      return json({ error: "Authenticated human identity is required" }, 401);
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
    const language = body.language || lead.language || "fr";
    const text = EmailSalesAgent.draft(lead, language, kind);
    const now = new Date().toISOString();
    const draftId = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      `INSERT INTO drafts (
        id, lead_id, language, subject, body, kind, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'draft_ready', ?, ?)`,
      draftId,
      id,
      language,
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
    if (kind !== "initial") {
      const sequence = kind === "follow_up_1" ? 1 : 2;
      this.ctx.storage.sql.exec(
        `INSERT INTO followups (
          id, lead_id, draft_id, sequence, status, created_at
        ) VALUES (?, ?, ?, ?, 'draft_only', ?)`,
        crypto.randomUUID(),
        id,
        draftId,
        sequence,
        now
      );
    }
    this.reviewDraft(draftId);
    this.recordActivity(id, actor, "email.draft_created", {
      draftId,
      kind,
      language,
      externalActionTaken: false
    });
    return json(this.draft(draftId), 201);
  }

  private async editDraft(id: string, request: Request) {
    const draft = this.draft(id);
    if (!draft) return json({ error: "Draft not found" }, 404);
    if (draft.status === "sent")
      return json({ error: "Sent draft is immutable" }, 409);
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
    this.reviewDraft(id);
    this.recordActivity(
      draft.leadId,
      request.headers.get("x-reelhaus-approver") || "authenticated-user",
      "email.draft_edited",
      { draftId: id, approvalInvalidated: true }
    );
    return json(this.draft(id));
  }

  private reviewDraft(id: string) {
    const draft = this.draft(id);
    if (!draft) return json({ error: "Draft not found" }, 404);
    const lead = this.lead(draft.leadId);
    if (!lead) return json({ error: "Lead not found" }, 404);
    const result = EmailReviewAgent.review(
      lead,
      draft,
      this.peerDraftOpenings(draft)
    );
    const review: EmailReview = {
      ...result,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString()
    };
    this.ctx.storage.sql.exec(
      `INSERT INTO email_reviews (
        id, draft_id, draft_version, score, approved, issues_json,
        rewritten_subject, rewritten_body, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      review.id,
      review.draftId,
      review.draftVersion,
      review.score,
      review.approved ? 1 : 0,
      JSON.stringify(review.issues),
      review.rewrittenSubject,
      review.rewrittenBody,
      review.createdAt
    );
    this.recordActivity(
      draft.leadId,
      "system:email-review-agent",
      "email.review_completed",
      {
        draftId: id,
        draftVersion: draft.version,
        score: review.score,
        approved: review.approved,
        personalization: review.personalization
      }
    );
    return json(
      {
        ...review,
        rewritten_subject: review.rewrittenSubject,
        rewritten_body: review.rewrittenBody
      },
      201
    );
  }

  private approveDraft(id: string, request: Request) {
    const draft = this.draft(id);
    if (!draft) return json({ error: "Draft not found" }, 404);
    const lead = this.lead(draft.leadId);
    if (!lead || !canContact(lead))
      return json({ error: "Lead must not be contacted" }, 409);
    if (draft.status !== "draft_ready")
      return json({ error: "Draft is not ready" }, 409);
    if (!draftHasRequiredOptOut(draft))
      return json({ error: "Opt-out is missing" }, 409);
    const review = this.ctx.storage.sql
      .exec<{ approved: number }>(
        `SELECT approved FROM email_reviews
         WHERE draft_id = ? AND draft_version = ?
         ORDER BY created_at DESC LIMIT 1`,
        id,
        draft.version
      )
      .toArray()[0];
    if (!review || review.approved === 0)
      return json(
        { error: "The current draft version must pass Email Review first" },
        409
      );
    const approvedBy = request.headers.get("x-reelhaus-approver");
    if (!approvedBy)
      return json({ error: "Approver identity is required" }, 401);
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
    this.recordActivity(draft.leadId, approvedBy, "email.approved", {
      draftId: id,
      draftVersion: draft.version,
      approvalAllowsOneMessage: true
    });
    return json({ approved: true, approvedBy, approvedAt: now });
  }

  private rejectDraft(id: string, request: Request) {
    const draft = this.draft(id);
    if (!draft) return json({ error: "Draft not found" }, 404);
    if (draft.status === "sent")
      return json({ error: "Sent draft is immutable" }, 409);
    this.ctx.storage.sql.exec("DELETE FROM approvals WHERE draft_id = ?", id);
    this.ctx.storage.sql.exec(
      "UPDATE drafts SET status = 'rejected', updated_at = ? WHERE id = ?",
      new Date().toISOString(),
      id
    );
    this.recordActivity(
      draft.leadId,
      request.headers.get("x-reelhaus-approver") || "authenticated-user",
      "email.rejected",
      { draftId: id }
    );
    return json({ rejected: true });
  }

  private doNotContact(id: string, request: Request) {
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
    this.ctx.storage.sql.exec(
      `UPDATE followups SET status = 'stopped', stopped_at = ?
       WHERE lead_id = ? AND stopped_at IS NULL`,
      now,
      id
    );
    this.recordEvent(id, null, "do_not_contact", { source: "dashboard" });
    this.recordActivity(
      id,
      request.headers.get("x-reelhaus-approver") || "authenticated-user",
      "contact.do_not_contact",
      { permanent: true }
    );
    return json({ doNotContact: true });
  }

  private async sendApprovedDraft(id: string) {
    if (!outreachIsEnabled(this.env.OUTREACH_ENABLED))
      return json(
        { error: "OUTREACH_ENABLED is false; sending is disabled" },
        409
      );
    if (String(this.env.EMAIL_MODE || "draft_only") === "draft_only")
      return json(
        { error: "EMAIL_MODE is draft_only; sending is disabled" },
        409
      );
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
      }>(
        "SELECT draft_version, approved_by, consumed_at FROM approvals WHERE draft_id = ?",
        id
      )
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
      "UPDATE approvals SET consumed_at = ? WHERE draft_id = ?",
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
    this.recordActivity(lead.id, approval.approved_by, "email.sent", {
      draftId: id,
      provider: delivery.provider
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
    this.ctx.storage.sql.exec(
      `UPDATE followups SET status = 'stopped', stopped_at = ?
       WHERE lead_id = ? AND stopped_at IS NULL`,
      now,
      id
    );
    this.recordEvent(id, null, body.type, {
      providerThreadId: body.providerThreadId,
      note: body.note?.slice(0, 500)
    });
    this.recordActivity(id, "system:inbound-event", `contact.${body.type}`, {
      followUpsStopped: true
    });
    return json({ recorded: true, followUpsStopped: true });
  }

  private async reviewLeadQuality(id: string, request: Request) {
    const lead = this.lead(id);
    if (!lead) return json({ error: "Lead not found" }, 404);
    if (!lead.pilot)
      return json({ error: "Quality review is limited to pilot leads" }, 409);
    const reviewedBy = request.headers.get("x-reelhaus-approver");
    if (!reviewedBy)
      return json(
        { error: "Authenticated reviewer identity is required" },
        401
      );
    const body = (await request.json()) as {
      realOpportunity?: boolean;
      observationAccuracy?: number;
      emailPersonalization?: number;
      scoreUsefulness?: number;
      relevance?: number;
      notes?: string;
    };
    const ratings = [
      body.observationAccuracy,
      body.emailPersonalization,
      body.scoreUsefulness,
      body.relevance
    ];
    if (
      typeof body.realOpportunity !== "boolean" ||
      ratings.some(
        (rating) =>
          !Number.isInteger(rating) || Number(rating) < 1 || Number(rating) > 5
      )
    )
      return json(
        { error: "Opportunity and all four ratings from 1 to 5 are required" },
        400
      );
    const review: LeadQualityReview = {
      id: crypto.randomUUID(),
      leadId: id,
      realOpportunity: body.realOpportunity,
      observationAccuracy: Number(body.observationAccuracy),
      emailPersonalization: Number(body.emailPersonalization),
      scoreUsefulness: Number(body.scoreUsefulness),
      relevance: Number(body.relevance),
      notes: (body.notes || "").trim().slice(0, 2_000),
      reviewedBy,
      reviewedAt: new Date().toISOString()
    };
    this.ctx.storage.sql.exec(
      `INSERT INTO lead_quality_reviews (
        id, lead_id, real_opportunity, observation_accuracy,
        email_personalization, score_usefulness, relevance, notes,
        reviewed_by, reviewed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      review.id,
      review.leadId,
      review.realOpportunity ? 1 : 0,
      review.observationAccuracy,
      review.emailPersonalization,
      review.scoreUsefulness,
      review.relevance,
      review.notes,
      review.reviewedBy,
      review.reviewedAt
    );
    this.recordActivity(id, reviewedBy, "pilot.quality_reviewed", {
      reviewId: review.id,
      realOpportunity: review.realOpportunity,
      observationAccuracy: review.observationAccuracy,
      emailPersonalization: review.emailPersonalization,
      scoreUsefulness: review.scoreUsefulness,
      relevance: review.relevance
    });
    return json(review, 201);
  }

  private exportReelScan(format: string) {
    if (!["csv", "json"].includes(format))
      return json({ error: "format must be csv or json" }, 400);
    const audits = this.ctx.storage.sql
      .exec<SqlRow>(
        `SELECT audits.*, leads.business_name, leads.category, leads.city,
          EXISTS(
            SELECT 1 FROM pilot_leads WHERE lead_id = leads.id
          ) AS is_pilot
         FROM audits JOIN leads ON leads.id = audits.lead_id
         ORDER BY audits.created_at DESC`
      )
      .toArray()
      .map((row) => {
        const audit = this.mapAudit(row);
        return {
          businessName: String(row.business_name),
          category: String(row.category),
          city: String(row.city),
          pilot: Boolean(row.is_pilot),
          recommendedService: audit.recommendedService,
          evidenceConfidence: audit.evidenceConfidence,
          opportunityScore: audit.opportunityScore,
          verifiedOpportunityCount: audit.verifiedOpportunityCount,
          framework: audit.framework,
          reportCreatedAt: audit.createdAt,
          priorities: audit.priorities
        };
      });
    if (format === "json")
      return new Response(
        JSON.stringify(
          { exportedAt: new Date().toISOString(), audits },
          null,
          2
        ),
        {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "content-disposition":
              'attachment; filename="reelscan-reports.json"',
            "cache-control": "no-store"
          }
        }
      );
    const rows = [
      [
        "business_name",
        "category",
        "city",
        "pilot",
        "recommended_service",
        "priority",
        "guest_stage",
        "signal",
        "evidence",
        "observation",
        "guest_impact",
        "confidence",
        "suggestion",
        "source_url",
        "observed_at",
        "report_created_at"
      ]
    ];
    for (const audit of audits) {
      let added = false;
      for (const priority of ["critical", "important", "optional"] as const) {
        for (const issue of audit.priorities[priority]) {
          rows.push([
            audit.businessName,
            audit.category,
            audit.city,
            audit.pilot ? "true" : "false",
            audit.recommendedService,
            priority,
            issue.journeyStage || "",
            issue.signal || issue.code,
            issue.evidence || issue.detail,
            issue.detail,
            issue.impact || "",
            issue.confidence || "Low",
            issue.suggestion || "",
            issue.sourceUrl,
            issue.observedAt,
            audit.reportCreatedAt
          ]);
          added = true;
        }
      }
      if (!added)
        rows.push([
          audit.businessName,
          audit.category,
          audit.city,
          audit.pilot ? "true" : "false",
          audit.recommendedService,
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          audit.reportCreatedAt
        ]);
    }
    return new Response(
      rows.map((row) => row.map(csvCell).join(",")).join("\n"),
      {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": 'attachment; filename="reelscan-reports.csv"',
          "cache-control": "no-store"
        }
      }
    );
  }

  private async businessAssistant(request: Request) {
    const body = (await request.json()) as {
      leadId?: string;
      type?:
        | "lead_summary"
        | "client_brief"
        | "proposal_outline"
        | "meeting_notes";
    };
    if (!body.leadId) return json({ error: "leadId is required" }, 400);
    if (
      !body.type ||
      ![
        "lead_summary",
        "client_brief",
        "proposal_outline",
        "meeting_notes"
      ].includes(body.type)
    )
      return json({ error: "Invalid assistant output type" }, 400);
    const lead = this.lead(body.leadId);
    if (!lead) return json({ error: "Lead not found" }, 404);
    const output = BusinessAssistantAgent.prepare(lead, body.type);
    this.recordActivity(
      lead.id,
      request.headers.get("x-reelhaus-approver") || "authenticated-user",
      "assistant.output_created",
      { type: body.type, externalActionTaken: false }
    );
    return json(output, 201);
  }

  private recordActivity(
    leadId: string | null,
    actor: string,
    action: string,
    details: Record<string, unknown>
  ) {
    this.ctx.storage.sql.exec(
      `INSERT INTO activities (
        id, lead_id, actor, action, details_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      leadId,
      actor,
      action,
      JSON.stringify(details),
      new Date().toISOString()
    );
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
    this.persistGuardianReport(report);
    return json(report, 201);
  }

  private persistGuardianReport(report: AuditReport) {
    this.ctx.storage.sql.exec(
      "INSERT INTO reports VALUES (?, ?, ?, ?)",
      report.id,
      report.createdAt,
      JSON.stringify(report.summary),
      JSON.stringify(report)
    );
  }

  private async triggerReelScanV1ClientZero() {
    const { result, report } = await runReelScanV1ClientZero({
      ai: this.env.AI,
      auditLedger: this.auditLedger,
      fetcher: fetch
    });
    this.persistGuardianReport(report);
    this.recordActivity(
      null,
      "system:reelscan-v1",
      "reelscan_v1.client_zero_scanned",
      {
        scanId: result.scanId,
        evidenceCount: result.evidence.length,
        findingCount: result.findings.length,
        analysisRunStatus: result.analysisRun.status,
        recommendedAction: result.recommendation?.action ?? null,
        reviewStatus: result.reviewStatus
      }
    );
    return json(result, result.analysisRun.status === "failed" ? 503 : 201);
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
      .exec<{ report_json: string }>(
        "SELECT report_json FROM reports WHERE id = ?",
        id
      )
      .toArray()[0];
    return row
      ? json(parseJson<AuditReport>(row.report_json))
      : json({ error: "Report not found" }, 404);
  }
}
