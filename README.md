# omnist (TypeScript)

[![test](https://github.com/omnist-dev/omnist-ts/actions/workflows/test.yml/badge.svg)](https://github.com/omnist-dev/omnist-ts/actions/workflows/test.yml)
[![docs](https://github.com/omnist-dev/omnist-ts/actions/workflows/docs.yml/badge.svg)](https://github.com/omnist-dev/omnist-ts/actions/workflows/docs.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

TypeScript port of [omnist](https://github.com/omnist-dev/omnist) -- one
canonical data model for JSON, YAML, TOML, XML, and its own native OML
(Omnist Markup Language). See the upstream Python project for the full
design rationale; this repo mirrors its module boundaries and public API
(camelCase names of the same functions).

**Docs:** <https://ts.omnist.dev/> (start at
[Quickstart](https://ts.omnist.dev/quickstart)).

Status: fully implemented -- library, CLI, and fuzz/oracle test suite are
complete and at 100% coverage (issues #1-#11). No npm package has been
published yet; that's a separate, deliberate decision still pending, not
a sign of incompleteness. Track progress via the issue tracker.

## Model

Same model as upstream, ported directly from its formal spec:

- A **Document** is an ordered list of labeled edges (not a map) -- arrays
  are repeated labels.
- A **Schema** is `record` definitions (closed, named fields with
  cardinality), where a field's type is exactly one scalar
  (`string`/`integer`/`number`/`boolean`/`date`/`time`/`datetime`,
  optionally nullable), a `Ref` to a named record, or `any`.

See [the model spec](docs/design/model.md) for the full formal definition
this port implements against, or [the quickstart](docs/quickstart.md) for
the shortest possible tour.

## Development

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run test:coverage
npm run docs:dev      # live-reload docs site at http://localhost:5173
npm run docs:build    # static build to docs/.vitepress/dist
```

## License

Apache-2.0 -- see [LICENSE](LICENSE) and [NOTICE](NOTICE).
