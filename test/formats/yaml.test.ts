import { describe, expect, it } from "vitest";
import { doc } from "../../src/document.js";
import { ParseError, WriteError } from "../../src/errors.js";
import { WriteReport } from "../../src/report.js";
import { readYaml, writeYaml, checkYaml } from "../../src/formats/yaml.js";

describe("readYaml", () => {
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
