import { describe, expect, it } from "vitest";
import { WriteReport, finishWrite } from "../src/report.js";
import { WriteError } from "../src/errors.js";

describe("WriteReport", () => {
  it("starts empty", () => {
    const rep = new WriteReport();
    expect(rep.adjustments).toEqual([]);
    expect(rep.ok).toBe(true);
    expect(rep.length).toBe(0);
    expect(rep.toString()).toBe("no adjustments");
  });

  it("add() records an adjustment", () => {
    const rep = new WriteReport();
    rep.add("$.a", "null.omitted", "dropped", "warning");
    expect(rep.adjustments).toEqual([
      { path: "$.a", code: "null.omitted", message: "dropped", severity: "warning" },
    ]);
    expect(rep.length).toBe(1);
  });

  it("separates warnings and errors", () => {
    const rep = new WriteReport();
    rep.add("$.a", "a", "m1", "warning");
    rep.add("$.b", "b", "m2", "error");
    expect(rep.toString()).toBe("warning: $.a: m1\nerror: $.b: m2");
    expect(rep.warnings.map((a) => a.code)).toEqual(["a"]);
    expect(rep.errors.map((a) => a.code)).toEqual(["b"]);
  });

  it("ok is true iff no error-severity entries", () => {
    const rep = new WriteReport();
    rep.add("$.a", "a", "m1", "warning");
    expect(rep.ok).toBe(true);
    rep.add("$.b", "b", "m2", "error");
    expect(rep.ok).toBe(false);
  });

  it("is iterable", () => {
    const rep = new WriteReport();
    rep.add("$.a", "a", "m1", "warning");
    rep.add("$.b", "b", "m2", "error");
    expect([...rep].map((a) => a.code)).toEqual(["a", "b"]);
  });

  it("toString formats severity: path: message per line", () => {
    const rep = new WriteReport();
    rep.add("$.a", "a", "m1", "warning");
    rep.add("$.b", "b", "m2", "error");
    expect(rep.toString()).toBe("warning: $.a: m1\nerror: $.b: m2");
  });
});

describe("finishWrite", () => {
  it("returns text unchanged when not strict and no external report", () => {
    const rep = new WriteReport();
    rep.add("$.a", "a", "m1", "warning");
    expect(finishWrite("text", rep)).toBe("text");
  });

  it("copies adjustments into an external report", () => {
    const rep = new WriteReport();
    rep.add("$.a", "a", "m1", "warning");
    const out = new WriteReport();
    expect(finishWrite("text", rep, { report: out })).toBe("text");
    expect(out.adjustments).toEqual(rep.adjustments);
  });

  it("appends rather than replacing existing entries in the external report", () => {
    const rep = new WriteReport();
    rep.add("$.a", "a", "m1", "warning");
    const out = new WriteReport();
    out.add("$.z", "z", "m0", "warning");
    finishWrite("text", rep, { report: out });
    expect(out.adjustments.map((a) => a.code)).toEqual(["z", "a"]);
  });

  it("strict raises WriteError when there are adjustments", () => {
    const rep = new WriteReport();
    rep.add("$.a", "a", "m1", "warning");
    expect(() => finishWrite("text", rep, { strict: true })).toThrow(WriteError);
  });

  it("strict does not raise when there are no adjustments", () => {
    const rep = new WriteReport();
    expect(finishWrite("text", rep, { strict: true })).toBe("text");
  });

  it("WriteError carries the report", () => {
    const rep = new WriteReport();
    rep.add("$.a", "a", "m1", "warning");
    try {
      finishWrite("text", rep, { strict: true });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(WriteError);
      expect((e as WriteError).report).toBe(rep);
    }
  });
});
