# Changelog

All notable changes to this project are documented here. The format is
loosely based on [Keep a Changelog](https://keepachangelog.com/). This is
the first documented release of the TypeScript port; the public API
mirrors the upstream Python package's `__all__` (camelCase names of the
same functions).

## [v0.0.2-alpha] -- security and performance hardening

A security and performance audit pass over the v0.0.1-alpha codebase,
following the same fuzz/profile/measure discipline as the rest of this
project -- every finding here was either reproduced with real
measurements or confirmed via property-based fuzzing, not asserted.

**Security fixes:**
- **XML sanitizer only replaced the first illegal character per string**
  (issue #36): `xmlSanitize` used a non-global regex with `.replace()`,
  so a value with multiple XML-illegal control characters left every
  character after the first as a raw, unescaped byte in the output --
  malformed XML that Python's `ElementTree` correctly rejects, breaking
  cross-port interop. Fixed with a dedicated global-flagged regex for the
  replace call, keeping the original non-global regex for its `.test()`
  use elsewhere (avoiding a stateful-`lastIndex` pitfall).
- **MAX_DEPTH guard bypass via `Doc.add`/`Doc.set`** (issue #37): both
  methods restarted the depth counter at 0 on every mutation instead of
  accounting for the cursor's actual depth, letting a document be built
  arbitrarily deep through the public `Doc` API despite the documented
  ~200-level guard. `Doc` now tracks its own depth correctly through
  `child()`/`edges()`/`add()`/`set()`. Also added depth guards to
  `nodeEquals()`/`reprNode()` (backing `Doc.equals()`/`Doc.toString()`),
  which previously let a raw `RangeError` (stack overflow) escape instead
  of the library's own `DocumentError` on a sufficiently deep node. Along
  the way, corrected four `v8 ignore`-annotated "unreachable" branches in
  the format writers' depth checks that were actually reachable via the
  public `writeJson`/`writeYaml`/`writeToml`/`writeXml` API independent of
  the `Doc`-level bug -- each now has a real test instead of a pragma.
- **`fast-xml-parser` dependency advisory** (issue #38, informational):
  confirmed the vulnerable `XMLBuilder` class this port never imports or
  uses (`writeXml` hand-writes its own XML) -- not exploitable here, but
  documented since no `4.x` release clears the advisory.

**Performance fixes:**
- **OML tokenizer dispatch was allocating and linear-scanning on every
  token** (issue #35): `Scanner.next()` used
  `Object.keys(match.groups).find(...)` to identify which named capture
  group matched, allocating a fresh array and scanning it roughly
  400,000-500,000 times for a 100k-edge document. Replaced with a cached
  static group-name array walked by index. Measured ~2-4.5x faster
  `readOml` at 25k-100k edges (machine-dependent; a shared/contended
  benchmark host showed smaller but still real gains on independent
  re-measurement).
- **YAML read/write investigated and found inherent, not a bug** (issue
  #43): profiled and confirmed over 90% of `readYaml`/`writeYaml` time is
  inside the `yaml` npm package's own parser/serializer, not this port's
  wrapper code (which measured as fast as JSON's equivalent steps).
  Documented in the new performance page rather than "fixed," since
  there's nothing in this port's control to fix.
- **YAML merge-key (`<<`) is a genuine cross-implementation limitation**
  (issue #46): a document edge labeled exactly `<<` triggers unconditional
  merge-key interpretation in the `yaml` package's `yaml-1.1` schema
  (needed for PyYAML-compatible parsing), with no clean way to disable it
  without breaking real merge-key support. Confirmed PyYAML has the
  identical limitation by direct reproduction. Excluded from the fuzz
  suite's label generator (matching the documented-exclusion precedent
  already used for `inf`/`nan`/`-inf` and NEL) and documented as a known
  limitation, rather than silently left as an intermittent fuzz flake.

**New: performance benchmark suite** (issue #42) -- `tools/bench.ts`
(`npm run bench`), measuring `validate()`/`normalize()`/
`compatibleWith()`/`extract()` throughput and every codec's read/write
throughput on a 100k-edge document, matching the upstream Python
project's "measured, not implied" performance discipline. Real numbers
published in the new `docs/performance.md`.

All fixes verified via the full suite (845 tests, 100% line/branch/
function/statement coverage), the property-based fuzz suite (stress-
tested at 33x normal iteration count with zero flakes), and a full
standalone semantic-oracle run (24,025 schema-pair checks, zero definite
bugs) before this release.

## [v0.0.1-alpha] -- initial port: model, formats, CLI, docs

The first complete pass of the TypeScript port, tracking upstream
[omnist](https://github.com/omnist-dev/omnist) v0.7.8's module boundaries
and public surface. Library, CLI, and test infrastructure are complete
and at 100% line/branch/function/statement coverage; no npm package has
been published yet.

- **Document model** (issue #4/#5): `Doc`, `doc()`, the OSD/OML text
  syntaxes (`parseSchema`/`toOsd`, `readOml`/`writeOml`), and the
  canonical `Node`/`Edge`/`Scalar` types.
- **Schema model & algebra** (issue #6): `Schema`, `record`/`field`/`ref`/
  `nullable`/`t`, `validate`, `compatibleWith`, `equivalent`, `normalize`,
  `prune`, `isEmpty`, plus the internal `extract`/`isomorphic`/`lint`
  operations backing them.
- **Schema-directed deserialization and inference** (issue #7):
  `materialize`, `infer`, `inferWithReport`.
- **Format codecs** (issue #8): `readJson`/`writeJson`/`checkJson`,
  `readYaml`/`writeYaml`/`checkYaml`, `readToml`/`writeToml`/`checkToml`,
  `readXml`/`writeXml`/`checkXml` -- each with the same adjustment-
  reporting contract (`WriteReport`, `strict` mode) as OML and JSON.
  XML's reader is hardened against XXE/entity-expansion by construction,
  not by opt-in configuration.
- **CLI** (issue #9): the `omnist` binary -- `format`, `convert`, `check`,
  `validate`, `infer`, and the `schema` subcommands (`format`/`normalize`/
  `prune`/`is-empty`/`extract`/`compatible-with`/`equivalent`).
- **Property-based fuzzing and the semantic oracle** (issue #10):
  `test/fuzz.test.ts` round-trips random Documents through every format;
  `tools/semantic_oracle.ts` brute-force checks the schema algebra against
  set-theoretic ground truth, independent of the two algorithms it
  cross-validates.
- **Documentation and release infrastructure** (issue #11): the VitePress
  docs site (quickstart, guide, schema model, a worked example, the API
  reference, CLI docs, formats overview, glossary, testing, repo layout,
  and the design specs shared with the Python port), `examples/*` fixtures
  ported from the four real-world format examples (pyproject.toml,
  package.json, a GitHub Actions workflow, sitemap.xml), the
  `check_doc_examples.ts` CI gate (ported from the Python project's own
  tool, same `verified-by`/`doc-illustrative` marker convention), and the
  `docs.yml` GitHub Pages deploy workflow.
- Also exported `parseSchema`/`toOsd`, the full `schema.ts` builder
  surface, `infer`/`inferWithReport`, `materialize`, and `lint` from the
  package's public entry point (`src/index.ts`) -- these existed and were
  fully tested internally (the CLI already used them) but weren't
  reachable by library consumers before this release; this closes that
  gap to reach full parity with the Python package's `__all__`.
- **Security fix** (issue #32): a Document edge labeled `__proto__`
  could reassign an internal object's own prototype rather than being
  stored as an ordinary property, in the JSON-shaped grouping step shared
  by the JSON/YAML/TOML writers, in TOML's own object-copying steps, and
  in XML's tag-name extraction (a `fast-xml-parser`-internal aliasing
  quirk). Found via property-based fuzzing before any release shipped.
  Fixed by building every such object with `Object.create(null)` (or
  correcting the aliased label back to the real tag name for XML) instead
  of a plain object literal. Confirmed, across three independent review
  rounds, that this never reached the global `Object.prototype` -- the
  corruption was contained to the object being built each time -- but the
  silent data corruption and denial-of-service crash paths were real.
  Regression tests pin the exact fuzz-discovered counterexamples.
