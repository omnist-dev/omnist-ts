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

This module is pinned to the "yaml-1.1" schema (chosen for date/bool-
coercion parity with PyYAML's safe_load/safe_dump -- see
src/formats/yaml.ts's file-top comment), which brings YAML 1.1's own
resolution quirks along with it: yes/no/on/off/true/false (any case)
resolve to booleans, not strings -- narrowed from full YAML 1.1's
alias set to match PyYAML's own default resolver, so a bare y/n does
NOT resolve to a boolean the way yes/no does (issue #89) -- and
.inf/-.inf/.nan resolve to the corresponding non-finite number,
matching PyYAML rather than the stricter YAML 1.2 core schema. None of
that is adjustment-report territory -- it's read-side resolution, not
a write-side lossy substitution -- but it's the reason a YAML document
authored for a YAML-1.2 tool can read back differently here.

Because a mapping key is also subject to that same boolean resolution,
a bare key like on: (the "Norway problem") resolves to boolean true
before it ever becomes a Document label -- and since a label must be a
string, readYaml rejects that document with a DocumentError rather
than silently stringifying the resolved boolean back to the string
"true".

## Alias expansion limit

YAML anchors and aliases let a small input materialize into an enormous
Document. `readYaml` enforces omnist-spec's alias expansion limit (D-18,
D-19, D-20, `02-document-model.md` Sec2.4.1) and rejects an over-limit input
with a `DocumentError` whose `code` is `document.limit.alias-expansion` and
whose `path` is `$` (the message carries the `line`/`col` of the offending
node), *before* any alias is expanded. The check is one linear pass over the
parsed document's anchor/reference graph, with memoized counts in arbitrary
precision, so a "billion laughs" input is refused in milliseconds however
large the expansion it describes.

For every anchored node, every mapping and sequence (anchored or not), the
document root, and every inline merge source, `E = W / S` is computed: `W` is
the number of value slots the node materializes, `S` the number it is written
with (an alias counts one slot in `S` and its target's `W` in `W`; a merge-key
reference `<<: *b` contributes `W(b) - 1`). Scalars are never checked. If any
`E` exceeds the maximum, the input is rejected. An anchor that refers to
itself, directly or through other anchors (`a: &a [*a]`, `a: &a {<<: *a}`),
has unbounded `W` and is rejected with the same code.

The maximum is **50** by default (the spec's reference value). Raise or lower
it with `maxAliasExpansion`, an integer from 1 to 10000; zero or a negative
value selects the default and is never "no limit", and a larger or
fractional value throws a `RangeError`. This port has no other configurable
limit: `MAX_DEPTH`, `MAX_NODES` and `MAX_INT_DIGITS` are compile-time
constants.

```ts
import { readYaml } from "@omnist-dev/omnist";

readYaml(text, { maxAliasExpansion: 200 });
```
<!-- doc-illustrative -->

**Legitimate merges are not free.** A mapping that merges a large anchor and
writes little of its own reads `E` of about `(keys + 2) / 3`:
`job: {<<: *base, script: x}` is written with three slots and materializes
`keys + 2`. A 100-service compose file each merging a 20-key defaults block
reads at most 7.33, and a 100-service one merging a 60-key block 20.67, both
well inside 50. But a mapping that merges a 150-key anchor and writes one key
of its own reads about 50.67 and is rejected at the default; a 100-key block
aliased 100 times at the document root reads 50.50 and is too. If a real
workload needs it, raise `maxAliasExpansion`. `W` is a structural upper bound,
blind to key collisions (a merged key overridden by a local key is still
counted), so the limit errs toward rejection.

The `yaml` package's own alias guard (`maxAliasCount`, default 100) is
switched off here: it counts aliases against a fixed number rather than
measuring expansion, so it would reject legitimate documents (a scalar aliased
500 times) and pre-empt this check's coded error on the dangerous ones.

## Adjustment codes

`writeYaml`/`checkYaml` can report one adjustment code -- the full set
YAML's codec can ever emit (`test/fuzz.test.ts` asserts this against
`ALLOWED_CODES.yaml`):

| code | severity | trigger |
|---|---|---|
| `string.line-break-char` | warning | a label or string value containing U+0085 (NEL) -- forced to a double-quoted scalar so it round-trips correctly |

U+0085 is one of the line-break characters YAML's block-scalar folding
treats specially; left unquoted, a value containing it can be re-folded
on read in a way that doesn't reproduce the original text byte-for-byte.
`writeYaml` sidesteps that by writing any string containing it (label or
value) as an explicitly double-quoted scalar instead of a plain or
block one.

```ts
import { buildNode } from "@omnist-dev/omnist";
import { checkYaml, writeYaml } from "@omnist-dev/omnist";

const node = buildNode({ note: "line1line2" });
checkYaml(node).adjustments;
// [{ path: "$.note", code: "string.line-break-char",
//    message: "value contains U+0085 (NEL); written double-quoted to round-trip correctly",
//    severity: "warning" }]
writeYaml(node);
// 'note: "line1line2"\n' -- double-quoted, not the plain/block form writeYaml uses otherwise
```
<!-- doc-illustrative -->

The same code fires for a *label* containing U+0085 (message text reads
"label contains U+0085 ..." instead of "value contains ..."), since a
YAML mapping key is scanned the same way a scalar value is.

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


## Arbitrary-precision integers (issue #98)

`integer`-kinded values are backed by native `BigInt`, not `number`.
`readYaml` runs `YAML.parse` with the `yaml` package's own `intAsBigInt:
true` option, so a bare integer-shaped token (all digits, no `.`, no
exponent) parses into an exact `bigint` no matter how large -- no
tag-and-revive workaround is needed here the way `readJson`'s does,
because the `yaml` package exposes this natively. `writeYaml` similarly
relies on the package's native `bigint` stringification (a bare digit
token, same as before). `number`-kinded values (float-shaped tokens) are
unaffected and stay plain JS `number`.

`.inf`/`-.inf`/`.nan` are unaffected either way: those round-trip natively
(see this file's top comment) and are not integer literals.

`readYaml` still raises `ParseError` on a bare integer-shaped token (all
digits, outside a quoted scalar or comment) with more than 4300 digits
(`MAX_INT_DIGITS`, matching CPython's `sys.get_int_max_str_digits()`
default and `src/document.ts`'s own cap). Before issue #98 this same scan
existed to catch the underlying `yaml` package silently rounding an
over-long literal to `Infinity` (indistinguishable from `.inf`); now that
`intAsBigInt: true` makes the package construct an arbitrarily large
`bigint` instead of overflowing, the scan's purpose has shifted but its
necessity hasn't: an unbounded-digit literal is still a real
unbounded-digit-to-string conversion risk (security, superlinear),
whether it would have overflowed or not.

`writeYaml` also forces every plain JS `number` scalar (never a `bigint`)
to render with at least one fraction digit, even when whole (e.g. `-0`
writes as `-0.0`, not `-0`) -- otherwise a whole-valued `number` would
write as a bare digit token indistinguishable from an `integer`, and read
back as the wrong kind.

The digit-cap scan is a text-level heuristic, not a full YAML tokenizer:
it skips quoted scalars and `#` comments, but does not track block-scalar
(`|`/`>`) indentation, so an over-long digit run inside literal
block-scalar text could in principle be misflagged. This is the same
class of accepted, documented gap as this file's `"<<"` merge-key
limitation above, not a full YAML grammar reimplementation.
