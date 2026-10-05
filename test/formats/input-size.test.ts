import { describe, expect, it } from "vitest";
import { ParseError } from "../../src/errors.js";
import {
  DEFAULT_MAX_INPUT_BYTES,
  INPUT_SIZE_CODE,
  checkInputSize,
  resolveMaxInputBytes,
  utf8Length,
} from "../../src/formats/input-size.js";
import { readJson } from "../../src/formats/json.js";
import { readYaml } from "../../src/formats/yaml.js";
import { readToml } from "../../src/formats/toml.js";
import { readXml } from "../../src/formats/xml.js";
import { readOml } from "../../src/oml.js";
import { readFormat, registerFormat } from "../../src/registry.js";
import "../../src/index.js";

// omnist-spec v0.30.0-beta D-23..D-26 (Sec2.4.2): a reader refuses an input of
// more than the maximum number of BYTES with `document.limit.input-size` at
// `$`, accepts one of exactly that many, counts the bytes before the BOM is
// stripped and before any decoding or parsing. Replaces issue #110's coarse
// 256 MiB UTF-16-unit guard. Non-ASCII is written as \u{...} escapes so the
// source stays plain ASCII (an invisible literal BOM would be unreadable).

const BOM = "\u{feff}";
const E_ACUTE = "\u{e9}"; // two bytes
const EURO = "\u{20ac}"; // three bytes
const GRIN = "\u{1F600}"; // an astral character: four bytes

function refusal(fn: () => unknown): ParseError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ParseError);
    return e as ParseError;
  }
  throw new Error("expected a refusal, got a result");
}

describe("DEFAULT_MAX_INPUT_BYTES", () => {
  it("is 64 MiB", () => {
    expect(DEFAULT_MAX_INPUT_BYTES).toBe(64 * 1024 * 1024);
    expect(DEFAULT_MAX_INPUT_BYTES).toBe(67_108_864);
  });
});

describe("utf8Length", () => {
  const cases: Array<[string, string, number]> = [
    ["empty", "", 0],
    ["ASCII", "abc", 3],
    ["two-byte (e acute)", E_ACUTE, 2],
    ["two-byte boundary U+07FF", "\u{7ff}", 2],
    ["three-byte boundary U+0800", "\u{800}", 3],
    ["three-byte (euro sign)", EURO, 3],
    ["the BOM", BOM, 3],
    ["an astral pair is four bytes", GRIN, 4],
    ["a lone high surrogate is three", "a\u{d800}b", 5],
    ["a lone high surrogate at the end is three", "a\u{d800}", 4],
    ["a lone low surrogate is three", "\u{dc00}", 3],
    ["a high surrogate followed by a non-low unit", "\u{d800}a", 4],
    ["a reversed pair is two lone surrogates", "\u{dc00}\u{d800}", 6],
    ["mixed", "a" + E_ACUTE + EURO + GRIN, 1 + 2 + 3 + 4],
  ];
  it.each(cases)("%s", (_name, text, bytes) => {
    expect(utf8Length(text)).toBe(bytes);
    // Cross-check against the platform encoder wherever the text is well formed.
    const hasLone = Array.from(text).some((ch) => ch.length === 1 && ch.charCodeAt(0) >= 0xd800 && ch.charCodeAt(0) <= 0xdfff);
    if (!hasLone) expect(utf8Length(text)).toBe(new TextEncoder().encode(text).length);
  });
});

