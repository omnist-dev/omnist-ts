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
  referee.ts     structural comparison (Sec4) -- Document via Doc.equals,
                 Schema via exact/isomorphic modes (schemaEquals / isomorphic())
  selfTest.ts    runs vendor/omnist-spec's _referee-self-test/ fixtures
```

Only the referee and its self-test exist yet (step 1 of the harness's
7-step build-out, issue #85). The per-operation fixture runner (track 1,
`conformance/fixtures/`) and the JSON-vector runner (track 2,
`test-suite/`) are follow-up work and will land in this directory too,
each with its own `README.md` section, once built.

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

Run the self-test (and, once they exist, the fixture and vector runners)
locally before committing the bump -- a fixture-content change is exactly
the kind of thing this exists to catch.

## Running it

```bash
npx tsx tools/conformance/selfTest.ts
npm run conformance:self-test
```

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
