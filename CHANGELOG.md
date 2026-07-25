# Changelog

All notable changes to this project are documented here. The format is
loosely based on [Keep a Changelog](https://keepachangelog.com/). This is
the first documented release of the TypeScript port; the public API
mirrors the upstream Python package's `__all__` (camelCase names of the
same functions).

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
