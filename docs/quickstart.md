# Quickstart

```bash
npm install @omnist-dev/omnist
```
<!-- doc-illustrative -->

The shortest possible tour -- one OML snippet, one schema, one validation,
one inference. For the fuller order/address/line-item walkthrough, see
[A real-life example](example.md).

```ts
import { readOml, parseSchema, infer, doc, toOsd, Doc } from "@omnist-dev/omnist";

// 1. A document, in OML -- omnist's own format (see formats/oml.md)
const node = readOml('name: "Ann"');

// 2. A schema, in OSD (see schema.md)
const schema = parseSchema('record Person { "name": string }\nroot Person');

// 3. Validate the document against the schema
schema.validate(new Doc(node)).ok; // true

// 4. Infer a schema from example documents instead of writing one by hand
toOsd(infer([doc({ name: "Ann" }), doc({ name: "Bo" })]));
// 'record Root {\n    "name": string,\n}\nroot Root\n'
```
<!-- verified-by: test/docs-quickstart.test.ts::quickstart snippet reproduces the documented output -->

That's it -- a Document, a Schema, `validate()`, and `infer()`. From here:

- [User guide](guide.md) -- the full practical tour.
- [A real-life example](example.md) -- a multi-field order schema across formats.
- [The Schema model & OSD](schema.md) -- OSD in depth.
- [Repo layout](layout.md) -- how the repo itself is organized.
