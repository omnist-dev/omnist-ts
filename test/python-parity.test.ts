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
import { parseDateToken } from "../src/temporal.js";

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

describe("gap: calendar-invalid temporal strings pass matchesKind", () => {
  it("accepts a nonexistent calendar date as date (Python: false)", () => {
    expect(matchesKind("2024-02-30", "date")).toBe(true);
    expect(matchesKind("2024-02-30T00:00", "datetime")).toBe(true);
    // The out-of-range month/day cases Date.parse does reject stay rejected,
    // so the hole is specifically day-overflow inside a real month.
    expect(matchesKind("2024-13-01", "date")).toBe(false);
    expect(matchesKind("2024-01-32", "date")).toBe(false);
  });

  it("validate accepts what materialize rejects, contradicting deserialize.ts", () => {
    const s = parseSchema('record R { "d": date }\nroot R');
    expect(s.validate(Doc.of({ d: "2024-02-30" })).ok).toBe(true);
    expect(() => materialize(buildNode({ d: "2024-02-30" }), s)).toThrow(ParseError);
  });
});

describe("gap: matchesKind accepts hour 24 as time", () => {
  it("accepts 24:00 / 24:00:00 (Python: false, via time.fromisoformat)", () => {
    expect(matchesKind("24:00", "time")).toBe(true);
    expect(matchesKind("24:00:00", "time")).toBe(true);
    // The OML tokenizer, which shares the documented spelling, rejects it.
    expect(() => readOml("a: 24:00")).toThrow();
  });
});

describe("gap: writeOml erases a UTC offset (issue #26 fixed only for TOML)", () => {
  it("rewrites an offset datetime as an offset-less one", () => {
    // Python round-trips `a: 2024-01-01T12:00:00-08:00` verbatim.
    expect(writeOml(readOml("a: 2024-01-01T12:00:00-08:00"))).toBe("a: 2024-01-01T20:00:00");
    expect(writeOml(readOml("a: 2024-01-01T12:00:00+00:00"))).toBe("a: 2024-01-01T12:00:00");
  });

  it("TOML does preserve local-vs-offset, per issue #26", () => {
    expect(writeToml(readToml("a = 2024-01-01T12:00:00"))).toBe("a = 2024-01-01T12:00:00.000\n");
    expect(writeToml(readToml("a = 2024-01-01T12:00:00Z"))).toBe("a = 2024-01-01T12:00:00.000Z\n");
  });
});

describe("gap: an OML TIME literal does not round-trip", () => {
  it("re-emits a bare time as a quoted string (Python: a: 12:00:00)", () => {
    expect(readOml("a: 12:00")).toEqual([{ label: "a", target: "12:00" }]);
    expect(writeOml(readOml("a: 12:00"))).toBe('a: "12:00"');
  });
});

describe("gap: XML scalar coercion is narrower than Python int()/float()", () => {
  it("leaves Python-only numeric spellings as strings, and omits string.ambiguous", () => {
    for (const s of ["nan", "inf", "1_0", "infinity"]) {
      // Python read_xml coerces all four (nan/inf to floats, "1_0" to 10).
      expect(readXml("<r><a>" + s + "</a></r>")).toEqual([
        { label: "r", target: [{ label: "a", target: s }] },
      ]);
      expect(checkXml([{ label: "r", target: [{ label: "a", target: s }] }]).adjustments).toEqual(
        [],
      );
    }
    // The spellings both implementations agree on still coerce, and are
    // still reported.
    expect(readXml("<r><a>+5</a></r>")).toEqual([
      { label: "r", target: [{ label: "a", target: 5 }] },
    ]);
    expect(
      checkXml([{ label: "r", target: [{ label: "a", target: "+5" }] }]).adjustments.map(
        (a) => a.code,
      ),
    ).toEqual(["string.ambiguous"]);
  });
});

describe("fixed: integer-literal limits (issue #54)", () => {
  const big = "1".repeat(4301);

  it("JSON/YAML now raise ParseError past the 4300-digit cap, matching CPython's int_max_str_digits, instead of silently yielding Infinity", () => {
    expect(() => readJson('{"a": ' + big + "}")).toThrow(ParseError);
    expect(() => readYaml("a: " + big)).toThrow(ParseError);
  });

  it("TOML instead rejects any integer past 2^53, which Python accepts (issue #25, accepted structural limitation)", () => {
    expect(() => readToml("a = 9007199254740993")).toThrow(ParseError);
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
  it("integer/number collapse onto one JS number", () => {
    // Python: matches_kind(1.0, "integer") is False; value_kind(1.0) is "number".
    expect(matchesKind(1.0, "integer")).toBe(true);
    expect(valueKind(1.0)).toBe("integer");
    expect(readJson('{"a": 1.0}')).toEqual([{ label: "a", target: 1 }]);
  });

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
