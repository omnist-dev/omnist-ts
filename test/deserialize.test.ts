import { describe, expect, it } from "vitest";
import { doc, Doc, type Edge, type Node } from "../src/document.js";
import { ParseError } from "../src/errors.js";
import { parseSchema } from "../src/osd.js";
import { readOml } from "../src/oml.js";
import { materialize } from "../src/deserialize.js";
import { TimeValue } from "../src/temporal.js";

// Ported from upstream omnist's tests/test_canonical.py: TestDeserialize
// (schema= materialize path), TestValidateMaterializeAgreement (the
// boundary-spelling subset relevant to deserialization, not validation
// alone -- that's already covered in test/schema.test.ts). This port has
// no read_json/read_yaml/etc. yet, so "schema-directed reads" cases go
// through readOml(text, { schema }) instead, which is what issue #7 wires
// up in src/oml.ts.

function e(label: string, target: Node): Edge {
  return { label, target };
}

describe("materialize: iso strings become Date / numeric exactness", () => {
  const SCHEMA =
    'record R { "d": date, "t": time, "dt": datetime, "n": number, ' +
    '"i": integer, "s": string, "b": boolean }\nroot R';

  it("upgrades iso date/datetime strings to Date, leaves time as a string", () => {
    const s = parseSchema(SCHEMA);
    const node = readOml(
      'd: "2024-01-01"\nt: "12:00:00"\ndt: "2024-01-01T10:00:00"\nn: 1\ni: 1\ns: "x"\nb: true\n',
      { schema: s },
    ) as Edge[];
    const values = new Map(node.map((edge) => [edge.label, edge.target]));
    expect(values.get("d")).toEqual(new Date(Date.UTC(2024, 0, 1)));
    expect(values.get("t")).toEqual(new TimeValue("12:00:00"));
    expect(values.get("dt")).toEqual(new Date(Date.UTC(2024, 0, 1, 10, 0, 0)));
  });

  it("numeric exactness both directions", () => {
    const s = parseSchema('record R { "n": number, "i": integer }\nroot R');
    const node = readOml("n: 3\ni: 4\n", { schema: s }) as Edge[];
    const values = new Map(node.map((edge) => [edge.label, edge.target]));
    expect(values.get("n")).toBe(3);
    expect(values.get("i")).toBe(4);
  });

  it("inexact numeric conversion raises", () => {
    const s = parseSchema('record R { "i": integer }\nroot R');
    expect(() => readOml("i: 4.5\n", { schema: s })).toThrow(ParseError);
  });

  it("unparseable value raises", () => {
    const s = parseSchema(SCHEMA);
    expect(() =>
      readOml(
        'd: 1\nt: "12:00:00"\ndt: "x"\nn: 1\ni: 1\ns: "x"\nb: true\n',
        { schema: s },
      ),
    ).toThrow(ParseError);
  });

  it("already-typed values pass through materialize unchanged", () => {
    const s = parseSchema(SCHEMA);
    const node = readOml(
      'd: "2024-01-01"\nt: "12:00:00"\ndt: "2024-01-01T10:00:00"\nn: 1\ni: 1\ns: "x"\nb: true\n',
      { schema: s },
    );
    const again = materialize(node, s);
    expect(again).toEqual(node);
  });
});

