# TOML

`readToml`/`writeToml`/`checkToml` (`src/formats/toml.ts`, built on the
optional `smol-toml` peer dependency).

TOML has no bare top-level scalar -- a document must be table-shaped
(a record at the root), so a Document whose root is a leaf can't be
written to TOML at all. TOML tables map onto the same edge-list model as
every other format; arrays of tables are the array-field case.

```ts
import { readToml, writeToml, checkToml } from "@omnist-dev/omnist";

const node = readToml('name = "Ann"\ntag = ["x", "y"]\n');
writeToml(node);
```
<!-- doc-illustrative -->

TOML round-trips `date`/`datetime` natively in both directions (via
`smol-toml`'s `TomlDate`, which tags which of TOML's temporal kinds a
literal came from -- see the module's file-top comment and issue #26): a
`Date` leaf written by `writeToml` comes back from `readToml` as the same
kind of `Date`, offset-vs-local included. TOML's bare `time` literal
(no calendar date) is the one exception -- this port's `Scalar` type only
maps `date`/`datetime` onto `Date` (see `src/temporal.ts`'s file-top
comment: "a time scalar stays a plain string at the Document layer"), so
a TOML `time` literal reads as a plain ISO-ish string and writes back out
as a TOML string, not a TOML time literal. This is a deliberate,
pre-existing asymmetry with Python's `tomllib`/`tomli_w` (which round-trip
`datetime.time` natively), not a `smol-toml` gap -- see the OML/`TIME`
token handling in `docs/formats/oml.md` for the corresponding OML-side
treatment.

Unlike JSON, TOML's own grammar accepts `nan`/`inf`/`-inf` float literals
directly, so a `NaN`/`Infinity` leaf is written as is: it needs no
adjustment and does not fail (unlike JSON, where it is a write failure).

## Adjustment codes

`writeToml`/`checkToml` can report one adjustment code, `format.interleaving-lost`
(path `$`, warning): TOML's grouping rule collapses same-label edges into an
array of tables, so a Document whose labels interleave across other labels
(`m, x, m`) reads back in grouped order. `test/fuzz.test.ts` asserts the set
against `ALLOWED_CODES.toml`.

## A `null` leaf fails to write

TOML has no `null` token, and dropping the edge would leave no trace it ever
existed. A `null` leaf is therefore an unconditional write failure -- `strict`
or not, and in `checkToml` too -- with code `write.unsupported-value` and the
leaf's path (indexed per E-10). The old `null.omitted` adjustment no longer
exists for TOML.

```ts
import { doc } from "@omnist-dev/omnist";
import { writeToml } from "@omnist-dev/omnist";

const node = doc({ name: "Ann", nickname: null }).toData();
writeToml(node);
// throws WriteError, code "write.unsupported-value", path "$.nickname"
```
<!-- doc-illustrative -->

## Arbitrary-precision integers (issue #98)

`integer`-kinded values are backed by native `BigInt`, not `number`.
`readToml`/`writeToml` run `smol-toml` with its own `integersAsBigInt:
true` / `numbersAsFloat: true` options, so a TOML integer literal of any
magnitude parses into an exact `bigint` (TOML's own spec already requires
64-bit signed integer support; `smol-toml`'s bigint mode goes beyond that
to genuinely arbitrary precision, matching Python's `tomllib`), and every
plain JS `number` leaf (`number`-kinded, never `integer`) writes with an
explicit decimal point even when whole -- otherwise a whole-valued
`number` would write as a bare digit token indistinguishable from an
`integer`, and read back as the wrong kind.

This closes what used to be a real, documented structural limitation
(issue #25/#8): before issue #98, this port's Document model unified
Python's separate `int`/`float` onto a single JS `number`, which cannot
represent an integer beyond ±(2^53 - 1) (`Number.MAX_SAFE_INTEGER`)
losslessly, so `readToml` threw `ParseError` on anything past that range
even though TOML's own spec (and Python's `tomllib`/`tomli_w`) supports
the full 64-bit range and beyond. `readToml` still enforces this port's
own `MAX_INT_DIGITS` cap (4300 digits, matching CPython's
`sys.get_int_max_str_digits()` default and `src/document.ts`'s own cap)
via a text-level pre-parse scan (`checkTomlIntegerDigits`) -- that limit
is a deliberate security guard against unbounded-digit int-to-str
conversion, not a representational limit, and stays in place (see
`docs/formats/json.md`'s equivalent note).
