import { describe, expect, it } from "vitest";
import { doc } from "../../src/document.js";
import { ParseError, WriteError } from "../../src/errors.js";
import { WriteReport } from "../../src/report.js";
import { readJson, writeJson, checkJson } from "../../src/formats/json.js";

describe("readJson", () => {
  it("parses a JSON object into a Document node", () => {
    const node = readJson('{"a": 1, "b": [1, 2]}');
    expect(node).toEqual(doc({ a: 1, b: [1, 2] }).toData());
  });

  it("raises ParseError on invalid JSON", () => {
    expect(() => readJson("{not json")).toThrow(ParseError);
    expect(() => readJson("{not json")).toThrow(/invalid JSON/);
  });
});

describe("round-trip", () => {
  it("read(write(x)) == x for a nested structure with a repeated label", () => {
    const d = readJson(
      '{"name":"P","members":[{"name":"Ann","role":"dev"},' +
      '{"name":"Bob","role":"pm"}]}',
    );
    expect(readJson(writeJson(d))).toEqual(d);
  });

  it("a single-element array projects to a bare value without a schema (count-1 fallback)", () => {
    const d = readJson('{"members":[{"name":"Ann"}]}');
    expect(writeJson(d)).toBe('{"members": {"name": "Ann"}}');
  });

  it("matches Python default separators: comma-space, colon-space, no indent", () => {
    const d = doc({ d: "2024-01-01" }).toData();
    expect(writeJson(d)).toBe('{"d": "2024-01-01"}');
  });
});

describe("temporal and special-float handling", () => {
  it("a Date leaf is stringified with a warning", () => {
    const node = doc({ d: new Date(Date.UTC(2024, 0, 1)) }).toData();
    const rep = checkJson(node);
    expect(rep.adjustments.map((a) => a.code)).toEqual(["temporal.stringified"]);
    expect(writeJson(node)).toBe('{"d": "2024-01-01"}');
  });

  it("NaN is reported as float.special (error severity)", () => {
    const node = [{ label: "x", target: NaN }];
    const rep = checkJson(node);
    expect(rep.adjustments.map((a) => a.code)).toEqual(["float.special"]);
    expect(rep.errors.length).toBe(1);
  });

  it("lenient write substitutes null for NaN/Infinity/-Infinity and stays valid JSON", () => {
    for (const value of [Infinity, -Infinity, NaN]) {
      const node = [{ label: "a", target: value }];
      const text = writeJson(node);
      expect(text).toBe('{"a": null}');
      expect(() => JSON.parse(text)).not.toThrow();
      const rep = checkJson(node);
      expect(rep.adjustments.map((a) => a.code)).toEqual(["float.special"]);
      expect(rep.errors.length).toBe(1);
      expect(rep.adjustments[0]?.message).toContain("null");
    }
  });

  it("strict still refuses special floats instead of substituting", () => {
    const node = [{ label: "a", target: Infinity }];
    expect(() => writeJson(node, { strict: true })).toThrow(WriteError);
  });

  it("substitution walks nested structure, not just top-level leaves", () => {
    const node = [
      { label: "r", target: [
        { label: "x", target: Infinity },
        { label: "y", target: 1 },
      ] },
    ];
    expect(writeJson(node)).toBe('{"r": {"x": null, "y": 1}}');
  });
});

describe("check_json parity with write_json", () => {
  it("a clean write has an empty report and is truthy (ok)", () => {
    const node = doc({ a: 1 }).toData();
    const rep = checkJson(node);
    expect(rep.adjustments).toEqual([]);
    expect(rep.ok).toBe(true);
  });
});

describe("schema-directed reads", () => {
  it("materializes via a schema when opts.schema is given", async () => {
    const { parseSchema } = await import("../../src/osd.js");
    const s = parseSchema("record R { \"n\": number }\nroot R");
    const node = readJson('{"n": 1}', { schema: s });
    expect(node).toEqual([{ label: "n", target: 1 }]);
  });
});

describe("writeJson indent option", () => {
  it("formats with newlines and per-level indentation, matching json.dumps(indent=N)", () => {
    const d = doc({ a: 1, b: { c: 2 } }).toData();
    expect(writeJson(d, { indent: 2 })).toBe(
      '{\n  "a": 1,\n  "b": {\n    "c": 2\n  }\n}',
    );
  });

  it("indents an array too", () => {
    const d = doc({ members: [1, 2] }).toData();
    expect(writeJson(d, { indent: 2 })).toBe(
      '{\n  "members": [\n    1,\n    2\n  ]\n}',
    );
  });
});

