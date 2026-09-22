# Changelog

All notable changes to this project are documented here. The format is
loosely based on [Keep a Changelog](https://keepachangelog.com/). This is
the first documented release of the TypeScript port; the public API
mirrors the upstream Python package's `__all__` (camelCase names of the
same functions).

## [v0.4.0-alpha] -- spec v0.21.0-beta sweep: OSD-14/OSD-15, D-14/bytes_hex

`vendor/omnist-spec` bumped from v0.19.0-beta to **v0.21.0-beta** (273
vectors, was 249). Conformance (vector track): **213 pass / 0 fail / 60 skip**
(was 189 / 0 / 60 at the old pin). Fixture track: 19 / 0 / 0 throughout.

Real behavior changes:

- **OSD-15 (canonical escaping):** the canonical OSD writer (`toOsd`) now
  escapes exactly a backslash as `\\` and a double quote as `\"` in a field
  label, nothing else. It previously escaped nothing at all: a label like
  `a\b` was written as the unescaped `"a\b"`, which reads back as `ab` --
  silent corruption, a different schema with no diagnostic. This was also a
  false pass in this repo's own vector runner: `runParseSchema`
  (`tools/conformance/vectorRunner.ts`) never checked a `parse_schema`
  vector's `expect.schema` field at all, so the four
  `osd-grammar/canonical-output/label-*` vectors reported green without the
  writer's output ever being compared. Both are fixed together.
- **OSD-14 (the unwritable label), new:** `toOsd` now throws `WriteError`
  with `code: "write.unsupported-value"` and `path` set to the Schema path
  of the *record* holding the field, unconditionally (not only under
  `strict`), for a field label containing a C0 control character (U+0000 to
  U+001F). `WriteError` gained optional `code`/`path` fields for this (an
  additive widening, same pattern as `ParseError`/`SchemaError`/
  `DocumentError` -- no existing call site or catch site needs updating).
  No conformance vector can pin this rule (a vector's schema input is OSD
  text, and a schema with an unwritable label has none -- `omnist-spec`
  DIV-5); covered instead by new unit and property tests in
  `test/osd.test.ts` (arbitrary-label round-trip via `fast-check`).
- **D-14 (invalid UTF-8) and new `bytes_hex` vectors:** this package's one
  byte-oriented entry point -- the CLI's file/stdin reading (`src/cli.ts`'s
  `readInput`) -- now decodes strictly. Node's own
  `fs.readFileSync(path, "utf-8")` silently substitutes `U+FFFD` for
  invalid UTF-8 (measured live) rather than failing, which is exactly the
  "decode with replacement" `omnist-spec` E-27 forbids; a new
  `decodeStrictUtf8` helper (`TextDecoder("utf-8", { fatal: true })`)
  replaces it on both the file-read and real-stdin paths and reports
  `parse.invalid-encoding` at `1:1` (a new `ParseError`) on failure. The
  CLI's `--json` error payload (`jsonError`) now also surfaces a thrown
  error's own top-level `code`/`path` when `.errors` is empty, so this
  diagnostic (and any future top-level-coded error) is structured under
  `--json`, not just in the free-text message. All 14 new `bytes_hex`
  vectors (`omnist-spec` E-27) are run for real: the vector runner spawns
  the actual CLI as a subprocess, feeding it raw bytes on stdin -- the only
  way to present genuinely ill-formed UTF-8 without decoding it first, per
  `omnist-spec` §8.5.3/DIV-6. All 14 pass.
- **OML-26/OML-27 (top-level trailing-content vs. in-bracket
  unexpected-token):** confirmed already correct against the five new
  vectors (this port implemented the general rule in PR #148, ahead of the
  spec text landing it); no code change.
- **DIV-3 unchanged:** the six `declared_max_alias_expansion` vectors still
  skip, citing DIV-3 (D-18 alias expansion limits remain unimplemented,
  same as every port).

Other:

- The vector runner's byte-oriented drivers (`runParseBytesHex`,
  `runParseSchemaBytesHex`) and the OSD-14/OSD-15 fixes are covered by new
  tests reaching this repo's 100%-lines/100%-branches coverage standard;
  several genuinely unreachable defensive branches (e.g. a `spawnSync`
  result's signal-killed/launch-failure fields, and a CLI error payload
  shape `jsonError` can never actually produce) are marked
  `/* v8 ignore */` with an inline justification rather than forced by a
  contrived test.
- Version bumped `0.3.1-alpha` -> `0.4.0-alpha` (new behavior, not just a
  fix: OSD-14 is new enforced writer behavior, OSD-15 changes writer
  output).

## [v0.3.1-alpha] -- spec v0.19.0-beta sweep: D-15/D-21 BOM, data-XML profile, E-23, OML-25, D-18 allowlist

`vendor/omnist-spec` bumped from v0.9.1-beta to **v0.19.0-beta** (249
vectors, was 204). Conformance (vector track): **189 pass / 0 fail / 60 skip**
(was 128 / 0 / 76 of 204 at the old pin; the 231-vector v0.18.0-beta suite
measured 146 / 7 / 78 before any code change, and the v0.19.0-beta suite
177 / 3 / 69 with the v0.18 fixes in place). Fixture track: 19 / 0 / 0
throughout.

Real behavior changes:

