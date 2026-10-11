// The three universal safety limits (omnist-spec D-9, D-28, E-4a): configurable
// per call on every reader, coded `document.limit.depth` / `.nodes` at `$` and
// `.int-digits` at the literal's Document path, and counting the decimal digits
// of an integer's VALUE. Companion to the vendored vectors in
// document-model/limits*.json, which the Track 2 runner drives with the same
// options.
import { describe, expect, it } from "vitest";
import { Doc, doc } from "../src/document.js";
import {
  DEFAULT_LIMITS,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_INT_DIGITS,
  DEFAULT_MAX_NODES,
  bigintExceeds,
  depthIssue,
  digitsExceed,
  intDigitsIssue,
  nodesIssue,
  resolveLimits,
} from "../src/limits.js";
import { readFormat } from "../src/registry.js";
import { readJson } from "../src/formats/json.js";
import { readOml } from "../src/oml.js";
import { readToml } from "../src/formats/toml.js";
import { readXml } from "../src/formats/xml.js";
import { readYaml } from "../src/formats/yaml.js";
import { parseSchema } from "../src/osd.js";
import "../src/index.js";

/** What `fn` throws, as a {class, code, path} triple. */
function refusal(fn: () => unknown): { name: string; code: unknown; path: unknown } {
  try {
    fn();
  } catch (e) {
    const err = e as { code?: unknown; path?: unknown };
    return { name: (e as Error).constructor.name, code: err.code, path: err.path };
  }
  throw new Error("expected a refusal, but the call returned");
}

describe("resolveLimits", () => {
  it("defaults to the spec's reference values", () => {
    expect(resolveLimits()).toEqual({ maxDepth: 200, maxNodes: 1_000_000, maxIntDigits: 4300 });
    expect(resolveLimits({})).toEqual(DEFAULT_LIMITS);
    expect([DEFAULT_MAX_DEPTH, DEFAULT_MAX_NODES, DEFAULT_MAX_INT_DIGITS]).toEqual([200, 1_000_000, 4300]);
  });

  it("takes each value as given", () => {
    expect(resolveLimits({ maxDepth: 3, maxNodes: 7, maxIntDigits: 9 })).toEqual({ maxDepth: 3, maxNodes: 7, maxIntDigits: 9 });
  });

  it.each([0, -1, 1.5, NaN, Infinity])("refuses %s with a RangeError: a limit is never 'none' (D-10)", (bad) => {
    expect(() => resolveLimits({ maxDepth: bad })).toThrow(RangeError);
    expect(() => resolveLimits({ maxNodes: bad })).toThrow(/maxNodes must be an integer of at least 1/);
    expect(() => resolveLimits({ maxIntDigits: bad })).toThrow(/maxIntDigits/);
  });

  it("refuses a non-number", () => {
    expect(() => resolveLimits({ maxDepth: "3" as unknown as number })).toThrow(RangeError);
  });

  it("builds the three diagnostics", () => {
    expect(depthIssue(3)).toEqual({ message: "nesting exceeds the maximum depth (3)", code: "document.limit.depth", path: "$" });
    expect(nodesIssue(2)).toEqual({ message: "node count exceeds the maximum (2)", code: "document.limit.nodes", path: "$" });
    const i = intDigitsIssue(3, "$.a[1]");
    expect([i.code, i.path]).toEqual(["document.limit.int-digits", "$.a[1]"]);
    expect(i.message).toContain("$.a[1]: integer has more than 3 digits");
  });
});

