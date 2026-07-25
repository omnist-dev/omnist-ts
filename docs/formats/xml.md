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

## Mixed content is rejected

Text alongside child elements at the same level (`<a>text<b/></a>`,
or text before/after/between element children) is outside the data-XML
profile and `readXml` throws `ParseError` on it, rather than silently
dropping the text or the elements:

```ts
import { readXml } from "@omnist-dev/omnist";

readXml("<root>text<child>x</child></root>");
// throws ParseError("$: mixed content (text alongside child elements) is outside the data-XML profile")
```
<!-- doc-illustrative -->

This is a read-time rejection, not a write-side `Adjustment` -- there is
no way to construct a Document node whose text and child edges could
serialize to mixed content in the first place (a `Node` is either a
scalar leaf or an edge list, never both), so `writeXml` can never produce
mixed content for `readXml` to reject.

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

**Deliberate divergence from the Python port** (issue #53). Python's
`_coerce` (`omnist/formats.py`) tries `int()` then `float()`, which
additionally accept spellings that are Python numeric-literal syntax
rather than data-XML syntax: `nan`, `inf`, and `infinity` parse as float
special values, and `1_0` (the underscore digit-group separator) parses
as the integer `10`. This port's `coerce` (`src/formats/xml.ts`) does not
accept any of those four spellings -- they stay strings:

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

## Adjustment codes

`writeXml`/`checkXml` can report six adjustment codes -- more than any
other codec here, since XML's data-XML profile is the tightest fit of the
four (no `null`, no distinguishable empty container, element names have a
narrower legal-character set than a Document label, and only a subset of
XML 1.0's text range is safely representable). This is the full set
(`test/fuzz.test.ts` asserts this against `ALLOWED_CODES.xml`):

| code | severity | trigger |
|---|---|---|
| `null.omitted` | warning | a `null` leaf -- written as an empty element (`<tag />`), same spelling as an empty string |
| `temporal.stringified` | warning | a `Date` leaf -- written as text, reads back as a plain string, not a `Date` |
| `shape.empty_ambiguous` | warning | an empty internal node (edge list with no edges) -- written as `<tag />`, reads back as the empty-string leaf `""`, not `[]` |
| `key.sanitized` | warning | a label that isn't a legal XML element name -- written sanitized |
| `string.ambiguous` | warning | a string leaf whose text happens to coerce to a different type on read (e.g. `"30"`) |
| `string.illegal_xml_char` | error | a string containing a character XML 1.0 cannot represent (a C0 control other than tab/LF/CR) -- replaced with U+FFFD |
| `string.cr_normalized` | warning | a string containing `\r` -- XML mandates line-ending normalization on parse, so it reads back as `\n` |

(That's seven rows for six *distinct* situations -- `null.omitted` and
`temporal.stringified` are shared with JSON/TOML's own versions of the
same codes; `shape.empty_ambiguous`, `key.sanitized`, `string.ambiguous`,
`string.illegal_xml_char`, and `string.cr_normalized` are XML-only.)

### `null.omitted` and `temporal.stringified`

```ts
import { buildNode } from "@omnist-dev/omnist";
import { checkXml, writeXml } from "@omnist-dev/omnist";

const node = buildNode({ root: { note: null, when: new Date(Date.UTC(2024, 0, 1)) } });
checkXml(node).adjustments;
// [{ path: "$.root.note", code: "null.omitted",
//    message: "null written as an empty element", severity: "warning" },
//  { path: "$.root.when", code: "temporal.stringified",
//    message: "temporal value written as text (reads back as a string)", severity: "warning" }]
```
<!-- doc-illustrative -->

Unlike TOML's `null.omitted` (the edge disappears), XML's `null.omitted`
still writes an element -- `<note />` -- so the edge survives the
round-trip, just as an empty string rather than `null`.

### `shape.empty_ambiguous`

```ts
import { checkXml, writeXml } from "@omnist-dev/omnist";
import type { Node } from "@omnist-dev/omnist";

const node: Node = [{ label: "root", target: [{ label: "items", target: [] }] }];
checkXml(node).adjustments;
// [{ path: "$.root.items", code: "shape.empty_ambiguous",
//    message: "empty internal node (no edges) written as <tag /> and reads back as the empty-string leaf '', not []",
//    severity: "warning" }]
writeXml(node);
// "<root>\n  <items />\n</root>"
```
<!-- doc-illustrative -->

An empty internal node (`items: []`, a container with zero children) and
an empty-string leaf (`items: ""`) both write as `<items />`, and
`readXml` can't tell them apart on the way back in -- it always resolves
`<items />` to the empty-string leaf. This is the XML analogue of
JSON/YAML/TOML's own shared count-1 array/scalar ambiguity (see
`docs/formats/overview.md`), specific to the empty case.

### `key.sanitized`

```ts
import { checkXml, writeXml } from "@omnist-dev/omnist";
import type { Node } from "@omnist-dev/omnist";

const node: Node = [{ label: "root", target: [{ label: "not valid!", target: "x" }] }];
checkXml(node).adjustments;
// [{ path: "$.root.not valid!", code: "key.sanitized",
//    message: 'label "not valid!" isn\'t a valid XML name; written sanitized', severity: "warning" }]
writeXml(node);
// "<root>\n  <not_valid_>x</not_valid_>\n</root>"
```
<!-- doc-illustrative -->

A Document label can be any string; an XML element name can't (no spaces,
a restricted start-character set, no bare `!`). `writeXml` sanitizes an
illegal label into a legal element name rather than refusing to write --
the `path` in the `Adjustment` still carries the *original*, unsanitized
label, so the report stays keyed to the input, not the sanitized output.

