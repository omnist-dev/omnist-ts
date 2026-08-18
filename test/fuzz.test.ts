/**
 * Property-based fuzzing of the Document model, codecs, and OML/OSD
 * parsers. Ported from upstream `tests/test_fuzz.py` -- see that file's
 * module docstring for the two angles (round-trip fuzzing, crash-freedom
 * fuzzing) and `docs/design/ts-implementation-notes.md` §3 for the
 * Hypothesis -> fast-check strategy mapping this file builds against.
 *
 * Found bugs (real round-trip mismatches or unhandled-exception crashes)
 * are not fixed here -- per the project's standing bug workflow, they're
 * filed as a separate issue and fixed in their own PR. A flaw in this
 * file's own lossiness assumptions is fixed here instead.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  type Node,
  type Edge,
  type Scalar,
  ParseError,
  SchemaError,
  DocumentError,
  doc,
  readOml,
  writeOml,
  checkOml,
  readJson,
  writeJson,
  checkJson,
  readYaml,
  writeYaml,
  checkYaml,
  readToml,
  writeToml,
  checkToml,
  readXml,
  writeXml,
  checkXml,
} from "../src/index.js";
import { parseSchema } from "../src/osd.js";

const NUM_RUNS = 150;

// ---------------------------------------------------------------------------
// Scalars -- all seven kinds + null, with edge-case values
// ---------------------------------------------------------------------------

const strings = fc.string({ maxLength: 20 });

// Integers: values near (but not tripping) the digit-count guard's
// neighborhood -- see upstream's identical comment. This generator's job is
// round-trip values, not boundary values; the boundary itself is covered by
// targeted tests elsewhere, not widened into here.
//
// bigint-backed since issue #98 (Document-layer `integer` scalars are
// native bigint, `number` stays plain JS number -- see
// src/document.ts's file-top comment). `bigint` has no signed zero, so
// unlike the `floats` generator below there is only one zero constant
// here, not a `0`/`-0` pair.
const integers = fc.oneof(
  fc.bigInt({ min: -(2n ** 53n) + 1n, max: 2n ** 53n - 1n }),
  fc.constant(0n),
);

// Floats: very large/small magnitudes, signed zero, nan/inf.
const floats = fc.oneof(
  fc.double({ noNaN: false }),
  fc.constant(0.0),
  fc.constant(-0.0),
  fc.double({ min: 1e300, max: 1.7e308, noNaN: true }),
  fc.double({ min: -1.7e308, max: -1e300, noNaN: true }),
  fc.double({ min: 1e-300, max: 1e-10, noNaN: true }),
);

// date/time/datetime -- represented at the Document layer as plain
// strings (see src/document.ts's file-top comment); we generate the
// documented spellings schema.ts's regexes accept, since a Document-layer
// round-trip fuzzer's job is to cover the shapes the writers actually
// know how to emit/read, not schema-directed values.
function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

const dateStrings = fc
  .tuple(fc.integer({ min: 1, max: 9999 }), fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 28 }))
  .map(([y, m, d]) => `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`);

const timeStrings = fc
  .tuple(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 }), fc.integer({ min: 0, max: 59 }))
  .map(([h, m, s]) => `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}`);

const datetimeStrings = fc
  .tuple(dateStrings, timeStrings)
  .map(([d, t]) => `${d}T${t}`);

const scalars: fc.Arbitrary<Scalar> = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  integers,
  floats,
  strings,
  dateStrings,
  timeStrings,
  datetimeStrings,
);

// "inf"/"nan"/"-inf" excluded from labels: same reasoning as upstream's
// Python fuzzer -- write_oml would emit them as bare identifiers but a
// scanner may tokenize them as NUMBER, not IDENT. Whether the TS scanner
// actually shares that gap is checked directly (not assumed) by the
// crash-freedom / round-trip suites below still exercising these strings
// as ordinary scalar *values* (only labels are filtered here).
const labels = fc.string({ minLength: 1, maxLength: 10 }).filter((s) => !["inf", "nan", "-inf"].includes(s));

const { node: nodes } = fc.letrec<{ node: Node }>((tie) => ({
  node: fc.oneof(
    { depthSize: "small" },
    scalars,
    fc.array(
      fc.tuple(labels, tie("node") as fc.Arbitrary<Node>),
      { maxLength: 5 },
    ).map((pairs): Edge[] => pairs.map(([label, target]) => ({ label, target }))),
  ),
}));

function boundedNodes(): fc.Arbitrary<Node> {
  return nodes;
}

// ---------------------------------------------------------------------------
// Equality that treats NaN as self-equal and compares through a grouped
// (same-label-collapsed) projection where a codec doesn't preserve
// interleaving.
// ---------------------------------------------------------------------------

function nanSafeScalarEqual(a: Scalar, b: Scalar): boolean {
  if (typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b)) {
    return true;
  }
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  return a === b;
}

function nanSafeEqual(a: Node, b: Node): boolean {
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((ea, i) => {
      const eb = b[i] as Edge;
      return ea.label === eb.label && nanSafeEqual(ea.target, eb.target);
    });
  }
  return nanSafeScalarEqual(a as Scalar, b as Scalar);
}

/**
 * Group same-label edges of a Node into a plain object, recursively -- the
 * JSON-shaped projection every lossy codec (JSON/YAML/TOML) goes through
 * (see `Doc.toGrouped`). A label seen once maps to a bare (recursively
 * grouped) value; seen more than once, to an array of them. Kept as a
 * standalone recursive structure (not `Doc.toGrouped`, which only handles
 * Doc-shaped input) so it also accepts nodes reconstructed directly from a
 * lossy reader.
 */