describe("digitsExceed / bigintExceeds (D-28: the digits of the value)", () => {
  it("measures a decimal literal by its length without leading zeros", () => {
    expect(digitsExceed("999", 10, 3)).toBe(false);
    expect(digitsExceed("1000", 10, 3)).toBe(true);
    expect(digitsExceed("00000999", 10, 3)).toBe(false);
    expect(digitsExceed("0", 10, 1)).toBe(false);
    expect(digitsExceed("000", 10, 1)).toBe(false);
  });

  it("measures other radixes by the value they denote", () => {
    expect(digitsExceed("3E7", 16, 3)).toBe(false); // 999
    expect(digitsExceed("3E8", 16, 3)).toBe(true); // 1000
    expect(digitsExceed("FFF", 16, 3)).toBe(true); // 4095
    expect(digitsExceed("1747", 8, 3)).toBe(false); // 999
    expect(digitsExceed("1750", 8, 3)).toBe(true); // 1000
    expect(digitsExceed("1111100111", 2, 3)).toBe(false); // 999
    expect(digitsExceed("1111101000", 2, 3)).toBe(true); // 1000
    expect(digitsExceed("0", 16, 1)).toBe(false);
  });

  it("decides a huge literal from its length alone, and a borderline one exactly", () => {
    // 3 600 hex digits are a value of 4 335 decimal digits; 4 301 binary digits, 1 295.
    expect(digitsExceed("F".repeat(3600), 16, 4300)).toBe(true);
    expect(digitsExceed("1".repeat(4301), 2, 4300)).toBe(false);
    // A 100 000 000-digit literal is refused without converting it (this would take minutes).
    expect(digitsExceed("F".repeat(100_000_000), 16, 4300)).toBe(true);
    // Within a digit or two of the limit the value is converted and counted exactly.
    const edge = (10n ** 99n).toString(16);
    expect(digitsExceed(edge, 16, 100)).toBe(false);
    expect(digitsExceed(edge, 16, 99)).toBe(true);
  });

  it("counts a bigint by value, sign excluded", () => {
    expect(bigintExceeds(999n, 3)).toBe(false);
    expect(bigintExceeds(-999n, 3)).toBe(false);
    expect(bigintExceeds(1000n, 3)).toBe(true);
    expect(bigintExceeds(-1000n, 3)).toBe(true);
    expect(bigintExceeds(0n, 1)).toBe(false);
  });
});

describe("depth: levels of node nesting from the root, the root being level 1", () => {
  // make(n): a document with n edges in a chain from the root to a scalar leaf, so its
  // deepest node is level n (the root is level 1).
  const cases: [string, (n: number) => string, (t: string, d: number) => unknown][] = [
    ["oml", (n) => "a: " + "{ a: ".repeat(n - 1) + "1" + " }".repeat(n - 1), (t, d) => readOml(t, { maxDepth: d })],
    ["json", (n) => '{"a":'.repeat(n) + "1" + "}".repeat(n), (t, d) => readJson(t, { maxDepth: d })],
    [
      "yaml",
      (n) => Array.from({ length: n }, (_, i) => "  ".repeat(i) + "a:").join("\n") + " 1\n",
      (t, d) => readYaml(t, { maxDepth: d }),
    ],
    ["toml", (n) => "[" + Array.from({ length: n - 1 }, () => "a").join(".") + "]\nb = 1\n", (t, d) => readToml(t, { maxDepth: d })],
    ["xml", (n) => "<a>".repeat(n) + "x" + "</a>".repeat(n), (t, d) => readXml(t, { maxDepth: d })],
  ];

  it.each(cases)("%s: a document of N levels is read at maxDepth N and refused at N - 1, at $", (_fmt, make, read) => {
    // The deepest node of make(4) is level 4 (the root is level 1).
    expect(() => read(make(4), 4)).not.toThrow();
    expect(refusal(() => read(make(4), 3))).toMatchObject({ code: "document.limit.depth", path: "$" });
  });

  it("is 200 by default in every format", () => {
    const readers: Record<string, (text: string) => unknown> = { oml: readOml, json: readJson, yaml: readYaml, toml: readToml, xml: readXml };
    for (const [fmt, make] of cases) {
      const read = readers[fmt] as (text: string) => unknown;
      expect(() => read(make(DEFAULT_MAX_DEPTH))).not.toThrow();
      expect(refusal(() => read(make(DEFAULT_MAX_DEPTH + 1)))).toMatchObject({ code: "document.limit.depth", path: "$" });
    }
  });

  it("is a DocumentError from a builder and a ParseError from the OML reader", () => {
    expect(refusal(() => readJson('{"a": {"b": 1}}', { maxDepth: 1 })).name).toBe("DocumentError");
    expect(refusal(() => readOml("a: { b: 1 }", { maxDepth: 1 })).name).toBe("ParseError");
  });

  it("counts a repeated label's targets at their siblings' depth, not one deeper", () => {
    // $.a is a node at level 2 whether it is written once or repeated.
    expect(() => readJson('{"a": [{"b": 1}, {"b": 2}]}', { maxDepth: 2 })).not.toThrow();
    expect(() => readJson('{"a": {"b": 1}}', { maxDepth: 2 })).not.toThrow();
    expect(refusal(() => readJson('{"a": [{"b": {"c": 1}}]}', { maxDepth: 2 }))).toMatchObject({ code: "document.limit.depth" });
  });

  it("does not count a scalar leaf as a level", () => {
    expect(() => readJson('{"a": 1}', { maxDepth: 1 })).not.toThrow();
    expect(refusal(() => readJson('{"a": {"b": 1}}', { maxDepth: 1 }))).toMatchObject({ code: "document.limit.depth" });
  });
});

