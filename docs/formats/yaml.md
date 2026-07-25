# YAML

`readYaml`/`writeYaml`/`checkYaml` (`src/formats/yaml.ts`, built on the
optional `yaml` peer dependency).

YAML is closer to the Document model than JSON -- it has native date/
timestamp scalars -- but shares JSON's array/object shape, so the same
same-label-edges-collapse-to-an-array mapping and count-1 fallback apply.
Pass `{ schema }` to `readYaml` to disambiguate and to upgrade leaves the
same way `readJson`/`readToml`/`readXml` do.

```ts
import { readYaml, writeYaml, checkYaml } from "@omnist-dev/omnist";

const node = readYaml("name: Ann\ntag:\n  - x\n  - y\n");
writeYaml(node);
```
<!-- doc-illustrative -->


## Known limitation: a label literally `"<<"` (issue #46)

A document edge labeled exactly `"<<"` round-trips fine through JSON, OML,
TOML, and XML, but not through YAML. YAML 1.1 gives that exact key special
"merge key" meaning, and the underlying `yaml` package applies it
unconditionally for the `"yaml-1.1"` schema this port is pinned to (chosen
for date/bool-coercion parity with PyYAML's `safe_load`/`safe_dump` --
see `src/formats/yaml.ts`'s file-top comment). PyYAML has the identical,
unconditional behavior in its own `SafeLoader`/`SafeDumper` -- confirmed
directly: `yaml.safe_load('<<: 1')` raises the same
`expected a mapping ... for merging` error -- so this is a genuine
cross-implementation YAML-format gap, not a bug specific to this port.

Concretely:

- if the `"<<"` edge's target isn't a map, `writeYaml`/`readYaml` round-trip
  throws `ParseError` on read-back;
- if the target *is* a map, the round-trip "succeeds" but silently loses
  data: the `"<<"` edge disappears and its children splice into the parent
  map instead of staying a distinct edge.

`test/fuzz.test.ts`'s YAML round-trip property test excludes labels equal
to `"<<"` for this reason (the same way it excludes documents containing
U+0085 for issue #69), and `test/formats/yaml.test.ts` has two direct
regression tests pinning down both failure modes above.
