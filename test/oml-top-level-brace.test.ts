// omnist-ts#160, omnist-spec Sec4.6: an OML document is exactly one of three
// shapes (a single scalar, zero or more top-level edges, the empty document).
// A top-level braced node `{a: 1}` is none of them: it is rejected as
// parse.unexpected-token at the brace, the code Go and Python (omnist#356)
// report. Braces stay legal as an edge's value.
import { describe, expect, it } from "vitest";
import { ParseError, readOml, writeOml } from "../src/index.js";

function failure(text: string): ParseError {
  try {
    readOml(text);
  } catch (e) {
    expect(e).toBeInstanceOf(ParseError);
    return e as ParseError;
  }
  throw new Error("expected a parse error for " + JSON.stringify(text));
}

describe("a top-level braced node is not a document (#160)", () => {
  const rejected: Array<[string, string, string]> = [
    ["a braced node", "{a: 1}", "1:1"],
    ["an empty braced node", "{}", "1:1"],
    ["a braced node with spaces", "{ a: 1; b: 2 }", "1:1"],
    ["a braced node after blank lines", "\n\n  {a: 1}", "3:3"],
    ["a braced node after a comment", "# c\n{a: 1}", "2:1"],
    ["a braced node after a BOM", "\u{feff}{a: 1}", "1:1"],
    ["a braced node before an edge", "{a: 1}\nb: 2", "1:1"],
    ["a braced node as the second statement", "x: 1\n{a: 1}", "2:1"],
  ];
  it.each(rejected)("%s", (_name, text, path) => {
    const e = failure(text);
    expect(e.code).toBe(path === "2:1" && text.startsWith("x:") ? "parse.trailing-content" : "parse.unexpected-token");
    expect(e.path).toBe(path);
  });

  it("the three legal shapes still read", () => {
    expect(readOml('"hello"')).toBe("hello");
    expect(writeOml(readOml("a: 1\nb: 2\n"), { indent: null })).toBe("a: 1; b: 2");
    expect(readOml("")).toEqual([]);
  });

  it("a braced node is still a legal VALUE", () => {
    expect(writeOml(readOml("x: {a: 1}"), { indent: null })).toBe("x: { a: 1 }");
    expect(writeOml(readOml("a: [{b: 1}, {b: 2}]"), { indent: null })).toBe("a: { b: 1 }; a: { b: 2 }");
  });
});
