import { describe, expect, it } from "vitest";
import { parseSchema } from "../../src/osd.js";
import { lint, type LintFinding } from "../../src/ops/lint.js";

function only(findings: readonly LintFinding[]): LintFinding {
  if (findings.length !== 1) throw new Error(`expected exactly one finding, got ${findings.length}`);
  const [f] = findings;
  if (f === undefined) throw new Error("unreachable");
  return f;
}

// Ported from upstream omnist's tests/test_lint.py.

function codes(findings: readonly LintFinding[]): string[] {
  return findings.map((f) => f.code);
}

describe("lint", () => {
  it("reports unsatisfiable-record for a mandatory ref cycle", () => {
    const s = parseSchema('record A { "b": B }\nrecord B { "a": A }\nroot A');
    const findings = lint(s);
    const unsat = findings.filter((f) => f.code === "unsatisfiable-record");
    expect(new Set(unsat.map((f) => f.location))).toEqual(new Set(["A", "B"]));
    expect(unsat.every((f) => f.severity === "warning")).toBe(true);
  });

  it("reports unreachable-record", () => {
    const s = parseSchema('record R { "x": integer }\nrecord Orphan { "y": string }\nroot R');
    const findings = lint(s);
    const unreach = findings.filter((f) => f.code === "unreachable-record");
    const first = only(unreach);
    expect(first.location).toBe("Orphan");
    expect(first.severity).toBe("warning");
  });

  it("reports duplicate-record", () => {
    const s = parseSchema(
      'record Addr { "c": string }\nrecord Location { "c": string }\nrecord R { "a": Addr, "l": Location }\nroot R',
    );
    const findings = lint(s);
    const dup = findings.filter((f) => f.code === "duplicate-record");
    const first = only(dup);
    expect(first.location).toBe("Addr, Location");
    expect(first.severity).toBe("warning");
    expect(first.message).toContain("normalize");
  });

  it("inventories any-fields", () => {
    const s = parseSchema('record R { "id": string, "data": any }\nroot R');
    const findings = lint(s);
    const anys = findings.filter((f) => f.code === "any-field");
    const first = only(anys);
    expect(first.location).toBe("R.data");
    expect(first.severity).toBe("info");
  });

  it("a clean schema has no findings", () => {
    const s = parseSchema('record R { "x": integer, "y" [0,1]: string }\nroot R');
    expect(lint(s)).toEqual([]);
  });

  it("sorts findings by code then location", () => {
    const s = parseSchema('record A { "b": B }\nrecord B { "a": A }\nrecord Orphan { "z": any }\nroot A');
    const findings = lint(s);
    const keys = findings.map((f) => [f.code, f.location] as const);
    const sorted = [...keys].sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
    expect(keys).toEqual(sorted);
  });

  it("an any-only schema has no warning-severity findings", () => {
    const s = parseSchema('record R { "data": any }\nroot R');
    const findings = lint(s);
    expect(codes(findings)).toEqual(["any-field"]);
    expect(findings.some((f) => f.severity === "warning")).toBe(false);
  });

  it("does not mutate the schema", () => {
    const s = parseSchema('record R { "x": integer }\nrecord Orphan { "y": string }\nroot R');
    const before = new Set(s.env.keys());
    lint(s);
    expect(new Set(s.env.keys())).toEqual(before);
  });
});

describe("lint: sort comparator branch coverage", () => {
  it("orders findings across differing and equal codes/locations, both directions", () => {
    const s = parseSchema(
      'record Z { "b": B }\nrecord B { "z": Z }\n' +
        'record Orphan1 { "x": integer }\nrecord Orphan2 { "y": integer }\n' +
        'record R { "zebra": any, "mango": any, "apple": any }\nroot R',
    );
    const findings = lint(s);
    const keys = findings.map((f) => [f.code, f.location] as const);
    const sorted = [...keys].sort(([ca, la], [cb, lb]) =>
      ca === cb ? (la < lb ? -1 : la > lb ? 1 : 0) : ca < cb ? -1 : 1,
    );
    expect(keys).toEqual(sorted);
  });
  it("sorts unreachable-record locations by codepoint, not locale-aware collation", () => {
    // Issue #56: `localeCompare` without an explicit locale does
    // Unicode-collation-aware comparison, which orders "aaa" before "B"
    // (case-insensitive-ish collation). Python's plain tuple sort is a
    // codepoint comparison, where uppercase "B" (0x42) sorts before
    // lowercase "aaa" (0x61). Only "R" is reachable from root, so "aaa"
    // and "B" are both unreachable-record findings whose relative order
    // is exactly what's under test.
    const s = parseSchema(
      'record R { "a": string }\nrecord aaa { "b": string }\nrecord B { "c": string }\nroot R',
    );
    const locations = lint(s)
      .filter((f) => f.code === "unreachable-record")
      .map((f) => f.location);
    expect(locations).toEqual(["B", "aaa"]);
  });
});
