import { describe, expect, it } from "vitest";
import { doc } from "../../src/document.js";
import type { Node } from "../../src/document.js";
import { ParseError, WriteError } from "../../src/errors.js";
import { WriteReport } from "../../src/report.js";
import { readJson, writeJson, checkJson } from "../../src/formats/json.js";
import { TimeValue } from "../../src/temporal.js";

describe("readJson", () => {
  it("parses a JSON object into a Document node", () => {
    const node = readJson('{"a": 1, "b": [1, 2]}');
    expect(node).toEqual(doc({ a: 1n, b: [1n, 2n] }).toData());
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
    // "y" is a plain JS `number` (not bigint), so it writes with a
    // decimal point since issue #98 -- see oml.ts's writeScalar for
    // why a bare digit token would otherwise read back as a
    // different kind (bigint).
    expect(writeJson(node)).toBe('{"r": {"x": null, "y": 1.0}}');
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
    // "n" is declared `number` -- materialize always normalizes to a
    // host float (spec Sec7.2), even from JSON's own integer-shaped
    // literal `1`.
    const node = readJson('{"n": 1}', { schema: s });
    expect(node).toEqual([{ label: "n", target: 1 }]);
  });
});

describe("writeJson indent option", () => {
  it("formats with newlines and per-level indentation, matching json.dumps(indent=N)", () => {
    // doc({...}) builds plain JS numbers (`number`-kind, not bigint),
    // which write with a decimal point since issue #98.
    const d = doc({ a: 1, b: { c: 2 } }).toData();
    expect(writeJson(d, { indent: 2 })).toBe(
      '{\n  "a": 1.0,\n  "b": {\n    "c": 2.0\n  }\n}',
    );
  });

  it("indents an array too", () => {
    const d = doc({ members: [1, 2] }).toData();
    expect(writeJson(d, { indent: 2 })).toBe(
      '{\n  "members": [\n    1.0,\n    2.0\n  ]\n}',
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
    expect(writeJson(node)).toBe('{"a": {"x": 1.0}}');
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

  it("regression: fast-check counterexample from PR #30 CI (seed 1037922291) via writeJson directly", () => {
    // Reported independently by a user against master (pre-fix): fast-check's
    // property fuzzing in test/fuzz.test.ts intermittently found this exact
    // document -- a " "-labeled edge nesting an empty "__proto__" edge list --
    // crashing writeJson with "TypeError: cannot serialize Object", because
    // grouped() (document.ts) built its output object via a plain {} literal:
    // out["__proto__"] = value reassigns the built object's own prototype
    // rather than creating a property, so the corrupted object then fails
    // isPlainRecord's Object.getPrototypeOf check inside serialize(). Fixed
    // by grouped() using Object.create(null); this pins the exact reported
    // counterexample as a permanent regression rather than relying on
    // fast-check's random seed to rediscover it.
    const node: Node = [{ label: " ", target: [{ label: "__proto__", target: [] }] }];
    expect(() => writeJson(node)).not.toThrow();
    expect(writeJson(node)).toBe('{" ": {"__proto__": {}}}');
  });
});

describe("checkWriteDepth is a real, reachable guard (issue #37)", () => {
  // issue #77: MAX_NODES boundary -- a shallow-but-wide document (one label
  // repeated many times) must still be rejected once its total node count
  // exceeds the limit, even though it never comes close to MAX_DEPTH.
  // Explicit longer timeout: genuinely just slow (~3s to build/parse a
  // million-node document), not a hang -- bumped when vitest 2 -> 4 (#103)
  // pushed this past the 5000ms default in a full-suite run.
  it(
    "readJson accepts a document at exactly MAX_NODES (1,000,000) nodes",
    () => {
      const k = 999_999;
      const arr = Array.from({ length: k }, (_, i) => i);
      const text = JSON.stringify({ x: arr });
      expect(() => readJson(text)).not.toThrow();
    },
    20000,
  );

  it(
    "readJson rejects a document one node over MAX_NODES",
    () => {
      const k = 1_000_000;
      const arr = Array.from({ length: k }, (_, i) => i);
      const text = JSON.stringify({ x: arr });
      expect(() => readJson(text)).toThrow(/node count exceeds the maximum \(1000000\)/);
    },
    20000,
  );

  it("writeJson rejects a hand-built Node deeper than MAX_DEPTH", () => {
    // writeJson takes a raw Node (a publicly exported type), so a caller
    // can hand-build one deeper than buildNode() would ever allow --
    // this is not a dormant defensive backstop, it is a live guard. See
    // src/document.ts's Doc.add()/Doc.set() fix (issue #37) for the
    // related bug where this was previously reachable via the public
    // mutation API too.
    let node: Node = 1;
    for (let i = 0; i < 250; i++) {
      node = [{ label: "a", target: node }];
    }
    expect(() => writeJson(node)).toThrow(/nesting exceeds the maximum depth \(200\)/);
  });
});

describe("over-large integer literal (issue #54)", () => {
  it("raises ParseError instead of silently producing Infinity", () => {
    const text = '{"a": ' + "1".repeat(4301) + "}";
    expect(() => readJson(text)).toThrow(ParseError);
    expect(() => readJson(text)).toThrow(/digit/);
  });

  it("does not reject a legitimately-overflowing float literal (1e400)", () => {
    // 1e400 overflows float64 to Infinity on both this port and Python --
    // matches Python's own behavior, so it must NOT raise. Only an
    // integer-shaped literal past the digit cap should.
    const node = readJson('{"a": 1e400}');
    expect(node).toEqual([{ label: "a", target: Infinity }]);
  });

  it("does not reject a large-but-safe integer", () => {
    const node = readJson('{"a": 12345}');
    expect(node).toEqual([{ label: "a", target: 12345n }]);
  });
});

describe("issue #96: a TimeValue writes as plain text (JSON has no native time syntax)", () => {
  it("writeJson unwraps a TimeValue leaf to its plain text", () => {
    const text = writeJson([{ label: "t", target: new TimeValue("12:00:00") }]);
    expect(text).toBe('{"t": "12:00:00"}');
  });
});
