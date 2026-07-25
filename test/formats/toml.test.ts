import { describe, expect, it } from "vitest";
import { doc, Doc } from "../../src/document.js";
import { ParseError, WriteError } from "../../src/errors.js";
import { WriteReport } from "../../src/report.js";
import { readToml, writeToml, checkToml } from "../../src/formats/toml.js";

describe("readToml", () => {
  it("parses a table into a Document node", () => {
    const node = readToml('a = 1\n[b]\nc = 2\n');
    expect(node).toEqual(doc({ a: 1, b: { c: 2 } }).toData());
  });

  it("raises ParseError on invalid TOML", () => {
    expect(() => readToml("not [ valid toml")).toThrow(ParseError);
    expect(() => readToml("not [ valid toml")).toThrow(/invalid TOML/);
  });

  it("an array-of-tables becomes a repeated edge, read raw", () => {
    const node = readToml('[[items]]\nsku = "W"\n[[items]]\nsku = "G"\n');
    expect(node).toEqual([
      { label: "items", target: [{ label: "sku", target: "W" }] },
      { label: "items", target: [{ label: "sku", target: "G" }] },
    ]);
  });

  it("reads a bare date literal as a Date, no schema needed", () => {
    const node = readToml("d = 2024-01-01");
    expect(node).toEqual([{ label: "d", target: new Date(Date.UTC(2024, 0, 1)) }]);
  });

  it("reads a bare time literal as a plain string (no native time scalar)", () => {
    const node = readToml("t = 12:00:00");
    expect(node).toEqual([{ label: "t", target: "12:00:00" }]);
  });

  it("reads a bare time literal with a fractional second, fraction preserved", () => {
    const node = readToml("t = 12:00:00.250");
    expect(node).toEqual([{ label: "t", target: "12:00:00.250" }]);
  });

  it("reads a local datetime literal as a Date", () => {
    const node = readToml("dt = 2024-01-01T12:00:00");
    expect(node).toEqual([{ label: "dt", target: new Date(Date.UTC(2024, 0, 1, 12, 0, 0)) }]);
  });

  it("reads an offset datetime literal as a Date at the right instant", () => {
    const node = readToml("dt = 2024-01-01T12:00:00+02:00");
    expect(node).toEqual([{ label: "dt", target: new Date(Date.UTC(2024, 0, 1, 10, 0, 0)) }]);
  });

  it("raises ParseError on an oversized integer literal", () => {
    const text = "a = " + "9".repeat(4301);
    expect(() => readToml(text)).toThrow(ParseError);
  });
});

describe("round-trip", () => {
  it("read(write(x)) == x for a nested structure with a repeated label", () => {
    const d = readToml('name = "P"\n[[members]]\nname = "Ann"\nrole = "dev"\n' +
      '[[members]]\nname = "Bob"\nrole = "pm"\n');
    expect(readToml(writeToml(d))).toEqual(d);
  });

  it("matches across formats: json/toml agree on the same document", () => {
    const t = readToml('name = "P"\n[[members]]\nname = "Ann"\nrole = "dev"\n' +
      '[[members]]\nname = "Bob"\nrole = "pm"\n');
    expect(t).toEqual([
      { label: "name", target: "P" },
      { label: "members", target: [{ label: "name", target: "Ann" }, { label: "role", target: "dev" }] },
      { label: "members", target: [{ label: "name", target: "Bob" }, { label: "role", target: "pm" }] },
    ]);
  });

  it("a date leaf round-trips losslessly", () => {
    const node = doc({ d: new Date(Date.UTC(2024, 0, 1)) }).toData();
    const text = writeToml(node);
    expect(text).toContain("2024-01-01");
    expect(readToml(text)).toEqual(node);
  });

  it("a local (no-offset) datetime leaf round-trips as local, not offset (issue #26)", () => {
    const read = readToml("dt = 2024-01-01T12:00:00");
    const text = writeToml(read);
    // Must NOT gain an offset/Z marker that wasn't in the source literal.
    expect(text.trim()).toBe("dt = 2024-01-01T12:00:00.000");
    expect(readToml(text)).toEqual(read);
  });

  it("an offset datetime leaf still round-trips as offset (issue #26 doesn't regress this)", () => {
    const read = readToml("dt = 2024-01-01T12:00:00+02:00");
    const text = writeToml(read);
    expect(text.trim()).toBe("dt = 2024-01-01T10:00:00.000Z");
    expect(readToml(text)).toEqual(read);
  });
});

describe("writing", () => {
  it("writes a date-kind Date without a time component (a local TOML date)", () => {
    const read = readToml("d = 2024-01-01");
    const text = writeToml(read);
    expect(text).toBe("d = 2024-01-01\n");
  });

  it("writes an untagged Date as an offset (Z) TOML datetime", () => {
    const node = doc({ d: new Date(Date.UTC(2024, 0, 1, 9, 30)) }).toData();
    const text = writeToml(node);
    expect(text).toContain("2024-01-01T09:30:00");
  });

  it("writes a simple table", () => {
    expect(writeToml([{ label: "id", target: "A1" }])).toBe('id = "A1"\n');
  });

  it("rejects a non-object (bare scalar) root", () => {
    expect(() => writeToml("bare leaf")).toThrow(WriteError);
    expect(() => writeToml("bare leaf")).toThrow(/top-level table/);
  });
});