describe("node count: the root and every node, not a scalar leaf", () => {
  it.each([
    ["oml", "a: 1\nb: 2\n", "a: { b: 1 }\n", (t: string, n: number) => readOml(t, { maxNodes: n })],
    ["json", '{"a": 1, "b": 2}', '{"a": {"b": 1}}', (t: string, n: number) => readJson(t, { maxNodes: n })],
    ["yaml", "a: 1\nb: 2\n", "a:\n  b: 1\n", (t: string, n: number) => readYaml(t, { maxNodes: n })],
    ["toml", "a = 1\nb = 2\n", "[a]\nb = 1\n", (t: string, n: number) => readToml(t, { maxNodes: n })],
    ["xml", "<a>1</a>", "<r><a>1</a></r>", (t: string, n: number) => readXml(t, { maxNodes: n })],
  ])("%s: one node (the root) fits maxNodes 1, a second does not", (_fmt, within, over, read) => {
    expect(() => read(within, 1)).not.toThrow();
    expect(refusal(() => read(over, 1))).toMatchObject({ code: "document.limit.nodes", path: "$" });
  });
});

describe("integer digits: the value's decimal digits, at the literal's Document path", () => {
  const at = { code: "document.limit.int-digits" };

  it("OML: at the limit is read, past it is refused at the path; the sign is not counted", () => {
    expect(() => readOml("n: 999\n", { maxIntDigits: 3 })).not.toThrow();
    expect(() => readOml("n: -999\n", { maxIntDigits: 3 })).not.toThrow();
    expect(refusal(() => readOml("n: 1000\n", { maxIntDigits: 3 }))).toEqual({ name: "ParseError", code: at.code, path: "$.n" });
    expect(refusal(() => readOml("n: -1000\n", { maxIntDigits: 3 })).path).toBe("$.n");
  });

  it("OML: the path is indexed per E-10 for a repeated label, in an array and across edges", () => {
    expect(refusal(() => readOml("a: [1, 2000]\n", { maxIntDigits: 3 })).path).toBe("$.a[1]");
    expect(refusal(() => readOml("a: 1\nb: { c: 1 }\na: 2000\n", { maxIntDigits: 3 })).path).toBe("$.a[1]");
    expect(refusal(() => readOml("a: { b: 1000 }\n", { maxIntDigits: 3 })).path).toBe("$.a.b");
  });

  it("OML: a bare top-level integer is refused at $", () => {
    expect(refusal(() => readOml("1000", { maxIntDigits: 3 })).path).toBe("$");
  });

  it("OML: an over-long literal is refused without being converted (4 000 000 digits, instantly)", () => {
    const t = Date.now();
    expect(refusal(() => readOml("n: " + "7".repeat(4_000_000)))).toMatchObject({ code: at.code, path: "$.n" });
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it("JSON: at and past the limit, sign excluded, with indexed and nested paths", () => {
    expect(() => readJson('{"a": 999}', { maxIntDigits: 3 })).not.toThrow();
    expect(() => readJson('{"a": -999}', { maxIntDigits: 3 })).not.toThrow();
    expect(refusal(() => readJson('{"a": 1000}', { maxIntDigits: 3 }))).toEqual({ name: "ParseError", code: at.code, path: "$.a" });
    expect(refusal(() => readJson('{"a": -1000}', { maxIntDigits: 3 })).path).toBe("$.a");
    expect(refusal(() => readJson('{"a": [1, 2000]}', { maxIntDigits: 3 })).path).toBe("$.a[1]");
    expect(refusal(() => readJson('{"a": {"b": 1000}}', { maxIntDigits: 3 })).path).toBe("$.a.b");
  });

  it("JSON: a float or an exponent is not an integer literal", () => {
    expect(() => readJson('{"a": 1000.5, "b": 1e1000}', { maxIntDigits: 3 })).not.toThrow();
  });

  it("YAML: decimal, hex, octal, binary, underscored and leading-zero literals are counted by value (D-28)", () => {
    const ok = (t: string): void => void readYaml(t, { maxIntDigits: 3 });
    const bad = (t: string): { name: string; code: unknown; path: unknown } => refusal(() => readYaml(t, { maxIntDigits: 3 }));
    ok("a: 999\n");
    ok("a: -999\n");
    ok("a: +999\n");
    ok("a: 0x3E7\n");
    ok("a: 0b1111100111\n");
    ok("a: 01747\n");
    ok("a: 9_9_9\n");
    ok("a: 0000999\n");
    expect(bad("a: 1000\n")).toEqual({ name: "ParseError", code: at.code, path: "$.a" });
    expect(bad("a: -1000\n").path).toBe("$.a");
    expect(bad("a: 0xFFF\n").path).toBe("$.a");
    expect(bad("a: 0b1111101000\n").path).toBe("$.a");
    expect(bad("a: 01750\n").path).toBe("$.a");
    expect(bad("a: 1_000\n").path).toBe("$.a");
    expect(bad("a: [1, 2000]\n").path).toBe("$.a[1]");
  });

  it("YAML: a sexagesimal integer is counted on its converted value", () => {
    expect(() => readYaml("a: 190:20:30\n", { maxIntDigits: 6 })).not.toThrow();
    expect(refusal(() => readYaml("a: 190:20:30\n", { maxIntDigits: 5 })).path).toBe("$.a");
  });

  it("YAML: a word that merely ends in digits is a string, not an integer literal", () => {
    expect(readYaml("a: id" + "7".repeat(50) + "\n", { maxIntDigits: 3 })).toEqual([{ label: "a", target: "id" + "7".repeat(50) }]);
  });

  it("YAML: an over-long literal is refused without being converted", () => {
    const t = Date.now();
    expect(refusal(() => readYaml("a: " + "7".repeat(4_000_000) + "\n"))).toMatchObject({ code: at.code, path: "$.a" });
    expect(Date.now() - t).toBeLessThan(5000);
  });

  it("TOML: decimal, hex, octal, binary and underscored literals are counted by value (D-28)", () => {
    const ok = (t: string): void => void readToml(t, { maxIntDigits: 3 });
    const bad = (t: string): { name: string; code: unknown; path: unknown } => refusal(() => readToml(t, { maxIntDigits: 3 }));
    ok("a = 999\n");
    ok("a = -999\n");
    ok("a = 0x3E7\n");
    ok("a = 0o1747\n");
    ok("a = 0b1111100111\n");
    ok("a = 9_9_9\n");
    expect(bad("a = 1000\n")).toEqual({ name: "ParseError", code: at.code, path: "$.a" });
    expect(bad("a = 0xFFF\n").path).toBe("$.a");
    expect(bad("a = 0o1750\n").path).toBe("$.a");
    expect(bad("a = 0b1111101000\n").path).toBe("$.a");
    expect(bad("a = 1_000\n").path).toBe("$.a");
    expect(bad("[t]\na = [1, 2000]\n").path).toBe("$.t.a[1]");
  });

  it("TOML: a 3 600-digit hex literal exceeds the default; a 4 301-digit binary literal does not (D-28)", () => {
    expect(refusal(() => readToml("a = 0x" + "F".repeat(3600) + "\n"))).toMatchObject({ code: at.code, path: "$.a" });
    expect(() => readToml("a = 0b" + "1".repeat(4301) + "\n")).not.toThrow();
  });

  describe("TOML: a huge decimal literal is found in the text and refused before it is converted", () => {
    const huge = "9".repeat(5000);

    it("at its path, signed or underscored, in a table and in an array", () => {
      expect(refusal(() => readToml("a = " + huge + "\n"))).toEqual({ name: "ParseError", code: at.code, path: "$.a" });
      expect(refusal(() => readToml("a = -" + huge + "\n")).path).toBe("$.a");
      expect(refusal(() => readToml("a = +" + huge + "\n")).path).toBe("$.a");
      expect(refusal(() => readToml("a = " + "9_".repeat(4400) + "9\n")).path).toBe("$.a");
      expect(refusal(() => readToml("[t]\nb = 1\nc = [1, " + huge + "]\n")).path).toBe("$.t.c[1]");
    });

    it("is refused quickly: 4 000 000 digits are not converted", () => {
      const t = Date.now();
      expect(refusal(() => readToml("a = " + "7".repeat(4_000_000) + "\n", { maxIntDigits: 100 }))).toMatchObject({ code: at.code });
      expect(Date.now() - t).toBeLessThan(5000);
    });

    it("skips what only looks like one: comments, strings, floats, dates, words, and a run under the limit", () => {
      const ok = (t: string): unknown => readToml(t);
      ok("# " + huge + "\na = 1\n");
      ok('s = "' + huge + '"\n');
      ok("s = '" + huge + "'\n");
      ok('s = "a\\\\b"\nf = ' + huge + ".5\n");
      ok("f = " + huge + "e5\n");
      ok("a = 1\nd = 1979-05-27\n");
      ok("a = 1\n" + huge + "_x = 2\n");
      expect(() => readToml("a = " + "9".repeat(4300) + "\n")).not.toThrow();
    });

    it("a bare key made of digits is a key, not a literal", () => {
      expect(readToml(huge + " = 1\n")).toEqual([{ label: huge, target: 1n }]);
    });

    it("falls through to the ordinary parse when the text is invalid for another reason", () => {
      expect(refusal(() => readToml("a = " + huge + "\nb = \n"))).toMatchObject({ code: "parse.codec-syntax" });
    });

    it("falls through when the defused text is refused for another limit", () => {
      expect(refusal(() => readToml("[a.b.c]\nd = " + huge + "\n", { maxDepth: 2 }))).toMatchObject({ code: "document.limit.depth" });
    });

    it("is not fooled by a string that looks like the marker it substitutes", () => {
      const lure = "omnist-overlong-0-" + "x".repeat(5000);
      expect(refusal(() => readToml('s = "' + lure + '"\na = ' + huge + "\n")).path).toBe("$.a");
    });
  });

  it("XML: a schema-directed integer leaf is refused at the leaf's path (E-4a), not left a string", () => {
    const s = parseSchema('record R { "n": integer }\nroot R');
    expect(readXml("<n>999</n>", { schema: s, maxIntDigits: 3 })).toEqual([{ label: "n", target: 999n }]);
    expect(refusal(() => readXml("<n>1000</n>", { schema: s, maxIntDigits: 3 }))).toEqual({
      name: "ParseError",
      code: at.code,
      path: "$.n",
    });
  });

  it("XML: the path of a repeated leaf is indexed", () => {
    const s = parseSchema('record Root { "r": R }\nrecord R { "n" [2,2]: integer }\nroot Root');
    expect(refusal(() => readXml("<r><n>1</n><n>1000</n></r>", { schema: s, maxIntDigits: 3 })).path).toBe("$.r.n[1]");
  });

  it("the Doc API refuses an over-long bigint at its path, with the code", () => {
    const e = refusal(() => doc({ a: [1n, 10n ** 4400n] }));
    expect(e).toEqual({ name: "DocumentError", code: at.code, path: "$.a[1]" });
    expect(() => Doc.of({ a: 10n ** 4299n })).not.toThrow();
  });
});

describe("the limits reach every reader through the registry, and are validated up front", () => {
  it.each(["oml", "json", "yaml", "toml", "xml"])("readFormat(%s) validates maxDepth/maxNodes/maxIntDigits", (fmt) => {
    for (const bad of [{ maxDepth: 0 }, { maxNodes: -1 }, { maxIntDigits: 1.5 }]) {
      expect(() => readFormat(fmt, "", bad)).toThrow(RangeError);
    }
  });

  it("readFormat passes a limit to the reader", () => {
    expect(refusal(() => readFormat("json", '{"a": {"b": 1}}', { maxDepth: 1 }))).toMatchObject({ code: "document.limit.depth" });
  });
});

describe("D-29: an overflowing number literal is an infinity, an underflowing one 0.0", () => {
  it("reads 1e999 as Infinity and 1e-999 as 0 in JSON, OML, YAML and TOML", () => {
    const only = (n: unknown): unknown => (n as { target: unknown }[])[0]?.target;
    expect(only(readJson('{"a": 1e999}'))).toBe(Infinity);
    expect(only(readJson('{"a": -1e999}'))).toBe(-Infinity);
    expect(only(readJson('{"a": 1e-999}'))).toBe(0);
    expect(only(readOml("a: 1e999\n"))).toBe(Infinity);
    expect(only(readOml("a: -1e999\n"))).toBe(-Infinity);
    expect(only(readYaml("a: 1.0e+999\n"))).toBe(Infinity);
    expect(only(readYaml("a: -1.0e+999\n"))).toBe(-Infinity);
    expect(only(readToml("a = 1e999\n"))).toBe(Infinity);
    expect(only(readToml("a = -1e999\n"))).toBe(-Infinity);
  });
});
