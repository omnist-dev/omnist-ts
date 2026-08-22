# Changelog

All notable changes to this project are documented here. The format is
loosely based on [Keep a Changelog](https://keepachangelog.com/). This is
the first documented release of the TypeScript port; the public API
mirrors the upstream Python package's `__all__` (camelCase names of the
same functions).

## [v0.1.2-alpha] -- audit-fix cycle: data-corruption bug, spec-conformance fix, hardening

Combines two rounds of work: the security/dependency updates originally
tagged `v0.1.1-alpha` (never fully released -- that tag's version bump
only touched `package.json`, missed `src/index.ts`/`test/index.test.ts`,
so this release also completes it) and a 6-issue audit-fix cycle
(issues #106-111), all independently reviewed and merged.

**From the incomplete v0.1.1-alpha bump:**
- `fast-xml-parser` upgraded to 5.x -- stricter `__proto__`/`constructor`/
  `prototype` rejection and disabled `valueOf`-family renaming
  (security fix, GHSA-gh4j-gqv2-49f6).
- `vitest` upgraded 2 -> 4, closing 2 critical + 1 high CVE.
- Generated TypeDoc API docs added to the docs site, plus two follow-up
  fixes for a dead content-area link (VitePress's Vue Router intercepts
  same-origin content links even with `target="_self"` set -- only
  `target="_blank"` reliably bypasses it).

**Correctness fixes (issues #106, #107):**
- **`materialize()` silently lost or invented numeric precision on
  bigint<->number conversions** (issue #106, HIGH severity): a
  `number`-kinded field materializing from a bigint outside float64's
  exact range silently rounded (`9007199254740993n` -> `9007199254740992`);
  an `integer`-kinded field materializing from a float that merely
  *looked* like a whole number invented digits (`1e25` ->
  `10000000000000000905969664n`, since `Number.isInteger(1e25)` is
  `true` but `1e25` isn't a safe integer). Both cases now correctly
  reject via the same non-value-exact rejection path every other
  lossy conversion already uses, per spec Sec7.2's "loses nothing and
  invents nothing" rule.
- **`MAX_NODES` counted every scalar leaf, not just actual nodes**
  (issue #107): per the spec's own grammar (`node = [edge, edge, ...]`,
  a scalar leaf's target is a `value`, not a `node`), a document with
  1,000,000 scalar fields under one root has exactly one real node --
  but this port rejected it as exceeding the limit. Fixed across all
  three construction paths (`buildNode`, XML's `xmlToNode`, OML's
  parser); all four formats' MAX_NODES boundary tests were rebuilt to
  test the real, corrected 1,000,000-node boundary rather than a
  boundary that no longer meant anything under the fix.

**Enhancements (issues #104, #108 -- structured diagnostics, not
compliance fixes; `omnist-spec`'s Sec8.1 explicitly doesn't require
this yet):**
- `SchemaError` gained optional `code`/`path` fields for OSD's lexer
  (issue #104, 3 of 6 candidate codes reachable given OSD's actual
  grammar).
- `ParseError` gained the same for OML's tokenizer/parser (issue #108,
  10 of 11 candidate codes reachable -- OML's grammar is richer than
  OSD's; the 11th, `parse.separator-in-array`, is structurally
  unreachable because the array-parsing loop can't distinguish "a
  separator token was misused" from any other malformed
  array-closing token once it's already been silently skipped).

**Hardening:**
- All four format readers now reject oversized raw input (>256 MiB)
  before handing it to their underlying parsing library, closing a
  defense-in-depth gap where a maliciously large input could force
  substantial work inside JSON.parse/`yaml`/`smol-toml`/
  `fast-xml-parser` before this port's own safety limits ever got a
  chance to apply (issue #110). Verified per-library: three of the
  four already have their own structural depth protection
  (`fast-xml-parser`'s `maxNestedTags`, `smol-toml`'s `maxDepth`,
  `yaml`'s `maxAliasCount` for alias expansion specifically) -- none
  of the four bounded raw input *size*, which is the gap this closes.
- Documented (not fixed) 3 real `npm audit` vulnerabilities in
  `esbuild`/`vite`/`vitepress`'s dev-tooling chain (issue #109) --
  the only resolving version line is an unreleased `vitepress` 2.x
  pre-release; pinning a docs-only devDependency to an unstable
  pre-1.0 alpha was judged worse than the accepted risk (dev-server-only,
  never touches CI or the published package). See `SECURITY.md` for
  the full rationale and revisit trigger.

**Investigated, no fix needed:**
- A borderline-flaky XML MAX_NODES boundary test (issue #111) --
  the timeout had already been fixed incidentally by issue #107's
  work; a follow-up perf investigation found XML's ~3x slower
  boundary-test time versus JSON/OML is inherent to `fast-xml-parser`'s
  own tokenization cost for this input shape (benchmarked directly:
  ~13s of the ~15-21s total is spent inside the library itself, before
  this port's own conversion code ever runs), not an inefficiency in
  this port's own code.

**Process:** every fix independently reviewed by a separate agent that
reproduced red/green itself; two PRs (#115, #116) needed a second review
round after the first round caught real issues (a claimed conformance
vector count that needed independent re-verification, and a factually
wrong library-capability claim in a code comment -- `smol-toml` does
have its own depth guard, contrary to the first draft's claim). Full
suite (1153+ tests), 100% coverage, `tsc --noEmit`/`eslint`/doc-example
gate all clean throughout.

## [v0.1.0-alpha] -- own conformance harness against omnist-spec

The first minor-version milestone: this port now has its own
conformance-test harness against `omnist-spec` -- own referee, own
runners, consuming `omnist-spec`'s fixtures via a pinned git submodule,
never depending on the Python reference implementation. Full report at
issue [#85](https://github.com/omnist-dev/omnist-ts/issues/85).

**Two independent tracks**, both CI-gated on every push/PR:
- The OML/OSD fixture harness (`tools/conformance/runner.ts`):
  **19 passed, 0 failed, 0 skipped**.
- The JSON-vector suite (`tools/conformance/vectorRunner.ts`, 139
  vectors): **103 passed, 0 failed, 36 skipped**. Every skip cites an
  explicit reason -- a numbered divergence-ledger entry (`D-6`, the
  Document model's integer/number kind collapse), "not yet
  implemented" (this port's safety limits are compile-time constants),
  or a structured-diagnostics gap on syntax-level parse failures.

**Correctness fixes found and independently reviewed along the way:**
- `recordEquals` compared a record's fields positionally instead of as
  an unordered, label-keyed set (issue #86) -- found by the referee's
  own self-test, before any real fixture ran.
- `readXml` coerced element text to numbers/booleans on schema-less
  reads (issue #88), the same bug class the Python reference fixed as a
  breaking change in `omnist#288`. Took two review rounds: the first
  fix's new schema-directed type-recovery path used regexes broader
  than Python's reference (accepted `+5`/`007`/`.5`); the second
  tightened them to exact parity with Python's `_XML_INT_RE`/
  `_XML_NUM_RE`.
- `readYaml` mishandled boolean-resolved mapping keys (issue #89): a
  `yaml-1.1` alias set broader than the reference implementation's
  (matched bare `y`/`n`, not just `on`/`off`/`yes`/`no`/`true`/`false`),
  plus silent stringification of a boolean-resolved key instead of
  rejecting the document.

No vector or spec defects were found in this pass -- all three original
failures were genuine implementation bugs.

**Docs:** the conformance harness is now documented on the public site
(`docs/testing.md`), not just internally
(`tools/conformance/README.md`). The omnist logo was also added to the
docs site, copied verbatim from `omnist-spec`.

**Process:** every fix independently reviewed by a separate agent that
reproduced red/green itself and, for the CI gating logic itself, a
reviewer who genuinely broke a fixture to confirm the fail path
actually triggers rather than trusting the code. Full suite (1074+
tests), 100% coverage, `tsc --noEmit`/`eslint`/doc-example-gate all
clean.

## [v0.0.5-alpha] -- spec-conformance audit fixes

A spec-vs-implementation verification pass against `omnist-spec` found
five gaps, all confirmed real and fixed:

- **Unbounded node-count DoS** (issue #77): no `MAX_NODES` limit existed
  anywhere, despite the spec requiring one alongside the existing
  `MAX_DEPTH`/`MAX_INT_DIGITS` guards. A shallow document (depth 1) with
  an arbitrary number of repeated same-label edges built without
  complaint. Added `MAX_NODES = 1,000,000` (the spec's reference
  default), threaded through `buildNode()` for JSON/YAML/TOML and as
  local counters in XML/OML's direct tree-construction paths -- the
  security-relevant fix in this batch.
- **S-3: reserved record names accepted by the builder API** (issue
  #75): `schema()` silently accepted a record named after a scalar
  keyword (`string`, `integer`, etc.) or `any`, producing a permanently
  unreferenceable record. Already enforced correctly in the OSD text
  parser; now enforced in the builder API too.
- **S-7: `nullable(ref(...))` silently succeeded** (issue #76): returned
  a malformed `{tag: "ref", ..., nullable: true}` object instead of
  throwing. Now throws `SchemaError`, matching the OSD grammar's
  existing rejection of `?` after a reference type.
- **S-2: `field()` didn't validate integer cardinality bounds** (issue
  #78): `field("x", t.string, 1.5, 2.5)` built without error. Now
  validates `min`/`max` are integers via the builder API, the same way
  OSD parsing already guarantees by construction.
- **Test coverage gap: capitalized `INF`/`-INF`** (issue #74): the
  existing `NaN`-is-not-the-keyword test had no `INF`/`-INF`
  counterpart. Verified the behavior was already correct and added the
  missing coverage.

**Process:** every fix independently reviewed by a separate agent that
reproduced red/green itself; full suite (919 tests, 100% coverage),
`tsc --noEmit`, `eslint`, and the doc-example gate all verified clean
before this release.

## [v0.0.4-alpha] -- OML write-side depth guard, docs completeness

- **`writeOml` had no depth guard** (issue #70): every other codec's
  writer (`writeJson`/`writeYaml`/`writeToml`/`writeXml`) got a
  `checkWriteDepth` call as part of issue #37's fix; `writeOml` was
  missed. A hand-built `Node` (bypassing `buildNode`'s construction-time
  check, since `Node`/`Edge` are exported public types) nested past 200
  levels wrote successfully with no error, risking an uncaught
  `RangeError` (stack overflow) instead of the library's own error type.
  Now raises `WriteError` naming the limit, matching `readOml`'s existing
  guard, in both pretty and compact write modes.
- **`docs/formats/oml.md` brought to full documentation depth** (issue
  #67): expanded from 38 lines to the same grammar-complete coverage the
  other three format pages already have (issue #57) -- reading/writing,
  the zero-adjustment guarantee, temporal-offset and TIME-literal
  round-tripping (issues #51/#52), numeric edge cases, comments, raw/
  multiline strings, reserved words, and the depth guard. Took three
  review rounds to land clean: the first pass had a fabricated claim
  about integer vs. float `-0` sign handling on read (both actually
  preserve sign; only write loses it), and issue #70 landing mid-review
  required two follow-up passes to fully reconcile every reference to
  the depth-guard behavior across the page, including one stale internal
  anchor link -- a reminder that a page under active review needs a full
  re-read, not just a diff-check, when its subject matter changes under
  it.
- **Workflow playbook**: added an explicit policy
  (`docs/workflow-playbook.md`) for when this port's behavior disagrees
  with upstream Python -- fix the port by default, but implement against
  the formal spec and file an issue on the upstream repo when Python
  itself is demonstrably wrong. Formalizes the practice already used for
  the `prune()` non-determinism finding
  ([omnist-dev/omnist#253](https://github.com/omnist-dev/omnist/issues/253)).

**Process:** full suite (911 tests, 100% coverage), `tsc --noEmit`, and
`eslint` verified clean before this release; every fix independently
reviewed by a separate agent that reproduced the claimed behavior itself
rather than trusting the report, per this repo's standing playbook rule.

## [v0.0.3-alpha] -- cross-implementation correctness pass

A systematic differential comparison against the real Python `omnist`
runtime (not just reading source side by side), covering the Document
model, Schema model, OSD, OML, all four codecs, infer/deserialize, the
schema algebra, the CLI, and the public API surface. Full report at
[docs/python-parity.md](docs/python-parity.md). Nine categories confirmed
identical, six deliberate divergences documented with rationale, and nine
genuine correctness gaps found and fixed -- every fix independently
verified against live CPython, not just against expectations.

**Correctness fixes:**
- **`validate()` accepted calendar-invalid dates and out-of-range times**
  (issue #49, #50): `matchesKind` used JS's lenient `Date.parse` for
  date/time/datetime validity, which rolls a day overflow forward
  (`"2024-02-30"` validated as a `date`) and permits `24:00` as a time
  per the ECMAScript Date Time String Format. This also meant `validate`
  and `materialize` could disagree -- a documented invariant this port
  claims never to violate. Both now route through the same
  `parseDateToken`/`parseTimeToken`/`parseDatetimeToken` functions
  `oml.ts`'s tokenizer and `materialize` already used, so the two layers
  can't drift again. Confirmed against CPython 3.13.5 directly.
- **`writeOml` erased a datetime's UTC offset** (issue #51): the issue
  #26 fix (preserving local-vs-offset datetimes) landed for TOML only.
  OML datetimes now carry the same tagging via `temporal.ts`, and an
  offset-tagged midnight datetime no longer collapses to a bare `DATE`
  token.
- **A bare OML `TIME` literal didn't round-trip** (issue #52): `writeOml`
  now emits a bare `TIME` token for any string that's a valid time
  literal by shape and range, instead of always quoting it. Documented
  tradeoff: an ordinary `"12:00"` string gets promoted to a bare token on
  write, since a string primitive has no identity for schema-aware
  tagging.
- **`lint()`/`prune()` output ordering diverged from Python** (issue #56):
  `lint`'s sort used locale-aware `localeCompare` instead of plain
  codepoint comparison. `prune`'s environment reconstruction now
  preserves the input schema's declared order, filtered to what's
  reachable -- notably, Python's own equivalent turned out to be
  non-deterministic (`PYTHONHASHSEED`-dependent, confirmed by rerunning
  it repeatedly), so an exact "match Python" target wasn't even
  well-defined; filed upstream as
  [omnist-dev/omnist#253](https://github.com/omnist-dev/omnist/issues/253).
- **Over-large integer literals silently became `Infinity` in JSON/YAML**
  (issue #54): now raise `ParseError` past the same 4300-digit cap
  CPython itself uses (`sys.get_int_max_str_digits()`), matching the
  precedent already accepted for TOML (issue #25). The YAML-side fix
  needed a second pass after review found a false positive on ordinary
  word+digit plain scalars (an id/hash/token ending in a long digit run).
- **Missing public API exports** (issue #58): the seven scalar constants
  (`STRING`/`INTEGER`/.../`DATETIME`) and `satisfiableSet`/
  `equivalenceClasses` exist in Python's own `__all__` but weren't
  exported from this port's entry point. Now are.

**Documented, not fixed (deliberate divergences, not gaps):**
- XML scalar coercion stays narrower than Python's (doesn't accept
  Python numeric-literal spellings like `nan`/`inf`/`1_0`) -- matching
  Python here would let `readXml` manufacture `NaN`/`Infinity` values
  this port's own `writeJson` can't represent (issue #53).
- The `12:00+05:60` case: Python silently renormalizes an invalid offset
  minute to `+06:00`; this port rejects it outright rather than silently
  changing a user's value.
- `docs/formats/{json,yaml,toml,xml}.md` now document all nine
  `Adjustment`/`WriteReport` codes this port's codecs can produce, with
  severity and worked examples (issue #57). `docs/formats/oml.md`
  remains comparatively thin and is tracked separately (issue #67).

**Process:** every fix in this release went through independent review
that reproduced the claimed behavior against live CPython, not just
trusted the report -- and two rounds surfaced real problems before merge
(a YAML scanner false positive on issue #54, and stale test assertions
in `test/python-parity.test.ts` left over from issue #56 landing on
`master` mid-cycle). Full suite (909 tests, 100% coverage), the fuzz
suite stress-tested at 20x normal iterations, and the full semantic
oracle (24,025 pairs, zero definite bugs) all verified clean before this
release.

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
