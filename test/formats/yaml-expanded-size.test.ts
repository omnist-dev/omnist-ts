// D-18a and D-22 (omnist-spec v0.26.0-beta, Sec2.4.1): merge carriers, malformed
// merge shapes, and the expanded-size limit. Companion to yaml-alias.test.ts.
import YAML from "yaml";
import { describe, expect, it, vi } from "vitest";
import { main } from "../../src/cli.js";
import { DocumentError, ParseError } from "../../src/errors.js";
import { getFormat } from "../../src/registry.js";
import { readYaml } from "../../src/formats/yaml.js";
import {
  ALIAS_EXPANSION_CODE,
  checkAliasExpansion,
  DEFAULT_MAX_EXPANDED_SLOTS,
  EXPANDED_SIZE_CODE,
  MAX_RECOMMENDED_EXPANDED_SLOTS,
  resolveMaxExpandedSlots,
} from "../../src/formats/yaml-alias.js";
import { parseSchema } from "../../src/osd.js";

interface Opts {
  maxAliasExpansion?: number;
  maxExpandedSlots?: number;
}

/** `{k1: 1, ..., kN: N}` as flow text. */
function flow(n: number, prefix = "k"): string {
  const parts: string[] = [];
  for (let i = 1; i <= n; i++) parts.push(prefix + String(i) + ": " + String(i));
  return "{" + parts.join(", ") + "}";
}

function thrown(text: string, opts: Opts): unknown {
  try {
    readYaml(text, opts);
  } catch (e) {
    return e;
  }
  throw new Error("expected rejection, but the document was accepted");
}

function limit(text: string, code: string, opts: Opts): DocumentError {
  const err = thrown(text, opts);
  expect(err).toBeInstanceOf(DocumentError);
  expect((err as DocumentError).code).toBe(code);
  expect((err as DocumentError).path).toBe("$");
  return err as DocumentError;
}

const ratio = (text: string, max: number, slots?: number): DocumentError =>
  limit(text, ALIAS_EXPANSION_CODE, slots === undefined ? { maxAliasExpansion: max } : { maxAliasExpansion: max, maxExpandedSlots: slots });
const size = (text: string, slots: number, max?: number): DocumentError =>
  limit(text, EXPANDED_SIZE_CODE, max === undefined ? { maxExpandedSlots: slots } : { maxAliasExpansion: max, maxExpandedSlots: slots });
function ok(text: string, opts: Opts): void {
  expect(() => readYaml(text, opts)).not.toThrow();
}
const okRatio = (text: string, max: number): void => ok(text, { maxAliasExpansion: max });
const okSize = (text: string, slots: number, max?: number): void =>
  ok(text, max === undefined ? { maxExpandedSlots: slots } : { maxAliasExpansion: max, maxExpandedSlots: slots });

function syntax(text: string, opts: Opts = {}): ParseError {
  const err = thrown(text, opts);
  expect(err).toBeInstanceOf(ParseError);
  expect((err as ParseError).code).toBe("parse.codec-syntax");
  expect((err as ParseError).path).toMatch(/^[0-9]+:[0-9]+$/);
  return err as ParseError;
}

