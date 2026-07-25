# The Schema model & OSD

A **Schema** is Omnist's other central feature, alongside
[OML](formats/oml.md). It's written as **OSD** (Omnist Schema Definition) --
a small, closed text language for describing the shape a Document must
have: `record` definitions -- a closed set of named fields, each with a
cardinality -- plus a `root` saying which one a document validates against.
There's no JSON Schema-style open-ended composition: a field's type is
always **exactly one** fixed scalar or one reference to another record,
never a union, enum, or literal value.

```ts
import { parseSchema, doc } from "@omnist-dev/omnist";

const s = parseSchema(`
    record Database { "type": string, "server": string, "port": integer }
    record Service  { "host": string, "port": integer,
                       "databases" [1,]: Database, "tags" [0,]: string }
    root Service
`);
s.validate(doc({
  host: "api.internal", port: 8443,
  databases: [{ type: "prod", server: "db1.internal.example.com", port: 5432 }],
  tags: ["prod", "us-east"],
})).ok; // true
```
<!-- doc-illustrative -->

## Shape

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

- **Field labels are always quoted** (they're data strings, and may contain
  spaces: `"home address"`). An unquoted identifier in type position is a
  *schema name* -- a scalar keyword (`string`, `integer`, ...) or a `Ref` to
  a record.
- **Cardinality `[min,max]`** is the only multiplicity knob: `[1,1]`
  required (the default -- omit the brackets), `[0,1]` optional, `[0,]`
  zero-or-more, `[1,]` one-or-more, `[2,5]` bounded. **There is no separate
  array type** -- an array is just a field with `max > 1`.
- A field's type is **always exactly one** of the seven fixed scalars
  (`string`, `integer`, `number`, `boolean`, `date`, `time`, `datetime`),
  optionally suffixed `?` for nullable (`string?`), or a `Ref` (an unquoted
  name) to a named record. `?` is independent of cardinality -- a
  *required* field can still be nullable (it must appear, but its value may
  be `null`). `?` never applies to a `Ref`; a record that may be absent is
  `[0,1]`, never `Ref?`.
- **Records are closed** -- an unexpected label is a validation error, not
  silently ignored.

All of this is defined formally, with proofs, in
[the model spec](design/model.md).

## The `any` type

A field may be typed `any`: its value is accepted *unchecked* -- any
scalar, `null`, or a nested subtree of any shape -- and validation does not
descend into it. The field's **label** is still fixed, declared, and
counted: cardinality applies exactly as for every other field. Only the
value's shape is unconstrained. See
[design/any-type-spec.md](design/any-type-spec.md) for the formal spec.

```ts
import { doc, parseSchema } from "@omnist-dev/omnist";

const s = parseSchema(`
record Event {
    "id":      string,
    "type":    string,
    "data":    any,
}
root Event
`);

// Two payloads with completely different shapes -- one schema accepts both.
s.validate(doc({ id: "evt_1", type: "user.created",
                  data: { name: "Ann", email: "a@x.com" } })).ok;      // true
s.validate(doc({ id: "evt_2", type: "payment.settled",
                  data: { amountCents: 1250, currency: "EUR" } })).ok; // true
```
<!-- doc-illustrative -->

## Validation

`schema.validate(doc)` returns a `ValidationResult`: `.ok` plus, on
failure, an array of field-path-qualified errors. `schema.validates(doc)`
is a shorthand for `schema.validate(doc).ok`.

## Operations

- `schema.compatibleWith(other)` -- true iff every document `other` accepts,
  `schema` also accepts (backward compatibility).
- `schema.equivalent(other)` -- true iff the two schemas accept exactly the
  same set of documents.
- `schema.normalize()` -- a canonical form: merges equivalent records,
  useful before comparing schemas structurally.
- `schema.prune()` / `schema.isEmpty()` -- remove/detect unsatisfiable
  branches (a schema whose language is empty, e.g. contradictory
  cardinality).
- `extract(schema, keep)` -- the sub-schema reachable from a subset of root
  fields.
- `isomorphic(a, b)` -- true iff the two schemas are the same graph up to
  record renaming.
- `lint(schema)` -- structural findings (unreachable records, redundant
  fields) short of an outright validation error.

See [the API reference](api.md#operations) for exact signatures and
[design/model.md](design/model.md) for the formal semantics behind
"compatible" and "equivalent."

## OSD grammar

The full ABNF grammar, verified against the parser, lives at
[design/schema-osd-grammar.md](design/schema-osd-grammar.md).
