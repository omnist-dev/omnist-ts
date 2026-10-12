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
| `format.temporal-stringified` | warning | a `Date` leaf -- JSON has no date/time type, so it's written as an ISO-8601 string |
| `format.interleaving-lost` | warning | labels interleaved across other labels (`m, x, m`) -- JSON's grouping rule collapses same-label edges, so the order is lost; reported once, at `$` |

```ts
import { doc } from "@omnist-dev/omnist";
import { checkJson, writeJson } from "@omnist-dev/omnist";

const node = doc({ when: new Date(Date.UTC(2024, 0, 1, 12, 0, 0)) }).toData();
checkJson(node).adjustments;
// [{ path: "$.when", code: "format.temporal-stringified",
//    message: "temporal value written as an ISO-8601 string", severity: "warning" }]
writeJson(node);
// '{"when": "2024-01-01T12:00:00"}'
```
<!-- doc-illustrative -->

### `NaN` and `Infinity` fail to write

JSON has no token for `NaN`/`Infinity`/`-Infinity`, and substituting `null`
would be indistinguishable from a real `null`. Such a leaf is an
unconditional write failure (`write.unsupported-value`, at the leaf's
indexed path), `strict` or not, and in `checkJson` too. The old
`float.special` adjustment no longer exists.

```ts
import { doc } from "@omnist-dev/omnist";
import { writeJson } from "@omnist-dev/omnist";

writeJson(doc({ x: NaN }).toData());
// throws WriteError, code "write.unsupported-value", path "$.x"
```
<!-- doc-illustrative -->

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

`readJson` raises `ParseError` (code `document.limit.int-digits`, at the
literal's Document path, `$.a` or `$.a[1]`) on an integer literal whose
value has more than 4300 digits by default (spec D-9, D-28; matching
CPython's `sys.get_int_max_str_digits()` default). The limit is configurable
per call, `readJson(text, { maxIntDigits })`, like `maxDepth` and `maxNodes`
(see [Limitations](../limitations.md#safety-limits-and-how-to-set-them)): it
is a deliberate security guard against unbounded-digit int-to-str conversion
(superlinear), not a representational limit. An over-long literal is never
converted to a `bigint`; it is tagged and refused at its path.

A float literal that overflows float64 to `Infinity` (e.g. `1e400`) is
*not* rejected: spec D-29 says a number literal that rounds to infinity is
accepted and reads as an infinity (`-1e400` as `-Infinity`), and one that
underflows (`1e-999`) reads as `0.0`. Only an integer-shaped literal past
the digit cap raises.

An integer value satisfies a `number`-typed schema field directly with no
conversion (the one sanctioned scalar-subtyping relation, spec Sec6.3);
`materialize`, by contrast, always normalizes a `number`-typed field to a
host float even from an integer-shaped source literal (spec Sec7.2) --
see `docs/python-parity.md` for the worked example.

## Temporal values and negative zero (since 0.10.0-alpha)

A `date`, `time` or `datetime` is written as its ISO-8601 string and reported
as `format.temporal-stringified`, once per leaf (a `time` leaf too; it was
silent). Spec E-37: the value is never altered. A `datetime` with an offset is
written at its own offset and wall-clock reading (`2024-01-15T12:00:00+01:00`,
not `2024-01-15T11:00:00`), every fractional digit is kept (six, not three),
and the seconds are always written (`12:00` is `12:00:00`). A negative zero is
written as `-0.0` (spec D-29, OML-19).
