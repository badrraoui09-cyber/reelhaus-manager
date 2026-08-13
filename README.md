# ReelHaus Manager

Private Cloudflare Agent for the ReelHaus website guardian and controlled sales
outreach. The safe test configuration uses `EMAIL_MODE=mock` together with the
independent kill switch `OUTREACH_ENABLED=false`; deployment cannot call an
email provider.

## Safety model

- Only restaurants, cafés, bakeries, riads and small hotels in Morocco are
  accepted.
- Every lead requires at least one public source URL.
- Private or non-public contact data must not be entered.
- Autonomous Discovery v1.0 processes a controlled queue and optionally reads
  configured public JSON-LD directory pages. It does not scrape Google search,
  bypass CAPTCHA/login, or buy/import address lists.
- Browser Run checks `robots.txt`, uses a declared bot user agent and never
  submits forms.
- Qualification and drafting require at least three verified gastronomy
  opportunities across at least two guest-journey stages. Missing evidence is
  recorded as a coverage gap and never earns qualification points.
- Editing invalidates an existing approval.
- One current approval is atomically consumed before the provider call and can
  trigger at most one provider attempt.
- `OUTREACH_ENABLED=false` blocks every provider call before an approval is
  consumed.
- Reply, bounce, opt-out and `do_not_contact` stop pending follow-ups.
- At most two follow-up drafts are allowed, with seven days between contacts by
  default.
- No recipient, message body or OAuth token is written to logs.
- Default daily limits are 20 new leads and 5 sends.

## Architecture

```text
Cloudflare Access
       │ verified Access JWT (or local-development token)
       ▼
Worker + React dashboard
       │
       ▼
ReelHausManager (Cloudflare Agents SDK + SQLite Durable Object)
  ├─ reelhaus-principles ─ shared identity, evidence, hospitality and writing rules
  ├─ Business Intelligence Workspace v1.0
  │    └─ protected search and evidence-only cross-module profiles
  ├─ AutonomousDiscoveryAgent v1.0
  │    └─ public JSON-LD sources, identity deduplication, review priority
  ├─ ReelScanAuditAgent ─ verified observations and priorities
  ├─ QualificationAgent ─ transparent 0–100 recommendation
  ├─ EmailSalesAgent ─ French/Arabic drafts only
  ├─ EmailReviewAgent ─ mandatory quality and claims gate
  ├─ FollowUpAgent ─ maximum two controlled drafts
  ├─ BusinessAssistantAgent ─ internal facts-only documents
  ├─ Website Guardian ─ read-only ReelHaus FR/AR audit
  └─ EmailProvider
       ├─ MockEmailProvider
       └─ GmailEmailProvider
```

The scheduled handler processes queued public candidates and up to five
explicitly configured public source pages at `07:00 UTC`. It respects
`robots.txt`, reads only public HTML without login, processes at most one source
page per host in a run and never exceeds 20 accepted candidates per day.
Discovery creates candidates only. A signed-in human starts ReelScan, reviews
its evidence and the existing Qualification recommendation, then separately
approves the candidate for CRM visibility. No discovery path sends email.

### Autonomous Discovery Agent v1.0

`src/discovery-agent.ts` is a source-independent research and filtering layer.
It normalizes public facts, deduplicates by website host, normalized phone,
coordinates, Maps URL and normalized business name/city, merges source
provenance, and rejects closed, unclear, non-hospitality or insufficiently
evidenced businesses. The active market is Morocco; the country field and
policy boundary allow later markets to be added deliberately.

Discovery confidence is separate from ReelScan evidence confidence:

- **High:** at least two public sources plus at least two identity/contact
  signals;
- **Medium:** a valid public source plus a website or other sufficient signals;
- **Low:** insufficient information; the candidate is rejected rather than
  qualified.

Accepted records use `New`, `Queued`, `Analyzing`, `Scanned`, `Approved`,
`Rejected` and `Ignored` queue states; legacy `Sent to ReelScan` and `Qualified`
records remain readable. Missing email is allowed and is never invented; it
does not enable outreach.

The Discovery Priority Score orders manual review only. It explains each
public or verified signal (website, contact/social presence, menu, mobile,
language and booking observations) and is never used as an Opportunity or
Qualification Score. Manual decisions are retained per candidate. After at
least three decisions for a similar category/city, the historical approval
pattern may adjust future priority by at most ±10 points; qualification rules
remain unchanged.

### Business Intelligence Workspace v1.0

The workspace is a read-only intelligence projection across the existing
Discovery, ReelScan, Qualification, CRM, Follow-up, Email Review and activity
records. It introduces no alternate scoring, evidence editing, automatic CRM
transition or external action. Search returns compact identity summaries; the
complete profile is loaded only after selection for fast initial rendering.

