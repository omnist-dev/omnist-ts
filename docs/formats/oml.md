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

The full ABNF grammar, verified against the parser, lives at
[design/oml-grammar.md](../design/oml-grammar.md).
