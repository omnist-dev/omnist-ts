# TOML

`readToml`/`writeToml`/`checkToml` (`src/formats/toml.ts`, built on the
optional `smol-toml` peer dependency).

TOML has no bare top-level scalar -- a document must be table-shaped
(a record at the root), so a Document whose root is a leaf can't be
written to TOML at all. TOML tables map onto the same edge-list model as
every other format; arrays of tables are the array-field case.

```ts
import { readToml, writeToml, checkToml } from "@omnist-dev/omnist";

const node = readToml('name = "Ann"\ntag = ["x", "y"]\n');
writeToml(node);
```
<!-- doc-illustrative -->
