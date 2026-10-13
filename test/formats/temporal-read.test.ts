import { describe, expect, it } from "vitest";
import { readYaml, writeYaml } from "../../src/formats/yaml.js";
import { readToml, writeToml } from "../../src/formats/toml.js";
import { readJson, writeJson } from "../../src/formats/json.js";
import { readXml } from "../../src/formats/xml.js";
import { readOml, writeOml } from "../../src/oml.js";
import { parseSchema } from "../../src/osd.js";
import type { ParseError } from "../../src/errors.js";

// E-37, omnist-ts#169 (a) and (b): a reader never alters a temporal value. Every
// reader keeps the clock reading, the offset and every fraction digit the
// Document can hold (six), or fails with a coded diagnostic.

const jsonOf = (node: unknown): string => writeJson(node as never, { indent: null });
// Trailing zeros of a fraction are insignificant (E-37): `.100` is `.1`.
const fracNorm = (v: string): string => v.replace(/(\.\d*?)0+(?=[+-]\d\d:\d\d$|Z$|$)/, "$1").replace(/\.(?=[+-]|Z|$)/, "");
const valueOf = (text: string): string => fracNorm((JSON.parse(text) as { a: string }).a);

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as ParseError).code;
  }
  return undefined;
}

const DATETIMES = [
  "2024-01-15T12:00:00+01:00",
  "2024-01-15T12:00:00-05:30",
  "2024-01-15T12:00:00.1+01:00",
  "2024-01-15T12:00:00.12+01:00",
  "2024-01-15T12:00:00.123+01:00",
  "2024-01-15T12:00:00.1234+01:00",
  "2024-01-15T12:00:00.12345+01:00",
  "2024-01-15T12:00:00.123456+01:00",
  "2024-01-15T12:00:00.123456",
  "2024-01-15T23:59:59.999999-12:00",
];

describe("YAML keeps the offset and every fraction digit", () => {
  it.each(DATETIMES)("%s", (v) => {
    expect(valueOf(jsonOf(readYaml("a: " + v + "\n")))).toBe(fracNorm(v));
  });

  it("reads Z as the offset +00:00, not as an instant with the offset dropped", () => {
    expect(valueOf(jsonOf(readYaml("a: 2024-01-15T12:00:00.123456Z\n")))).toBe("2024-01-15T12:00:00.123456+00:00");
  });

  it("reads the library's looser spellings with the same value", () => {
    expect(valueOf(jsonOf(readYaml("a: 2024-01-15 1:2:3 -5\n")))).toBe("2024-01-15T01:02:03-05:00");
    expect(valueOf(jsonOf(readYaml("a: 2024-1-5t12:00:00.5 +5:30\n")))).toBe("2024-01-05T12:00:00.5+05:30");
    expect(valueOf(jsonOf(readYaml("a: 2024-01-15 12:00:00.250\n")))).toBe("2024-01-15T12:00:00.25");
  });

  it("a date stays a date", () => {
    expect(valueOf(jsonOf(readYaml("a: 2024-01-15\n")))).toBe("2024-01-15");
  });

  it("a fraction that cannot be held exactly is a coded diagnostic, never rounded", () => {
    expect(codeOf(() => readYaml("a: 2024-01-15T12:00:00.1234567Z\n"))).toBe("parse.codec-syntax");
    expect(codeOf(() => readYaml("a: 2024-01-15T12:00:00.123456789+01:00\n"))).toBe("parse.codec-syntax");
    // Trailing zeros are insignificant: seven digits with the last zero are exact.
    expect(valueOf(jsonOf(readYaml("a: 2024-01-15T12:00:00.1234560Z\n")))).toBe("2024-01-15T12:00:00.123456+00:00");
  });

  it("an hour, minute, second, offset or date out of range is a coded diagnostic, not rolled over", () => {
    for (const bad of ["2024-01-15T25:00:00", "2024-01-15T12:61:00", "2024-01-15T12:00:61", "2024-01-15T12:00:00 +29", "2024-02-30", "2023-02-29"]) {
      expect(codeOf(() => readYaml("a: " + bad + "\n")), bad).toBe("parse.codec-syntax");
    }
  });

  it("round-trips through the YAML, TOML and OML writers", () => {
    for (const v of DATETIMES) {
      const node = readYaml("a: " + v + "\n");
      expect(valueOf(jsonOf(readYaml(writeYaml(node))))).toBe(fracNorm(v));
      expect(valueOf(jsonOf(readOml(writeOml(node))))).toBe(fracNorm(v));
      expect(valueOf(jsonOf(readToml(writeToml(node))))).toBe(fracNorm(v));
    }
  });
});