describe("D-18a: a sequence in merge-value position is a carrier, anchored or not", () => {
  it("the anchored carrier is not a candidate and holds no slot: at the limit accepted, one past rejected", () => {
    // p, q: W = S = 4. z: W = 1 + 3 + 3 + 3 = 10, S = 5 (z, <<, m1..m3) -> E = 2.00.
    const at = "p: &p {a1: 1, a2: 2, a3: 3}\nq: &q {b1: 4, b2: 5, b3: 6}\nz: {<<: &s [*p, *q], m1: 7, m2: 8, m3: 9}\n";
    okRatio(at, 2);
    ratio(at, 1);
    // One more key each: z: W = 12, S = 5 -> 2.40.
    const past = "p: &p {a1: 1, a2: 2, a3: 3, a4: 4}\nq: &q {b1: 5, b2: 6, b3: 7, b4: 8}\nz: {<<: &s [*p, *q], m1: 9, m2: 10, m3: 11}\n";
    ratio(past, 2);
    okRatio(past, 3);
  });

  it("an anchor on the carrier changes no verdict (spec worked example: E(z) = 4/3)", () => {
    for (const max of [1, 2]) {
      const anchored = "p: &p {k: 1}\nq: &q {j: 2}\nz: {<<: &s [*p, *q], m: 3}\n";
      const bare = "p: &p {k: 1}\nq: &q {j: 2}\nz: {<<: [*p, *q], m: 3}\n";
      const verdict = (t: string): boolean => {
        try {
          readYaml(t, { maxAliasExpansion: max });
          return true;
        } catch {
          return false;
        }
      };
      expect(verdict(anchored)).toBe(max === 2);
      expect(verdict(bare)).toBe(verdict(anchored));
    }
  });

  it("an alias to a sequence in merge position contributes the sum of W(member) - 1, never W(s) - 1", () => {
    // p, q: W = 2. s (ordinary): W = 9, S = 5. z: W = 1 + 4 * 1 + 1 = 6, S = 3 -> E = 2.00.
    const at = "p: &p {a: 1}\nq: &q {b: 2}\ns: &s [*p, *q, *p, *q]\nz: {<<: *s, m: 3}\n";
    okRatio(at, 2);
    ratio(at, 1);
    const past = "p: &p {a: 1}\nq: &q {b: 2}\ns: &s [*p, *q, *p, *q]\nz: {<<: *s}\n";
    // W(z) = 1 + 4 = 5, S = 2 -> 2.50.
    ratio(past, 2);
    okRatio(past, 3);
  });

  it("spec worked example y: {<<: *s, m: 3} reads W = 4, S = 3 (not 1 + (W(s) - 1) + 1 = 6)", () => {
    const text = "p: &p {k: 1}\nq: &q {j: 2}\ns: &s [*p, *q]\ny: {<<: *s, m: 3}\n";
    okRatio(text, 2); // E(s) = 5/3 = 1.67 is the largest
    // Root: W = 1 + 2 + 2 + 5 + 4 = 14 exactly.
    okSize(text, 14);
    size(text, 13);
  });

  it("an ordinary anchored sequence stays a candidate: s: &s [*p, *q] reads W = 5, S = 3, E = 1.67", () => {
    const text = "p: &p {k: 1}\nq: &q {j: 2}\ns: &s [*p, *q]\n";
    ratio(text, 1);
    okRatio(text, 2);
  });

  it("a plain alias to an anchored carrier materializes the list: 1 + W(p) + W(q)", () => {
    // p, q: W = 2; z: W = 4; t: *s adds 1 + 2 + 2 = 5. Root W = 1 + 2 + 2 + 4 + 5 = 14.
    const text = "p: &p {k: 1}\nq: &q {j: 2}\nz: {<<: &s [*p, *q], m: 3}\nt: *s\n";
    okSize(text, 14);
    size(text, 13);
  });

  it("an inline mapping and an anchored mapping inside a carrier (spec worked example: W = S = 5)", () => {
    const text = "z: {<<: [{x: 1}, &m {y: 2}, *m], k: 3}\n";
    okRatio(text, 1);
    // Root W = 1 + 5 = 6.
    okSize(text, 6);
    size(text, 5);
  });

  it("a mapping first defined inside a carrier is a candidate in its own right, and a later alias uses its W", () => {
    const text = "b: &b " + flow(10) + "\nz: {<<: [&m {y: *b, w: *b}, *m], k: 3}\n";
    // m: W = 1 + 22 = 23, S = 3 -> 7.67. z: W = 1 + 22 + 22 + 1 = 46, S = 5 -> 9.2.
    ratio(text, 7);
    ratio(text, 9);
    okRatio(text, 10);
    // An aliased m elsewhere is a plain alias: W(m) = 23 in full.
    ratio(text + "u: {v: *m}\n", 9);
  });

  it("an inline mapping inside a carrier adds its written slots, less its container, to the referrer's S", () => {
    // {x: *p, y: *p}: W = 23, S = 3 (E = 7.67); z: W = 1 + 22 + 1 = 24, S = 1 + 1 + 2 + 1 = 5 (4.8).
    const text = "p: &p " + flow(10) + "\nz: {<<: [{x: *p, y: *p}], m: 3}\n";
    ratio(text, 4);
    okRatio(text, 8);
  });
});

