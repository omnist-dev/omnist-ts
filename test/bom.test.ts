import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stripLeadingBom } from "../src/bom.js";
import { doc } from "../src/document.js";
import { ParseError, SchemaError } from "../src/errors.js";
import { readOml, writeOml } from "../src/oml.js";
import { parseSchema, toOsd } from "../src/osd.js";
import { readJson, writeJson } from "../src/formats/json.js";
import { readYaml, writeYaml } from "../src/formats/yaml.js";
import { readToml, writeToml } from "../src/formats/toml.js";
import { readXml, writeXml } from "../src/formats/xml.js";

// Spec D-15 (docs/02-document-model.md Sec2.5): a leading U+FEFF is stripped
// on every read surface, exactly one, only at offset zero; no writer emits one.
const BOM = "﻿";
const EXPECTED = doc({ a: 1n }).toData();

describe("stripLeadingBom", () => {
  it("strips exactly one mark at offset zero", () => {
    expect(stripLeadingBom(BOM + "x")).toBe("x");
    expect(stripLeadingBom(BOM + BOM + "x")).toBe(BOM + "x");
  });
  it("leaves a mark anywhere else, and mark-free text, untouched", () => {
    expect(stripLeadingBom("x" + BOM)).toBe("x" + BOM);
    expect(stripLeadingBom(" " + BOM + "x")).toBe(" " + BOM + "x");
    expect(stripLeadingBom("x")).toBe("x");
    expect(stripLeadingBom("")).toBe("");
  });
});

describe("D-15: every read surface strips one leading BOM", () => {
  it("OML", () => expect(readOml(BOM + "a: 1\n")).toEqual(EXPECTED));
  it("JSON", () => expect(readJson(BOM + '{"a": 1}')).toEqual(EXPECTED));
  it("YAML", () => expect(readYaml(BOM + "a: 1\n")).toEqual(EXPECTED));
  it("TOML", () => expect(readToml(BOM + "a = 1\n")).toEqual(EXPECTED));
  it("XML", () => {
    expect(readXml(BOM + "<r><a>1</a></r>")).toEqual(readXml("<r><a>1</a></r>"));
  });
  it("OSD", () => {
    const text = 'record R { "a": string } root R\n';
    expect(toOsd(parseSchema(BOM + text))).toBe(toOsd(parseSchema(text)));
  });
});

describe("D-15 negative half: a second BOM is not silently swallowed (where this port owns the grammar)", () => {
  it("OML rejects a doubled mark", () => {
    expect(() => readOml(BOM + BOM + "a: 1\n")).toThrow(ParseError);
  });
  it("OSD rejects a doubled mark (JS \\s matches U+FEFF; the OSD whitespace class must not)", () => {
    expect(() => parseSchema(BOM + BOM + 'record R { "a": string } root R\n')).toThrow(SchemaError);
  });
  it("OSD rejects a mark that is not at offset zero", () => {
    expect(() => parseSchema('record R { "a": string } ' + BOM + "root R\n")).toThrow(SchemaError);
    expect(() => parseSchema(" " + BOM + 'record R { "a": string } root R\n')).toThrow(SchemaError);
  });
  it("JSON and TOML reject a doubled mark", () => {
    expect(() => readJson(BOM + BOM + '{"a": 1}')).toThrow(ParseError);
    expect(() => readToml(BOM + BOM + "a = 1\n")).toThrow(ParseError);
  });
  it("YAML and XML: the underlying library tolerates a second mark; recorded, not tightened", () => {
    // Deliberately NOT reimplementing yaml's / fast-xml-parser's grammar to be
    // stricter: this pins the observed library behavior so a change is noticed.
    expect(readYaml(BOM + BOM + "a: 1\n")).toEqual(EXPECTED);
    expect(readXml(BOM + BOM + "<r><a>1</a></r>")).toEqual(readXml("<r><a>1</a></r>"));
  });
});

describe("D-15: no writer emits a leading BOM", () => {
  // Even a document whose first scalar starts with U+FEFF as *data* must not
  // put one at the head of the output text.
  const docs = [doc({ r: { a: 1n, b: "x" } }).toData(), doc({ r: { a: BOM + "x" } }).toData()];
  it.each(docs.map((d, i) => [i, d] as const))("OML/JSON/YAML/TOML/XML output %i", (_i, d) => {
    const outs = [writeOml(d), writeJson(d), writeYaml(d), writeToml(d), writeXml(d)];
    for (const out of outs) {
      expect(out.startsWith(BOM)).toBe(false);
      expect(out.charCodeAt(0)).not.toBe(0xfeff);
    }
  });
  it("OSD output", () => {
    const s = parseSchema('record R { "a": string } root R\n');
    expect(toOsd(s).startsWith(BOM)).toBe(false);
    expect(toOsd(s, { indent: null }).startsWith(BOM)).toBe(false);
  });
});

describe("D-15: stripping lives in one place", () => {
  it("no source file carries a raw (invisible) U+FEFF literal", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (name.endsWith(".ts") && readFileSync(p, "utf-8").includes(BOM)) offenders.push(p);
      }
    };
    walk(path.join(root, "src"));
    walk(path.join(root, "tools"));
    expect(offenders).toEqual([]);
  });
});
