# TS implementation decisions

Design-tier decisions that the Python source doesn't answer, because they're
specific to porting the model into TypeScript's type system and tooling.
Each is a prerequisite for the issue(s) noted, so an implementer can build
without stopping to ask. Ported behavior itself is *not* re-decided here —
only "how do we represent/organize this in TS," never "what should it do"
(that answer is always the Python source + `docs/design/model.md`).

## 1. `Type` representation: discriminated union, not a class hierarchy

**Blocks:** issue #3 (Schema model) and everything downstream of it.

Python's `Type = Scalar | Ref(Name)` (plus `AnyType`, model.md §5) is a
closed three-way sum: a field's type is a `Scalar`, a `Ref`, or `any` --
never a fourth thing, never a combination (§5's "never a composition" rule
is the whole point of the model). TypeScript's idiomatic representation of
a closed sum is a **discriminated union** with a literal tag, not an
`instanceof`-checked class hierarchy: it gives exhaustiveness checking
(`switch` + `never` on the tag catches an unhandled case at compile time,
which directly enforces the "never a fourth thing" rule the model
requires), plain-object structural equality (no reference-identity trap),
and trivial JSON round-tripping for anything that needs to serialize a
`Type`.

```ts
export type FieldType = ScalarType | RefType | AnyFieldType;

export interface ScalarType {
  readonly tag: "scalar";
  readonly scalarKind: ScalarKind; // "string" | "integer" | ... (the 7 kinds)
  readonly nullable: boolean;
}

export interface RefType {
  readonly tag: "ref";
  readonly name: string;
}

export interface AnyFieldType {
  readonly tag: "any";
}

export type ScalarKind =
  | "string" | "integer" | "number" | "boolean"
  | "date" | "time" | "datetime";
```

Naming note: Python's `Scalar` dataclass calls its own kind field `kind`.
In TS, `kind` is reserved as the outer discriminant name across the whole
schema-model type family (`Field.type.tag` in the snippet above is named
`tag`, not `kind`, specifically to avoid this collision) -- the scalar's
own kind is `scalarKind`. Keep this rename localized to `schema.ts`; it's a
naming accommodation, not a semantic difference from Python.

`Record`, `Field`, and `Schema` follow the same shape: plain `readonly`
data interfaces for `Field`/`Record` (matching Python's dataclass-like
immutability), but `Schema` stays a **class** with methods
(`validate`, `compatibleWith`, `equivalent`, `normalize`, `extract`,
`prune`, `isEmpty`) -- matching the agreed "mirror Python's API shape"
decision (methods, not free functions, for the schema-algebra entry
points a caller invokes). Internally those methods delegate to the pure
functions in `ops/*.ts` (see decision 2) rather than containing the
algorithm themselves, exactly as `omnist/schema.py`'s `Schema` class
delegates to `omnist/ops/*.py`.

Since TS has no operator overloading, Python's `__eq__`/`__hash__`/`__repr__`
dunders (exercised by `test_canonical.py`'s dunder tests) become named
functions: `recordEquals`, `schemaEquals`, `fieldTypeEquals`, etc. --
structural comparison, not `===`. Document these explicitly in issue #3 so
the port doesn't silently rely on reference equality where Python relied on
value equality.

## 2. Schema algebra: pure functions over `Map`, not classes

**Blocks:** issue #6 (`ops/*.ts`).

Python's `ops/*.py` modules (`prune.py`, `minimize.py`, `subschema.py`,
`extract.py`, `lint.py`, `isomorphic.py`) are free functions operating on
`(root, env)` pairs, using dicts/sets/dicts-of-sets for fixpoint
bookkeeping (satisfiable-set computation in `prune.py`, partition-block
maps in `minimize.py`). The direct, idiomatic TS analog:

- **Pure functions**, not methods on a class, in each `ops/*.ts` module --
  `prune(schema: Schema): Schema`, `normalize(schema: Schema): Schema`,
  etc. -- taking and returning immutable `Schema` values (a new `env` Map,
  never mutating the input), matching Python's own "operations return a new
  Schema" contract.
- **`Map<string, Record>`** for the environment (direct analog of Python's
  `dict[str, Record]`), **`Set<string>`** for satisfiable-record tracking
  and reachability, **`Map<string, string>`** for the partition-refinement
  block-id assignment in `minimize.ts`.
- **Iterative fixpoint loops** (`while (changed) { ... }`, a boolean
  `changed` flag flipped inside the loop body) -- matching the small,
  direct style of the Python originals (`prune.py`/`minimize.py` are 65/55
  lines respectively; no need for a generator/coroutine abstraction).
- `Schema.prototype.prune()`/`.normalize()`/`.compatibleWith()`/etc. are
  thin wrappers calling into `ops/*.ts`'s exported functions, so the
  algebra itself stays testable in isolation (issue #6's tests target the
  `ops/*.ts` functions directly, same as `test_canonical.py`'s
  `TestOperations` class does against the Python functions, not just
  through `Schema`'s public methods).

## 3. Fuzzing: Hypothesis strategies → fast-check equivalents

**Blocks:** issue #10, but decisions here apply per-module as each op's
tests are written (issue #6 onward), not deferred to the end.

Mapping from `tests/test_fuzz.py`'s Hypothesis strategies to `fast-check`:

| Hypothesis (Python) | fast-check (TS) | Used for |
|---|---|---|
| `st.recursive(...)` / manual depth-guarded recursion | `fc.letrec(tie => ({...}))` | Nested Document node generation, up to depth 5 |
| `st.one_of(...)` | `fc.oneof(...)` | Choosing among the 7 scalar kinds + null at each leaf |
| `st.sampled_from([...])` | `fc.constantFrom(...)` | Fixed enumerations (scalar kind names, adjustment codes) |
| `st.text()`, `st.integers()`, `st.floats()`, `st.booleans()` | `fc.string()`, `fc.integer()`, `fc.double()`, `fc.boolean()` | Scalar leaf values, including edge cases (signed zero, NaN/inf via `fc.double({ noNaN: false })`) |
| `st.dates()`/`st.times()`/`st.datetimes()` (year 1-9999 range) | `fc.date({ min, max })` + custom time/datetime composition (`fc.date` alone doesn't split date/time/datetime the way the model does -- compose from `fc.integer` field ranges where needed) | Temporal scalar leaves |
| custom alphabet strategies (OML/OSD-syntax-biased text) | `fc.stringOf(fc.oneof(fc.constantFrom(...syntaxChars), fc.char()))`, weighted via `fc.oneof`'s `weight` option | Crash-freedom fuzzing of `readOml`/`parseSchema` |
| `assume(...)` | `fc.pre(...)` | Filtering out known, separately-tracked excluded cases (mirroring Python's own excluded-case comments, e.g. `"inf"`/`"nan"` labels) |
| `max_examples=150`, `deadline=None`, `HealthCheck.too_slow` suppressed | `fc.assert(fc.property(...), { numRuns: 150 })` (fast-check has no per-example deadline concept to suppress) | Module-level settings, applied per test file |

fast-check ships built-in shrinking (same role as Hypothesis's), so no
translation needed there. Property test *organization* mirrors Python's
`test_fuzz.py` file-for-file: round-trip fuzzing per codec (OML exact,
others exact-modulo-documented-adjustments), crash-freedom fuzzing of
`readOml`/`parseSchema`, and the `equivalent()` vs. `_isomorphic()`
cross-check property from `docs/testing.md`'s "triple-checked algebra"
section, ported once `ops/minimize.ts` and `ops/isomorphic.ts` both exist
(issue #6).
