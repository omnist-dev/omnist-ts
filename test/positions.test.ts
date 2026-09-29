import { describe, expect, it } from "vitest";
import { ParseError, SchemaError } from "../src/errors.js";
import { readOml } from "../src/oml.js";
import { parseSchema } from "../src/osd.js";
import { lineCol } from "../src/position.js";

// omnist-spec v0.22.0-beta: OML-25/26/27 (top-level leftover tokens) and
// E-28/E-29 (line:col counts code points; line advances at LF).

const astral = String.fromCodePoint(0x1f600);
const eAcute = String.fromCharCode(0xe9);
const combining = String.fromCharCode(0x301);

function omlErr(text: string): ParseError {
  try {
    readOml(text);
  } catch (e) {
    expect(e).toBeInstanceOf(ParseError);
    return e as ParseError;
  }
  throw new Error(`expected a ParseError for ${JSON.stringify(text)}`);
}

function osdErr(text: string): SchemaError {
  try {
    parseSchema(text);
  } catch (e) {
    expect(e).toBeInstanceOf(SchemaError);
    return e as SchemaError;
  }
  throw new Error(`expected a SchemaError for ${JSON.stringify(text)}`);
}

describe("OML-26: leftover token after a complete top-level edge", () => {
  const leftovers: Array<[string, string]> = [
    ["}", "close brace"],
    ["]", "close bracket"],
    [",", "comma"],
    [":", "colon"],
    ["{", "open brace"],
    ["[2]", "array"],
    ["5", "integer"],
    ["1.5", "number"],
    ["nan", "nan"],
    ["inf", "inf"],
    ["2024-01-01", "date"],
    ["10:30:00", "time"],
    ["2024-01-01T10:30:00", "datetime"],
  ];
  for (const [tok, name] of leftovers) {
    it(`${name} after LF is parse.trailing-content at 2:1`, () => {
      const e = omlErr(`a: 1\n${tok}`);
      expect(e.code).toBe("parse.trailing-content");
      expect(e.path).toBe("2:1");
    });
    it(`${name} after ';' is parse.trailing-content at 1:7`, () => {
      const e = omlErr(`a: 1; ${tok}`);
      expect(e.code).toBe("parse.trailing-content");
      expect(e.path).toBe("1:7");
    });
    it(`${name} with no separator is parse.trailing-content at 1:6`, () => {
      const e = omlErr(`a: 1 ${tok}`);
      expect(e.code).toBe("parse.trailing-content");
      expect(e.path).toBe("1:6");
    });
  }

  it("a brace edge value followed by LF and } is trailing content at 2:1", () => {
    const e = omlErr("a: {b: 1}\n}");
    expect(e.code).toBe("parse.trailing-content");
    expect(e.path).toBe("2:1");
  });

  it("a STRING or IDENT with no separator is leftover (1:6)", () => {
    expect(omlErr("a: 1 b: 2").path).toBe("1:6");
    expect(omlErr('a: 1 "b": 2').code).toBe("parse.trailing-content");
  });

  it("a STRING or IDENT after a separator is the next edge (valid two-edge document)", () => {
    expect(readOml("a: 1\nb: 2")).toEqual(readOml("a: 1; b: 2"));
    expect(readOml('a: 1\n"b": 2')).toEqual(readOml("a: 1\nb: 2"));
    expect(readOml("a: 1\nb: 2\n")).toHaveLength(2);
  });

  it("a malformed next edge reports its own error", () => {
    const reserved = omlErr("a: 1\nnull: 2");
    expect(reserved.code).toBe("parse.reserved-word-label");
    expect(reserved.path).toBe("2:1");
    expect(omlErr("a: 1\nb 2").code).toBe("parse.unexpected-token");
  });

  it("the trailing separator run may end the document", () => {
    expect(readOml("a: 1\n\n;\n")).toHaveLength(1);
  });
});

describe("OML-25: scalar branch", () => {
  it("1, LF, } is trailing content at 2:1", () => {
    const e = omlErr("1\n}");
    expect(e.code).toBe("parse.trailing-content");
    expect(e.path).toBe("2:1");
  });
  it("1 } is trailing content at 1:3", () => {
    expect(omlErr("1 }").path).toBe("1:3");
  });
});