type Grouped = Scalar | Grouped[] | { [label: string]: Grouped };

function grouped(node: Node): Grouped {
  if (!Array.isArray(node)) return node;
  const counts = new Map<string, number>();
  for (const { label } of node) counts.set(label, (counts.get(label) ?? 0) + 1);
  const out: { [label: string]: Grouped } = {};
  for (const { label, target } of node) {
    const g = grouped(target);
    if ((counts.get(label) ?? 0) > 1) {
      const existing = out[label];
      if (Array.isArray(existing)) existing.push(g);
      else out[label] = [g];
    } else {
      out[label] = g;
    }
  }
  return out;
}

function nanSafeEqualDeep(x: Grouped, y: Grouped): boolean {
  if (typeof x === "number" && typeof y === "number" && Number.isNaN(x) && Number.isNaN(y)) return true;
  if (x instanceof Date || y instanceof Date) {
    return x instanceof Date && y instanceof Date && x.getTime() === y.getTime();
  }
  if (Array.isArray(x) && Array.isArray(y)) {
    return x.length === y.length && x.every((v, i) => nanSafeEqualDeep(v, y[i] as Grouped));
  }
  if (Array.isArray(x) !== Array.isArray(y)) return false;
  if (typeof x === "object" && x !== null && typeof y === "object" && y !== null) {
    const ox = x as { [label: string]: Grouped };
    const oy = y as { [label: string]: Grouped };
    const kx = Object.keys(ox).sort();
    const ky = Object.keys(oy).sort();
    if (kx.length !== ky.length || !kx.every((k, i) => k === ky[i])) return false;
    return kx.every((k) => nanSafeEqualDeep(ox[k] as Grouped, oy[k] as Grouped));
  }
  return x === y;
}

function nanSafeEqualGrouped(a: Node, b: Node): boolean {
  return nanSafeEqualDeep(grouped(a), grouped(b));
}

it("nanSafeEqual/nanSafeEqualGrouped report mismatched shapes correctly", () => {
  // The fuzz tests below only ever compare a value against its own
  // round-trip, so these branches never fire there -- exercised directly.
  expect(nanSafeEqual(NaN, NaN)).toBe(true);
  expect(nanSafeEqual([{ label: "a", target: 1 }], [{ label: "a", target: 1 }, { label: "b", target: 2 }])).toBe(false);
  expect(nanSafeEqual([{ label: "a", target: 1 }], [{ label: "b", target: 1 }])).toBe(false);
  expect(nanSafeEqualGrouped([{ label: "a", target: NaN }], [{ label: "a", target: NaN }])).toBe(true);
  expect(nanSafeEqualGrouped([{ label: "a", target: 1 }], [{ label: "b", target: 1 }])).toBe(false);
});

// ---------------------------------------------------------------------------
// 1. OML round-trip -- exact equality, no adjustments possible
// ---------------------------------------------------------------------------

