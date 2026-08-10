/**
 * Characterization tests backing `docs/python-parity.md`.
 *
 * Every claim on that page that is not a plain code citation is pinned
 * here, so the report cannot silently rot: the "confirmed identical"
 * claims assert the behavior both implementations share, and the
 * divergence/gap claims assert *this port*'s current behavior with the
 * Python result recorded alongside in a comment. When a gap is fixed, the
 * corresponding test here is the one that has to change -- which is the
 * signal to update the report.
 *
 * The Python-side results quoted in comments were produced by running the
 * equivalent call against `omnist` 0.7.8 (see the PR for issue #48).
 */
import { describe, expect, it } from "vitest";
import { Doc, buildNode } from "../src/document.js";
import { materialize } from "../src/deserialize.js";
import { ParseError } from "../src/errors.js";
import {
  checkXml,
  matchesKind,
  parseSchema,
  readJson,
  readOml,
  readToml,
  readXml,
  readYaml,
  toOsd,
  valueKind,
  writeOml,
  writeToml,
} from "../src/index.js";
import { lint } from "../src/ops/lint.js";
import { prune } from "../src/ops/prune.js";
import { parseDateToken, TimeValue } from "../src/temporal.js";

describe("depth boundary (report: Confirmed identical -- Document model)", () => {
  const nestJson = (n: number): string => {
    let o: unknown = 1;
    for (let i = 0; i < n; i++) o = { a: o };
    return JSON.stringify(o);
  };
  const nestOml = (n: number): string => {
    let s = "1";
    for (let i = 0; i < n; i++) s = "{ a: " + s + " }";
    return s;
  };
  const nestXml = (n: number): string => {
    let s = "1";
    for (let i = 0; i < n; i++) s = "<a>" + s + "</a>";
    return s;
  };

  it("JSON and OML both accept 200 levels and reject 201, matching Python", () => {
    expect(() => readJson(nestJson(200))).not.toThrow();
    expect(() => readJson(nestJson(201))).toThrow();
    expect(() => readOml(nestOml(200))).not.toThrow();
    expect(() => readOml(nestOml(201))).toThrow();
  });

  it("XML accepts 201 levels -- the same off-by-one Python has, not a port bug", () => {
    expect(() => readXml(nestXml(201))).not.toThrow();
    expect(() => readXml(nestXml(202))).toThrow();
  });
});

describe("fixed (issue #49): calendar-invalid temporal strings are rejected", () => {
  it("rejects a nonexistent calendar date as date and datetime, matching Python", () => {
    expect(matchesKind("2024-02-30", "date")).toBe(false);
    expect(matchesKind("2024-02-30T00:00", "datetime")).toBe(false);
    // The out-of-range month/day cases were rejected before the fix too.
    expect(matchesKind("2024-13-01", "date")).toBe(false);
    expect(matchesKind("2024-01-32", "date")).toBe(false);
  });

  it("validate and materialize now agree, as deserialize.ts claims they must", () => {
    const s = parseSchema('record R { "d": date }\nroot R');
    expect(s.validate(Doc.of({ d: "2024-02-30" })).ok).toBe(false);
    expect(() => materialize(buildNode({ d: "2024-02-30" }), s)).toThrow(ParseError);
  });
});

describe("fixed (issue #50): hour 24 is not a valid time", () => {
  it("rejects 24:00 / 24:00:00, matching Python's time.fromisoformat", () => {
    expect(matchesKind("24:00", "time")).toBe(false);
    expect(matchesKind("24:00:00", "time")).toBe(false);
    // The OML tokenizer, which shares the documented spelling, rejected it all
    // along -- that disagreement between the two layers was the gap.
    expect(() => readOml("a: 24:00")).toThrow();
  });
});

