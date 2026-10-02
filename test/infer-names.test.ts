import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { main } from "../src/cli.js";
import { SchemaError, infer, parseSchema, toOsd } from "../src/index.js";

// omnist-spec v0.28.0-beta S-8: every record name infer() derives must be a
// valid name. Mirrors omnist-py's _identifier: non-[A-Za-z0-9_] -> `_`, leading
// digits/underscores stripped, `Rec` when nothing is left, first letter upper.
const NAMES: [string, string][] = [
  ["123", "Rec"],
  ["9", "Rec"],
  ["éclair", "Clair"],
  ["日本", "Rec"],
  ["a b", "A_b"],
  ["__", "Rec"],
  ["9lives", "Lives"],
  ["a-b", "A_b"],
  ["host", "Host"],
];

function recordNames(text: string): string[] {
  return [...text.matchAll(/^record (\S+) \{/gm)].map((m) => m[1] as string);
}

describe("infer(): record names are always valid S-8 names", () => {
  it.each(NAMES)("key %j -> record %s", (key, name) => {
    const s = infer([{ [key]: { a: 1 } }]);
    expect([...s.env.keys()].sort()).toEqual(["Root", name].sort());
    expect(parseSchema(toOsd(s)).equivalent(s)).toBe(true);
  });

  it("two keys that sanitize to the same name stay unique", () => {
    const s = infer([{ "123": { a: 1 }, "9": { b: 2 }, "日本": { c: 3 }, rec: { d: 4 }, "a b": { e: 1 }, "a-b": { f: 1 } }]);
    expect([...s.env.keys()].sort()).toEqual(["Root", "Rec", "Rec2", "Rec3", "Rec4", "A_b", "A_b2"].sort());
    expect(parseSchema(toOsd(s)).equivalent(s)).toBe(true);
  });

  it("an empty key still fails with schema.empty-label, as before (not a record-name problem)", () => {
    try {
      infer([{ "": { a: 1 } }]);
    } catch (e) {
      expect((e as SchemaError).code).toBe("schema.empty-label");
      return;
    }
    throw new Error("expected a SchemaError");
  });

  it("property: every inferred schema constructs and round-trips through toOsd", () => {
    const alphabet = ["a", "Z", "0", "9", "_", " ", "-", ".", "é", "日", "\u{1F600}", "$"];
    let seed = 12345;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let i = 0; i < 300; i++) {
      const obj: Record<string, unknown> = {};
      for (let k = 0; k < 1 + rnd(4); k++) {
        let key = "";
        for (let c = 0; c < 1 + rnd(5); c++) key += alphabet[rnd(alphabet.length)];
        obj[key] = { v: 1, w: { x: "s" } };
      }
      const s = infer([obj]);
      for (const name of s.env.keys()) expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
      expect(parseSchema(toOsd(s)).equivalent(s)).toBe(true);
    }
  });
});

describe("infer CLI: odd keys exit 0 in every input format", () => {
  let dir: string;
  let out = "";
  let err = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omnist-infer-"));
    out = "";
    err = "";
    vi.spyOn(process.stdout, "write").mockImplementation((s) => ((out += String(s)), true));
    vi.spyOn(process.stderr, "write").mockImplementation((s) => ((err += String(s)), true));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const cases: [string, string, string[]][] = [
    ["json", '{"123": {"a": 1}, "a b": {"b": 2}, "日本": {"c": 3}}', ["Rec", "A_b", "Rec2"]],
    ["yaml", '"123":\n  a: 1\n"a b":\n  b: 2\n"日本":\n  c: 3\n', ["Rec", "A_b", "Rec2"]],
    ["toml", '["123"]\na = 1\n["a b"]\nb = 2\n["日本"]\nc = 3\n', ["Rec", "A_b", "Rec2"]],
    ["xml", "<root><a.b><x>1</x></a.b><_9><y>2</y></_9></root>", ["A_b", "Rec"]],
  ];
  it.each(cases)("%s", async (fmt, text, expected) => {
    const f = path.join(dir, `in.${fmt}`);
    fs.writeFileSync(f, text);
    const code = await main(["infer", f, "--from", fmt]);
    expect({ code, err }).toEqual({ code: 0, err: "" });
    const names = recordNames(out);
    for (const n of expected) expect(names).toContain(n);
    for (const n of names) expect(n).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    expect(parseSchema(out)).toBeDefined();
  });
});
