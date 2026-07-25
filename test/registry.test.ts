import { describe, expect, it } from "vitest";
import { Format, registerFormat, getFormat, formats } from "../src/registry.js";
import { OmnistError } from "../src/errors.js";
import "../src/index.js";

describe("format registry", () => {
  it("has the built-in formats registered", () => {
    const names = formats();
    expect(names).toContain("json");
    expect(names).toContain("oml");
  });

  it("formats() is sorted", () => {
    const names = formats();
    expect(names).toEqual([...names].sort());
  });

  it("getFormat round-trips through read/write", () => {
    const fmt = getFormat("json");
    const node = fmt.read('{"a": 1}');
    expect(fmt.write(node)).toBe('{"a": 1}');
  });

  it("unknown format raises OmnistError naming the registered formats", () => {
    expect(() => getFormat("nope")).toThrow(OmnistError);
    try {
      getFormat("nope");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("nope");
      expect((e as Error).message).toContain("json");
    }
  });

  it("registerFormat adds a plugin usable via getFormat", () => {
    const fmt: Format = {
      name: "lines",
      read: (text: string) => text.split(" ").map((x) => ["n", Number(x)] as const),
      write: (node: unknown) =>
        (node as Array<[string, number]>).map(([, v]) => String(v)).join(" "),
    };
    registerFormat(fmt);
    expect(formats()).toContain("lines");
    const got = getFormat("lines");
    expect(got.write(got.read("1 2 3"))).toBe("1 2 3");
  });

  it("registerFormat replaces an existing entry of the same name", () => {
    const first: Format = { name: "dup", read: (t) => t, write: (n) => String(n) };
    const second: Format = { name: "dup", read: (t) => String(t) + "!", write: (n) => String(n) };
    registerFormat(first);
    registerFormat(second);
    expect(getFormat("dup").read("x")).toBe("x!");
  });

  it("check is optional on a Format", () => {
    const fmt: Format = { name: "nocheck", read: (t) => t, write: (n) => String(n) };
    expect(fmt.check).toBeUndefined();
  });
});
