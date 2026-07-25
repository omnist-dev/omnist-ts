# OML

`readOml`/`writeOml`/`checkOml` (`src/oml.ts`).

**OML** (Omnist Markup Language) is Omnist's own format -- the only one
that round-trips every Document shape (all seven scalars, `null`, repeated
and interleaved labels, arbitrary nesting, multiple top-level edges) with
**zero adjustments**. Where JSON/YAML/TOML each give up something (TOML
has no `null`, JSON has no native dates, YAML's schema-less numeric
guessing needs quoting workarounds), OML maps onto the Document model 1:1
-- `checkOml` is always an empty `WriteReport`, and there is no
`strict`/`report` writer machinery for the same reason. Reach for it
whenever you're not constrained to a specific interchange format: a config
or fixture format inside your own project, or the artifact you
snapshot/diff in tests.

```ts
import { readOml, writeOml, checkOml } from "@omnist-dev/omnist";

const node = readOml('name: "Ann"\ntag: "x"\ntag: "y"\n');
writeOml(node);         // 'name: "Ann"\ntag: "x"\ntag: "y"'
checkOml(node);          // WriteReport {} -- always empty
```
<!-- doc-illustrative -->

## Shape

A document is zero or more `label: value` edges, one per line (or
`;`-separated on one line, for inline style). A repeated label is how an
array appears -- same as every other format. Values nest with `{ }`:

```
name: "Ann"
tag: "x"
tag: "y"
nested: {
    inner: 1
}
list: [1, 2, 3]      # sugar for repeated same-label edges
n: null
d: 2024-01-01
```
<!-- doc-illustrative -->

This reads into `[('name', 'Ann'), ('tag', 'x'), ('tag', 'y'), ('nested',
[('inner', 1)]), ('list', 1), ('list', 2), ('list', 3), ('n', null), ('d',
2024-01-01T00:00:00.000Z)]` -- `tag` is a repeated label (two edges, in
order), and `list` expands from array sugar into three more repeated
edges at that exact spot. Confirmed by running `readOml` on the block
above:

```
[
  { label: "name", target: "Ann" },
  { label: "tag", target: "x" },
  { label: "tag", target: "y" },
  { label: "nested", target: [{ label: "inner", target: 1 }] },
  { label: "list", target: 1 },
  { label: "list", target: 2 },
  { label: "list", target: 3 },
  { label: "n", target: null },
  { label: "d", target: 2024-01-01T00:00:00.000Z }
]
```
<!-- doc-illustrative -->

Edge order is **data**, not metadata: it's preserved on the way in and
the way out, and two documents with the same edges in a different order
build different (unequal) `Node`s -- see [overview.md](overview.md) for
how that compares across formats.

## Scalars are typed by their spelling, not a tag

There's no type annotation -- the literal's shape says what it is:

| Spelling | Scalar | Document (TS) type |
|---|---|---|
| `"text"` | string | `string` |
| `42` / `-42` | integer | `number` |
| `3.14` / `1e10` / `nan` / `inf` / `-inf` | number | `number` |
| `true` / `false` | boolean | `boolean` |
| `2024-01-01` | date | `Date` |
| `12:30:00` | time | `string` |
| `2024-01-01T12:30:00` | datetime | `Date` |
| `null` | null | `null` |