describe("resolveMaxInputBytes", () => {
  it("undefined selects the default", () => {
    expect(resolveMaxInputBytes(undefined)).toBe(DEFAULT_MAX_INPUT_BYTES);
  });
  it("a positive safe integer is used as given", () => {
    expect(resolveMaxInputBytes(1)).toBe(1);
    expect(resolveMaxInputBytes(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });
  const bad: Array<[string, unknown]> = [
    ["zero", 0],
    ["a negative number", -1],
    ["a fraction", 1.5],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["a number beyond the safe range", 2 ** 53],
    ["a string", "10"],
    ["null", null],
  ];
  it.each(bad)("refuses %s with a RangeError (never 'no limit')", (_name, value) => {
    expect(() => resolveMaxInputBytes(value as number)).toThrow(RangeError);
    expect(() => resolveMaxInputBytes(value as number)).toThrow(/maxInputBytes must be an integer of at least 1/);
  });
});

describe("checkInputSize (D-23)", () => {
  const cases: Array<[string, string, number, boolean]> = [
    ["ASCII exactly at the maximum is accepted", "x".repeat(20), 20, false],
    ["ASCII one byte over is refused", "x".repeat(21), 20, true],
    ["a multi-byte string at the maximum in bytes is accepted", E_ACUTE.repeat(10), 20, false],
    ["the same string counts bytes, not characters: 10 chars, 20 bytes, max 19", E_ACUTE.repeat(10), 19, true],
    ["more characters than the maximum is refused without counting", E_ACUTE.repeat(25), 20, true],
    ["a BOM counts three bytes: at the maximum", BOM + "x".repeat(17), 20, false],
    ["a BOM counts three bytes: one over", BOM + "x".repeat(18), 20, true],
    ["an astral character counts four bytes: at the maximum", GRIN.repeat(5), 20, false],
    ["an astral character counts four bytes: one over", GRIN.repeat(5) + "x", 20, true],
    ["a lone surrogate counts three bytes", "\u{d800}".repeat(7), 20, true],
    ["a maximum of one admits a single byte", "x", 1, false],
    ["a maximum of one refuses two", "xx", 1, true],
    ["an empty input is always accepted", "", 1, false],
    ["a short string under a third of the maximum is accepted without counting", EURO.repeat(3), 100, false],
  ];
  it.each(cases)("%s", (_name, text, max, over) => {
    if (over) {
      const e = refusal(() => checkInputSize(text, max));
      expect(e.code).toBe(INPUT_SIZE_CODE);
      expect(e.path).toBe("$");
      expect(e.message).toBe(
        `input exceeds the maximum input size (${max} bytes); pass maxInputBytes to raise it`,
      );
    } else {
      expect(() => checkInputSize(text, max)).not.toThrow();
    }
  });

  it("the refusal says how to raise the limit, and a caller may supply its own hint", () => {
    expect(refusal(() => checkInputSize("xx", 1)).message).toContain("pass maxInputBytes to raise it");
    expect(refusal(() => checkInputSize("xx", 1, "use --max-input-bytes to raise it")).message).toContain(
      "use --max-input-bytes to raise it",
    );
  });

  it("uses the default maximum when none is given: 64 MiB accepted, one byte over refused", () => {
    expect(() => checkInputSize("x".repeat(DEFAULT_MAX_INPUT_BYTES), undefined)).not.toThrow();
    const e = refusal(() => checkInputSize("x".repeat(DEFAULT_MAX_INPUT_BYTES + 1), undefined));
    expect(e.code).toBe(INPUT_SIZE_CODE);
    expect(e.message).toContain("67108864 bytes");
  });

  it("validates the maximum before it looks at the text", () => {
    expect(() => checkInputSize("x", 0)).toThrow(RangeError);
  });
});

// Every reader, at the maximum and one byte over, with the same input shape the
// vectors use; the BOM, multi-byte and malformed-input cases follow.
type Reader = (text: string, opts?: { maxInputBytes?: number }) => unknown;
const READERS: Array<[string, Reader, string]> = [
  ["readJson", readJson as Reader, '{"a":"xxxxxxxxxxxx"}'], // 20 bytes
  ["readYaml", readYaml as Reader, "a: xxxxxxxxxxxxxxxx\n"], // 20 bytes
  ["readToml", readToml as Reader, 'a = "xxxxxxxxxxx"\n'], // 16 bytes
  ["readXml", readXml as Reader, "<a>xxxxxxxxxxxx</a>"], // 19 bytes
  ["readOml", readOml as Reader, 'a: "xxxxxxxxxxxx"\n'], // 16 bytes
];

describe.each(READERS)("%s honours maxInputBytes (D-23)", (_name, read, text) => {
  const size = utf8Length(text);

  it("accepts an input of exactly the maximum", () => {
    expect(() => read(text, { maxInputBytes: size })).not.toThrow();
  });

  it("refuses an input one byte over with document.limit.input-size at $", () => {
    const e = refusal(() => read(text, { maxInputBytes: size - 1 }));
    expect(e.code).toBe(INPUT_SIZE_CODE);
    expect(e.path).toBe("$");
    expect(e.message).toContain(`${size - 1} bytes`);
  });

  it("counts a leading BOM's three bytes, before it is stripped", () => {
    expect(() => read(BOM + text, { maxInputBytes: size + 3 })).not.toThrow();
    expect(refusal(() => read(BOM + text, { maxInputBytes: size + 2 })).code).toBe(INPUT_SIZE_CODE);
  });

  it("checks the size BEFORE parsing: an over-limit malformed input is a size refusal", () => {
    const e = refusal(() => read("{[ not valid <<< ", { maxInputBytes: 5 }));
    expect(e.code).toBe(INPUT_SIZE_CODE);
  });

  it("checks the size before the second-BOM check too", () => {
    const e = refusal(() => read(BOM + BOM + text, { maxInputBytes: 5 }));
    expect(e.code).toBe(INPUT_SIZE_CODE);
  });

  it("an invalid maximum is a RangeError, not a parse result", () => {
    expect(() => read(text, { maxInputBytes: 0 })).toThrow(RangeError);
    expect(() => read(text, { maxInputBytes: 1.5 })).toThrow(RangeError);
  });

  it("applies the default (64 MiB) when no maximum is given", () => {
    expect(() => read(text)).not.toThrow();
    expect(() => read(text, {})).not.toThrow();
  });
});

describe("readers count bytes, not characters", () => {
  it("a multi-byte JSON string: 7 e-acutes are 14 bytes, 15 characters in all", () => {
    const text = '{"a":"' + E_ACUTE.repeat(7) + '"}'; // 6 + 14 + 2 = 22 bytes
    expect(text.length).toBe(15);
    expect(utf8Length(text)).toBe(22);
    expect(() => readJson(text, { maxInputBytes: 22 })).not.toThrow();
    expect(refusal(() => readJson(text, { maxInputBytes: 21 })).code).toBe(INPUT_SIZE_CODE);
    expect(refusal(() => readJson(text, { maxInputBytes: 15 })).code).toBe(INPUT_SIZE_CODE);
  });
});

// The check runs before the library does, so a huge input is refused without
// ever being parsed -- the ordering claim of issue #110.
describe("readers refuse an over-default input without parsing it", () => {
  const oversized = "x".repeat(DEFAULT_MAX_INPUT_BYTES + 1);

  const cases: Array<[string, () => unknown]> = [
    ["readJson", () => readJson('"' + oversized + '"')],
    ["readYaml", () => readYaml(oversized)],
    ["readToml", () => readToml('a = "' + oversized + '"')],
    ["readXml", () => readXml("<a>" + oversized + "</a>")],
    ["readOml", () => readOml('a: "' + oversized + '"')],
  ];
  it.each(cases)("%s", (_name, fn) => {
    const start = Date.now();
    const e = refusal(fn);
    expect(e.code).toBe(INPUT_SIZE_CODE);
    expect(Date.now() - start).toBeLessThan(5000);
  });
});

// The cap must not refuse a legitimate document: XML's tag-per-node encoding is
// the most verbose of the five formats, so it is the tightest fit.
describe("the default stays well above a legitimate MAX_NODES-sized document", () => {
  it("a 1,000,000-leaf-element XML document is well under half the default", () => {
    const text = "<r>" + "<a>0</a>".repeat(1_000_000) + "</r>";
    expect(utf8Length(text)).toBeLessThan(DEFAULT_MAX_INPUT_BYTES / 2);
  });
});

describe("readFormat (the registry entry point)", () => {
  it("reads with a built-in format and passes maxInputBytes through", () => {
    expect(() => readFormat("json", '{"a":1}', { maxInputBytes: 7 })).not.toThrow();
    expect(refusal(() => readFormat("json", '{"a":1}', { maxInputBytes: 6 })).code).toBe(INPUT_SIZE_CODE);
  });

  it("uses the default maximum when no options are given", () => {
    expect(readFormat("oml", "a: 1\n")).toEqual([{ label: "a", target: 1n }]);
  });

  it("bounds a plugin reader that ignores the option, before it runs", () => {
    let ran = false;
    registerFormat({
      name: "size-plugin",
      read: () => {
        ran = true;
        return [];
      },
      write: () => "",
    });
    expect(refusal(() => readFormat("size-plugin", "abcdef", { maxInputBytes: 5 })).code).toBe(INPUT_SIZE_CODE);
    expect(ran).toBe(false);
    expect(readFormat("size-plugin", "abcde", { maxInputBytes: 5 })).toEqual([]);
    expect(ran).toBe(true);
  });

  it("an unknown format is still an OmnistError", () => {
    expect(() => readFormat("no-such-format", "x")).toThrow(/unknown format/);
  });
});
