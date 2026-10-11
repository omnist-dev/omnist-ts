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
  **494 passed, 0 failed, 28 skipped** (of 522, spec v0.34.0-beta); the 28
  skips are the `extensions-osd-oml` vectors (OSD-OML is not implemented).

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
  hasn't built -- today only the 28 `extensions-osd-oml` vectors (the
  OSD-OML extension, E-20/E-21). The safety limits are all configurable per
  call -- `maxDepth`, `maxNodes`, `maxIntDigits` (since 0.9.0-alpha; they
  were compile-time constants and 52 vectors skipped), the alias expansion
  limit by `ReadYamlOptions.maxAliasExpansion`, the expanded size by
  `maxExpandedSlots`, and the input size by `maxInputBytes` -- so every
  vector that declares a vector-local maximum through a `declared_max_*` key
  runs for real, against that maximum and never the default.
- **A structured-diagnostics gap** ("not yet implemented") -- a vector
  skips this way **only** when the error this port throws genuinely lacks a
  `path` and/or `code`. Errors that carry both are compared for real:
  OML/OSD `parse.*` errors, the `schema.*` well-formedness errors (Sec8.3.3,
  Sec8.4.1; since #149 no vector skips for this reason), the data-XML
  profile refusals, and `document.unlabeled-element`.

Diagnostic **paths** are always compared; **codes** are compared where the
thrown error carries one (its `parse.*`/`format.*` codes are spec codes).
Validate/materialize diagnostics are compared by path only (Sec8.5.2
rule 4) -- those codes predate `omnist-spec`'s Sec8.3 taxonomy.

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

This port enforces the safety limits below, which bound the work done against
untrusted input, each documented alongside the code that enforces it. All of
them are configurable per call:

| Limit | Value | Enforced in | Bounds |
|---|---|---|---|
| Depth (`maxDepth`) | 200 | `src/limits.ts` (the defaults and the resolver), `src/document.ts` (`buildNode`), `src/oml.ts` (the parser), `src/formats/xml.ts` (`xmlToNode`); the writers and traversals keep their own backstop at the default | Levels of node nesting counted from the Document root, which is level 1; `document.limit.depth` at `$` |
| Node count (`maxNodes`) | 1,000,000 | `src/document.ts` (`buildNode`), `src/oml.ts`, `src/formats/xml.ts` | Nodes of one Document, the root included, a scalar leaf not; `document.limit.nodes` at `$` |
| Integer digits (`maxIntDigits`) | 4,300 | `src/limits.ts` (`digitsExceed`), checked by value in `src/document.ts` (`buildNode`), `src/oml.ts`, and as each reader resolves an integer (`json.ts`, `yaml.ts`, `toml.ts`, `xml.ts`) | Decimal digits of an integer's value, sign excluded (D-28); `document.limit.int-digits` at the literal's Document path |
| Alias expansion factor | 50 (configurable: `ReadYamlOptions.maxAliasExpansion`, 1 to 10,000) | `src/formats/yaml-alias.ts` (`checkAliasExpansion`), called by `readYaml` before anything is materialized | The ratio of value slots materialized to value slots written, per anchored node, mapping, sequence, and the document root (D-18) |
| Expanded size | 1,000,000 slots (configurable: `ReadYamlOptions.maxExpandedSlots`, 1 to 10,000,000) | `src/formats/yaml-alias.ts` (`checkAliasExpansion`), called by `readYaml` before anything is materialized | The value slots one YAML input materializes (`W` of the root), for an input that contains an alias or a merge key (D-22); an alias-free input is exempt |
| Input size | 64 MiB (67,108,864 bytes; configurable: `maxInputBytes` on every reader, `--max-input-bytes` on the CLI, any integer of at least 1) | `src/formats/input-size.ts` (`checkInputSize`), called first thing in each of `readJson`/`readYaml`/`readToml`/`readXml`/`readOml` | Raw input size in UTF-8 bytes, a leading BOM counted, before anything is decoded or parsed (D-23); see [Limitations](limitations.md) |

The depth, node and digit defaults match the reference defaults in
`omnist-spec`'s [`02-document-model.md` Sec2.4](https://github.com/omnist-dev/omnist-spec/blob/master/docs/02-document-model.md#24-safety-limits),
and each reader takes them as options (`maxDepth`, `maxNodes`,
`maxIntDigits`; an integer of at least 1, else a `RangeError`: D-10); see
[Limitations](limitations.md#safety-limits-and-how-to-set-them). The alias
expansion factor matches the reference default of 50 and the expanded size
the reference default of 1,000,000 (`02-document-model.md` Sec2.4.1, D-18 to
D-22), exposed as `ReadYamlOptions.maxAliasExpansion` and
`ReadYamlOptions.maxExpandedSlots` (D-10, D-11: finite, documented; see
[YAML](formats/yaml.md)).

The input-size limit is `omnist-spec` D-23 to D-26 (`02-document-model.md`
Sec2.4.2; it began as this port's own guard, issue #110). The codecs each hand
raw input text to an external parsing library (native `JSON.parse`, the `yaml`
package, `smol-toml`, `fast-xml-parser`) *before* `buildNode`'s
depth and node checks ever run -- those checks bound the materialized
Document, not the work the library does producing the intermediate value.
`checkInputSize` refuses an oversized input first, with
`document.limit.input-size` at `$`. The default is 64 MiB, a deliberate
behaviour change from the 256 MiB UTF-16-unit guard of earlier versions; what
it does and does not bound is in [Limitations](limitations.md).

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
