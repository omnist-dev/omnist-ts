# JSON

`readJson`/`writeJson`/`checkJson` (`src/formats/json.ts`).

JSON has no native `date`/`time`/`datetime` type and no `NaN`/`Infinity`.
Writing a Document with those leaves adjusts them (dates to ISO-8601
strings, non-finite numbers to `null`) and records an `Adjustment` in the
`WriteReport`, unless `{ strict: true }` is passed, in which case the
write throws instead.

Same-label edges (an array field) collapse into a JSON array; a label that
occurs exactly once stays a bare value rather than a single-element array
-- the schema-less "count-1 fallback." Pass `{ schema }` to `readJson` to
disambiguate a genuinely-array field with exactly one element from a
scalar field, and to upgrade ISO date/time strings to real `Date`s.

```ts
import { readJson, writeJson, checkJson } from "@omnist-dev/omnist";

const node = readJson('{"name": "Ann", "tag": ["x", "y"]}');
writeJson(node);
checkJson(node); // WriteReport -- what a write would adjust, without writing
```
<!-- doc-illustrative -->

## Adjustment codes

`writeJson`/`checkJson` can report two adjustment codes -- the full set
JSON's codec can ever emit (`test/fuzz.test.ts` asserts this against
`ALLOWED_CODES.json`, so this list can't silently drift from the code):

| code | severity | trigger |
|---|---|---|
| `temporal.stringified` | warning | a `Date` leaf -- JSON has no date/time type, so it's written as an ISO-8601 string |
| `float.special` | error | a `NaN`/`Infinity`/`-Infinity` leaf -- not valid JSON, so it's substituted with `null` |

```ts
import { buildNode } from "@omnist-dev/omnist";
import { checkJson, writeJson } from "@omnist-dev/omnist";

const node = buildNode({ when: new Date(Date.UTC(2024, 0, 1, 12, 0, 0)) });
checkJson(node).adjustments;
// [{ path: "$.when", code: "temporal.stringified",
//    message: "temporal value written as an ISO-8601 string", severity: "warning" }]
writeJson(node);
// '{"when": "2024-01-01T12:00:00"}'
```
<!-- doc-illustrative -->

```ts
import { buildNode } from "@omnist-dev/omnist";
import { checkJson, writeJson } from "@omnist-dev/omnist";

const node = buildNode({ x: NaN });
checkJson(node).adjustments;
// [{ path: "$.x", code: "float.special",
//    message: "NaN is not valid JSON; wrote null", severity: "error" }]
writeJson(node); // '{"x": null}' -- lenient default: substitutes and moves on
writeJson(node, { strict: true }); // throws WriteError("error: $.x: NaN is not valid JSON; wrote null")
```
<!-- doc-illustrative -->

`strict: true` doesn't change *which* substitution happens for
`float.special` -- `writeJson` still computes the same `null`-substituted
value internally either way -- it changes whether that value is ever
returned. In lenient mode the substituted text comes back normally; in
strict mode `finishWrite` sees a non-empty report and throws
`WriteError` before any text is returned, regardless of the adjustment's
severity (`strict` ignores severity, unlike the default lenient/error
split elsewhere -- see `docs/formats/overview.md` and `src/report.ts`).

## Arbitrary-precision integers (issue #98)

`integer`-kinded values are backed by native `BigInt`, not `number` --
`readJson` parses any integer-shaped JSON literal (no `.`, no exponent)
into an exact `bigint`, no matter how large, and `writeJson` serializes a
`bigint` leaf back to the same digit text. `1e400`-magnitude precision
loss is a thing of the past for genuinely integer-shaped input; `number`-
kinded values (anything with a `.` or exponent) are unaffected and stay
plain JS `number`, float64 semantics unchanged.

Mechanically: native `JSON.parse` always rounds an integer literal to
float64 before any reviver ever sees it, so `readJson` never hands the
raw text to `JSON.parse` directly for an integer-shaped token. It first
rewrites every such token into a tagged JSON string (`tagIntegerLiterals`),
runs `JSON.parse` with a reviver that converts the tagged strings back
into `BigInt` (`bigintReviver`), and only then hands the result to
`buildNode`. `tools/conformance/vectorRunner.ts` reuses the same two
functions to load the conformance-vector JSON files themselves, which can
also contain large integer literals.

`readJson` still raises `ParseError` on an integer literal with more than
4300 digits (`MAX_INT_DIGITS`, matching CPython's
`sys.get_int_max_str_digits()` default and `src/document.ts`'s own cap) --
that limit is a deliberate security guard against unbounded-digit
int-to-str conversion (superlinear), not a representational limit, and
stays in place.

A float literal that overflows float64 to `Infinity` (e.g. `1e400`) is
*not* rejected: Python's own `json` module produces `inf` for the same
input, so treating that as an error would be a new mismatch, not a fix.
Only an integer-shaped literal past the digit cap raises.

An integer value satisfies a `number`-typed schema field directly with no
conversion (the one sanctioned scalar-subtyping relation, spec Sec6.3);
`materialize`, by contrast, always normalizes a `number`-typed field to a
host float even from an integer-shaped source literal (spec Sec7.2) --
see `docs/python-parity.md` for the worked example.