describe("materialize: shape and cardinality errors", () => {
  it("unknown field raises; no schema leaves the node unchanged", () => {
    const s = parseSchema('record R { "a": integer }\nroot R');
    expect(() => readOml('a: 1\nb: "extra"\n', { schema: s })).toThrow(/unexpected field/);
    expect(readOml("a: 1\n")).toEqual([e("a", 1)]);
  });

  it("shape mismatches raise (record expected got scalar, and vice versa)", () => {
    const s = parseSchema('record R { "a": R2 }\nrecord R2 { "x": integer }\nroot R');
    expect(() => materialize([e("a", 5)], s)).toThrow(/expected an object/);
    const s2 = parseSchema('record R { "a": integer }\nroot R');
    expect(() => materialize([e("a", [e("x", 1)])], s2)).toThrow(/expected a integer value/);
  });

  it("missing field raises", () => {
    const s = parseSchema('record R { "a": integer }\nroot R');
    expect(() => materialize([], s)).toThrow(/exactly 1/);
  });

  it("multiple problems are all reported together", () => {
    const s = parseSchema('record R { "a": integer, "b": string }\nroot R');
    let caught: ParseError | undefined;
    try {
      materialize([e("a", "x"), e("c", 1)], s);
    } catch (err) {
      caught = err as ParseError;
    }
    expect(caught).toBeInstanceOf(ParseError);
    const msg = String(caught?.message);
    expect(msg).toContain("unexpected field"); // "c"
    expect(msg).toContain("cannot be read as integer"); // "a"
    expect(msg).toContain("exactly 1"); // missing "b"
  });

  it("structured errors are exposed on ParseError.errors", () => {
    const s = parseSchema('record R { "a": integer, "b": string }\nroot R');
    let caught: ParseError | undefined;
    try {
      materialize([e("a", "x"), e("c", 1)], s);
    } catch (err) {
      caught = err as ParseError;
    }
    expect(caught).toBeInstanceOf(ParseError);
    const errors = caught?.errors ?? [];
    expect(errors).toHaveLength(3);
    const codes = new Set(errors.map((err) => err.code));
    expect(codes).toEqual(new Set(["type-mismatch", "unexpected-field", "cardinality"]));
    expect(errors.every((err) => err.path.startsWith("$"))).toBe(true);
    expect(errors.every((err) => typeof err.message === "string" && err.message.length > 0)).toBe(
      true,
    );
  });

  it("a format-syntax ParseError has empty structured errors", () => {
    let caught: ParseError | undefined;
    try {
      readOml("a: `");
    } catch (err) {
      caught = err as ParseError;
    }
    expect(caught).toBeInstanceOf(ParseError);
    expect(caught?.errors).toEqual([]);
  });
});

describe("materialize: scalar type-mismatch fallthrough", () => {
  it("a non-string value never satisfies string", () => {
    const s = parseSchema('record R { "s": string }\nroot R');
    expect(() => materialize([e("s", 1)], s)).toThrow(/cannot be read as string/);
  });

  it("a non-boolean value never satisfies boolean", () => {
    const s = parseSchema('record R { "b": boolean }\nroot R');
    expect(() => materialize([e("b", "x")], s)).toThrow(/cannot be read as boolean/);
  });
});

describe("materialize: boolean never satisfies integer/number", () => {
  it("rejects a boolean for integer and number fields", () => {
    const s = parseSchema('record R { "i": integer, "n": number }\nroot R');
    expect(() => materialize([e("i", true)], s)).toThrow(ParseError);
    expect(() => materialize([e("n", true)], s)).toThrow(ParseError);
  });
});

describe("materialize: date/time/datetime mutual exclusion (string form)", () => {
  it("bare date string never satisfies datetime", () => {
    const s = parseSchema('record R { "dt": datetime }\nroot R');
    expect(() => materialize([e("dt", "2024-01-01")], s)).toThrow(ParseError);
  });

  it("documented spellings still upgrade", () => {
    const s = parseSchema('record R { "d": date, "t": time, "dt": datetime }\nroot R');
    const node = materialize(
      [e("d", "2024-01-01"), e("t", "12:00:00"), e("dt", "2024-01-01T12:00:00")],
      s,
    ) as Edge[];
    const values = new Map(node.map((edge) => [edge.label, edge.target]));
    expect(values.get("d")).toEqual(new Date(Date.UTC(2024, 0, 1)));
    expect(values.get("t")).toEqual(new TimeValue("12:00:00"));
    expect(values.get("dt")).toEqual(new Date(Date.UTC(2024, 0, 1, 12, 0, 0)));
  });

  it("basic-format date is rejected", () => {
    const s = parseSchema('record R { "d": date }\nroot R');
    expect(() => materialize([e("d", "20240101")], s)).toThrow(/not a value-exact conversion/);
  });

  it("week-date is rejected", () => {
    const s = parseSchema('record R { "d": date }\nroot R');
    expect(() => materialize([e("d", "2024-W01-1")], s)).toThrow(ParseError);
  });

  it("basic-format time is rejected", () => {
    const s = parseSchema('record R { "t": time }\nroot R');
    expect(() => materialize([e("t", "120000")], s)).toThrow(ParseError);
  });

  it("basic-format datetime is rejected", () => {
    const s = parseSchema('record R { "dt": datetime }\nroot R');
    expect(() => materialize([e("dt", "20240101T120000")], s)).toThrow(ParseError);
  });

  it("space-separated datetime is rejected", () => {
    const s = parseSchema('record R { "dt": datetime }\nroot R');
    expect(() => materialize([e("dt", "2024-01-01 12:00:00")], s)).toThrow(ParseError);
  });
});

