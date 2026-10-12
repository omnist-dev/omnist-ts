// omnist-spec v0.35.0-beta, adopted in omnist-ts 0.10.0-alpha: path label
// quoting (E-36), temporal writing (E-37), negative zero (D-29, OML-19), XML
// characters and references (C-15, C-16), YAML number spellings (C-17), merge
// key order (C-12) and the YAML escapes (C-14). The vendored vectors run in
// the Track 2 runner; these pin the behaviour directly, red before green.
import { describe, expect, it } from "vitest";
import { labelSegment, childPath } from "../src/paths.js";
import { isoText, parseDatetimeToken, parseDateToken, TimeValue, timeHasOffset, timeText } from "../src/temporal.js";
import { checkJson, writeJson } from "../src/formats/json.js";
import { checkToml, writeToml } from "../src/formats/toml.js";
import { checkYaml, readYaml, writeYaml } from "../src/formats/yaml.js";
import { readXml } from "../src/formats/xml.js";
import { writeOml } from "../src/oml.js";
import type { Node } from "../src/document.js";

const BS = String.fromCharCode(92);
const leaf = (v: unknown): Node => [{ label: "a", target: v as never }];
const dt = (s: string): Date => parseDatetimeToken(s) as Date;

describe("E-36: a path label is bare unless it needs quoting", () => {
  it("keeps ordinary labels bare", () => {
    for (const l of ["name", "a b", "$", "\u00e9", "0", "a-b"]) expect(labelSegment(l)).toBe("." + l);
  });

  it("quotes the empty label and the punctuation the grammar spends", () => {
    expect(labelSegment("")).toBe('[""]');
    expect(labelSegment("a.b")).toBe('["a.b"]');
    expect(labelSegment("item[0]")).toBe('["item[0]"]');
    expect(labelSegment('q"x')).toBe('["q' + BS + '"x"]');
    expect(labelSegment("a" + BS + "b")).toBe('["a' + BS + BS + 'b"]');
  });

  it("escapes controls with the short forms and lowercase four-digit hex", () => {
    expect(labelSegment("l1\nl2")).toBe('["l1' + BS + "nl2" + '"]');
    expect(labelSegment("a\tb\rc")).toBe('["a' + BS + "tb" + BS + 'rc"]');
    expect(labelSegment("a\u001fb")).toBe('["a' + BS + 'u001fb"]');
    expect(labelSegment("a\u0000b")).toBe('["a' + BS + 'u0000b"]');
    expect(labelSegment("a\u007fb")).toBe('["a' + BS + 'u007fb"]');
    expect(labelSegment("a\u0085b")).toBe('["a' + BS + 'u0085b"]');
    expect(labelSegment("a\u2028b")).toBe('["a' + BS + 'u2028b"]');
    expect(labelSegment("a\u2029b")).toBe('["a' + BS + 'u2029b"]');
    expect(labelSegment("\u00e9.\u00fc")).toBe('["\u00e9.\u00fc"]');
  });

  it("childPath joins a segment to its parent", () => {
    expect(childPath("$", "a")).toBe("$.a");
    expect(childPath("$.a", "b.c")).toBe('$.a["b.c"]');
  });

  it("is the one renderer: a writer error names a dotted label's quoted path", () => {
    let err: unknown;
    try {
      writeToml([{ label: "a.b", target: null }]);
    } catch (e) {
      err = e;
    }
    expect((err as { path: string }).path).toBe('$["a.b"]');
  });
});

