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

Element text is untyped: XML has no native typed literals, unlike
YAML/TOML (which have real typed scalar syntax). On a **schema-less**
read, `readXml` never coerces text by shape -- every element's text
becomes a `string` scalar unconditionally, exactly like JSON/OML's own
schema-less behavior (issue #88; matches the Python port's own breaking
fix in `omnist#288`, v0.8.0):

```ts
import { readXml } from "@omnist-dev/omnist";

readXml("<r><n>30</n><f>3.5</f><ok>true</ok><d>2024-01-01</d></r>");
// [{ label: "r", target: [
//   { label: "n", target: "30" },
//   { label: "f", target: "3.5" },
//   { label: "ok", target: "true" },
//   { label: "d", target: "2024-01-01" },
// ] }]
```
<!-- doc-illustrative -->

Every leaf above stays a plain string -- `<n>30</n>` reads as `"30"`, not
the number `30`; `<ok>true</ok>` reads as `"true"`, not the boolean
`true`. A string is always a deliberate author choice absent a schema
override, the same rule every other codec here already follows.

### Schema-directed reads recover types locally

When `readXml` is given a schema (the `opts.schema` argument), it
recovers `boolean`/`integer`/`number` from element text *before* handing
the node to the shared `materialize()` -- guided by what the schema
declares each field to be, not by guessing from text shape:

```ts
import { readXml, parseSchema } from "@omnist-dev/omnist";

const s = parseSchema('record R { "n": integer, "f": number, "ok": boolean }\nroot R');
readXml("<r><n>30</n><f>3.5</f><ok>true</ok></r>", { schema: s });
// [{ label: "r", target: [
//   { label: "n", target: 30n },
//   { label: "f", target: 3.5 },
//   { label: "ok", target: true },
// ] }]
```
<!-- doc-illustrative -->

This pretyping step is local to `src/formats/xml.ts` -- it does **not**
change `materialize()` itself, which keeps rejecting a numeric-looking
string for every format (JSON/YAML/TOML/OML included) whenever there's no
XML-specific pretyping step ahead of it: a string is a deliberate author
choice absent a schema override, never an untyped placeholder, for every
format except XML, which has no other way to spell a typed literal at
all. A field declared `string` in the schema is left exactly as read (no
coercion attempted even if the text looks numeric), and an `any`-typed
field is likewise passed through untouched.

**Historical divergence, now closed** (issue #53, closed by #88). Before
#88, this port's schema-less coercion heuristic (a `coerce` function,
since removed) was narrower than Python's `_coerce`: Python's
`int()`/`float()` additionally accepted `nan`, `inf`, `infinity`, and
`1_0` (Python numeric-literal spellings, not data-XML syntax). Since #88
removes schema-less coercion entirely on this side (matching #288's
identical move on the Python side), that gap no longer exists -- both
ports now agree that every one of those spellings stays a plain string on
a schema-less read. See `docs/python-parity.md` for the full
cross-implementation comparison.

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
| `value.stringified` | warning | a non-string scalar leaf (`number`/`boolean`) -- written as text, reads back as a plain string on a schema-less read, not its original type |
| `string.illegal_xml_char` | error | a string containing a character XML 1.0 cannot represent (a C0 control other than tab/LF/CR) -- replaced with U+FFFD |
| `string.cr_normalized` | warning | a string containing `\r` -- XML mandates line-ending normalization on parse, so it reads back as `\n` |

(That's seven rows for six *distinct* situations -- `null.omitted` and
`temporal.stringified` are shared with JSON/TOML's own versions of the
same codes; `shape.empty_ambiguous`, `key.sanitized`, `value.stringified`,
`string.illegal_xml_char`, and `string.cr_normalized` are XML-only.
`value.stringified` replaced the pre-#88 `string.ambiguous` code -- see
below.)

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

### `value.stringified`

```ts
import { buildNode } from "@omnist-dev/omnist";
import { checkXml } from "@omnist-dev/omnist";

const node = buildNode({ root: { code: 30 } });
checkXml(node).adjustments;
// [{ path: "$.root.code", code: "value.stringified",
//    message: "non-string scalar written as text (reads back as a string)", severity: "warning" }]
```
<!-- doc-illustrative -->

The mirror image of the scalar-coercion section above: since issue #88, a
schema-less `readXml` never coerces text back into a number/boolean, so a
non-string Document leaf (a `number` or `boolean`) written as element text
is the one XML round-trip that always loses its type -- `30` (a number)
comes back as `"30"` (a string) on a plain read. `value.stringified` flags
that before it happens. (Before #88, this was the reverse situation --
`string.ambiguous` flagged a *string* leaf that happened to look numeric,
because the old shape-based coercion would have turned it back into a
number on read. Since coercion is gone, that code no longer applies: a
string leaf now always round-trips as a string, unconditionally.)

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
