import { describe, expect, it } from "vitest";
import { doc, buildNode, Doc, type Node } from "../src/document.js";
import { DocumentError } from "../src/errors.js";

// Ported from upstream omnist's tests/test_canonical.py::TestDocument,
// tests/test_canonical.py::TestDocumentRobustness (Doc-focused subset),
// and tests/test_depth_guards.py::TestDocExport.

describe("Doc: build and navigate", () => {
  it("builds and navigates an object", () => {
    const d = doc({ name: "Ann", age: 30 });
    expect(d.isLeaf).toBe(false);
    expect(d.labels()).toEqual(["name", "age"]);
    expect(d.getOne("name").value).toBe("Ann");
    expect(d.getOne("age").value).toBe(30);
  });

  it("repeated label is an array", () => {
    const d = doc({ member: [{ n: 1 }, { n: 2 }] });
    expect(d.count("member")).toBe(2);
    const members = d.get("member");
    expect(members[0]?.getOne("n").value).toBe(1);
    expect(members[1]?.getOne("n").value).toBe(2);
  });

  it("toData is an edge list", () => {
    const d = doc({ a: 1, xs: [1, 2] });
    expect(d.toData()).toEqual([
      { label: "a", target: 1 },
      { label: "xs", target: 1 },
      { label: "xs", target: 2 },
    ]);
  });

  it("toGrouped projects back to JSON shape", () => {
    const d = doc({ a: 1, xs: [1, 2] });
    expect(d.toGrouped()).toEqual({ a: 1, xs: [1, 2] });
  });

  it("rejects a bare array", () => {
    expect(() => doc([1, 2, 3])).toThrow(DocumentError);
  });

  it("rejects an array of arrays", () => {
    expect(() => doc({ m: [[1, 2], [3, 4]] })).toThrow(DocumentError);
  });

  it("rejects a non-string key", () => {
    // JS object keys are always strings; simulate the Python "non-string
    // key" case via a Map key, which build_node must also reject.
    expect(() => buildNode(new Map([[1, "a"]]))).toThrow(DocumentError);
  });

  it("supports editing: add, set, remove, child cursors", () => {
    const d = doc({ name: "Ann" });
    d.add("tag", "x").add("tag", "y");
    expect(d.count("tag")).toBe(2);
    d.set("name", "Bob");
    expect(d.getOne("name").value).toBe("Bob");
    d.set("age", 30);
    expect(d.getOne("age").value).toBe(30);
    d.remove("tag");
    expect(d.count("tag")).toBe(0);

    const d2 = doc({ addr: { city: "X" } });
    d2.child("addr").set("city", "Y");
    expect(d2.toGrouped()).toEqual({ addr: { city: "Y" } });
  });

  it("set() on an absent label appends", () => {
    const d = doc({ a: 1 });
    d.set("b", 2);
    expect(d.toData()).toEqual([
      { label: "a", target: 1 },
      { label: "b", target: 2 },
    ]);
  });

  it("set() on a single label is unchanged behavior", () => {
    const d = doc({ a: 1, b: 2 });
    d.set("a", 99);
    expect(d.toData()).toEqual([
      { label: "a", target: 99 },
      { label: "b", target: 2 },
    ]);
    expect(d.count("a")).toBe(1);
    expect(d.getOne("a").value).toBe(99);
  });

  it("set() on a repeated label collapses to one at the first position", () => {
    const d = doc({ a: 1 });
    d.add("a", 2);
    d.add("b", 9);
    d.set("a", 99);
    expect(d.toData()).toEqual([
      { label: "a", target: 99 },
      { label: "b", target: 9 },
    ]);
    expect(d.count("a")).toBe(1);
    expect(d.getOne("a").value).toBe(99);
  });

  it("set() preserves first-occurrence position among other labels", () => {
    const d = doc({ a: 1, b: 2 });
    d.add("a", 3);
    d.set("a", 99);
    expect(d.toData()).toEqual([
      { label: "a", target: 99 },
      { label: "b", target: 2 },
    ]);
  });

  it("set() after remove appends", () => {
    const d = doc({ a: 1 });
    d.add("a", 2);
    d.remove("a");
    expect(d.count("a")).toBe(0);
    d.set("a", 7);
    expect(d.toData()).toEqual([{ label: "a", target: 7 }]);
  });

  it("set() == remove() + add(), except for position", () => {
    const d1 = doc({ a: 1 });
    d1.add("a", 2).add("b", 9);
    d1.set("a", 99);

    const d2 = doc({ a: 1 });
    d2.add("a", 2).add("b", 9);
    d2.remove("a").add("a", 99);

    expect(d1.toData()).toEqual([
      { label: "a", target: 99 },
      { label: "b", target: 9 },
    ]);
    expect(d2.toData()).toEqual([
      { label: "b", target: 9 },
      { label: "a", target: 99 },
    ]);
  });
});

