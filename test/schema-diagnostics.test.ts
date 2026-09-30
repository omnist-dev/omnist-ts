import { describe, expect, it } from "vitest";
import { SchemaError, Schema, field, nullable, parseSchema, record, ref, t } from "../src/index.js";

// omnist-ts#149: every well-formedness failure carries a `schema.*` code and a
// Schema path (omnist-spec Sec8.3.3, Sec8.4.1, E-13, E-30).
function diag(fn: () => unknown): { code: string | undefined; path: string | undefined } {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SchemaError);
    const s = e as SchemaError;
    return { code: s.code, path: s.path };
  }
  throw new Error("expected a SchemaError");
}

const osd = (body: string, tail = "root R\n"): string => `record R {\n${body}\n}\n${tail}`;

describe("OSD text: schema.* code and Schema path", () => {
  const cases: [string, string, string, string][] = [
    ["empty cardinality", osd('"a" []: string,'), "schema.empty-cardinality", "R.a"],
    ["negative minimum", osd('"a" [-1]: string,'), "schema.invalid-cardinality", "R.a"],
    ["inverted range", osd('"a" [1,0]: string,'), "schema.invalid-cardinality", "R.a"],
    ["zero max", osd('"a" [0,0]: string,'), "schema.invalid-cardinality", "R.a"],
    ["non-integer bound", osd('"a" [1.5]: string,'), "schema.non-integer-cardinality", "R.a"],
    ["empty label", osd('"": string,'), "schema.empty-label", "R"],
    ["bracket in label", osd('"a[1]": string,'), "schema.bracket-in-label", "R"],
    ["closing bracket in label", osd('"total]": string,'), "schema.bracket-in-label", "R"],
    ["unquoted label", osd("a: string,"), "schema.unquoted-label", "R"],
    ["quoted type", osd('"a": "string",'), "schema.quoted-type", "R"],
    ["nullable ref", osd('"a": Other?,'), "schema.nullable-ref", "R.a"],
    ["nullable any", osd('"data": any?,'), "schema.nullable-any", "R.data"],
    ["capitalized Any", osd('"data": Any,'), "schema.unknown-type", "R.data"],
    ["dangling reference", osd('"a": Ghost,'), "schema.unknown-type", "R.a"],
    ["dangling root", osd('"a": string,', "root Ghost\n"), "schema.unknown-type", "$"],
    ["missing root", osd('"a": string,', ""), "schema.no-root", "$"],
    ["duplicate field", osd('"a": string,\n"a": integer,'), "schema.duplicate-field", "R"],
    ["duplicate record", `${osd('"a": string,', "")}record R {\n"b": integer,\n}\nroot R\n`, "schema.duplicate-record", "R"],
    ["scalar-named record", "record string {\n\"a\": string,\n}\nroot string\n", "schema.reserved-name", "string"],
    ["any-named record", "record any {\n\"a\": string,\n}\nroot any\n", "schema.reserved-name", "any"],
  ];
  it.each(cases)("%s", (_name, text, code, path) => {
    expect(diag(() => parseSchema(text))).toEqual({ code, path });
  });

  it("a non-integer bound in a two-bound range reports the field path", () => {
    expect(diag(() => parseSchema(osd('"a" [1,2.5]: string,')))).toEqual({
      code: "schema.non-integer-cardinality",
      path: "R.a",
    });
  });
});

describe("programmatic constructors carry the code", () => {
  it("field(): cardinality, label", () => {
    expect(diag(() => field("a", t.string, 1.5, 2)).code).toBe("schema.non-integer-cardinality");
    expect(diag(() => field("a", t.string, 1.5, null)).code).toBe("schema.non-integer-cardinality");
    expect(diag(() => field("a", t.string, 1, 2.5)).code).toBe("schema.non-integer-cardinality");
    expect(diag(() => field("a", t.string, -1, 1)).code).toBe("schema.invalid-cardinality");
    expect(diag(() => field("", t.string)).code).toBe("schema.empty-label");
    expect(diag(() => field("a]", t.string)).code).toBe("schema.bracket-in-label");
  });

  it("record(), nullable()", () => {
    expect(diag(() => record(field("a", t.string), field("a", t.integer))).code).toBe("schema.duplicate-field");
    expect(diag(() => nullable(t.any)).code).toBe("schema.nullable-any");
    expect(diag(() => nullable(ref("X"))).code).toBe("schema.nullable-ref");
  });

  it("Schema: dangling refs and reserved names carry a Schema path", () => {
    expect(diag(() => new Schema(ref("Ghost"), { R: record() }))).toEqual({ code: "schema.unknown-type", path: "$" });
    expect(diag(() => new Schema(ref("R"), { R: record(field("a", ref("Ghost"))) }))).toEqual({
      code: "schema.unknown-type",
      path: "R.a",
    });
    expect(diag(() => new Schema(ref("any"), { any: record() }))).toEqual({ code: "schema.reserved-name", path: "any" });
    expect(diag(() => new Schema(ref("integer"), { integer: record() }))).toEqual({
      code: "schema.reserved-name",
      path: "integer",
    });
  });
});
