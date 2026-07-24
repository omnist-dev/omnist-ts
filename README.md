# omnist (TypeScript)

**Work in progress.** TypeScript port of [omnist](https://github.com/omnist-dev/omnist)
— one canonical data model for JSON, YAML, TOML, XML, and its own native OML
(Omnist Markup Language). See the upstream Python project for the full
design rationale; this repo mirrors its module boundaries and public API
(camelCase names of the same functions), porting module by module toward
parity with Python v0.7.8.

Status: pre-release, no npm package published yet. Track progress via the
issue tracker.

## Model

Same model as upstream, ported directly from its formal spec:

- A **Document** is an ordered list of labeled edges (not a map) — arrays
  are repeated labels.
- A **Schema** is `record` definitions (closed, named fields with
  cardinality), where a field's type is exactly one scalar
  (`string`/`integer`/`number`/`boolean`/`date`/`time`/`datetime`,
  optionally nullable), a `Ref` to a named record, or `any`.

See upstream's [docs/design/model.md](https://github.com/omnist-dev/omnist/blob/master/docs/design/model.md)
for the full formal definition this port implements against.

## Development

```bash
npm install
npm run typecheck
npm run lint
npm test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
