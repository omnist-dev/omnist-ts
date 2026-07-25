# Python parity

`omnist-ts` is a hand-written port of the Python
[`omnist`](https://github.com/omnist-dev/omnist) library, built against the
Python source and [the model spec](design/model.md) rather than transpiled.
This page records a systematic side-by-side comparison of the two
implementations, done after the full port and the security/performance
hardening pass shipped (issue
[#48](https://github.com/omnist-dev/omnist-ts/issues/48)).

The comparison ran both libraries over shared corpora and diffed the
results: `omnist` 0.7.8 on CPython 3.13, against this port at
`v0.0.2-alpha`. Every claim below is pinned by a test in
`test/python-parity.test.ts` or by a named source location.

- [Confirmed identical](#confirmed-identical)
- [Deliberate, documented divergences](#deliberate-documented-divergences)
- [Newly discovered gaps](#newly-discovered-gaps)

## Confirmed identical

### Document model

`src/document.ts` against `omnist/document.py`. Twenty-nine paired probes
over node construction, navigation and mutation returned identical results:
a bare array, an array of arrays, a cycle, a non-string key and an
unsupported value type all raise `DocumentError`; a shared but non-cyclic
subtree is accepted; `edges()` numbers repeated labels the same way (`$.a`,
`$.a[1]`); `getOne` on a missing or repeated label raises; `set` reinserts
at the first old occurrence and drops later duplicates; `remove`, `labels`
and `count` agree; `toGrouped` applies the same count-1 rule. Equality is
order-sensitive on both sides.

Both implementations share `MAX_DEPTH = 200` (`src/document.ts:47`,
`omnist/document.py:34`) and the `MAX_INT_DIGITS = 4300` constant.

**The depth-boundary numbering noted during issue
[#37](https://github.com/omnist-dev/omnist-ts/issues/37) was re-measured,
and the earlier description of it was wrong.** Reader by reader, the
deepest accepted nesting is identical in both languages: JSON 200, YAML
200, OML 200, XML 201. OML is *not* off by one; only XML is. That
off-by-one is inherited from the Python source, whose `_xml_to_node` starts
its recursion at depth 0 for the document element `read_xml` has already
wrapped in an edge. Faithful parity, not a port defect, so it stays as-is.
(Verified via `test/python-parity.test.ts`, depth boundary.)

### Schema model

`src/schema.ts` against `omnist/schema.py`. A 144-cell `matchesKind` and
`valueKind` cross-table over 18 representative values and all seven scalar
kinds matched in 139 cells; the five that differ are the documented scalar
collapses below. The two rules model.md section 10 singles out hold
exactly:

- **`boolean` never satisfies `integer` or `number`**, and nothing but a
  boolean satisfies `boolean`.
- **`date` and `datetime` stay mutually exclusive** for the string form
  unconditionally, and for the object form whenever the `Date` carries an
  issue-#14 kind tag.

Cardinality validation, closed-record enforcement, and the five error codes
(`unexpected-field`, `cardinality`, `type-mismatch`, `null-not-allowed`,
`shape-mismatch`) fire in the same situations with the same codes. `any`
resolves to itself and short-circuits conformance on both sides, and
`nullable(t.any)` raises on both.

### OSD

`src/osd.ts` against `omnist/osd.py`. A 32-case corpus covering every
production in [the OSD grammar](design/schema-osd-grammar.md) plus its
error paths -- all four cardinality spellings, empty and reversed
cardinality, a fractional bound, `?` on a scalar and (illegally) on a ref,
`any` and the rejected `any?`, reserved scalar and `any` record names,
duplicate definitions, a missing or unknown root, comments, unquoted and
escaped labels, trailing garbage -- produced **identical results in all 32
cases**, both the accepted parses (compared as round-tripped
`toOsd(..., { indent: null })` text) and the rejected ones.

### OML

`src/oml.ts` against `omnist/oml.py`. A 78-case corpus covering
[the OML grammar](design/oml-grammar.md): integer, float and exponent
spellings; the rejected hex, binary, octal, underscore-separated and
leading-zero forms; `nan` and `inf`; the boolean and null keywords and
their rejected capitalizations; the six accepted string escapes plus five
rejected ones and an unterminated string; date, time and datetime literals
including out-of-range ones; arrays (empty, trailing comma, nested, of
objects); nested nodes; separators; comments; quoted and unquoted labels;
and eleven malformed inputs. **68 of 78 cases are byte-identical**,
including every rejection. The ten that differ are all instances of the
scalar collapses and the two OML gaps listed below.

### Codecs

`src/formats/*.ts` against the matching sections of `omnist/formats.py`.
Both implementations define the same nine adjustment codes and no others:
`temporal.stringified`, `null.omitted`, `string.ambiguous`,
`key.sanitized`, `float.special`, `shape.empty_ambiguous`,
`string.illegal_xml_char`, `string.cr_normalized`,
`string.line-break-char`.

A 32-document corpus was run through all five `check*` functions on both
sides (160 reports), comparing every path, code and severity triple.
**157 of 160 matched exactly**: same code, same path, same severity, same
order. Coverage included nulls at the root and nested; dates and
datetimes; NaN, Infinity and negative Infinity; invalid and leading-digit
XML names; an empty internal node; eight `string.ambiguous` candidate
spellings; a C0 control character; CR; U+0085 in both label and value
position; a BMP noncharacter; repeated labels; and an empty root. The three
mismatches are the XML coercion gap below.

Writer output was compared over an 18-document corpus. Textual differences
are confined to serializer-library formatting (TOML array style, YAML
block-sequence indentation and quote choice, exponent rendering) plus the
scalar collapses. No adjustment and no refusal differs.

### infer and deserialize

`src/infer.ts` and `src/deserialize.ts` against `infer.py` and
`deserialize.py`. Both implement the same five-step inference algorithm
with the same two-pass label ordering, the same widening once any sample
repeats a label, the same `integer`/`number` subset collapse, the same
generated-name uniquifying, and the same `allowAny` fallback reasons.
`materialize` implements the same conversion and rejection table from
model.md section 10 and reuses `matchesKind` as its shape check, so
`validate` and `materialize` agree -- with the one exception recorded as a
gap below.

### Schema algebra

`src/ops/*.ts` against `omnist/ops/*.py`. A 20-schema corpus (recursive
records, mandatory ref cycles, zero-max fields, unreachable records,
structurally duplicate records, `any` fields, nullable scalars, mixed
cardinalities) was run through `isEmpty`, `prune`, `normalize`,
`satisfiableSet`, `equivalenceClasses`, `lint` and `extract`, and all 400
ordered pairs through `compatibleWith` and `equivalent`. **Every
satisfiability, minimization, subschema and extraction answer matched,
including every error case** -- the no-valid-subschema `SchemaError` from
`extract` fires on the same inputs. Two of 560 comparisons differ, both
purely in the *ordering* of otherwise-identical output; see the gaps
section.

### CLI

`src/cli.ts` against `omnist/cli.py`. A 37-invocation matrix was run
through both binaries. Subcommand and flag coverage is identical
(`format`, `convert`, `check`, `validate`, `infer`, and `schema` with
`format`, `normalize`, `prune`, `is-empty`, `extract`, `lint`,
`compatible-with` and `equivalent`), and so are **every exit code** -- `0`
for success, `1` for a negative-but-valid answer or an adjustment under
`--strict`, `2` for usage and data or IO errors -- and **every `--json`
and `--result-format` payload shape**, the same keys in the same nesting:

- `{ok, errors[{path, message}]}` for a validation result;
- `{ok, message, errors[{path, code, message}]}` for a failure;
- `[{path, code, message, severity}]` for a write report;
- `{ok, findings[{code, severity, location, message}]}` for lint;
- a single-key boolean object for `is-empty`, `compatible-with` and
  `equivalent`.

Both send a `--report` write report to stderr and the document itself to
stdout.

Differences are confined to message *text*, which the stability policy does
not pin: the version string, repr-style quoting (single versus double
quotes around a value inside a message), the underlying parser wording
(`JSON.parse` versus the CPython `json` module, `ENOENT` versus the CPython
errno form), and the `argparse` usage block versus the hand-rolled one
here. Error *codes* and types match.

### Public API surface

Every name in the Python `__all__` has an exported equivalent, with two
exceptions noted under gaps. The Python class-based `Scalar`, `Ref`,
`Field`, `Record` and `AnyType` map to discriminated-union types here plus
the `ref`, `field`, `record`, `t` and `ANY` builders, and `Error` maps to
`OmnistIssue`. Because TS has no operator overloading, the Python dunders
and small methods map to exported helpers: `fieldTypeEquals`,
`recordEquals`, `schemaEquals`, `validationResultToString`, `recordField`
and `cardinalityStr`. `DetachedNode` and `UnsafeXMLWarning` are exported
and unraised on both sides.

## Deliberate, documented divergences

These are design consequences of the target language, not defects. Each was
decided deliberately and is described in the relevant module header.

### 1. `integer` and `number` collapse onto one `number` (issue #3)

JS has a single numeric type, so the Document layer cannot hold the
`int`/`float` distinction Python does. Kind *tracking* for `integer` versus
`number` lives entirely in the Schema layer.

Consequences, all verified: `matchesKind(1.0, "integer")` is `true` here and
`False` in Python; `valueKind(1.0)` is `"integer"` here and `"number"`
there; `readJson` of `1.0` yields the integer `1`; `materialize` of a
`number` field returns the value unchanged rather than upgrading it to a
float; and writers emit `1` where Python emits `1.0`. (Verified via
`test/python-parity.test.ts`, documented scalar collapses.)

### 2. `date` and `datetime` collapse onto one `Date`, with kind tagging (issue #14)

Both kinds map to the native `Date`. `src/temporal.ts` tags a `Date` with
the kind it was actually read as, via a `WeakMap`, at the two (and only two)
places that construct one from text whose kind is known: the OML tokenizer
and `materialize`. `matchesKind` consults that tag, so the cross-schema
ambiguity the collapse would otherwise create is resolved for every `Date`
that came from a schema-directed parse.

The documented residual holds and is confirmed accurate: a bare `Date`
constructed by application code carries no tag and stays ambiguous by
necessity -- it satisfies whichever of `date`/`datetime` a field declares.
(Verified via `test/python-parity.test.ts`, tagged versus untagged Date.)

One knock-on not previously written down: `valueKind` returns `"datetime"`
even for a `date`-tagged `Date`, where Python returns `"date"`. This affects
only the type name inside a `type-mismatch` message, never a verdict.

### 3. `time` is a plain string

JS has no bare time-of-day type, so a `time` scalar is an ordinary string at
the Document layer. Python holds a real `datetime.time`.

Consequences: `readToml` of a TOML time literal yields a string, and writing
it back produces a quoted TOML string rather than a time literal; and the
`temporal.stringified` code for a `time` leaf has
nothing to fire on here, because there is no Document value this port would
recognize as a time rather than a string. Both are accepted lossiness. The
OML case is *not* accepted lossiness and is filed as a gap below, because
OML has a native TIME token.

### 4. TOML local versus offset datetime (issue #26)

`src/formats/toml.ts` keeps a module-local `WeakSet` marking datetimes read
from an offset-less TOML literal, so they are written back offset-less
instead of defaulting to `Z`. Confirmed still working in both directions.
(Verified via `test/python-parity.test.ts`, TOML preserves local-vs-offset.)

### 5. Reader strictness inherited from the underlying parsers

Two acceptance differences where this port is the stricter, spec-correct
side, and the Python behavior is CPython-library leniency:

- `readJson` rejects the non-standard `NaN` and `Infinity` literals that
  the CPython `json` module accepts. Python can therefore read a JSON
  document its own `write_json` refuses to emit.
- `readYaml` rejects a duplicate mapping key, where PyYAML silently keeps
  the last one.

(Verified via `test/python-parity.test.ts`, reader strictness.)

### 6. `buildNode` also accepts a JS `Map`

`buildNode` treats a `Map` as an ordered-entries container alongside a plain
object; Python accepts only a `dict`. This is input convenience at the
boundary and is unrelated to the refused schema-level `Map` type (see
[Openness](design/openness.md)).

## Newly discovered gaps

Each of these is a behavioral divergence that is not a language consequence
and not a decision anyone made. All nine are filed as their own issues
(#49 through #54, #56 through #58); none are fixed here, per the issue #48
plan.

### G1. Calendar-invalid date strings pass `validate` (`src/schema.ts:263`)

Tracked as issue [#49](https://github.com/omnist-dev/omnist-ts/issues/49).

`isIsoDateString` shape-checks with a regex and then defers to
`Date.parse`, which rolls a day overflow forward instead of failing
(`Date.parse("2024-02-30")` is 1 March, not `NaN`). So a nonexistent
calendar date validates as a `date`, and the same string with a time
attached validates as a `datetime`. Python rejects both via
`date.fromisoformat`, and model.md section 10 says a string that is not a
valid bare ISO date must be rejected.

This also breaks an invariant `src/deserialize.ts` states outright --
that `validate` and `materialize` can never disagree, because both go
through `matchesKind`. They do disagree: `materialize` additionally runs
`parseDateToken`, which *is* calendar-validated, and rejects. The
`/* v8 ignore start -- unreachable */` pragma on that branch in
`materializeTemporal` is therefore wrong; the branch is live.

```ts
matchesKind("2024-02-30", "date");        // true   (Python: False)
matchesKind("2024-02-30T00:00", "datetime"); // true (Python: False)

const s = parseSchema('record R { "d": date }\nroot R');
s.validate(doc({ d: "2024-02-30" })).ok;  // true
materialize(buildNode({ d: "2024-02-30" }), s); // throws ParseError
```
<!-- verified-by: test/python-parity.test.ts -->

### G2. Hour 24 passes `validate` as a `time` (`src/schema.ts:268`)

Tracked as issue [#50](https://github.com/omnist-dev/omnist-ts/issues/50).

`isIsoTimeString` composes `1970-01-01T` + the value and hands it to
`Date.parse`, which accepts `24:00` as end-of-day. Python rejects it, and so
does the `parseTimeToken` helper in this port (`src/temporal.ts`, `hh > 23`), so the
OML tokenizer and `matchesKind` disagree about the same spelling.

```ts
matchesKind("24:00", "time");     // true (Python: False)
readOml("a: 24:00");              // throws ParseError
```
<!-- verified-by: test/python-parity.test.ts -->

### G3. `writeOml` erases a UTC offset (`src/oml.ts`)

Tracked as issue [#51](https://github.com/omnist-dev/omnist-ts/issues/51).

Issue #26 fixed the local-versus-offset asymmetry for TOML only. `oml.ts`
has the same asymmetry, unfixed: an offset datetime read from OML is
normalized to UTC and written back with no offset at all. The instant
survives a same-implementation round-trip, but the *text* changes, and a
Python reader interprets the offset-less result as a naive local datetime --
so the value drifts across implementations.

```ts
writeOml(readOml("a: 2024-01-01T12:00:00-08:00"));
// "a: 2024-01-01T20:00:00"   (Python: unchanged, offset preserved)
```
<!-- verified-by: test/python-parity.test.ts -->

### G4. An OML TIME literal does not round-trip (`src/oml.ts`)

Tracked as issue [#52](https://github.com/omnist-dev/omnist-ts/issues/52).

Because `time` is a plain string here, an OML TIME token reads as a string
and is re-emitted *quoted*. Unlike JSON or XML, OML has a native TIME token,
so this is the one format where the port discards information the format
itself can carry.

```ts
writeOml(readOml("a: 12:00"));   // 'a: "12:00"'  (Python: a: 12:00:00)
```
<!-- verified-by: test/python-parity.test.ts -->

### G5. XML scalar coercion is narrower than Python (`src/formats/xml.ts:196`)

Tracked as issue [#53](https://github.com/omnist-dev/omnist-ts/issues/53).

`coerce` uses two numeric regexes; Python `_coerce` uses `int()` and
`float()`, which additionally accept `nan`, `inf`, `infinity` and
underscore-separated digits. The same XML therefore reads as a different
Document. Because reader and writer agree internally, `checkXml` correctly
omits `string.ambiguous` for those spellings -- which is *why* three of the
160 report comparisons differ.

The behavior here is arguably the better one (Python leaks
Python-specific literal syntax into a data format, and can produce a NaN
that JSON cannot then represent), but it is undocumented on either side of
the port and needs a decision, not silence.

```ts
readXml("<r><a>nan</a></r>");
// [{label:"r", target:[{label:"a", target:"nan"}]}]
// Python: [("r", [("a", nan)])] -- a float
```
<!-- verified-by: test/python-parity.test.ts -->

### G6. Integer-literal limits diverge, and disagree between codecs

Tracked as issue [#54](https://github.com/omnist-dev/omnist-ts/issues/54).

Three different behaviors for one class of input:

- `readJson` and `readYaml` accept an integer literal past the documented
  4300-digit cap and silently yield `Infinity`, which `writeJson` then turns
  into `null` with a `float.special` error. Python raises `ParseError`.
- `readToml` rejects *any* integer past 2^53 outright (via `smol-toml`),
  which Python accepts exactly.
- So the same over-large integer is silently corrupted by two readers and
  refused by a third.

`checkIntDigits` in `src/document.ts` carries a comment calling the cap
dormant for JS numbers. That is true of the *model* layer but leaves the
reader layer with no guard at all.

```ts
readJson('{"a": ' + "1".repeat(4301) + "}");
// [{label:"a", target:Infinity}]   (Python: raises ParseError)
readToml("a = 9007199254740993");
// throws ParseError                (Python: reads it exactly)
```
<!-- verified-by: test/python-parity.test.ts -->

### G7. Ordering of output documented as deterministic

Tracked as issue [#56](https://github.com/omnist-dev/omnist-ts/issues/56).

Two spots where both implementations are deterministic but disagree:

- `lint` sorts findings with `localeCompare` (`src/ops/lint.ts`), where
  Python sorts by codepoint. Record names differing in case come out in a
  different order, which matters for anything diffing
  `omnist schema lint --json` output.
- `prune` rebuilds its environment in traversal order rather than preserving
  the authored declaration order Python keeps, so `omnist schema prune`
  emits the same records in a different sequence.

```ts
// Python lint order: ["B", "aaa"]; here: ["aaa", "B"]
// Python prune env order: ["A", "B", "R"]; here: ["R", "B", "A"]
```
<!-- verified-by: test/python-parity.test.ts -->

### G8. `docs/formats/*.md` document none of the nine adjustment codes

Tracked as issue [#57](https://github.com/omnist-dev/omnist-ts/issues/57).

Python documents each codec at length -- the coercion heuristic, the
round-trip caveats, and every adjustment code the writer can emit, with
worked examples. The five pages under `docs/formats/` here are short
orientation stubs: none of the nine codes appears in any of them (the only
mention anywhere in `docs/` is one example in `cli.md`). The behavior is
implemented and tested; only the user-facing explanation is missing.

### G9. Two public-surface omissions

Tracked as issue [#58](https://github.com/omnist-dev/omnist-ts/issues/58).

- The seven module-level scalar constants Python exports in `__all__`
  (`STRING`, `INTEGER`, `NUMBER`, `BOOLEAN`, `DATE`, `TIME`, `DATETIME`)
  have no exported equivalent; only the `t` namespace is reachable.
- `omnist.ops` is an importable public submodule in Python, so
  `satisfiable_set` and `equivalence_classes` are callable. Here the package
  `exports` map only publishes `.`, and neither function is re-exported from
  `src/index.ts`, so neither is reachable by a consumer.

### Not filed

Two message-text-only differences, exempt under the stability policy and
recorded here only so a future comparison does not re-discover them: the
error path for an identifier-shaped non-ASCII key is bracketed here
(`$["cafe"]`) and dotted in Python, because the identifier test is an
ASCII-only regex rather than `str.isidentifier()`; and `valueKind` on a
`date`-tagged `Date` reports `datetime` (see divergence 2).
