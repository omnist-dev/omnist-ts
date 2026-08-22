# Testing

The test suite, coverage tooling and target, the fuzzing approach, and
what CI runs.

## Layout

`test/` mirrors `src/` one-to-one: `document.test.ts` tests `document.ts`,
`test/formats/*.test.ts` mirrors `src/formats/*.ts`, `test/ops/*.test.ts`
mirrors `src/ops/*.ts`. See [layout.md](layout.md) for the full map,
including the doc-pinning tests (`test/docs-*.test.ts`) and the CLI's own
tests.

## Running the suite

```bash
npm test              # vitest run
npm run test:coverage # vitest run --coverage
npm run typecheck     # tsc --noEmit
npm run lint          # eslint .
npm run oracle        # tools/semantic_oracle.ts, the full brute-force run
```
<!-- doc-illustrative -->

## Coverage

`vitest.config.ts` enforces **100% line, branch, function, and statement
coverage** over `src/**/*.ts` and `tools/**/*.ts`, via the v8 provider.
There is no partial-coverage carve-out: every new line ships covered, or
it ships behind a `/* v8 ignore */` comment with a reason, matching the
convention already used in `src/cli.ts` and elsewhere for genuinely
unreachable branches (defensive checks, `noUncheckedIndexedAccess`
fallbacks proven safe by a surrounding loop invariant).

## Property-based fuzzing

`test/fuzz.test.ts` generates random `Doc` trees and round-trips them
through each format's `read*`/`write*` pair, asserting that any reported
adjustment is one of the format's documented adjustment codes, and that an
unadjusted round-trip is byte-for-byte (OML) or structurally exact.

## The semantic oracle

`tools/semantic_oracle.ts` is a brute-force, set-theoretic ground-truth
check on the schema algebra: it enumerates a finite universe of documents
and checks `compatibleWith`, `equivalent`/`normalize`+`isomorphic`, and
`prune`/`isEmpty` against the actual language each schema accepts
(`{ d in U : schema.validate(d).ok }`), rather than against another
algorithm -- a third, independent check alongside the two algorithms it
cross-validates. `test/semantic-oracle.test.ts` runs the same checks over
a smaller, bounded universe so they fit inside the normal test suite; `npm
run oracle` runs the full, larger version standalone.

## Doc-example coverage

