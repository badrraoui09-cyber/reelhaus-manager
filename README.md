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
- Discovery processes a controlled queue; it does not scrape Google search,
  bypass CAPTCHA/login, or buy/import address lists.
- Browser Run checks `robots.txt`, uses a declared bot user agent and never
  submits forms.
- A verified observation is required before an outreach draft can be created.
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
       │ verified Access JWT (or local dev token)
       ▼
Worker + React dashboard
       │
       ▼
ReelHausManager (Cloudflare Agents SDK + SQLite Durable Object)
  ├─ Website Guardian
  ├─ controlled discovery queue
  ├─ Browser Run website analysis
  ├─ lead scoring and deduplication
  ├─ drafts, approvals and outreach event log
  └─ EmailProvider
       ├─ MockEmailProvider
       └─ GmailEmailProvider
```

The scheduled handler processes queued public candidates at `07:00 UTC`. It
does not send email. Candidate records are entered through the private dashboard
or API and then inspected within the daily discovery limit.

## Lead data

The API exposes the requested fields using camelCase:

- `id`, `businessName`, `category`, `city`, `country`
- `websiteUrl`, `mapsUrl`, `publicEmail`, `phone`, `whatsapp`
- `discoveredAt`, `sourceUrls`, `observedIssues`, `recommendedService`
- `status`, `lastContactedAt`, `nextFollowUpAt`, `doNotContact`, `notes`
- transparent `score` and `scoreReasons`

Allowed statuses:

`discovered`, `qualified`, `draft_ready`, `approved`, `contacted`, `replied`,
`meeting_requested`, `proposal_sent`, `won`, `lost`, `do_not_contact`.

## SQLite schema

The single SQLite Durable Object creates:

- `reports` — Website Guardian reports;
- `leads` — lead fields, unique deduplication key, score and status;
- `drafts` — versioned French/Arabic initial and follow-up drafts;
- `approvals` — approver, timestamp, approved version and one-time consumption;
- `outreach_events` — sent/reply/bounce/opt-out audit log and Gmail thread IDs;
- `daily_usage` — per-day discovery and send counters;
- `discovery_queue` — controlled candidate input and processing outcome.

`do_not_contact` is stored on the lead and cannot be bypassed by changing a
draft. Pending drafts and approvals are revoked when contact must stop.

## Configuration

Install Node.js 22+, pnpm 10 and dependencies:

```bash
pnpm install
cp .dev.vars.example .dev.vars
pnpm types
```

Safe local commands:

```bash
pnpm check
pnpm test
pnpm build
pnpm dev
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
pnpm exec wrangler secret put GUARDIAN_API_TOKEN
pnpm exec wrangler secret put CF_ACCESS_TEAM_DOMAIN
pnpm exec wrangler secret put CF_ACCESS_AUD
pnpm exec wrangler secret put GMAIL_CLIENT_ID
pnpm exec wrangler secret put GMAIL_CLIENT_SECRET
pnpm exec wrangler secret put GMAIL_REFRESH_TOKEN
```

`GUARDIAN_API_TOKEN` is only a local/API fallback. Production uses Cloudflare
Access. `ALLOW_LOCAL_BEARER_AUTH` is `false` in `wrangler.jsonc`; enable it only
in local `.dev.vars`.

## Cloudflare Access

1. Deploy only after review and approval.
2. In Workers & Pages, select the Worker and enable Cloudflare Access for its
   route, including preview deployments if required.
3. Create an Allow policy limited to Badr Raoui or explicitly authorized users.
4. Do not add an Everyone/Bypass policy.
5. Copy the Access application audience tag to `CF_ACCESS_AUD`.
6. Set `CF_ACCESS_TEAM_DOMAIN`, for example
   `team-name.cloudflareaccess.com`.

The Worker verifies the `Cf-Access-Jwt-Assertion` signature against Cloudflare's
JWKS and checks issuer, audience and expiry. It does not trust a caller-supplied
email header.

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

## Outreach workflow

1. Queue a business with category, city and public source.
2. Run discovery manually or wait for Cron.
3. Browser Run records public website observations and sources.
4. The transparent score determines `discovered` or `qualified`.
5. Generate a French or Arabic draft from a verified observation.
6. Edit if necessary; every edit invalidates approval.
7. Approve or reject. The Access identity and approval time are stored.
8. In `draft_only`, sending remains blocked.
9. In `mock` or manually enabled `gmail`, “send” consumes the approval once.
10. Record reply, bounce or opt-out against the lead/thread. Follow-ups stop.

The email always offers ReelScan as a low-risk first step, contains no invented
claims or guarantees, and includes a polite permanent opt-out.

## API

All `/api/*` routes require a valid Cloudflare Access JWT or the local bearer
token.

- `GET /api/sales`
- `POST /api/discovery/queue`
- `POST /api/discovery/run`
- `PATCH /api/leads/:id`
- `POST /api/leads/:id/draft`
- `POST /api/leads/:id/events`
- `POST /api/leads/:id/do-not-contact`
- `PATCH /api/drafts/:id`
- `POST /api/drafts/:id/approve`
- `POST /api/drafts/:id/reject`
- `POST /api/drafts/:id/send`
- `POST /api/scan`
- `GET /api/reports`
- `GET /api/reports/:id`

No OAuth callback, MCP, DNS, Netlify, GitHub or publishing endpoint is exposed.

## Tests

Tests cover:

- lead deduplication;
- transparent score calculation;
- allowed status transitions;
- permanent do-not-contact enforcement;
- outreach kill-switch enforcement;
- follow-up count and interval limits;
- current, single-use approval rules;
- opt-out requirement;
- Mock provider behavior;
- Gmail missing-secret and API-error behavior;
- `robots.txt` and Browser Run failure behavior;
- Website Guardian report summarization.

Automated tests never select the Gmail provider with real credentials.

## Not activated

- real Gmail sending (`EMAIL_MODE=mock`, no Gmail secrets);
- all provider calls (`OUTREACH_ENABLED=false`);
- automatic inbox reading or Gmail reply polling;
- Gmail Pub/Sub watch/webhook;
- automated Google Maps discovery;
- automatic sending of initial or follow-up email;
- external list imports;

Replies, bounces and opt-outs can currently be recorded through the authenticated
event endpoint/dashboard workflow. Automatic Gmail inbox synchronization would
require additional read scopes and infrastructure and must receive a separate
privacy/security review.
