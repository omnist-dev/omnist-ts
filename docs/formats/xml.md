# XML

`readXml`/`writeXml`/`checkXml` (`src/formats/xml.ts`, built on the
optional `fast-xml-parser` peer dependency).

A deliberately narrow **data-XML** profile: elements only -- no
attributes, no CDATA distinction, mixed content is rejected. XML always
has exactly one top-level element, so an XML Document always has a single
top-level edge (wrap a multi-rooted Document under one label first, the
same convention used in
[the real-life example's schema](../example.md#the-schema)).

`readXml` is hardened against XXE / entity-expansion attacks by
construction (external entities and entity expansion always throw,
regardless of options) -- see `SECURITY.md` and the module's own header
comment for the threat model.

```ts
import { readXml, writeXml, checkXml } from "@omnist-dev/omnist";

const node = readXml("<root><name>Ann</name></root>");
writeXml(node);
```
<!-- doc-illustrative -->
