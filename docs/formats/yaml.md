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


## Known limitation: an over-large integer literal is rejected, not corrupted (issue #54)

`readYaml` raises `ParseError` on a bare integer-shaped token (all digits,
no `.`, no exponent, outside a quoted scalar or comment) with more than
4300 digits -- the same digit cap `src/document.ts` already enforces on a
parsed Document value (`MAX_INT_DIGITS`, matching CPython's
`sys.get_int_max_str_digits()` default). Before this check existed, the
underlying `yaml` package would silently round such a literal to
`Infinity`, indistinguishable from this port's documented native `.inf`
support -- so `writeYaml` had no way to tell "the user wrote `.inf`" apart
from "the reader silently lost precision."

`.inf`/`-.inf`/`.nan` themselves are unaffected: those round-trip natively
(see this file's top comment) and are not integer literals.

This mirrors `readToml`'s own precedent (see `docs/formats/toml.md` and
issue #25): reject with a clear error rather than silently lose precision.
Full arbitrary-precision integer support (a JS `BigInt`-shaped Document
value) would be a much larger structural change and is out of scope here.

The digit-cap scan is a text-level heuristic, not a full YAML tokenizer:
it skips quoted scalars and `#` comments, but does not track block-scalar
(`|`/`>`) indentation, so an over-long digit run inside literal
block-scalar text could in principle be misflagged. This is the same
class of accepted, documented gap as this file's `"<<"` merge-key
limitation above, not a full YAML grammar reimplementation.