Each profile shows:

- business identity and public contact facts;
- Discovery source, confidence, explainable priority, deduplication state and
  learning adjustment;
- latest ReelScan, all stored scans, coverage and a deterministic previous-scan
  comparison;
- website health derived from existing public ReelScan evidence, grouped into
  SEO, UX and accessibility findings;
- an explicit performance limitation because current ReelScan does not collect
  performance timing;
- immutable Qualification history and missing-evidence reasons;
- CRM stage, notes, unassigned owner state, follow-ups, contact events and
  status timeline;
- latest controlled email draft and its matching Email Review;
- a facts-only summary of why the business may be interesting, its largest
  verified opportunities and the next manual step.

The profile works for pre-CRM Discovery candidates and approved CRM leads.
Candidate staging remains hidden from CRM until the existing manual approval
gate is completed.

### Master Intelligence Layer

`src/reelhaus-principles.ts` is the shared operating policy above the existing
agents. Version `REELHAUS_AI_VERSION = "1.0"` identifies the current policy
contract. It does not replace ReelScan intelligence, evidence gates,
qualification or human approval. It defines:

- ReelHaus identity and the primary Morocco hospitality categories;
- quality over quantity and evidence before recommendation;
- the guest discovery, decision and action framework;
- the hospitality signals shared by ReelScan and Qualification;
- the four internal pre-output questions;
- human, respectful, concise and professional customer writing rules;
- unsupported commercial claims and generic agency-language detection;
- separate 0–5 observation quality, business relevance and personalization
  evaluation plus `High`/`Medium`/`Low` confidence.

Agents do not receive new external permissions from this module. It is a
deterministic, side-effect-free intelligence and quality layer.

## Lead data

The API exposes the requested fields using camelCase:

- `id`, `businessName`, `category`, `city`, `country`
- `websiteUrl`, `mapsUrl`, `publicEmail`, `phone`, `whatsapp`
- `discoveredAt`, `sourceUrls`, `observedIssues`, `recommendedService`
- `status`, `lastContactedAt`, `nextFollowUpAt`, `doNotContact`, `notes`
- transparent `score` and `scoreReasons`

Allowed CRM statuses:

`new`, `analyzing`, `discovered` (legacy), `qualified`, `draft_ready`,
`approved`, `contacted`, `replied`, `meeting`, `meeting_requested` (legacy),
`proposal_sent`, `won`, `lost`, `do_not_contact`.

Automated qualification writes a recommendation and score, but it does not
change the customer status. A signed-in human must confirm CRM status changes.

## SQLite schema

The single SQLite Durable Object creates and safely retains:

- `reports` — Website Guardian reports;
- `companies` — deduplicated Morocco business identity;
- `leads` — lead fields, unique deduplication key, score and status;
- `audits` — sourced ReelScan observations, priorities and service; deterministic
  AI-quality metrics are rebuilt from these stored facts;
- `qualification` — immutable score runs with four explicit criteria;
- `email_drafts` — canonical versioned French/Arabic draft history;
- `drafts` — compatibility table mirrored into `email_drafts`;
- `email_reviews` — score, verdict, issues and safe rewrite per version;
- `approvals` — approver, timestamp, approved version and one-time consumption;
- `contacts` — public contact value with source and observation date;
- `followups` — sequence 1–2, schedule and permanent stop state;
- `activities` — actor, action and non-sensitive audit details;
- `outreach_events` — sent/reply/bounce/opt-out audit log and Gmail thread IDs;
- `daily_usage` — per-day discovery and send counters;
- `discovery_queue` — controlled candidate input and processing outcome;
- `discovery_candidates` — deduplicated public candidate facts, confidence,
  provenance, detected languages, optional coordinates, review priority,
  decision timestamps, queue status and optional ReelScan staging link;
- `discovery_identities` — unique website, phone, coordinate, Maps and
  normalized name/city keys mapped to a candidate;
- `discovery_decisions` — authenticated human approve, reject or ignore
  decision used only for future Discovery prioritization;
- `pilot_leads` — explicit label for real-world test leads;
- `lead_quality_reviews` — immutable human ratings for opportunity, observation
  accuracy, email personalization, score usefulness and relevance.

`do_not_contact` is stored on the lead and cannot be bypassed by changing a
draft. Pending drafts and approvals are revoked when contact must stop.

## Configuration

Install Node.js 22+, npm 11 and dependencies:

```bash
npm install
cp .dev.vars.example .dev.vars
npm run types
```

Safe local commands:

