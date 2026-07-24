import { describe, expect, it } from "vitest";
import { doc } from "../src/document.js";
import { SchemaError } from "../src/errors.js";
import {
  ANY,
  Schema,
  cardinalityStr,
  field,
  fieldTypeEquals,
  matchesKind,
  nullable,
  record,
  recordEquals,
  ref,
  schema,
  schemaEquals,
  t,
  valueKind,
  validationResultToString,
} from "../src/schema.js";

// Ported from upstream omnist's tests/test_canonical.py: TestValidation,
// TestTemporalBoundary, TestSchemaModelDunders, TestMatchesKindAndValueKind,
// TestSchemaConstructionErrors, TestOsdRobustness (validation-relevant
// subset only -- OSD *parsing* itself is issue #4, not ported here), plus
// TestPublicApi's non-OSD assertions. OSD-text-based cases are re-expressed
// against the builder API (record/field/ref/schema/t), since parse_schema
// doesn't exist yet in this port.

describe("builders: t namespace and field types", () => {
  it("t exposes the seven scalars plus any, ready to use directly", () => {
    expect(t.string).toEqual({ tag: "scalar", scalarKind: "string", nullable: false });
    expect(t.any).toBe(ANY);
    expect(t.any).toEqual({ tag: "any" });
  });

  it("nullable() makes a copy that also accepts null", () => {
    const ns = nullable(t.integer);
    expect(ns).toEqual({ tag: "scalar", scalarKind: "integer", nullable: true });
    expect(t.integer.nullable).toBe(false); // original untouched
  });

  it("nullable() on an already-nullable scalar is a no-op value", () => {
    const ns = nullable(nullable(t.string));
    expect(ns).toEqual({ tag: "scalar", scalarKind: "string", nullable: true });
  });

  it("nullable(t.any) raises: any already includes null", () => {
    expect(() => nullable(t.any)).toThrow(SchemaError);
    expect(() => nullable(t.any)).toThrow(/any already includes null/);
  });

  it("ref() builds a RefType", () => {
    expect(ref("R")).toEqual({ tag: "ref", name: "R" });
  });
});

describe("Field / Record construction errors", () => {
  it("field() type must be a Ref, Scalar, or t.any", () => {
    // @ts-expect-error -- exercising the runtime guard against a bad type
    expect(() => field("x", "not-a-type")).toThrow(SchemaError);
    // @ts-expect-error -- exercising the runtime guard against a bad type
    expect(() => field("x", "not-a-type")).toThrow(/must be a Ref, Scalar, or t\.any/);
  });

  it("field() requires min <= max and min >= 0", () => {
    expect(() => field("x", t.string, 2, 1)).toThrow(/invalid cardinality/);
    expect(() => field("x", t.string, -1, 1)).toThrow(/invalid cardinality/);
    expect(() => field("x", t.string, -1, null)).toThrow(/invalid cardinality \[-1,\]/);
  });

  it("field() cardinality_str renders the common shapes", () => {
    expect(cardinalityStr(field("x", t.string, 1, 1))).toBe("exactly 1");
    expect(cardinalityStr(field("x", t.string, 0, 1))).toBe("0 or 1");
    expect(cardinalityStr(field("x", t.string, 1, null))).toBe("at least 1");
    expect(cardinalityStr(field("x", t.string, 2, 5))).toBe("between 2 and 5");
  });

  it("record() rejects a duplicate field label", () => {
    expect(() => record(field("a", t.string), field("a", t.integer))).toThrow(
      /duplicate field label/,
    );
  });
});

describe("Schema construction errors", () => {
  it("root must be a Ref", () => {
    // @ts-expect-error -- exercising the runtime guard against a bad root
    expect(() => new Schema("R", new Map())).toThrow(/root must be a Ref/);
  });

  it("an env entry that isn't a Record raises SchemaError, not a crash", () => {
    // @ts-expect-error -- exercising the runtime guard against a bad env value
    expect(() => schema(ref("R"), { R: t.string })).toThrow(/must be a Record/);
  });

  it("an unknown Ref target raises at construction time", () => {
    expect(() => schema(ref("Ghost"), {})).toThrow(/unknown type "Ghost"/);
  });

  it("the Schema class accepts a Map directly, and defaults env to empty", () => {
    const s1 = new Schema(ref("R"), new Map([["R", record(field("a", t.integer))]]));
    expect(s1.validate(doc({ a: 1 })).ok).toBe(true);
    // a root Ref to a record that would need an env, called with no env at
    // all, still constructs (an empty env) -- it just can never validate.
    expect(() => new Schema(ref("R"))).toThrow(/unknown type "R"/);
  });

  it("resolve() on an unknown Ref raises", () => {
    const s = schema("R", { R: record(field("a", t.integer)) });
    expect(() => s.resolve(ref("Nope"))).toThrow(/unknown type "Nope"/);
  });

  it("resolve() is a single hop: Ref -> the Record itself", () => {
    const s = schema(ref("Point"), {
      Point: record(field("x", t.integer), field("y", t.integer)),
    });
    const rec = s.resolve(ref("Point"));
    expect(rec).toBe(s.env.get("Point"));
  });

  it("resolve() returns a bare scalar or any as itself", () => {
    const s = schema("R", { R: record(field("a", t.integer)) });
    expect(s.resolve(t.string)).toBe(t.string);
    expect(s.resolve(ANY)).toBe(ANY);
  });
});

