import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseSchema } from "../../src/osd.js";
import { Schema, t, ref, record, field, ANY, type Field, type FieldType } from "../../src/schema.js";
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

// ---------------------------------------------------------------------------
// Property-based strengthening (issue #10): the hand-constructed pairs above
// pin specific known-tricky shapes; this section adds fast-check generators
// so the Theorem 4 cross-check (equivalent === isomorphic(normalize,
// normalize)) and normalize's own properties are also checked over randomly
// generated schemas, not just examples chosen by a human -- matching
// upstream `tests/test_fuzz.py`'s `schemas()`/`test_equivalent_agrees_with_
// normalize_and_isomorphic` and friends. See
// `docs/design/ts-implementation-notes.md` §3 for the Hypothesis ->
// fast-check strategy mapping.
// ---------------------------------------------------------------------------

const RECORD_NAMES = ["A", "B", "C"] as const;

// [1,1] and [0,undefined-as-null] etc: both mandatory and optional
// cardinalities must appear with real probability -- an all-optional
// generator could never produce a mandatory ref cycle (an unsatisfiable,
// empty-language schema), exactly the shape that most stresses `isEmpty`/
// `normalize`/`isomorphic` together.
const cardinalities: fc.Arbitrary<[number, number | null]> = fc.constantFrom(
  [1, 1],
  [0, 1],
  [1, null],
  [0, null],
);

const nonAnyFieldTypes: fc.Arbitrary<FieldType> = fc.oneof(
  fc.constant(t.string),
  fc.constant(t.integer),
  fc.constantFrom(...RECORD_NAMES.map((n) => ref(n))),
);

// Spec any-type-spec.md Sec.5.2: a generated field's type is `any` with
// probability ~0.15, matching upstream's fuzz generator.
const ANY_FIELD_PROBABILITY = 0.15;
const fieldTypes: fc.Arbitrary<FieldType> = fc
  .double({ min: 0, max: 1, noNaN: true })
  .chain((p) => (p < ANY_FIELD_PROBABILITY ? fc.constant(ANY) : nonAnyFieldTypes));

const fieldsArb: fc.Arbitrary<Field[]> = fc
  .array(
    fc.tuple(fc.integer({ min: 0, max: 1 }), fieldTypes, cardinalities),
    { minLength: 0, maxLength: 2 },
  )
  .map((rows) => rows.map(([i, ftype, [lo, hi]], idx) => field(`f${idx}${i}`, ftype, lo, hi)));

const schemasArb: fc.Arbitrary<Schema> = fc
  .tuple(fieldsArb, fieldsArb, fieldsArb, fc.constantFrom(...RECORD_NAMES))
  .map(([fa, fb, fc_, rootName]) => {
    const env = {
      A: record(...fa),
      B: record(...fb),
      C: record(...fc_),
    };
    return new Schema(ref(rootName), env);
  });

describe("property-based: equivalent/isomorphic Theorem-4 cross-check", () => {
  it("agrees for arbitrary random schema pairs", () => {
    fc.assert(
      fc.property(schemasArb, schemasArb, (s, t2) => {
        expect(equivalent(s, t2)).toBe(isomorphic(normalize(s), normalize(t2)));
      }),
      { numRuns: 150 },
    );
  });

  it("normalize never changes a schema's language", () => {
    fc.assert(
      fc.property(schemasArb, (s) => {
        expect(equivalent(normalize(s), s)).toBe(true);
      }),
      { numRuns: 150 },
    );
  });

  it("normalize is idempotent", () => {
    fc.assert(
      fc.property(schemasArb, (s) => {
        const once = normalize(s);
        const twice = normalize(once);
        expect([...once.env.keys()].sort()).toEqual([...twice.env.keys()].sort());
        expect(once.root.name).toBe(twice.root.name);
      }),
      { numRuns: 150 },
    );
  });

  it("an unsatisfiable schema is vacuously compatibleWith anything", () => {
    fc.assert(
      fc.property(schemasArb, schemasArb, (s, t2) => {
        if (isEmpty(s)) {
          expect(compatibleWith(s, t2)).toBe(true);
        }
      }),
      { numRuns: 150 },
    );
  });
});
