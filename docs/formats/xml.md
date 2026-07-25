# XML

`readXml`/`writeXml`/`checkXml` (`src/formats/xml.ts`, built on the
optional `fast-xml-parser` peer dependency).

A deliberately narrow **data-XML** profile: elements only -- no
attributes, no CDATA distinction, mixed content is rejected. XML always
has exactly one top-level element, so an XML Document always has a single
top-level edge (wrap a multi-rooted Document under one label first, the
same convention used in
[the real-life example's schema](../example.md#the-schema)).

`readXml` is hardened against XXE / entity-expansion attacks by
construction (external entities and entity expansion always throw,
regardless of options) -- see `SECURITY.md` and the module's own header
comment for the threat model.

## Scalar coercion

Element text is untyped. `readXml`'s coercion heuristic tries `true`/
`false` (case-insensitive), then an integer pattern, then a float pattern,
before falling back to the raw string -- it does **not** attempt any
date/time coercion, since a date string is indistinguishable from any
other string by spelling alone without a declared scalar to check it
against:

```ts
import { readXml } from "@omnist-dev/omnist";

readXml("<r><n>30</n><f>3.5</f><ok>true</ok><d>2024-01-01</d></r>");
// [{ label: "r", target: [
//   { label: "n", target: 30 },
//   { label: "f", target: 3.5 },
//   { label: "ok", target: true },
//   { label: "d", target: "2024-01-01" },
// ] }]
```
<!-- doc-illustrative -->

`<n>30</n>` reads as the number `30` and `<ok>true</ok>` as `true`, but
`<d>2024-01-01</d>` stays the plain string `"2024-01-01"`.

**Deliberate divergence from the Python port.** Python's `_coerce`
(`omnist/formats.py`) tries `int()` then `float()`, which additionally
accept spellings that are Python numeric-literal syntax rather than
data-XML syntax: `nan`, `inf`, and `infinity` parse as float special
values, and `1_0` (the underscore digit-group separator) parses as the
integer `10`. This port's `coerce` (`src/formats/xml.ts`) does not accept
any of those four spellings -- they stay strings:

```ts
import { readXml } from "@omnist-dev/omnist";

readXml("<r><a>nan</a><b>inf</b><c>infinity</c><d>1_0</d></r>");
// [{ label: "r", target: [
//   { label: "a", target: "nan" },
//   { label: "b", target: "inf" },
//   { label: "c", target: "infinity" },
//   { label: "d", target: "1_0" },
// ] }]
```
<!-- doc-illustrative -->

This is kept narrower on purpose, not an oversight: matching Python here
would let `readXml("<r><a>nan</a></r>")` manufacture a `NaN`/`Infinity`
value from ordinary-looking element text, and JSON -- one of this port's
other codecs -- cannot represent either (`writeJson` has no encoding for
a non-finite number). Accepting Python's literal syntax in a data format
would also make an XML document read differently depending on which port
reads it. Because `coerce` never accepts these spellings, `checkXml`
correspondingly never reports `string.ambiguous` for them either --
reader and writer agree. See `docs/python-parity.md` for the full
cross-implementation comparison (tracked as a deliberate divergence, not
a gap).

```ts
import { readXml, writeXml, checkXml } from "@omnist-dev/omnist";

const node = readXml("<root><name>Ann</name></root>");
writeXml(node);
```
<!-- doc-illustrative -->
