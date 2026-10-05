// omnist-spec v0.31.0-beta OML-29 (Sec4.2.1; DIV-19): after the colon of an
// edge, any run of horizontal space, comments, newlines and `;` is skipped and
// the value may start on a later line. A separator is still REQUIRED between
// edges (OML-26, OML-27).
import { describe, expect, it } from "vitest";
import { ParseError, readOml, writeOml } from "../src/index.js";

const compact = (text: string): string => writeOml(readOml(text), { indent: null });

describe("OML-29: a gap after the colon is skipped", () => {
  const accepted: Array<[string, string, string]> = [
    ["newline after the colon", "a:\n1", "a: 1"],
    ["semicolon after the colon", "a: ;1", "a: 1"],
    ["comment then newline after the colon", "a: # c\n1", "a: 1"],
    ["newline before a node value", "a:\n{b: 1}", "a: { b: 1 }"],
    ["blank lines after the colon", "a:\n\n\n1", "a: 1"],
    ["newline after a colon inside braces", "x: {a:\n1}", "x: { a: 1 }"],
    ["a mixed run of space, comment, newline and semicolon", 'a: ;\n# c\n; "s"', 'a: "s"'],
    ["before an array", "a:\n[1, 2]", "a: 1; a: 2"],
    ["two edges, each with a gap", "a:\n\n1\nb:\n2", "a: 1; b: 2"],
    ["CRLF after the colon", "a:\r\n1", "a: 1"],
  ];
  it.each(accepted)("%s", (_name, text, expected) => {
    expect(compact(text)).toBe(expected);
  });

  const rejected: Array<[string, string, string, string]> = [
    // A skipped gap does not license a missing separator between edges.
    ["no separator before the next edge", "a:\n1 b: 2", "parse.trailing-content", "2:3"],
    ["the next label is not the value", "a:\nb: 1", "parse.bare-word", "2:1"],
    ["a gap then end of input", "a:\n", "parse.unexpected-token", "2:1"],
    ["a gap then the closing brace", "x: {a:\n}", "parse.unexpected-token", "2:1"],
    ["no value at all", "a:", "parse.unexpected-token", "1:3"],
    ["OML-27 still holds inside braces", "x: {a: 1 b: 2}", "parse.unexpected-token", "1:10"],
  ];
  it.each(rejected)("still rejects: %s", (_name, text, code, path) => {
    let err: unknown;
    try {
      readOml(text);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ParseError);
    expect((err as ParseError).code).toBe(code);
    expect((err as ParseError).path).toBe(path);
  });
});

// OML-29 is about what follows the colon only. Nothing before the colon is
// skipped: a newline, `;` or comment between a label and its colon ends the
// label's edge, so the colon has no label and the document is rejected. Only
// horizontal space may precede the colon (`a : 1`, OML-26's note in Sec4.2.1).
describe("OML-29: a separator BEFORE the colon is not skipped", () => {
  const gaps: Array<[string, string]> = [
    ["a newline", "\n"],
    ["a semicolon", ";"],
    ["a comment then a newline", " # c\n"],
    ["a CRLF", "\r\n"],
  ];
  const shapes: Array<[string, (gap: string) => string]> = [
    ["the first edge", (g) => `a${g}: 1`],
    ["a later edge", (g) => `x: 1\nb${g}: 2`],
    ["inside braces", (g) => `x: {a${g}: 1}`],
    ["inside an array of nodes", (g) => `x: [{a${g}: 1}]`],
  ];
  for (const [gapName, gap] of gaps) {
    for (const [shapeName, build] of shapes) {
      it(`rejects ${gapName} before the colon: ${shapeName}`, () => {
        expect(() => readOml(build(gap))).toThrow(ParseError);
      });
    }
  }

  it("horizontal space before the colon is still fine", () => {
    expect(compact("a : 1")).toBe("a: 1");
    expect(compact("a  \t: 1")).toBe("a: 1");
    expect(compact("x: {a : 1}")).toBe("x: { a: 1 }");
  });

  it("reports the stray token at its position", () => {
    const at = (text: string): string | undefined => {
      try {
        readOml(text);
      } catch (e) {
        return (e as ParseError).path;
      }
      return undefined;
    };
    expect(at("a\n: 1")).toBe("1:1");
    expect(at("x: {a\n: 1}")).toBe("1:6");
    expect(at("x: 1\nb;: 2")).toBe("2:2");
  });
});