describe("D-18a: malformed merge shapes are parse.codec-syntax, at a line:col", () => {
  it.each([
    ["a scalar merge value", "a:\n  <<: 1\n", "2:7"],
    ["a null merge value", "a:\n  <<:\n", "2:6"],
    ["a scalar member of a merge sequence", "a:\n  <<: [1]\n", "2:8"],
    ["a sequence inside a merge sequence", "a:\n  <<: [[{a: 1}]]\n", "2:8"],
    ["an alias to a sequence of scalars", "s: &s [1, 2]\nz:\n  <<: *s\n", "3:7"],
    ["a merge sequence holding an alias to a sequence", "s: &s [{a: 1}]\nz:\n  <<: [*s]\n", "3:8"],
    ["an alias to a scalar", "x: &x 1\nz:\n  <<: *x\n", "3:7"],
    ["a scalar member that is an alias to a scalar", "x: &x 1\nz:\n  <<: [*x]\n", "3:8"],
    ["a merge in a sequence item", "- {a: 1}\n- {<<: 1}\n", "2:8"],
    ["a merge in an inline mapping inside a carrier", "z: {<<: [{<<: 2}]}\n", "1:15"],
  ])("%s", (_name, text, at) => {
    expect(syntax(text).path).toBe(at);
    // And it is the same code whatever the limits are.
    syntax(text, { maxAliasExpansion: 1, maxExpandedSlots: 1 });
  });

  it("a malformed merge wins over an alias-expansion bomb that comes BEFORE it (spec vector)", () => {
    const text = "p: &p {a: 1, b: 2, c: 3}\nt: {<<: [*p, *p, *p, *p]}\nbad:\n  <<: 1\n";
    ratio("p: &p {a: 1, b: 2, c: 3}\nt: {<<: [*p, *p, *p, *p]}\n", 2); // the bomb alone
    expect(syntax(text, { maxAliasExpansion: 2 }).path).toBe("4:7");
  });

  it("a malformed merge wins over a bomb that comes AFTER it, over an expanded-size input, and over a cycle", () => {
    syntax("bad:\n  <<: 1\np: &p {a: 1, b: 2, c: 3}\nt: {<<: [*p, *p, *p, *p]}\n", { maxAliasExpansion: 2 });
    syntax("p: &p {a: 1}\nq: {x: *p, y: *p}\nbad: {<<: 1}\n", { maxExpandedSlots: 2 });
    syntax("a: &a [*a]\nb: {<<: 1}\n");
    syntax("a: &a {<<: *a}\nb: {<<: [2]}\n");
  });

  it("an anchor defined later in the same mapping is still seen by the shape check", () => {
    syntax("{s: &s [1], <<: *s}\n");
  });

  it("an unresolved alias is a syntax error at the alias, and wins over a limit", () => {
    expect(syntax("z: {<<: *nope}\n").path).toBe("1:9");
    expect(syntax("z: {<<: [*nope]}\n").path).toBe("1:10");
    expect(syntax("a: 1\nb: *nope\n").path).toBe("2:4");
    syntax("p: &p {a: 1, b: 2, c: 3}\nt: {<<: [*p, *p, *p, *p]}\nu: *nope\n", { maxAliasExpansion: 2 });
  });

  it("an anchor defined inside the merge value is known to an alias inside the same value", () => {
    syntax("z: {<<: [{q: &x 1}, *x]}\n"); // *x is a scalar: not a mapping
    ok("z: {<<: [{q: &m {a: 1}}, *m]}\n", {});
  });

  it("well-formed shapes are untouched: a mapping, an alias to one, a sequence of mappings and aliases", () => {
    ok("m: &m {a: 1}\nz: {<<: *m}\ny: {<<: [*m, {b: 2}, &n {c: 3}, *n]}\nx: {<<: {d: 4}}\n", {});
    ok("s: &s [{a: 1}, {b: 2}]\nz: {<<: *s}\n", {});
  });

  it("a quoted \"<<\" is an ordinary key, so its scalar value is fine", () => {
    ok('a: {"<<": 1, "<<x": [1]}\n', {});
  });

  it("the check is also the registered reader's and the CLI's", () => {
    expect(() => getFormat("yaml").read("a:\n  <<: 1\n")).toThrow(ParseError);
    const out: string[] = [];
    const err: string[] = [];
    const sink = (buf: string[]): NodeJS.WritableStream =>
      ({ write: (c: unknown) => (buf.push(String(c)), true) }) as unknown as NodeJS.WritableStream;
    const code = main(["convert", "-", "--from", "yaml", "--to", "json", "--json"], {
      stdout: sink(out),
      stderr: sink(err),
      stdin: "a:\n  <<: 1\n",
    });
    expect(code).toBe(2);
    const payload = JSON.parse(out.join("")) as { errors: { code: string; path: string }[] };
    expect(payload.errors[0]?.code).toBe("parse.codec-syntax");
    expect(payload.errors[0]?.path).toBe("2:7");
  });
});

