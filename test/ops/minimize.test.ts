import { describe, expect, it } from "vitest";
import { parseSchema } from "../../src/osd.js";
import { Schema } from "../../src/schema.js";
import { equivalenceClasses, normalize } from "../../src/ops/minimize.js";
import { isEmpty } from "../../src/ops/prune.js";
import { compatibleWith, equivalent } from "../../src/ops/subschema.js";
import { isomorphic } from "../../src/ops/isomorphic.js";

// Ported from upstream omnist's tests/test_canonical.py
// (TestNormalizePartitionRefinement).

describe("normalize: partition refinement", () => {
  it("merges ref-chained duplicates in one pass", () => {
    const s = parseSchema(
      'record A { "x": C }\nrecord B { "x": D }\n' +
        'record C { "y": integer }\nrecord D { "y": integer }\n' +
        'record Root { "a": A, "b": B }\nroot Root',
    );
    const n = normalize(s);
    expect([...n.env.keys()].sort()).toEqual(["A", "C", "Root"]);
    expect(equivalent(n, s)).toBe(true);
  });

  it("merges recursive twins", () => {
    const s = parseSchema(
      'record Root { "p" [0,1]: P, "q" [0,1]: Q }\n' +
        'record P { "next" [0,1]: P }\nrecord Q { "next" [0,1]: Q }\nroot Root',
    );
    const n = normalize(s);
    expect(n.env.size).toBe(2);
    expect(equivalent(n, s)).toBe(true);
  });

  it("drops unreachable records", () => {
    const s = parseSchema('record R { "x": integer }\nrecord Orphan { "y": string }\nroot R');
    expect([...normalize(s).env.keys()].sort()).toEqual(["R"]);
  });

  it("does not over-merge records with different scalar types", () => {
    const s = parseSchema('record A { "x": integer }\nrecord B { "x": string }\nrecord Root { "a": A, "b": B }\nroot Root');
    expect(normalize(s).env.size).toBe(3);
  });

  it("is idempotent", () => {
    const s = parseSchema(
      'record A { "x": C }\nrecord B { "x": D }\n' +
        'record C { "y": integer }\nrecord D { "y": integer }\n' +
        'record Root { "a": A, "b": B }\nroot Root',
    );
    const once = normalize(s);
    const twice = normalize(once);
    expect(equivalent(twice, once)).toBe(true);
    expect([...twice.env.keys()].sort()).toEqual([...once.env.keys()].sort());
  });

  it("does not split a block on field declaration order", () => {
    const s = parseSchema(
      'record A { "x": integer, "y": string }\n' +
        'record B { "y": string, "x": integer }\n' +
        'record Root { "a": A, "b": B }\nroot Root',
    );
    const n = normalize(s);
    expect([...n.env.keys()].sort()).toEqual(["A", "Root"]);
    expect(equivalent(n, s)).toBe(true);
  });

  it("returns the pruned schema unchanged for an empty schema", () => {
    const s = parseSchema('record A { "x": B }\nrecord B { "y": A }\nroot A');
    expect(isEmpty(s)).toBe(true);
    const n = normalize(s);
    expect(isEmpty(n)).toBe(true);
    expect([...n.env.keys()].sort()).toEqual(["A", "B"]);
    expect(n.root.name).toBe("A");
  });

  it("handles multi-round refinement", () => {
    const s = parseSchema(
      'record Root { "a": A, "b": B }\n' +
        'record A { "x": P }\nrecord B { "x": Q }\n' +
        'record P { "v": integer, "w": R }\n' +
        'record Q { "v": integer, "w": S }\n' +
        'record R { "n": integer }\nrecord S { "n": string }\nroot Root',
    );
    const n = normalize(s);
    expect([...n.env.keys()].sort()).toEqual(["A", "B", "P", "Q", "R", "Root", "S"]);
    expect(equivalent(n, s)).toBe(true);
  });
});

