# Limitations

## The 64 MiB input-size limit

Every read of a Document from text refuses an input of more than **64 MiB**
(`64 * 1024 * 1024` = 67,108,864 bytes) with `document.limit.input-size` at `$`
([omnist-spec](https://github.com/omnist-dev/omnist-spec) D-23 to D-26). This is
a **behaviour change** in v0.8.0-alpha: it replaces an older guard of 256 MiB
counted in UTF-16 code units (issue #110), so an input between 64 and 256 MiB that
used to parse is now refused until you raise the limit.

- **Bytes, not characters.** The UTF-8 size is counted, so an `e` with an acute
  accent is two, and a leading byte-order mark is three: the count is taken
  before the mark is stripped and before anything is decoded or parsed.
- **Checked first.** An oversized input is refused even if it is also malformed.
  An input of exactly the maximum is accepted.
- **Library.** `readJson`, `readYaml`, `readToml`, `readXml` and `readOml` take
  `maxInputBytes`: an integer of at least 1, otherwise a `RangeError`. There is
  no "unlimited". `readFormat(name, text, opts)` applies the same limit before a
  plugin reader runs.
- **CLI.** `--max-input-bytes N` on `format`, `convert`, `check`, `validate` and
  `infer`. The file or stdin read stops at `N + 1` bytes, and the refusal says how
  to raise the limit.

```ts
import { readJson } from "@omnist-dev/omnist";

readJson('{"a":"xxxxxxxxxxxx"}', { maxInputBytes: 20 }); // 20 bytes: accepted
readJson('{"a":"xxxxxxxxxxxxx"}', { maxInputBytes: 20 }); // 21 bytes: ParseError,
// code "document.limit.input-size", path "$"
```
<!-- doc-illustrative -->

### What the limit does and does not bound

The spec gives no reference default and says a cap SHOULD NOT exceed 10 MiB
without measuring. A byte cap bounds the cost of a parsing library's worst case;
it does not make any parse fast. Measured on this port (WSL2, Node 20, `yaml`
2.9, `smol-toml`, `fast-xml-parser`):

| Input | Size | Read time |
|---|---|---|
| JSON, array of records | 10 MiB / 64 MiB | 0.5 s / 2.9 s |
| OML, repeated edges | 10 MiB / 64 MiB | 0.7 s / 4.5 s |
| XML, repeated elements | 10 MiB / 64 MiB | 0.9 s / 5.4 s |
| YAML, block sequence of records | 2 MiB | 0.7 s |
| TOML, array of tables | 1 / 2 / 4 / 10 MiB | 0.3 / 1.0 / 5.0 / 46.7 s |
| YAML, one block mapping | 135 / 271 / 564 KiB (5,000 / 10,000 / 20,000 keys) | 1.4 / 6.0 / 17.3 s |

So 64 MiB is a sound bound for JSON, OML and XML, and **not** for two parsers:

- **YAML ([omnist-ts#157](https://github.com/omnist-dev/omnist-ts/issues/157)):**
  the `yaml` library's parse of one large block mapping is quadratic in its keys.
  A 1 MB single block mapping of 50,000 keys took about 195 s. That is far below
  64 MiB, so **the default cap does not bound it**; nor would any cap that still
  admits ordinary documents. The aliases inside `!!pairs` and `!!omap` are a
  separate, still-open part of that issue. Neither is fixed here.
- **TOML:** the `smol-toml` parse of a long array of tables is also superlinear
  (about 47 s at 10 MiB). The 64 MiB default does not bound it either.

If you read untrusted YAML or TOML, pass a `maxInputBytes` that matches what you
expect to receive (for example `1024 * 1024`), and run the parse in a process you
can time out.

### Why 64 MiB

A document within `MAX_NODES` (1,000,000 nodes) is never refused by it: a
1,000,000-leaf XML document is well under 50 MiB, and the other formats are more
compact. It is also the value the Python implementation uses. A smaller default
would refuse legitimate large documents and would still not make YAML or TOML safe,
which is why the limit is configurable rather than lower.

## Writers refuse a string with no UTF-8 encoding

A JavaScript string can hold a UTF-16 lone surrogate, which has no UTF-8 encoding.
No writer will write one (spec C-9): `writeJson`, `writeYaml`, `writeToml`,
`writeXml`, `writeOml` and their `check*` functions throw `WriteError` with code
`write.unsupported-value`, at the Document path of the node holding the string (for
an edge label, the node holding the edge), whatever `strict` is. A valid surrogate
pair, an astral character, writes normally.
