# OML

`readOml`/`writeOml`/`checkOml` (`src/oml.ts`).

**OML** (Omnist Markup Language) is Omnist's own format -- the only one
that round-trips every Document shape (all seven scalars, `null`, repeated
and interleaved labels, arbitrary nesting, multiple top-level edges) with
**zero adjustments**. Reach for it whenever you're not constrained to a
specific interchange format: a config or fixture format inside your own
project, or the artifact you snapshot/diff in tests.

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

- Object fields (`{ ... }`) are separated by newlines or `;`, **not**
  commas -- a comma is reserved for `[...]` array sugar.
- `#` starts a comment that runs to end of line, legal anywhere whitespace
  is legal. Comments are lexical trivia, discarded before parsing -- they
  never round-trip.
- `[...]` is sugar for repeated same-label edges, expanded at parse time --
  it is **not** a value type in the Document model, just an alternate way
  to write the same edge list.
- The seven scalar kinds all have a literal form: quoted strings,
  unsuffixed integers, decimal/exponent numbers, `true`/`false`, ISO
  `date`/`time`/`datetime` tokens, and `null`.

## Temporal values

OML is the only supported format whose grammar has native `date`, `time` and
`datetime` tokens, so it is the only one where the Document model -- not the
format -- is the limiting factor. Two consequences are worth knowing.

**A datetime keeps its UTC offset.** An offset in the source literal is
preserved on write, rather than normalized away:

```
a: 2024-01-01T12:00:00-08:00
b: 2024-01-01T12:00:00+00:00
c: 2024-01-01T12:00:00
```
<!-- verified-by: test/oml.test.ts "issue #51: writeOml preserves a datetime's UTC offset" -->

All three round-trip as written. `a` and `b` are the same instants they were
read as; `c` carries no offset and gets none back. This matters across
implementations, not just within one: the Python implementation reads an
offset-less literal as a *naive local* datetime, so rewriting `b` as `c` would
change the value for a Python reader even though this port reads both as UTC.

**A time-shaped string is written as a `TIME` token.** `time` has no native JS
type, so the Document model represents it as a plain string (see
[overview.md](overview.md)). Nothing distinguishes a string that came from a
`TIME` token from an ordinary string of the same text -- a string is a
primitive, so there is no identity to hang an out-of-band tag on, which is how
the `date`-vs-`datetime` and local-vs-offset ambiguities are resolved. `writeOml`
resolves the ambiguity in favour of the token: any string that is a valid TIME
literal is written bare.

```
a: 12:00
b: "24:00"
c: "noon"
```
<!-- verified-by: test/oml.test.ts "issue #52: a TIME literal round-trips as a TIME token" -->

So `a: 12:00` survives a read/write round trip as a `TIME` token, and the
trade-off is that an ordinary string `"12:00"` is promoted to one. The
Document-level round trip is exact either way, since reading a `TIME` token
yields that same string back; only the token kind seen by a *later* reader
changes. `b` stays quoted because `24:00` is shaped like a time but is not one
(hour must be 0-23, matching the Python implementation).

The full ABNF grammar, verified against the parser, lives at
[design/oml-grammar.md](../design/oml-grammar.md).
