import { describe, expect, it } from "vitest";
import { validatePublicScanUrl } from "./url-safety";

describe("validatePublicScanUrl", () => {
  it("accepts a normal public HTTPS hostname", () => {
    const result = validatePublicScanUrl("https://example.com/some/path");
    expect(result.ok).toBe(true);
  });

  it("rejects localhost", () => {
    expect(validatePublicScanUrl("https://localhost/").ok).toBe(false);
    expect(validatePublicScanUrl("https://localhost.localdomain/").ok).toBe(
      false
    );
  });

  it("rejects IPv4 private/reserved ranges", () => {
    const cases = [
      "https://127.0.0.1/",
      "https://0.0.0.0/",
      "https://10.1.2.3/",
      "https://172.16.0.1/",
      "https://172.31.255.255/",
      "https://192.168.1.1/",
      "https://169.254.169.254/", // cloud metadata
      "https://100.64.0.1/", // carrier-grade NAT
      "https://224.0.0.1/", // multicast
      "https://255.255.255.255/"
    ];
    for (const url of cases) {
      const result = validatePublicScanUrl(url);
      expect(result.ok, `expected ${url} to be rejected`).toBe(false);
    }
  });

  it("does not reject a public IPv4 address that merely looks similar", () => {
    // 172.15.x and 172.32.x are outside the RFC1918 172.16.0.0/12 band.
    expect(validatePublicScanUrl("https://172.15.0.1/").ok).toBe(true);
    expect(validatePublicScanUrl("https://172.32.0.1/").ok).toBe(true);
    expect(validatePublicScanUrl("https://8.8.8.8/").ok).toBe(true);
  });

  it("rejects IPv6 loopback, link-local, and unique-local", () => {
    const cases = [
      "https://[::1]/",
      "https://[fe80::1]/",
      "https://[fc00::1]/",
      "https://[fd12:3456:789a::1]/",
      "https://[::ffff:127.0.0.1]/", // IPv4-mapped loopback
      "https://[::ffff:192.168.1.1]/" // IPv4-mapped private
    ];
    for (const url of cases) {
      const result = validatePublicScanUrl(url);
      expect(result.ok, `expected ${url} to be rejected`).toBe(false);
    }
  });

  it("accepts a public IPv6 address", () => {
    expect(validatePublicScanUrl("https://[2606:4700:4700::1111]/").ok).toBe(
      true
    );
  });

  it("rejects credentials embedded in the URL", () => {
    expect(
      validatePublicScanUrl("https://user:pass@example.com/").ok
    ).toBe(false);
  });

  it("rejects non-HTTPS protocols", () => {
    for (const url of [
      "http://example.com/",
      "ftp://example.com/",
      "file:///etc/passwd",
      "data:text/html,<script>alert(1)</script>",
      "javascript:alert(1)"
    ]) {
      const result = validatePublicScanUrl(url);
      expect(result.ok, `expected ${url} to be rejected`).toBe(false);
    }
  });

  it("rejects malformed URLs", () => {
    expect(validatePublicScanUrl("not a url").ok).toBe(false);
    expect(validatePublicScanUrl("").ok).toBe(false);
    expect(validatePublicScanUrl(null).ok).toBe(false);
    expect(validatePublicScanUrl(undefined).ok).toBe(false);
    expect(validatePublicScanUrl(42).ok).toBe(false);
  });

  it("rejects an oversized URL", () => {
    const url = `https://example.com/${"a".repeat(3000)}`;
    const result = validatePublicScanUrl(url);
    expect(result.ok).toBe(false);
  });

  it("rejects .local, .internal, and metadata hostnames", () => {
    expect(validatePublicScanUrl("https://printer.local/").ok).toBe(false);
    expect(validatePublicScanUrl("https://service.internal/").ok).toBe(false);
    expect(
      validatePublicScanUrl("https://metadata.google.internal/").ok
    ).toBe(false);
  });
});
