/**
 * Pins the exact values shown in docs/guide.md's code blocks so the doc
 * can't silently drift from what running it actually produces.
 */
import { describe, expect, it } from "vitest";
import { doc, parseSchema, toOsd } from "../src/index.js";

describe("documents section reproduces the shown values", () => {
  it("labels/count/getOne/get/toData/toGrouped match the doc", () => {
    const d = doc({ name: "Ann", tag: ["x", "y"] });
    expect(d.labels()).toEqual(["name", "tag"]);
    expect(d.count("tag")).toBe(2);
    expect(d.getOne("name").value).toBe("Ann");
    expect(d.get("tag").map((t) => t.value)).toEqual(["x", "y"]);
    expect(d.toData()).toEqual([
      { label: "name", target: "Ann" },
      { label: "tag", target: "x" },
      { label: "tag", target: "y" },
    ]);
    expect(d.toGrouped()).toEqual({ name: "Ann", tag: ["x", "y"] });
  });
});

describe("osd round-trips through parseSchema and toOsd", () => {
  it("matches the documented output", () => {
    const s = parseSchema('record User { "name": string }\nroot User');
    expect(toOsd(s)).toBe('record User {\n    "name": string,\n}\nroot User\n');
  });
});