describe("E-37: temporals are written unaltered, with seconds", () => {
  it("keeps the offset, the wall clock and every fraction digit", () => {
    expect(isoText(dt("2024-01-15T12:00:00+01:00"))).toBe("2024-01-15T12:00:00+01:00");
    expect(isoText(dt("2024-01-15T12:00:00.123456+01:00"))).toBe("2024-01-15T12:00:00.123456+01:00");
    expect(isoText(dt("2024-01-15T12:00-05:30"))).toBe("2024-01-15T12:00:00-05:30");
    expect(isoText(dt("2024-01-15T12:00:00"))).toBe("2024-01-15T12:00:00");
    expect(isoText(dt("2024-01-15T12:00:00.000"))).toBe("2024-01-15T12:00:00");
    expect(isoText(dt("2024-01-15T00:00:00"))).toBe("2024-01-15T00:00:00");
  });

  it("writes a date, and an untagged instant as before", () => {
    expect(isoText(parseDateToken("2024-01-15") as Date)).toBe("2024-01-15");
    expect(isoText(new Date(Date.UTC(2024, 0, 15)))).toBe("2024-01-15");
    expect(isoText(new Date(Date.UTC(2024, 0, 15, 11, 0, 0, 250)))).toBe("2024-01-15T11:00:00.250");
  });

  it("writes a time with its seconds", () => {
    expect(timeText(new TimeValue("12:00"))).toBe("12:00:00");
    expect(timeText(new TimeValue("12:00+01:00"))).toBe("12:00:00+01:00");
    expect(timeText(new TimeValue("12:00:00.123456"))).toBe("12:00:00.123456");
    expect(timeText(new TimeValue("noon"))).toBe("noon");
    expect(timeHasOffset(new TimeValue("12:00+01:00"))).toBe(true);
    expect(timeHasOffset(new TimeValue("12:00"))).toBe(false);
  });

  it("JSON never converts to UTC and reports every temporal", () => {
    const node = leaf(dt("2024-01-15T12:00:00.123456+01:00"));
    expect(writeJson(node, { indent: null })).toBe('{"a": "2024-01-15T12:00:00.123456+01:00"}');
    expect(checkJson(leaf(new TimeValue("12:00:00"))).adjustments.map((a) => a.code)).toEqual([
      "format.temporal-stringified",
    ]);
  });

  it("TOML writes native literals with T, and stringifies an offset time", () => {
    expect(writeToml(leaf(dt("2024-01-15T12:00:00+01:00")))).toBe("a = 2024-01-15T12:00:00+01:00\n");
    expect(writeToml(leaf(dt("2024-01-15T12:00:00")))).toBe("a = 2024-01-15T12:00:00\n");
    expect(writeToml(leaf(dt("2024-01-15T12:00:00+00:00")))).toBe("a = 2024-01-15T12:00:00Z\n");
    expect(writeToml(leaf(new TimeValue("12:00")))).toBe("a = 12:00:00\n");
    expect(writeToml(leaf(new TimeValue("12:00+01:00")))).toBe('a = "12:00:00+01:00"\n');
    expect(checkToml(leaf(new TimeValue("12:00+01:00"))).adjustments.map((a) => a.code)).toEqual([
      "format.temporal-stringified",
    ]);
    expect(checkToml(leaf(new TimeValue("12:00"))).adjustments).toEqual([]);
  });

  it("YAML writes a datetime with T and no quotes, a time quoted, and reports the time", () => {
    expect(writeYaml(leaf(dt("2024-01-15T12:00:00+01:00")))).toBe("a: 2024-01-15T12:00:00+01:00\n");
    expect(writeYaml(leaf(new TimeValue("12:00:00.5")))).toBe('a: "12:00:00.5"\n');
    expect(checkYaml(leaf(new TimeValue("12:00:00"))).adjustments.map((a) => a.code)).toEqual([
      "format.temporal-stringified",
    ]);
  });

  it("OML writes the seconds and keeps the offset and fraction", () => {
    expect(writeOml(leaf(dt("2024-01-15T12:00:00.123456+01:00")), { indent: null })).toBe(
      "a: 2024-01-15T12:00:00.123456+01:00",
    );
  });
});

describe("D-29, OML-19: negative zero keeps its sign in every writer", () => {
  it("writes -0.0", () => {
    expect(writeJson(leaf(-0), { indent: null })).toBe('{"a": -0.0}');
    expect(writeOml(leaf(-0), { indent: null })).toBe("a: -0.0");
    expect(writeToml(leaf(-0))).toBe("a = -0.0\n");
    expect(writeYaml(leaf(-0))).toBe("a: -0.0\n");
  });
});

describe("C-14: YAML escapes what YAML 1.1 does not print", () => {
  it("escapes DEL, C1 controls and the noncharacters in lowercase hex", () => {
    expect(writeYaml(leaf("x\u007fy"))).toBe('a: "x' + BS + 'x7fy"\n');
    expect(writeYaml(leaf("x\u0080y"))).toBe('a: "x' + BS + 'x80y"\n');
    expect(writeYaml(leaf("x\u009fy"))).toBe('a: "x' + BS + 'x9fy"\n');
    expect(writeYaml(leaf("x\ufffey"))).toBe('a: "x' + BS + 'ufffey"\n');
    expect(writeYaml(leaf("x\uffffy"))).toBe('a: "x' + BS + 'uffffy"\n');
  });
});

