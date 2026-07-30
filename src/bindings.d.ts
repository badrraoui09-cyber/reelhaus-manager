interface Env extends Cloudflare.Env {
  GUARDIAN_API_TOKEN?: string;
  ALLOW_LOCAL_BEARER_AUTH?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  EMAIL_MODE?: "draft_only" | "mock" | "gmail";
  GMAIL_CLIENT_ID?: string;
  GMAIL_CLIENT_SECRET?: string;
  GMAIL_REFRESH_TOKEN?: string;
  MAX_DAILY_NEW_LEADS?: string;
  MAX_DAILY_SENDS?: string;
  MIN_FOLLOW_UP_DAYS?: string;
}