describe("TOML keeps every fraction digit", () => {
  it.each(DATETIMES)("%s", (v) => {
    expect(valueOf(jsonOf(readToml("a = " + v + "\n")))).toBe(fracNorm(v));
  });

  it("keeps a local time's fraction", () => {
    for (const t of ["12:00:00.1", "12:00:00.1234", "12:00:00.123456", "23:59:59.999999"]) {
      expect(valueOf(jsonOf(readToml("a = " + t + "\n")))).toBe(fracNorm(t));
    }
  });

  it("reads Z as +00:00 and a space separator as T", () => {
    expect(valueOf(jsonOf(readToml("a = 2024-01-15 12:00:00.123456Z\n")))).toBe("2024-01-15T12:00:00.123456+00:00");
  });

  it("a fraction of only zeros is no fraction", () => {
    expect(valueOf(jsonOf(readToml("a = 2024-01-15T12:00:00.0000+01:00\n")))).toBe("2024-01-15T12:00:00+01:00");
    expect(valueOf(jsonOf(readToml("a = 12:00:00.00000\n")))).toBe("12:00:00");
  });

  it("a fraction that cannot be held exactly is a coded diagnostic, never rounded", () => {
    expect(codeOf(() => readToml("a = 2024-01-15T12:00:00.1234567Z\n"))).toBe("parse.codec-syntax");
    expect(codeOf(() => readToml("a = 12:00:00.123456789\n"))).toBe("parse.codec-syntax");
    expect(valueOf(jsonOf(readToml("a = 12:00:00.1234560\n")))).toBe("12:00:00.123456");
  });

  it("an out-of-range field in a long-fraction literal is a coded diagnostic", () => {
    for (const bad of ["25:00:00.1234", "12:61:00.1234", "2024-02-30T12:00:00.1234Z", "2024-01-15T12:00:00.1234+25:00"]) {
      expect(codeOf(() => readToml("a = " + bad + "\n")), bad).toBe("parse.codec-syntax");
    }
  });

  it("a long-fraction literal where a key goes is a syntax error", () => {
    expect(codeOf(() => readToml("12:00:00.1234 = 1\n"))).toBe("parse.codec-syntax");
    expect(codeOf(() => readToml("a = 1\n2024-01-15T12:00:00.1234Z = 1\n"))).toBe("parse.codec-syntax");
  });

  it("literal text that only looks like one is left alone", () => {
    const text = [
      "# 12:00:00.1234567 in a comment",
      "a = '12:00:00.1234567'",
      'b = "2024-01-15T12:00:00.1234567Z"',
      "c = '''",
      "12:00:00.1234567",
      "'''",
      'd = """',
      "12:00:00.1234567 \\",
      '"""',
      "e = 1 # 12:00:00.1234567",
    ].join("\n");
    const out = JSON.parse(jsonOf(readToml(text))) as Record<string, unknown>;
    expect(out.a).toBe("12:00:00.1234567");
    expect(out.b).toBe("2024-01-15T12:00:00.1234567Z");
    expect(out.c).toBe("12:00:00.1234567\n");
    expect(out.e).toBe(1n === out.e ? 1n : 1);
  });

  it("a value that looks like the placeholder is not mistaken for one", () => {
    const text = 'a = "omnist-frac-0-0-x"\nb = 12:00:00.1234\nc = "omnist-frac-1-0-x"\n';
    const out = JSON.parse(jsonOf(readToml(text))) as Record<string, string>;
    expect(out.a).toBe("omnist-frac-0-0-x");
    expect(out.b).toBe("12:00:00.1234");
    expect(out.c).toBe("omnist-frac-1-0-x");
  });

  it("round-trips through the TOML writer", () => {
    for (const v of DATETIMES) {
      expect(valueOf(jsonOf(readToml(writeToml(readToml("a = " + v + "\n")))))).toBe(fracNorm(v));
    }
  });
});

describe("JSON, XML and OML keep a temporal value too (cross-port check 1)", () => {
  const schema = parseSchema('record R { "a": datetime } root R');
  const xmlSchema = parseSchema('record R { "a": datetime } record W { "R": R } root W');
  it.each(DATETIMES)("%s", (v) => {
    expect(valueOf(jsonOf(readJson(JSON.stringify({ a: v }), { schema })))).toBe(fracNorm(v));
    const viaXml = JSON.parse(jsonOf(readXml("<R><a>" + v + "</a></R>", { schema: xmlSchema }))) as { R: { a: string } };
    expect(fracNorm(viaXml.R.a)).toBe(fracNorm(v));
    expect(valueOf(jsonOf(readOml("a: " + v + "\n")))).toBe(fracNorm(v));
  });

  it("OML rejects a fraction of seven digits instead of altering it", () => {
    expect(codeOf(() => readOml("a: 2024-01-15T12:00:00.1234567Z\n"))).toBeDefined();
  });

  it("a schema-directed read refuses seven fraction digits instead of altering them", () => {
    expect(() => readJson('{"a":"2024-01-15T12:00:00.1234567Z"}', { schema })).toThrow();
  });
});
