import { describe, expect, it } from "vitest";
import { parseSchema } from "../../src/osd.js";
import { recordField, type Record as OmnistRecord, type Schema } from "../../src/schema.js";
import { isEmpty, prune, satisfiableSet } from "../../src/ops/prune.js";
import { equivalent } from "../../src/ops/subschema.js";

function getRec(s: Schema, name: string): OmnistRecord {
  const rec = s.env.get(name);
  if (rec === undefined) throw new Error(`expected ${JSON.stringify(name)} in env`);
  return rec;
}

// Ported from upstream omnist's tests/test_canonical.py (TestEmptySchemas).

function mandatoryCycle() {
  return parseSchema('record A { "x": B }\nrecord B { "y": A }\nroot A');
}

describe("satisfiableSet / isEmpty", () => {
  it("is empty for a mandatory ref cycle", () => {
    expect(isEmpty(mandatoryCycle())).toBe(true);
  });

  it("is not empty when the cycle is broken by an optional field", () => {
    const s = parseSchema('record A { "x" [0,1]: B }\nrecord B { "y": A }\nroot A');
    expect(isEmpty(s)).toBe(false);
  });

  it("is not empty for a scalar-only schema", () => {
    const s = parseSchema('record R { "a": integer }\nroot R');
    expect(isEmpty(s)).toBe(false);
  });

  it("an optional dead field does not block satisfiability", () => {
    const r = parseSchema('record R { "x" [0,1]: Dead }\nrecord Dead { "d": Dead }\nroot R');
    expect(isEmpty(r)).toBe(false);
    expect(satisfiableSet(r).has("R")).toBe(true);
    expect(satisfiableSet(r).has("Dead")).toBe(false);
  });
});

describe("prune", () => {
  it("drops unreachable records", () => {
    const s = parseSchema('record A { "x": integer }\nrecord Unused { "y": integer }\nroot A');
    const p = prune(s);
    expect(p.env.has("Unused")).toBe(false);
    expect(p.env.has("A")).toBe(true);
  });

  it("drops max=0 fields", () => {
    const s = parseSchema('record R { "dead" [0,0]: integer, "live": integer }\nroot R');
    const p = prune(s);
    expect(recordField(getRec(p, "R"), "dead")).toBeUndefined();
    expect(recordField(getRec(p, "R"), "live")).not.toBeUndefined();
  });

  it("drops optional unsatisfiable fields", () => {
    const s = parseSchema('record R { "x" [0,1]: Dead }\nrecord Dead { "d": Dead }\nroot R');
    const p = prune(s);
    expect(recordField(getRec(p, "R"), "x")).toBeUndefined();
    expect(p.env.has("Dead")).toBe(false);
  });

  it("is equivalent to the original", () => {
    const s = parseSchema(
      'record R { "dead" [0,0]: integer, "live": integer }\nrecord Unused { "z": integer }\nroot R',
    );
    expect(equivalent(prune(s), s)).toBe(true);
  });

  it("is idempotent", () => {
    const s = parseSchema(
      'record R { "dead" [0,0]: integer, "live": integer }\nrecord Unused { "z": integer }\nroot R',
    );
    const once = prune(s);
    const twice = prune(once);
    expect([...twice.env.keys()].sort()).toEqual([...once.env.keys()].sort());
    for (const name of once.env.keys()) {
      expect(getRec(once, name).fields.length).toBe(getRec(twice, name).fields.length);
    }
  });

  it("keeps an unsatisfiable root's own fields intact", () => {
    const s = mandatoryCycle();
    const p = prune(s);
    expect(isEmpty(p)).toBe(true);
    expect(recordField(getRec(p, "A"), "x")).not.toBeUndefined();
    expect(equivalent(p, s)).toBe(true);
  });
});