describe("fixed (issue #51): writeOml preserves a UTC offset", () => {
  it("round-trips an offset datetime verbatim, as Python does", () => {
    expect(writeOml(readOml("a: 2024-01-01T12:00:00-08:00"))).toBe(
      "a: 2024-01-01T12:00:00-08:00",
    );
    expect(writeOml(readOml("a: 2024-01-01T12:00:00+00:00"))).toBe(
      "a: 2024-01-01T12:00:00+00:00",
    );
  });

  it("TOML preserves local-vs-offset, per issue #26", () => {
    expect(writeToml(readToml("a = 2024-01-01T12:00:00"))).toBe("a = 2024-01-01T12:00:00.000\n");
    expect(writeToml(readToml("a = 2024-01-01T12:00:00Z"))).toBe("a = 2024-01-01T12:00:00.000Z\n");
  });
});

describe("fixed (issue #52): an OML TIME literal round-trips", () => {
  it("re-emits a bare time as a TIME token, not a quoted string", () => {
    // A genuinely time-kinded value is a `TimeValue` wrapper at the Document
    // layer (issue #96), not a plain string -- JS has no bare time-of-day
    // type, so `TimeValue` gives it the same kind of real identity `Date`
    // already has for date/datetime. The OML text is stable across a
    // read/write cycle either way.
    expect(readOml("a: 12:00")).toEqual([{ label: "a", target: new TimeValue("12:00") }]);
    expect(writeOml(readOml("a: 12:00"))).toBe("a: 12:00");
    // Python normalizes the spelling to `a: 12:00:00`, having parsed the token
    // into a `datetime.time`; this port writes the token text back verbatim,
    // which is text-stable and not an observable value difference.
  });
});

describe("fixed (issue #88, matches Python's #288): schema-less XML no longer coerces element text by shape at all", () => {
  it("leaves every numeric/boolean-looking spelling as a string on a schema-less read, agreeing with Python's post-#288 behavior", () => {
    // Before #88, this port's readXml coerced "+5"-shaped text to a number
    // (INT_RE/FLOAT_RE) while deliberately NOT accepting Python's own
    // int()/float() literal syntax ("nan"/"inf"/"infinity"/"1_0") -- a
    // documented, narrower-than-Python divergence. #288 (the Python port's
    // fix) removed shape-based coercion from read_xml's schema-less path
    // entirely; #88 does the same here, so there is no longer a
    // numeric-coercion gap to characterize at all -- every one of these
    // spellings, on both ports, now stays a string absent a schema.
    for (const s of ["nan", "inf", "1_0", "infinity", "+5", "30"]) {
      expect(readXml("<r><a>" + s + "</a></r>")).toEqual([
        { label: "r", target: [{ label: "a", target: s }] },
      ]);
      expect(checkXml([{ label: "r", target: [{ label: "a", target: s }] }]).adjustments).toEqual(
        [],
      );
    }
  });
});

describe("fixed: integer-literal limits (issue #54)", () => {
  const big = "1".repeat(4301);

  it("JSON/YAML now raise ParseError past the 4300-digit cap, matching CPython's int_max_str_digits, instead of silently yielding Infinity", () => {
    expect(() => readJson('{"a": ' + big + "}")).toThrow(ParseError);
    expect(() => readYaml("a: " + big)).toThrow(ParseError);
  });

  it("TOML now accepts an integer past 2^53 exactly, matching Python (issue #98 -- was previously an accepted structural limitation, issue #25)", () => {
    // Was: readToml("a = 9007199254740993") threw ParseError, since
    // TOML integers went through JS `number` (float64) and smol-toml
    // rejected anything past the safe-integer range outright. Since
    // issue #98, TOML integers are bigint-backed (smol-toml's own
    // integersAsBigInt mode), so this now round-trips exactly, the
    // same as Python -- no divergence left to document.
    const node = readToml("a = 9007199254740993");
    expect(node).toEqual([{ label: "a", target: 9007199254740993n }]);
  });
});

