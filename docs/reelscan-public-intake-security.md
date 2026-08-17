# ReelScan Public Intake — Security Review & Hardening Design

Status as of Task #5A:

```text
PUBLIC ROUTE CODE EXISTS
EDGE ACCESS STILL BLOCKS IT
LIVE WEBSITE STILL USES FORMSPREE
```

`POST /api/public/reelscan` is implemented, tested, and deployed. The
Cloudflare Zero Trust Access policy at the edge still covers the entire
`reelhaus-manager.badrraoui09.workers.dev` hostname (verified empirically —
see §3), so the route is unreachable by unauthenticated Internet traffic.
`reelhaus.de` still submits through Formspree; nothing about the live site
changed. This document does not authorize public launch — see §16, "What
still blocks public launch (Task #5B)".

This document stores no secrets, tokens, or credentials. Every secret
referenced below (`TURNSTILE_SECRET_KEY`, `PUBLIC_RATE_LIMIT_PEPPER`) is
named only as a Worker secret to be provisioned later, never a value.

---

## 1. What changed since Task #4

Task #4's `{url, email?, turnstileToken}` schema was a conceptual
placeholder, never wired to any route. Task #5A replaced it with the real
product contract (§4), corrected the Turnstile token length assumption
(4096 → Cloudflare's documented 2048), generalized ReelScan v1 to run
against an arbitrary customer target (not just reelhaus.de), built the
inbound-request data model, wired rate limiting/concurrency/cooldown to
the existing Durable Object's SQLite storage, and added the actual
`POST`/`OPTIONS /api/public/reelscan` route — deployed, but still fully
blocked by Cloudflare Access.

## 2. Target architecture (as built)

```text
reelhaus.de (still on Formspree — unchanged)
    |
    v  (Task #5B only)
POST /api/public/reelscan        <-- EXISTS, deployed, Access still blocks it
    |  - CORS: reelhaus.de / www.reelhaus.de only (public-intake-route.ts)
    |  - body-size cap before JSON.parse (body-limit.ts)
    |  - strict request schema (public-request-schema.ts)
    |  - Turnstile verified server-side, fail closed (turnstile.ts)
    |  - per-caller rate limit, hashed IP key (public-intake-service.ts, caller-key.ts)
    v
server.ts: routePublicReelScan() -> fixed internal path only
    |  POST https://internal/public-intake/submit
    |  (never derived from the incoming request's own path)
    v
sales-agent.ts (inside the Durable Object)
    |  handlePublicIntakeSubmit() -> handlePublicReelScanRequest()
    v
PublicIntakeService.submit() (public-intake-service.ts)
    |  classify the optional link (link-classifier.ts)
    |  insert an inbound_requests row (public-intake-store.ts)
    |
    +-- no link / Instagram / Google Maps / unsafe link
    |     -> requestStatus = "needs_target_review", no fetch, no AI call
    |
    +-- safe website link
          -> target cooldown check (24h, hostname-level)
          -> atomic concurrency reservation (max 2 concurrent)
          -> runReelScanV1Target() (reelscan.ts, generalized)
                - safeFetchPublicUrl() (SSRF-safe, bounded)
                - Workers AI reasoning over EvidenceRecords only
                - same deterministic validation/consolidation/severity floor
                  as Client #0
          -> requestStatus = "scan_ready_needs_review" | "analysis_failed"
    v
Manager (GET /api/inbound-requests, Access-protected, unchanged auth)
    -> operator sees request + score/recommendation if a scan completed
    -> always labeled Needs Review, never auto-approved, nothing sent
```

Public response, always: `{"ok": true, "status": "received"}` — identical
whether a scan completed, is still pending capacity, or the request needs
a human to supply/verify a target. See §11.

---

## 3. Route-security matrix

Two independent layers still protect every existing route:

1. **Edge layer** — a Cloudflare Zero Trust Access policy on the whole
   `reelhaus-manager.badrraoui09.workers.dev` hostname (external Cloudflare
   dashboard config, not in this repo). Re-verified after Task #5A's
   deploy: `GET /`, `GET /api/ai/health`, `GET /api/audit/scans/:id`,
   `POST /api/reelscan/v1/client-zero`, **and `POST /api/public/reelscan`**
   all return `302` to the Access login page for unauthenticated requests.
2. **Application layer** — `access-auth.ts` independently validates the
   Access JWT for every route it's applied to. Task #5A adds exactly one,
   surgical exception: `isPublicApiRoute()` in `server-routing.ts`, an
   **exact string match** on `(POST|OPTIONS) /api/public/reelscan` only —
   a separate list from the private `API_ROUTES` table, so it cannot
   accidentally expand by editing that table. `/api/public/foo`,
   `/api/public/reelscan/extra`, and `/api/public/reelscan/admin` are all
   confirmed (by test) to stay on the authenticated path.

| Route | Method | Public/Private | App-layer auth | Data sensitivity |
|---|---|---|---|---|
| `/api/auth/diagnostic` | GET | Private (edge+app) | Access JWT required | Low |
| `/api/ai/health` | GET | Private | Access JWT required | Low |
| `/api/audit/scans/:scanId` | GET | Private | Access JWT required | **High** — full evidence/finding lineage |
| `/api/reelscan/v1/client-zero` | POST | Private | Access JWT required | High — cost-incurring |
| `/api/scan`, `/api/reports*` | POST/GET | Private | Access JWT required | Medium |
| `/api/sales`, `/api/businesses/*` | GET | Private | Access JWT required | **High** — CRM/lead data |
| `/api/reelscan/export` | GET | Private | Access JWT required | High — bulk export |
| `/api/discovery/*` | POST | Private | Access JWT required | High |
| `/api/leads/*`, `/api/drafts/*` | PATCH/POST | Private | Access JWT required | **Critical** — `/drafts/:id/send` sends real email |
| `/api/assistant` | POST | Private | Access JWT required | Medium |
| **`/api/inbound-requests`** (new) | GET | Private | Access JWT required, unchanged auth path | High — customer name/contact/business data |
| Static dashboard assets | GET/HEAD | Private (edge only) | No app-layer check (no data in the shell itself) | Low |
| **`/api/public/reelscan`** (new) | POST, OPTIONS | **Public** (code exists; edge Access currently still blocks it — see §16) | **Explicitly bypassed** via `isPublicApiRoute()` — Turnstile + rate limit + schema are the actual gates instead | Accepts customer contact info; returns nothing beyond `{ok, status}` |

**Never a proxy:** `routePublicReelScan()` in `server.ts` forwards to a
single hardcoded internal URL
(`https://internal/public-intake/submit`) regardless of the incoming
request's actual path — the public caller's path/body can never select a
different internal DO route. `sales-agent.ts`'s handler for that fixed
path is the only DO code path the public route can ever reach; it does
not call, forward to, or expose any other internal operation.

---

## 4. Final public request contract — `public-request-schema.ts`

```ts
{
  name: string;              // required, ≤200 chars
  businessName: string;      // required, ≤200 chars
  city: string;               // required, ≤100 chars
  supportNeed: "unknown" | "reelscan" | "local_visibility"
             | "reelbuild" | "reelcare" | "other";  // required
  email?: string;              // ≤254 chars, RFC-shaped
  whatsapp?: string;            // conservatively normalized, no invented country code
  link?: string;                 // website / Instagram / Google Maps / absent
  issue?: string;                 // ≤2000 chars, stored as context only
  privacyAccepted: true;            // must be the literal boolean true
  language: "fr" | "ar";              // required
  turnstileToken: string;              // required, ≤2048 chars
}
```

- **Unknown fields rejected outright** (`prompt`, `model`, `scoreOverride`,
  `scanId`, `evidence`, `marketingConsent`, etc.) — the whole request
  fails, nothing is silently dropped or silently trusted.
- **At least one of `email` or `whatsapp` is required.**
- WhatsApp normalization strips everything but digits and a single leading
  `+`, validates a plausible 6–15 digit count, and **never invents a
  country code** — `"0612345678"` stays `"0612345678"`.
- `issue` is customer free text, stored as context (`inbound_requests.issue`)
  and **never** inserted into the ReelScan AI prompt — `reelscan.ts` only
  ever receives `EvidenceRecord`s derived from the fetched target site.
- `link` is deliberately optional and untyped as to kind — see §6.
  A customer without a website is never rejected for lacking one.
- `privacyAccepted` must be the literal boolean `true`; `"true"`, `1`, or
  omission are all rejected.
- Parsed via `JSON.parse` + an explicit field allowlist, so a `"__proto__"`
  key becomes an ordinary own property (per the JSON spec) rather than a
  prototype-pollution vector — tested directly.
- No marketing consent is collected or implied — this is request context
  for an opted-in inbound service workflow, not a marketing list signup.

---

## 5. Turnstile — `turnstile.ts`, corrected

- **Token length corrected**: Cloudflare's documented maximum is **2048**
  characters (not Task #4's placeholder 4096) — enforced in
  `public-request-schema.ts`, and confirmed rejected *before* any
  `siteverify` call is even made (tested).
- `verifyTurnstileToken()` still always calls `siteverify` server-side and
  fails closed on every error path (missing secret/token, non-2xx,
  malformed JSON, network error, timeout).
- **New:** optional `expectedHostnames`/`expectedAction` checks. When
  configured (the route always configures them: `["reelhaus.de",
  "www.reelhaus.de"]` and `"reelscan_intake"`), a `siteverify` response
  with `success: true` but a mismatched hostname or action still fails
  closed — tested. **`success === true` remains the only thing that can
  ever make verification pass**; hostname/action are never trusted alone.
- **5-minute token validity and single-use/replay rejection are handled
  entirely by Cloudflare** on the `siteverify` side — this codebase makes
  no independent replay-tracking claim, and doesn't need to.
- No production Turnstile keys exist yet (§16). Missing
  `TURNSTILE_SECRET_KEY` fails closed with a generic `try_again_later`,
  confirmed by test — there is no fallback path that skips verification.
- No live Turnstile calls anywhere in the test suite.

---

## 6. Body-size enforcement — `body-limit.ts`

Enforced **before** `JSON.parse`, independent of Cloudflare's own
platform-level body limit:

- Wrong `Content-Type` (must be exactly `application/json`) rejected
  immediately.
- An oversized declared `Content-Length` is rejected before any byte is
  read.
- The actual streamed bytes are also counted and capped — a missing or
  dishonest `Content-Length` cannot bypass the limit (same
  defense-in-depth pattern as `safe-fetch.ts`'s content cap).
- Default limit: **16 KiB** (`MAX_PUBLIC_BODY_BYTES`,
  `public-intake-config.ts`) — generous for this payload's actual field
  sizes, tiny compared to any platform default.
- Malformed/oversized bodies surface as the single generic
  `invalid_request` public error, nothing more specific.

---

## 7. Link classification — `link-classifier.ts`

```ts
type SubmittedLinkKind =
  | "website" | "instagram" | "google_maps" | "other_reference" | "none";
```

- **Website**: the only kind that can ever become a ReelScan fetch target.
  Still must independently pass `validatePublicScanUrl` — a link that
  parses as an ordinary URL but points at a private/reserved address is
  classified `other_reference`, not `website`, and is therefore *never*
  fetched (tested).
- **Instagram / Google Maps**: recognized by hostname, stored as request
  context (`submittedLink`, `linkKind`), **never fetched, never analyzed**
  (tested — the fetcher is asserted uncalled).
- **No link**: accepted request, `requestStatus: "needs_target_review"`.
  A legitimate business without a website is never rejected for lacking
  one.
- **Unsafe/malformed link**: downgraded to `other_reference` rather than
  rejecting the whole request — the customer's contact info is still
  captured; a human decides what to do with an unscannable/unsafe link.

---

## 8. Generalized ReelScan v1 — `reelscan.ts`

`runReelScanV1ClientZero()` is now a thin wrapper around a shared
`runReelScanV1Core()`; `runReelScanV1Target({targetUrl, ai, auditLedger,
fetcher})` is the new, generalized entry point for an arbitrary customer
target. Everything downstream of evidence collection — AI reasoning,
`parseReelScanAiResponse`, `downgradeUncertainIssues`, `consolidateFindings`,
`applySeverityFloor`, `deriveDeterministicFindings`, scoring,
recommendation, `reviewStatus` — is **identical code**, not a re-implementation,
proven by the Client #0 test suite staying green unmodified (62 tests, all
still passing after the refactor).

What differs for a generic target, and why:

- Uses `safeFetchPublicUrl()` (Task #4), never a raw `fetch()` — every
  redirect hop is re-validated, content-type is HTML/XHTML-only, and the
  byte cap is enforced against actual streamed bytes.
- No Website Guardian equivalent runs. `analyzeReelHaus()`'s specific
  checks (required FR/AR `hreflang` pairing, RTL correctness) are
  reelhaus.de-specific and would be meaningless — often wrong — for an
  arbitrary single-locale customer site. A generic target's evidence is
  the same factual content-evidence extraction (title, meta description,
  heading, hero excerpt, action-link occurrences, service-term mentions)
  Client #0 also uses, scoped to the one validated page.
- Consequence: `deriveDeterministicFindings()` (the Guardian severity
  floor's source) naturally finds no eligible Guardian evidence for a
  generic target and contributes nothing — not a bug, a scope boundary,
  confirmed by test. AI-reported findings for customer targets are
  therefore backed only by content evidence, same validation rigor.
- A fetch/validation failure before any evidence exists throws
  `ReelScanTargetError` (never a fabricated empty "success") — the
  calling service maps it to `analysis_failed` with a sanitized reason
  in the *private* audit log only.

---

## 9. Inbound request data model — `public-intake-store.ts`

New, additive Durable Object SQLite tables — `inbound_requests` and
`public_rate_limit_windows` — created idempotently
(`CREATE TABLE IF NOT EXISTS`), isolated from `discovery_candidates`,
`leads`, `drafts`, and every other existing table. **Nothing in
`public-intake-service.ts` imports or touches Discovery/CRM/outreach
modules** — an inbound request cannot become a Discovery candidate, a
lead, or an outreach draft; confirmed by test.

Persisted fields: id, timestamps, name, businessName, city, supportNeed,
email, whatsapp, submittedLink, linkKind, scanTargetKey (normalized —
see §10), issue, language, requestStatus, scanId, scanStatus,
analysisErrorCode, sourceOrigin, privacyAcceptedAt.

**Never persisted:** the Turnstile token, any raw Cloudflare secret, the
AI prompt, raw request headers, or the raw caller IP (see §12).

### Status model

```text
received -> needs_target_review          (no link / non-website link / unsafe link)
received -> scanning -> scan_ready_needs_review   (safe website, scan completed)
received -> scanning -> analysis_failed           (safe website, scan or fetch failed)
received (unchanged)                       (safe website, but cooldown or full capacity —
                                             accepted, deferred, no automatic retry queue in #5A)
```

No status is ever auto-converted into a Discovery candidate, a qualified
lead, a CRM stage, or an email draft — those remain later, explicit human
decisions.

---

## 10. Rate limiting / concurrency / cooldown — wired to SQLite

Centralized in `public-intake-config.ts` — nothing is hardcoded in route
logic:

```ts
PUBLIC_RATE_LIMIT = { maxAcceptedPerWindow: 3, windowSeconds: 3600 };
TARGET_SCAN_COOLDOWN_MS = 24 * 60 * 60 * 1000;       // 24h
MAX_CONCURRENT_PUBLIC_SCANS = 2;
SCAN_RESERVATION_MAX_AGE_MS = 2 * 60 * 1000;          // 2 minutes
```

**Why these values:** conservative v1 starting points, chosen to comfortably
exceed legitimate single-customer use while bounding worst-case cost. 3
*accepted* requests/hour/caller (not merely attempts — a rejected request
doesn't consume budget); 2 concurrent scans keeps AI cost trivially bounded
even under sustained abuse; 24h target cooldown matches "a page rarely
changes meaningfully within a day"; the 2-minute reservation expiry is set
comfortably above `REELSCAN_AI_TIMEOUT_MS` (60s) plus fetch/processing
overhead, so a genuinely stuck request can't hold a concurrency slot
forever. All are named constants, trivially adjustable later.

**Target cooldown normalization** — `normalizeScanTargetKey()`
(`public-intake-service.ts`): lowercased hostname with a leading `www.`
stripped, **path/query/fragment ignored entirely**. `example.com/`,
`example.com/?x=1`, and `example.com/about` all share one cooldown key by
design (no public-suffix/eTLD library is a dependency of this repo — a
coarser-than-strictly-necessary cooldown is a safe direction to err in for
an abuse control, not a correctness concern).

**Concurrency atomicity** — `tryReserveScanningSlot()`
(`public-intake-store.ts`): the active-count check and the reservation
write happen as consecutive **synchronous** Durable Object SQLite calls,
with no `await` between them. Durable Object SQLite bindings are
synchronous, and a DO's JS execution is single-threaded, so nothing else
can interleave between the check and the write — this *is* the "single
Durable Object / SQLite transaction" the task asked for, without needing
an explicit transaction API. Proven directly by test: three simultaneous
reservation attempts against a cap of 2 never yield more than 2 successes.
A reservation older than `SCAN_RESERVATION_MAX_AGE_MS` is excluded from the
active count (tested) — a crashed/killed request can't permanently occupy
a slot. Both the success and failure paths of `PublicIntakeService.submit()`
always resolve the reservation to a terminal status (tested for AI failure
and for an unexpected fetch failure) — nothing is left stuck in
`"scanning"` under normal operation.

**Per-caller rate limit** uses the same synchronous read → pure-decision
(`evaluateRateLimit`, Task #4) → conditional write pattern for the same
atomicity guarantee.

### IP handling — `caller-key.ts`

- Only `CF-Connecting-IP` is trusted as the source IP — set by the
  Cloudflare edge itself and not spoofable by the caller (unlike
  `X-Forwarded-For`, which any client can set to an arbitrary value;
  confirmed the code never reads it).
- The raw IP is never persisted. `hashCallerKey(ip, pepper)` computes an
  HMAC-SHA-256 keyed with a **dedicated** Worker secret,
  `PUBLIC_RATE_LIMIT_PEPPER` — never the Turnstile secret, never reused
  for any other purpose. Only the resulting pseudonymous hash is stored,
  in `public_rate_limit_windows`.
- Stale windows are purged (`purgeStaleRateLimitWindows`) once they're
  well past their own lifetime, so pseudonymous keys don't accumulate
  indefinitely.

---

## 11. Public response contract — `public-intake-route.ts`

Success, always, regardless of what happened internally:

```json
{ "ok": true, "status": "received" }
```

No `scanId`, internal request ID, evidence IDs, score, recommendation,
findings, model/provider details, or raw analysis errors — confirmed by
test that the response body contains exactly these two keys, nothing else,
whether the request needed target review, is still pending capacity, or
completed a full scan.

Errors — a small fixed set, confirmed to never leak the underlying
provider/internal message (tested with a deliberately "detailed" thrown
error, confirming it never appears in the response):

| Code | HTTP | Meaning |
|---|---|---|
| `invalid_request` | 400 | Schema/body/content-type validation failed |
| `verification_failed` | 403 | Turnstile did not pass (including hostname/action mismatch) |
| `rate_limited` | 429 | This caller exceeded the per-hour accepted-request cap |
| `try_again_later` | 503 | Server misconfiguration (e.g. missing Turnstile secret/pepper) |

`unsafe_url` (from Task #4's original design) is defined in `url-safety.ts`
but is **not** surfaced as a top-level public error by this route — an
unsafe *link* degrades gracefully to `other_reference`/`needs_target_review`
rather than rejecting the whole request, consistent with "don't reject a
legitimate business over a bad link" (§7).

---

## 12. Error handling design

Unchanged in spirit from Task #4, now actually implemented in
`public-intake-route.ts`: only the 4 codes in §11 ever reach the public
caller. Full detail (the actual `ReelScanTargetError` reason, the AI
failure message, etc.) is stored only in `inbound_requests.analysisErrorCode`
— visible solely through the Access-protected `/api/inbound-requests` route,
never in the public response, never in a thrown/uncaught exception path
(the route handler has no code path that can propagate a raw exception to
the caller — every external call, `readPublicRequestBody`,
`parsePublicReelScanRequestBody`, `verifyTurnstileToken`,
`PublicIntakeService.submit`, is either already typed-result-based or
wrapped in its own try/catch).

---

## 13. Manager visibility — `public-intake-service.ts`

`GET /api/inbound-requests` (Access-protected, same auth path as every
other private route) returns `listInboundRequestsForManager()`: every
stored field **except** raw evidence, plus (only when
`requestStatus === "scan_ready_needs_review"`) a `score` and
`recommendation` derived on read from the same `calculateReelScanScore`/
`recommendReelScanAction` functions Client #0 uses — never a second,
divergent scoring implementation, never raw findings/evidence in the list
view. A completed scan's `requestStatus` is literally the string
`"scan_ready_needs_review"` — the Manager UI (not built in this task; see
§16) would render that as "Needs Review", never as approved. No send/reply/
outreach action exists anywhere in this code path.

---

## 14. CORS — `cors-policy.ts` + `public-intake-config.ts`

Unchanged design from Task #4, now wired: `evaluatePublicCors()` allow-lists
exactly `https://reelhaus.de` and `https://www.reelhaus.de` (centralized in
`PUBLIC_CORS_ORIGINS`), no wildcard, no credentials header, an unrecognized
origin gets zero CORS headers. `OPTIONS /api/public/reelscan` returns
exactly this narrow preflight configuration and nothing else — confirmed by
test. Every private `/api/*` route, including the new
`/api/inbound-requests`, still gets no CORS headers at all.

---

## 15. Remaining risks (unchanged from Task #4, still accepted)

- **DNS rebinding** — still not solvable with standard Workers `fetch()`;
  see Task #4 §12 for the full explanation. Unchanged by this task.
- **IPv4/IPv6 range coverage is broad but not exhaustively IANA-complete.**
- **Turnstile solves bot-vs-human, not intent** — a human can still submit
  a URL they don't own.
- **No background retry queue.** A request deferred by the cooldown or the
  concurrency cap stays `"received"` with no automatic re-attempt — a human
  (via the Manager) or a later task must act on it. Deliberate v1
  simplification, not an oversight.
- **No Website Guardian equivalent for generic targets** (§8) — customer
  scans currently only ever produce content-evidence-backed findings, not
  the FR/AR-specific technical audit Client #0 gets. A future task could
  build a generic single-locale technical collector if warranted.

---

## 16. What still blocks public launch (Task #5B)

Manual, external steps — **none performed in Task #5A**:

1. Create the production Turnstile widget in the Cloudflare dashboard.
2. Restrict the widget to ReelHaus domains
   (`reelhaus.de`, `www.reelhaus.de`).
3. Provision the Worker secret `TURNSTILE_SECRET_KEY`
   (`wrangler secret put`).
4. Provision the Worker secret `PUBLIC_RATE_LIMIT_PEPPER`.
5. Verify both secret bindings exist without ever printing/exposing their
   values (`wrangler secret list` shows names only).
6. Create the exact Cloudflare Access path override/exclusion for
   `POST /api/public/reelscan` (and its `OPTIONS` preflight) — narrowly
   scoped to that one path, verified against every other path staying
   Access-protected.
7. Re-verify every other Manager path (`/api/sales`, `/api/audit/scans/*`,
   the dashboard root, etc.) is still `302`-gated after step 6.
8. Update `reelhaus.de`'s form: Formspree → this JSON API.
9. Embed the Turnstile client widget on the live form.
10. Update FR + AR form behavior/success/error messages.
11. Update the FR + AR privacy notice to factually describe the new
    processing flow (it currently names Formspree).
12. Deploy the website.
13. Run **one** controlled real inbound ReelScan end to end.
14. Inspect the result in the Manager.
15. A human manually reviews the findings.
16. No automatic delivery to the customer at any point.

None of these were performed in Task #5A, by design.
