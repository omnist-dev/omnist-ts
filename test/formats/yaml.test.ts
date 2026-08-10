import { describe, expect, it } from "vitest";
import { doc } from "../../src/document.js";
import { ParseError, WriteError, DocumentError } from "../../src/errors.js";
import { WriteReport } from "../../src/report.js";
import { readYaml, writeYaml, checkYaml } from "../../src/formats/yaml.js";
import { TimeValue } from "../../src/temporal.js";

describe("readYaml", () => {
  it("does not flag a plain scalar whose trailing digit run merely happens to be long (issue #64 review finding)", () => {
    const longDigits = "4".repeat(4301);
    // A plain-scalar value like an id/hash/token ending in a long digit
    // run is not a numeric literal -- must not be flagged as an oversized
    // integer just because its tail looks like one.
    expect(() => readYaml("a: abc" + longDigits)).not.toThrow();
    // A short key with a long word+digits value, same idea.
    expect(() => readYaml("key: id" + longDigits)).not.toThrow();
    // A genuine oversized integer, not glued to a word, must still throw.
    expect(() => readYaml("a: " + longDigits)).toThrow(ParseError);
    // A genuine oversized negative integer must still throw too.
    expect(() => readYaml("a: -" + longDigits)).toThrow(ParseError);
  });

  it("parses a YAML mapping into a Document node", () => {
    const node = readYaml("a: 1\nb:\n  - 1\n  - 2\n");
    expect(node).toEqual(doc({ a: 1, b: [1, 2] }).toData());
  });

  it("raises ParseError on invalid YAML", () => {
    expect(() => readYaml("a: [1, 2\n")).toThrow(ParseError);
    expect(() => readYaml("a: [1, 2\n")).toThrow(/invalid YAML/);
  });

  it("natively parses an unquoted ISO date scalar into a Date, no schema needed", () => {
    const node = readYaml("d: 2024-01-01");
    const edges = node as { label: string; target: unknown }[];
    expect(edges[0]?.target).toBeInstanceOf(Date);
    expect((edges[0]?.target as Date).toISOString()).toBe("2024-01-01T00:00:00.000Z");
  });

  it("natively parses an unquoted ISO datetime scalar into a Date", () => {
    const node = readYaml("dt: 2024-01-01T12:00:00");
    const edges = node as { label: string; target: unknown }[];
    expect((edges[0]?.target as Date).toISOString()).toBe("2024-01-01T12:00:00.000Z");
  });

  it("a bare time-of-day resolves to YAML 1.1's sexagesimal integer, not a time type", () => {
    const node = readYaml("t: 12:00:00");
    const edges = node as { label: string; target: unknown }[];
    expect(edges[0]?.target).toBe(43200);
  });

  it("YAML 1.1 boolean coercion turns a bare on/off/yes/no scalar into a boolean", () => {
    const node = readYaml("a: on\nb: off\nc: yes\nd: no\n");
    expect(node).toEqual(doc({ a: true, b: false, c: true, d: false }).toData());
  });

  it("issue #89 vector 1: a bare 'n' key is not a boolean alias, unlike full-word aliases like on/off/yes/no (reference resolver only treats full-word aliases, not bare y/n, as booleans)", () => {
    const node = readYaml("n: 12:00:00\n");
    const edges = node as { label: string; target: unknown }[];
    expect(edges[0]?.label).toBe("n");
    expect(edges[0]?.target).toBe(43200);
  });

  it("issue #89 vector 2 (the Norway problem): a bare 'on' key resolves to boolean true and MUST reject the document, not silently coerce to the label \"true\"", () => {
    expect(() => readYaml("on:\n  push: true\n")).toThrow(DocumentError);
  });
});

describe("round-trip", () => {
  it("read(write(x)) == x for a nested structure with a repeated label", () => {
    const d = readYaml(
      "name: P\nmembers:\n  - name: Ann\n    role: dev\n  - name: Bob\n    role: pm\n",
    );
    expect(readYaml(writeYaml(d))).toEqual(d);
  });

  it("a single-element array projects to a bare value without a schema (count-1 fallback)", () => {
    const d = readYaml("members:\n  - name: Ann\n");
    expect(writeYaml(d)).toBe("members:\n  name: Ann\n");
  });

  it("all formats (json/yaml) parse the same document for equivalent input", async () => {
    const { readJson } = await import("../../src/formats/json.js");
    const j = readJson(
      (String.raw`{"name":"P","members":[{"name":"Ann","role":"dev"},{"name":"Bob","role":"pm"}]}`),
    );
    const y = readYaml("name: P\nmembers:\n  - name: Ann\n    role: dev\n  - name: Bob\n    role: pm\n");
    expect(j).toEqual(y);
  });
});

describe("merge-key label is a genuine YAML limitation (issue #46)", () => {
  // A document edge labeled literally "<<" round-trips fine through
  // JSON/OML/TOML/XML, but YAML 1.1 gives that exact label special
  // "merge key" meaning -- the yaml package (like PyYAML's own
  // SafeLoader/SafeDumper: yaml.safe_load("<<: 1") raises the
  // equivalent ConstructorError) applies this unconditionally for the
  // "yaml-1.1" schema this port is pinned to, with no clean way to opt
  // out short of dropping that schema (see src/formats/yaml.ts's file-top
  // comment on why yaml-1.1 is required for date/bool parity with
  // PyYAML). So this is a real, documented YAML-format gap -- not a TS
  // bug -- and is excluded from test/fuzz.test.ts's YAML label generator
  // the same way #69's NEL concern is (see that file for the full
  // writeup). These two tests just pin down the concrete failure modes.
  it("a non-map merge target throws ParseError on read-back", () => {
    const text = writeYaml(doc({ "<<": -1e300 }).toData());
    expect(text).toBe("<<: -1e+300\n");
    expect(() => readYaml(text)).toThrow(ParseError);
  });

  it("a map merge target round-trips silently wrong -- the '<<' edge vanishes and its children splice into the parent", () => {
    const d = doc({ "<<": { a: 1 }, b: 2 }).toData();
    const text = writeYaml(d);
    const back = readYaml(text);
    expect(back).not.toEqual(d);
    expect(back).toEqual(doc({ a: 1, b: 2 }).toData());
  });
});

