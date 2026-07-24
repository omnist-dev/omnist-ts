import { describe, expect, it } from "vitest";
import { parseSchema } from "../../src/osd.js";
import { SchemaError } from "../../src/errors.js";
import { recordField, type Record as OmnistRecord, type Schema } from "../../src/schema.js";
import { extract } from "../../src/ops/extract.js";
import { normalize } from "../../src/ops/minimize.js";
import { compatibleWith, equivalent } from "../../src/ops/subschema.js";

function getRec(s: Schema, name: string): OmnistRecord {
  const rec = s.env.get(name);
  if (rec === undefined) throw new Error(`expected ${JSON.stringify(name)} in env`);
  return rec;
}

// Ported from upstream omnist's tests/test_canonical.py (TestExtract).

describe("extract", () => {
  it("the paper's worked Quote/Order example", () => {
    const quoteOrder = parseSchema(`
      record Root { "quote" [0,1]: Quote, "order" [0,1]: Order }
      record Quote { "line" [1,]: Line }
      record Order { "line" [1,]: OrderLine }
      record Line { "desc": string, "price": number }
      record OrderLine { "product" [1,]: Product, "qty": integer }
      record Product { "desc": string, "price": number }
      root Root
    `);
    const ex = extract(quoteOrder, ["quote", "line", "desc", "price"]);
    expect([...ex.env.keys()].sort()).toEqual(["Line", "Quote", "Root"]);
    expect(compatibleWith(ex, quoteOrder)).toBe(true);
  });

  it("raises with the offending label and record on mandatory deletion", () => {
    const s = parseSchema('record R { "must": integer, "opt" [0,1]: string }\nroot R');
    let err: unknown;
    try {
      extract(s, ["opt"]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SchemaError);
    const msg = (err as Error).message;
    expect(msg).toContain("must");
    expect(msg).toContain("R");
  });

  it("full-label extract equals normalize's record count", () => {
    const s = parseSchema(
      'record A { "x": integer }\nrecord B { "x": integer }\nrecord Root { "a": A, "b": B }\nroot Root',
    );
    expect(extract(s, ["a", "b", "x"]).env.size).toBe(normalize(s).env.size);
  });

  it("optional field deletion does not invalidate its record", () => {
    const s = parseSchema('record R { "must": integer, "opt" [0,1]: string }\nroot R');
    const ex = extract(s, ["must"]);
    expect(recordField(getRec(ex, ex.root.name), "opt")).toBeUndefined();
    expect(compatibleWith(ex, s)).toBe(true);
  });

  it("propagates invalidation transitively", () => {
    // C loses its mandatory "z" (not kept) -> C invalidated.
    // B's mandatory field "c" points at C -> B invalidated.
    // A's mandatory field "b" points at B -> A invalidated (root).
    const s = parseSchema('record A { "b": B }\nrecord B { "c": C }\nrecord C { "z": integer }\nroot A');
    let err: unknown;
    try {
      extract(s, []);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SchemaError);
    const msg = (err as Error).message;
    const candidates: [string, string][] = [
      ["b", "A"],
      ["c", "B"],
      ["z", "C"],
    ];
    expect(candidates.some(([label, rec]) => msg.includes(label) && msg.includes(rec))).toBe(true);
  });

  it("drops a deleted ref field's target record from the result", () => {
    const s = parseSchema('record R { "keep": integer, "drop" [0,1]: Other }\nrecord Other { "v": string }\nroot R');
    const ex = extract(s, ["keep"]);
    expect(ex.root.name).toBe("R");
    expect(recordField(getRec(ex, "R"), "drop")).toBeUndefined();
    expect(ex.env.has("Other")).toBe(false);
  });

  it("extract's result is equivalent to itself after normalize (idempotent shape)", () => {
    const s = parseSchema('record R { "a": integer, "b": string }\nroot R');
    const ex = extract(s, ["a", "b"]);
    expect(equivalent(ex, normalize(s))).toBe(true);
  });
});
