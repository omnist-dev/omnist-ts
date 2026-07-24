import { describe, expect, it } from "vitest";
import {
  OmnistError,
  SchemaError,
  ParseError,
  WriteError,
  DocumentError,
  DetachedNode,
  UnsafeXMLWarning,
} from "../src/errors.js";

describe("error hierarchy", () => {
  it("SchemaError is an OmnistError", () => {
    const e = new SchemaError("bad schema");
    expect(e).toBeInstanceOf(OmnistError);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("SchemaError");
    expect(e.message).toBe("bad schema");
  });

  it("DetachedNode is a DocumentError is an OmnistError", () => {
    const e = new DetachedNode("cursor stale");
    expect(e).toBeInstanceOf(DocumentError);
    expect(e).toBeInstanceOf(OmnistError);
  });

  it("ParseError defaults errors to empty and carries structured issues", () => {
    const bare = new ParseError("bad json");
    expect(bare.errors).toEqual([]);

    const withIssues = new ParseError("invalid", [
      { path: "$.id", message: "expected integer, got string", code: "type_mismatch" },
    ]);
    expect(withIssues.errors).toHaveLength(1);
    expect(withIssues.errors[0]?.code).toBe("type_mismatch");
  });

  it("WriteError carries an opaque report", () => {
    const report = { adjustments: [] };
    const e = new WriteError("lossy write", report);
    expect(e.report).toBe(report);
    expect(new WriteError("no report").report).toBeUndefined();
  });

  it("UnsafeXMLWarning is a plain Error subclass, unused by the library", () => {
    expect(new UnsafeXMLWarning("unused")).toBeInstanceOf(Error);
  });

  it("errors are catchable by base type across the hierarchy", () => {
    const thrown: unknown[] = [
      new SchemaError("a"),
      new ParseError("b"),
      new DocumentError("c"),
      new DetachedNode("d"),
      new WriteError("e"),
    ];
    for (const err of thrown) {
      expect(err).toBeInstanceOf(OmnistError);
    }
  });
});
