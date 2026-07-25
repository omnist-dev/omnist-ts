# JSON

`readJson`/`writeJson`/`checkJson` (`src/formats/json.ts`).

JSON has no native `date`/`time`/`datetime` type and no `NaN`/`Infinity`.
Writing a Document with those leaves adjusts them (dates to ISO-8601
strings, non-finite numbers to `null`) and records an `Adjustment` in the
`WriteReport`, unless `{ strict: true }` is passed, in which case the
write throws instead.

Same-label edges (an array field) collapse into a JSON array; a label that
occurs exactly once stays a bare value rather than a single-element array
-- the schema-less "count-1 fallback." Pass `{ schema }` to `readJson` to
disambiguate a genuinely-array field with exactly one element from a
scalar field, and to upgrade ISO date/time strings to real `Date`s.

```ts
import { readJson, writeJson, checkJson } from "@omnist-dev/omnist";

const node = readJson('{"name": "Ann", "tag": ["x", "y"]}');
writeJson(node);
checkJson(node); // WriteReport -- what a write would adjust, without writing
```
<!-- doc-illustrative -->
