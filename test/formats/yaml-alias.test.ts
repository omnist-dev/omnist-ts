// D-18/D-19/D-20 (omnist-spec Sec2.4.1): the YAML alias expansion limit.
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { main } from "../../src/cli.js";
import { DocumentError, ParseError } from "../../src/errors.js";
import { getFormat } from "../../src/registry.js";
import { readYaml } from "../../src/formats/yaml.js";
import {
  ALIAS_EXPANSION_CODE,
  checkAliasExpansion,
  DEFAULT_MAX_ALIAS_EXPANSION,
  MAX_RECOMMENDED_ALIAS_EXPANSION,
  resolveMaxAliasExpansion,
} from "../../src/formats/yaml-alias.js";
import { parseSchema } from "../../src/osd.js";

const CODE = "document.limit.alias-expansion";

/** Three levels of 8-way fan-out: E(a3) = 1097/9 = 121.9, far past the default of 50. */
const BOMB = [
  "a0: &a0 {k: x}",
  "a1: &a1 {" + Array.from({ length: 8 }, (_, j) => "p" + String(j) + ": *a0").join(", ") + "}",
  "a2: &a2 {" + Array.from({ length: 8 }, (_, j) => "p" + String(j) + ": *a1").join(", ") + "}",
  "a3: &a3 {" + Array.from({ length: 8 }, (_, j) => "p" + String(j) + ": *a2").join(", ") + "}",
  "",
].join("\n");

/** `{k1: 1, ..., kN: N}` as flow text. */
function flow(n: number, prefix = "k"): string {
  const parts: string[] = [];
  for (let i = 1; i <= n; i++) parts.push(prefix + String(i) + ": " + String(i));
  return "{" + parts.join(", ") + "}";
}

function rejected(text: string, max?: number): DocumentError {
  try {
    readYaml(text, max === undefined ? {} : { maxAliasExpansion: max });
  } catch (e) {
    expect(e).toBeInstanceOf(DocumentError);
    const err = e as DocumentError;
    expect(err.code).toBe(CODE);
    expect(err.path).toBe("$");
    return err;
  }
  throw new Error("expected rejection, but the document was accepted");
}

function accepted(text: string, max?: number): void {
  expect(() => readYaml(text, max === undefined ? {} : { maxAliasExpansion: max })).not.toThrow();
}

/** Time a whole rejection through readYaml (small inputs only: the `yaml` parse is included). */
function rejectedQuickly(text: string, limitMs = 1000): number {
  const t0 = performance.now();
  rejected(text);
  const ms = performance.now() - t0;
  expect(ms).toBeLessThan(limitMs);
  return ms;
}

/**
 * Time the D-18 check alone. The `yaml` package's own parse is not this
 * check's cost and is slow on big inputs (seconds for a ~1 MB text, with or
 * without aliases), so the text is parsed once outside the timer. `limitMs`
 * is generous because the coverage run instruments this code (uninstrumented,
 * these checks take milliseconds).
 */
function checkTime(text: string, expectReject: boolean, limitMs: number): number {
  const parsed = YAML.parseDocument(text, { schema: "yaml-1.1" });
  const t0 = performance.now();
  if (expectReject) {
    expect(() => checkAliasExpansion(parsed.contents, 50, text)).toThrow(DocumentError);
  } else {
    checkAliasExpansion(parsed.contents, 50, text);
  }
  const ms = performance.now() - t0;
  expect(ms).toBeLessThan(limitMs);
  return ms;
}

