import { describe, expect, it } from "vitest";
import {
  OmnistError,
  SchemaError,
  VERSION,
  STRING,
  INTEGER,
  NUMBER,
  BOOLEAN,
  DATE,
  TIME,
  DATETIME,
  t,
  satisfiableSet,
  equivalenceClasses,
  schema,
  record,
  field,
  ref,
} from "../src/index.js";

describe("public entry point", () => {
  it("re-exports the error hierarchy", () => {
    expect(new SchemaError("x")).toBeInstanceOf(OmnistError);
  });

  it("exposes the current version", () => {
    expect(VERSION).toBe("0.0.4-alpha");
  });

  it("exports the seven scalar constants matching their t.* equivalents", () => {
    expect(STRING).toEqual(t.string);
    expect(INTEGER).toEqual(t.integer);
    expect(NUMBER).toEqual(t.number);
    expect(BOOLEAN).toEqual(t.boolean);
    expect(DATE).toEqual(t.date);
    expect(TIME).toEqual(t.time);
    expect(DATETIME).toEqual(t.datetime);
  });

  it("exposes satisfiableSet and equivalenceClasses as callable, package-level ops", () => {
    const s = schema("A", {
      A: record(field("x", ref("B"))),
      B: record(field("y", STRING)),
      C: record(field("y", STRING)),
    });

    expect(satisfiableSet(s)).toEqual(new Set(["A", "B", "C"]));

    const classes = equivalenceClasses(s);
    const bcClass = classes.find((block) => block.includes("B"));
    expect(bcClass).toEqual(expect.arrayContaining(["B", "C"]));
  });
});
