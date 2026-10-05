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
Document. `readYaml` enforces two of omnist-spec's limits on that mechanism
(D-18 to D-22, `02-document-model.md` Sec2.4.1) and rejects an over-limit
input with a `DocumentError` at path `$` (the message carries the `line`/`col`
of the offending node, or of the root), *before* any alias is expanded. Both
checks are one linear pass over the parsed document's anchor/reference graph,
with memoized counts in arbitrary precision, so a "billion laughs" input is
refused in milliseconds however large the expansion it describes.

| Limit | Code | Default | Option |
|---|---|---|---|
| Expansion factor (the ratio, D-18) | `document.limit.alias-expansion` | 50 | `maxAliasExpansion`, 1 to 10,000 |
| Expanded size (the absolute cap, D-22) | `document.limit.expanded-size` | 1,000,000 slots | `maxExpandedSlots`, 1 to 10,000,000 |

For both options, zero, a negative value and NaN select the default and are
never "no limit"; a value above the ceiling, infinite or fractional throws a
`RangeError`. This port has no other configurable limit: `MAX_DEPTH`,
`MAX_NODES` and `MAX_INT_DIGITS` are compile-time constants.

```ts
import { readYaml } from "@omnist-dev/omnist";

readYaml(text, { maxAliasExpansion: 200, maxExpandedSlots: 5_000_000 });
```
<!-- doc-illustrative -->

### The ratio: `E = W / S`

For every anchored node, every mapping and sequence (anchored or not), the
document root, and every inline merge source, `E = W / S` is computed: `W` is
the number of value slots the node materializes, `S` the number it is written
with (an alias counts one slot in `S` and its target's `W` in `W`; a merge-key
reference `<<: *b` contributes `W(b) - 1`). Scalars are never checked. If any
`E` exceeds the maximum, the input is rejected. An anchor that refers to
itself, directly or through other anchors (`a: &a [*a]`, `a: &a {<<: *a}`),
has unbounded `W` and is rejected with the same code.

**Merge sequences (D-18a).** A sequence in merge-value position is a carrier,
whether or not it is anchored: `<<: [*p, *q]` and `<<: &s [*p, *q]` read the
same. The carrier holds no slot and is not a candidate; each member
contributes `W(member) - 1` and the `<<` entry is one written slot. `<<: *s`,
an alias to a sequence, contributes the same sum over the members of `s`
(never `W(s) - 1`). A sequence written as an ordinary value and anchored
there (`s: &s [*p, *q]`) is an ordinary candidate, and a plain alias `t: *s`
of a carrier materializes the list (`1` plus the members' `W`). A mapping
written inline in a carrier, or first anchored there, counts its own written
slots less its container in `S` and `W - 1` in `W`.

**Malformed merges are syntax errors.** A merge value must be a mapping or a
sequence of mappings. A scalar value (`<<: 1`, or an empty `<<:`), a scalar
member (`<<: [1]`), a sequence inside a merge sequence (`<<: [[{a: 1}]]`) and
an alias to a sequence of scalars are `parse.codec-syntax` at the offending
`line:col`. They are detected before anything is counted, so they win over
every `document.limit.*` code, including when the malformed merge comes after
a bomb. An alias to an anchor that is not defined is the same code.

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

### The cap: `W(root)`

The ratio bounds amplification, not size: a large document in which every
container sits just under the maximum `E` passes it and can still allocate
gigabytes (omnist-spec#125). So for an input that contains **at least one
alias or merge key**, `readYaml` also rejects `W(root)` greater than
`maxExpandedSlots` with `document.limit.expanded-size`. `W(root)` exactly at
the cap is accepted. The cap is checked after the ratio, so an input that
crosses both reports `document.limit.alias-expansion`, and before anything is
materialized. The 40,000-container shape (each container `{x: *block}` over a
49-slot block, every `E` about 25) has `W(root)` of 2,000,050 and is refused by
the cap alone.

**The cliff.** An input with no alias and no merge key is not subject to the
cap, however large: a plain YAML file of two million slots is accepted (it is
still bounded by `MAX_NODES` and the input size limit), as a JSON file of the
same size is. Add one alias, even a harmless one of a scalar, and the file is
subject to the cap and is rejected. A quoted `"<<"` key is an ordinary key, not
a merge key.

The `yaml` package's own alias guard (`maxAliasCount`, default 100) is
switched off here: it counts aliases against a fixed number rather than
measuring expansion, so it would reject legitimate documents (a scalar aliased
500 times) and pre-empt this check's coded error on the dangerous ones.

**What the checks do not bound.** They bound expansion, not parse cost: the
`yaml` library's own parse of a huge text is not covered. That parse is
superlinear in the number of anchors (about 50,000 anchors take around 150 s to
parse while the check takes about 0.2 s), a cost that predates these limits. It
is also quadratic in the number of keys of one block mapping, with or without
aliases (measured with `yaml` 2.9.0: 20,000 keys took 22.8 s, and a 1.19 MB
single block mapping of 50,000 keys took 191.7 s, identical before this limit
existed), while a sequence of the same size parses in a fraction of a second.
So a roughly 1 MB input that is one big mapping is about three minutes of CPU
whatever D-18 and D-22 say, and the default input-size limit (64 MiB) is far
too high to stop it (see [Limitations](../limitations.md)). The cost is the library's, not the check's. Two compose-style figures
in this port's tests: a `services:` mapping of 100 services each merging a
20-key block has `W(root)` 2,223 (1 + 21 for the root and block, 1 for the
`services` mapping, 100 x 22); with the services at the top level, as in the
tests, it is 2,222. 60 keys give 6,263 / 6,262 and 1,000 services 62,063 / 62,062.
`MAX_NODES` counts only mappings, not scalars, so scalar-heavy expansion is
bounded by the checks above alone (`W(root)` is at most the ratio maximum times
`S(root)`, and at most the cap).

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
