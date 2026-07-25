/**
 * Pins the exact output shown in docs/quickstart.md's code block so the
 * doc can't silently drift from what running it actually produces. See
 * docs/testing.md.
 */
import { describe, expect, it } from "vitest";
import { readOml, parseSchema, infer, doc, toOsd, Doc } from "../src/index.js";

describe("quickstart snippet reproduces the documented output", () => {
  it("validates and infers exactly as shown", () => {
    const node = readOml('name: "Ann"');
    const schema = parseSchema('record Person { "name": string }\nroot Person');
    expect(schema.validate(new Doc(node)).ok).toBe(true);

    const inferred = infer([doc({ name: "Ann" }), doc({ name: "Bo" })]);
    expect(toOsd(inferred)).toBe('record Root {\n    "name": string,\n}\nroot Root\n');
  });
});
