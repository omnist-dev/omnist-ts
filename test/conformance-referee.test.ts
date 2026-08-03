/**
 * Unit tests for tools/conformance/referee.ts -- the structural-equality
 * referee ported from Python's tools/conformance/referee.py. These test the
 * referee's own comparison logic against small synthetic OML/OSD snippets
 * and require no submodule; the real conformance run against
 * vendor/omnist-spec's fixtures is exercised by
 * test/conformance-self-test.test.ts.
 */
import { describe, expect, it } from "vitest";
import { compareDocument, compareSchema } from "../tools/conformance/referee.js";

describe("compareDocument", () => {
  it("returns true for structurally identical OML", () => {
    expect(compareDocument("a: 1\nb: 2\n", "a: 1\nb: 2\n")).toBe(true);
  });

  it("returns false for reordered edges (order-sensitive)", () => {
    expect(compareDocument("a: 1\nb: 2\n", "b: 2\na: 1\n")).toBe(false);
  });

  it("returns false for different values", () => {
    expect(compareDocument("a: 1\n", "a: 2\n")).toBe(false);
  });
});

describe("compareSchema", () => {
  const a = 'record R {\n    "a": string,\n}\nroot R\n';
  const bSameNames = 'record R {\n    "a": string,\n}\nroot R\n';
  const bRenamed = 'record S {\n    "a": string,\n}\nroot S\n';
  const bDifferentField = 'record R {\n    "a": integer,\n}\nroot R\n';

  it("exact mode: true for identical schemas", () => {
    expect(compareSchema(a, bSameNames, "exact")).toBe(true);
  });

  it("exact mode: false for renamed records", () => {
    expect(compareSchema(a, bRenamed, "exact")).toBe(false);
  });

  it("exact mode: false for a differing field type", () => {
    expect(compareSchema(a, bDifferentField, "exact")).toBe(false);
  });

  it("isomorphic mode: true for renamed-but-isomorphic records", () => {
    expect(compareSchema(a, bRenamed, "isomorphic")).toBe(true);
  });

  it("isomorphic mode: false for a differing field type", () => {
    expect(compareSchema(a, bDifferentField, "isomorphic")).toBe(false);
  });

  it("throws on an unknown mode string", () => {
    expect(() => compareSchema(a, bSameNames, "fuzzy")).toThrow(/unknown comparison mode/);
  });
});
