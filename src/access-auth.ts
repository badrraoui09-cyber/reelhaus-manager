export interface AccessConfig {
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
}

interface DiagnosticConfig extends AccessConfig {
  EMAIL_MODE?: string;
  OUTREACH_ENABLED?: string;
}

export type AccessValidationResult =
  | { status: "authenticated"; identity: string }
  | {
      status: "not_configured" | "missing_jwt" | "rejected";
      identity?: never;
    };

export interface AccessDiagnostic {
  accessConfigured: boolean;
  accessJwtPresent: boolean;
  emailMode: string;
  outreachEnabled: boolean;
}

interface JwtHeader {
  alg?: string;
  kid?: string;
}

interface JwtPayload {
  aud?: string | string[];
  email?: string;
  exp?: number;
  iat?: number;
  iss?: string;
  nbf?: number;
}

interface JwkSet {
  keys: Array<JsonWebKey & { kid?: string }>;
}

function decodePart<T>(part: string): T {
  const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return JSON.parse(atob(padded)) as T;
}

function bytes(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value);
}

function normalizedTeamDomain(config: AccessConfig): string {
  return (
    config.CF_ACCESS_TEAM_DOMAIN?.trim()
      .replace(/^https?:\/\//, "")
      .replace(/\/$/, "") || ""
  );
}

export function accessIsConfigured(config: AccessConfig): boolean {
  return Boolean(normalizedTeamDomain(config) && config.CF_ACCESS_AUD?.trim());
}

export function accessDiagnostic(
  request: Request,
  config: DiagnosticConfig
): AccessDiagnostic {
  return {
    accessConfigured: accessIsConfigured(config),
    accessJwtPresent: Boolean(
      request.headers.get("cf-access-jwt-assertion")?.trim()
    ),
    emailMode: String(config.EMAIL_MODE || "draft_only"),
    outreachEnabled: String(config.OUTREACH_ENABLED) === "true"
  };
}

export async function validateCloudflareAccess(
  request: Request,
  config: AccessConfig
): Promise<AccessValidationResult> {
  const token = request.headers.get("cf-access-jwt-assertion");
  const teamDomain = normalizedTeamDomain(config);
  const expectedAud = config.CF_ACCESS_AUD?.trim();
  if (!teamDomain || !expectedAud) return { status: "not_configured" };
  if (!token) return { status: "missing_jwt" };
  const parts = token.split(".");
  if (parts.length !== 3) return { status: "rejected" };

  try {
    const header = decodePart<JwtHeader>(parts[0]);
    const payload = decodePart<JwtPayload>(parts[1]);
    if (header.alg !== "RS256" || !header.kid || !payload.email)
      return { status: "rejected" };
    const now = Math.floor(Date.now() / 1000);
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (
      !audiences.includes(expectedAud) ||
      payload.iss !== `https://${teamDomain}` ||
      !payload.exp ||
      payload.exp <= now ||
      (payload.nbf !== undefined && payload.nbf > now)
    )
      return { status: "rejected" };

    const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, {
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) return { status: "rejected" };
    const jwks = (await response.json()) as JwkSet;
    const jwk = jwks.keys.find((key) => key.kid === header.kid);
    if (!jwk) return { status: "rejected" };
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const signaturePart = parts[2]
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(parts[2].length / 4) * 4, "=");
    const signature = Uint8Array.from(atob(signaturePart), (char) =>
      char.charCodeAt(0)
    );
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signature,
      bytes(`${parts[0]}.${parts[1]}`)
    );
    return valid
      ? { status: "authenticated", identity: payload.email }
      : { status: "rejected" };
  } catch {
    return { status: "rejected" };
  }
}
