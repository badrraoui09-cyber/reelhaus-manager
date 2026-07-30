interface AccessConfig {
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
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

export async function verifyCloudflareAccess(
  request: Request,
  config: AccessConfig
): Promise<string | null> {
  const token = request.headers.get("cf-access-jwt-assertion");
  const teamDomain = config.CF_ACCESS_TEAM_DOMAIN?.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const expectedAud = config.CF_ACCESS_AUD;
  if (!token || !teamDomain || !expectedAud) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  try {
    const header = decodePart<JwtHeader>(parts[0]);
    const payload = decodePart<JwtPayload>(parts[1]);
    if (header.alg !== "RS256" || !header.kid || !payload.email) return null;
    const now = Math.floor(Date.now() / 1000);
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (
      !audiences.includes(expectedAud) ||
      payload.iss !== `https://${teamDomain}` ||
      !payload.exp ||
      payload.exp <= now ||
      (payload.nbf !== undefined && payload.nbf > now)
    )
      return null;

    const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, {
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) return null;
    const jwks = (await response.json()) as JwkSet;
    const jwk = jwks.keys.find((key) => key.kid === header.kid);
    if (!jwk) return null;
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
    return valid ? payload.email : null;
  } catch {
    return null;
  }
}
