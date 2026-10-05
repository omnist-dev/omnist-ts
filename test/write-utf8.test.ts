// omnist-spec v0.32.0-beta C-9 (Sec7.3; DIV-5): ALL five writers MUST fail with
// `write.unsupported-value`, unconditionally, on any string value or edge label
// that has no UTF-8 encoding (in JavaScript, a UTF-16 lone surrogate). Emitting
// it as an escape or raw does not comply. The path is the Document path of the
// node HOLDING the string: the leaf for a value (indexed per E-10), the node
// that holds the edge for a label.
import { describe, expect, it } from "vitest";
import {
  WriteError,
  checkJson,
  checkOml,
  checkToml,
  checkXml,
  checkYaml,
  readJson,
  readOml,
  readToml,
  readXml,
  readYaml,
  writeJson,
  writeOml,
  writeToml,
  writeXml,
  writeYaml,
  type Edge,
  type Node,
} from "../src/index.js";
import { checkEncodable } from "../src/encodable.js";

// Written as \u{...} escapes: a lone surrogate cannot live in a UTF-8 source file.
const HI = "\u{d800}"; // a lone high surrogate
const LO = "\u{dc00}"; // a lone low surrogate
const GRIN = "\u{1F600}"; // a valid pair: an astral character, which encodes

function e(label: string, target: Node): Edge {
  return { label, target };
}

interface Writer {
  readonly name: string;
  readonly write: (node: Node, opts?: { strict?: boolean }) => string;
  readonly check: (node: Node) => unknown;
  readonly read: (text: string) => Node;
}

const WRITERS: Writer[] = [
  { name: "JSON", write: (n, o) => writeJson(n, o), check: checkJson, read: (t) => readJson(t) },
  { name: "YAML", write: (n, o) => writeYaml(n, o), check: checkYaml, read: (t) => readYaml(t) },
  { name: "TOML", write: (n, o) => writeToml(n, o), check: checkToml, read: (t) => readToml(t) },
  { name: "XML", write: (n, o) => writeXml(n, o), check: checkXml, read: (t) => readXml(t) },
  { name: "OML", write: (n) => writeOml(n), check: checkOml, read: (t) => readOml(t) },
];

function failure(fn: () => unknown): WriteError {
  try {
    fn();
  } catch (exc) {
    expect(exc).toBeInstanceOf(WriteError);
    return exc as WriteError;
  }
  throw new Error("expected the writer to fail, it returned");
}

// [description, node, expected path]
const OFFENDERS: Array<[string, Node, string]> = [
  ["a lone high surrogate in a value", [e("a", 1n), e("b", "x" + HI)], "$.b"],
  ["a lone low surrogate in a value", [e("a", "y" + LO)], "$.a"],
  ["a surrogate pair reversed is two lone surrogates", [e("a", LO + HI)], "$.a"],
  ["a lone high surrogate at the very end of a value", [e("a", "tail" + HI)], "$.a"],
  ["a lone high surrogate followed by an ordinary character", [e("a", HI + "z")], "$.a"],
  ["a repeated label is indexed: the second occurrence", [e("a", "ok"), e("a", "y" + LO)], "$.a[1]"],
  ["a repeated label is indexed: the first occurrence", [e("a", "y" + LO), e("a", "ok")], "$.a[0]"],
  ["a nested value", [e("r", [e("k", "v"), e("k", "v" + HI)])], "$.r.k[1]"],
  ["a lone surrogate in a label is reported at the node holding the edge", [e("r", [e("x" + HI, 1n)])], "$.r"],
  ["a lone surrogate in a root label is reported at $", [e("a" + LO, "v")], "$"],
  ["a bad label wins over a bad value in an earlier edge: labels come first", [e("a", "v" + HI), e("b" + HI, "v")], "$"],
  ["the first offender in document order is the one reported", [e("a", "1" + HI), e("b", "2" + HI)], "$.a"],
  ["a bad value inside a later edge, a good one before it", [e("a", [e("k", "fine")]), e("b", [e("k", "bad" + HI)])], "$.b.k"],
  ["a scalar root", "x" + HI, "$"],
];

