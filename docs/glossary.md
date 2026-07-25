# Glossary

One definition per term, grouped by concept area. Where two terms look
similar but mean different things, the entry says so explicitly.

## Document model terms

These describe the **data** -- the canonical tree every supported format
reads into and writes out of. Defined formally in
[the model spec](design/model.md).

- **node** -- the canonical value of the Document model: either a scalar
  value (a leaf), or an ordered list of labeled edges (an internal node).
  `Node` is the TypeScript type for this shape, independent of the `Doc`
  wrapper class.
- **Document** -- the data model as a whole: "a Document is a tree of
  ordered, labeled edges." Used for the *concept*, not a specific class --
  a `Node` *is* a Document, in the sense that any node is an instance of
  the Document model.
- **`Doc`** -- the guarded wrapper class around a node, with navigation and
  editing helpers (`.edges()`, `.get()`, `.add()`, ...). Where "Document"
  names the model/concept, `Doc` is the specific class that holds one.
- **edge** -- a `{ label, target }` pair: the Document-model unit of
  structure. "Many" is a repeated label, i.e. several edges sharing one
  label -- not a single edge pointing at an array. Contrast with
  **field**, the Schema-model term for the corresponding named,
  cardinality-bound slot a record declares.
- **label** -- the string key half of an edge. The same word is used on
  the Schema side for a field's name (`Field.label`) -- by design, since a
  field's label is exactly the edge label it constrains.
- **leaf** -- a node holding a scalar value rather than a list of edges.
  `Doc.isLeaf` is `true` exactly for this case.
- **Scalar** (lowercase type, `Scalar` in `document.ts`) -- a value that
  can sit at a Document leaf: `string`, `number`, `boolean`,
  `Date`/(date-only or datetime), or `null`.

## Schema model terms

These describe the **constraint** -- the shape a Document must have to be
valid. Defined formally in [the model spec](design/model.md).

- **`ScalarType`** -- the Schema-side type object: one of the seven fixed
  kinds (`string`, `integer`, `number`, `boolean`, `date`, `time`,
  `datetime`), optionally nullable, used as a field's type (`t.string`,
  `nullable(t.string)`).
- **`Field`** -- a named, cardinality-bound slot in a record: a label, a
  `FieldType` (a `ScalarType`, a `RefType`, or `any`), and `[min, max]`.
- **`Record`** -- a closed, ordered set of `Field`s.
- **`RefType`** / **`ref()`** -- a reference to a named record by name, used
  as a field's type for composition and recursion.
- **`Schema`** -- a root `RefType` plus an environment (`Map<string,
  Record>`) of named records it can resolve through.
- **OSD** -- Omnist Schema Definition, the text syntax `parseSchema`/`toOsd`
  read and write.
- **cardinality** -- a field's `[min, max]` bounds; `max === null` means
  unbounded.
- **`any`** -- a field type that accepts any value (scalar or subtree)
  unchecked, while still fixing the field's label and cardinality. See
  [design/any-type-spec.md](design/any-type-spec.md).

## Operations

- **validate** -- `schema.validate(doc)`, returns a `ValidationResult`.
- **compatibleWith** -- backward-compatibility check between two schemas.
- **equivalent** -- true iff two schemas accept exactly the same documents.
- **normalize** -- canonical form of a schema (merges equivalent records).
- **prune** / **isEmpty** -- remove/detect unsatisfiable branches.
- **infer** -- build a `Schema` from example documents.
- **lint** -- structural findings short of a validation error.

## Format terms

- **OML** -- Omnist Markup Language, the library's own zero-adjustment
  native format.
- **adjustment** -- a lossy or normalizing change a `write*` call makes to
  fit a target format (reported by `WriteReport`/`check*`).
- **`WriteReport`** -- the object `finishWrite` returns, carrying any
  `Adjustment`s a write made.