describe("tagged collections whose items are Pairs (!!omap, !!pairs) and root aliases", () => {
  it.each([
    ["!!omap of mappings", "a: !!omap [{x: 1}, {y: 2}]\n"],
    ["!!pairs of mappings", "a: !!pairs [{x: 1}, {x: 2}]\n"],
    ["!!omap of scalar-valued entries", "a: !!omap [x: 1, y: 2]\n"],
    ["!!pairs of scalar-valued entries", "a: !!pairs [x: 1, x: 2]\n"],
    ["a root !!omap", "!!omap [{x: 1}]\n"],
    ["a block !!omap", "a: !!omap\n  - x: 1\n  - y: 2\n"],
    ["!!timestamp and a custom tag", "c: !!timestamp 2001-12-14\nd: !foo 1\n"],
  ])("%s is accepted as before", (_name, text) => {
    ok(text, {});
  });

  it("an anchor defined inside a Pair is known to a later alias, in the shape pass and in the count", () => {
    ok("a: !!pairs [{x: &z {q: 1}}]\nb: *z\n", {});
    ok("a: !!omap [x: &z {q: 1}]\nb: {<<: *z}\n", {});
  });

  it("a ratio bomb written inside !!pairs is still counted", () => {
    const text = "p: &p " + flow(10) + "\na: !!pairs [{x: {u: *p, v: *p, w: *p}}]\n";
    ratio(text, 5);
    okRatio(text, 10000);
  });

  it("a genuinely malformed merge inside !!pairs is parse.codec-syntax at its real position", () => {
    expect(syntax("a: !!pairs [{x: {<<: 5}}]\n").path).toBe("1:22");
    expect(syntax("a: !!omap [x: {<<: 5}]\n").path).toBe("1:20");
  });

  it("a root alias is an unresolved alias, positioned, not a bare 1:1 library error", () => {
    expect(syntax("*a\n").path).toBe("1:1");
    expect(syntax("--- *a\n").path).toBe("1:5");
    expect(syntax("---\n\n  *a\n").path).toBe("3:3");
  });
});

