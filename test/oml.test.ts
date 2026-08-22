import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Doc, type Edge, type Node } from "../src/document.js";
import { TimeValue } from "../src/temporal.js";
import { ParseError } from "../src/errors.js";
import { checkOml, readOml, writeOml } from "../src/oml.js";
import { parseSchema } from "../src/osd.js";
import { field, record, ref, schema, t } from "../src/schema.js";

// Ported from upstream omnist's tests/test_oml.py (issue #5). The Python
// source represents a node's edge list as `[(label, value), ...]` tuples;
// this port's Document model (src/document.ts) uses `Edge[]` (`{ label,
// target }`), so every expected node literal below is built with the `e(...)`
// helper rather than tuple literals. Error assertions match error *type*
// (ParseError) and a stable substring of the message, per the
// message-stability policy established in test/osd.test.ts -- not the exact
// Python text.

function e(label: string, target: Node): Edge {
  return { label, target };
}

/** Indexed access that throws instead of returning `undefined` -- avoids
 * `!` non-null assertions (forbidden by this repo's eslint config) while
 * still satisfying `noUncheckedIndexedAccess`. */
function at<T>(arr: readonly T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`index ${String(i)} out of bounds`);
  return v;
}

// ---------------------------------------------------------------------------
// Happy paths: round-tripping every scalar kind
// ---------------------------------------------------------------------------

describe("scalar round trips", () => {
  it.each([
    ['a: "hello"', [e("a", "hello")]],
    ["a: 42", [e("a", 42n)]],
    ["a: -42", [e("a", -42n)]],
    ["a: 3.14", [e("a", 3.14)]],
    ["a: -3.14", [e("a", -3.14)]],
    ["a: 1e10", [e("a", 1e10)]],
    ["a: 1.5e-3", [e("a", 1.5e-3)]],
    ["a: true", [e("a", true)]],
    ["a: false", [e("a", false)]],
    ["a: null", [e("a", null)]],
    ["a: 2024-01-01", [e("a", new Date(Date.UTC(2024, 0, 1)))]],
    ["a: 12:30:00", [e("a", new TimeValue("12:30:00"))]],
    [
      "a: 2024-01-01T12:30:00",
      [e("a", new Date(Date.UTC(2024, 0, 1, 12, 30, 0)))],
    ],
    ["a: inf", [e("a", Infinity)]],
    ["a: -inf", [e("a", -Infinity)]],
  ] as const)("%s", (src, expected) => {
    const node = readOml(src);
    expect(node).toEqual(expected);
    expect(readOml(writeOml(node))).toEqual(node);
  });

  it("a: nan reads as NaN", () => {
    const node = readOml("a: nan") as Edge[];
    expect(typeof at(node, 0).target).toBe("number");
    expect(Number.isNaN(at(node, 0).target)).toBe(true);
  });
});

it("empty document is an empty edge list", () => {
  expect(readOml("")).toEqual([]);
  expect(readOml("   \n  \n")).toEqual([]);
});

it("CRLF line endings act as separators", () => {
  expect(readOml("a: 1\r\nb: 2\r\n")).toEqual([e("a", 1n), e("b", 2n)]);
});

it("a bare leaf document is a plain scalar", () => {
  expect(readOml("42")).toBe(42n);
  expect(readOml('"just a string"')).toBe("just a string");
});

it("a stray character is a ParseError", () => {
  expect(() => readOml("a: `")).toThrow(/stray character/);
});

it.each(["@", "&", "/", "^", "%", "!", "~", "`", "$"])(
  "stray character %s is rejected",
  (ch) => {
    expect(() => readOml("a: " + ch)).toThrow(ParseError);
  },
);

it("unmatched close bracket is a ParseError", () => {
  expect(() => readOml("a: ]")).toThrow(ParseError);
});

it.each([
  ["a: 2024-13-01", /invalid date/],
  ["a: 25:00:00", /invalid time/],
  ["a: 2024-13-01T00:00:00", /invalid datetime/],
])("invalid temporal literal %s is a ParseError", (src, match) => {
  expect(() => readOml(src)).toThrow(match);
});

// ---------------------------------------------------------------------------
// TS-native temporal parsing edge cases -- not in upstream's test_oml.py
// (Python delegates to datetime.date/time/datetime.fromisoformat; this port
// hand-writes the TIME/DATE/DATETIME grammar's semantic validation, see
// parseDateToken/parseTimeToken/parseDatetimeToken in src/oml.ts), added to
// exercise every branch of that hand-written validation.
// ---------------------------------------------------------------------------

describe("TS-native temporal parsing", () => {
  it("an invalid day-of-month is a ParseError", () => {
    expect(() => readOml("a: 2024-02-30")).toThrow(/invalid date/);
  });

  it("a TIME token with no seconds reads as a TimeValue (issue #96)", () => {
    expect(readOml("a: 12:30")).toEqual([e("a", new TimeValue("12:30"))]);
  });

  it("a TIME token with fractional seconds reads as a TimeValue (issue #96)", () => {
    expect(readOml("a: 12:30:00.500")).toEqual([e("a", new TimeValue("12:30:00.500"))]);
  });

  it("a TIME token with a UTC offset reads as a TimeValue (issue #96)", () => {
    expect(readOml("a: 12:30:00+01:00")).toEqual([e("a", new TimeValue("12:30:00+01:00"))]);
  });

  it("a TIME token with an out-of-range offset is a ParseError", () => {
    expect(() => readOml("a: 12:30:00+99:00")).toThrow(/invalid time/);
  });

  it("a DATETIME token with fractional seconds round-trips its milliseconds", () => {
    const node = readOml("a: 2024-01-01T12:30:00.250") as Edge[];
    const target = at(node, 0).target as Date;
    expect(target.getUTCMilliseconds()).toBe(250);
    expect(writeOml(node)).toBe("a: 2024-01-01T12:30:00.250");
  });

  it("a DATETIME token with a positive UTC offset is normalized to the equivalent UTC instant", () => {
    const node = readOml("a: 2024-01-01T12:30:00+02:00") as Edge[];
    const target = at(node, 0).target as Date;
    expect(target.getTime()).toBe(Date.UTC(2024, 0, 1, 10, 30, 0));
  });

  it("a DATETIME token with a negative UTC offset is normalized to the equivalent UTC instant", () => {
    const node = readOml("a: 2024-01-01T12:30:00-02:00") as Edge[];
    const target = at(node, 0).target as Date;
    expect(target.getTime()).toBe(Date.UTC(2024, 0, 1, 14, 30, 0));
  });

  it("a DATETIME token with an invalid time part is a ParseError", () => {
    expect(() => readOml("a: 2024-01-01T25:00:00")).toThrow(/invalid datetime/);
  });
});