Every fenced code block added or changed in `docs/*.md` needs either a
`<!-- verified-by: test/path.test.ts::testName -->` marker (naming the
test that asserts the block's exact literal output) or a
`<!-- doc-illustrative -->` marker (for a pattern-illustrating snippet,
diagram, or grammar fragment with no runnable literal-output claim).
`tools/check_doc_examples.ts` enforces this in CI (pull-request-only,
diffed against the PR's base ref) -- run it locally with:

```bash
npx tsx tools/check_doc_examples.ts --base-ref origin/master
```
<!-- doc-illustrative -->

This does not verify a marker is *honest* -- only that one exists. See
`test/check-doc-examples.test.ts` for the gate's own tests, and
`test/docs-*.test.ts` for the doc-pinning tests a `verified-by` marker
points at.

## Conformance testing

`tools/conformance/` runs this port's own referee and runners against
[`omnist-spec`](https://github.com/omnist-dev/omnist-spec)'s fixtures,
vendored via a pinned git submodule (`vendor/omnist-spec`) -- own
comparison logic, own drivers, never dependent on the Python reference
implementation. Two independent tracks, from the same submodule pin:

- **The OML/OSD fixture harness** (`tools/conformance/runner.ts`) runs
  `conformance/fixtures/`'s directory-per-case fixtures (11 operations)
  directly against this library's functions. Currently
  **19 passed, 0 failed, 0 skipped**.
- **The JSON-vector suite** (`tools/conformance/vectorRunner.ts`) runs
  `test-suite/`'s JSON-envelope vectors (`name`/`operation`/`input`/
  `expect`) against the same functions. Currently
  **103 passed, 0 failed, 36 skipped** (of 139).

Every skip cites an explicit, checkable reason, per
[`docs/08-conformance-and-errors.md` Sec8.5.5](https://github.com/omnist-dev/omnist-spec/blob/master/docs/08-conformance-and-errors.md)
in `omnist-spec` -- never an unreasoned skip:

- **A numbered divergence-ledger entry** (`omnist-spec`'s
  `docs/09-divergence-ledger.md` Sec9.4) for a deliberate, documented
  design difference -- e.g. **D-6**: this port's `Document` model can't
  represent the spec's `integer`/`number` kind distinction independent
  of a schema (JS has one numeric type; see
  [python-parity.md](python-parity.md) #1). One vector is affected.
- **"not yet implemented"** for a spec-required capability this port
  hasn't built -- e.g. the 6 `document-model/limits.json` vectors assume
  a runtime-configurable safety limit, and this port's `MAX_DEPTH`/
  `MAX_NODES`/`MAX_INT_DIGITS` are compile-time constants with no
  configuration surface.
- **A structured-diagnostics gap** -- 29 `oml-grammar`/`osd-grammar`/
  `schema-wellformedness` vectors expect a `path`/`code` on a raw
  syntax-level parse or well-formedness failure, and this port's
  `ParseError`/`SchemaError` carry no structured fields for that case
  (matching the same asymmetry as the Python reference's `ParseError`).

Diagnostics are compared in **code-agnostic mode** (`ok` plus the set of
`path`s, never `code`) per Sec8.5.2 rule 4 -- verified empirically, not
assumed: this port's error codes predate `omnist-spec`'s Sec8.3 code
taxonomy, same as the Python reference.

Run locally:

```bash
npm run conformance:self-test  # referee self-check, 10/10
npm run conformance:runner     # Track 1, the fixture harness
npm run conformance:vectors    # Track 2, the JSON-vector suite
```
<!-- doc-illustrative -->

See `tools/conformance/README.md` for the submodule layout and the
pin-bump procedure.

## Safety limits

This port hardcodes four compile-time safety limits that bound the work
done against untrusted input, each documented alongside the code that
enforces it:

| Limit | Value | Enforced in | Bounds |
|---|---|---|---|
| `MAX_DEPTH` | 200 | `src/document.ts` (`buildNode`), and locally redefined per the same convention in `src/oml.ts`, `src/infer.ts`, `src/schema.ts`, and each of `src/formats/{json,yaml,toml,xml}.ts` | Levels of node nesting in a materialized Document |
| `MAX_NODES` | 1,000,000 | `src/document.ts` (`buildNode`), `src/formats/xml.ts` (`xmlToNode`) | Total nodes materialized while building one Document |
| `MAX_INT_DIGITS` | 4,300 | `src/document.ts`, and a raw-text pre-parse scan in each of `src/formats/{json,yaml,toml,xml}.ts` | Decimal digits in an `integer` literal |
| `MAX_INPUT_BYTES` | 256 MiB (268,435,456 UTF-16 code units) | `src/formats/input-size.ts` (`checkInputSize`), called first thing in each of `readJson`/`readYaml`/`readToml`/`readXml` | Raw input text size, before any external parsing library runs |

`MAX_DEPTH`/`MAX_NODES`/`MAX_INT_DIGITS` match the reference defaults in
`omnist-spec`'s [`02-document-model.md` Sec2.4](https://github.com/omnist-dev/omnist-spec/blob/master/docs/02-document-model.md#24-safety-limits).
None of the three is spec-required to have a runtime-configurable
surface (see the Conformance testing section above), and this port
doesn't expose one.

`MAX_INPUT_BYTES` is not a spec-defined limit -- it's specific to this
port's four external-library-backed format codecs (issue #110). Those
codecs each hand raw input text to an external parsing library (native
`JSON.parse`, the `yaml` package, `smol-toml`, `fast-xml-parser`)
*before* `buildNode`'s `MAX_DEPTH`/`MAX_NODES` checks ever run --
those checks bound the materialized Document, not the work the external
library does while producing the intermediate parsed value in the first
place. `checkInputSize` closes the coarse but cheap case (an
attacker-controlled, arbitrarily large raw input) ahead of any library
call. See `src/formats/input-size.ts`'s file-top comment for the full
reasoning, including why 256 MiB was chosen (a large margin over what
even a maximally-verbose, `MAX_NODES`-sized document actually needs).

## What CI runs

`.github/workflows/test.yml` runs `npm test` / `npm run test:coverage` /
`npm run typecheck` / `npm run lint` on every push and pull request, plus
a pull-request-only `docs-examples` job running
`tools/check_doc_examples.ts` against the PR's diff (needs full git
history, hence `fetch-depth: 0`), and a `conformance` job (submodules
checked out) running all three commands above on every push and pull
request. Per Sec8.5.5, the `conformance` job fails the build only when a
runner's fail count is nonzero -- never merely because skips exist, as
long as every skip is properly reasoned as above. `.github/workflows/docs.yml`
builds and deploys the VitePress site to GitHub Pages on push to `master`
touching `docs/**`.
