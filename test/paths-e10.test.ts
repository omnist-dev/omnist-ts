// omnist-spec v0.30.0-beta E-10 (Sec8.4): the index `[i]` is on EVERY edge of a
// label that occurs more than once in a node, the first included
// (`$.item[0]`, `$.item[1]`), and absent when the label occurs exactly once.
// The count is of the edges the node holds, per node. Every place that names
// a Document path builds it with src/paths.ts, so each is pinned here.
import { describe, expect, it } from "vitest";
import {
  Doc,
  WriteError,
  checkJson,
  checkXml,
  checkYaml,
  materialize,
  parseSchema,
  writeToml,
  type Edge,
  type Node,
} from "../src/index.js";
import { edgePaths } from "../src/paths.js";

function e(label: string, target: Node): Edge {
  return { label, target };
}

const OK_SCHEMA = 'record R {\n  "ok": string,\n}\nroot R\n';
const ITEM_SCHEMA = 'record I {\n  "sku": string,\n}\nrecord R {\n  "item" [1,]: I,\n}\nroot R\n';

const D = new Date(Date.UTC(2024, 0, 1));

describe("edgePaths (E-10)", () => {
  const cases: Array<[string, string[], string[]]> = [
    ["no edges", [], []],
    ["one edge", ["a"], ["$.a"]],
    ["all labels distinct", ["a", "b", "c"], ["$.a", "$.b", "$.c"]],
    ["a label twice: first included", ["a", "a"], ["$.a[0]", "$.a[1]"]],
    ["first, middle, last of three", ["a", "a", "a"], ["$.a[0]", "$.a[1]", "$.a[2]"]],
    ["a repeated label next to a unique one", ["a", "b", "a"], ["$.a[0]", "$.b", "$.a[1]"]],
    ["two repeated labels count separately", ["a", "b", "a", "b"], ["$.a[0]", "$.b[0]", "$.a[1]", "$.b[1]"]],
    ["a repeated label contiguous with a unique one", ["u", "a", "a"], ["$.u", "$.a[0]", "$.a[1]"]],
  ];
  it.each(cases)("%s", (_name, labels, expected) => {
    expect(edgePaths("$", labels.map((label) => ({ label })))).toEqual(expected);
  });

  it("builds on the given parent path", () => {
    expect(edgePaths("$.x[1]", [{ label: "a" }, { label: "a" }])).toEqual(["$.x[1].a[0]", "$.x[1].a[1]"]);
    expect(edgePaths("$.x", [{ label: "a" }])).toEqual(["$.x.a"]);
  });
});

describe("Doc.edges / validate paths", () => {
  it("indexes the first of a repeated label and nothing else", () => {
    const d = new Doc([e("a", 1n), e("a", 2n), e("b", 3n)]);
    expect(d.edges().map(([, c]) => c.path)).toEqual(["$.a[0]", "$.a[1]", "$.b"]);
  });

  it("a single edge has no index", () => {
    expect(new Doc([e("a", 1n)]).edges().map(([, c]) => c.path)).toEqual(["$.a"]);
  });

  it("paths are per node: $.item[1].tag and $.item[0].tag[1] in one document", () => {
    const d = new Doc([
      e("item", [e("tag", 1n), e("tag", 2n)]),
      e("item", [e("tag", 3n)]),
    ]);
    const paths: string[] = [];
    for (const [, item] of d.edges()) {
      for (const [, tag] of item.edges()) paths.push(tag.path);
    }
    expect(paths).toEqual(["$.item[0].tag[0]", "$.item[0].tag[1]", "$.item[1].tag"]);
  });

  it("validate reports an undeclared repeated field at indexed paths, first included", () => {
    const s = parseSchema(OK_SCHEMA);
    const r = s.validate(new Doc([e("ok", "x"), e("extra", 1n), e("extra", 2n)]));
    expect(r.errors.map((x) => x.path)).toEqual(["$.extra[0]", "$.extra[1]"]);
  });

  it("validate: an undeclared label occurring once is not indexed", () => {
    const s = parseSchema(OK_SCHEMA);
    const r = s.validate(new Doc([e("ok", "x"), e("extra", 1n)]));
    expect(r.errors.map((x) => x.path)).toEqual(["$.extra"]);
  });

  it("validate: the count is of the edges held, not the declared cardinality", () => {
    const s = parseSchema(ITEM_SCHEMA);
    const one = s.validate(new Doc([e("item", [e("sku", 1n)])]));
    expect(one.errors.map((x) => x.path)).toEqual(["$.item.sku"]);
  });
});

describe("materialize paths", () => {
  it("indexes the first of a repeated undeclared label", () => {
    const s = parseSchema(OK_SCHEMA);
    expect(() => materialize([e("extra", 1n), e("extra", 2n)], s)).toThrow();
    try {
      materialize([e("extra", 1n), e("extra", 2n)], s);
    } catch (exc) {
      const paths = (exc as { errors: Array<{ path: string }> }).errors.map((x) => x.path);
      expect(paths).toContain("$.extra[0]");
      expect(paths).toContain("$.extra[1]");
    }
  });

  it("a single occurrence has no index", () => {
    const s = parseSchema(OK_SCHEMA);
    try {
      materialize([e("extra", 1n)], s);
      expect.unreachable();
    } catch (exc) {
      const paths = (exc as { errors: Array<{ path: string }> }).errors.map((x) => x.path);
      expect(paths).toContain("$.extra");
      expect(paths).not.toContain("$.extra[0]");
    }
  });
});

describe("writer diagnostics use E-10 paths", () => {
  it("JSON: a temporal leaf under a repeated label", () => {
    const rep = checkJson([e("d", D), e("d", D), e("x", D)]);
    expect(rep.adjustments.map((a) => a.path)).toEqual(["$.d[0]", "$.d[1]", "$.x"]);
  });

  it("YAML: a NEL label under a repeated label", () => {
    const rep = checkYaml([e("a\x85", 1n), e("a\x85", 2n)]);
    expect(rep.adjustments.map((a) => a.path)).toEqual(["$.a\x85[0]", "$.a\x85[1]"]);
  });

  it("XML: a null leaf under a repeated label", () => {
    const rep = checkXml([e("r", [e("n", null), e("n", null), e("m", null)])]);
    expect(rep.adjustments.map((a) => a.path)).toEqual(["$.r.n[0]", "$.r.n[1]", "$.r.m"]);
  });

  it("TOML: the null-leaf error names the indexed first occurrence", () => {
    try {
      writeToml([e("n", null), e("n", 1n)]);
      expect.unreachable();
    } catch (exc) {
      expect(exc).toBeInstanceOf(WriteError);
      expect((exc as WriteError).path).toBe("$.n[0]");
    }
  });
});