describe("equivalenceClasses", () => {
  it("groups structurally identical records without pruning", () => {
    const s = parseSchema(
      'record Addr { "c": string }\nrecord Location { "c": string }\n' +
        'record R { "a": Addr, "l": Location }\nroot R',
    );
    const blocks = equivalenceClasses(s).map((b) => [...b].sort());
    expect(blocks).toContainEqual(["Addr", "Location"]);
  });
});

// The "triple-checked algebra" property (docs/testing.md, upstream): the
// core schema algebra is checked three structurally unrelated ways --
// compatibleWith's own coinductive inclusion test, minimize-then-
// isomorphism (Theorem 4), and (issue #10's fuller scope) brute-force
// enumeration. This ports the minimize/isomorphic half of that cross-check
// with hand-constructed pairs; #10 adds property-based fuzzing.
describe("the triple-checked algebra: equivalent === isomorphic(normalize, normalize)", () => {
  function check(a: Schema, b: Schema) {
    expect(equivalent(a, b)).toBe(isomorphic(normalize(a), normalize(b)));
  }

  it("agrees on a record rename", () => {
    const a = parseSchema('record R { "x": integer }\nroot R');
    const b = parseSchema('record S { "x": integer }\nroot S');
    check(a, b);
    expect(equivalent(a, b)).toBe(true);
  });

  it("agrees on a field reorder", () => {
    const a = parseSchema('record R { "a": integer, "b": string }\nroot R');
    const b = parseSchema('record R { "b": string, "a": integer }\nroot R');
    check(a, b);
    expect(equivalent(a, b)).toBe(true);
  });

  it("agrees when one side has an added unreachable record", () => {
    const a = parseSchema('record R { "x": integer }\nroot R');
    const b = parseSchema('record R { "x": integer }\nrecord Orphan { "y": string }\nroot R');
    check(a, b);
    expect(equivalent(a, b)).toBe(true);
  });

  it("agrees on genuinely different schemas", () => {
    const a = parseSchema('record R { "x": integer }\nroot R');
    const b = parseSchema('record R { "x": string }\nroot R');
    check(a, b);
    expect(equivalent(a, b)).toBe(false);
  });

  it("agrees on two distinct empty (unsatisfiable) schemas", () => {
    const a = parseSchema('record A { "x": B }\nrecord B { "y": A }\nroot A');
    const b = parseSchema('record P { "q": P }\nroot P');
    check(a, b);
    expect(equivalent(a, b)).toBe(true);
  });

  it("normalize(s).equivalent(s) for several schemas", () => {
    const schemas = [
      parseSchema('record R { "x": integer }\nroot R'),
      parseSchema(
        'record A { "x": C }\nrecord B { "x": D }\n' +
          'record C { "y": integer }\nrecord D { "y": integer }\n' +
          'record Root { "a": A, "b": B }\nroot Root',
      ),
      parseSchema('record A { "x": B }\nrecord B { "y": A }\nroot A'),
    ];
    for (const s of schemas) {
      expect(equivalent(normalize(s), s)).toBe(true);
    }
  });

  it("normalize is idempotent (normalize(normalize(s)) equals normalize(s))", () => {
    const s = parseSchema(
      'record A { "x": C }\nrecord B { "x": D }\n' +
        'record C { "y": integer }\nrecord D { "y": integer }\n' +
        'record Root { "a": A, "b": B }\nroot Root',
    );
    const once = normalize(s);
    const twice = normalize(once);
    expect(isomorphic(once, twice)).toBe(true);
    expect([...once.env.keys()].sort()).toEqual([...twice.env.keys()].sort());
  });
});

describe("compatibleWith / equivalent cross-check against isomorphic", () => {
  it("agrees compatibleWith both ways implies isomorphic normalized forms", () => {
    const a = parseSchema('record R { "a": integer, "b": string }\nroot R');
    const b = parseSchema('record R { "b": string, "a": integer }\nroot R');
    expect(compatibleWith(a, b)).toBe(true);
    expect(compatibleWith(b, a)).toBe(true);
    expect(isomorphic(normalize(a), normalize(b))).toBe(true);
  });
});
