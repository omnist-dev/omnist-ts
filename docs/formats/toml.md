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
`smol-toml`'s `TomlDate` on read): a `Date` leaf written by `writeToml` comes
back from `readToml` as the same kind of `Date`, offset-vs-local included.
Since 0.10.0-alpha (spec E-37) the writer never alters the value: an offset
datetime is written at its own offset and wall-clock reading
(`2024-01-15T12:00:00+01:00`, never converted to UTC), a datetime without an
offset is a local date-time with no `Z`, every fractional digit is kept, the
separator is `T`, and a `time` or `datetime` read without seconds is written
with them. A `time` without an offset is written as TOML's local time
(`12:00:00`); a `time` with an offset has no TOML literal, so it is written as
a double-quoted string and reported as `format.temporal-stringified`. A TOML
`time` literal still reads as a plain string (this port's `Scalar` maps only
`date`/`datetime` onto `Date`), so it writes back as a string.

Since 0.10.1-alpha (spec E-37) a TOML reader never alters a temporal value:
`smol-toml` keeps three fraction digits of a time, so a date-time or local-time
literal with four or more fraction digits is read by this port and keeps up to
six (trailing zeros are insignificant). A literal that cannot be held exactly (a
seventh significant fraction digit) or whose fields are out of range is
`parse.codec-syntax`, never rounded. The offset is kept (`Z` reads as `+00:00`).
Text over 65,536 characters is also read in linear time (see
[Limitations](../limitations.md)).

Since 0.10.0-alpha a negative zero (`-0.0`) is written as `-0.0`; it was
`0.0` (spec D-29).

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
own integer-digit limit (spec D-9, D-28): 4300 decimal digits by default
(matching CPython's `sys.get_int_max_str_digits()` default), configurable as
`readToml(text, { maxIntDigits })`. The limit counts the digits of the
integer's VALUE, so `0xFFF` (4095) is four digits and refused at a limit of
three, `0b1111100111` (999) and `9_9_9` are three and accepted, and a
3 600-digit hex literal (a value of 4 335 digits) is refused by default. A
refusal is a `ParseError` with code `document.limit.int-digits` at the
literal's Document path (`$.a`, `$.t.a[1]`). Every converted integer is
checked by value, without a decimal conversion of a huge one; a decimal
literal of more than 64 digits that is over the limit is also found in the
text first, so it is refused before `smol-toml` converts it. That limit is a
deliberate security guard against unbounded-digit int-to-str conversion, not a
representational limit (see `docs/formats/json.md`'s equivalent note).
A float literal that overflows (`1e999`) reads as an infinity, and one that
underflows as `0.0` (D-29).
