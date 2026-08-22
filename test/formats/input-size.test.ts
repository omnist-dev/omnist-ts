import { describe, expect, it } from "vitest";
import { ParseError } from "../../src/errors.js";
import { MAX_INPUT_BYTES, checkInputSize } from "../../src/formats/input-size.js";
import { readJson } from "../../src/formats/json.js";
import { readYaml } from "../../src/formats/yaml.js";
import { readToml } from "../../src/formats/toml.js";
import { readXml } from "../../src/formats/xml.js";

// Issue #110: all four format readers used to hand raw input straight to
// their underlying external parsing library before this repo's own
// MAX_DEPTH/MAX_NODES checks (in buildNode(), src/document.ts) ever ran.
// checkInputSize() closes the "attacker sends an arbitrarily large raw
// input string" case cheaply, ahead of any library call. See
// src/formats/input-size.ts's file-top comment for the full reasoning
// and how MAX_INPUT_BYTES was chosen.

describe("checkInputSize", () => {
  it("accepts input at exactly MAX_INPUT_BYTES", () => {
    const text = "a".repeat(MAX_INPUT_BYTES);
    expect(() => checkInputSize(text, "JSON")).not.toThrow();
  });

  it("rejects input one code unit over MAX_INPUT_BYTES", () => {
    const text = "a".repeat(MAX_INPUT_BYTES + 1);
    expect(() => checkInputSize(text, "JSON")).toThrow(ParseError);
    expect(() => checkInputSize(text, "JSON")).toThrow(/invalid JSON.*input size limit/s);
  });

  it("names the format in the error message", () => {
    const text = "a".repeat(MAX_INPUT_BYTES + 1);
    expect(() => checkInputSize(text, "YAML")).toThrow(/invalid YAML/);
  });
});

// Each of these constructs a syntactically-valid-shaped document (a single
// oversized string/text value) that the underlying library would happily
// accept and fully parse if given the chance -- so a fast rejection here
// (well under a second, no huge intermediate parsed structure ever built)
// demonstrates the size check runs *before* the library, not that the
// library itself would have been slow. That ordering claim is the one
// issue #110 is actually about; see the source-reading evidence in the
// issue body for confirmation that each library's own parse call used to
// run first.
describe("readJson / readYaml / readToml / readXml reject oversized input before parsing", () => {
  const oversized = "x".repeat(MAX_INPUT_BYTES + 1);

  it("readJson rejects an oversized (but otherwise valid) JSON string literal", () => {
    const text = '"' + oversized + '"';
    const start = Date.now();
    expect(() => readJson(text)).toThrow(ParseError);
    expect(() => readJson(text)).toThrow(/input size limit/);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("readYaml rejects an oversized (but otherwise valid) plain scalar", () => {
    // A bare run of letters is a valid YAML plain scalar -- without the
    // size check, this parses successfully into one giant string node.
    const start = Date.now();
    expect(() => readYaml(oversized)).toThrow(ParseError);
    expect(() => readYaml(oversized)).toThrow(/input size limit/);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("readToml rejects an oversized (but otherwise valid) string value", () => {
    const text = 'a = "' + oversized + '"';
    const start = Date.now();
    expect(() => readToml(text)).toThrow(ParseError);
    expect(() => readToml(text)).toThrow(/input size limit/);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("readXml rejects an oversized (but otherwise valid) element text", () => {
    const text = "<a>" + oversized + "</a>";
    const start = Date.now();
    expect(() => readXml(text)).toThrow(ParseError);
    expect(() => readXml(text)).toThrow(/input size limit/);
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

// Sanity check (issue #110 step 6): the size cap must not be tighter than
// what a legitimate MAX_NODES-sized document actually needs. XML's
// preserveOrder tag-per-node encoding is the most byte-verbose of the
// four formats, so it's the tightest fit against the cap -- checking it
// covers the other three by construction (JSON/YAML/TOML are all more
// compact per node).
describe("MAX_INPUT_BYTES stays well above a legitimate MAX_NODES-sized document", () => {
  it("a 1,000,000-leaf-element XML document serializes to well under MAX_INPUT_BYTES", () => {
    const oneMillionMinimalElements = "<a>0</a>".repeat(1_000_000);
    const text = "<r>" + oneMillionMinimalElements + "</r>";
    expect(text.length).toBeLessThan(MAX_INPUT_BYTES);
    // Comfortable margin, not just "technically under": today's
    // reference default (MAX_NODES = 1,000,000, src/formats/xml.ts) in
    // its most verbose realistic shape uses well under half the cap.
    expect(text.length).toBeLessThan(MAX_INPUT_BYTES / 2);
  });
});