describe("validate: scalar kinds and cardinality", () => {
  function s(rec: ReturnType<typeof record>): Schema {
    return schema("R", { R: rec });
  }

  it("scalar kinds are checked", () => {
    const sch = s(record(field("n", t.integer), field("string_", t.string, 1, 1)));
    expect(sch.validate(doc({ n: 1, string_: "x" })).ok).toBe(true);
    expect(sch.validate(doc({ n: "x", string_: "x" })).ok).toBe(false);
  });

  it("required and optional fields", () => {
    const sch = s(record(field("name", t.string), field("age", t.integer, 0, 1)));
    expect(sch.validate(doc({ name: "a" })).ok).toBe(true);
    expect(sch.validate(doc({ name: "a", age: 3 })).ok).toBe(true);
    expect(sch.validate(doc({ age: 3 })).ok).toBe(false); // name required
  });

  it("closed records reject unexpected labels", () => {
    const sch = s(record(field("a", t.integer)));
    const r = sch.validate(doc({ a: 1, b: 2 }));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.message.includes("unexpected field"))).toBe(true);
    expect(r.errors.some((e) => e.code === "unexpected-field")).toBe(true);
  });

  it("array cardinality", () => {
    const zeroPlus = s(record(field("xs", t.integer, 0, null)));
    expect(zeroPlus.validate(doc({ xs: [1, 2, 3] })).ok).toBe(true);
    expect(zeroPlus.validate(doc({})).ok).toBe(true);

    const onePlus = s(record(field("xs", t.integer, 1, null)));
    expect(onePlus.validate(doc({})).ok).toBe(false);
    expect(onePlus.validate(doc({ xs: [1] })).ok).toBe(true);

    const exactlyTwo = s(record(field("xs", t.integer, 2, 2)));
    expect(exactlyTwo.validate(doc({ xs: [1, 2] })).ok).toBe(true);
    expect(exactlyTwo.validate(doc({ xs: [1] })).ok).toBe(false);
  });

  it("nullable scalars accept null and their kind, reject other kinds", () => {
    const sch = s(record(field("note", nullable(t.string))));
    expect(sch.validate(doc({ note: null })).ok).toBe(true);
    expect(sch.validate(doc({ note: "hi" })).ok).toBe(true);
    expect(sch.validate(doc({ note: 1 })).ok).toBe(false);
  });

  it("integer satisfies number", () => {
    const sch = s(record(field("v", t.number)));
    expect(sch.validate(doc({ v: 7 })).ok).toBe(true);
    expect(sch.validate(doc({ v: 7.5 })).ok).toBe(true);
    expect(sch.validate(doc({ v: "x" })).ok).toBe(false);
  });

  it("ref and recursion", () => {
    const sch = schema("Node", {
      Node: record(field("value", t.integer), field("kids", ref("Node"), 0, null)),
    });
    expect(
      sch.validate(doc({ value: 1, kids: [{ value: 2, kids: [] }] })).ok,
    ).toBe(true);
    expect(
      sch.validate(doc({ value: 1, kids: [{ value: "x", kids: [] }] })).ok,
    ).toBe(false);
  });

  it("multiple problems are all reported, not just the first", () => {
    const sch = s(record(field("a", t.integer), field("b", t.string)));
    const r = sch.validate(doc({ a: "x", b: 1, c: 9 }));
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(3);
  });

  it("record where a scalar was expected -- shape mismatch", () => {
    const sch = s(record(field("a", t.integer)));
    const r = sch.validate(doc({ a: { nested: 1 } }));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.message.includes("got an object"))).toBe(true);
    expect(r.errors.some((e) => e.code === "shape-mismatch")).toBe(true);
  });

  it("null against a non-nullable scalar -- null-not-allowed", () => {
    const sch = s(record(field("a", t.integer)));
    const r = sch.validate(doc({ a: null }));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.message.includes("null not allowed here"))).toBe(true);
    expect(r.errors.some((e) => e.code === "null-not-allowed")).toBe(true);
  });

  it("scalar where a record was expected -- shape mismatch", () => {
    const sch = schema("R", {
      Inner: record(field("x", t.integer)),
      R: record(field("a", ref("Inner"))),
    });
    const r = sch.validate(doc({ a: 1 }));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.message.includes("expected an object, got a value"))).toBe(
      true,
    );
  });

  it("validate() requires an actual Doc", () => {
    const sch = s(record(field("a", t.integer)));
    // @ts-expect-error -- exercising the runtime guard against a raw object
    expect(() => sch.validate({ a: 1 })).toThrow(TypeError);
    // @ts-expect-error -- exercising the runtime guard against a raw object
    expect(() => sch.validate({ a: 1 })).toThrow(/validate\(\) expects a Doc/);
  });

  it("accepts() delegates to validate()", () => {
    const sch = s(record(field("a", t.integer)));
    expect(sch.accepts(doc({ a: 1 }))).toBe(true);
    expect(sch.accepts(doc({ a: "x" }))).toBe(false);
  });
});

