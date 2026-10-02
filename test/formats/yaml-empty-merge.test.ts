// D-18a empty merge sequence (omnist-spec v0.27.0-beta, Sec2.4.1): `<<: []` is a
// well-formed carrier that merges nothing (W 0, S one slot for the `<<` entry).
import { describe, expect, it } from "vitest";
import { doc } from "../../src/document.js";
import { DocumentError } from "../../src/errors.js";
import { readYaml } from "../../src/formats/yaml.js";
import { EXPANDED_SIZE_CODE } from "../../src/formats/yaml-alias.js";

describe("D-18a: an empty merge sequence merges nothing", () => {
  it("`config: {<<: []}` is an empty mapping", () => {
    expect(readYaml("config: {<<: []}\n")).toEqual(doc({ config: {} }).toData());
  });

  it("`t: {<<: [], c: 3}` keeps only its own key", () => {
    expect(readYaml("t: {<<: [], c: 3}\n")).toEqual(doc({ t: { c: 3n } }).toData());
  });

  it("the alias form `s: &s []` then `<<: *s` merges nothing", () => {
    expect(readYaml("s: &s []\nt: {<<: *s, c: 3}\n")).toEqual(doc({ t: { c: 3n } }).toData());
  });

  it("an anchored empty carrier in merge position merges nothing", () => {
    expect(readYaml("t: {<<: &s [], c: 3}\n")).toEqual(doc({ t: { c: 3n } }).toData());
  });

  it("an empty sequence outside merge position yields no edge", () => {
    expect(readYaml("a: 1\nk: []\n")).toEqual(doc({ a: 1n }).toData());
    expect(readYaml("t: {<<: [], k: []}\n")).toEqual(doc({ t: {} }).toData());
  });

  it("size cap boundary: W(root)=2, S(root)=3 for `t: {<<: []}`", () => {
    const text = "t: {<<: []}\n";
    expect(() => readYaml(text, { maxExpandedSlots: 2 })).not.toThrow();
    let err: unknown;
    try {
      readYaml(text, { maxExpandedSlots: 1 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DocumentError);
    expect((err as DocumentError).code).toBe(EXPANDED_SIZE_CODE);
    expect((err as DocumentError).code).toBe("document.limit.expanded-size");
  });
});