### `string.ambiguous`

```ts
import { buildNode } from "@omnist-dev/omnist";
import { checkXml } from "@omnist-dev/omnist";

const node = buildNode({ root: { code: "30" } });
checkXml(node).adjustments;
// [{ path: "$.root.code", code: "string.ambiguous",
//    message: 'string "30" looks like another type and reads back as that type', severity: "warning" }]
```
<!-- doc-illustrative -->

The mirror image of the scalar-coercion section above: a *string* Document
leaf that happens to spell out something `coerce` would turn into a
number/boolean on read. Writing it as element text is the only option XML
has (there's no typed-vs-untyped element distinction in this profile), so
the string comes back as `30` (a number), not `"30"` -- `string.ambiguous`
flags that before it happens.

### `string.illegal_xml_char` and `string.cr_normalized`

```ts
import { buildNode } from "@omnist-dev/omnist";
import { checkXml, writeXml } from "@omnist-dev/omnist";

const illegal = buildNode({ root: { text: "a" + String.fromCharCode(1) + "b" } });
checkXml(illegal).adjustments;
// [{ path: "$.root.text", code: "string.illegal_xml_char",
//    message: "string contains a character XML 1.0 cannot represent (e.g. a C0 control other than tab/LF/CR); it is replaced with U+FFFD on write so the output stays well-formed",
//    severity: "error" }]
writeXml(illegal);
// U+0001 (a C0 control character, not tab/LF/CR) is substituted with U+FFFD in the output

const cr = buildNode({ root: { text: "a\rb" } });
checkXml(cr).adjustments;
// [{ path: "$.root.text", code: "string.cr_normalized",
//    message: "string contains a carriage return ('\r'); XML mandates line-ending normalization on parse, so '\r' (and '\r\n') read back as '\n'",
//    severity: "warning" }]
```
<!-- doc-illustrative -->

`string.illegal_xml_char` is the one XML-specific `error`-severity code
(alongside JSON's `float.special`): a C0 control character outside
tab/LF/CR has no legal XML 1.0 representation at all, so `writeXml`
substitutes U+FFFD (the Unicode replacement character) rather than
producing malformed output. `string.cr_normalized` is a warning because
the substitution is lossless in the sense the XML spec defines --
`\r`/`\r\n` are *specified* to normalize to `\n` on parse, so the
adjustment documents expected, standard behavior rather than a
worked-around gap.