Bare words are never strings -- `name: Ann` is a `ParseError` ("bare word
... is not a valid value here; strings must be quoted"); quote it:
`name: "Ann"`. Unlike JSON/YAML/TOML, no leaf value in this table ever
needs a schema to read as the "right" type -- see
[Reading without a schema](#reading) below.

`date` and `datetime` both map onto the same native `Date` (JS has no
bare-date type distinct from a timestamp); see [Temporal
values](#temporal-values) for how `writeOml` decides which of the two
shapes to write back, and for the UTC-offset and `TIME`-token behavior
that's specific to this port.

## Reading

Because every unquoted OML literal is already exactly typed by its own
spelling, `readOml` without a schema hands back the right JS type for
every leaf directly -- there's no separate coercion step the way there is
for JSON/YAML/TOML:

```
readOml('d: 2024-01-01\nn: 3')
// [{ label: "d", target: 2024-01-01T00:00:00.000Z }, { label: "n", target: 3 }]
```
<!-- doc-illustrative -->

The one case that *isn't* already typed is a value written as a quoted
string -- `"2024-01-01"` is unambiguously a `string` by its own spelling
(OML has no separate date literal that also happens to be quotable), so it
stays a `string` unless a schema says otherwise. `readOml(text, {
schema })` runs the parsed document through `materialize`
(`src/deserialize.ts`, issue #7): it leaf-converts (e.g. that quoted
`"2024-01-01"` into a real `Date`, given a schema field typed `date`) and
shape-checks (cardinality, closedness) in one pass, throwing `ParseError`
with the full structured issue list if the result can't be made to
conform. For OML this matters less for type-upgrading than it does for
the other formats -- `schema` is a no-op for the unquoted `d: 2024-01-01`
case above, since the parser already produced a `Date` -- and matters more
for the quoted-string case and for validation itself (a missing field, the
wrong cardinality) which is exactly what schema-directed reading catches
that plain parsing can't. See [schema.md](../schema.md) for the schema
side, and `src/oml.ts`'s `ReadOmlOptions` doc comment.

## Writing

```ts
writeOml([{ label: "name", target: "Ada" }]); // 'name: "Ada"'
```
<!-- doc-illustrative -->

The canonical writer always emits `LF` newlines, 2-space indentation, and
the minimal string-escape form (`\"` and `\\` plus literal Unicode) --
same input always produces the same output, useful for diffing or
snapshotting. `writeOml(node, { indent: null })` switches to a
single-line, machine-oriented form -- edges joined by `"; "` instead of
newlines -- for log lines or diffless storage where pretty-printing isn't
useful:

```
writeOml([
  { label: "name", target: "Ada" },
  { label: "tags", target: [{ label: "tag", target: "x" }, { label: "tag", target: "y" }] },
])
// 'name: "Ada"\ntags: {\n  tag: "x"\n  tag: "y"\n}'
writeOml(node, { indent: null })
// 'name: "Ada"; tags: { tag: "x"; tag: "y" }'
```
<!-- doc-illustrative -->

Both forms round-trip through `readOml` to the same `Node` -- `indent`
only changes layout, never meaning. `writeOml(node, { arrays: true })`
collapses maximal runs of two or more consecutive same-label edges back
into `[...]` array form (a run of length one still writes as a plain
scalar edge); the default `arrays: false` is byte-identical to `arrays`
not existing at all:

```
const node = readOml('a: "x"\nb: 1\nb: 2\nb: 3\nc: true');
writeOml(node);                    // 'a: "x"\nb: 1\nb: 2\nb: 3\nc: true'
writeOml(node, { arrays: true });   // 'a: "x"\nb: [1, 2, 3]\nc: true'
```
<!-- verified-by: test/oml.test.ts "collapses runs, pretty mode" -->

Unlike `readOml`, `writeOml` does **not** enforce the 200-level depth cap
-- confirmed by writing a hand-built `Node` 201 levels deep (something
`readOml` itself could never produce, since it *does* enforce the cap on
the way in): the write succeeds with no error and no adjustment. See
[The depth guard](#the-depth-guard) below for the read-side behavior and
why this asymmetry exists.

## The zero-adjustment guarantee

Every other format in this port loses *something* on write and records an
`Adjustment` for it (see each format's own page, and the roundup in
[overview.md](overview.md)): JSON stringifies dates and substitutes
`null` for non-finite numbers, YAML has similar temporal and
special-float handling, TOML drops `null` edges entirely. OML has none of
that machinery because its grammar is a superset of the Document model's
own shape: all seven scalar kinds, `null`, repeated/interleaved labels,
arbitrary nesting, and multiple top-level edges are all native syntax.
`checkOml` always returns an empty `WriteReport`, confirmed directly:

```
checkOml(readOml('a: 1')).adjustments   // []
```
<!-- doc-illustrative -->

A concrete round trip through every scalar kind at once, with no
adjustment and no loss:

```ts
const src = 'name: "Ann"\ntag: "x"\ntag: "y"\nnested: {\n  inner: 1\n}\n' +
  'list: [1, 2, 3]\nn: null\nd: 2024-01-01\n';
const node = readOml(src);
checkOml(node).adjustments;        // []
const out = writeOml(node);
readOml(out);                      // deep-equal to `node`
```
<!-- doc-illustrative -->

This is what "lossless" means concretely for this port: there is no
Document shape `buildNode` can construct that OML can't spell out, and no
OML feature that needs a special case anywhere in the read/write path.

## Temporal values

OML is the only supported format whose grammar has native `date`, `time`
and `datetime` tokens, so it is the only one where the Document model --
not the format -- is the limiting factor. Two consequences are worth
knowing.

**A datetime keeps its UTC offset.** An offset in the source literal is
preserved on write, rather than normalized away:

```
a: 2024-01-01T12:00:00-08:00
b: 2024-01-01T12:00:00+00:00
c: 2024-01-01T12:00:00
```
<!-- verified-by: test/oml.test.ts "issue #51: writeOml preserves a datetime's UTC offset" -->

All three round-trip as written. `a` and `b` are the same instants they
were read as; `c` carries no offset and gets none back. This matters
across implementations, not just within one: the Python implementation
reads an offset-less literal as a *naive local* datetime, so rewriting `b`
as `c` would change the value for a Python reader even though this port
reads both as UTC.

**A `Date` at exactly midnight UTC with no recorded offset writes as a
bare `DATE`, not a `DATETIME`.** `readOml` maps a `DATE` token
(`2024-01-01`) to a UTC-midnight `Date` and a `DATETIME` token to a `Date`
at the parsed instant; `writeOml` picks the output shape by checking
whether the `Date`'s UTC time-of-day is exactly midnight (`writeDate` in
`src/oml.ts`) -- unless the value carries a recorded offset (previous
paragraph), in which case it is always written as an offset `DATETIME`,
never collapsed to `DATE`, since the offset tag is itself proof a
`DATETIME` was read. This is the same date-vs-datetime ambiguity
`document.ts` documents for `Date` generally; it's Document-level
round-trip-safe (`readOml(writeOml(node))` compares equal), just not
always token-kind-identical to the source.

**A time-shaped string is written as a `TIME` token.** `time` has no
native JS type, so the Document model represents it as a plain string
(see the scalar table above). Nothing distinguishes a string that came
from a `TIME` token from an ordinary string of the same text -- a string
is a primitive, so there is no identity to hang an out-of-band tag on,
which is how the `date`-vs-`datetime` and local-vs-offset ambiguities
above are resolved instead. `writeOml` resolves *this* ambiguity in favor
of the token: any string that is a valid TIME literal (`isTimeLiteral` in
`src/oml.ts`: both shape *and* range, via `parseTimeToken`) is written
bare.

```
a: 12:00
b: "24:00"
c: "noon"
```
<!-- verified-by: test/oml.test.ts "issue #52: a TIME literal round-trips as a TIME token" -->

So `a: 12:00` survives a read/write round trip as a `TIME` token, and the
trade-off is that an ordinary string `"12:00"` is promoted to one on
write:

```
writeOml(buildNode({ a: "12:00" }));   // 'a: 12:00' -- not 'a: "12:00"'
```
<!-- doc-illustrative -->

The Document-level round trip is exact either way, since reading a `TIME`
token yields that same string back; only the token kind seen by a *later*
reader changes. `b` stays quoted because `24:00` is shaped like a time but
is not one (hour must be 0-23, matching the Python implementation).

## Numeric edge cases

- **Signed zero.** `-0` (integer literal) reads back as plain `0` --
  there's no negative-zero integer at the JS numeric level, so
  `readOml("a: -0")` gives `target === 0` with no distinguishable sign.
  `-0.0` (float literal) *does* preserve the sign: `Object.is(target,
  -0)` is `true`. But that sign does not survive a write -- `writeScalar`
  renders a number with `String(v)`, and `String(-0) === "0"` in JS, so
  `writeOml(readOml("a: -0.0"))` comes back as `a: 0`, not `a: -0.0`. This
  is a real, one-directional loss (read preserves the sign; write does
  not), unlike every other case on this page.
- **Scientific notation.** `1e10`, `1.5e-3`, and similar exponent forms
  are all valid `NUMBER` literals and parse to the expected finite
  `number`; `writeOml` renders a value like `1e10` back out via JS's
  default `String(number)` formatting (`a: 10000000000` for that
  example, not exponent form -- OML's grammar accepts either spelling on
  read, but the writer always emits whatever `String()` produces).
- **Overflow and underflow are defined, not errors.** A float literal
  that overflows float64 magnitude (`1e400`) reads as `Infinity`, and one
  that underflows (`1e-400`) reads as `0` -- both are IEEE-754-defined
  outcomes, matching Python's own `float()` behavior on the same inputs,
  so OML doesn't special-case either as a `ParseError`. `writeOml` writes
  `Infinity` back out as the reserved `inf` spelling.
- **The reserved float spellings (`nan`/`inf`/`-inf`) are `NUMBER`
  tokens, not `IDENT`s**, matched by the tokenizer before `IDENT` is ever
  tried (see [design/oml-grammar.md](../design/oml-grammar.md), §1). That
  means `nan: 1` is a `ParseError` -- not "reserved word as label", but
  "unexpected trailing content after the document body", because the
  parser takes the top-level scalar branch (`nan` alone is a complete,
  valid `NUMBER` value), consumes `nan`, and only then chokes on the
  leftover `: 1`. Quoting the label (`"nan": 1`) sidesteps the whole
  issue, since a quoted `STRING` token is unambiguously a label.
- **The 4300-digit integer cap.** An unsuffixed integer literal is capped
  at 4300 digits (sign excluded) -- exactly `MAX_INT_DIGITS` in
  `src/oml.ts`, matching CPython's own `sys.get_int_max_str_digits()`
  default and this port's other codecs (see `docs/formats/json.md`).
  4300 digits parses; 4301 raises `ParseError` naming the limit. This is
  a denial-of-service guard (int-to-string conversion on an
  arbitrarily-long digit string is superlinear), not a data-modeling
  constraint.

## Comments

`#` starts a comment that runs to end of line. It's valid anywhere
whitespace is valid -- on its own line, before an edge, or trailing after
a value:

```
readOml("# a top comment\na: 1  # trailing comment\nb: 2\n")
// [{ label: "a", target: 1 }, { label: "b", target: 2 }]
```
<!-- doc-illustrative -->

`#` inside any string literal (double-quoted, raw `'...'`, or multiline
`"""..."""`) is always literal data, never a comment -- a string token is
consumed as one opaque unit by its own quote-matching rules, and the
trivia scanner that recognizes `#` never runs until that literal is fully
closed. Comments are lexical trivia, discarded before parsing -- they
never affect the resulting `Node` and **don't round-trip**: `writeOml`
never re-emits them.

## Strings: escaping, raw, and multiline

A normal (double-quoted) string escapes the usual set: `\"`, `\\`, `\n`,
`\t`, `\r`, `\b`, `\f`, `\/`, and `\uXXXX` (a surrogate pair of two
`\uXXXX` escapes denotes one astral code point, e.g. U+1F600). The
canonical writer only ever emits the minimal subset -- `\"`, `\\`, `\n`,
`\r`, `\t`, and `\u00XX` for other control characters -- literal Unicode
otherwise, never `\/`, `\b`, `\f`, or surrogate-pair escapes on the way
out (`writeString` in `src/oml.ts`).

Two extra spellings are **OML-Extended**: read-only conveniences the
tokenizer accepts but the canonical writer never produces, so reading one
and writing it back changes layout, never meaning.

- **Raw** `'...'` -- no escape processing at all; ideal for paths or
  regexes: `'C:\no\escapes'` reads as the literal text `C:\no\escapes`,
  backslashes untouched. The one limitation: it can't contain `'` at all
  -- there's no escape for it inside raw strings, so the first `'`
  encountered always closes the string. `a: 'can't'` is a `ParseError`
  partway through: the raw string closes right after `can`, leaving a
  bare `t` where a separator (newline or `;`) was expected next.
- **Multiline** `"""..."""` -- may contain literal newlines (a newline
  right after the opening `"""` is stripped, so the first content line
  doesn't have to share the delimiter's line); ordinary escapes still
  work inside. The terminator is the *first* run of three or more `"`
  characters: only the first three of that run close the string, so
  `says ""hi"" there` inside a multiline body is literal content (a
  2-quote run, not a terminator), while a run of exactly three anywhere
  does close it.

```
readOml('a: """\nhello\nworld"""')          // [{ label: "a", target: "hello\nworld" }]
readOml('a: """\nsays ""hi"" there"""')      // [{ label: "a", target: 'says ""hi"" there' }]
```
<!-- doc-illustrative -->

Newlines *inside* a multiline string never act as the structural line
separator -- the tokenizer reads `"""..."""` as one token from open to
close, so only a newline *outside* any token separates one edge from the
next.

## Separators

Object fields (`{ ... }`) are separated by one or more newlines and/or
`;`, **not** commas -- a comma is reserved for `[...]` array sugar. `;` is
for one-line ("inline") style: `{ a: 1; b: 2 }`.

## Reserved words

`null`, `true`, and `false` can't be used unquoted as a label inside
`{ }` -- `ParseError` naming the specific reserved word and suggesting the
quoted spelling. Any other `IDENT`-shaped text, and any quoted `STRING`,
is a valid label, including `"null"` itself. Two sharp edges worth
knowing, both confirmed against the parser:

```
readOml("a: { null: 1 }")
// ParseError: "null" is a reserved word and cannot be a bare label; quote it: "null"

readOml("true: 1")
// ParseError: unexpected trailing content after the document body (token COLON ":")
```
<!-- doc-illustrative -->

The second case is *not* the reserved-word error from the first: at the
top level, `_looks_like_edge`-equivalent lookahead in the parser excludes
reserved words from the "this could be an edge" check, so `true: 1`
parses `true` as the scalar value `true` (a complete, valid document on
its own), and only then fails on the leftover `: 1` as ordinary trailing
content -- a different failure mode with a different message than the
same word used as a label inside braces. `null`/`true`/`false` are
ordinary `IDENT` tokens at the tokenizer level (unlike `nan`/`inf`, see
[Numeric edge cases](#numeric-edge-cases) above) and are excluded only by
the parser.

## Arrays

`[...]` is sugar for repeated same-label edges, expanded at parse time --
it is **not** a value type in the Document model. `label: [v1, v2, ...,
vn]` means exactly `label: v1; label: v2; ...; label: vn` at that position
in the edge list:

```
readOml('a: "x"\nb: [1, 2, 3]\nc: true\nb: [4, 5, 6]')
// [{a,"x"},{b,1},{b,2},{b,3},{c,true},{b,4},{b,5},{b,6}]
```
<!-- verified-by: test/oml.test.ts "worked example: arrays interleave with plain edges" -->

An array element may be a scalar, `null`, or a `{ }` brace subtree -- but
never another array (arrays aren't values, so there's nothing to nest
into):

```
readOml("b: [[1,2]]")   // ParseError: nested array is not allowed
readOml("b: []")        // ParseError: empty array is not allowed
readOml("[1, 2]")       // ParseError: expected a value, got LBRACKET "[" -- no bare array at the top level
readOml("[1,2]: 3")     // ParseError: expected a value, got LBRACKET "[" -- an array can't stand in for a label
```
<!-- doc-illustrative -->

Newlines and `#` comments *inside* `[...]` are legal and insignificant --
only a bare newline or `;` used *as the separator* is rejected (a comma
is the only valid element separator inside brackets); a trailing comma
before `]` is legal:

```
readOml("b: [1, 2, 3,]")   // [{ label: "b", target: 1 }, { label: "b", target: 2 }, { label: "b", target: 3 }]
```
<!-- verified-by: test/oml.test.ts "a trailing comma is legal" -->

`writeOml(node, { arrays: true })` is the write-side inverse -- see
[Writing](#writing) above.

## The depth guard

Nesting depth (the number of `{` a value may be wrapped in) is capped at
200 **on read**, matching the Document model's own bound (`MAX_DEPTH` in
`src/oml.ts`, and the same constant `src/document.ts`/`src/schema.ts`
each keep their own copy of). 200 levels of `{` parses; 201 raises
`ParseError` naming the limit:

```
readOml(200-levels-deep-source)    // parses fine
readOml(201-levels-deep-source)    // ParseError: nesting exceeds the maximum depth (200)
```
<!-- verified-by: test/oml.test.ts "nesting depth limit is enforced" -->

This is a denial-of-service guard against a pathological *input* hanging
or exhausting the call stack, not a data-modeling constraint -- see
[Numeric edge cases](#numeric-edge-cases) above for the matching integer
digit cap.

**The guard is read-side only.** `writeOml` does not re-check depth on the
way out: a `Node` built directly (not via `readOml`, which itself could
never hand back something over the cap) that nests past 200 levels
writes successfully with no error. In practice this only matters for a
`Node` assembled programmatically -- `buildNode` and every reader in this
port cap out at 200 the same way `readOml` does, so this gap isn't
reachable through the normal read -> transform -> write path. It's called
out here because it's a real asymmetry with `readOml`'s own guard, not
because it's expected to bite in practice.

## Not yet implemented

A few OML-Extended conveniences from the Python reference's design draft
aren't implemented in this port yet: digit separators (`1_000_000`),
non-decimal integer literals (`0x1F`, `0o17`, `0b1010`), the pair-free
astral escape `\u{1F600}`, a lenient `date time` (space) datetime
separator, and a trailing `Z` UTC-zone marker. None of these affect what
OML can *represent* -- every Document already round-trips -- they're
optional input sugar for later.

## See also

- [design/oml-grammar.md](../design/oml-grammar.md) -- the full ABNF
  grammar, its lexical priority order, and the worked examples this page's
  claims are drawn from.
- [overview.md](overview.md) -- how OML compares to JSON/YAML/TOML on
  adjustments, and the special-features-mapped-to-OML comparison table.
- The Python reference's [`docs/formats/oml.md`](https://github.com/omnist-dev/omnist/blob/master/docs/formats/oml.md)
  for the upstream design this port implements a subset of (this page
  documents this port's *actual* behavior, not a copy of that one).