describe("materialize: any field and repeated-label paths", () => {
  it("an any-typed field passes its value through unchanged", () => {
    const s = parseSchema('record R { "a": any }\nroot R');
    const node = materialize([e("a", 5)], s) as Edge[];
    expect(node).toEqual([e("a", 5)]);
  });

  it("a second occurrence of an array field gets an indexed path on error", () => {
    const s = parseSchema('record R { "xs" [0,]: integer }\nroot R');
    let caught: ParseError | undefined;
    try {
      materialize([e("xs", 1), e("xs", "not an int")], s);
    } catch (err) {
      caught = err as ParseError;
    }
    expect(caught).toBeInstanceOf(ParseError);
    expect(caught?.errors.some((issue) => issue.path === "$.xs[1]")).toBe(true);
  });
});

describe("materialize: null handling", () => {
  it("non-nullable scalar receiving null raises null-not-allowed", () => {
    const s = parseSchema('record R { "x": string }\nroot R');
    expect(() => readOml('x: null\n', { schema: s })).toThrow(/null not allowed/);
  });

  it("nullable scalar receiving null passes through untouched", () => {
    const s2 = parseSchema('record R { "x": string? }\nroot R');
    const node = readOml('x: null\n', { schema: s2 });
    expect(node).toEqual([e("x", null)]);
  });
});

describe("materialize/validate boundary-spelling agreement (deserialization subset)", () => {
  // #157/S3-equivalent: validate() and materialize() must agree at the
  // ISO-8601-basic-format/week-date boundary, not just happen to.
  const BOUNDARY_SPELLINGS = [
    "2024-01-01", // documented date -- both accept
    "20240101", // ISO basic format -- both must reject
    "2024-W01-1", // ISO week date -- both must reject
    "12:00:00", // documented time, but not a `date`
    "120000", // ISO basic format time -- both must reject
    "2024-01-01T12:00:00", // documented datetime, but not a bare `date`
    "20240101T120000", // ISO basic format datetime -- both must reject
    "2024-01-01 12:00:00", // space-separated -- rejected (docs require 'T')
    "not-a-date-at-all",
  ];

  it.each(["date", "time", "datetime"] as const)(
    "validate() and materialize() agree on every boundary spelling for %s",
    (kind) => {
      const s = parseSchema(`record R { "v": ${kind} }\nroot R`);
      for (const spelling of BOUNDARY_SPELLINGS) {
        const validates = s.validate(doc({ v: spelling })).ok;
        let materializes: boolean;
        try {
          materialize([e("v", spelling)], s);
          materializes = true;
        } catch (err) {
          if (!(err instanceof ParseError)) throw err;
          materializes = false;
        }
        expect(materializes).toBe(validates);
      }
    },
  );
});

describe("materialize: a Date instance is checked against the field's kind, not passed through unconditionally", () => {
  // Reproduces the gap found in independent review of PR #21: readOml's
  // DATE/DATETIME tokenizer branch (oml.ts) already calls
  // parseDateToken/parseDatetimeToken directly, tagging the resulting Date
  // via temporal.ts's WeakMap (issue #14) before materializeTemporal ever
  // sees it. Pre-fix, materializeTemporal's `if (value instanceof Date)
  // return value;` passed every Date through unconditionally, regardless of
  // its tag, so a `date`-tagged Date silently satisfied a `datetime`-typed
  // field at materialize/readOml time -- then failed re-validation against
  // that same schema, breaking materialize's documented guarantee that
  // "validate and materialize can never disagree".
  it("a bare DATE token read against a datetime-typed schema raises, not silently passes through", () => {
    const schema = parseSchema('record R { "x": datetime }\nroot R');
    expect(() => readOml("x: 2024-01-01\n", { schema })).toThrow(ParseError);
    expect(() => readOml("x: 2024-01-01\n", { schema })).toThrow(
      /cannot be read as datetime/,
    );
  });

  it("a bare DATETIME token read against a date-typed schema raises, not silently passes through", () => {
    const schema = parseSchema('record R { "x": date }\nroot R');
    expect(() => readOml("x: 2024-01-01T10:00:00\n", { schema })).toThrow(ParseError);
  });

  it("materialize never lets a mistagged Date through: the result always still validates", () => {
    const dateSchema = parseSchema('record R { "x": date }\nroot R');
    const datetimeSchema = parseSchema('record R { "x": datetime }\nroot R');
    const node = readOml("x: 2024-01-01\n", { schema: dateSchema });
    const d = new Doc(node);
    expect(dateSchema.validate(d).ok).toBe(true);
    // Pre-fix, this used to return `{ ok: false }` after materialize had
    // already accepted the value silently -- now materialize itself raises
    // before we ever get here, so this assertion documents the fixed
    // invariant (materialize's output always validates against the schema
    // materialize was given) rather than exercising the mismatch directly.
    expect(datetimeSchema.validate(d).ok).toBe(false);
  });

  it("an untagged, bare Date (constructed outside any schema-directed parse) still passes through for either kind", () => {
    // No signal to resolve the ambiguity from -- this is the documented,
    // accepted residual limitation (see temporal.ts file-top comment and
    // deserialize.ts's materializeTemporal), not a bug.
    const dateSchema = parseSchema('record R { "x": date }\nroot R');
    const datetimeSchema = parseSchema('record R { "x": datetime }\nroot R');
    const bare = new Date("2024-01-01T00:00:00Z");
    expect(materialize([e("x", bare)], dateSchema)).toEqual([e("x", bare)]);
    expect(materialize([e("x", bare)], datetimeSchema)).toEqual([e("x", bare)]);
  });
});