it("repeated labels and interleaving stay as separate edges", () => {
  const node = readOml("a: 1\nb: 2\na: 3\nb: 4\na: 5");
  expect(node).toEqual([e("a", 1n), e("b", 2n), e("a", 3n), e("b", 4n), e("a", 5n)]);
  const d = new Doc(node as Edge[]);
  expect(d.count("a")).toBe(3);
  expect(d.get("a").map((c) => c.value)).toEqual([1n, 3n, 5n]);
});

it("nested braces at arbitrary depth", () => {
  const node = readOml('a: { b: { c: { d: "leaf" } } }');
  expect(node).toEqual([e("a", [e("b", [e("c", [e("d", "leaf")])])])]);
});

it("inline brace style with semicolons", () => {
  expect(readOml("{ a: 1; b: 2 }")).toEqual([e("a", 1n), e("b", 2n)]);
});

it("comments are ignored", () => {
  const node = readOml("# a top comment\na: 1  # trailing comment\nb: 2\n");
  expect(node).toEqual([e("a", 1n), e("b", 2n)]);
});

// ---------------------------------------------------------------------------
// String escaping
// ---------------------------------------------------------------------------

describe("string escaping", () => {
  it("basic escapes", () => {
    const node = readOml('a: "line1\\nline2\\ttabbed\\\\backslash\\"quote"');
    expect(node).toEqual([e("a", 'line1\nline2\ttabbed\\backslash"quote')]);
  });

  it("unicode escape in the BMP (literal utf-8)", () => {
    expect(readOml('a: "\u00e9"')).toEqual([e("a", "\u00e9")]);
  });

  it("astral character via literal UTF-8", () => {
    expect(readOml('a: "\u{1F600}"')).toEqual([e("a", "\u{1F600}")]);
  });

  it("unpaired surrogate escape is rejected", () => {
    expect(() => readOml('a: "\\uD83D"')).toThrow(ParseError);
    expect(() => readOml('a: "\\uDE00"')).toThrow(ParseError);
  });

  it("surrogate pair via \\u escapes combines into one astral char", () => {
    const src = 'a: "\\uD83D\\uDE00"';
    expect(readOml(src)).toEqual([e("a", "\u{1F600}")]);
  });

  it("a non-surrogate \\u escape is returned as-is", () => {
    expect(readOml('a: "\\u0041"')).toEqual([e("a", "A")]);
  });

  it("unterminated escape sequence is rejected", () => {
    expect(() => readOml('a: "\\')).toThrow(/unterminated escape sequence/);
  });

  it("high surrogate followed by a non-low-surrogate is rejected", () => {
    expect(() => readOml('a: "\\uD83DA"')).toThrow(/unpaired high surrogate/);
    expect(() => readOml('a: "\\uD83Dx"')).toThrow(/unpaired high surrogate/);
  });

  it("high surrogate followed by a well-formed non-low-surrogate escape is rejected", () => {
    const src = 'a: "\\uD83D\\u0041"';
    expect(() => readOml(src)).toThrow(/unpaired high surrogate/);
  });

  it("a \\u escape needs exactly 4 hex digits", () => {
    expect(() => readOml('a: "\\u12"')).toThrow(/invalid \\u escape/);
  });

  it("an unknown escape character is rejected", () => {
    expect(() => readOml('a: "\\z"')).toThrow(/invalid escape/);
  });

  it("a literal control character must be escaped", () => {
    expect(() => readOml('a: "tab\there"')).toThrow(ParseError);
  });

  it("the writer emits only the minimal escape set", () => {
    const text = writeOml([e("a", 'has "quotes" and \\backslash\\ and \n newline')]);
    expect(text).toBe('a: "has \\"quotes\\" and \\\\backslash\\\\ and \\n newline"');
    // '/' is never escaped on write even though \/ is accepted on read
    expect(writeOml([e("a", "a/b")])).toBe('a: "a/b"');
    expect(readOml('a: "a\\/b"')).toEqual([e("a", "a/b")]);
  });
});

// ---------------------------------------------------------------------------
// Raw strings (E2)
// ---------------------------------------------------------------------------

describe("raw strings", () => {
  it("no escape processing at all", () => {
    const node = readOml("a: 'C:\\talks\\ada\\slides.key'");
    expect(node).toEqual([e("a", "C:\\talks\\ada\\slides.key")]);
  });

  it("cannot contain an apostrophe", () => {
    expect(() => readOml("a: 'it''s broken'")).toThrow(ParseError);
  });

  it("unterminated raw string is a ParseError", () => {
    expect(() => readOml("a: 'never closed")).toThrow(/unterminated raw string/);
  });

  it("the canonical writer never emits it", () => {
    const node = readOml("a: 'C:\\x'");
    const text = writeOml(node);
    expect(text).not.toContain("'");
    expect(text).toBe('a: "C:\\\\x"');
  });
});

// ---------------------------------------------------------------------------
// Multiline strings (E3) and SEP/newline interaction
// ---------------------------------------------------------------------------

describe("multiline strings", () => {
  it("basic multiline body", () => {
    const node = readOml('a: """\nline one\nline two\n"""');
    expect(node).toEqual([e("a", "line one\nline two\n")]);
  });

  it("leading newline stripped but internal newlines kept", () => {
    const node = readOml('a: """\nx\ny\n"""') as Edge[];
    expect(at(node, 0).target).toBe("x\ny\n");
  });

  it("no leading newline needed", () => {
    expect(readOml('a: """same line start"""')).toEqual([e("a", "same line start")]);
  });

  it("leading CRLF is stripped", () => {
    const node = readOml('a: """\r\nx\n"""') as Edge[];
    expect(at(node, 0).target).toBe("x\n");
  });

  it("unterminated multiline string is a ParseError", () => {
    expect(() => readOml('a: """never closed')).toThrow(/unterminated multiline string/);
  });

  it("a control character in a multiline string must be escaped", () => {
    const src = 'a: """x\ry"""';
    expect(() => readOml(src)).toThrow(/control character/);
  });

  it("internal newlines never act as a separator", () => {
    const node = readOml('a: """\nx\ny\n"""\nb: 1');
    expect(node).toEqual([e("a", "x\ny\n"), e("b", 1n)]);
  });

  it("immediately followed by a label with no SEP is a ParseError", () => {
    expect(() => readOml('a: """\nx\ny\n"""b: 1')).toThrow(ParseError);
  });

  it("followed by a semicolon separator is valid", () => {
    const node = readOml('a: """\nx\ny\n""";b: 1');
    expect(node).toEqual([e("a", "x\ny\n"), e("b", 1n)]);
  });

  it("escapes are still processed inside a multiline string", () => {
    const node = readOml('a: """back\\\\slash and \\"escaped quote\\""""');
    expect(node).toEqual([e("a", 'back\\slash and "escaped quote"')]);
  });

  it.each([
    ['a: """x"""', "x"],
    ['a: """"""', ""],
    ['a: """"x"""', '"x'],
    ['a: """""x"""', '""x'],
  ])("touching quote runs: %s", (src, value) => {
    expect(readOml(src)).toEqual([e("a", value)]);
  });

  it("four touching trailing quotes leaves a dangling unterminated string", () => {
    expect(() => readOml('a: """""""')).toThrow(ParseError);
  });

  it("an escaped quote breaks a terminator run", () => {
    const node = readOml('a: """x\\"""y"""');
    expect(node).toEqual([e("a", 'x"""y')]);
  });

  it("the canonical writer never emits it", () => {
    const node = readOml('a: """\nx\ny\n"""');
    const text = writeOml(node);
    expect(text).not.toContain('"""');
    expect(text).toBe('a: "x\\ny\\n"');
  });
});