describe("alias expansion: the spec's worked examples (Sec2.4.1)", () => {
  it("unanchored merge fan-in: E(t) = 13/2 = 6.5 (rejected at 6, accepted at 7)", () => {
    const text = "b: &b {k1: 1, k2: 2, k3: 3}\nt: {<<: [*b, *b, *b, *b]}\n";
    rejected(text, 6);
    accepted(text, 7);
  });

  it("merge-key sequence: W(z)=4, S(z)=3, E=1.33 (rejected at 1, accepted at 2)", () => {
    const text = "p: &p {k: 1}\nq: &q {j: 2}\nz: &z {<<: [*p, *q], m: 3}\n";
    rejected(text, 1);
    accepted(text, 2);
  });

  it("nested case: E(p)=1, E(q)=1, E(r)=2 (rejected at 1, accepted at 2)", () => {
    const text = "p: &p {k: 1}\nq: &q {<<: *p, m: 2}\nr: &r {n: *q}\n";
    rejected(text, 1);
    accepted(text, 2);
  });

  it("inline merge source: W(t)=3, S(t)=4, E=0.75", () => {
    accepted("t: {<<: {a: 1}, z: 1}\n", 1);
  });

  it("an anchor on a bare scalar has E = 1.00 and is never a problem", () => {
    accepted("a: &a 1\nb: *a\n", 1);
  });

  it("a merge at exactly the limit is accepted, one past it is rejected (W=9, S=3)", () => {
    const text = "b: &b " + flow(7) + "\nt: {<<: *b, z: 1}\n";
    accepted(text, 3);
    rejected(text, 2);
  });

  it("a plain alias counts W(b) in full where a merge counts W(b)-1 (quoted \"<<\" is an ordinary key)", () => {
    // t = {"<<": *b}: W = 1 + 11 = 12, S = 2 -> E = 6.
    const text = "b: &b " + flow(10) + '\nt: {"<<": *b}\n';
    rejected(text, 5);
    accepted(text, 6);
    // The unquoted merge key flattens instead: W = 1 + 10 = 11, S = 2 -> 5.5.
    const merged = "b: &b " + flow(10) + "\nt: {<<: *b}\n";
    rejected(merged, 5);
    accepted(merged, 6);
  });
});

describe("alias expansion: candidates", () => {
  it("rejects an unanchored container that merely holds aliases", () => {
    rejected("b: &b " + flow(12) + "\njob: {<<: *b, script: x}\n", 4);
  });

  it("checks the document root as a container", () => {
    // root: W = 1 + 11 + 10*11 = 122, S = 1 + 11 + 10 = 22 -> E ~ 5.5.
    const parts = ["base: &b " + flow(10)];
    for (let i = 1; i <= 10; i++) parts.push("r" + String(i) + ": *b");
    const text = parts.join("\n") + "\n";
    rejected(text, 5);
    accepted(text, 6);
  });

  it("checks a sequence root", () => {
    const parts = ["- &b [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]"];
    for (let i = 0; i < 10; i++) parts.push("- *b");
    rejected(parts.join("\n") + "\n", 5);
  });

  it("checks a container inside another candidate on its own (not diluted by a big document)", () => {
    // The amplifying inner mapping sits in a large, otherwise flat document.
    const parts = ["b: &b [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]", "pad:"];
    for (let i = 0; i < 400; i++) parts.push("  - " + String(i));
    parts.push("inner: {k: *b, j: *b, h: *b, g: *b}");
    const text = parts.join("\n") + "\n";
    // inner: W = 1 + 4*11 = 45, S = 1 + 4 = 5 -> E = 9; the root's E is ~1.
    rejected(text, 8);
    accepted(text, 9);
  });

  it("checks an inline merge source on its own (its aliases add to its W)", () => {
    // {x1: *b, x2: *b}: W = 1 + 2*4 = 9, S = 3 -> E = 3.
    const text = "b: &b {k1: 1, k2: 2, k3: 3}\nt: {<<: {x1: *b, x2: *b}, z: 1}\n";
    accepted(text, 3);
    rejected(text, 2);
  });

  it("an anchored merge-key carrier sequence is itself a candidate and can be aliased", () => {
    // t: W = 1 + 3 + 3 = 7, S = 2 (3.5); s (plain): W = 9, S = 3 (3.0).
    const text = "b: &b {k1: 1, k2: 2, k3: 3}\nt: {<<: &s [*b, *b]}\nu: *s\n";
    rejected(text, 3);
    accepted(text, 4);
  });

  it("an unanchored carrier sequence holds no slot of its own", () => {
    accepted("p: &p {k: 1}\nq: &q {j: 2}\nz: {<<: [*p, *q], m: 3}\n", 2);
  });

  it("an inline mapping inside a merge-key sequence counts like an inline merge source", () => {
    // z: W = 1 + (W({a: 1}) - 1) + (W(p) - 1) + 1 = 4, S = 1 + 1 + (S({a: 1}) - 1) + 1 = 4.
    accepted("p: &p {k: 1}\nz: {<<: [{a: 1}, *p], m: 3}\n", 1);
    // {x: *p, y: *p}: W = 23, S = 3 (E = 7.67); z: W = 24, S = 5 (4.8).
    const text = "p: &p " + flow(10) + "\nz: {<<: [{x: *p, y: *p}], m: 3}\n";
    rejected(text, 4);
    accepted(text, 8);
  });

  it("scalars are never checked: a scalar aliased 500 times is accepted (the library's own guard is off)", () => {
    const parts = ["s: &s x"];
    for (let i = 0; i < 500; i++) parts.push("r" + String(i) + ": *s");
    accepted(parts.join("\n") + "\n");
  });

  it("an empty value, an empty document, and a scalar root are not limit errors", () => {
    accepted("? a\n");
    accepted("a:\nb: [1, 2]\n");
    accepted("");
    accepted("&a scalar\n");
    // A root sequence is a candidate; it is refused later only because a bare
    // array has no labeled-edge form, which is not a limit error.
    expect(() => readYaml("- \n- x\n")).toThrow(/bare array/);
  });

  it("anchors and aliases inside mapping keys take part in the walk", () => {
    // A container key is walked; its anchor resolves for a later alias. The
    // document is then refused by buildNode (non-string key), not the limit.
    expect(() => readYaml("? &k [1, 2]\n: v\nz: *k\n")).toThrow(DocumentError);
    expect(() => readYaml("? &k {p: 1}\n: x\n? *k\n: y\n")).toThrow(DocumentError);
  });
});