describe("unsupported scalar", () => {
  it("write_json rejects a leaf that is neither a JSON-native type nor Date", () => {
    const node = [{ label: "a", target: Symbol("x") as unknown as null }];
    expect(() => writeJson(node)).toThrow(/cannot serialize/);
  });

  it("an object leaf with a non-Object.prototype, non-null prototype is rejected too", () => {
    function Weird(this: { x: number }): void {
      this.x = 1;
    }
    const target = new (Weird as unknown as new () => { x: number })();
    const node = [{ label: "a", target: target as unknown as null }];
    expect(() => writeJson(node)).toThrow(/cannot serialize Weird/);
  });

  it("an object leaf with a null prototype serializes as a plain object", () => {
    const target: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    target["x"] = 1;
    const node = [{ label: "a", target: target as unknown as null }];
    expect(writeJson(node)).toBe('{"a": {"x": 1}}');
  });

  it("NaN reached via serialize in strict mode still round-trips through the branch", () => {
    const node = [{ label: "a", target: NaN }];
    expect(() => writeJson(node, { strict: true })).toThrow();
  });
});

describe("isoOf full-datetime branch", () => {
  it("a non-midnight Date is stringified with a time-of-day and fractional seconds", () => {
    const node = [{ label: "d", target: new Date(Date.UTC(2024, 0, 1, 9, 30, 15, 250)) }];
    expect(writeJson(node)).toBe('{"d": "2024-01-01T09:30:15.250"}');
  });

  it("a non-midnight Date with zero milliseconds omits the fraction", () => {
    const node = [{ label: "d", target: new Date(Date.UTC(2024, 0, 1, 9, 30, 15)) }];
    expect(writeJson(node)).toBe('{"d": "2024-01-01T09:30:15"}');
  });
});

describe("unsupported non-object scalar", () => {
  it("a function leaf hits the typeof fallback in the error message", () => {
    const node = [{ label: "a", target: (() => 1) as unknown as null }];
    expect(() => writeJson(node)).toThrow(/cannot serialize function/);
  });
});

describe("remaining serialize branches", () => {
  it("writes a false boolean leaf", () => {
    const node = [{ label: "a", target: false }];
    expect(writeJson(node)).toBe('{"a": false}');
  });

  it("writes a true boolean leaf", () => {
    const node = [{ label: "a", target: true }];
    expect(writeJson(node)).toBe('{"a": true}');
  });

  it("passes opts.report through to finishWrite when given", () => {
    const node = doc({ d: new Date(Date.UTC(2024, 0, 1)) }).toData();
    const out = new WriteReport();
    writeJson(node, { report: out });
    expect(out.adjustments.map((a) => a.code)).toEqual(["temporal.stringified"]);
  });

  it("strict mode still computes text for -Infinity before throwing", () => {
    const node = [{ label: "a", target: -Infinity }];
    expect(() => writeJson(node, { strict: true })).toThrow();
  });

  it("an empty top-level node serializes to an empty object", () => {
    const node: import("../../src/document.js").Node = [];
    expect(writeJson(node)).toBe("{}");
  });

});

// Issue #32 (security regression): a JSON document with a "__proto__" key
// is untrusted input reaching readJson/writeJson via document.ts's
// grouped(). Before the fix, writeJson(readJson(...)) on such input threw
// "cannot serialize Object" -- a denial-of-service crash -- because
// grouped() corrupted the built object's own prototype instead of storing
// "__proto__" as a normal data key. This proves the full read/write round
// trip is safe end-to-end, and that global Object.prototype is never
// touched.
describe("readJson/writeJson: __proto__ label round-trips safely (issue #32)", () => {
  it("round-trips a top-level __proto__ key without throwing or corrupting data", () => {
    const malicious = '{"__proto__": {"polluted": true}, "safe": 1}';
    const node = readJson(malicious);
    const text = writeJson(node);
    const reparsed = JSON.parse(text);
    expect(Object.prototype.hasOwnProperty.call(reparsed, "__proto__")).toBe(true);
    expect((reparsed as Record<string, unknown>)["__proto__"]).toEqual({ polluted: true });
    expect((reparsed as Record<string, unknown>).safe).toBe(1);
  });

  it("never pollutes the global Object.prototype", () => {
    const malicious = '{"__proto__": {"polluted": true}}';
    const node = readJson(malicious);
    writeJson(node);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it("constructor/prototype keys also round-trip as ordinary data", () => {
    const malicious = '{"constructor": {"prototype": {"polluted": true}}}';
    const node = readJson(malicious);
    const text = writeJson(node);
    expect(JSON.parse(text)).toEqual({ constructor: { prototype: { polluted: true } } });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
