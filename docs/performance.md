# Performance

Measured on an ordinary laptop (WSL2, Node.js 20), the same way Python's
["Why Omnist"](https://github.com/omnist-dev/omnist/blob/main/docs/why-omnist.md#performance)
publishes its numbers: real timed runs, not estimates. Every number below
came from an actual `npm run bench` (`tools/bench.ts`, issue #42) on this
port, not a port of the Python numbers -- the two implementations are
different languages with different runtimes, so their numbers are not
expected to match. Run it yourself with:

```bash
npm run bench
```
<!-- doc-illustrative -->

## A 100k-edge document

The same shape Python's write-up uses: an array of three-field records
(`id`, `name`, `active`) wrapped under a single root edge, sized to
~100,000 total edges (25,000 records here; ~1.30MB as JSON).

| Operation | Time |
|---|---|
| build the Document (`buildNode`) | ~68ms |
| JSON write / read | ~135ms / ~76ms |
| YAML write / read | ~887ms / ~1955ms |
| TOML write / read | ~147ms / ~238ms |
| XML write / read | ~101ms / ~477ms |
| OML write / read | ~94ms / ~616ms |

YAML read (and, to a lesser extent, write) is the clear outlier here --
roughly 3x OML's read time and over 25x JSON's, on the same document.
[omnist-ts#43](https://github.com/omnist-dev/omnist-ts/issues/43) profiled
this directly (`YAML.parse`/`YAML.stringify` timed in isolation from this
port's own wrapper code) rather than guessing, and confirmed it's an
inherent property of the `yaml` npm package's parser/serializer, not a
bug in this port's `src/formats/yaml.ts`:

- Splitting `readYaml` into its two steps shows `YAML.parse` alone taking
  ~2100ms of the ~2190ms total read -- this port's own `buildNode()` step
  (the same function every other codec's reader calls) took ~60ms, in
  line with JSON's whole read time. The wrapper is not the bottleneck;
  well over 90% of the time is inside the `yaml` package itself.
- The same split on the write side: `grouped()` (this port's own
  pre-processing, shared with JSON) took ~14ms of the ~900ms total write;
  `YAML.stringify` alone took ~800ms.
- Timing `YAML.parse` at 5k/10k/20k/40k records showed a constant
  ~78-82us/record, i.e. linear scaling with document size, not quadratic
  -- ruling out an accidentally-pessimal usage pattern (no O(n^2) blowup
  to fix).
- Switching from the `"yaml-1.1"` schema (required for PyYAML-compatible
  parsing, see `src/formats/yaml.ts`'s file-top comment) to the package's
  default `"core"` schema shaved only ~15% off parse time (~2105ms to
  ~1752ms) -- the schema choice isn't the driver either.

Conclusion: YAML's grammar is substantially more complex than JSON's
(block/flow styles, anchors/aliases, multiple scalar-resolution schemas,
implicit typing), and the `yaml` package's parser pays for that
complexity per node. That cost is real but not a regression to chase --
there was no fix to make here. If YAML is your hot-path format on large
documents, prefer JSON or OML.

OML read is meaningfully faster than a prior audit measured pre-#35: that
issue's tokenizer-dispatch fix roughly halved OML read time on a
comparably sized document (from ~1047ms to ~616ms here), matching its own
before/after claim.

## Schema.validate()

Against a 30-record schema (each record: 3 scalar fields + one optional
`any` field), at increasing document sizes:

| Total items (across 30 records) | Time |
|---|---|
| 300 | ~2ms |
| 3,000 | ~3ms |
| 30,000 | ~43ms |

## Schema-only operations

On the same 30-record schema:

| Operation | Time |
|---|---|
| `normalize` | ~1ms |
| `compatibleWith` (self) | <1ms |
| `extract` (half the labels) | <1ms |

## Notes

- Every number above is a **median of 7 timed samples**, after 3 untimed
  warm-up runs (5 samples / 2 warm-ups for the larger codec benchmarks),
  specifically so a single slow sample -- this machine sometimes runs
  concurrent agent processes -- doesn't skew the reported number the way
  a mean would be skewed by one outlier.
- `tools/bench.ts` is a manual tool, not part of `npm test`/CI (like
  Python's own benchmarking, and like this port's `tools/semantic_oracle.ts`
  full run): there is no "correct" performance number to assert
  red/green against, so re-run it yourself rather than trusting these
  numbers to stay exactly current as the code changes.
- These numbers are from one machine, one point in time (see the bench
  tool's own printed timestamp when you run it) -- treat them as an order
  of-magnitude sanity check, not a guarantee.

## See also

- [Testing](testing.md) -- the correctness side: coverage target, the
  triple-checked schema algebra, fuzzing.
- [Repo layout](layout.md) -- where `tools/bench.ts` sits relative to the
  rest of the tree.