describe("alias expansion: cycles (D-20)", () => {
  it.each([
    ["a sequence holding an alias of itself", "a: &a [*a]\n"],
    ["a mapping holding an alias of itself", "a: &a {b: *a}\n"],
    ["a self-merge", "a: &a {<<: *a, k: 1}\n"],
    ["a self-merge in a merge sequence", "a: &a {<<: [*a], k: 1}\n"],
    ["a nested anchor referring to its ancestor", "a: &a {b: &b {c: *a}}\n"],
    ["a root container holding an alias of itself", "&r [*r]\n"],
  ])("rejects %s with the alias-expansion code", (_name, text) => {
    const err = rejected(text);
    expect(err.message).toMatch(/^line [0-9]+, col [0-9]+: an anchor refers to itself/);
    // No finite E is computed for a cycle, so even a huge maximum rejects it.
    rejected(text, MAX_RECOMMENDED_ALIAS_EXPANSION);
  });

  it("names the position of the offending alias", () => {
    expect(rejected("x: 1\na: &a [\n  *a]\n").message).toMatch(/^line 3, col 3:/);
  });

  it("redefining an anchor name inside its own definition is not a cycle", () => {
    accepted("a: &a {b: &a 1, c: *a}\n");
  });

  it("an unresolved alias is still the library's codec-syntax error, not a limit error", () => {
    expect(() => readYaml("a: *nope\n")).toThrow(ParseError);
    try {
      readYaml("a: *nope\n");
    } catch (e) {
      expect((e as ParseError).code).toBe("parse.codec-syntax");
    }
  });
});

