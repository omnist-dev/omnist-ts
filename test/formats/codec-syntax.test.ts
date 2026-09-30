/**
 * E-31 / E-11 / DIV-8: every JSON, YAML, TOML and XML SYNTAX error is
 * `parse.codec-syntax` with a real `line:col` inside the input, in the
 * library (ParseError code/path) and in the CLI `--json` `errors` array.
 * Which character is blamed is the library's; these tests pin only the code,
 * the well-formedness and bound of the position, and a few exact values where
 * the library's report is unambiguous.
 */
import { describe, expect, it } from "vitest";
import { main } from "../../src/cli.js";
import { ParseError } from "../../src/errors.js";
import { codecSyntaxError } from "../../src/formats/codec-error.js";
import { readJson } from "../../src/formats/json.js";
import { readToml } from "../../src/formats/toml.js";
import { readXml } from "../../src/formats/xml.js";
import { readYaml } from "../../src/formats/yaml.js";
import { isWellFormedPosition } from "../../tools/conformance/vectorRunner.js";

type Reader = (text: string) => unknown;
const READERS: Record<string, Reader> = { json: readJson, yaml: readYaml, toml: readToml, xml: readXml };

const ASTRAL = String.fromCodePoint(0x1f600);

const CASES: [string, string, string][] = [
  ["json", "missing value", '{"a": }'],
  ["json", "trailing comma", '{"a":1,}'],
  ["json", "bare word", "tru"],
  ["json", "unterminated string", '{"a":"x'],
  ["json", "empty input", ""],
  ["json", "multi-line", '{\n  "a": 1,\n  "b" 2\n}'],
  ["json", "multi-byte before the error", `{"${ASTRAL}": 1,\n "é" }`],
  ["yaml", "nested mapping value", "a: b: c"],
  ["yaml", "bad indentation", "a:\n  b: 1\n c: 2"],
  ["yaml", "tab indentation", "\ta: 1"],
  ["yaml", "unresolved alias", "a: *nope"],
  ["yaml", "multi-byte before the error", `k: ${ASTRAL}\nb: c: d`],
  ["toml", "key without value", "a = "],
  ["toml", "bad table header", "[a"],
  ["toml", "duplicate key", "a = 1\na = 2"],
  ["toml", "duplicate table, multi-line", "[t]\n[t]"],
  ["toml", "multi-byte before the error", `a = "${ASTRAL}\n`],
  ["xml", "mismatched closing tag", "<a><b></a>"],
  ["xml", "unclosed tag", "<a>"],
  ["xml", "attribute without value", "<a b=1/>"],
  ["xml", "empty input", ""],
  ["xml", "multiple roots", "<a></a><b/>"],
  ["xml", "multi-line", "<a>\n<b>\n</a>"],
  ["xml", "multi-byte before the error", `<a>${ASTRAL}</x>`],
];

function thrown(format: string, text: string): ParseError {
  try {
    (READERS[format] as Reader)(text);
  } catch (e) {
    return e as ParseError;
  }
  throw new Error(`${format} accepted ${JSON.stringify(text)}`);
}

