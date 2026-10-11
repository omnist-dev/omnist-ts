// omnist-spec v0.34.0-beta, adopted in omnist-ts 0.9.0-alpha: the registered
// write-report codes (E-5, E-34), the YAML profile decisions (C-13, D-27, E-34)
// and the rules the vendored vectors pin. The vectors themselves run in the
// Track 2 runner; these pin the behaviour directly, red before green.
import { describe, expect, it } from "vitest";
import { ParseError } from "../src/errors.js";
import { WriteReport } from "../src/report.js";
import { checkJson, writeJson } from "../src/formats/json.js";
import { checkXml, writeXml } from "../src/formats/xml.js";
import { checkYaml, readYaml, writeYaml } from "../src/formats/yaml.js";
import { TimeValue } from "../src/temporal.js";
import { main } from "../src/cli.js";
import type { Node } from "../src/document.js";

const NEL = String.fromCharCode(0x85);
const date = new Date(Date.UTC(2024, 0, 15));

function codes(rep: WriteReport): [string, string][] {
  return rep.adjustments.map((a) => [a.path, a.code]);
}

function thrown(fn: () => unknown): { name: string; code?: unknown; path?: unknown; message: string } {
  try {
    fn();
  } catch (e) {
    const err = e as { code?: unknown; path?: unknown; message: string };
    return { name: (e as Error).constructor.name, code: err.code, path: err.path, message: err.message };
  }
  throw new Error("expected a throw");
}