```bash
npm run check
npm test
npm run build
npm run dev
```

This is a Cloudflare Vite-plugin project. The input `wrangler.jsonc` deliberately
does not set `assets.directory`; `vite build` generates the deployment
configuration and points it at `dist/client`. Always run the Vite build before
`wrangler deploy`. Cloudflare Workers Builds must use `npm run build` as the
build command and `npx wrangler deploy` as the deploy command.

### Non-secret variables

Configured in `wrangler.jsonc`:

- `EMAIL_MODE=mock`
- `OUTREACH_ENABLED=false`
- `MAX_DAILY_NEW_LEADS=20`
- `MAX_DAILY_SENDS=5`
- `MIN_FOLLOW_UP_DAYS=7`

Optional discovery configuration:

- `DISCOVERY_OSM_ENABLED` — enables one rate-limited OpenStreetMap Overpass
  hospitality lookup per UTC day. The agent rotates a small city area and one
  hospitality category to keep the request bounded. Production uses `true`;
  local development defaults to `false`. Results remain candidates and never
  enter CRM or outreach automatically.
- `DISCOVERY_SOURCE_URLS` — comma-separated public directory/source pages with
  hospitality `application/ld+json`. Leave unset to process only candidates
  entered through the private queue in addition to the optional OpenStreetMap
  lookup. It is not a secret.

Supported email modes:

- `draft_only` — no provider call and no send;
- `mock` — tests the complete approval flow without real email;
- `gmail` — creates a Gmail draft and sends it only after a current approval.

`OUTREACH_ENABLED` must also be explicitly changed to `true` before any provider
call is possible. Review the code, Cloudflare Access and Gmail setup before
changing either safety setting.

## Required bindings

- `ASSETS` — Vite static assets
- `REELHAUS_MANAGER` — SQLite Durable Object
- `BROWSER` — Cloudflare Browser Run
- Cron trigger `0 7 * * *`

The Browser Run binding follows Cloudflare's official `browser.binding`
configuration and requires a plan with Browser Run enabled.

## Secrets

Set these through Cloudflare Secrets; never put their real values in the
repository:

```bash
npx wrangler secret put CF_ACCESS_TEAM_DOMAIN
npx wrangler secret put CF_ACCESS_AUD
```

Copy `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` from the real Cloudflare Access
application. Never guess either value. `GUARDIAN_API_TOKEN` belongs only in a
local `.dev.vars` file; do not create it as a production secret.
`ALLOW_LOCAL_BEARER_AUTH` is `false` in `wrangler.jsonc` and must remain false
in production.

## Cloudflare Access

1. In Workers & Pages, open `reelhaus-manager`.
2. Go to Settings > Domains & Routes.
3. On `reelhaus-manager.badrraoui09.workers.dev`, select **Enable Cloudflare
   Access**.
4. Open **Manage Cloudflare Access** and configure the generated Self-hosted
   application.
5. Add an **Allow** policy whose Include rule is the explicitly authorized
   email address. Do not add Everyone, Bypass or email-domain-wide access.
6. In Zero Trust > Settings, copy the actual team domain, including
   `.cloudflareaccess.com`, to the `CF_ACCESS_TEAM_DOMAIN` Worker secret.
7. In Zero Trust > Access controls > Applications, configure the ReelHaus
   application and copy its Application Audience (AUD) tag from Additional
   settings to the `CF_ACCESS_AUD` Worker secret.
8. Reload the Worker URL and complete the Access login before testing the API.

The Worker verifies the `Cf-Access-Jwt-Assertion` signature against Cloudflare's
JWKS and checks issuer, audience and expiry. It does not trust a caller-supplied
email header. API authentication failures distinguish missing configuration,
missing login and a rejected JWT without returning secrets or token details.
The production dashboard sends same-origin credentials explicitly and does not
show the local bearer-token form.

## Gmail OAuth setup

Gmail is implemented but intentionally inactive.

1. Create a Google Cloud project and enable the Gmail API.
2. Configure the OAuth consent screen for ReelHaus Manager.
3. Create a Web application OAuth client.
4. Request only
   `https://www.googleapis.com/auth/gmail.compose`.
   This restricted scope is required because the integration creates Gmail
   drafts and later sends them. `gmail.send` alone cannot create drafts.
5. Complete Google's required test-user, verification and—where applicable—
   restricted-scope security assessment process.
6. Perform the one-time server-side OAuth authorization outside this
   repository. Request offline access and obtain a refresh token.
7. Store client ID, client secret and refresh token as Cloudflare Secrets.
8. Test first with `EMAIL_MODE=mock`.
9. After human review, change `EMAIL_MODE` to `gmail` and redeploy manually.

