import { describe, expect, it } from "vitest";
import { parseSchema } from "../../src/osd.js";
import { field, record, ref, schema, t } from "../../src/schema.js";
import { compatibleWith, equivalent } from "../../src/ops/subschema.js";

// Ported from upstream omnist's tests/test_canonical.py (TestOperations,
// TestEmptySchemas subset).

describe("compatibleWith / equivalent", () => {
  it("an added optional field is compatible", () => {
    const v1 = parseSchema('record R { "a": integer }\nroot R');
    const v2 = parseSchema('record R { "a": integer, "b" [0,1]: integer }\nroot R');
    expect(compatibleWith(v1, v2)).toBe(true);
    expect(compatibleWith(v2, v1)).toBe(false);
  });

  it("required-to-optional is compatible", () => {
    const strict = parseSchema('record R { "a": integer, "b": integer }\nroot R');
    const loose = parseSchema('record R { "a": integer, "b" [0,1]: integer }\nroot R');
    expect(compatibleWith(strict, loose)).toBe(true);
    expect(compatibleWith(loose, strict)).toBe(false);
  });

  it("integer is compatible with number, not vice versa", () => {
    const narrow = parseSchema('record R { "v": integer }\nroot R');
    const wide = parseSchema('record R { "v": number }\nroot R');
    expect(compatibleWith(narrow, wide)).toBe(true);
    expect(compatibleWith(wide, narrow)).toBe(false);
  });

  it("nullable is one-directional", () => {
    const narrow = parseSchema('record R { "v": string }\nroot R');
    const wide = parseSchema('record R { "v": string? }\nroot R');
    expect(compatibleWith(narrow, wide)).toBe(true);
    expect(compatibleWith(wide, narrow)).toBe(false);
  });

  it("array bounds must be a subset", () => {
    const a = parseSchema('record R { "xs" [2,3]: integer }\nroot R');
    const b = parseSchema('record R { "xs" [1,5]: integer }\nroot R');
    expect(compatibleWith(a, b)).toBe(true);
    expect(compatibleWith(b, a)).toBe(false);
  });

  it("date is not compatible with string", () => {
    const a = schema(ref("R"), { R: record(field("d", t.date)) });
    const b = schema(ref("R"), { R: record(field("d", t.string)) });
    expect(compatibleWith(a, b)).toBe(false);
  });

  it("equivalent under field reorder", () => {
    const a = parseSchema('record R { "a": integer, "b": string }\nroot R');
    const b = parseSchema('record R { "b": string, "a": integer }\nroot R');
    expect(equivalent(a, b)).toBe(true);
  });

  it("any absorbs everything on the B side", () => {
    const a = parseSchema('record R { "v": string }\nroot R');
    const b = parseSchema('record R { "v": any }\nroot R');
    expect(compatibleWith(a, b)).toBe(true);
    expect(compatibleWith(b, a)).toBe(false);
  });

  it("a record is never compatible with a scalar or vice versa", () => {
    const a = schema(ref("R"), { R: record(field("f", ref("Inner"))), Inner: record(field("v", t.integer)) });
    const b = schema(ref("R"), { R: record(field("f", t.integer)) });
    expect(compatibleWith(a, b)).toBe(false);
    expect(compatibleWith(b, a)).toBe(false);
  });

  it("B requiring a field A doesn't guarantee is incompatible", () => {
    const a = parseSchema('record R { "a" [0,1]: integer }\nroot R');
    const b = parseSchema('record R { "a": integer }\nroot R');
    expect(compatibleWith(a, b)).toBe(false);
  });
});

describe("compatibleWith on unsatisfiable (empty) schemas", () => {
  function mandatoryCycle() {
    return parseSchema('record A { "x": B }\nrecord B { "y": A }\nroot A');
  }

  it("an empty schema is vacuously compatible with anything, not vice versa", () => {
    const empty = mandatoryCycle();
    const other = parseSchema('record C { "z": integer }\nroot C');
    expect(compatibleWith(empty, other)).toBe(true);
    expect(compatibleWith(other, empty)).toBe(false);
  });

  it("two distinct empty schemas are equivalent", () => {
    const empty1 = mandatoryCycle();
    const empty2 = parseSchema('record P { "q": P }\nroot P');
    expect(equivalent(empty1, empty2)).toBe(true);
  });

  it("an optional dead field does not block compatibility", () => {
    const r = parseSchema('record R { "x" [0,1]: Dead }\nrecord Dead { "d": Dead }\nroot R');
    const r2 = parseSchema("record R2 {  }\nroot R2");
    expect(compatibleWith(r, r2)).toBe(true);
  });
});

describe("subschema: uncommon branch coverage", () => {
  it("unbounded A max is not a subset of a bounded B max", () => {
    const a = parseSchema('record R { "xs" [1,]: integer }\nroot R');
    const b = parseSchema('record R { "xs" [1,5]: integer }\nroot R');
    expect(compatibleWith(a, b)).toBe(false);
    expect(compatibleWith(b, a)).toBe(true);
  });

  it("B requires a field present in A but with too low a minimum", () => {
    const a = parseSchema('record R { "a" [0,1]: integer }\nroot R');
    const b = parseSchema('record R { "a": integer }\nroot R');
    expect(compatibleWith(a, b)).toBe(false);
  });
});

describe("subschema: B requires a label A does not declare at all", () => {
  it("is incompatible", () => {
    const a = parseSchema('record R { }\nroot R');
    const b = parseSchema('record R { "a": integer }\nroot R');
    expect(compatibleWith(a, b)).toBe(false);
  });
});
