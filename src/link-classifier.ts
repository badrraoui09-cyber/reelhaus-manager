// Deterministic classification for the optional link a customer submits
// through the public ReelScan intake ("Site, Instagram ou Google Maps").
// Only a link classified as an ordinary "website" may ever become a
// ReelScan fetch target — Instagram/Google Maps/other links are stored as
// request context only and are never fetched or analyzed in ReelScan v1.
import { validatePublicScanUrl } from "./url-safety";

export type SubmittedLinkKind =
  | "website"
  | "instagram"
  | "google_maps"
  | "other_reference"
  | "none";

export interface ClassifiedLink {
  kind: SubmittedLinkKind;
  /** The original, unmodified submitted value — always stored as-is for context. */
  raw?: string;
  /** Only set when kind === "website" and the URL passed SSRF validation. */
  normalizedUrl?: string;
}

const INSTAGRAM_HOSTS = new Set(["instagram.com", "www.instagram.com"]);
const GOOGLE_MAPS_HOSTS = new Set([
  "maps.google.com",
  "www.google.com", // .../maps paths
  "google.com", // short-link redirects and regional TLD-less references
  "maps.app.goo.gl",
  "goo.gl"
]);

function hostnameOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function classifySubmittedLink(link: unknown): ClassifiedLink {
  if (typeof link !== "string" || !link.trim()) return { kind: "none" };
  const raw = link.trim();

  const hostname = hostnameOf(raw);
  if (!hostname) return { kind: "other_reference", raw };

  if (INSTAGRAM_HOSTS.has(hostname)) return { kind: "instagram", raw };

  if (
    GOOGLE_MAPS_HOSTS.has(hostname) ||
    hostname.endsWith(".google.com") ||
    hostname === "maps.app.goo.gl"
  ) {
    // A bare google.com/goo.gl link isn't necessarily a Maps link, but we
    // never fetch it either way (only "website" targets are ever fetched)
    // — the distinction only matters for how it's displayed to a reviewer.
    return { kind: "google_maps", raw };
  }

  const validation = validatePublicScanUrl(raw);
  if (!validation.ok) return { kind: "other_reference", raw };

  return { kind: "website", raw, normalizedUrl: validation.url };
}