Access tokens are obtained server-side from Google's token endpoint and held
only in request memory. OAuth tokens are never returned to the browser or logged.

## Dashboard

The private React dashboard contains:

- **Overview** — leads found, analyzed and qualified, pending drafts, actions,
  aggregate real-world pilot quality and a visible **AI Quality** section;
- **Business Workspace** — global search and one responsive profile combining
  Discovery, ReelScan, website health, Qualification, CRM, Email Review,
  evidence-only insights and a chronological timeline;
- **Discovery Queue** — new/queued/scanned/approved/rejected/duplicate metrics,
  explainable priority, public website link and explicit Scan, Approve, Reject,
  Ignore and manual Rescan actions;
- **Leads** — city/category/opportunity/status filters and controlled public candidate
  input, a pilot label and manual lead-quality review;
- **ReelScan Reports** — the Gastronomy ReelScan framework with Evidence,
  Observation, Guest Impact, Confidence and protected CSV/JSON export;
- **Email Review** — edit, review, apply safe rewrite, approve or reject;
- **CRM Pipeline** — human-controlled status and internal lead brief;
- **Settings** — read-only safe-mode and daily-limit visibility;
- **Website Guardian** — read-only ReelHaus `/fr/` and `/ar/` audit.

Cloudflare Access protects every API. The frontend uses same-origin
credentials. Local bearer authentication is available only when
`ALLOW_LOCAL_BEARER_AUTH=true` in local development.

## Real-world pilot mode

Mark a candidate as a pilot lead before adding it to the discovery queue. Pilot
mode does not change email or outreach safety: keep `EMAIL_MODE=mock` and
`OUTREACH_ENABLED=false`. After ReelScan and draft review, expand **Leadqualität
manuell prüfen** on the lead and record:

- whether a real commercial opportunity exists;
- observation accuracy, email personalization, score usefulness and target
  relevance on a 1–5 scale;
- internal evidence notes.

The Overview aggregates the latest human review for each pilot lead. CSV and
JSON ReelScan exports remain protected by Cloudflare Access and contain sourced
observations, not OAuth tokens or private request data. If Browser Run is
temporarily unavailable, the Worker uses a limited, robots-aware public HTML
fallback and labels its observations accordingly.

## Gastronomy ReelScan framework

Every audit evaluates thirteen signals:

- **Guest discovery:** Google visibility signals, contact availability and
  location information;
- **Guest decision:** menu accessibility, food/service information, photos,
  languages and trust signals;
- **Guest action:** phone, WhatsApp, reservation, ordering and directions.

Each evaluation is stored as a verified strength, a verified opportunity or an
explicit coverage gap. It includes public evidence, the precise observation,
guest impact and `High`/`Medium`/`Low` evidence confidence. A verified
opportunity also receives one realistic recommendation that directly solves
its observed signal. A coverage gap receives no recommendation. A limited
static-HTML absence receives Low confidence and cannot qualify a lead by
itself.

Impact and recommendation guidance is contextual rather than a signal-only
template. When facts are available, it uses business category, city, verified
language context and existing strengths such as a public phone or email. The
impact connects the observed issue to likely guest behavior and a possible
consequence. The recommendation names the business and prescribes the
signal-specific action, such as menu access, opening hours, reservation,
contact or directions. A central guidance check rejects generic advice and
rewrites it before an audit is returned.

Every audit also returns separate Master Intelligence quality metrics:

- observation quality, 0–5;
- business relevance, 0–5;
- personalization readiness, 0–5;
- evidence confidence, `High`/`Medium`/`Low`;
- number of missing-evidence signals.

The dashboard does not collapse these into one opaque score. **AI Quality**
shows average observation quality, average reviewed-draft personalization,
rejected drafts and missing evidence.

An Opportunity Score is calculated only when at least three verified
opportunities with Medium or High confidence cover at least two guest stages.
Business category, email availability and missing research data never create an
Opportunity Score.

## Controlled workflow

1. Queue a business with category, city and public source.
2. Run discovery manually or wait for Cron.
3. Discovery validates the Morocco hospitality fit, merges duplicates, records
   confidence and creates a candidate only.
4. A signed-in human starts **Scan now**; the candidate is still hidden from CRM.
5. Browser Run records public website observations and sources.
6. ReelScan stores all thirteen signal evaluations with evidence and confidence.
7. Qualification recommends `new` or `qualified` only after the evidence
   threshold is met; otherwise no Opportunity Score exists.
8. A human chooses **Approve → CRM**, Reject or Ignore. Only approval makes the
   staged lead visible in CRM; no status is changed automatically.
