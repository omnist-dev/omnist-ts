# Omnist -- user guide

Omnist gives you **one canonical data model** for JSON, YAML, TOML, XML, and
its own native [**OML**](formats/oml.md), and a [**schema language**](schema.md)
to validate and compare shapes over it. The model is defined formally in
[the model spec](design/model.md); this guide is the practical tour; the
[API reference](api.md) lists every name with signatures.

- [The two ideas](#the-two-ideas)
- [Documents](#documents)
- [OML -- the native format](#oml-the-native-format)
- [Schemas -- OSD](#schemas-osd)
- [Schemas -- the builder functions](#schemas-the-builder-functions)
- [Validation](#validation)
- [Operations](#operations)
- [Reading & writing other formats](#reading-writing-other-formats)
- [Inferring a schema](#inferring-a-schema)

## The two ideas

- A **Document** is a *tree*: a node is either a scalar value or an
  **ordered list of labeled edges**. "Many" is a label that repeats, not a
  field pointing to an array. See
  [the model spec, section 4](design/model.md) for the formal definition.
- A **Schema** is built from named **`record`** definitions (a closed set of
  named fields, each with a cardinality). A field's type is always exactly
  one of the seven fixed scalar kinds (optionally nullable, e.g. `string?`)
  or a `Ref` to a named record -- never a composition of the two. `Ref`s are
  how reuse and recursion work. See
  [the model spec, section 5](design/model.md) for the formal definition.

```ts
import { parseSchema, doc } from "@omnist-dev/omnist";

const s = parseSchema(
  'record User { "name": string, "age" [0,1]: integer }\nroot User'
);
s.validate(doc({ name: "Ann" })).ok; // true
```
<!-- doc-illustrative -->

## Documents

`doc(value)` builds a `Doc` from a plain JS value. An object becomes an edge
list; a key whose value is an array expands into one edge per item (a
repeated label).

```ts
import { doc } from "@omnist-dev/omnist";

const d = doc({ name: "Ann", tag: ["x", "y"] });
d.labels();                          // ['name', 'tag']
d.count("tag");                      // 2 -- 'tag' is a repeated label (an array)
d.getOne("name").value;              // 'Ann'
d.get("tag").map((t) => t.value);    // ['x', 'y']
d.toData();                          // [{label:'name',target:'Ann'},{label:'tag',target:'x'},{label:'tag',target:'y'}]
d.toGrouped();                       // {name: 'Ann', tag: ['x', 'y']} (JSON-shaped)
```
<!-- verified-by: test/docs-guide.test.ts::documents section reproduces the shown values -->

Edit through the guarded API (a repeated `add` is how an array grows):

```ts
d.add("tag", "z");     // append an edge
d.set("name", "Bob");  // replace all 'name' edges with one ('set' = 'remove' + 'add')
d.remove("tag");       // drop every 'tag' edge
d.child("name");       // a cursor to the single child
```
<!-- doc-illustrative -->

`set(label, value)` removes every edge under `label`, then inserts a single
new edge at the position of the first old occurrence (or appends, if
`label` wasn't present). On a label that occurs once, this is exactly
"replace it in place"; on a repeated label, every duplicate collapses into
that one edge.

## OML -- the native format

**OML** (Omnist Markup Language) is Omnist's own format -- the only one
that round-trips every Document shape (all seven scalars, `null`, repeated
and interleaved labels, arbitrary nesting, multiple top-level edges) with
zero adjustments. See [the OML format page](formats/oml.md) for the full
pitch, grammar, escaping rules, and edge cases.

```ts
import { readOml, writeOml, Doc } from "@omnist-dev/omnist";

const d = new Doc(readOml('name: "Ann"\ntag: "x"\ntag: "y"\njoined: 2024-01-01\n'));
d.toGrouped();          // {name: 'Ann', tag: ['x', 'y'], joined: Date(2024-01-01)}
writeOml(d.toData());   // back to OML text, byte-for-byte stable
```
<!-- doc-illustrative -->

Reach for OML whenever you're not constrained to a specific interchange
format: for example, as a config or fixture format inside your own project,
or as the artifact you snapshot/diff in tests.

`#` starts a comment that runs to end of line, legal anywhere whitespace is
legal. Comments are lexical trivia, discarded before parsing -- they never
round-trip:

```ts
import { readOml } from "@omnist-dev/omnist";

readOml("a: 1  # this note is gone\n"); // [{label: 'a', target: 1}]
```
<!-- doc-illustrative -->

`[...]` is sugar for repeated same-label edges, expanded at parse time -- it
is **not** a value type in the Document model, just an alternate way to
write the same edge list:

```ts
readOml("b: [1, 2, 3]"); // [{label:'b',target:1},{label:'b',target:2},{label:'b',target:3}]
```
<!-- doc-illustrative -->

See [Comments](formats/oml.md#comments) and [Arrays](formats/oml.md#arrays)
on the OML format page for the full grammar and edge cases.

## Schemas -- OSD

A schema is written as **OSD** (Omnist Schema Definition): `record`
definitions plus a `root`. **Cardinality `[min,max]`** is the only
multiplicity knob (required / optional / array), and a field's type is
always exactly one fixed scalar or one `Ref` -- never a composition. See
[the Schema model & OSD](schema.md#shape) for the full shape, cardinality
rules, and quoting conventions.

```
record Address { "street": string, "city": string }

record User {
    "name":          string,        # required (default cardinality [1,1])
    "nickname" [0,1]: string,        # optional
    "emails" [1,]:    string,        # one or more (an array)
    "address":       Address,        # Ref to a named record
    "note":          string?,       # nullable scalar
}
root User
```
<!-- doc-illustrative -->

Round-tripping back to text:

```ts
import { parseSchema, toOsd } from "@omnist-dev/omnist";

const s = parseSchema('record User { "name": string }\nroot User');
toOsd(s); // 'record User {\n    "name": string,\n}\nroot User\n'
```
<!-- verified-by: test/docs-guide.test.ts::osd round-trips through parseSchema and toOsd -->

## Schemas -- the builder functions

OSD text isn't the only way to build a `Schema`: `schema()`, `record()`,
`field()`, `ref()`, `nullable()`, and the `t` namespace (`t.string`,
`t.integer`, `t.number`, `t.boolean`, `t.date`, `t.time`, `t.datetime`)
build the same model programmatically -- useful for generating a schema
from something other than hand-written OSD text.

```ts
import { schema, record, field, ref, t } from "@omnist-dev/omnist";

const s = schema("User", {
  Address: record(field("street", t.string), field("city", t.string)),
  User: record(
    field("name", t.string),
    field("address", ref("Address")),
  ),
});
```
<!-- doc-illustrative -->

## Validation

`Schema.validate(doc)` returns a `ValidationResult` with `.ok` and, on
failure, one or more field-path-qualified errors.

```ts
import { parseSchema, doc } from "@omnist-dev/omnist";

const s = parseSchema('record P { "name": string }\nroot P');
s.validate(doc({ name: "Ann" })).ok;   // true
s.validate(doc({})).ok;                // false -- 'name' is required
```
<!-- doc-illustrative -->

## Operations

Schema-to-schema and schema-to-itself operations live as `Schema` methods
and standalone functions from `ops/*`: `compatibleWith`, `equivalent`,
`normalize`, `prune`, `isEmpty`, `extract`, `isomorphic`, and `lint`. See
[the API reference](api.md#operations) for signatures, and
[design/model.md](design/model.md) for what "compatible" and "equivalent"
formally mean.

## Reading & writing other formats

Every format module exports `read*`/`write*`/`check*`: `readJson`/
`writeJson`, `readYaml`/`writeYaml`, `readToml`/`writeToml`, `readXml`/
`writeXml`, plus OML's `readOml`/`writeOml`. `check*` reports the
adjustments a write would make without writing anything. See
[Formats](formats/overview.md) for the per-format mapping and caveats.

## Inferring a schema

`infer(samples)` builds a `Schema` that accepts every sample; pass
`{ allowAny: true }` to widen inconsistent fields to `any` instead of
throwing, and read the report back from `inferWithReport`.

```ts
import { infer, inferWithReport, doc } from "@omnist-dev/omnist";

infer([doc({ name: "Ann" }), doc({ name: "Bo" })]);
const { schema, report } = inferWithReport(
  [doc({ name: "Ann" }), doc({ name: 1 })],
  { allowAny: true },
);
```
<!-- doc-illustrative -->