describe("OML-27: inside braces and brackets stays unexpected-token", () => {
  it("missing separator or stray token", () => {
    expect(omlErr("a: { b: 1 c: 2 }").code).toBe("parse.unexpected-token");
    expect(omlErr("a: { b: 1\n, }").code).toBe("parse.unexpected-token");
    expect(omlErr("a: { b: 1\n: }").code).toBe("parse.unexpected-token");
    expect(omlErr("a: [1 2]").code).toBe("parse.unexpected-token");
  });
  it("unterminated arrays stay unexpected-token; a separator in an array stays separator-in-array", () => {
    expect(omlErr("a: [1, 2\n").code).toBe("parse.unexpected-token");
    expect(omlErr("a: [1\n").code).toBe("parse.unexpected-token");
    expect(omlErr("x: {a: [1, 2\n}").code).toBe("parse.unexpected-token");
    const e = omlErr("a: [1\n2]");
    expect(e.code).toBe("parse.separator-in-array");
    expect(e.path).toBe("2:1");
  });
});

describe("E-28 / E-29: OML columns count code points", () => {
  // The invalid escape is reported at the string's opening quote (E-23).
  const cases: Array<[string, string, string]> = [
    ["BMP non-ASCII", eAcute, "1:12"],
    ["astral character", astral, "1:12"],
    ["combining mark (base + mark = 2)", `e${combining}`, "1:13"],
    ["two astral characters", astral + astral, "1:13"],
  ];
  for (const [name, ch, pos] of cases) {
    it(`${name} before the failure`, () => {
      const e = omlErr(`a: "${ch}"; b: "\\q"\n`);
      expect(e.code).toBe("parse.invalid-escape");
      expect(e.path).toBe(pos);
    });
  }
  it("a tab before the failure is one code point", () => {
    expect(omlErr(`a:\t"${astral}"; b: "\\q"`).path).toBe("1:12");
    expect(omlErr(`a:\t"${eAcute}${combining}"\t; b: "\\q"`).path).toBe("1:14");
  });
  it("line advances at LF; CRLF is one break", () => {
    expect(omlErr(`a: 1\r\n}`).path).toBe("2:1");
    expect(omlErr(`a: 1\n${astral}`).path).toBe("2:1");
    expect(omlErr(`a: 1\n"${astral}" 5`).path).toBe("2:5");
  });
  it("a lone CR does not advance the line", () => {
    expect(omlErr("a: 1\r}").path).toMatch(/^1:/); // the column is unspecified (E-29)
  });
});

describe("E-28 / E-29: OSD columns count code points", () => {
  // A raw control character in a string is reported at the string's opening quote (E-23).
  const u1 = String.fromCharCode(1);
  it("astral character before the failure on line 2", () => {
    const e = osdErr(`record R {\n    "${astral}": string, "b${u1}": string,\n}\nroot R\n`);
    expect(e.code).toBe("parse.control-character");
    expect(e.path).toBe("2:18");
  });
  it("BMP non-ASCII, combining mark and tab before the failure", () => {
    expect(osdErr(`record R {\n    "${eAcute}": string, "b${u1}": string,\n}\nroot R\n`).path).toBe("2:18");
    expect(osdErr(`record R {\n    "e${combining}": string, "b${u1}": string,\n}\nroot R\n`).path).toBe("2:19");
    expect(osdErr(`record R {\n\t"${astral}":\tstring, "b${u1}": string,\n}\nroot R\n`).path).toBe("2:15");
  });
  it("CRLF counts as one line break", () => {
    expect(osdErr(`record R {\r\n    "b${u1}": string,\r\n}\r\nroot R\r\n`).path).toBe("2:5");
  });
});

describe("lineCol helper", () => {
  it("counts code points and LF lines", () => {
    expect(lineCol("", 0)).toEqual([1, 1]);
    expect(lineCol(`${astral}x`, 2)).toEqual([1, 2]);
    expect(lineCol(`a\n${astral}${astral}x`, 6)).toEqual([2, 3]);
    expect(lineCol("a\nb\nc", 4)).toEqual([3, 1]);
    // a newline at or after pos does not count
    expect(lineCol("ab\ncd", 2)).toEqual([1, 3]);
    expect(lineCol("ab\ncd", 3)).toEqual([2, 1]);
  });
  it("a lone surrogate is one code point; a pair cut at pos is not merged", () => {
    const hi = String.fromCharCode(0xd83d);
    const lo = String.fromCharCode(0xde00);
    expect(lineCol(`${hi}x`, 2)).toEqual([1, 3]);
    expect(lineCol(`${lo}x`, 2)).toEqual([1, 3]);
    expect(lineCol(`${hi}${lo}`, 1)).toEqual([1, 2]);
    expect(lineCol(`${hi}${lo}`, 2)).toEqual([1, 2]);
  });
});
