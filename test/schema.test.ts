import { describe, expect, it } from "vitest";
import { Doc, doc } from "../src/document.js";
import { materialize } from "../src/deserialize.js";
import { SchemaError } from "../src/errors.js";
import { parseSchema } from "../src/osd.js";
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
import { TimeValue } from "../src/temporal.js";

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

  it("nullable(ref(...)) raises: nullable cannot apply to a Ref", () => {
    expect(() => nullable(ref("X"))).toThrow(SchemaError);
    expect(() => nullable(ref("X"))).toThrow(/cannot be applied to a Ref/);
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

  it("field() requires min and max to be integers", () => {
    expect(() => field("x", t.string, 1.5, 2)).toThrow(/invalid cardinality/);
    expect(() => field("x", t.string, 1, 2.5)).toThrow(/invalid cardinality/);
    expect(() => field("x", t.string, 1)).not.toThrow();
    expect(() => field("x", t.string, 1, null)).not.toThrow();
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

  it("a record named after a scalar keyword is rejected (S-3)", () => {
    expect(() =>
      schema("Root", {
        Root: record(field("x", ref("string"))),
        string: record(field("y", t.integer)),
      }),
    ).toThrow(SchemaError);
    expect(() =>
      schema("Root", {
        Root: record(field("x", ref("string"))),
        string: record(field("y", t.integer)),
      }),
    ).toThrow(/reserved scalar name/);
  });

  it("a record named \"any\" is rejected (S-3)", () => {
    expect(() =>
      schema("Root", {
        Root: record(field("x", t.any)),
        any: record(field("y", t.integer)),
      }),
    ).toThrow(SchemaError);
    expect(() =>
      schema("Root", {
        Root: record(field("x", t.any)),
        any: record(field("y", t.integer)),
      }),
    ).toThrow(/reserved type name/);
  });

  it("the Schema class accepts a Map directly, and defaults env to empty", () => {
    const s1 = new Schema(ref("R"), new Map([["R", record(field("a", t.integer))]]));
    expect(s1.validate(doc({ a: 1n })).ok).toBe(true);
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
    expect(sch.validate(doc({ n: 1n, string_: "x" })).ok).toBe(true);
    expect(sch.validate(doc({ n: "x", string_: "x" })).ok).toBe(false);
  });

  it("required and optional fields", () => {
    const sch = s(record(field("name", t.string), field("age", t.integer, 0, 1)));
    expect(sch.validate(doc({ name: "a" })).ok).toBe(true);
    expect(sch.validate(doc({ name: "a", age: 3n })).ok).toBe(true);
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
    expect(zeroPlus.validate(doc({ xs: [1n, 2n, 3n] })).ok).toBe(true);
    expect(zeroPlus.validate(doc({})).ok).toBe(true);

    const onePlus = s(record(field("xs", t.integer, 1, null)));
    expect(onePlus.validate(doc({})).ok).toBe(false);
    expect(onePlus.validate(doc({ xs: [1n] })).ok).toBe(true);

    const exactlyTwo = s(record(field("xs", t.integer, 2, 2)));
    expect(exactlyTwo.validate(doc({ xs: [1n, 2n] })).ok).toBe(true);
    expect(exactlyTwo.validate(doc({ xs: [1n] })).ok).toBe(false);
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
      sch.validate(doc({ value: 1n, kids: [{ value: 2n, kids: [] }] })).ok,
    ).toBe(true);
    expect(
      sch.validate(doc({ value: 1n, kids: [{ value: "x", kids: [] }] })).ok,
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
    expect(sch.accepts(doc({ a: 1n }))).toBe(true);
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
    expect(matchesKind(4n, "integer")).toBe(true);
    expect(matchesKind(4.5, "integer")).toBe(false);
    expect(matchesKind(4.5, "number")).toBe(true);
  });

  it("valueKind reports the most specific kind", () => {
    expect(valueKind(1n)).toBe("integer");
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

describe("issue #14: cross-schema date/datetime ambiguity", () => {
  // Reproduces the gap tracked in GitHub issue #14: the same Document
  // value, once materialized against a schema that says "date", must NOT
  // also satisfy a different schema that says "datetime" for the same
  // label -- exactly as Python's `matches_kind` excludes a real
  // `datetime.datetime` from a `date`-typed field (and vice versa), even
  // though both collapse onto the single native `Date` type at the
  // Document layer (src/document.ts).
  const DATE_SCHEMA = parseSchema('record R { "x": date }\nroot R');
  const DATETIME_SCHEMA = parseSchema('record R { "x": datetime }\nroot R');

  it("a Date materialized as `date` no longer satisfies a `datetime`-typed schema", () => {
    const node = materialize(doc({ x: "2024-01-01" }).toData(), DATE_SCHEMA);
    const d = new Doc(node);
    expect(DATE_SCHEMA.validate(d).ok).toBe(true);
    expect(DATETIME_SCHEMA.validate(d).ok).toBe(false);
  });

  it("a Date materialized as `datetime` no longer satisfies a `date`-typed schema", () => {
    const node = materialize(doc({ x: "2024-01-01T10:00:00" }).toData(), DATETIME_SCHEMA);
    const d = new Doc(node);
    expect(DATETIME_SCHEMA.validate(d).ok).toBe(true);
    expect(DATE_SCHEMA.validate(d).ok).toBe(false);
  });

  it("a bare, untagged Date (constructed outside any schema context) stays ambiguous by necessity", () => {
    // No schema-directed parse ever tagged this Date with a kind, so
    // there's no signal to resolve the ambiguity from -- this is the
    // documented, accepted residual limitation, not a bug.
    const bare = new Doc([{ label: "x", target: new Date("2024-01-01T00:00:00Z") }]);
    expect(DATE_SCHEMA.validate(bare).ok).toBe(true);
    expect(DATETIME_SCHEMA.validate(bare).ok).toBe(true);
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

  it("recordEquals treats field declaration order as insignificant", () => {
    const r1 = record(field("a", t.string), field("b", t.integer, 0, 1));
    const r2 = record(field("b", t.integer, 0, 1), field("a", t.string));
    expect(recordEquals(r1, r2)).toBe(true);
  });

  it("recordEquals: same labels but a different type on one field are unequal", () => {
    const r1 = record(field("a", t.string), field("b", t.integer));
    const r2 = record(field("b", t.string), field("a", t.string));
    expect(recordEquals(r1, r2)).toBe(false);
  });

  it("recordEquals: same labels but different cardinality on one field are unequal", () => {
    const r1 = record(field("a", t.string, 1, 1), field("b", t.integer, 0, 1));
    const r2 = record(field("b", t.integer, 0, 2), field("a", t.string, 1, 1));
    expect(recordEquals(r1, r2)).toBe(false);
  });

  it("recordEquals: same field count and types but different label sets are unequal", () => {
    const r1 = record(field("a", t.string), field("b", t.string));
    const r2 = record(field("a", t.string), field("c", t.string));
    expect(recordEquals(r1, r2)).toBe(false);
  });

  it("schemaEquals treats field declaration order within a record as insignificant", () => {
    const s1 = schema("R", { R: record(field("a", t.string), field("b", t.integer, 0, 1)) });
    const s2 = schema("R", { R: record(field("b", t.integer, 0, 1), field("a", t.string)) });
    expect(schemaEquals(s1, s2)).toBe(true);
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
    expect(validationResultToString(sch.validate(doc({ a: 1n })))).toBe("valid");
    const bad = sch.validate(doc({ a: "x" }));
    expect(validationResultToString(bad)).toMatch(/^invalid:\n {2}at \$\.a: /);
  });
});

describe("public-API-shaped usage (TestPublicApi's non-OSD assertions)", () => {
  it("operations are exposed as Schema methods, wired through the builder API", () => {
    const s = schema(ref("R"), { R: record(field("v", nullable(t.integer))) });
    expect(s.validate(doc({ v: 7n })).ok).toBe(true);
    expect(s.validate(doc({ v: null })).ok).toBe(true);
    expect(s.validate(doc({ v: "other" })).ok).toBe(false);
  });

  it("compatibleWith/equivalent/normalize/extract/prune/isEmpty delegate to ops/*.ts (issue #6)", () => {
    const s = schema(ref("R"), { R: record(field("v", t.integer)) });
    const wide = schema(ref("R"), { R: record(field("v", t.number)) });
    expect(s.compatibleWith(wide)).toBe(true);
    expect(wide.compatibleWith(s)).toBe(false);
    expect(s.equivalent(s)).toBe(true);
    expect(s.equivalent(wide)).toBe(false);
    expect(s.normalize().equivalent(s)).toBe(true);
    expect(s.extract("v").equivalent(s)).toBe(true);
    expect(s.prune().equivalent(s)).toBe(true);
    expect(s.isEmpty()).toBe(false);
  });
});

describe("issue #49: calendar validity, not Date.parse day-rollover", () => {
  // `Date.parse("2024-02-30")` rolls the overflowing day forward to 1 March
  // instead of failing, so a nonexistent calendar date used to satisfy
  // `date`/`datetime`. Python rejects both (`date.fromisoformat("2024-02-30")`
  // raises "day is out of range for month"), and model.md section 10 requires
  // a string that is not a valid bare ISO date to be rejected.
  it("rejects a day that overflows a real month", () => {
    for (const v of ["2024-02-30", "2023-02-29", "2024-04-31", "2024-06-31"]) {
      expect(matchesKind(v, "date")).toBe(false);
      expect(matchesKind(`${v}T00:00`, "datetime")).toBe(false);
    }
  });

  it("still accepts the last real day of each of those months", () => {
    for (const v of ["2024-02-29", "2023-02-28", "2024-04-30", "2024-06-30"]) {
      expect(matchesKind(v, "date")).toBe(true);
      expect(matchesKind(`${v}T00:00`, "datetime")).toBe(true);
    }
  });

  it("agrees with the pre-existing month/day range rejections", () => {
    expect(matchesKind("2024-13-01", "date")).toBe(false);
    expect(matchesKind("2024-01-32", "date")).toBe(false);
    expect(matchesKind("2024-00-01", "date")).toBe(false);
    expect(matchesKind("2024-01-00", "date")).toBe(false);
  });
});

describe("issue #50: hour 24 is not a valid time", () => {
  // ISO 8601 permits 24:00 as end-of-day, and so does the ECMAScript Date Time
  // String Format, so `Date.parse` used to accept it. Python rejects it
  // (`time.fromisoformat("24:00")` raises "hour must be in 0..23") and so does
  // this port's own OML tokenizer, so `matchesKind` was the odd one out.
  it("rejects hour 24 in a time, matching the OML tokenizer and Python", () => {
    expect(matchesKind("24:00", "time")).toBe(false);
    expect(matchesKind("24:00:00", "time")).toBe(false);
    expect(matchesKind("24:00:00.000", "time")).toBe(false);
    expect(matchesKind("24:00+01:00", "time")).toBe(false);
  });

  it("rejects hour 24 in a datetime too", () => {
    expect(matchesKind("2024-01-01T24:00", "datetime")).toBe(false);
  });

  it("still accepts the last real minute of a day", () => {
    expect(matchesKind("23:59", "time")).toBe(true);
    expect(matchesKind("23:59:59", "time")).toBe(true);
    expect(matchesKind("00:00", "time")).toBe(true);
  });

  it("keeps this port's stricter offset-minute check (a decision, not an accident)", () => {
    // Python accepts an offset of 5h60m (`time.fromisoformat("12:00+05:60")`
    // normalizes it to +06:00); this port's `parseTimeToken` rejects an offset
    // minute > 59, and the OML tokenizer therefore does too. Kept deliberately:
    // one spelling per instant, and the two layers agree with each other.
    expect(matchesKind("12:00+05:60", "time")).toBe(false);
    expect(matchesKind("12:00+05:59", "time")).toBe(true);
  });
});

describe("issue #96: valueKind reports a TimeValue as \"time\", not \"string\"", () => {
  it("a TimeValue mismatched against a non-time field reports its real kind in the error", () => {
    const s = parseSchema('record R { "n": number }\nroot R');
    const result = s.validate(new Doc([{ label: "n", target: new TimeValue("12:00:00") }]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(JSON.stringify(result.errors)).toContain("time");
    }
  });
});