describe("validate: the `any` type -- unchecked leaf", () => {
  it("accepts a scalar, null, a record, or deep nesting at an any field", () => {
    const sch = schema("R", { R: record(field("data", t.any)) });
    expect(sch.validate(doc({ data: "x" })).ok).toBe(true);
    expect(sch.validate(doc({ data: 1 })).ok).toBe(true);
    expect(sch.validate(doc({ data: null })).ok).toBe(true);
    expect(sch.validate(doc({ data: { nested: { deeper: [1, 2, 3] } } })).ok).toBe(true);
    expect(sch.validate(doc({ data: { arr: [] } })).ok).toBe(true);
  });

  it("cardinality of the any-typed label is still enforced", () => {
    const sch = schema("R", { R: record(field("data", t.any, 1, 1)) });
    expect(sch.validate(doc({})).ok).toBe(false);
    const r = sch.validate(doc({}));
    expect(r.errors.some((e) => e.code === "cardinality")).toBe(true);
  });

  it("does not descend into an any subtree: unexpected-field errors inside it are never raised", () => {
    const sch = schema("R", { R: record(field("data", t.any)) });
    // if `any` mistakenly delegated to a record check, `junk` would be
    // reported as an unexpected field -- it must not be.
    expect(sch.validate(doc({ data: { junk: 1, more: { still: "ignored" } } })).ok).toBe(true);
  });
});

describe("temporal boundary: date / time / datetime string mutual exclusion", () => {
  const DATE = schema("R", { R: record(field("v", t.date)) });
  const TIME = schema("R", { R: record(field("v", t.time)) });
  const DATETIME = schema("R", { R: record(field("v", t.datetime)) });

  it("a bare date string satisfies only date", () => {
    const v = "2024-01-01";
    expect(DATE.validate(doc({ v })).ok).toBe(true);
    expect(DATETIME.validate(doc({ v })).ok).toBe(false);
    expect(TIME.validate(doc({ v })).ok).toBe(false);
  });

  it("a bare time string satisfies only time", () => {
    const v = "12:00:00";
    expect(TIME.validate(doc({ v })).ok).toBe(true);
    expect(DATE.validate(doc({ v })).ok).toBe(false);
    expect(DATETIME.validate(doc({ v })).ok).toBe(false);
  });

  it("a full timestamp string satisfies only datetime", () => {
    for (const v of ["2024-01-01T12:00:00", "2024-01-01T00:00:00"]) {
      expect(DATETIME.validate(doc({ v })).ok).toBe(true);
      expect(DATE.validate(doc({ v })).ok).toBe(false);
      expect(TIME.validate(doc({ v })).ok).toBe(false);
    }
  });

  it("an unparseable string satisfies none of the three", () => {
    const v = "not-a-date";
    expect(DATE.validate(doc({ v })).ok).toBe(false);
    expect(TIME.validate(doc({ v })).ok).toBe(false);
    expect(DATETIME.validate(doc({ v })).ok).toBe(false);
  });
});

describe("matchesKind / valueKind", () => {
  it("bool never satisfies integer or number", () => {
    expect(matchesKind(true, "integer")).toBe(false);
    expect(matchesKind(false, "number")).toBe(false);
    expect(matchesKind(true, "boolean")).toBe(true);
  });

  it("integer requires a whole number", () => {
    expect(matchesKind(4, "integer")).toBe(true);
    expect(matchesKind(4.5, "integer")).toBe(false);
    expect(matchesKind(4.5, "number")).toBe(true);
  });

  it("valueKind reports the most specific kind", () => {
    expect(valueKind(1)).toBe("integer");
    expect(valueKind(1.5)).toBe("number");
    expect(valueKind(true)).toBe("boolean");
    expect(valueKind("x")).toBe("string");
    expect(valueKind(new Date("2024-01-01T00:00:00Z"))).toBe("datetime");
  });

  it("matches_kind for a real Date object at date and datetime kinds", () => {
    // The Document layer maps both `date` and `datetime` onto the native
    // `Date` type (see src/document.ts); a real `Date` therefore satisfies
    // whichever kind its field declares -- see matchesKind's doc comment.
    const d = new Date("2024-01-01T12:00:00Z");
    expect(matchesKind(d, "date")).toBe(true);
    expect(matchesKind(d, "datetime")).toBe(true);
  });

  it("matches_kind time object", () => {
    expect(matchesKind("12:00:00", "time")).toBe(true);
  });
});

