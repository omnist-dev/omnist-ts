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

`writeXml`/`checkXml` can report two adjustment codes. Everything else XML
cannot represent is an unconditional write failure, not an adjustment (see
"Unrepresentable values fail to write" below). `test/fuzz.test.ts` asserts
the set against `ALLOWED_CODES.xml`:

| code | severity | trigger |
|---|---|---|
| `temporal.stringified` | warning | a `Date` leaf -- written as text, reads back as a plain string, not a `Date` |
| `value.stringified` | warning | a non-string scalar leaf (`number`/`boolean`) -- written as text, reads back as a plain string on a schema-less read, not its original type |

(`temporal.stringified` is shared with JSON/YAML's own version of the
code; `value.stringified` replaced the pre-#88 `string.ambiguous` code --
see below.)

`readXml` can also report two codes into an optional `report`:
`format.attribute-dropped` and `format.namespace-dropped`, one per element
an attribute or a namespace prefix was discarded from. The path is the
element's Document path, with the `[i]` occurrence index (E-10) on every
element of a label that repeats among its siblings, the first included:

```ts
import { readXml, WriteReport } from "@omnist-dev/omnist";

const report = new WriteReport();
readXml('<r><a x="1"/><a x="2"/><b y="3"/></r>', { report });
report.adjustments.map((a) => [a.path, a.code]);
// [["$.r.a[0]", "format.attribute-dropped"],
//  ["$.r.a[1]", "format.attribute-dropped"],
//  ["$.r.b", "format.attribute-dropped"]]
```
<!-- verified-by: test/formats/xml.test.ts::indexes the drop-report paths of repeated elements (issue #163); test/formats/xml.test.ts::keeps a single element's drop-report path bare (issue #163) -->

### A `null` leaf fails to write (spec C-10)

```ts
import { buildNode } from "@omnist-dev/omnist";
import { writeXml } from "@omnist-dev/omnist";

const node = buildNode({ root: { note: null } });
writeXml(node);
// throws WriteError, code "write.unsupported-value", path "$.root.note"
```
<!-- doc-illustrative -->

XML has no null token, and `<note />` reads back as the empty string, a
different valid Document. So a `null` leaf is an unconditional write
failure -- `strict` or not, and in `checkXml` too -- the same treatment as
a TOML `null`. The error's `path` names the null leaf, with an `[n]` index
(from 0) on a label that repeats among its siblings. The old
`null.omitted` adjustment no longer exists for XML.

### `temporal.stringified`

```ts
import { buildNode } from "@omnist-dev/omnist";
import { checkXml } from "@omnist-dev/omnist";

const node = buildNode({ root: { when: new Date(Date.UTC(2024, 0, 1)) } });
checkXml(node).adjustments;
// [{ path: "$.root.when", code: "temporal.stringified",
//    message: "temporal value written as text (reads back as a string)", severity: "warning" }]
```
<!-- doc-illustrative -->

### Unrepresentable values fail to write

An empty internal node, a label that is not a legal XML name, and a string
holding a character XML 1.0 cannot represent have no safe XML spelling:
writing an empty node as `<tag />` reads back as the empty-string leaf,
sanitizing a label invents a different one (and two labels can collide),
and replacing a character invents a different string. Per fail-don't-invent
each is an unconditional `WriteError` with code `write.unsupported-value`,
`strict` or not, and in `checkXml` too. The `path` names the offending node
or leaf, indexed per E-10.

```ts
import { checkXml, writeXml } from "@omnist-dev/omnist";
import type { Node } from "@omnist-dev/omnist";

const empty: Node = [{ label: "root", target: [{ label: "items", target: [] }] }];
writeXml(empty);
// throws WriteError, code "write.unsupported-value", path "$.root.items"

const badLabel: Node = [{ label: "root", target: [{ label: "not valid!", target: "x" }] }];
checkXml(badLabel);
// throws WriteError, code "write.unsupported-value", path "$.root.not valid!"

const badChar: Node = [{ label: "root", target: [{ label: "text", target: "a\u0001b" }] }];
writeXml(badChar);
// throws WriteError, code "write.unsupported-value", path "$.root.text"
```
<!-- doc-illustrative -->

The pre-fail-don't-invent codes `shape.empty_ambiguous`, `key.sanitized` and
`string.illegal_xml_char` no longer exist.

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

### Carriage returns are not an adjustment

A string containing `\r` is written with the character escaped as the
numeric character reference `&#13;`, which is exempt from XML's mandatory
line-ending normalization on parse, so it reads back intact. There is
nothing to report, and the old `string.cr_normalized` code no longer
exists.

```ts
import { buildNode } from "@omnist-dev/omnist";
import { checkXml, writeXml } from "@omnist-dev/omnist";

const cr = buildNode({ root: { text: "a\rb" } });
checkXml(cr).adjustments; // []
writeXml(cr);
// "<root>\n  <text>a&#13;b</text>\n</root>\n"
```
<!-- verified-by: test/formats/xml.test.ts::escapes a literal carriage return as the numeric character reference &#13; -->
