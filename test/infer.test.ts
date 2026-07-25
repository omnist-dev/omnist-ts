import { describe, expect, it } from "vitest";
import { doc } from "../src/document.js";
import { SchemaError } from "../src/errors.js";
import { infer, inferWithReport, type AnyFallback } from "../src/infer.js";

// Ported from upstream omnist's tests/test_canonical.py: TestInfer,
// TestInferErrors, TestInferAllowAny.

describe("infer: basic shapes", () => {
  it("optional field detection", () => {
    const s = infer([doc({ name: "Ann", age: 30 }), doc({ name: "Bob" })]);
    expect(s.validate(doc({ name: "Cy" })).ok).toBe(true); // age optional
    expect(s.validate(doc({ age: 1 })).ok).toBe(false); // name required
  });

  it("array and nested object", () => {
    const s = infer([doc({ id: 1, tags: ["a", "b"], addr: { city: "X" } })]);
    expect(s.validate(doc({ id: 9, tags: ["c"], addr: { city: "Y" } })).ok).toBe(true);
    expect(s.validate(doc({ id: 9, tags: [1], addr: { city: "Y" } })).ok).toBe(false);
  });

  it("accepts its own samples (int + float -> number)", () => {
    const samples = [doc({ v: 1 }), doc({ v: 2.5 })];
    const s = infer(samples);
    for (const sm of samples) {
      expect(s.validate(sm).ok).toBe(true);
    }
  });

  it("conflicting scalars raise", () => {
    expect(() => infer([doc({ v: 1 }), doc({ v: "x" })])).toThrow(SchemaError);
  });

  it("null-only field infers nullable string", () => {
    const s = infer([doc({ v: null }), doc({ v: null })]);
    expect(s.validate(doc({ v: null })).ok).toBe(true);
    expect(s.validate(doc({ v: "anything" })).ok).toBe(true);
  });

  it("null alongside a kind is orthogonal", () => {
    const s = infer([doc({ v: 1 }), doc({ v: null })]);
    expect(s.validate(doc({ v: 7 })).ok).toBe(true);
    expect(s.validate(doc({ v: null })).ok).toBe(true);
    expect(s.validate(doc({ v: "x" })).ok).toBe(false);
  });

  it("optional field detection is order independent", () => {
    const absentFirst = infer([doc({ host: "a" }), doc({ host: "b", port: 80 })]);
    const absentLast = infer([doc({ host: "b", port: 80 }), doc({ host: "a" })]);
    expect(absentFirst.equivalent(absentLast)).toBe(true);

    const rootRec = absentFirst.env.get("Root");
    if (rootRec === undefined) throw new Error("Root missing");
    const port = rootRec.fields[1];
    if (port === undefined) throw new Error("port field missing");
    expect(port.label).toBe("port");
    expect([port.min, port.max]).toEqual([0, 1]);

    expect(absentFirst.validate(doc({ host: "x" })).ok).toBe(true);
    expect(absentFirst.validate(doc({ host: "x", port: 1 })).ok).toBe(true);
  });
});

describe("infer: sampleNode branches", () => {
  it("accepts a plain (non-Doc) value, run through buildNode directly", () => {
    const s = infer([{ name: "Ann" }, { name: "Bob" }]);
    expect(s.validate(doc({ name: "Cy" })).ok).toBe(true);
  });
});

describe("infer: generated-name identifier edge cases", () => {
  it("a label with non-identifier characters is sanitized", () => {
    const s = infer([doc({ "my-field": { x: 1 } })]);
    expect([...s.env.keys()]).toContain("My_field");
  });

  it("an empty-string label falls back to the generated name \"Rec\"", () => {
    const s = infer([doc({ "": { x: 1 } })]);
    expect(s.env.has("Rec")).toBe(true);
  });
});

