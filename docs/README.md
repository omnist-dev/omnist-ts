# Omnist documentation

This folder is the source for the [VitePress](https://vitepress.dev) docs
site (`docs.yml` deploys it to GitHub Pages on push to `master`). Start
here, in roughly this order:

| Doc | What it covers |
|---|---|
| [Quickstart](quickstart.md) | The shortest possible tour. |
| [User guide](guide.md) | The practical tour -- documents, OML, OSD and the builder functions, validation, the schema operations, codecs, inference. |
| [The Schema model & OSD](schema.md) | `record` definitions, cardinality, the builder functions, and the comparison/inference operations. |
| [A real-life example](example.md) | One order schema validated against an order written in OML. |
| [API reference](api.md) | Every public name with signatures. |
| [CLI](cli.md) | The `omnist` command-line tool. |
| [Formats](formats/overview.md) | How each format maps to the model -- [OML](formats/oml.md) / [JSON](formats/json.md) / [YAML](formats/yaml.md) / [TOML](formats/toml.md) / [XML](formats/xml.md). |
| [Spec: formal model, grammars & algebra](https://spec.omnist.dev) | The normative Document/Schema models, OML/OSD grammars, and schema algebra -- language-agnostic, authoritative for every omnist port. |
| [Glossary](glossary.md) | One definition per term used across the docs and code. |
| [Testing](testing.md) | The test suite: layout, coverage tooling and target, fuzzing, the semantic oracle, and the doc-example CI gate. |
| [Repo layout](layout.md) | How the repo is organized: `src/*.ts` responsibilities, the docs page map, the test file map. |
