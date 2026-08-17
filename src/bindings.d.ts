interface Env extends Cloudflare.Env {}

declare namespace Cloudflare {
  interface Env {
    GUARDIAN_API_TOKEN?: string;
    CF_ACCESS_TEAM_DOMAIN?: string;
    CF_ACCESS_AUD?: string;
    GMAIL_CLIENT_ID?: string;
    GMAIL_CLIENT_SECRET?: string;
    GMAIL_REFRESH_TOKEN?: string;
    DISCOVERY_SOURCE_URLS?: string;
    DISCOVERY_OSM_ENABLED?: string;
    // Task #5A: types only, no values. Provisioned later via
    // `wrangler secret put` — see docs/reelscan-public-intake-security.md.
    // Absence must fail closed (see public-intake-route.ts), never skip
    // verification/rate limiting.
    TURNSTILE_SECRET_KEY?: string;
    PUBLIC_RATE_LIMIT_PEPPER?: string;
  }
}