describe("divergence: reader strictness JSON/YAML inherit from their parsers", () => {
  it("rejects JSON non-standard NaN/Infinity literals (Python accepts)", () => {
    expect(() => readJson('{"a": NaN}')).toThrow(ParseError);
    expect(() => readJson('{"a": Infinity}')).toThrow(ParseError);
  });

  it("rejects a duplicate YAML mapping key (Python: last one wins)", () => {
    expect(() => readYaml("{a: 1, a: 2}")).toThrow(ParseError);
  });
});

describe("fixed: integer/number kind distinction now matches Python (issues #3, #14, #98)", () => {
  it("matches_kind/value_kind tell integer and number apart natively, no shape-guessing", () => {
    // Was: matchesKind(1.0, "integer") was true and valueKind(1.0) was
    // "integer" (JS has one `number` type, so a whole-valued float was
    // indistinguishable from an integer -- omnist-spec ledger D-6).
    // Python: matches_kind(1.0, "integer") is False; value_kind(1.0) is
    // "number". Since issue #98, integer-kinded values are bigint-backed,
    // so the same holds here now: a plain `number`, even a whole one,
    // never satisfies "integer".
    expect(matchesKind(1.0, "integer")).toBe(false);
    expect(valueKind(1.0)).toBe("number");
    expect(matchesKind(1n, "integer")).toBe(true);
    expect(valueKind(1n)).toBe("integer");
    expect(readJson('{"a": 1.0}')).toEqual([{ label: "a", target: 1.0 }]);
    expect(readJson('{"a": 1}')).toEqual([{ label: "a", target: 1n }]);
  });
});

describe("fixed: deterministic-output ordering now matches Python (issue #56)", () => {
  it("lint now sorts locations by codepoint, matching Python's sorted()", () => {
    const s = parseSchema(
      'record R { "a": string }\nrecord aaa { "b": string }\nrecord B { "c": string }\nroot R',
    );
    // Python: ["B", "aaa"] (codepoint order -- uppercase first).
    expect(lint(s).map((f) => f.location)).toEqual(["B", "aaa"]);
  });

  it("prune now preserves the input schema's declared order (Python's own equivalent is non-deterministic, PYTHONHASHSEED-dependent -- see omnist-dev/omnist#253)", () => {
    const s = parseSchema(
      'record A { "x": string }\nrecord B { "x": string }\nrecord R { "p": A, "q": B }\nroot R',
    );
    expect([...prune(s).env.keys()]).toEqual(["A", "B", "R"]);
    expect(toOsd(prune(s), { indent: null }).trim()).toContain("record R {");
  });
});

describe("divergence: documented scalar collapses (issues #3, #14)", () => {

  it("a tagged Date is kind-exclusive, an untagged one is not", () => {
    const tagged = parseDateToken("2024-01-01") as Date;
    expect(matchesKind(tagged, "date")).toBe(true);
    expect(matchesKind(tagged, "datetime")).toBe(false);
    const bare = new Date(Date.UTC(2024, 0, 1));
    expect(matchesKind(bare, "date")).toBe(true);
    expect(matchesKind(bare, "datetime")).toBe(true);
  });

  it("valueKind reports a date-tagged Date as datetime", () => {
    // Python: value_kind(datetime.date(2024,1,1)) == "date".
    expect(valueKind(parseDateToken("2024-01-01"))).toBe("datetime");
  });

  it("a time is an ordinary string at the Document layer", () => {
    expect(readToml("a = 12:00:00")).toEqual([{ label: "a", target: "12:00:00" }]);
    expect(writeToml(readToml("a = 12:00:00"))).toBe('a = "12:00:00"\n');
  });
});

describe("divergence: error-path formatting for a non-ASCII key", () => {
  it("brackets a key Python str.isidentifier() would dot", () => {
    // Python emits a dotted path for an identifier-shaped non-ASCII key.
    expect(() => buildNode({ ["caf" + String.fromCharCode(0xe9)]: new Set() })).toThrow(
      /^\$\["caf/,
    );
  });
});
