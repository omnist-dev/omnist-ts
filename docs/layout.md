# Repo layout

How the repo itself is organized: `src/*.ts` module responsibilities, the
docs page map, and the test file map.

## `src/`

| File | Responsibility |
|---|---|
| `document.ts` | The Document model: `Node`, `Edge`, `Scalar`, `Doc`, `doc()`. |
| `schema.ts` | The Schema model: `Schema`, `Record`, `Field`, `FieldType`, builders (`schema`, `record`, `field`, `ref`, `nullable`, `t`), validation, `compatibleWith`/`equivalent`/`normalize`/`prune`/`isEmpty` (delegating to `ops/*`). |
| `osd.ts` | OSD text syntax: `parseSchema`, `toOsd`. |
| `oml.ts` | OML text syntax: `readOml`, `writeOml`, `checkOml`. |
| `infer.ts` | Schema inference from example documents: `infer`, `inferWithReport`. |
| `deserialize.ts` | Schema-directed deserialization: `materialize`. |
| `report.ts` | `WriteReport`, `Adjustment`, `finishWrite` -- the adjustment-reporting machinery shared by every format writer. |
| `registry.ts` | The pluggable format registry: `registerFormat`, `getFormat`, `formats`. |
| `errors.ts` | The exception hierarchy: `OmnistError`, `SchemaError`, `ParseError`, `WriteError`, `DocumentError`, `DetachedNode`, `UnsafeXMLWarning`. |
| `temporal.ts` | Date/time/datetime token parsing shared by OML and the format codecs. |
| `formats/json.ts`, `formats/yaml.ts`, `formats/toml.ts`, `formats/xml.ts` | Per-format `read*`/`write*`/`check*`. |
| `ops/*.ts` | The schema algebra: `subschema.ts` (`compatibleWith`/`equivalent`), `minimize.ts` (`normalize`), `prune.ts`, `extract.ts`, `isomorphic.ts`, `lint.ts`, `signature.ts` (shared canonicalization). |
| `cli.ts` | The `omnist` command-line tool (issue #9). |
| `index.ts` | The public surface -- every exported name, mirroring the Python package's `__all__`. |

## `docs/`

See [docs/README index](README.md) (or the site nav) for the full page
map; the short version:

- `quickstart.md`, `guide.md`, `schema.md`, `example.md` -- the practical
  tour, in reading order.
- `api.md` -- every public name with signatures.
- `cli.md` -- the `omnist` command-line tool.
- `formats/*.md` -- per-format mapping and caveats.
- `design/*.md` -- formal specs (model, OML grammar, OSD grammar, the
  `any` type, openness), shared with the Python port.
- `glossary.md`, `testing.md`, `layout.md` -- this page.

## `test/`

One `*.test.ts` per `src/*.ts` module of the same name (`document.test.ts`
tests `document.ts`, and so on), plus:

- `test/formats/*.test.ts`, `test/ops/*.test.ts` -- mirroring `src/formats/`
  and `src/ops/`.
- `test/fuzz.test.ts` -- property-based round-trip fuzzing across formats
  (issue #10).
- `test/semantic-oracle.test.ts` -- the bounded CI run of
  `tools/semantic_oracle.ts`'s brute-force ground-truth check on the
  schema algebra.
- `test/cli.test.ts`, `test/cli-examples.test.ts` -- the CLI's own
  subcommand tests and its `examples/cli/*` fixture-driven tests.
- `test/check-doc-examples.test.ts` -- tests `tools/check_doc_examples.ts`,
  the CI gate requiring a `verified-by`/`doc-illustrative` marker on every
  new/changed doc code block.
- `test/docs-*.test.ts` -- pin the literal output shown in a specific docs
  page's code blocks (named by page: `docs-quickstart.test.ts`,
  `docs-guide.test.ts`, `docs-example.test.ts`), so a `verified-by` marker
  in that page has something real to point at.

## `tools/`

- `semantic_oracle.ts` -- the full brute-force semantic oracle (`npm run
  oracle`); `test/semantic-oracle.test.ts` runs a bounded version of the
  same checks in CI.
- `check_doc_examples.ts` -- the doc-example marker CI gate.

100% line/branch/function/statement coverage is enforced repo-wide by
`vitest.config.ts`'s coverage thresholds, over `src/**/*.ts` and
`tools/**/*.ts`. See [testing.md](testing.md).