describe("a library failure while materializing", () => {
  it("is still parse.codec-syntax, at 1:1 where the error names no position", () => {
    // toJS recurses on the JS stack, so a deep-but-parseable document can overflow it with a bare RangeError.
    const spy = vi.spyOn(YAML.Document.prototype, "toJS").mockImplementation(() => {
      throw new RangeError("Maximum call stack size exceeded");
    });
    try {
      const err = syntax("a: 1\n");
      expect(err.path).toBe("1:1");
      expect(err.message).toContain("Maximum call stack size exceeded");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("D-22: the expanded-size limit", () => {
  const SHARED = "base: &base {k1: 1, k2: 2, k3: 3}\nt: {a: *base, b: *base, c: *base, d: *base}\n"; // W(root) = 22

  it("at the cap accepted, one past rejected, at the root path $", () => {
    okSize(SHARED, 22);
    const err = size(SHARED, 21);
    expect(err.message).toBe(
      "line 1, col 1: the input expands to 22 value slots, over the maximum expanded size (21)",
    );
  });

  it("is checked after the ratio: when both limits are crossed, alias-expansion is reported", () => {
    ratio(SHARED, 3, 21); // E(t) = 3.40 and W(root) = 22
    size(SHARED, 21, 4); // ratio passes (3.40 <= 4), size fails
  });

  it("the cap passes where the ratio fails, and the ratio passes where the cap fails", () => {
    ratio(SHARED, 3, 22);
    okSize(SHARED, 22, 4);
  });

  it("an alias-free document is exempt, however large", () => {
    const text = Array.from({ length: 7 }, (_, i) => "k" + String(i + 1) + ": " + String(i + 1)).join("\n") + "\n";
    okSize(text, 3);
    // The same document with ONE harmless alias of a scalar is subject to the cap: W = 9.
    const withAlias = "k1: &x 1\n" + text.split("\n").slice(1).join("\n") + "k8: *x\n";
    size(withAlias, 3);
    okSize(withAlias, 9);
  });

  it("the cliff: a plain file far past the cap passes, one added alias subjects it to the cap", () => {
    // 200 maps of 49 scalars: W = 1 + 200 * 50 = 10 001 slots, alias-free. The cap is lowered to 5 000 so the
    // test stays small; the cliff is the same at the default of 1 000 000.
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) lines.push("m" + String(i) + ": " + flow(49));
    const plain = lines.join("\n") + "\n";
    okSize(plain, 5000);
    const err = size(plain + "z: &z 1\ny: *z\n", 5000);
    expect(err.message).toContain("expands to 10003 value slots");
  }, 60000);

  it("a merge key with no alias at all subjects the input to the cap (inline merge source)", () => {
    const text = "t: {<<: {a: 1}}\n"; // W(root) = 3
    size(text, 2);
    okSize(text, 3);
  });

  it("a quoted \"<<\" key is not a merge key, so the input stays exempt", () => {
    okSize('t: {"<<": {a: 1}}\n', 1);
  });

  it("an alias to a scalar counts as an alias", () => {
    size("a: &a 1\nb: *a\n", 2);
  });

  it("a merge-position alias to a sequence, and an alias inside a sequence, count too", () => {
    size("s: &s [{a: 1}]\nz: {<<: *s}\n", 2);
    size("- &a {x: 1}\n- *a\n", 2);
  });

  it("an alias to an anchor that is not defined is the library's syntax error, not a size error", () => {
    syntax("- *nope\n", { maxExpandedSlots: 1 });
    syntax("- {a: 1}\n- *nope\n", { maxExpandedSlots: 1 });
    syntax("a: &a 1\nb: *a\nc: *nope\n", { maxExpandedSlots: 2 });
  });

  it("the check is a bound on the structural count: an overridden merged key still counts (D-19)", () => {
    // q: W = 1 + (2 - 1) + 1 = 3 although it materializes {k: 9}. Root: 1 + 2 + 3 = 6.
    const text = "p: &p {k: 1}\nq: &q {<<: *p, k: 9}\n";
    okSize(text, 6);
    size(text, 5);
  });

  it("the walk is exact for a worked mix of merge, plain alias, carrier and sequence (W(root) = 21)", () => {
    // p: 2; q: 1 + 1 + 1 = 3; r: {n: *q}: 4; s: &s [*p, *q]: 1 + 2 + 3 = 6;
    // z: {<<: *s, m: 3}: 1 + (1 + 2) + 1 = 5 (the members flatten: W - 1 = 1 and 2).
    const text = "p: &p {k: 1}\nq: &q {<<: *p, m: 2}\nr: &r {n: *q}\ns: &s [*p, *q]\nz: {<<: *s, m: 3}\n";
    // Root: 1 + 2 + 3 + 4 + 6 + 5 = 21.
    okSize(text, 21);
    size(text, 20);
  });
});

describe("D-22: option validation (D-10, D-11)", () => {
  it("defaults to 1 000 000", () => {
    expect(DEFAULT_MAX_EXPANDED_SLOTS).toBe(1_000_000);
    expect(resolveMaxExpandedSlots(undefined)).toBe(1_000_000);
  });

  it("zero, negative and NaN select the default, never 'no limit'", () => {
    for (const v of [0, -1, -1e9, Number.NaN, Number.NEGATIVE_INFINITY]) {
      expect(resolveMaxExpandedSlots(v)).toBe(1_000_000);
    }
  });

  it("an integer up to the recommended ceiling is used as given", () => {
    expect(resolveMaxExpandedSlots(1)).toBe(1);
    expect(resolveMaxExpandedSlots(MAX_RECOMMENDED_EXPANDED_SLOTS)).toBe(10_000_000);
    expect(MAX_RECOMMENDED_EXPANDED_SLOTS).toBe(10_000_000);
  });

  it("a value above the ceiling, infinite or fractional is a RangeError, from readYaml and from the registry", () => {
    for (const v of [10_000_001, 1e12, Number.POSITIVE_INFINITY, 2.5]) {
      expect(() => readYaml("a: 1\n", { maxExpandedSlots: v })).toThrow(RangeError);
      expect(() => getFormat("yaml").read("a: 1\n", { maxExpandedSlots: v })).toThrow(/maxExpandedSlots must be an integer from 1 to 10000000/);
    }
  });

  it("zero selects the default: a document of 1 000 000 slots is accepted, 1 000 001 rejected (check only)", () => {
    // `- &b {48 scalars}` is W = 49; then 20407 aliases of it and r scalars: W = 999 993 + r.
    const build = (r: number): string => {
      const lines = ["- &b " + flow(48)];
      for (let i = 0; i < 20407; i++) lines.push("- *b");
      for (let i = 0; i < r; i++) lines.push("- " + String(i));
      return lines.join("\n") + "\n";
    };
    // The materialization is not this test's business, so only the check runs on the parsed AST.
    const run = (r: number, slots: number): void => {
      const text = build(r);
      checkAliasExpansion(YAML.parseDocument(text, { schema: "yaml-1.1" }).contents, 50, text, resolveMaxExpandedSlots(slots));
    };
    run(7, 0);
    expect(() => run(8, 0)).toThrow(/expands to 1000001 value slots, over the maximum expanded size \(1000000\)/);
    run(8, 1_000_001);
    // Through readYaml the rejection is the same error, raised before anything is materialized.
    limit(build(8), EXPANDED_SIZE_CODE, { maxExpandedSlots: 0 });
  }, 120000);

  it("checkAliasExpansion falls back to the default cap when none is given", () => {
    const text = "a: &a 1\nb: *a\n";
    const parsed = YAML.parseDocument(text, { schema: "yaml-1.1" });
    expect(() => checkAliasExpansion(parsed.contents, 50, text)).not.toThrow();
    expect(() => checkAliasExpansion(parsed.contents, 50, text, 2)).toThrow(DocumentError);
  });

  it("the two options are independent", () => {
    const text = "a: &a " + flow(5) + "\nb: *a\nc: *a\n";
    // Root: W = 1 + 6 + 6 + 6 = 19, S = 1 + 6 + 1 + 1 = 9 (E = 2.11).
    okSize(text, 19, 4);
    ratio(text, 2, 1_000_000);
  });
});

describe("D-22: a memory bomb the ratio check cannot see", () => {
  /**
   * 40 000 containers that each alias one 49-slot block: every E is 25.5, W(root) is 2 000 050. A root
   * sequence, because the `yaml` package parses a big block mapping in quadratic time (every key is
   * checked against all earlier ones), which is the library's cost and not this check's.
   */
  function bomb(containers: number): string {
    return "- &b " + flow(48) + "\n" + "- {x: *b}\n".repeat(containers);
  }

  it("is rejected with document.limit.expanded-size; only the check is timed", () => {
    const text = bomb(40000);
    // The `yaml` package's own parse is not this check's cost, so it is outside the timer.
    const parsed = YAML.parseDocument(text, { schema: "yaml-1.1" });
    const t0 = performance.now();
    let err: unknown;
    try {
      checkAliasExpansion(parsed.contents, 50, text);
    } catch (e) {
      err = e;
    }
    const ms = performance.now() - t0;
    expect(err).toBeInstanceOf(DocumentError);
    expect((err as DocumentError).code).toBe(EXPANDED_SIZE_CODE);
    // 1 + 49 + 40000 * 50 = 2 000 050 slots.
    expect((err as DocumentError).message).toContain("expands to 2000050 value slots");
    // Generous: the coverage run instruments this code; uninstrumented it is milliseconds.
    expect(ms).toBeLessThan(3000);
    // The ratio check alone accepts it: raising the cap to the ceiling admits it.
    expect(() => checkAliasExpansion(parsed.contents, 50, text, 10_000_000)).not.toThrow();
  }, 120000);

  it("through readYaml end to end, and through the CLI, before anything is materialized", () => {
    const text = bomb(40000);
    limit(text, EXPANDED_SIZE_CODE, {});
    const out: string[] = [];
    const err: string[] = [];
    const sink = (buf: string[]): NodeJS.WritableStream =>
      ({ write: (c: unknown) => (buf.push(String(c)), true) }) as unknown as NodeJS.WritableStream;
    const code = main(["convert", "-", "--from", "yaml", "--to", "json", "--json"], { stdout: sink(out), stderr: sink(err), stdin: text });
    expect(code).toBe(2);
    const payload = JSON.parse(out.join("")) as { errors: { code: string; path: string }[] };
    expect(payload.errors[0]).toMatchObject({ code: EXPANDED_SIZE_CODE, path: "$" });
  }, 120000);

  it("also through a schema-directed read", () => {
    const schema = parseSchema('record R { "b": any }\nroot R');
    expect(() => readYaml(bomb(40000), { schema })).toThrow(/expands to 2000050/);
  }, 120000);
});

describe("D-19/D-22: W is exact past 2^53 (arbitrary precision, never wrapped or rounded)", () => {
  /** `a0` over one scalar, then each level refers to the previous one `branching` times. */
  function tower(branching: number, levels: number): string {
    const lines = ["a0: &a0 {k: x}"];
    for (let i = 1; i <= levels; i++) {
      const refs = Array.from({ length: branching }, (_, j) => "p" + String(j) + ": *a" + String(i - 1)).join(", ");
      lines.push("a" + String(i) + ": &a" + String(i) + " {" + refs + "}");
    }
    return lines.join("\n") + "\n";
  }

  it("2 branches x 70 levels: W(root) = 3 * 2^71 - 73 is reported to the digit", () => {
    const text = tower(2, 70);
    const parsed = YAML.parseDocument(text, { schema: "yaml-1.1" });
    // With the public options the first level over the ratio stops the walk (alias-expansion) long before
    // W grows large, which is the point of checking as the walk goes. The internal entry point lets the
    // ratio maximum be set past anything the option admits, so the whole tower is counted: W(a_i) = 3 * 2^i - 1
    // and W(root) = 1 + sum = 3 * 2^71 - 73 = 7083549724304467820471, far past 2^53 = 9007199254740992.
    let err: unknown;
    try {
      checkAliasExpansion(parsed.contents, 1e30, text, 1e21);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DocumentError);
    expect((err as DocumentError).code).toBe(EXPANDED_SIZE_CODE);
    expect((err as DocumentError).message).toContain("expands to 7083549724304467820471 value slots");
  });

  it("through the public option the same tower is refused by the ratio, at the first level over it", () => {
    ratio(tower(2, 70), 10000);
    ratio(tower(2, 70), 50);
  });
});

describe("D-22: realistic documents are accepted at the defaults (false-positive guards)", () => {
  /** `services` compose-style entries each merging one `keys`-key defaults block. */
  function compose(services: number, keys: number): string {
    const lines = ["x-base: &base " + flow(keys)];
    for (let i = 0; i < services; i++) lines.push("svc" + String(i) + ": {<<: *base, image: img" + String(i) + "}");
    return lines.join("\n") + "\n";
  }

  it("100 services merging a 20-key block: W = 1 + 21 + 100 * 22 = 2 222", () => {
    const text = compose(100, 20);
    ok(text, {});
    okSize(text, 2222);
    size(text, 2221);
  });

  it("100 services merging a 60-key block: W = 6 262, worst E = 21", () => {
    const text = compose(100, 60);
    ok(text, {});
    okSize(text, 6262);
    size(text, 6261);
  });

  it("nested under a `services:` mapping the same documents read the spec's 2 223 / 6 263 / 62 063", () => {
    const nested = (services: number, keys: number): string => {
      const lines = ["x-base: &base " + flow(keys), "services:"];
      for (let i = 0; i < services; i++) lines.push("  svc" + String(i) + ": {<<: *base, image: img" + String(i) + "}");
      return lines.join("\n") + "\n";
    };
    for (const [services, keys, w] of [[100, 20, 2223], [100, 60, 6263], [1000, 60, 62063]] as const) {
      okSize(nested(services, keys), w);
      size(nested(services, keys), w - 1);
    }
  }, 120000);

  it("1000 services merging a 60-key block: W = 62 062", () => {
    const text = compose(1000, 60);
    ok(text, {});
    okSize(text, 62062);
    size(text, 62061);
  }, 120000);
});