describe("write reports use the registered codes (E-5, omnist-ts#166)", () => {
  it("JSON reports a Date as format.temporal-stringified", () => {
    expect(codes(checkJson([{ label: "d", target: date }]))).toEqual([["$.d", "format.temporal-stringified"]]);
  });

  it("XML reports a non-string scalar as format.value-stringified, once per leaf, indexed", () => {
    const node: Node = [{ label: "r", target: [
      { label: "n", target: 1n },
      { label: "n", target: true },
      { label: "x", target: 2.5 },
    ] }];
    expect(codes(checkXml(node))).toEqual([
      ["$.r.n[0]", "format.value-stringified"],
      ["$.r.n[1]", "format.value-stringified"],
      ["$.r.x", "format.value-stringified"],
    ]);
  });

  it("XML reports a date, time or datetime leaf as format.temporal-stringified and NEVER also value-stringified", () => {
    const node: Node = [{ label: "r", target: [
      { label: "d", target: date },
      { label: "t", target: new TimeValue("12:30:00") },
      { label: "dt", target: new Date(Date.UTC(2024, 0, 15, 12, 30, 0)) },
    ] }];
    expect(codes(checkXml(node))).toEqual([
      ["$.r.d", "format.temporal-stringified"],
      ["$.r.t", "format.temporal-stringified"],
      ["$.r.dt", "format.temporal-stringified"],
    ]);
    const rep = new WriteReport();
    writeXml(node, { report: rep });
    expect(rep.adjustments.map((a) => a.code)).not.toContain("format.value-stringified");
  });

  it("the CLI check command prints the registered code", () => {
    const out: string[] = [];
    const sink = { write: (c: unknown) => (out.push(String(c)), true) } as unknown as NodeJS.WritableStream;
    const code = main(["check", "-", "--from", "json", "--to", "xml", "--result-format", "json"], {
      stdout: sink,
      stderr: sink,
      stdin: '{"a": 1, "d": "x"}',
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain('"code": "format.value-stringified"');
    expect(out.join("")).not.toContain('"code": "value.stringified"');
  });
});

describe("YAML writes U+0085 as the escape \\N and reports format.string-line-break-char (E-34)", () => {
  it("a value: double-quoted, \\N, never the raw character, and it reads back", () => {
    const node: Node = [{ label: "a", target: "x" + NEL + "y" }];
    const text = writeYaml(node);
    expect(text).toBe('a: "x\\Ny"\n');
    expect(text.includes(NEL)).toBe(false);
    expect(readYaml(text)).toEqual(node);
  });

  it("every NEL in a string is escaped, beside other escapes", () => {
    const node: Node = [{ label: "a", target: NEL + "a\nb" + NEL }];
    const text = writeYaml(node);
    expect(text).toBe('a: "\\Na\\nb\\N"\n');
    expect(readYaml(text)).toEqual(node);
  });

  it("a label: the key is escaped too", () => {
    const node: Node = [{ label: "k" + NEL, target: "v" }];
    const text = writeYaml(node);
    expect(text).toBe('"k\\N": v\n');
    expect(readYaml(text)).toEqual(node);
  });

  it("reports the registered code once per string value, at the leaf's path, indexed", () => {
    const node: Node = [
      { label: "a", target: "p" + NEL },
      { label: "a", target: "q" + NEL },
      { label: "b", target: "plain" },
    ];
    expect(codes(checkYaml(node))).toEqual([
      ["$.a[0]", "format.string-line-break-char"],
      ["$.a[1]", "format.string-line-break-char"],
    ]);
    const rep = new WriteReport();
    writeYaml(node, { report: rep });
    expect(rep.adjustments.every((a) => a.severity === "warning")).toBe(true);
  });
});

describe("YAML refuses !!omap, !!pairs and !!set: format.tag-forbidden at $ (C-13)", () => {
  it.each([
    ["omap", "t: !!omap [{k: 1}, {j: 2}]\n", "!!omap"],
    ["pairs", "t: !!pairs [{k: 1}, {k: 2}]\n", "!!pairs"],
    ["flow set", "t: !!set {x, y}\n", "!!set"],
    ["block set", "t: !!set\n  ? x\n  ? y\n", "!!set"],
    ["empty omap", "t: !!omap []\n", "!!omap"],
    ["top-level omap", "!!omap [{k: 1}]\n", "!!omap"],
    ["a nested omap", "a:\n  b:\n    - c: !!omap [{k: 1}]\n", "!!omap"],
  ])("%s", (_name, text, tag) => {
    const e = thrown(() => readYaml(text));
    expect(e).toMatchObject({ name: "ParseError", code: "format.tag-forbidden", path: "$" });
    expect(e.message).toContain(tag);
  });

  it("is a ParseError, not a syntax error", () => {
    expect(() => readYaml("t: !!set {x}\n")).toThrow(ParseError);
  });

  it("an untagged sequence of single-entry mappings is repeated edges, and other tags are untouched", () => {
    expect(readYaml("t:\n  - {k: 1}\n  - {j: 2}\n")).toHaveLength(2);
    expect(readYaml("a: !!seq [1, 2]\nb: !!map {x: 1}\nc: !!str 5\nd: !foo bar\n")).toHaveLength(5);
  });
});

describe("YAML: only an untagged or !!merge-tagged plain << is the merge key (D-27)", () => {
  it("!!str << is an ordinary string key", () => {
    expect(readYaml("q: {!!str <<: 2}\n")).toEqual([{ label: "q", target: [{ label: "<<", target: 2n }] }]);
  });

  it("!!str << with an alias value merges nothing: the value is the aliased mapping", () => {
    expect(readYaml("p: &p {x: 1}\nq: {!!str <<: *p}\n")).toEqual([
      { label: "p", target: [{ label: "x", target: 1n }] },
      { label: "q", target: [{ label: "<<", target: [{ label: "x", target: 1n }] }] },
    ]);
  });

  it("a block-style !!str << key is ordinary too", () => {
    expect(readYaml("!!str <<: 1\n")).toEqual([{ label: "<<", target: 1n }]);
  });

  it("an untagged << and a !!merge << merge", () => {
    const merged = [
      { label: "p", target: [{ label: "x", target: 1n }] },
      { label: "q", target: [{ label: "x", target: 1n }, { label: "y", target: 2n }] },
    ];
    expect(readYaml("p: &p {x: 1}\nq: {<<: *p, y: 2}\n")).toEqual(merged);
    expect(readYaml("p: &p {x: 1}\nq: {!!merge <<: *p, y: 2}\n")).toEqual(merged);
  });

  it("a quoted << is an ordinary key", () => {
    expect(readYaml('q: {"<<": 2}\n')).toEqual([{ label: "q", target: [{ label: "<<", target: 2n }] }]);
  });

  it("a !!merge << with a scalar value is still malformed", () => {
    expect(thrown(() => readYaml("q: {!!merge <<: 1}\n"))).toMatchObject({ code: "parse.codec-syntax" });
  });
});

describe("JSON still writes a Date as an ISO string", () => {
  it("and reads it back as a string", () => {
    expect(writeJson([{ label: "d", target: date }])).toBe('{"d": "2024-01-15"}');
  });
});