describe("infer: errors", () => {
  it("zero samples raises", () => {
    expect(() => infer([])).toThrow(/zero samples/);
  });

  it("non-object root raises", () => {
    expect(() => infer([doc(5)])).toThrow(/object .record. samples/);
  });

  it("mixed object and scalar for one label raises", () => {
    expect(() => infer([doc({ a: { x: 1 } }), doc({ a: 5 })])).toThrow(/mixes objects and values/);
  });

  it("generated record names don't collide", () => {
    // "item" and "Item" both capitalize to the generated name "Item"
    const s = infer([doc({ item: { a: 1 }, Item: { b: 2 } })]);
    expect(s.env.has("Item")).toBe(true);
    expect(s.env.has("Item2")).toBe(true);
  });
});

describe("infer: allow-any fallback", () => {
  it("multi-kind scalar opens to any", () => {
    const { schema: s, report: fb } = inferWithReport([doc({ v: 1 }), doc({ v: "x" })], {
      allowAny: true,
    });
    const rec = s.env.get("Root");
    if (rec === undefined) throw new Error("Root missing");
    expect(rec.fields[0]?.type.tag).toBe("any");
    expect(fb).toHaveLength(1);
    expect(fb[0]?.location).toBe("Root.v");
    expect(fb[0]?.reason).toBe("values of more than one scalar kind (integer, string)");
  });

  it("object value mix opens to any", () => {
    const { schema: s, report: fb } = inferWithReport(
      [doc({ a: { x: 1 } }), doc({ a: 5 })],
      { allowAny: true },
    );
    const rec = s.env.get("Root");
    if (rec === undefined) throw new Error("Root missing");
    expect(rec.fields[0]?.type.tag).toBe("any");
    expect(fb).toHaveLength(1);
    expect(fb[0]?.location).toBe("Root.a");
    expect(fb[0]?.reason).toBe("mixes objects and values");
  });

  it("siblings stay precise", () => {
    const { schema: s, report: fb } = inferWithReport(
      [doc({ v: 1, name: "Ann" }), doc({ v: "x", name: "Bob" })],
      { allowAny: true },
    );
    const rec = s.env.get("Root");
    if (rec === undefined) throw new Error("Root missing");
    const byLabel = new Map(rec.fields.map((f) => [f.label, f.type]));
    expect(byLabel.get("v")?.tag).toBe("any");
    const nameType = byLabel.get("name");
    expect(nameType?.tag).toBe("scalar");
    if (nameType?.tag === "scalar") {
      expect(nameType.scalarKind).toBe("string");
    }
    expect(fb.map((f: AnyFallback) => f.location)).toEqual(["Root.v"]);
  });

  it("nested all-object label still a record, not any", () => {
    // narrowest-node scoping: a clean nested object still becomes a
    // record; only the genuinely-conflicting field opens.
    const { schema: s, report: fb } = inferWithReport(
      [
        doc({ addr: { city: "X" }, v: 1 }),
        doc({ addr: { city: "Y" }, v: "s" }),
      ],
      { allowAny: true },
    );
    const rec = s.env.get("Root");
    if (rec === undefined) throw new Error("Root missing");
    const byLabel = new Map(rec.fields.map((f) => [f.label, f.type]));
    expect(byLabel.get("addr")?.tag).toBe("ref");
    expect(byLabel.get("v")?.tag).toBe("any");
    expect(fb.map((f: AnyFallback) => f.location)).toEqual(["Root.v"]);
  });

  it("fallback location uses nested record name", () => {
    const { report: fb } = inferWithReport(
      [doc({ outer: { v: 1 } }), doc({ outer: { v: "s" } })],
      { allowAny: true },
    );
    expect(fb.map((f: AnyFallback) => f.location)).toEqual(["Outer.v"]);
  });

  it("default still raises at multi-kind site", () => {
    expect(() => infer([doc({ v: 1 }), doc({ v: "x" })])).toThrow(/more than one scalar/);
    expect(() => infer([doc({ v: 1 }), doc({ v: "x" })], { allowAny: false })).toThrow(
      /more than one scalar/,
    );
  });

  it("default still raises at object-value-mix site", () => {
    expect(() => infer([doc({ a: { x: 1 } }), doc({ a: 5 })])).toThrow(/mixes objects and values/);
  });
});