- **D-15 / D-21 (BOM):** a leading U+FEFF is stripped on every read surface
  (OML, OSD, JSON, YAML, TOML, XML) through one shared helper
  (`src/bom.ts`), exactly one mark at offset zero. A second leading mark is
  rejected on all six surfaces at text position `1:1`: `parse.unexpected-token`
  on OML and OSD (their own lexers), `parse.codec-syntax` on JSON, TOML, YAML
  and XML via an explicit pre-check (`rejectSecondLeadingBom`), because the
  `yaml` and `fast-xml-parser` libraries would otherwise silently swallow it.
  JSON and TOML used to reject BOMs entirely; OML's open-coded strip (an
  invisible literal U+FEFF) was replaced by the helper; OSD's tokenizer no
  longer treats U+FEFF as whitespace. No writer emits a BOM (pinned by test).
- **Data-XML profile (spec v0.14.0):** `readXml` refuses a `DOCTYPE`
  (`format.dtd-forbidden`) and any non-predefined entity reference
  (`format.entity-forbidden`); these and `format.mixed-content` carry their
  code and path `$` on the thrown `ParseError`. Numeric character references
  remain legal.
- **E-23:** OSD string-body errors (`parse.control-character`) report the
  position of the string's opening quote, not the offending character; a
  control character right after a backslash is now an error (OSD Sec5.3.1).
- **OML error codes:** a newline or `;` in place of a missing array comma is
  `parse.separator-in-array`; leftover content after a top-level scalar/edge
  value is `parse.trailing-content` (OML-25).
- YAML merge-key order (source order, earlier alias wins) already matches, but
  entirely because of the `yaml` library (2.9.0, resolved from `^2.5.0`); this
  port has no merge logic of its own, and the six `formats-yaml/merge-key`
  vectors are the only assertion of it.
- **OML `parse.separator-in-array`** fires only when a newline/`;` stood where
  a comma was required before a *further* element; an unterminated array
  whose last element is followed by a newline (`a: [1, 2\n`) is
  `parse.unexpected-token`. The "got EOF" error message now names the real
  `line:col` (it said `line 0, col 0`; the path was already right).
- **OML temporal value errors** (`2024-13-01`, `23:59:60`, ...) now carry
  `parse.invalid-date` / `parse.invalid-time` at the token's start (was
  uncoded, positioned at the token's end).
- **`DocumentError`** gained optional `code` / `path`; array-of-arrays and
  non-string mapping keys carry `document.unlabeled-element` with the Document
  path.
- **XML order:** well-formedness is checked before the data-XML profile
  refusal, so malformed input is a syntax error even if it also contains a
  DOCTYPE or an entity reference.

Tooling / no behavior change:

- Vector runner: `declared_max_alias_expansion` added to the declared-limit
  allowlist, so all six `formats-yaml/alias-expansion` vectors skip (E-20
  "not yet implemented", citing DIV-3) instead of `expansion-at-declared-limit-succeeds`
  reporting a false pass at this port's own default. D-18/D-19/D-20 are NOT
  implemented here (nor in any port).
- Vector runner: the blanket "reader threw + vector expects diagnostics ->
  skip" rule was narrowed to skip only when the thrown error carries no
  `path` and/or no `code`; otherwise path and code are compared for real
  (paths always; codes where the error carries one, Sec8.5.2). The 20
  remaining such skips are the `schema.*` well-formedness vectors, reported
  as E-20 "not yet implemented" and cited to omnist-ts#149 (`SchemaError`
  carries no structured `code`/`path`; the values are in the message).
- S-21 (`infer` opens to `any` only when asked, reports every opening)
  audited for both opening paths: already compliant, no change.

## [v0.3.0-alpha] -- spec-correctness audit: 9-issue "fail, don't invent" cycle

`vendor/omnist-spec` bumped to `0ac1eac`+, bringing in a batch of grammar
and format-write corrections; all 9 resulting issues (#125-133) landed
together in a single PR (#134) because the submodule bump is atomic
upstream and the conformance-vector CI gate requires every new vector
to pass, not just a subset.

Real behavior changes:

- `[0,0]` field cardinality is now rejected (`schema.invalid-cardinality`)
  -- redundant with simply not declaring the field, and was silently
  accepted before.
- Empty-string (`schema.empty-label`) and bracket-containing
  (`schema.bracket-in-label`) field labels are now rejected at schema
  construction.
- Leading-zero numeric literals in OML (e.g. `01`, `0.5` written as
  `00.5`) are now a tokenizer error (`parse.leading-zero`).
- DATE/TIME/DATETIME/timezone-offset range validation was audited
  against the spec's new explicit value ranges; this port was already
  correct, including the specific case of a timezone offset with an
  out-of-range minute component (e.g. `+00:60`) silently normalizing
  instead of being rejected.
- Writes that previously succeeded by silently substituting a lossy
  fallback now fail outright, since the fallback could collide two
  distinct inputs into the same output: JSON `NaN`/`Infinity`, XML
  labels/strings with no legal character representation, XML
  empty-internal-node ambiguity, and TOML null leaves.
- XML now escapes a literal carriage return as `&#13;` on write instead
  of emitting it raw, so it round-trips losslessly instead of being
  silently dropped or corrupted on re-read.

Verified with 100% test coverage, the full conformance-vector suite,
the fuzz suite, and the semantic oracle, all against real CI.

## [v0.2.0-alpha] -- version alignment with sibling ports

Minor-version bump, not a new feature milestone on its own -- the
aggregate scope since v0.1.1-alpha (structured `SchemaError`/`ParseError`
diagnostics, the full issues #106-111 audit-fix cycle covering a real
data-corruption fix, a real spec-conformance fix, and new input-size
hardening) matches the shape of change that triggered the identical
0.1.x -> 0.2.0-alpha bump on both `omnist-j` and `omnist-go`'s own
audit cycles. Brings this port's version number in line with its
siblings, which were understating the comparison at 0.1.2-alpha.

No code changes in this release beyond the version bump itself --
v0.1.2-alpha's content (below) is the real substance.

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
