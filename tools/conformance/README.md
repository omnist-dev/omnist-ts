# omnist-ts's conformance runner

Runs `omnist-ts`'s own library against
[`omnist-spec`](https://github.com/omnist-dev/omnist-spec)'s conformance
fixtures, judging structural equality with `omnist-ts`'s own `readOml`,
`parseSchema`, `Doc.equals`, `schemaEquals`, and `isomorphic()`. See
[`docs/conformance-harness.md`](https://github.com/omnist-dev/omnist-spec/blob/master/docs/conformance-harness.md)
(track 1, OML/OSD fixtures) and
[`docs/08-conformance-and-errors.md`](https://github.com/omnist-dev/omnist-spec/blob/master/docs/08-conformance-and-errors.md)
Sec8.5 (track 2, JSON vectors) in `omnist-spec` for the full spec -- this is
orientation, not a second definition.

Ported from Python's `omnist`'s `tools/conformance/` (issue #85 here,
ultimately from `omnist-spec`'s `conformance/orchestrator/`, issue #283
upstream): same fixtures, same referee logic, own runner using this
repo's direct library calls instead of a CLI wrapper or subprocess.

## Layout

```
tools/conformance/
  referee.ts       structural comparison (Sec4) -- Document via Doc.equals,
                    Schema via exact/isomorphic modes (schemaEquals / isomorphic())
  selfTest.ts       runs vendor/omnist-spec's _referee-self-test/ fixtures
  runner.ts         track 1: per-operation OML/OSD fixture runner
                    (vendor/omnist-spec's conformance/fixtures/)
  vectorRunner.ts   track 2: JSON-vector runner (vendor/omnist-spec's
                    test-suite/), dispatch per Sec8.5.3's operation table
```

All three tracks (referee self-test, fixture runner, vector runner) are
built (steps 1-3 of the harness's 7-step build-out, issue #85).

## Fixture sourcing: a pinned git submodule

`vendor/omnist-spec` is a git submodule pinned to a specific `omnist-spec`
tag -- **not** tracking `omnist-spec@master`, so fixture updates are
explicit, reviewable version bumps rather than silent drift. Currently
pinned to `v0.1.0-alpha`, the same tag Python's `omnist` pins.

Cloning this repo doesn't check the submodule out by default; either
clone with `--recurse-submodules`, or after a normal clone:

```bash
git submodule update --init
```

### Bumping the pin

When `omnist-spec` cuts a new tag with fixture changes worth picking up:

```bash
cd vendor/omnist-spec
git fetch origin <new-tag>
git checkout FETCH_HEAD
cd ../..
git add vendor/omnist-spec
git commit -m "chore: bump vendor/omnist-spec to <new-tag>"
```

Run all three runners locally before committing the bump -- a
fixture-content change is exactly the kind of thing this exists to catch:

```bash
npm run conformance:self-test
npm run conformance:runner
npm run conformance:vectors
```

## Running it

```bash
npm run conformance:self-test    # referee self-test, 10 cases
npm run conformance:runner       # track 1: OML/OSD fixtures, 11 operations
npm run conformance:vectors      # track 2: JSON-vector suite
```

Current real status (re-verify rather than trusting this table -- it's a
snapshot, not a promise):

| Command                    | Result                                  |
| --------------------------- | ---------------------------------------- |
| `conformance:self-test`    | 10/10 passed                            |
| `conformance:runner`       | 19 passed, 0 failed, 0 skipped (11 ops) |
| `conformance:vectors`      | 103 passed, 0 failed, 36 skipped (of 139) |

## The skip-citation convention (Sec8.5.5)

Per `omnist-spec`'s `docs/08-conformance-and-errors.md` Sec8.5.5, a
`[SKIP]` line is never an unexplained gap: it MUST cite either "not yet
implemented" or a numbered divergence-ledger entry (`docs/09-divergence-ledger.md`,
Sec9.4) by number. `vectorRunner.ts`'s current skips break down as:

- **`D-6 (integer/number kind collapse)`** -- `omnist-ts`'s `Scalar` union
  has no `integer`/`number` kind tag independent of a schema (one JS
  numeric type; `matchesKind` derives the distinction from
  `Number.isInteger`). This is `omnist-spec`'s Sec9.4 D-6, an open,
  by-design, TypeScript-only divergence -- not a bug. Only the specific
  vectors whose outcome depends on this distinction are skipped; the
  Document-model area otherwise passes in full per Sec9.2's carve-out.
- **"not yet implemented -- omnist-ts's safety limits are compile-time
  constants, no runtime configuration surface"** -- vectors that probe
  runtime-configurable safety limits Python exposes but this repo
  currently bakes in as constants.
- **"syntax-level ParseError/SchemaError carries no structured
  path/code"** -- vectors expecting a structured error path/code that a
  syntax-level parse/schema error in this repo's error types doesn't
  carry.

A skip with no reason, or a reason not tied to one of the categories
above (or a newly added ledger entry), is a reporting bug in the runner,
not an acceptable result -- see issue #85's step 4 for the triage process
that produced today's list.

## How this maps to CI

`.github/workflows/test.yml`'s `conformance` job runs all three commands
above, in order, on every push and pull request to `master` (checkout
with `submodules: true` so `vendor/omnist-spec` is actually populated).
Per Sec8.5.5, the job fails the build only when a runner's fail count is
nonzero -- every one of the three scripts' `main()` returns `1` on
`failed > 0` and `0` otherwise, including when skips exist, so an
honestly-cited skip never turns CI red. A fixture directory missing
(submodule not checked out) returns `2`, which also fails CI, distinctly
from a real conformance failure.

## Known issue found by the self-test

`main() against the real vendor/omnist-spec submodule` in
`test/conformance-self-test.test.ts` documents a real, currently-failing
case: `01-schema-exact-equal-different-field-order`. `schemaEquals`
(`src/schema.ts`, via `recordEquals`) compares a record's fields
positionally, so two records that differ only in field *declaration
order* compare unequal in exact mode. Field order isn't semantically
significant per the model (`docs/design/model.md` Sec13 and this
fixture's `purpose.txt`), and Python's reference `Record.__eq__` is
order-independent (it compares label-keyed dicts). This looks like a
genuine `omnist-ts` bug, not a referee bug -- it's left untouched here
per the harness build-out plan (issue #85), to be triaged and fixed as
its own step rather than silently worked around in the referee.

## Unit tests vs. the real conformance run

`test/conformance-referee.test.ts` unit-tests the referee's comparison
rules against small synthetic OML/OSD snippets, and
`test/conformance-self-test.test.ts` both exercises `selfTest.ts`'s
runner logic against scratch fixture directories (covering the
malformed-input and missing-fixtures branches) and runs it in-process
against the real, pinned submodule fixtures -- both run in the normal
`npm test`/`npm run test:coverage`, no extra setup beyond `git submodule
update --init`, and keep this package at the project's usual
100%-line/branch/function coverage bar (`vitest.config.ts`).