describe("C-17: YAML number spellings", () => {
  const read = (text: string): unknown => (readYaml(text) as { target: unknown }[])[0]?.target;

  it("reads these as strings", () => {
    for (const s of ["08", "09", "0:5", "1e3", "1.0e3", "0o17", "1e+3", ".", "-.5", "+.5", "+.5e+3", "._5", "+._5"]) expect(read("a: " + s)).toBe(s);
  });

  it("reads these as numbers", () => {
    expect(read("a: 0")).toBe(0n);
    expect(read("a: 010")).toBe(8n);
    expect(read("a: 1_000")).toBe(1000n);
    expect(read("a: 190:20:30")).toBe(685230n);
    expect(read("a: 5.")).toBe(5);
    expect(read("a: .5")).toBe(0.5);
    expect(read("a: 1.0e+3")).toBe(1000);
    expect(read("a: 1:30.5")).toBe(90.5);
    expect(read("a: .inf")).toBe(Infinity);
    expect(Number.isNaN(read("a: .nan"))).toBe(true);
  });
});

describe("C-17: the writer spells an exponent so it reads back as a number", () => {
  it("writes 1.0e-300, not 1e-300", () => {
    expect(writeYaml(leaf(1e-300))).toBe("a: 1.0e-300\n");
    expect(writeYaml(leaf(1e21))).toBe("a: 1.0e+21\n");
    expect(writeYaml(leaf(1.5e300))).toBe("a: 1.5e+300\n");
    expect(readYaml("a: 1.0e-300")).toEqual([{ label: "a", target: 1e-300 }]);
  });
});

describe("C-12: a merge key contributes first, wherever it is written", () => {
  it("places merged entries before the mapping's own, an own key overriding in place", () => {
    const node = readYaml("a: &a {x: 1, k: a}\nc:\n  p: 0\n  <<: *a\n  k: own\n  q: 9\n") as {
      label: string;
      target: { label: string; target: unknown }[];
    }[];
    const c = node.find((e) => e.label === "c")?.target ?? [];
    expect(c.map((e) => e.label)).toEqual(["x", "k", "p", "q"]);
    expect(c[1]?.target).toBe("own");
  });
});

describe("C-16: XML characters and references", () => {
  const fails = (xml: string): boolean => {
    try {
      readXml(xml);
      return false;
    } catch (e) {
      expect((e as { code: string }).code).toBe("parse.codec-syntax");
      return true;
    }
  };

  it("decodes entities exactly once", () => {
    expect(readXml("<r>&amp;#65;</r>")).toEqual([{ label: "r", target: "&#65;" }]);
    expect(readXml("<r>&amp;lt;</r>")).toEqual([{ label: "r", target: "&lt;" }]);
    expect(readXml("<r>&#65;&#x42;&#x10FFFF;&#9;</r>")).toEqual([{ label: "r", target: "AB\u{10ffff}\t" }]);
    expect(readXml("<r>&#x0000000041;</r>")).toEqual([{ label: "r", target: "A" }]);
  });

  it("reads a CDATA section literally and alongside text", () => {
    expect(readXml("<r><![CDATA[&#65;<&amp;]]></r>")).toEqual([{ label: "r", target: "&#65;<&amp;" }]);
    expect(readXml("<r>a<![CDATA[b]]>&amp;c</r>")).toEqual([{ label: "r", target: "ab&c" }]);
    expect(readXml("<r><![CDATA[]]></r>")).toEqual([{ label: "r", target: "" }]);
  });

  it("refuses a reference outside Char or malformed, without crashing", () => {
    for (const ref of ["&#0;", "&#1;", "&#xB;", "&#xD800;", "&#55296;", "&#xFFFE;", "&#xFFFF;", "&#x110000;", "&#1114112;"]) {
      expect(fails("<r>" + ref + "</r>")).toBe(true);
    }
    for (const ref of ["&#;", "&#x;", "&#65", "&#X41;", "&#99999999999999999999;", "&#x" + "F".repeat(400) + ";"]) {
      expect(fails("<r>" + ref + "</r>")).toBe(true);
    }
    expect(fails('<r a="&#1;"/>')).toBe(true);
  });

  it("refuses a raw character outside Char anywhere", () => {
    for (const ch of ["\u0000", "\u0001", "\u000b", "\u000c", "\u001f", "\ufffe", "\uffff"]) {
      expect(fails("<r>a" + ch + "b</r>")).toBe(true);
      expect(fails("<r><![CDATA[" + ch + "]]></r>")).toBe(true);
      expect(fails("<r><!-- " + ch + " -->x</r>")).toBe(true);
      expect(fails('<r a="' + ch + '"/>')).toBe(true);
      expect(fails("<r><?pi " + ch + "?>x</r>")).toBe(true);
    }
  });

  it("treats a reference inside a comment or CDATA section as literal text", () => {
    expect(readXml("<r><!-- &#0; -->x</r>")).toEqual([{ label: "r", target: "x" }]);
    expect(readXml("<r><![CDATA[&#0;]]></r>")).toEqual([{ label: "r", target: "&#0;" }]);
  });
});