describe("structural equality helpers (TS has no dunder overloading)", () => {
  it("fieldTypeEquals compares scalars by kind and nullable", () => {
    expect(fieldTypeEquals(t.string, t.string)).toBe(true);
    expect(fieldTypeEquals(t.string, t.integer)).toBe(false);
    expect(fieldTypeEquals(t.string, nullable(t.string))).toBe(false);
  });

  it("fieldTypeEquals compares refs by name", () => {
    expect(fieldTypeEquals(ref("R"), ref("R"))).toBe(true);
    expect(fieldTypeEquals(ref("R"), ref("S"))).toBe(false);
  });

  it("fieldTypeEquals treats any as a singleton shape", () => {
    expect(fieldTypeEquals(ANY, t.any)).toBe(true);
    expect(fieldTypeEquals(ANY, t.string)).toBe(false);
  });

  it("recordEquals compares field-by-field", () => {
    const r1 = record(field("a", t.string));
    const r2 = record(field("a", t.string));
    const r3 = record(field("a", t.integer));
    expect(recordEquals(r1, r2)).toBe(true);
    expect(recordEquals(r1, r3)).toBe(false);
  });

  it("recordEquals: differing field counts are unequal", () => {
    const r1 = record(field("a", t.string));
    const r2 = record(field("a", t.string), field("b", t.string, 0, 1));
    expect(recordEquals(r1, r2)).toBe(false);
  });

  it("schemaEquals compares root and env", () => {
    const s1 = schema("R", { R: record(field("a", t.string)) });
    const s2 = schema("R", { R: record(field("a", t.string)) });
    const s3 = schema("R", { R: record(field("a", t.integer)) });
    expect(schemaEquals(s1, s2)).toBe(true);
    expect(schemaEquals(s1, s3)).toBe(false);
  });

  it("schemaEquals: differing roots are unequal", () => {
    const s1 = schema("R", { R: record(field("a", t.string)), S: record(field("a", t.string)) });
    const s2 = schema("S", { R: record(field("a", t.string)), S: record(field("a", t.string)) });
    expect(schemaEquals(s1, s2)).toBe(false);
  });

  it("schemaEquals: differing env sizes are unequal", () => {
    const s1 = schema("R", { R: record(field("a", t.string)) });
    const s2 = schema("R", {
      R: record(field("a", t.string)),
      S: record(field("a", t.string)),
    });
    expect(schemaEquals(s1, s2)).toBe(false);
  });

  it("schemaEquals: same root and env size, different env member names, are unequal", () => {
    const s1 = schema("R", { R: record(field("a", t.string)), X: record(field("a", t.string)) });
    const s2 = schema("R", { R: record(field("a", t.string)), Y: record(field("a", t.string)) });
    expect(schemaEquals(s1, s2)).toBe(false);
  });

  it("validationResultToString renders ok and error cases", () => {
    const sch = schema("R", { R: record(field("a", t.integer)) });
    expect(validationResultToString(sch.validate(doc({ a: 1 })))).toBe("valid");
    const bad = sch.validate(doc({ a: "x" }));
    expect(validationResultToString(bad)).toMatch(/^invalid:\n {2}at \$\.a: /);
  });
});

describe("public-API-shaped usage (TestPublicApi's non-OSD assertions)", () => {
  it("operations are exposed as Schema methods, wired through the builder API", () => {
    const s = schema(ref("R"), { R: record(field("v", nullable(t.integer))) });
    expect(s.validate(doc({ v: 7 })).ok).toBe(true);
    expect(s.validate(doc({ v: null })).ok).toBe(true);
    expect(s.validate(doc({ v: "other" })).ok).toBe(false);
  });

  it("compatibleWith/equivalent/normalize/extract/prune/isEmpty are stubs pending issue #6", () => {
    const s = schema(ref("R"), { R: record(field("v", t.integer)) });
    const other = schema(ref("R"), { R: record(field("v", t.number)) });
    expect(() => s.compatibleWith(other)).toThrow(/issue #6/);
    expect(() => s.equivalent(other)).toThrow(/issue #6/);
    expect(() => s.normalize()).toThrow(/issue #6/);
    expect(() => s.extract("v")).toThrow(/issue #6/);
    expect(() => s.prune()).toThrow(/issue #6/);
    expect(() => s.isEmpty()).toThrow(/issue #6/);
  });
});