describe("codec syntax errors carry parse.codec-syntax and a real position", () => {
  it.each(CASES)("%s: %s", (format, _name, text) => {
    const e = thrown(format, text);
    expect(e).toBeInstanceOf(ParseError);
    expect(e.code).toBe("parse.codec-syntax");
    expect(e.path).not.toBe("0:0");
    expect(isWellFormedPosition(e.path, text)).toBe(true);
    expect(e.message).toContain(`line ${(e.path as string).replace(":", ", col ")}:`);
  });

  it("a multi-byte character before the error does not shift the column (code points, E-28)", () => {
    // YAML blames by offset and TOML by a UTF-16 column: both are converted.
    expect(thrown("yaml", `${ASTRAL}: a: b`).path).toBe(thrown("yaml", "x: a: b").path);
    expect(thrown("toml", `a = "${ASTRAL}\n`).path).toBe(thrown("toml", 'a = "x\n').path);
    expect(thrown("xml", `<a>${ASTRAL}</x>`).path).toBe(thrown("xml", "<a>x</x>").path);
    expect(thrown("json", `{"${ASTRAL}":1,}`).path).toBe("1:8");
  });

  it("reports where each library blames on a multi-line input", () => {
    expect(thrown("yaml", "a: b: c").path).toBe("1:4");
    expect(thrown("yaml", "a:\n  b: 1\n c: 2").path).toBe("3:1");
    expect(thrown("toml", "[t]\n[t]").path).toBe("2:2");
    expect(thrown("xml", "<a>\n<b>\n</a>").path).toBe("3:1");
    expect(thrown("json", '{"a":1,}').path).toBe("1:8");
  });

  it("uses 1:1 where the library names no position", () => {
    expect(thrown("yaml", "a: *nope").path).toBe("1:1");
    expect(thrown("xml", "<a></a><b/>").path).toBe("1:1");
  });

  it("a JSON error at end of input stands at the end", () => {
    expect(thrown("json", '{"a":1').path).toBe("1:7");
    expect(thrown("json", "tru").path).toBe("1:4");
  });

  it("duplicate YAML anchors are not a read error", () => {
    expect(() => readYaml("a: &x 1\nb: &x 2")).not.toThrow();
  });

  it("does not change D-21's fixed 1:1, nor non-syntax refusals", () => {
    const BOM = String.fromCharCode(0xfeff);
    expect(thrown("json", BOM + BOM + "{}").path).toBe("1:1");
    expect(thrown("xml", "<!DOCTYPE a><a/>").code).toBe("format.dtd-forbidden");
  });
});

describe("codecSyntaxError position resolution", () => {
  it("clamps out-of-range blame into the input", () => {
    expect(codecSyntaxError("X", "m", "ab", { offset: 99 }).path).toBe("1:3");
    expect(codecSyntaxError("X", "m", "ab", { offset: -5 }).path).toBe("1:1");
    expect(codecSyntaxError("X", "m", "ab\ncd", { line: 9, col: 1 }).path).toBe("2:3");
    expect(codecSyntaxError("X", "m", "ab\ncd", { line: 1, col: 99 }).path).toBe("1:3");
    expect(codecSyntaxError("X", "m", "ab\ncd", { line: 2 }).path).toBe("2:1");
    expect(codecSyntaxError("X", "m", "ab\ncd", { line: 2, col: 0 }).path).toBe("2:1");
    expect(codecSyntaxError("X", "m", "ab\ncd").path).toBe("1:1");
  });
});

function runCli(argv: string[], stdin: string): { code: number; out: string } {
  const out: string[] = [];
  const sink = (buf: string[]): NodeJS.WritableStream =>
    ({ write: (c: unknown) => (buf.push(String(c)), true) }) as unknown as NodeJS.WritableStream;
  const code = main(argv, { stdout: sink(out), stderr: sink([]), stdin });
  return { code, out: out.join("") };
}

describe("CLI --json surfaces the codec syntax code and position", () => {
  it.each(CASES)("%s: %s", (format, _name, text) => {
    const lib = thrown(format, text);
    const { code, out } = runCli(["convert", "--from", format, "--to", "oml", "-", "--json"], text);
    expect(code).toBe(2);
    const payload = JSON.parse(out) as { ok: boolean; errors: { path: string; code: string; message: string }[] };
    expect(payload.ok).toBe(false);
    expect(payload.errors).toHaveLength(1);
    expect(payload.errors[0]?.code).toBe("parse.codec-syntax");
    expect(payload.errors[0]?.path).toBe(lib.path);
    expect(isWellFormedPosition(payload.errors[0]?.path, text)).toBe(true);
  });

  it("the human message names the position", () => {
    const err: string[] = [];
    const sink = { write: (c: unknown) => (err.push(String(c)), true) } as unknown as NodeJS.WritableStream;
    const code = main(["convert", "--from", "yaml", "--to", "oml", "-"], {
      stdout: { write: () => true } as unknown as NodeJS.WritableStream,
      stderr: sink,
      stdin: "a: b: c",
    });
    expect(code).toBe(2);
    expect(err.join("")).toContain("line 1, col 4");
  });
});
