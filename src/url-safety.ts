// Deterministic SSRF-safety validation for a future public ReelScan intake.
//
// Cloudflare Workers' fetch() resolves DNS internally, at request time, and
// does not expose a way to pin or inspect the resolved IP before connecting
// — there is no raw-socket/DNS API in the standard fetch surface this repo
// uses. That means this validator can only ever check the URL/hostname AS
// WRITTEN: literal IP addresses, obviously-private/internal hostnames, and
// structural red flags (credentials, malformed input, wrong protocol). It
// cannot detect DNS rebinding (a hostname that validates as public here but
// resolves to a private/internal IP only when fetch() actually connects).
// That gap is real and is documented as a residual risk, not silently
// ignored — see docs/reelscan-public-intake-security.md.
//
// Because of the rebinding gap, this validator must be re-applied to EVERY
// redirect hop, not just the initial URL — see safe-fetch.ts.

export type UrlSafetyRejectionReason =
  | "malformed_url"
  | "unsupported_protocol"
  | "credentials_in_url"
  | "private_or_reserved_hostname"
  | "private_or_reserved_ip"
  | "url_too_long";

export type UrlSafetyResult =
  | { ok: true; url: string }
  | { ok: false; reason: UrlSafetyRejectionReason };

const MAX_URL_LENGTH = 2048;
const ALLOWED_PROTOCOLS = new Set(["https:"]);

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.internal",
  "instance-data"
]);
const BLOCKED_HOSTNAME_SUFFIXES = [".local", ".internal", ".localdomain"];

function ipv4Octets(host: string): number[] | null {
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return null;
  const octets = match.slice(1, 5).map(Number);
  if (octets.some((value) => value < 0 || value > 255)) return null;
  return octets;
}

// RFC 1918 private ranges, loopback, link-local (incl. 169.254.169.254
// cloud metadata), carrier-grade NAT, multicast, and the IANA
// special-purpose/reserved/documentation/benchmarking ranges.
function isPrivateIPv4(octets: number[]): boolean {
  const [a, b, c] = octets;
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224 && a <= 239) return true; // multicast
  if (a >= 240) return true; // reserved, incl. 255.255.255.255
  return false;
}

// Minimal, deliberately conservative IPv6 literal normalizer: expands "::"
// and embedded IPv4 (e.g. "::ffff:192.168.0.1") into 8 16-bit groups.
// Returns null for anything it isn't confident it parsed correctly —
// malformed input is rejected outright rather than guessed at.
function normalizeIPv6(rawHost: string): number[] | null {
  let host = rawHost;
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (!host.includes(":")) return null;
  if (!/^[0-9a-fA-F:.]+$/.test(host)) return null;

  const doubleColonCount = (host.match(/::/g) || []).length;
  if (doubleColonCount > 1) return null;
  const [head, tail] = host.split("::");

  const splitGroups = (part: string): string[] => (part ? part.split(":") : []);
  let headGroups = splitGroups(head);
  let tailGroups = tail !== undefined ? splitGroups(tail) : [];

  // An embedded IPv4 tail (only valid as the final group).
  const embeddedIn = tailGroups.length ? tailGroups : headGroups;
  const last = embeddedIn.at(-1);
  if (last && last.includes(".")) {
    const octets = ipv4Octets(last);
    if (!octets) return null;
    const hex1 = ((octets[0] << 8) | octets[1]).toString(16);
    const hex2 = ((octets[2] << 8) | octets[3]).toString(16);
    embeddedIn.splice(embeddedIn.length - 1, 1, hex1, hex2);
  }

  if (tail !== undefined) {
    const missing = 8 - headGroups.length - tailGroups.length;
    if (missing < 0) return null;
    headGroups = [...headGroups, ...Array(missing).fill("0"), ...tailGroups];
  }
  if (headGroups.length !== 8) return null;
  if (!headGroups.every((group) => /^[0-9a-fA-F]{1,4}$/.test(group)))
    return null;
  return headGroups.map((group) => parseInt(group, 16));
}

function isPrivateIPv6(groups: number[]): boolean {
  if (groups.every((value) => value === 0)) return true; // :: unspecified
  if (groups.slice(0, 7).every((value) => value === 0) && groups[7] === 1)
    return true; // ::1 loopback
  const g0 = groups[0];
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  // ::ffff:0:0/96 IPv4-mapped -> re-check the embedded IPv4 address.
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  ) {
    const octets = [
      groups[6] >> 8,
      groups[6] & 0xff,
      groups[7] >> 8,
      groups[7] & 0xff
    ];
    return isPrivateIPv4(octets);
  }
  return false;
}

export function validatePublicScanUrl(rawUrl: unknown): UrlSafetyResult {
  if (typeof rawUrl !== "string" || !rawUrl.trim())
    return { ok: false, reason: "malformed_url" };
  if (rawUrl.length > MAX_URL_LENGTH)
    return { ok: false, reason: "url_too_long" };

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "malformed_url" };
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol))
    return { ok: false, reason: "unsupported_protocol" };
  if (url.username || url.password)
    return { ok: false, reason: "credentials_in_url" };

  const hostname = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname))
    return { ok: false, reason: "private_or_reserved_hostname" };
  if (BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix)))
    return { ok: false, reason: "private_or_reserved_hostname" };

  const octets = ipv4Octets(hostname);
  if (octets)
    return isPrivateIPv4(octets)
      ? { ok: false, reason: "private_or_reserved_ip" }
      : { ok: true, url: url.toString() };

  if (hostname.startsWith("[") || hostname.includes(":")) {
    const groups = normalizeIPv6(hostname);
    if (!groups) return { ok: false, reason: "malformed_url" };
    return isPrivateIPv6(groups)
      ? { ok: false, reason: "private_or_reserved_ip" }
      : { ok: true, url: url.toString() };
  }

  return { ok: true, url: url.toString() };
}