// ---------------------------------------------------------------------------
// Top-level brace / structural disambiguation
// ---------------------------------------------------------------------------

describe("top-level structural disambiguation", () => {
  it("a brace must wrap the entire document", () => {
    expect(() => readOml("{ a: 1 }\nb: 2")).toThrow(ParseError);
  });

  it("one set of braces around everything is fine", () => {
    expect(readOml("{ a: 1; b: 2 }")).toEqual([e("a", 1n), e("b", 2n)]);
  });

  it("two bare leaves is an error", () => {
    expect(() => readOml("42\n43")).toThrow(ParseError);
  });

  it("empty braces is an empty node", () => {
    expect(readOml("{ ;;; }")).toEqual([]);
    expect(readOml("{ }")).toEqual([]);
  });

  it("two edges without a separator is an error", () => {
    expect(() => readOml("a: 1 b: 2")).toThrow(ParseError);
  });

  it("two edges with a newline separator is fine", () => {
    expect(readOml("a: 1\nb: 2")).toEqual([e("a", 1n), e("b", 2n)]);
  });
});

// ---------------------------------------------------------------------------
// Structural parse errors inside braces
// ---------------------------------------------------------------------------

describe("structural parse errors inside braces", () => {
  it("missing colon after label", () => {
    expect(() => readOml("{a 1}")).toThrow(/expected ':'/);
  });

  it("non-label token where a label is expected", () => {
    expect(() => readOml("{1: 2}")).toThrow(/expected a label/);
  });

  it("missing closing brace", () => {
    expect(() => readOml("{a: 1")).toThrow(/expected '\}'/);
  });

  it("missing value after colon", () => {
    expect(() => readOml("{a: }")).toThrow(/expected a value/);
  });
});

// ---------------------------------------------------------------------------
// Reserved words and labels
// ---------------------------------------------------------------------------

describe("reserved words and labels", () => {
  it("a reserved word as a bare top-level label parses as a scalar, then errors on trailing content", () => {
    expect(() => readOml("true: 1")).toThrow(ParseError);
  });

  it("a reserved word as a bare label inside braces is an error", () => {
    expect(() => readOml("{a: 1\ntrue: 2}")).toThrow(/reserved word/);
  });

  it("a quoted reserved word label is fine", () => {
    expect(readOml('"true": 1')).toEqual([e("true", 1n)]);
  });

  it("'nullable' is not reserved", () => {
    expect(readOml("nullable: 1")).toEqual([e("nullable", 1n)]);
  });

  it("capitalized NaN is a bare ident, not the keyword", () => {
    expect(() => readOml("a: NaN")).toThrow(ParseError);
    expect(readOml('a: "NaN"')).toEqual([e("a", "NaN")]);
  });

  it.each(["INF", "Inf", "-INF", "-Inf"])(
    "capitalized %s is a bare ident, not the keyword",
    (spelling) => {
      expect(() => readOml(`a: ${spelling}`)).toThrow(ParseError);
      expect(readOml(`a: "${spelling}"`)).toEqual([e("a", spelling)]);
    },
  );

  it("a label cannot start with a digit unless quoted", () => {
    expect(() => readOml("123: 1")).toThrow(ParseError);
    expect(readOml('"123": 1')).toEqual([e("123", 1n)]);
  });

  it("hyphenated labels are allowed", () => {
    expect(readOml("a-b: 1")).toEqual([e("a-b", 1n)]);
  });

  it.each(["inf", "nan", "-inf"])(
    "reserved number spelling %s as a label round-trips",
    (label) => {
      const node = [e(label, 1n)];
      const written = writeOml(node);
      expect(written).toBe(`"${label}": 1`);
      expect(readOml(written)).toEqual(node);
    },
  );
});

// ---------------------------------------------------------------------------
// Numeric edge cases
// ---------------------------------------------------------------------------