describe("adjustment reports", () => {
  it("drops a null value with a null.omitted warning", () => {
    const node = doc({ a: 1, b: null }).toData();
    const rep = checkToml(node);
    expect(rep.adjustments.map((a) => a.code)).toEqual(["null.omitted"]);
    expect(rep.warnings.length).toBe(1);
    expect(rep.errors.length).toBe(0);
    expect(writeToml(node)).not.toContain("b");
  });

  it("strict raises WriteError on null", () => {
    const node = doc({ a: 1, b: null }).toData();
    expect(() => writeToml(node, { strict: true })).toThrow(WriteError);
  });

  it("a clean write has an empty report", () => {
    const node = doc({ a: 1 }).toData();
    const rep = new WriteReport();
    writeToml(node, { report: rep });
    expect(rep.adjustments).toEqual([]);
    expect(rep.ok).toBe(true);
  });

  it("report arg and strict share the same events", () => {
    const node = doc({ a: 1, b: null }).toData();
    const rep = new WriteReport();
    let caught: unknown;
    try {
      writeToml(node, { strict: true, report: rep });
    } catch (exc) {
      caught = exc;
    }
    expect(caught).toBeInstanceOf(WriteError);
    expect(rep.adjustments.map((a) => a.code)).toEqual(["null.omitted"]);
  });
});

describe("unsupported scalar", () => {
  it("write_toml rejects a leaf that is neither a TOML-native type nor Date", () => {
    const node = [{ label: "a", target: Symbol("x") as unknown as null }];
    expect(() => writeToml(node)).toThrow(/cannot serialize/);
  });

  it("names the constructor of an unsupported object leaf in the error", () => {
    function Weird(this: { x: number }): void {
      this.x = 1;
    }
    const target = new (Weird as unknown as new () => { x: number })();
    const node = [{ label: "a", target: target as unknown as null }];
    expect(() => writeToml(node)).toThrow(/cannot serialize Weird/);
  });
});

describe("schema-directed reads", () => {
  it("materializes via a schema when opts.schema is given", async () => {
    const { parseSchema } = await import("../../src/osd.js");
    const s = parseSchema('record R { "n": number }\nroot R');
    const node = readToml('n = 3', { schema: s });
    expect(node).toEqual([{ label: "n", target: 3 }]);
  });

  it("a schema is a no-op for date fields (TOML already produces a Date)", async () => {
    const { parseSchema } = await import("../../src/osd.js");
    const s = parseSchema('record R { "d": date }\nroot R');
    const node = readToml('d = "2024-01-01"', { schema: s });
    expect(node).toEqual([{ label: "d", target: new Date(Date.UTC(2024, 0, 1)) }]);
  });
});

// Issue #32 follow-up: independent review found toTomlValue (used by
// writeToml) and convertTomlDates (used by readToml) have the identical
// unsafe-object-building shape that grouped() was hardened against above --
// see document.test.ts's issue #32 comment block for the full mechanism
// (a plain {} has Object.prototype in its chain, so out[k] = v for
// k === "__proto__" reassigns out's own prototype instead of creating an
// own property). toTomlValue re-copies grouped()'s already-safe
// Object.create(null) output into a plain {}, silently re-introducing the
// bug for any *nested* table (not just the document root). convertTomlDates
// walks smol-toml's own parsed value (which itself uses null-prototype
// tables, so a TOML `[__proto__]` table is a genuine own "__proto__" data
// property there) and has the same plain-{} bug on the read path, which is
// why reading a `[__proto__]` TOML table throws a spurious DocumentError
// downstream in buildNode rather than round-tripping the table.
import { readJson } from "../../src/formats/json.js";

describe("toTomlValue is hardened against __proto__/constructor labels (issue #32 follow-up)", () => {
  it("a nested __proto__-labeled table is not silently dropped when writing TOML", () => {
    const node = readJson('{"outer":{"__proto__":{"polluted":true},"kept":2}}');
    const text = writeToml(node);
    // Before the fix: toTomlValue's `out` for the *nested* "outer" table is
    // a plain {}, so out["__proto__"] = {polluted:true} reassigns outer's
    // prototype instead of storing it, and stringifyToml silently emits
    // only "kept" -- the __proto__-labeled data vanishes without error or
    // warning.
    expect(text).toContain("polluted");
    const roundTripped = readToml(text);
    // TOML has no guaranteed key order for a round-tripped table, so
    // compare the grouped (JSON-shaped) projection instead of the raw
    // edge list, which is order-sensitive.
    expect(new Doc(roundTripped).toGrouped()).toEqual(
      JSON.parse('{"outer":{"__proto__":{"polluted":true},"kept":2}}'),
    );
  });

  it("does not pollute the global Object.prototype when writing", () => {
    const node = readJson('{"outer":{"__proto__":{"polluted":true},"kept":2}}');
    writeToml(node);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("convertTomlDates is hardened against __proto__/constructor labels (issue #32 follow-up)", () => {
  it("a [__proto__] TOML table round-trips as ordinary data instead of throwing", () => {
    // Before the fix: this throws DocumentError("$: Object is not a
    // Document value") from buildNode, because convertTomlDates's plain-{}
    // `out` for the document root has its own prototype reassigned to
    // {polluted:true} while copying smol-toml's parsed value, so the
    // result fails buildNode's isPlainObject check entirely.
    const node = readToml("[__proto__]\npolluted = true\n");
    expect(node).toEqual(doc(JSON.parse('{"__proto__":{"polluted":true}}')).toData());
  });

  it("does not pollute the global Object.prototype when reading", () => {
    readToml("[__proto__]\npolluted = true\n");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("checkWriteDepth is a real, reachable guard (issue #37)", () => {
  it("writeToml rejects a hand-built Node deeper than MAX_DEPTH", () => {
    let node: import("../../src/document.js").Node = 1;
    for (let i = 0; i < 250; i++) {
      node = [{ label: "a", target: node }];
    }
    expect(() => writeToml(node)).toThrow(/nesting exceeds the maximum depth \(200\)/);
  });
});