describe("alias expansion: option validation (D-10, D-11)", () => {
  // E = 152/3 = 50.67 for this document: rejected at the default, accepted at 51.
  const big = "base: &b " + flow(150) + "\njob: {<<: *b, script: x}\n";

  it("defaults to 50", () => {
    expect(DEFAULT_MAX_ALIAS_EXPANSION).toBe(50);
    expect(resolveMaxAliasExpansion(undefined)).toBe(50);
    rejected(big);
    rejected(big, 50);
  });

  it("a mapping merging a 150-key anchor with one own key reads E = 50.67 (raise the option if needed)", () => {
    rejected(big, 50);
    accepted(big, 51);
    accepted(big, 10000);
  });

  it("zero, negative and NaN select the default, never 'no limit'", () => {
    for (const v of [0, -1, -1000, Number.NaN, Number.NEGATIVE_INFINITY]) {
      expect(resolveMaxAliasExpansion(v)).toBe(50);
      rejected(big, v);
    }
  });

  it("an integer up to the recommended ceiling is used as given", () => {
    expect(resolveMaxAliasExpansion(1)).toBe(1);
    expect(resolveMaxAliasExpansion(MAX_RECOMMENDED_ALIAS_EXPANSION)).toBe(10000);
  });

  it("a value above the ceiling, infinite or fractional is a RangeError", () => {
    for (const v of [10001, 1e9, Number.POSITIVE_INFINITY, 2.5]) {
      expect(() => readYaml("a: 1\n", { maxAliasExpansion: v })).toThrow(RangeError);
    }
  });

  it("the exported code constant is the spec code", () => {
    expect(ALIAS_EXPANSION_CODE).toBe(CODE);
  });
});

describe("alias expansion: bombs are rejected before materialization, in linear time", () => {
  /** Anchor `a0` over one scalar, then each level refers to the previous `branching` times. */
  function tower(branching: number, levels: number): string {
    const lines = ["a0: &a0 {k: x}"];
    for (let i = 1; i <= levels; i++) {
      const refs = Array.from({ length: branching }, (_, j) => "p" + String(j) + ": *a" + String(i - 1)).join(", ");
      lines.push("a" + String(i) + ": &a" + String(i) + " {" + refs + "}");
    }
    return lines.join("\n") + "\n";
  }

  it("branching 4, 10 levels", () => {
    rejectedQuickly(tower(4, 10));
  });

  it("branching 2, 30 levels (2^30 slots if expanded)", () => {
    rejectedQuickly(tower(2, 30));
  });

  it("branching 50, 4 levels", () => {
    rejectedQuickly(tower(50, 4));
  });

  it("an unanchored merge fan-in of 2000 aliases of a 2000-key anchor", () => {
    const keys = Array.from({ length: 2000 }, (_, i) => "k" + String(i) + ": 1").join(", ");
    const refs = Array.from({ length: 2000 }, () => "*b").join(", ");
    checkTime("b: &b {" + keys + "}\nt: {<<: [" + refs + "]}\n", true, 1000);
    expect(() => readYaml("b: &b {" + keys + "}\nt: {<<: [" + refs + "]}\n")).toThrow(DocumentError);
  });

  it("a 100000-item root sequence of {k: *b} over 1000 scalars: the check itself is linear", () => {
    const parts = ["- &b [" + Array.from({ length: 1000 }, (_, i) => String(i)).join(", ") + "]"];
    for (let i = 0; i < 100000; i++) parts.push("- {k: *b}");
    const text = parts.join("\n") + "\n";
    checkTime(text, true, 3000);
  }, 120000);

  it("the same bomb at 3000 items, through readYaml end to end", () => {
    const parts = ["- &b [" + Array.from({ length: 1000 }, (_, i) => String(i)).join(", ") + "]"];
    for (let i = 0; i < 3000; i++) parts.push("- {k: *b}");
    rejectedQuickly(parts.join("\n") + "\n", 5000);
  });

  it("an accepted 100000-item root is also checked in linear time", () => {
    const parts = ["- &b [1]"];
    for (let i = 0; i < 100000; i++) parts.push("- {k: *b}");
    checkTime(parts.join("\n") + "\n", false, 3000);
  }, 120000);

  it("the bomb's per-item ratio is what the maximum bounds (E = 6 for a 10-slot anchor)", () => {
    // {k: *b}: W = 1 + 11 = 12, S = 2.
    const text = "b: &b [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]\ni: {k: *b}\n";
    rejected(text, 5);
    accepted(text, 6);
  });
});

