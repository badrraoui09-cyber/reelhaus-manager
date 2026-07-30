interface Env extends Cloudflare.Env {}

declare namespace Cloudflare {
  interface Env {
    GUARDIAN_API_TOKEN?: string;
    CF_ACCESS_TEAM_DOMAIN?: string;
    CF_ACCESS_AUD?: string;
    GMAIL_CLIENT_ID?: string;
    GMAIL_CLIENT_SECRET?: string;
    GMAIL_REFRESH_TOKEN?: string;
  }
}