describe("temporal handling", () => {
  it("a date-shaped Date (midnight, untagged) round-trips as a bare date", () => {
    const node = doc({ born: new Date(Date.UTC(1815, 11, 10)) }).toData();
    expect(writeYaml(node)).toBe("born: 1815-12-10\n");
  });

  it("a full datetime Date writes with time-of-day", () => {
    const node = [{ label: "d", target: new Date(Date.UTC(2024, 0, 1, 9, 30, 15, 250)) }];
    const text = writeYaml(node);
    expect(text).toContain("2024-01-01T09:30:15.250");
  });
});

describe("check_yaml / write_yaml parity", () => {
  it("a clean write has an empty report and is ok", () => {
    const node = doc({ a: 1 }).toData();
    const rep = checkYaml(node);
    expect(rep.adjustments).toEqual([]);
    expect(rep.ok).toBe(true);
  });

  it("a value containing U+0085 (NEL) is reported and round-trips", () => {
    const node = [{ label: "a", target: "\x85" }];
    const rep = checkYaml(node);
    expect(rep.adjustments.map((a) => a.code)).toEqual(["string.line-break-char"]);
    expect(readYaml(writeYaml(node))).toEqual(node);
  });

  it("a label containing U+0085 (NEL) is reported and round-trips", () => {
    const node = [{ label: "\x85", target: null }];
    const rep = checkYaml(node);
    expect(rep.adjustments.map((a) => a.code)).toEqual(["string.line-break-char"]);
    expect(readYaml(writeYaml(node))).toEqual(node);
  });

  it("NaN/Infinity round-trip natively (YAML has no null-substitution need)", () => {
    for (const value of [Infinity, -Infinity, NaN]) {
      const node = [{ label: "a", target: value }];
      const rep = checkYaml(node);
      expect(rep.adjustments).toEqual([]);
    }
  });

  it("strict raises WriteError if anything had to be adjusted", () => {
    const node = [{ label: "a", target: "\x85" }];
    expect(() => writeYaml(node, { strict: true })).toThrow(WriteError);
  });

  it("passes opts.report through, appending rather than replacing", () => {
    const node = [{ label: "a", target: "\x85" }];
    const out = new WriteReport();
    writeYaml(node, { report: out });
    expect(out.adjustments.map((a) => a.code)).toEqual(["string.line-break-char"]);
  });
});

describe("schema-directed reads", () => {
  it("materializes via a schema when opts.schema is given", async () => {
    const { parseSchema } = await import("../../src/osd.js");
    const s = parseSchema(String.raw`record R { "num": number }
root R`);
    const node = readYaml("num: 1", { schema: s });
    expect(node).toEqual([{ label: "num", target: 1 }]);
  });

  it("upgrades an otherwise-unresolvable date-shaped string via schema", async () => {
    const { parseSchema } = await import("../../src/osd.js");
    const s = parseSchema(String.raw`record R { "d": date }
root R`);
    const node = readYaml(String.raw`d: "2024-01-01"`, { schema: s });
    const edges = node as { label: string; target: unknown }[];
    expect(edges[0]?.target).toBeInstanceOf(Date);
  });
});

describe("empty and top-level scalar", () => {
  it("an empty top-level node serializes to an empty mapping", () => {
    const node: import("../../src/document.js").Node = [];
    expect(writeYaml(node)).toBe("{}\n");
  });
});

describe("checkWriteDepth is a real, reachable guard (issue #37)", () => {
  it("writeYaml rejects a hand-built Node deeper than MAX_DEPTH", () => {
    let node: import("../../src/document.js").Node = 1;
    for (let i = 0; i < 250; i++) {
      node = [{ label: "a", target: node }];
    }
    expect(() => writeYaml(node)).toThrow(/nesting exceeds the maximum depth \(200\)/);
  });
});

describe("over-large integer literal (issue #54)", () => {
  it("raises ParseError instead of silently producing Infinity", () => {
    const text = "a: " + "1".repeat(4301) + "\n";
    expect(() => readYaml(text)).toThrow(ParseError);
    expect(() => readYaml(text)).toThrow(/digit/);
  });

  it("does not reject YAML's native .inf scalar", () => {
    // .inf is a native YAML 1.1 scalar (not an over-large integer literal)
    // and this port documents that Infinity round-trips natively -- must
    // not be caught by the new digit-cap guard.
    const node = readYaml("a: .inf\n");
    expect(node).toEqual([{ label: "a", target: Infinity }]);
  });

  it("does not reject a large-but-safe integer", () => {
    const node = readYaml("a: 12345\n");
    expect(node).toEqual([{ label: "a", target: 12345 }]);
  });

  it("does not scan an over-long digit run inside a comment", () => {
    const text = "# " + "1".repeat(4301) + "\na: 1\n";
    const node = readYaml(text);
    expect(node).toEqual([{ label: "a", target: 1 }]);
  });
});

describe("issue #96: a TimeValue writes as plain text (YAML has no native time syntax)", () => {
  it("writeYaml unwraps a TimeValue leaf to its plain text", () => {
    const text = writeYaml([{ label: "t", target: new TimeValue("12:00:00") }]);
    expect(text).toBe('t: "12:00:00"\n');
  });
});
