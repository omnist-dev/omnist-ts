# Formats

How each format maps to the Document model, and what it adjusts on the
way in or out. Every writer accepts a `strict` option (throw on any
adjustment) and reports adjustments through a `WriteReport`
(`checkFoo(node)` reports without writing).

| Format | Page | Zero-adjustment? | Notes |
|---|---|---|---|
| [OML](oml.md) | Omnist's own format | Yes | The only format that round-trips every Document shape exactly. |
| [JSON](json.md) | `formats/json.ts` | No | No native `date`/`time`/`datetime` or `NaN`/`Infinity` -- both get adjusted on write. |
| [YAML](yaml.md) | `formats/yaml.ts` | Mostly | Closer to the Document model than JSON (native dates), but still has JSON-like array/scalar limits. |
| [TOML](toml.md) | `formats/toml.ts` | Mostly | No top-level scalar root; a document must be table-shaped. |
| [XML](xml.md) | `formats/xml.ts` | No | Always single-rooted (one document element); attributes vs. elements is a modeling choice on the way in. |

## The shared contract

Every format module exports the same three functions:

- `readFoo(text, opts?)` -- parses into a `Node`. Pass `{ schema }` to
  upgrade value-exact leaves (ISO strings to real `Date`s, integer-looking
  numbers to the schema's declared kind) to match the schema, when the
  conversion is unambiguous -- see `deserialize.ts`'s `materialize`.
- `writeFoo(node, opts?)` -- serializes a `Node` to text. Pass `{ strict:
  true }` to throw instead of silently adjusting; otherwise adjustments are
  applied and (with `{ report }`) collected into a `WriteReport`.
- `checkFoo(node)` -- returns the `WriteReport` a write would produce,
  without writing anything.

See [the API reference](../api.md#formats) for exact signatures.