describe("Doc: robustness (guards)", () => {
  it("raises on deeply nested input", () => {
    let value: unknown = "leaf";
    for (let i = 0; i < 250; i++) {
      value = { x: value };
    }
    expect(() => doc(value)).toThrow(/nesting exceeds the maximum depth/);
  });

  it("raises on a self-referential object (cycle)", () => {
    const d: Record<string, unknown> = {};
    d["self"] = d;
    expect(() => doc(d)).toThrow(/cycle detected/);
  });

  it("raises on an unsupported value type (object)", () => {
    expect(() => doc({ a: new Set([1, 2, 3]) })).toThrow(
      /is not a Document value/,
    );
  });

  it("raises on an unsupported value type (non-object)", () => {
    expect(() => doc({ a: (): void => undefined })).toThrow(
      /is not a Document value/,
    );
  });

  it("a non-identifier key gets a bracketed path in error messages", () => {
    expect(() => doc({ "a-b": new Set([1]) })).toThrow(/\$\["a-b"\]/);
  });

  it("doc() passes an existing Doc through unchanged", () => {
    const d = doc({ a: 1 });
    expect(doc(d)).toBe(d);
  });

  it("value on an internal node raises", () => {
    const d = doc({ a: 1 });
    expect(() => d.value).toThrow(/not a leaf/);
  });

  it("edges() on a leaf raises", () => {
    const d = doc({ a: 1 }).getOne("a");
    expect(() => d.edges()).toThrow(/a leaf has no edges/);
  });

  it("getOne() with the wrong count raises", () => {
    const d = doc({ a: 1, b: 2 });
    expect(() => d.getOne("missing")).toThrow(/found 0/);
  });

  it("editing a leaf raises", () => {
    const leaf = doc({ a: 1 }).getOne("a");
    expect(() => leaf.add("x", 1)).toThrow(/cannot add on a leaf/);
    expect(() => leaf.set("x", 1)).toThrow(/cannot set on a leaf/);
    expect(() => leaf.remove("x")).toThrow(/cannot remove on a leaf/);
  });

  it("equals against a non-Document value is false", () => {
    expect(doc({ a: 1 }).equals(new Set([1, 2, 3]))).toBe(false);
  });

  it("has a leaf/node repr", () => {
    expect(doc(1).toString()).toBe("Doc(leaf: 1)");
    expect(doc({ a: 1 }).toString()).toContain("node:");
  });

  it("doc equals doc", () => {
    expect(doc({ a: 1 }).equals(doc({ a: 1 }))).toBe(true);
    expect(doc({ a: 1 }).equals(doc({ a: 2 }))).toBe(false);
  });

  it("a leaf never equals a node, and vice versa", () => {
    expect(doc(1).equals(doc({ a: 1 }))).toBe(false);
    expect(doc({ a: 1 }).equals(doc(1))).toBe(false);
  });

  it("edge lists of different lengths are not equal", () => {
    expect(doc({ a: 1 }).equals(doc({ a: 1, b: 2 }))).toBe(false);
  });

  it("edge lists with a differing label at the same position are not equal", () => {
    expect(doc({ a: 1 }).equals(doc({ b: 1 }))).toBe(false);
  });
});

// Document-level scalar-kind mapping (file-top comment): date/datetime map
// to native `Date`; equality compares by value (getTime()), not reference.
describe("Doc: Date scalar handling", () => {
  it("holds a Date value as-is", () => {
    const when = new Date("2024-01-01T00:00:00Z");
    const d = doc({ a: when });
    expect(d.getOne("a").value).toBeInstanceOf(Date);
    expect((d.getOne("a").value as Date).getTime()).toBe(when.getTime());
  });

  it("Doc equality compares Date scalars by value, not reference", () => {
    const d1 = doc({ a: new Date("2024-01-01T00:00:00Z") });
    const d2 = doc({ a: new Date("2024-01-01T00:00:00Z") });
    const d3 = doc({ a: new Date("2024-01-02T00:00:00Z") });
    expect(d1.equals(d2)).toBe(true);
    expect(d1.equals(d3)).toBe(false);
  });

  it("a Date scalar never equals a non-Date scalar", () => {
    expect(doc({ a: "x" }).equals(doc({ a: new Date("2024-01-01") }))).toBe(false);
    expect(doc({ a: new Date("2024-01-01") }).equals(doc({ a: "x" }))).toBe(false);
  });

  it("reprs a Date scalar as its ISO string", () => {
    const when = new Date("2024-01-01T00:00:00.000Z");
    expect(doc({ a: when }).toString()).toContain(when.toISOString());
  });
});

// Ported from tests/test_depth_guards.py::TestDocExport -- a Doc built
// directly from a raw node (bypassing build_node's own guard) must still
// fail cleanly on export, not blow the stack.
describe("Doc: export depth guard (bypassing buildNode)", () => {
  const DEEP = 5000;
  const JUST_UNDER = 190;

  function deepNode(depth: number, leaf: Node = 1): Node {
    let node: Node = leaf;
    for (let i = 0; i < depth; i++) {
      node = [{ label: "a", target: node }];
    }
    return node;
  }

  it("toData too deep raises DocumentError", () => {
    const d = new Doc(deepNode(DEEP));
    expect(() => d.toData()).toThrow(/nesting exceeds the maximum depth \(200\)/);
  });

  it("toData just under the limit succeeds", () => {
    const d = new Doc(deepNode(JUST_UNDER));
    expect(d.toData()).toEqual(deepNode(JUST_UNDER));
  });

  it("toGrouped too deep raises DocumentError", () => {
    const d = new Doc(deepNode(DEEP));
    expect(() => d.toGrouped()).toThrow(/nesting exceeds the maximum depth \(200\)/);
  });

  it("toGrouped just under the limit succeeds", () => {
    const d = new Doc(deepNode(JUST_UNDER));
    expect((d.toGrouped() as Record<string, unknown>)["a"]).not.toBeNull();
  });
});
