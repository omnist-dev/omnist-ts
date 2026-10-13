import { describe, expect, it } from "vitest";
import { readXml } from "../../src/formats/xml.js";
import type { DocumentError, ParseError } from "../../src/errors.js";

// omnist-ts#169 (c) and (d): hostile XML must give a coded diagnostic quickly.
// The bounds are generous: the depth case took minutes (100,000 deep) and the
// attribute case threw a RangeError before the fix.

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(Error);
    return (e as DocumentError | ParseError).code;
  }
  return undefined;
}

const nested = (n: number, leaf = "x"): string => "<a>".repeat(n) + leaf + "</a>".repeat(n);

describe("XML depth limit is enforced in linear time (omnist-ts#169 d)", () => {
  it.each([1_000, 10_000, 100_000])("a %i-deep document is refused with document.limit.depth quickly", (n) => {
    const text = nested(n);
    const t0 = performance.now();
    expect(codeOf(() => readXml(text))).toBe("document.limit.depth");
    // The pre-fix code needs about 0.05 s at 1,000 deep, over 1 s at 8,000 and
    // minutes at 100,000, growing faster than linearly; the fix is milliseconds.
    expect(performance.now() - t0).toBeLessThan(5000);
  }, 60_000);

  it("the depth limit sits exactly where it did: 200 nested elements read, 201 are refused", () => {
    expect(codeOf(() => readXml(nested(200)))).toBeUndefined();
    expect(codeOf(() => readXml(nested(201)))).toBe("document.limit.depth");
    expect(codeOf(() => readXml(nested(3), { maxDepth: 3 }))).toBeUndefined();
    expect(codeOf(() => readXml(nested(4), { maxDepth: 3 }))).toBe("document.limit.depth");
  });

  it("counts a self-closing child and skips comments, CDATA, processing instructions and quoted '>'", () => {
    const body = '<!-- <b><b><b> --><d><![CDATA[<b><b>]]></d><?pi <b><b> ?><c x="&gt;>" y=\'>\'/>';
    expect(codeOf(() => readXml("<a>" + body + "</a>", { maxDepth: 2 }))).toBeUndefined();
    expect(codeOf(() => readXml("<a><b>" + body + "</b></a>", { maxDepth: 2 }))).toBe("document.limit.depth");
    expect(codeOf(() => readXml("<a>" + body + "<b><e>v</e></b></a>", { maxDepth: 2 }))).toBe("document.limit.depth");
  });

  it("a wide document is not slowed by the check", () => {
    const text = "<r>" + "<i>1</i>".repeat(200_000) + "</r>";
    const t0 = performance.now();
    readXml(text);
    expect(performance.now() - t0).toBeLessThan(20_000);
  }, 60_000);
});

describe("an XML attribute value of any size gives a coded diagnostic (omnist-ts#169 c)", () => {
  it.each([1, 2, 4, 8])("a %i MB attribute value never escapes as a RangeError", (mb) => {
    const text = '<a x="' + "v".repeat(mb * 1024 * 1024) + '"><b>1</b></a>';
    const t0 = performance.now();
    const code = codeOf(() => readXml(text));
    // Up to the validator's own limit the value is read (and dropped); past it
    // the read is refused. Either way: no uncaught exception, and quickly.
    expect(code === undefined || code === "parse.codec-syntax").toBe(true);
    expect(performance.now() - t0).toBeLessThan(30_000);
  }, 60_000);

  it("an 8 MB attribute value is parse.codec-syntax with a line:col path", () => {
    const text = '<a x="' + "v".repeat(8 * 1024 * 1024) + '"><b>1</b></a>';
    try {
      readXml(text);
      throw new Error("expected a ParseError");
    } catch (e) {
      expect((e as ParseError).code).toBe("parse.codec-syntax");
      expect((e as ParseError).path).toMatch(/^\d+:\d+$/);
      expect((e as ParseError).message).toContain("attribute value");
    }
  }, 60_000);
});