9. Generate a French or Arabic draft containing a specific observation, why it
   matters to guests and one realistic suggestion.
10. Mandatory Email Review rejects reusable generic openings and checks
    restaurant/city uniqueness, evidence, guest impact, suggestion, claims,
    language, ReelScan, opt-out and length. Every edit invalidates approval.
11. Approve or reject. The Access identity, time and exact version are stored.
12. In `draft_only`, sending remains blocked.
13. In `mock` or manually enabled `gmail`, “send” consumes the approval once.
14. Record reply, bounce or opt-out against the lead/thread. Follow-ups stop.

The email always offers ReelScan as a low-risk first step, contains no invented
claims or guarantees, and includes a polite permanent opt-out.

## API

All `/api/*` routes require a valid Cloudflare Access JWT or the local bearer
token.

- `GET /api/auth/diagnostic`
- `GET /api/sales`
- `GET /api/businesses/search?q=...`
- `GET /api/businesses/:id/workspace`
- `POST /api/discovery/queue`
- `POST /api/discovery/run`
- `POST /api/discovery/candidates/:id/reelscan`
- `POST /api/discovery/candidates/:id/scan`
- `POST /api/discovery/candidates/:id/decision`
- `GET /api/reelscan/export?format=csv|json`
- `PATCH /api/leads/:id`
- `POST /api/leads/:id/draft`
- `POST /api/leads/:id/audit`
- `POST /api/leads/:id/qualify`
- `POST /api/leads/:id/quality-review`
- `POST /api/leads/:id/events`
- `POST /api/leads/:id/do-not-contact`
- `PATCH /api/drafts/:id`
- `POST /api/drafts/:id/review`
- `POST /api/drafts/:id/approve`
- `POST /api/drafts/:id/reject`
- `POST /api/drafts/:id/send`
- `POST /api/assistant`
- `POST /api/scan`
- `GET /api/reports`
- `GET /api/reports/:id`

The protected diagnostic route returns only `accessConfigured`,
`accessJwtPresent`, `emailMode` and `outreachEnabled`. It never returns a token,
JWT, email address, issuer, secret or request headers.

No OAuth callback, MCP, DNS, Netlify, GitHub or publishing endpoint is exposed.

## Tests

Tests cover:

- lead deduplication;
- Business Workspace search across identity/status fields, evidence-only
  insights, scan comparison, explicit performance limitations and no score
  without evidence;
- Discovery candidate merging, website/phone/coordinate/name deduplication,
  target-market filtering, missing-email behavior, missing-website evidence
  requirements, priority explanations, conservative decision learning,
  CRM-visibility gate, closed-business rejection, JSON-LD extraction and
  robots.txt enforcement;
- evidence-gated Opportunity Score calculation;
- allowed status transitions;
- permanent do-not-contact enforcement;
- outreach kill-switch enforcement;
- follow-up count and interval limits;
- current, single-use approval rules;
- opt-out requirement;
- Mock provider behavior;
- Gmail missing-secret and API-error behavior;
- `robots.txt` and Browser Run failure behavior;
- Website Guardian report summarization;
- sourced-only ReelScan facts and rejection of unverified claims;
- all thirteen Gastronomy ReelScan signals across the three guest stages;
- no qualification or Opportunity Score without minimum evidence;
- French quality and Arabic RTL drafting;
- rejection of generic reusable outreach and approval of specific
  restaurant/guest-impact/suggestion outreach;
- removal and rejection of fake promises;
- removal of unsupported claims such as `We increase reservations`;
- central ReelHaus identity, guest journey and pre-output rules;
- independent observation, relevance and personalization metrics;
- restaurant-context impact and signal-specific recommendation generation;
- rejection and rewrite of generic audit recommendations;
- no recommendation when evidence is missing;
- internal assistant output with no external action;
- protected API authentication without an Access JWT.

Automated tests never select the Gmail provider with real credentials.

## Not activated

- real Gmail sending (`EMAIL_MODE=mock`, no Gmail secrets);
- all provider calls (`OUTREACH_ENABLED=false`);
- automatic inbox reading or Gmail reply polling;
- Gmail Pub/Sub watch/webhook;
- automated Google Maps discovery;
- automatic sending of initial or follow-up email;
- autonomous CRM status changes;
- unrestricted crawling or Google/Maps search discovery;
- external proposal delivery, meeting scheduling or customer updates;
- external list imports;

Replies, bounces and opt-outs can currently be recorded through the authenticated
event endpoint/dashboard workflow. Automatic Gmail inbox synchronization would
require additional read scopes and infrastructure and must receive a separate
privacy/security review.
