import { describe, expect, it } from "vitest";
import {
  Schema,
  SchemaError,
  WriteError,
  field,
  infer,
  record,
  ref,
  t,
  toOsd,
  type Field,
} from "../src/index.js";

// omnist-spec v0.28.0-beta (S-8 addendum, S-22, S-23, S-24, OSD-16). DIV-5: no
// conformance vector pins any of these, so this file is the only pin.
function schemaDiag(fn: () => unknown): { code: string | undefined; path: string | undefined } {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SchemaError);
    const s = e as SchemaError;
    return { code: s.code, path: s.path };
  }
  throw new Error("expected a SchemaError");
}

function writeDiag(fn: () => unknown): { code: string | undefined; path: string | undefined } {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(WriteError);
    const w = e as WriteError;
    return { code: w.code, path: w.path };
  }
  throw new Error("expected a WriteError");
}

// A hand-built Field literal: `record()` does not re-check cardinality, which is
// the only way `max = 0` (rejected by field(), omnist-ts#125) reaches a Schema.
const zeroMax: Field = { label: "a", type: t.string, min: 0, max: 0 };

describe("S-8: schema.invalid-name is reported at `$`, name in the message only", () => {
  const bad = ["My Record!", "1abc", "", "a-b", "a.b", "é"];
  it.each(bad)("record name %j", (name) => {
    const d = schemaDiag(() => new Schema(ref("R"), { R: record(), [name]: record() }));
    expect(d).toEqual({ code: "schema.invalid-name", path: "$" });
  });
  it.each(bad)("root reference %j", (name) => {
    expect(schemaDiag(() => new Schema(ref(name), {}))).toEqual({ code: "schema.invalid-name", path: "$" });
  });
  it.each(bad)("reference target %j", (name) => {
    expect(schemaDiag(() => new Schema(ref("R"), { R: record(field("a", ref(name))) }))).toEqual({
      code: "schema.invalid-name",
      path: "$",
    });
  });
  it("the offending name is in the message, not the path", () => {
    try {
      new Schema(ref("R"), { R: record(), "Bad Name": record() });
    } catch (e) {
      expect((e as SchemaError).message).toContain("Bad Name");
      expect((e as SchemaError).path).toBe("$");
      return;
    }
    throw new Error("expected a SchemaError");
  });
  it("a malformed name is not reported as dangling or reserved", () => {
    expect(schemaDiag(() => new Schema(ref("a b"), { R: record() })).code).toBe("schema.invalid-name");
  });
  it("valid names still construct", () => {
    expect(() => new Schema(ref("_r1"), { _r1: record(field("a", ref("_r1"), 0, 1)) })).not.toThrow();
  });
  it("infer with a malformed rootName fails with schema.invalid-name", () => {
    expect(schemaDiag(() => infer([{ a: 1 }], { rootName: "bad name" })).code).toBe("schema.invalid-name");
  });
});

describe("S-22: schema.invalid-label for a label that does not encode to UTF-8", () => {
  const labels = ["a\udc80", "\ud800", "x\ud83dy", "\udfff\ud83d"];
  it.each(labels)("field() rejects %j (no record known, no path)", (label) => {
    expect(schemaDiag(() => field(label, t.string))).toEqual({ code: "schema.invalid-label", path: undefined });
  });
  it.each(labels)("record() rejects a hand-built Field with %j", (label) => {
    const f: Field = { label, type: t.string, min: 1, max: 1 };
    expect(schemaDiag(() => record(f)).code).toBe("schema.invalid-label");
  });
  it.each(labels)("Schema rejects %j at the record path R", (label) => {
    const rec = record();
    (rec.fields as Field[]).push({ label, type: t.string, min: 1, max: 1 });
    expect(schemaDiag(() => new Schema(ref("R"), { R: rec }))).toEqual({
      code: "schema.invalid-label",
      path: "R",
    });
  });
  it("the label is never put in the path", () => {
    const rec = record();
    (rec.fields as Field[]).push({ label: "a\udc80", type: t.string, min: 1, max: 1 });
    try {
      new Schema(ref("Rec"), { Rec: rec });
    } catch (e) {
      expect((e as SchemaError).path).toBe("Rec");
      expect((e as SchemaError).message).not.toContain("\udc80");
      return;
    }
    throw new Error("expected a SchemaError");
  });
  it("a well-formed surrogate pair is a valid label", () => {
    expect(() => field("😀", t.string)).not.toThrow();
  });
  it("the OSD writer is a backstop for a schema mutated after construction", () => {
    const rec = record(field("a", t.string));
    const s = new Schema(ref("R"), { R: rec });
    (rec.fields as Field[])[0] = { label: "a\udc80", type: t.string, min: 1, max: 1 };
    expect(schemaDiag(() => toOsd(s))).toEqual({ code: "schema.invalid-label", path: "R" });
  });
});

describe("S-23: a caller-supplied record ordering", () => {
  it("TypeScript has no such input: Schema takes an unordered env, toOsd emits env insertion order", () => {
    const s = new Schema(ref("B"), { B: record(field("a", ref("A"))), A: record() });
    expect(toOsd(s, { indent: null })).toBe('record B { "a": A } record A {  } root B\n');
  });
});

describe("OSD-16 / S-24: an OSD writer fails on max = 0", () => {
  it.each([[undefined], [4], [null]])("indent %s: write.unsupported-value at the record path", (indent) => {
    const s = new Schema(ref("R"), { R: record(field("ok", t.string), zeroMax) });
    expect(writeDiag(() => toOsd(s, indent === undefined ? {} : { indent }))).toEqual({
      code: "write.unsupported-value",
      path: "R",
    });
  });
  it("names the record holding the field, not the field", () => {
    const s = new Schema(ref("Root"), { Root: record(field("c", ref("Inner"))), Inner: record(zeroMax) });
    expect(writeDiag(() => toOsd(s)).path).toBe("Inner");
  });
  it("a [0,1] field is still written", () => {
    expect(toOsd(new Schema(ref("R"), { R: record(field("a", t.string, 0, 1)) }))).toContain('"a" [0,1]');
  });
  it("field() still rejects [0,0] at construction", () => {
    expect(schemaDiag(() => field("a", t.string, 0, 0)).code).toBe("schema.invalid-cardinality");
  });
});

describe("prune and normalize never emit max = 0", () => {
  const maxes = (s: Schema): (number | null)[] =>
    [...s.env.values()].flatMap((r) => r.fields.map((f) => f.max));
  it("prune drops a max = 0 field from every record it rebuilds", () => {
    const s = new Schema(ref("R"), { R: record(field("x", t.string), zeroMax, field("c", ref("C"))), C: record(zeroMax) });
    const p = s.prune();
    expect(maxes(p)).not.toContain(0);
    expect(p.env.get("C")?.fields).toEqual([]);
    expect(() => toOsd(p)).not.toThrow();
  });
  it("prune keeps an unsatisfiable root intact (so callers prune before writing)", () => {
    const s = new Schema(ref("R"), { R: record(field("x", ref("R")), zeroMax) });
    expect(s.isEmpty()).toBe(true);
    expect(maxes(s.prune())).toContain(0);
  });
  it("normalize of schemas built through the public API has no max = 0", () => {
    const s = new Schema(ref("R"), {
      R: record(field("a", ref("A"), 0, 3), field("b", ref("B"))),
      A: record(field("v", t.integer, 0, null)),
      B: record(field("v", t.integer, 0, null)),
    });
    expect(maxes(s.normalize())).not.toContain(0);
  });
});