describe("OML round-trip fuzzing", () => {
  it("is exact for every generated node", () => {
    fc.assert(
      fc.property(boundedNodes(), (node) => {
        expect(checkOml(node).adjustments).toEqual([]);
        const text = writeOml(node);
        const back = readOml(text);
        expect(nanSafeEqual(back, node)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("is exact with arrays=true (issue #218 parity: never reorders edges)", () => {
    fc.assert(
      fc.property(boundedNodes(), (node) => {
        const text = writeOml(node, { arrays: true });
        const back = readOml(text);
        expect(nanSafeEqual(back, node)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Lossy-format round-trip -- exact modulo documented adjustments
// ---------------------------------------------------------------------------

const ALLOWED_CODES: Record<string, ReadonlySet<string>> = {
  json: new Set(["temporal.stringified", "float.special"]),
  yaml: new Set(["temporal.stringified"]),
  toml: new Set(["null.omitted"]),
  xml: new Set([
    "null.omitted",
    "temporal.stringified",
    "value.stringified",
    "key.sanitized",
    "shape.empty_ambiguous",
  ]),
};

function codesOf(rep: Iterable<{ code: string }>): Set<string> {
  return new Set([...rep].map((a) => a.code));
}

describe("JSON round-trip fuzzing (modulo documented adjustments)", () => {
  it("only ever reports documented adjustment codes, and round-trips when unadjusted", () => {
    fc.assert(
      fc.property(boundedNodes(), (node) => {
        const rep = checkJson(node);
        const codes = codesOf(rep);
        for (const c of codes) expect((ALLOWED_CODES.json as ReadonlySet<string>).has(c)).toBe(true);
        const text = writeJson(node);
        const back = readJson(text);
        if (!codes.has("temporal.stringified") && !codes.has("float.special")) {
          expect(nanSafeEqualGrouped(back, node)).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// #69-equivalent concern (PyYAML/js-yaml mangling U+0085 NEL): excluded
// here so this test exercises the *documented* adjustments only. Not
// assumed to be a TS-side bug -- if the TS YAML writer/reader round-trips
// NEL cleanly, this exclusion is simply inert (never filters anything).
function hasNel(node: Node): boolean {
  if (Array.isArray(node)) {
    return node.some(({ label, target }) => label.includes("\x85") || hasNel(target));
  }
  return typeof node === "string" && node.includes("\x85");
}

// Issue #46: a label literally "<<" invokes YAML 1.1's merge-key syntax --
// the `yaml` package (like PyYAML's own SafeLoader/SafeDumper -- confirmed
// directly, not assumed: yaml.safe_load("<<: -1e300") raises the same
// "expected a mapping ... for merging" ConstructorError) treats a "<<" key
// specially during *both* stringify and parse, unconditionally, with no
// documented way to opt out short of dropping the "yaml-1.1" schema
// entirely (which the port is deliberately pinned to for its date/bool
// coercion parity with PyYAML -- see src/formats/yaml.ts's file-top
// comment). This is a genuine YAML-format limitation shared by both
// language ecosystems, not a TS-side bug: a document edge labeled "<<" is
// representable in the Document model (and round-trips fine through
// JSON/OML/TOML/XML) but not through YAML, which imposes merge semantics
// on that exact label regardless of what the target looks like -- a
// non-map target throws ParseError, and a map target round-trips silently
// wrong (the "<<" edge vanishes and its children splice into the parent
// map instead). Excluded here the same way #69's NEL concern is above:
// this test exercises the *documented* contract, not this known gap.
function hasMergeKeyLabel(node: Node): boolean {
  if (Array.isArray(node)) {
    return node.some(({ label, target }) => label === "<<" || hasMergeKeyLabel(target));
  }
  return false;
}

describe("YAML round-trip fuzzing (modulo documented adjustments)", () => {
  it("only ever reports documented adjustment codes, and round-trips when unadjusted", () => {
    fc.assert(
      fc.property(boundedNodes(), (node) => {
        fc.pre(!hasNel(node));
        fc.pre(!hasMergeKeyLabel(node));
        const rep = checkYaml(node);
        const codes = codesOf(rep);
        for (const c of codes) expect((ALLOWED_CODES.yaml as ReadonlySet<string>).has(c)).toBe(true);
        const text = writeYaml(node);
        const back = readYaml(text);
        if (rep.adjustments.length === 0) {
          expect(nanSafeEqualGrouped(back, node)).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("TOML round-trip fuzzing (modulo documented adjustments)", () => {
  it("only ever reports documented adjustment codes, and round-trips when unadjusted", () => {
    fc.assert(
      fc.property(boundedNodes(), (node) => {
        const rep = checkToml(node);
        const codes = codesOf(rep);
        for (const c of codes) expect((ALLOWED_CODES.toml as ReadonlySet<string>).has(c)).toBe(true);
        if (!Array.isArray(node)) return; // TOML requires a top-level table
        const text = writeToml(node);
        const back = readToml(text);
        if (rep.adjustments.length === 0) {
          expect(nanSafeEqualGrouped(back, node)).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// #67/#68-equivalent concerns (control chars, empty-node/empty-string
// ambiguity) -- excluded here so this test exercises the *documented*
// adjustments only, same reasoning as upstream.
function xmlSafeNode(node: Node): boolean {
  if (Array.isArray(node)) {
    if (node.length === 0) return false;
    return node.every(({ target }) => xmlSafeNode(target));
  }
  if (typeof node === "string") {
    return ![...node].some((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code < 0x20 && ch !== "\t" && ch !== "\n";
    });
  }
  return true;
}

it("xmlSafeNode classifies empty/non-empty and control chars correctly", () => {
  expect(xmlSafeNode([])).toBe(false);
  expect(xmlSafeNode([{ label: "a", target: "hello" }])).toBe(true);
  expect(xmlSafeNode([{ label: "a", target: "bad\x01char" }])).toBe(false);
  expect(xmlSafeNode("hello")).toBe(true);
  expect(xmlSafeNode(42)).toBe(true);
});

// fast-xml-parser 5.x rejects an element literally named __proto__,
// constructor, or prototype outright (see the dedicated
// "prototype-pollution hardening" tests in test/formats/xml.test.ts for
// why) -- excluded here too, same reasoning as xmlSafeNode's control-char
// exclusion: this test exercises the *documented* adjustments only, and a
// hard parse rejection for a known, deliberately-tested case is not one.
const CRITICAL_XML_LABELS = new Set(["__proto__", "constructor", "prototype"]);
function hasCriticalLabel(node: Node): boolean {
  if (!Array.isArray(node)) return false;
  return node.some(({ label, target }) => CRITICAL_XML_LABELS.has(label) || hasCriticalLabel(target));
}

describe("XML round-trip fuzzing (modulo documented adjustments)", () => {
  it("only ever reports documented adjustment codes, and round-trips when unadjusted", () => {
    fc.assert(
      fc.property(labels, boundedNodes(), (label, node) => {
        fc.pre(xmlSafeNode(node));
        const rooted: Node = [{ label, target: node }];
        fc.pre(!CRITICAL_XML_LABELS.has(label) && !hasCriticalLabel(node));
        const rep = checkXml(rooted);
        const codes = codesOf(rep);
        for (const c of codes) expect((ALLOWED_CODES.xml as ReadonlySet<string>).has(c)).toBe(true);
        const text = writeXml(rooted);
        const back = readXml(text);
        if (rep.adjustments.length === 0) {
          expect(nanSafeEqual(back, rooted)).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// 3. doc(...)/buildNode round-trip from the equivalent plain JS value
// ---------------------------------------------------------------------------

const { plain: plainValues } = fc.letrec<{ plain: unknown }>((tie) => ({
  plain: fc.oneof(
    { depthSize: "small" },
    scalars,
    fc.dictionary(labels, tie("plain"), { maxKeys: 5 }),
    fc.dictionary(labels, fc.array(tie("plain"), { maxLength: 4 }), { maxKeys: 3 }),
  ),
}));

describe("doc(...)/buildNode round-trip from a plain JS value", () => {
  it("round-trips through Doc.toData and then through OML exactly", () => {
    fc.assert(
      fc.property(plainValues, (value) => {
        let expected: Node;
        try {
          expected = doc(value).toData();
        } catch (e) {
          if (e instanceof DocumentError) return; // a legal rejection
          throw e;
        }
        expect(nanSafeEqual(doc(value).toData(), expected)).toBe(true);
        const back = readOml(writeOml(expected));
        expect(nanSafeEqual(back, expected)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Crash-freedom: arbitrary text into readOml / parseSchema
// ---------------------------------------------------------------------------

function assertOnlyParseError(fn: () => unknown, text: string): void {
  try {
    fn();
  } catch (e) {
    if (e instanceof ParseError) return;
    throw new Error(`readOml raised ${(e as Error).constructor.name} instead of ParseError on input ${JSON.stringify(text)}: ${(e as Error).message}`);
  }
}

function assertOnlySchemaError(fn: () => unknown, text: string): void {
  try {
    fn();
  } catch (e) {
    if (e instanceof SchemaError) return;
    throw new Error(`parseSchema raised ${(e as Error).constructor.name} instead of SchemaError on input ${JSON.stringify(text)}: ${(e as Error).message}`);
  }
}

describe("crash-freedom fuzzing: readOml/parseSchema on arbitrary text", () => {
  it("readOml never raises anything but ParseError on arbitrary unicode text", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (text) => {
        assertOnlyParseError(() => readOml(text), text);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("parseSchema never raises anything but SchemaError on arbitrary unicode text", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (text) => {
        assertOnlySchemaError(() => parseSchema(text), text);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// Text drawn from an alphabet biased toward OML/OSD syntax characters --
// far more likely to reach deep parser states than pure random unicode.
const SYNTAX_ALPHABET = ' \t\n\r;:{}[]",\'#-+.0123456789eEtTzZabcdefghijklmnopqrstuvwxyz_?nullruefalseinfa'.split("");
const syntaxLikeText = fc.stringOf(fc.constantFrom(...SYNTAX_ALPHABET), { maxLength: 200 });

describe("crash-freedom fuzzing: syntax-biased text", () => {
  it("readOml never raises anything but ParseError on syntax-like text", () => {
    fc.assert(
      fc.property(syntaxLikeText, (text) => {
        assertOnlyParseError(() => readOml(text), text);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("parseSchema never raises anything but SchemaError on syntax-like text", () => {
    fc.assert(
      fc.property(syntaxLikeText, (text) => {
        assertOnlySchemaError(() => parseSchema(text), text);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
