import { describe, expect, it } from "vitest";
import { field, record, ref, t, ANY, nullable } from "../../src/schema.js";
import { localSignature } from "../../src/ops/signature.js";

// Ported from upstream omnist's tests/test_any_core.py (local_signature
// cases) plus direct translations of the docstring's own examples.

describe("localSignature", () => {
  it("sorts fields by label, not declaration order", () => {
    const a = record(field("b", t.string), field("a", t.integer));
    const b = record(field("a", t.integer), field("b", t.string));
    expect(localSignature(a)).toEqual(localSignature(b));
  });

  it("excludes ref target names from the shape key", () => {
    const a = record(field("r", ref("Foo")));
    const b = record(field("r", ref("Bar")));
    expect(localSignature(a)).toEqual(localSignature(b));
  });

  it("distinguishes scalar kind and nullable", () => {
    const a = record(field("v", t.string));
    const b = record(field("v", t.integer));
    expect(localSignature(a)).not.toEqual(localSignature(b));
    const nullableRec = record(field("v", nullable(t.string)));
    expect(localSignature(a)).not.toEqual(localSignature(nullableRec));
  });

  it("distinguishes any from scalar and ref", () => {
    const anyRec = record(field("v", ANY));
    const scalarRec = record(field("v", t.string));
    const refRec = record(field("v", ref("Foo")));
    expect(localSignature(anyRec)).not.toEqual(localSignature(scalarRec));
    expect(localSignature(anyRec)).not.toEqual(localSignature(refRec));
  });

  it("distinguishes cardinality", () => {
    const a = record(field("v", t.string, 1, 1));
    const b = record(field("v", t.string, 0, 1));
    expect(localSignature(a)).not.toEqual(localSignature(b));
  });

  it("two records with the same fields in different order have equal signatures", () => {
    const a = record(field("x", t.integer), field("y", t.string));
    const b = record(field("y", t.string), field("x", t.integer));
    expect(localSignature(a)).toEqual(localSignature(b));
  });
});
