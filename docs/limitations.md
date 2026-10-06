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

The spec gives no reference default (D-24): an implementation may set any finite
value, must document it, and should measure its slowest codec on a worst-case
input of that size before raising it. A byte cap bounds the cost of a parsing library's worst case;
it does not make any parse fast. Measured on this port (WSL2, Node 20, `yaml`
2.9, `smol-toml`, `fast-xml-parser`):

| Input | Size | Read time |
|---|---|---|
| JSON, array of records | 10 MiB / 64 MiB | 0.5 s / 2.9 s |
| OML, repeated edges | 10 MiB / 64 MiB | 0.7 s / 4.5 s |
| XML, repeated elements | 10 MiB / 64 MiB | 0.9 s / 5.4 s |
| YAML, block sequence of records | 2 MiB; 0.14 / 0.28 / 0.58 / 1.2 MiB of short records | 0.7 s; 0.7 / 0.8 / 1.1 / 2.3 s (the first includes warm-up; linear) |
| TOML, array of tables | 1 / 2 / 4 / 10 MiB | 0.3 / 1.0 / 5.0 / 46.7 s |
| YAML, one block mapping | 91 / 183 / 388 / 1,004 KiB (5,000 / 10,000 / 20,000 / 50,000 keys) | 0.3 / 0.3 / 0.5 / 1.2 s (v0.8.1-alpha; before it 0.8 / 2.4 / 10.7 s, and minutes at 50,000) |

So 64 MiB is a sound bound for JSON, OML, XML and YAML mappings, and **not** for
one parser:

- **YAML ([omnist-ts#157](https://github.com/omnist-dev/omnist-ts/issues/157)):**
  the `yaml` library's duplicate-key check compares each key with every key before
  it, so its parse of one large block (or flow) mapping was quadratic in the keys:
  a 1 MB mapping of 50,000 keys took minutes (195 s on one machine, 74 s for a smaller text on another), far below 64 MiB. **Fixed in
  v0.8.1-alpha:** `readYaml` turns the library's check off and makes the same test
  in one linear pass, so that mapping now reads in about 1.2 s. A duplicate key is
  still refused with the same error and position, with one exception: in a mapping
  of a document whose total quadratic cost (the sum over its mappings of keys
  squared) exceeds that of one 4,096-key mapping, the error names the duplicate
  key's own position. The library's position is the end of the preceding token,
  so it can be the previous line when the previous value is empty (`a:` then
  `a: 1` after 4,500 keys: library 4501:3, port 4502:1). Re-running the
  library's quadratic check on such a document would reopen the denial of
  service, whether it is one huge mapping or many large ones (40 mappings of
  4,095 keys with one duplicate took 24 s to re-parse; now 5.4 s, most of it the parse itself). The aliases
  inside `!!pairs` and `!!omap` are a separate, still-open part of that issue.
- **TOML:** the `smol-toml` parse of a long array of tables is superlinear
  (about 47 s at 10 MiB; 0.2 / 0.8 / 3.5 s for 0.35 / 0.7 / 1.5 MiB). `readToml`
  adds about 10 percent to the library's time, so the cost is the library's, and
  the 64 MiB default does not bound it.

If you read untrusted TOML, pass a `maxInputBytes` that matches what you expect to
receive (for example `1024 * 1024`), and run the parse in a process you can time
out. The same advice holds for YAML until the `!!pairs` part of #157 is closed.

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