describe("numeric edge cases", () => {
  it("negative zero integer is exactly zero", () => {
    const node = readOml("a: -0") as Edge[];
    const target = node[0]?.target;
    expect(target === 0n).toBe(true);
  });

  it("negative zero float is sign-preserving", () => {
    const node = readOml("a: -0.0") as Edge[];
    expect(Object.is(at(node, 0).target, -0)).toBe(true);
  });

  it("integer digit limit is enforced", () => {
    const ok = "9".repeat(4300);
    const node = readOml(`a: ${ok}`) as Edge[];
    expect(at(node, 0).target).toBe(BigInt(ok));
    const tooBig = "9".repeat(4301);
    expect(() => readOml(`a: ${tooBig}`)).toThrow(ParseError);
  });

  it("overflow/underflow are defined, not errors", () => {
    const node = readOml("a: 1e400") as Edge[];
    expect(at(node, 0).target).toBe(Infinity);
    const node2 = readOml("a: 1e-400") as Edge[];
    expect(at(node2, 0).target).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Depth limit
// ---------------------------------------------------------------------------

it("nesting depth limit is enforced", () => {
  const tooDeep = "a: " + "{ b: ".repeat(201) + "1" + " }".repeat(201);
  expect(() => readOml(tooDeep)).toThrow(ParseError);
});

// ---------------------------------------------------------------------------
// BOM / encoding
// ---------------------------------------------------------------------------

it("a leading BOM is ignored", () => {
  expect(readOml("\uFEFFa: 1")).toEqual([e("a", 1n)]);
});

// ---------------------------------------------------------------------------
// Document round-trip: every scalar kind, repeats, interleaving, nesting
// ---------------------------------------------------------------------------

it("a full document round-trips losslessly and never needs an adjustment", () => {
  const node: Node = [
    e("title", "Conference"),
    e("attendee", "Ann"),
    e("session", [e("id", 1n), e("active", true)]),
    e("attendee", "Bob"),
    e("session", [e("id", 2n), e("active", false)]),
    e("when", new Date(Date.UTC(2024, 0, 1, 9, 30))),
    e("opens", "09:00:00"),
    e("on", new Date(Date.UTC(2024, 5, 1))),
    e("price", 29.99),
    e("capacity", 250n),
    e("notes", null),
  ];
  const text = writeOml(node);
  expect(readOml(text)).toEqual(node);
  expect(checkOml(node).adjustments).toEqual([]);
});

// A fixed source exercising every token kind the scanner produces -- the
// "golden" regression fixture, ported from upstream's B1 tokenizer-rewrite
// safety net (issue #155 there).
const GOLDEN_OML = String.raw`# a comment before anything else
plain: "hello \"world\"\n"; raw: 'C:\no\escapes'
multi: """
line one
line two"""
neg-int: -42; big-int: 4300
dec: -3.14; exp: 6.02e23; special: nan; pos-inf: inf; neg-inf: -inf
d: 2024-06-01
t: 09:30:00
dt: 2024-06-01T09:30:00
flags: { on: true; off: false; nothing: null }
nested: { a: { b: { c: "deep" } } }
`;

const GOLDEN_NODE: Node = [
  e("plain", 'hello "world"\n'),
  e("raw", String.raw`C:\no\escapes`),
  e("multi", "line one\nline two"),
  e("neg-int", -42n),
  e("big-int", 4300n),
  e("dec", -3.14),
  e("exp", 6.02e23),
  e("special", NaN),
  e("pos-inf", Infinity),
  e("neg-inf", -Infinity),
  e("d", new Date(Date.UTC(2024, 5, 1))),
  e("t", new TimeValue("09:30:00")),
  e("dt", new Date(Date.UTC(2024, 5, 1, 9, 30, 0))),
  e("flags", [e("on", true), e("off", false), e("nothing", null)]),
  e("nested", [e("a", [e("b", [e("c", "deep")])])]),
];

it("golden mixed-token fixture round-trips", () => {
  const node = readOml(GOLDEN_OML) as Edge[];
  const golden = GOLDEN_NODE as Edge[];
  for (let i = 0; i < golden.length; i++) {
    const got = at(node, i);
    const want = at(golden, i);
    expect(got.label).toBe(want.label);
    if (want.label === "special") {
      expect(typeof got.target).toBe("number");
      expect(Number.isNaN(got.target)).toBe(true);
    } else {
      expect(got.target).toEqual(want.target);
    }
  }
  const rewritten = writeOml(node);
  const reparsed = readOml(rewritten) as Edge[];
  for (let i = 0; i < node.length; i++) {
    const got = at(reparsed, i);
    const want = at(node, i);
    expect(got.label).toBe(want.label);
    if (want.label === "special") {
      expect(typeof got.target).toBe("number");
      expect(Number.isNaN(got.target)).toBe(true);
    } else {
      expect(got.target).toEqual(want.target);
    }
  }
});

// ---------------------------------------------------------------------------
// Schema-directed reads (materialize wiring -- issue #7)
// ---------------------------------------------------------------------------

describe("schema-directed reads", () => {
  it("accepts a schema and leaf-converts via materialize (issue #7)", () => {
    const s = parseSchema('record R { "d": date, "n": number }\nroot R');
    // "d" arrives as an OML DATE token (already a Date); "n" is written as
    // a JSON/YAML-style string here to exercise materialize's own
    // integer/number-exact upgrade, not OML's own literal-number parsing.
    // "n" is declared `number`; materialize always normalizes a
    // number-typed field to a host float (spec Sec7.2), even from an
    // integer-shaped literal -- so it converts to a plain JS `3`,
    // not bigint.
    const node = readOml('d: 2024-01-01\nn: 3', { schema: s });
    expect(node).toEqual([e("d", new Date(Date.UTC(2024, 0, 1))), e("n", 3)]);
  });

  it("leaf-converts an ISO date string (not an OML DATE token) via materialize", () => {
    const s = parseSchema('record R { "d": date }\nroot R');
    const node = readOml('d: "2024-01-01"', { schema: s });
    expect(node).toEqual([e("d", new Date(Date.UTC(2024, 0, 1)))]);
  });

  it("throws when the document does not conform to the schema", () => {
    const s = parseSchema('record R { "d": date }\nroot R');
    expect(() => readOml('d: "not a date"', { schema: s })).toThrow(ParseError);
  });

  it("throws a ParseError with structured errors on a shape mismatch", () => {
    const s = parseSchema('record R { "d": date }\nroot R');
    let caught: ParseError | undefined;
    try {
      readOml('d: "not a date"', { schema: s });
    } catch (err) {
      caught = err as ParseError;
    }
    expect(caught).toBeInstanceOf(ParseError);
    expect(caught?.errors.length).toBeGreaterThan(0);
  });

  it("validates a nested document against a schema after reading", () => {
    const s = parseSchema(
      'record Member { "name": string, "role": string }\n' +
        'record Team { "name": string, "members" [1,]: Member }\nroot Team',
    );
    const node = readOml(
      'name: "Platform"\n' + 'members: {\n' + '  name: "Ann"\n' + '  role: "dev"\n' + '}\n',
      { schema: s },
    );
    expect(s.validate(new Doc(node as Edge[])).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Full real-life document (matches the design doc's worked example)
// ---------------------------------------------------------------------------

const REAL_LIFE_OML = String.raw`
venue: {
    name: "Strange Loop"
    building: {
        address: {
            street: "123 Main St"
            city: "St. Louis"
            country: "US"
        }
        room: "Ballroom A"
    }
}
session: {
    title: "Schema Compatibility, Revisited"
    speaker: {
        name: "Ada Lovelace"
        bio: """
Works on data models and provenance.
Quote: "Hopper said it best".
Path: C:\\talks\\ada\\slides.key
"""
    }
    note: "Recording starts five minutes late."
    note: 'Slides posted after the talk -- path on the laptop: C:\talks\ada\slides.key'
    start: 2024-09-18T14:00:00
    duration: 50
    tags: "schemas"
    tags: "compatibility"
}
attendee_count: 312
virtual: false
`;

it("the real-life worked-example document round-trips", () => {
  const node = readOml(REAL_LIFE_OML);
  const d = new Doc(node as Edge[]);
  expect(d.getOne("venue").getOne("name").value).toBe("Strange Loop");
  const address = d.getOne("venue").getOne("building").getOne("address");
  expect(address.getOne("city").value).toBe("St. Louis");
  const session = d.getOne("session");
  expect(session.get("tags").map((t2) => t2.value)).toEqual(["schemas", "compatibility"]);
  expect(session.get("note").map((n) => n.value)).toEqual([
    "Recording starts five minutes late.",
    "Slides posted after the talk -- path on the laptop: C:\\talks\\ada\\slides.key",
  ]);
  const bio = session.getOne("speaker").getOne("bio").value as string;
  expect(bio.startsWith("Works on data models")).toBe(true);
  expect(bio).toContain('Quote: "Hopper said it best".');
  expect(session.getOne("start").value).toEqual(new Date(Date.UTC(2024, 8, 18, 14, 0, 0)));

  const text = writeOml(node);
  expect(readOml(text)).toEqual(node);
});

it("the real-life document validates against a schema", () => {
  const s = schema(
    "Root",
    {
      Address: record(
        field("street", t.string),
        field("city", t.string),
        field("country", t.string),
      ),
      Building: record(field("address", ref("Address")), field("room", t.string)),
      Venue: record(field("name", t.string), field("building", ref("Building"))),
      Speaker: record(field("name", t.string), field("bio", t.string)),
      Session: record(
        field("title", t.string),
        field("speaker", ref("Speaker")),
        field("note", t.string, 0, null),
        field("start", t.datetime),
        field("duration", t.integer),
        field("tags", t.string, 0, null),
      ),
      Root: record(
        field("venue", ref("Venue")),
        field("session", ref("Session")),
        field("attendee_count", t.integer),
        field("virtual", t.boolean),
      ),
    },
  );
  const d = new Doc(readOml(REAL_LIFE_OML) as Edge[]);
  const result = s.validate(d);
  expect(result.ok).toBe(true);
});

// ---------------------------------------------------------------------------
// writeOml edge cases
// ---------------------------------------------------------------------------

describe("writeOml edge cases", () => {
  it("a bare scalar document", () => {
    expect(writeOml(42)).toBe("42.0");
  });

  it("an empty nested node", () => {
    expect(writeOml([e("a", [])])).toBe("a: {}");
  });

  it("a label needing quotes", () => {
    expect(writeOml([e("a b", 1n)])).toBe('"a b": 1');
  });

  it("a label with a trailing newline is quoted (regression: #170 upstream)", () => {
    const written = writeOml([e("A\n", 1n)]);
    expect(written).toBe('"A\\n": 1');
    expect(readOml(written)).toEqual([e("A\n", 1n)]);
  });

  it("NaN", () => {
    expect(writeOml([e("a", NaN)])).toBe("a: nan");
  });

  it("rejects an unsupported scalar type (object)", () => {
    expect(() => writeOml([e("a", {} as unknown as Node)])).toThrow(/has no OML scalar form/);
  });

  it("rejects an unsupported scalar type (non-object, e.g. undefined)", () => {
    expect(() => writeOml([e("a", undefined as unknown as Node)])).toThrow(
      /undefined has no OML scalar form/,
    );
  });

  it("escapes CR, tab, and other control chars", () => {
    const text = writeOml([e("a", "x\ry\tz\x01")]);
    expect(text).toBe('a: "x\\ry\\tz\\u0001"');
  });
});

// ---------------------------------------------------------------------------
// writeOml(indent: null) -- compact, single-line output
// ---------------------------------------------------------------------------

describe("writeOml(indent: null) compact output", () => {
  it("exact compact string", () => {
    const node = [
      e("name", "Platform"),
      e("members", [e("name", "Ann"), e("role", "dev")]),
      e("members", [e("name", "Bob"), e("role", "pm")]),
    ];
    expect(writeOml(node, { indent: null })).toBe(
      'name: "Platform"; members: { name: "Ann"; role: "dev" }; ' +
        'members: { name: "Bob"; role: "pm" }',
    );
  });

  it("empty nested node", () => {
    expect(writeOml([e("a", [])], { indent: null })).toBe("a: {}");
  });

  it("bare scalar document", () => {
    expect(writeOml(42, { indent: null })).toBe("42.0");
  });

  it.each([
    [
      [
        e("title", "Conference"),
        e("attendee", "Ann"),
        e("session", [e("id", 1n), e("active", true)]),
        e("attendee", "Bob"),
        e("session", [e("id", 2n), e("active", false)]),
        e("when", new Date(Date.UTC(2024, 0, 1, 9, 30))),
        e("price", 29.99),
        e("notes", null),
      ],
    ],
    [[e("a", [e("b", [e("c", 1n)])])]],
    [[e("tag", "x"), e("tag", "y")]],
  ])("compact round-trips: %#", (node) => {
    expect(readOml(writeOml(node as Node, { indent: null }))).toEqual(node);
  });
});

// ---------------------------------------------------------------------------
// [...] array syntax -- pure syntactic sugar for repeated same-label edges.
// ---------------------------------------------------------------------------

describe("array syntax", () => {
  it("worked example: arrays interleave with plain edges", () => {
    const src = 'a: "x"\n' + "b: [1, 2, 3]\n" + "c: true\n" + "b: [4, 5, 6]\n";
    expect(readOml(src)).toEqual([
      e("a", "x"),
      e("b", 1n),
      e("b", 2n),
      e("b", 3n),
      e("c", true),
      e("b", 4n),
      e("b", 5n),
      e("b", 6n),
    ]);
  });

  it("expands to repeated edges, minimal case", () => {
    expect(readOml("b: [1, 2, 3]")).toEqual([e("b", 1n), e("b", 2n), e("b", 3n)]);
  });

  it("array of brace subtrees", () => {
    const src = 'members: [{name: "Ann"}, {name: "Bob"}]';
    expect(readOml(src)).toEqual([
      e("members", [e("name", "Ann")]),
      e("members", [e("name", "Bob")]),
    ]);
  });

  it("a nested array is a ParseError", () => {
    expect(() => readOml("b: [[1,2]]")).toThrow(/nested array/i);
  });

  it("an empty array is a ParseError", () => {
    expect(() => readOml("b: []")).toThrow(/empty array/i);
  });

  it("a trailing comma is legal", () => {
    expect(readOml("b: [1, 2, 3,]")).toEqual([e("b", 1n), e("b", 2n), e("b", 3n)]);
  });

  it("newlines inside brackets are legal and insignificant", () => {
    const src = "b: [\n  1,\n  2,\n  3\n]";
    expect(readOml(src)).toEqual([e("b", 1n), e("b", 2n), e("b", 3n)]);
  });

  it("a bare newline as separator inside brackets is illegal", () => {
    expect(() => readOml("b: [1\n2]")).toThrow(ParseError);
  });

  it("a semicolon as separator inside brackets is illegal", () => {
    expect(() => readOml("b: [1; 2]")).toThrow(ParseError);
  });

  it("comments inside brackets are legal", () => {
    const src = "b: [\n  1, # one\n  2, # two\n]";
    expect(readOml(src)).toEqual([e("b", 1n), e("b", 2n)]);
  });

  it("an array in label position is a ParseError", () => {
    expect(() => readOml("[1, 2]: 3")).toThrow(ParseError);
  });

  it("a bare array at the top level is a ParseError", () => {
    expect(() => readOml("[1, 2, 3]")).toThrow(ParseError);
  });

  it("null elements", () => {
    expect(readOml("b: [1, null, 3]")).toEqual([e("b", 1n), e("b", null), e("b", 3n)]);
  });
});

// ---------------------------------------------------------------------------
// writeOml({ arrays: true }) -- writer support
// ---------------------------------------------------------------------------

const GOLDEN_NODES_FOR_NO_REGRESSION: Node[] = [
  [e("a", "x"), e("b", 1n), e("c", true)],
  [e("tag", "x"), e("tag", "y")],
  [e("a", [e("b", [e("c", 1n)])])],
  [
    e("title", "Conference"),
    e("attendee", "Ann"),
    e("session", [e("id", 1n), e("active", true)]),
    e("attendee", "Bob"),
    e("session", [e("id", 2n), e("active", false)]),
    e("when", new Date(Date.UTC(2024, 0, 1, 9, 30))),
    e("price", 29.99),
    e("notes", null),
  ],
  [e("b", 1n), e("b", 2n), e("c", true), e("b", 3n)],
  [],
];

describe("writeOml({ arrays: true })", () => {
  it.each(GOLDEN_NODES_FOR_NO_REGRESSION.map((n): [Node] => [n]))(
    "arrays: false is byte-identical to the default: %#",
    (node) => {
      expect(writeOml(node, { arrays: false })).toBe(writeOml(node));
      expect(writeOml(node, { arrays: false, indent: null })).toBe(
        writeOml(node, { indent: null }),
      );
    },
  );

  it("collapses runs, pretty mode", () => {
    const node = [e("a", "x"), e("b", 1n), e("b", 2n), e("b", 3n), e("c", true)];
    expect(writeOml(node, { arrays: true })).toBe('a: "x"\nb: [1, 2, 3]\nc: true');
  });

  it("collapses runs, compact mode", () => {
    const node = [e("a", "x"), e("b", 1n), e("b", 2n), e("b", 3n), e("c", true)];
    expect(writeOml(node, { arrays: true, indent: null })).toBe(
      'a: "x"; b: [1, 2, 3]; c: true',
    );
  });

  it("a run of one stays a plain scalar edge", () => {
    const node = [e("b", 1n), e("c", true)];
    expect(writeOml(node, { arrays: true })).toBe("b: 1\nc: true");
  });

  it("never merges across a different label", () => {
    const node = [e("b", 1n), e("b", 2n), e("c", true), e("b", 3n)];
    const text = writeOml(node, { arrays: true });
    expect(text).toBe("b: [1, 2]\nc: true\nb: 3");
    expect(readOml(text)).toEqual(node);
  });

  it("array of brace subtrees", () => {
    const node = [e("members", [e("name", "Ann")]), e("members", [e("name", "Bob")])];
    const text = writeOml(node, { arrays: true });
    expect(text).toBe('members: [{ name: "Ann" }, { name: "Bob" }]');
    expect(readOml(text)).toEqual(node);
  });

  it("array with an empty record element", () => {
    const node = [e("members", []), e("members", [e("name", "Ann")])];
    const text = writeOml(node, { arrays: true });
    expect(text).toBe('members: [{}, { name: "Ann" }]');
    expect(readOml(text)).toEqual(node);
  });

  it("no line-wrapping regardless of run length", () => {
    const node = Array.from({ length: 20 }, (_, i) => e("b", i));
    const text = writeOml(node, { arrays: true });
    expect(text).not.toContain("\n");
    expect(text.startsWith("b: [")).toBe(true);
    expect(text.endsWith("]")).toBe(true);
    expect(readOml(text)).toEqual(node);
  });

  it.each(
    (
      [
        ...GOLDEN_NODES_FOR_NO_REGRESSION,
        [e("b", 1n), e("b", 2n), e("c", true), e("b", 3n)],
        [e("members", [e("name", "Ann")]), e("members", [e("name", "Bob")])],
        [e("members", []), e("members", [e("name", "Ann")])],
      ] as Node[]
    ).map((n): [Node] => [n]),
  )("round-trips pretty and compact: %#", (node) => {
    expect(readOml(writeOml(node, { arrays: true }))).toEqual(node);
    expect(readOml(writeOml(node, { arrays: true, indent: null }))).toEqual(node);
  });
});

// ---------------------------------------------------------------------------
// Property tests (fast-check): array form == repeated-label form, and
// read(write(node, arrays: true)) == node for arbitrary nodes.
// ---------------------------------------------------------------------------

const arrayScalarArb = fc.oneof(
  fc.integer({ min: -1_000_000, max: 1_000_000 }),
  fc.boolean(),
  fc.string({ maxLength: 10 }).filter((s) => !/["\\]/.test(s) && !/[\uD800-\uDFFF]/.test(s)),
  fc.constant(null),
);

function writeTestScalar(v: unknown): string {
  const omlOutput = writeOml([e("x", v as Node)]);
  // Match the label followed by ": " separator.
  // Labels in OML match [A-Za-z_][A-Za-z0-9_-]*, and we need to respect
  // quoting rules to avoid splitting inside quoted string values.
  const match = omlOutput.match(/^[A-Za-z_][A-Za-z0-9_-]*: /);
  if (!match) {
    throw new Error('Invalid OML output from writeOml: ' + omlOutput);
  }
  return omlOutput.slice(match[0].length);
}

describe("property: array form equals repeated-label form", () => {
  it("holds for arbitrary labels and scalar lists", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,8}$/),
        fc.array(arrayScalarArb, { minLength: 1, maxLength: 6 }),
        (label, values) => {
          const arraySrc = `${label}: [${values.map(writeTestScalar).join(", ")}]`;
          const repeatedSrc = values.map((v) => `${label}: ${writeTestScalar(v)}`).join("\n");
          expect(readOml(arraySrc)).toEqual(readOml(repeatedSrc));
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("property: writeOml({ arrays: true }) never reorders / always round-trips", () => {
  const labelArb = fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,6}$/);
  const nodeArb: fc.Arbitrary<Node> = fc.letrec((tie) => ({
    node: fc
      .array(fc.tuple(labelArb, tie("leafOrNode") as fc.Arbitrary<Node>), {
        maxLength: 6,
      })
      .map((pairs) => pairs.map(([label, target]) => e(label, target))),
    leafOrNode: fc.oneof(
      { depthSize: "small", maxDepth: 3 },
      arrayScalarArb,
      tie("node") as fc.Arbitrary<Node>,
    ),
  })).node;

  it("round-trips arbitrary nodes", () => {
    fc.assert(
      fc.property(nodeArb, (node) => {
        expect(readOml(writeOml(node, { arrays: true }))).toEqual(node);
        expect(readOml(writeOml(node, { arrays: true, indent: null }))).toEqual(node);
      }),
      { numRuns: 100 },
    );
  });
});

/** A literal newline, spelled without an escape so a multi-edge document
 * literal below reads as the exact text the doc example shows. */
const NEWLINE = String.fromCharCode(10);

describe("issue #51: writeOml preserves a datetime's UTC offset", () => {
  // Issue #26 fixed the local-vs-offset asymmetry for TOML with a module-local
  // WeakSet; oml.ts had the identical asymmetry and never got the treatment, so
  // an offset literal was normalized to UTC and written back with no offset at
  // all. That is only round-trip-stable if this implementation is on both ends
  // -- Python reads an offset-less literal as a naive local datetime.
  it.each([
    "a: 2024-01-01T12:00:00-08:00",
    "a: 2024-01-01T12:00:00+00:00",
    "a: 2024-01-01T12:00:00+05:30",
    "a: 2024-01-01T00:00:00+00:00",
    "a: 2024-01-01T08:00:00+08:00",
    "a: 2024-01-01T12:00:00.500-08:00",
  ])("round-trips %s as text", (src) => {
    expect(writeOml(readOml(src), { indent: null })).toBe(src);
  });

  it("keeps the instant unchanged while preserving the offset spelling", () => {
    const edges = readOml("a: 2024-01-01T12:00:00-08:00") as Edge[];
    expect((at(edges, 0).target as Date).toISOString()).toBe("2024-01-01T20:00:00.000Z");
  });

  it("leaves an offset-less datetime literal offset-less", () => {
    const src = "a: 2024-01-01T12:00:00";
    expect(writeOml(readOml(src), { indent: null })).toBe(src);
  });

  it("writes an untagged Date (built by application code) with no offset", () => {
    const edges: Edge[] = [{ label: "a", target: new Date(Date.UTC(2024, 0, 1, 12, 0, 0)) }];
    expect(writeOml(edges, { indent: null })).toBe("a: 2024-01-01T12:00:00");
  });

  it("a DATE token stays a bare date, offsets being meaningless for it", () => {
    expect(writeOml(readOml("a: 2024-01-01"), { indent: null })).toBe("a: 2024-01-01");
  });

  it("round-trips docs/formats/oml.md's temporal-offset example verbatim", () => {
    const src = [
      "a: 2024-01-01T12:00:00-08:00",
      "b: 2024-01-01T12:00:00+00:00",
      "c: 2024-01-01T12:00:00",
    ].join(NEWLINE);
    expect(writeOml(readOml(src))).toBe(src);
  });
});

describe("issue #52: a TIME literal round-trips as a TIME token", () => {
  // `time` is a plain string at the Document layer (no bare time-of-day type
  // in JS), and the writer used to quote every string -- so `a: 12:00` came
  // back out as `a: "12:00"`, which a subsequent OML reader (or Python) sees
  // as a string, not a time. OML is the one supported format with a native
  // TIME token, so this was the one place the port discarded information the
  // format itself can carry.
  it.each(["a: 12:00", "a: 12:00:00", "a: 23:59:59.500", "a: 12:00+05:30", "a: 00:00"])(
    "round-trips %s as text",
    (src) => {
      expect(writeOml(readOml(src), { indent: null })).toBe(src);
    },
  );

  it("reads a TIME token as a TimeValue at the Document layer (issue #96)", () => {
    // Superseded by issue #96: a genuinely time-kinded value is now a
    // `TimeValue` wrapper, not a plain string -- see the issue #96 describe
    // block below for the full provenance-tracking behavior this replaced.
    expect(readOml("a: 12:00")).toEqual([e("a", new TimeValue("12:00"))]);
  });

  it("round-trips docs/formats/oml.md's TIME-token example verbatim", () => {
    const src = ["a: 12:00", 'b: "24:00"', 'c: "noon"'].join(NEWLINE);
    expect(writeOml(readOml(src))).toBe(src);
  });

  it("a string that is only time-shaped, not a valid time, stays quoted", () => {
    for (const s of ["24:00", "12:60", "12:00:60", "12:00+05:60", "12:0", "1:00"]) {
      const written = writeOml([{ label: "a", target: s }], { indent: null });
      expect(written).toBe(`a: ${JSON.stringify(s)}`);
      expect(readOml(written)).toEqual([e("a", s)]);
    }
  });
});

describe("issue #96: a plain string never shape-guesses as a genuine TIME value", () => {
  // The bug this replaces: issue #52's fix made *any* time-shaped plain
  // string write bare, indistinguishable from a genuinely time-kinded value,
  // so a plain string got silently promoted to a real TIME literal on the
  // next OML read. Confirmed live against the freshly-bumped
  // vendor/omnist-spec@v0.2.0-alpha vectors
  // (formats-oml/basic/time-shaped-string-stays-quoted-on-write and its
  // formats-oml/basic/genuine-time-writes-bare sibling), which require a
  // `kind: "string"` input holding "12:00:00" to write quoted, and a
  // `kind: "time"` input holding the *identical* text to write bare -- only
  // real provenance tracking (a `TimeValue` wrapper, mirroring
  // omnist-rs#99/PR#100's `RawNode::TemporalLeaf`) can satisfy both.
  it("a plain string that happens to be time-shaped stays quoted on write", () => {
    const written = writeOml([{ label: "t", target: "12:00:00" }], { indent: null });
    expect(written).toBe('t: "12:00:00"');
  });

  it("a genuinely time-kinded value (read via OML's own TIME token) writes bare", () => {
    const node = readOml("t: 12:00:00");
    expect(node).toEqual([e("t", new TimeValue("12:00:00"))]);
    expect(writeOml(node, { indent: null })).toBe("t: 12:00:00");
  });

  it("readOml(writeOml(n)) is stable for a genuine TIME value read back a second time", () => {
    const first = readOml("t: 12:00:00");
    const second = readOml(writeOml(first));
    expect(second).toEqual(first);
  });
});

describe("checkWriteDepth is a real, reachable guard (issue #70)", () => {
  // issue #77: MAX_NODES boundary, mirroring the MAX_DEPTH boundary tests
  // above -- a shallow-but-wide document (one label repeated many times)
  // must still be rejected once its total node count exceeds the limit.
  //
  // issue #107: only actual `node`-typed values (edge lists, spec section
  // 2.2) count against MAX_NODES -- a scalar leaf's target is a `value`,
  // categorically distinct from `node`. A bare scalar array element (e.g.
  // `1`) parses to a scalar and does NOT count as a node; the boundary
  // fixtures below use `{}` elements instead, each a genuine (empty)
  // edge-list node.
  //
  // A huge number of scalar array elements is still just ONE node (the
  // root's edge list) -- this is the issue #107 repro itself.
  it(
    "readOml accepts 1,000,000 scalar array elements under one root (issue #107)",
    () => {
      const parts: string[] = [];
      for (let i = 0; i < 1_000_000; i++) parts.push(String(i));
      const text = `x: [${parts.join(",")}]`;
      expect(() => readOml(text)).not.toThrow();
    },
    30000,
  );

  // Explicit longer timeout: genuinely just slow (parsing a million-node
  // OML document), not a hang -- bumped when vitest 2 -> 4 (#103) pushed
  // this past the 5000ms default in a full-suite run.
  it(
    "readOml accepts a document at exactly MAX_NODES (1,000,000) nodes",
    () => {
      const k = 999_999;
      const parts: string[] = [];
      for (let i = 0; i < k; i++) parts.push("{}");
      const text = `x: [${parts.join(",")}]`;
      expect(() => readOml(text)).not.toThrow();
    },
    90000,
  );

  it(
    "readOml rejects a document one node over MAX_NODES",
    () => {
      const k = 1_000_000;
      const parts: string[] = [];
      for (let i = 0; i < k; i++) parts.push("{}");
      const text = `x: [${parts.join(",")}]`;
      expect(() => readOml(text)).toThrow(/node count exceeds the maximum \(1000000\)/);
    },
    90000,
  );

  it("writeOml rejects a hand-built Node deeper than MAX_DEPTH, in pretty mode", () => {
    // writeOml takes a raw Node (a publicly exported type), so a caller
    // can hand-build one deeper than buildNode() would ever allow -- same
    // gap issue #37 fixed for writeJson/writeYaml/writeToml/writeXml, but
    // apparently missed for writeOml. See src/formats/json.ts's own
    // checkWriteDepth and test/formats/json.test.ts's matching test.
    let node: Node = 1;
    for (let i = 0; i < 250; i++) {
      node = [{ label: "a", target: node }];
    }
    expect(() => writeOml(node)).toThrow(/nesting exceeds the maximum depth \(200\)/);
  });

  it("writeOml rejects a hand-built Node deeper than MAX_DEPTH, in compact mode", () => {
    let node: Node = 1;
    for (let i = 0; i < 250; i++) {
      node = [{ label: "a", target: node }];
    }
    expect(() => writeOml(node, { indent: null })).toThrow(/nesting exceeds the maximum depth \(200\)/);
  });
});

describe("OML parse error codes (spec Sec8.3.1, issue #108)", () => {
  function errOf(text: string): ParseError {
    try {
      readOml(text);
    } catch (e) {
      return e as ParseError;
    }
    throw new Error(`expected readOml(${JSON.stringify(text)}) to throw`);
  }

  it("a stray character gets parse.unexpected-token and a line:col path", () => {
    const err = errOf("a: %");
    expect(err).toBeInstanceOf(ParseError);
    expect(err.code).toBe("parse.unexpected-token");
    expect(err.path).toBe("1:4");
  });

  it("unexpected token via the array-close site also gets parse.unexpected-token", () => {
    const err = errOf("a: [1 2]");
    expect(err.code).toBe("parse.unexpected-token");
  });

  it("trailing content after the document body gets parse.trailing-content", () => {
    const err = errOf("1 2");
    expect(err.code).toBe("parse.trailing-content");
    expect(err.path).toBe("1:3");
  });

  it("an unterminated dquote string gets parse.unterminated-string", () => {
    const err = errOf('a: "ab');
    expect(err.code).toBe("parse.unterminated-string");
    expect(err.path).toBe("1:4");
  });

  it("an unterminated multiline string gets parse.unterminated-string", () => {
    const err = errOf('a: """ab');
    expect(err.code).toBe("parse.unterminated-string");
  });

  it("an unterminated raw string (missing closing ') gets parse.unterminated-string", () => {
    const err = errOf("a: 'ab");
    expect(err.code).toBe("parse.unterminated-string");
  });

  it("a literal control character in a string gets parse.control-character", () => {
    const err = errOf('a: "a\tb"');
    expect(err.code).toBe("parse.control-character");
    // scanStringSlow reports the string's opening-quote position, not the
    // offending character's own position -- existing (unchanged) behavior,
    // matching its sibling "unterminated string" errors in this function.
    expect(err.path).toBe("1:4");
  });

  it("a literal control character in a multiline string gets parse.control-character", () => {
    const err = errOf('a: """a\bb"""');
    expect(err.code).toBe("parse.control-character");
  });

  it("an unrecognized backslash escape gets parse.invalid-escape", () => {
    const err = errOf('a: "a\\qb"');
    expect(err.code).toBe("parse.invalid-escape");
    expect(err.path).toBe("1:4");
  });

  it("a truncated \\u escape gets parse.invalid-escape", () => {
    const err = errOf('a: "\\u12"');
    expect(err.code).toBe("parse.invalid-escape");
  });

  it("a trailing backslash right before end of input gets parse.invalid-escape, not a crash", () => {
    const err = errOf('a: "ab\\');
    expect(err.code).toBe("parse.invalid-escape");
  });

  it("an unpaired high surrogate escape gets parse.unpaired-surrogate", () => {
    const err = errOf('a: "\\uD800"');
    expect(err.code).toBe("parse.unpaired-surrogate");
    expect(err.path).toBe("1:4");
  });

  it("an unpaired low surrogate escape gets parse.unpaired-surrogate", () => {
    const err = errOf('a: "\\uDE00"');
    expect(err.code).toBe("parse.unpaired-surrogate");
  });

  it("a reserved word used as a bare label gets parse.reserved-word-label", () => {
    const err = errOf("{true: 1}");
    expect(err.code).toBe("parse.reserved-word-label");
    expect(err.path).toBe("1:2");
  });

  it("a bare identifier in value position gets parse.bare-word", () => {
    const err = errOf("a: foo");
    expect(err.code).toBe("parse.bare-word");
    expect(err.path).toBe("1:4");
  });

  it("an empty array gets parse.empty-array", () => {
    const err = errOf("a: []");
    expect(err.code).toBe("parse.empty-array");
    expect(err.path).toBe("1:4");
  });

  it("a nested array gets parse.nested-array", () => {
    const err = errOf("a: [[1]]");
    expect(err.code).toBe("parse.nested-array");
    expect(err.path).toBe("1:5");
  });

  it("an EOF-terminated array (missing ']') still gets parse.unexpected-token, with a real path despite the 'line 0, col 0' message quirk", () => {
    const err = errOf("a: [1");
    expect(err.code).toBe("parse.unexpected-token");
    expect(err.message).toMatch(/^line 0, col 0:/);
    expect(err.path).toBe("1:6");
  });

  it("parse.separator-in-array is not reachable: a newline between array elements without a comma still reports parse.unexpected-token", () => {
    // OML's array loop silently skips SEP tokens between elements before
    // checking for a comma, so there is no throw site that can tell
    // "a SEP was used as the separator" apart from any other malformed
    // array-closing token; both collapse into the generic "expected ','
    // or ']'" diagnostic. See the file-top comment in src/oml.ts.
    const err = errOf("a: [1\n2]");
    expect(err.code).toBe("parse.unexpected-token");
  });

  it("resource-limit throw sites (MAX_DEPTH) still carry no code/path (out of this issue's scope)", () => {
    const tooDeep = "a: " + "{ b: ".repeat(201) + "1" + " }".repeat(201);
    const err = errOf(tooDeep);
    expect(err.code).toBeUndefined();
    expect(err.path).toBeUndefined();
  });

  it("an invalid calendar DATE value still carries no code/path (a value-shape error, not a parse.* grammar error)", () => {
    const err = errOf("a: 2024-13-01");
    expect(err.code).toBeUndefined();
    expect(err.path).toBe("1:14");
  });
});