describe("issue #49: validate/materialize agreement on a calendar-invalid date", () => {
  // The stated invariant (file header, and `materializeTemporal`'s own comment)
  // is that `validate` and `materialize` can never disagree on whether a
  // string upgrades. They did: `matchesKind` deferred to `Date.parse`, which
  // rolls a day overflow forward, while `materialize` additionally called
  // `parseDateToken`, which is calendar-validated.
  const CALENDAR_INVALID = ["2024-02-30", "2023-02-29", "2024-04-31"];

  it("validate() rejects a calendar-invalid date, as materialize() already did", () => {
    const s = parseSchema('record R { "d": date }\nroot R');
    for (const v of CALENDAR_INVALID) {
      expect(s.validate(doc({ d: v })).ok).toBe(false);
      expect(() => materialize([e("d", v)], s)).toThrow(ParseError);
    }
  });

  it("validate() and materialize() agree for the datetime spelling too", () => {
    const s = parseSchema('record R { "dt": datetime }\nroot R');
    for (const v of CALENDAR_INVALID) {
      const spelling = `${v}T00:00:00`;
      expect(s.validate(doc({ dt: spelling })).ok).toBe(false);
      expect(() => materialize([e("dt", spelling)], s)).toThrow(ParseError);
    }
  });
});

describe("issue #50: validate/materialize agreement on hour 24", () => {
  it("rejects 24:00 in a time field on both paths", () => {
    const s = parseSchema('record R { "t": time }\nroot R');
    for (const v of ["24:00", "24:00:00"]) {
      expect(s.validate(doc({ t: v })).ok).toBe(false);
      expect(() => materialize([e("t", v)], s)).toThrow(ParseError);
    }
  });

  it("readOml with a schema rejects it as well, matching the bare tokenizer", () => {
    const s = parseSchema('record R { "t": time }\nroot R');
    expect(() => readOml('t: "24:00"', { schema: s })).toThrow(ParseError);
    expect(() => readOml("t: 24:00")).toThrow(ParseError);
  });
});

describe("issue #96: materialize upgrades a time field to a TimeValue, not a plain string", () => {
  it("a schema-directed materialize of a time field produces a TimeValue", () => {
    const s = parseSchema('record R { "t": time }\nroot R');
    const node = materialize([e("t", "12:00:00")], s);
    expect(node).toEqual([e("t", new TimeValue("12:00:00"))]);
  });

  it("a TimeValue compares equal to its plain-string form in Document equality", () => {
    const s = parseSchema('record R { "t": time }\nroot R');
    const materialized = new Doc(materialize([e("t", "12:00:00")], s));
    const plain = doc({ t: "12:00:00" });
    expect(materialized.equals(plain)).toBe(true);
  });

  it("the materialized TimeValue still re-validates against the same schema", () => {
    const s = parseSchema('record R { "t": time }\nroot R');
    const node = materialize([e("t", "12:00:00")], s);
    expect(s.validate(new Doc(node)).ok).toBe(true);
  });
});

describe("issue #96: a TimeValue that no longer matches a field's declared kind is rejected", () => {
  it("re-materializing an already-tagged TimeValue against a mismatched date field fails", () => {
    const timeSchema = parseSchema('record R { "t": time }\nroot R');
    const dateSchema = parseSchema('record R { "t": date }\nroot R');
    const node = materialize([e("t", "12:00:00")], timeSchema); // node.t is now a TimeValue
    expect(() => materialize(node, dateSchema)).toThrow(ParseError);
  });
});