describe.each(WRITERS)("$name writer: C-9", ({ name, write, check }) => {
  it.each(OFFENDERS)("write: %s", (_what, node, path) => {
    const err = failure(() => write(node));
    expect(err.code).toBe("write.unsupported-value");
    expect(err.path).toBe(path);
    // The label itself is never put in a path (Sec8.4 cannot quote one).
    expect(err.path).not.toContain(HI);
    expect(err.path).not.toContain(LO);
  });

  it.each(OFFENDERS)("check: %s", (_what, node, path) => {
    const err = failure(() => check(node));
    expect(err.code).toBe("write.unsupported-value");
    expect(err.path).toBe(path);
  });

  it("is unconditional: strict: false is not an escape hatch, and neither is strict: true", () => {
    const node: Node = [e("a", "x" + HI)];
    expect(failure(() => write(node, { strict: false })).code).toBe("write.unsupported-value");
    expect(failure(() => write(node, { strict: true })).code).toBe("write.unsupported-value");
  });

  it("is checked before the writer's own structural refusals", () => {
    // Two root edges: XML would refuse them as format.multiple-roots, TOML a root
    // that is not a table; C-9 is decided first.
    const node: Node = [e("a", "x" + HI), e("b", 1n)];
    expect(failure(() => write(node)).code).toBe("write.unsupported-value");
  });

  it(`${name}: a valid surrogate pair (an astral character) still writes`, () => {
    const node: Node = [e("r", [e("a", "hi " + GRIN)])];
    expect(() => write(node)).not.toThrow();
    expect(() => check(node)).not.toThrow();
  });

  it(`${name}: a document with no strings writes`, () => {
    expect(() => write([e("r", [e("n", 1n)])])).not.toThrow();
  });
});

describe("a valid pair round-trips where the writer can carry it (not just 'does not throw')", () => {
  it.each(WRITERS.filter((w) => w.name !== "XML"))("$name: the astral value and label", ({ write, read }) => {
    const node: Node = [e(GRIN, "v" + GRIN)];
    const back = read(write(node)) as Edge[];
    expect(back).toEqual(node);
  });

  it("XML: the astral value", () => {
    const node: Node = [e("r", "v" + GRIN)];
    expect(readXml(writeXml(node))).toEqual(node);
  });
});

describe("what encodes is not refused", () => {
  const encodes: Array<[string, string]> = [
    ["the empty string", ""],
    ["a replacement character", "\u{fffd}"],
    ["an astral character at the start", GRIN + "x"],
    ["two pairs in a row", GRIN + GRIN],
    ["a pair after a character", "a" + GRIN],
  ];
  it.each(encodes)("%s", (_what, value) => {
    expect(() => checkEncodable([e("a", value)])).not.toThrow();
    expect(() => checkEncodable([e(value, 1n)])).not.toThrow();
  });
});

describe("checkEncodable", () => {
  it("accepts a document of every non-string scalar", () => {
    expect(() => checkEncodable([e("a", 1n), e("b", 1.5), e("c", true), e("d", null), e("e", new Date(0))])).not.toThrow();
  });

  it("accepts the empty document and a scalar root", () => {
    expect(() => checkEncodable([])).not.toThrow();
    expect(() => checkEncodable("plain")).not.toThrow();
    expect(() => checkEncodable(1n)).not.toThrow();
  });

  it("a deeply nested document is walked iteratively (no stack overflow)", () => {
    let node: Node = "leaf";
    for (let i = 0; i < 50_000; i++) node = [e("k", node)];
    expect(() => checkEncodable(node)).not.toThrow();
    let bad: Node = "leaf" + HI;
    for (let i = 0; i < 2_000; i++) bad = [e("k", bad)];
    const err = failure(() => checkEncodable(bad));
    expect(err.code).toBe("write.unsupported-value");
    expect(err.path).toBe("$" + ".k".repeat(2_000));
  });
});
