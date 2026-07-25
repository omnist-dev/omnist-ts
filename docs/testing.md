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

## What CI runs

`.github/workflows/test.yml` runs `npm test` / `npm run test:coverage` /
`npm run typecheck` / `npm run lint` on every push and pull request, plus
a pull-request-only `docs-examples` job running
`tools/check_doc_examples.ts` against the PR's diff (needs full git
history, hence `fetch-depth: 0`). `.github/workflows/docs.yml` builds and
deploys the VitePress site to GitHub Pages on push to `master` touching
`docs/**`.
