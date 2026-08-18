// Task #2.21 security audit (Section 1/7): CSV/formula injection
// (CWE-1236) — a cell opened in Excel/Google Sheets whose content starts
// with =, +, -, or @ can be interpreted as a formula rather than plain
// text, letting exported data exfiltrate other cells or make outbound
// calls once opened. Standard mitigation: prefix such a value with a
// single quote, which every spreadsheet application treats as "force
// text" and which a human reading the CSV barely notices. Only the
// leading character matters, so this never changes the cell's actual
// informational content.
//
// Lives in its own file (not sales-agent.ts, where it's used) so it can
// be unit tested — sales-agent.ts re-exports ReelHausManager and pulls in
// a `cloudflare:`-scheme module the plain Node/vitest ESM loader cannot
// resolve, the same reason server-routing.ts exists as a separate,
// testable module split out of server.ts.
const FORMULA_TRIGGER_CHARACTERS = new Set(["=", "+", "-", "@"]);

export function csvCell(value: unknown): string {
  const text = String(value ?? "");
  const safeText = FORMULA_TRIGGER_CHARACTERS.has(text[0]) ? `'${text}` : text;
  return `"${safeText.replaceAll('"', '""')}"`;
}