describe("alias expansion: realistic documents are accepted at the default", () => {
  it("100 compose-style services each merging a 20-key defaults anchor", () => {
    const parts = ["x-defaults: &d " + flow(20)];
    for (let i = 0; i < 100; i++) parts.push("svc" + String(i) + ": {<<: *d, image: img" + String(i) + "}");
    accepted(parts.join("\n") + "\n");
  });

  it("a 100-key block aliased 60 times at the root is accepted, 100 times rejected (E = 50.50)", () => {
    const build = (n: number): string => {
      const parts = ["base: &b " + flow(100)];
      for (let i = 0; i < n; i++) parts.push("r" + String(i) + ": *b");
      return parts.join("\n") + "\n";
    };
    accepted(build(60));
    rejected(build(100));
  });

  it("a depth-3 anchor chain is accepted", () => {
    accepted("a: &a {x: 1, y: 2}\nb: &b {a: *a, z: 3}\nc: &c {b: *b}\nd: {c: *c, b: *b}\n");
  });
});

describe("alias expansion: every YAML entry point runs the check", () => {
  const bomb = BOMB;

  it("readYaml with a schema", () => {
    const schema = parseSchema('record R { "a": integer }\nroot R');
    expect(() => readYaml(bomb, { schema })).toThrow(DocumentError);
  });

  it("the registered 'yaml' format reader, with and without the option", () => {
    const fmt = getFormat("yaml");
    expect(() => fmt.read(bomb)).toThrow(DocumentError);
    expect(() => fmt.read(bomb, { maxAliasExpansion: 10000 })).not.toThrow();
  });

  it("the raised limit admits the same input that the default refuses", () => {
    rejected(bomb);
    accepted(bomb, 10000);
  });
});

describe("alias expansion: the CLI", () => {
  function run(argv: string[], stdin: string): { code: number; out: string; err: string } {
    const out: string[] = [];
    const err: string[] = [];
    const sink = (buf: string[]): NodeJS.WritableStream =>
      ({ write: (c: unknown) => (buf.push(String(c)), true) }) as unknown as NodeJS.WritableStream;
    const code = main(argv, { stdout: sink(out), stderr: sink(err), stdin });
    return { code, out: out.join(""), err: err.join("") };
  }
  const bomb = BOMB;

  it("convert fails with exit 2, a positioned message on stderr, and no output", () => {
    const { code, out, err } = run(["convert", "-", "--from", "yaml", "--to", "json"], bomb);
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toMatch(/^error: line [0-9]+, col [0-9]+: alias expansion factor of this (mapping|sequence) exceeds the configured maximum \(50\)\n$/);
  });

  it("--json carries the document.limit.alias-expansion code at path $", () => {
    const { code, out, err } = run(["convert", "-", "--from", "yaml", "--to", "json", "--json"], bomb);
    expect(code).toBe(2);
    expect(err).toBe("");
    const payload = JSON.parse(out) as { ok: boolean; errors: { path: string; code: string; message: string }[] };
    expect(payload.ok).toBe(false);
    expect(payload.errors).toHaveLength(1);
    expect(payload.errors[0]?.code).toBe(CODE);
    expect(payload.errors[0]?.path).toBe("$");
    expect(payload.errors[0]?.message).toMatch(/^line [0-9]+, col [0-9]+: /);
  });

  it("a self-referential anchor fails the same way", () => {
    const { code, out, err } = run(["convert", "-", "--from", "yaml", "--to", "json"], "a: &a [*a]\n");
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toContain("an anchor refers to itself");
  });

  it("an ordinary aliased document still converts", () => {
    const { code, out } = run(["convert", "-", "--from", "yaml", "--to", "json"], "a: &a {x: 1}\nb: *a\n");
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ a: { x: 1 }, b: { x: 1 } });
  });
});
