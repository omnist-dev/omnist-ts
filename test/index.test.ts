import { describe, expect, it } from "vitest";
import { OmnistError, SchemaError, VERSION } from "../src/index.js";

describe("public entry point", () => {
  it("re-exports the error hierarchy", () => {
    expect(new SchemaError("x")).toBeInstanceOf(OmnistError);
  });

  it("exposes the current version", () => {
    expect(VERSION).toBe("0.0.2-alpha");
  });
});
