/**
 * The comparison referee -- omnist-spec's docs/conformance-harness.md Sec4.
 *
 * Uses omnist-ts's own library to parse OML/OSD text and judge structural
 * equality. This module is deliberately small: it does no fixture-format
 * parsing and no per-operation dispatch -- see the (future) fixture and
 * vector runners for those. Ported from Python's `omnist`'s
 * `tools/conformance/referee.py` (itself ported from omnist-spec's
 * `conformance/orchestrator/referee.py`, issue #283) with no change to the
 * comparison logic itself.
 */

import { Doc } from "../../src/document.js";
import { readOml } from "../../src/oml.js";
import { parseSchema } from "../../src/osd.js";
import { schemaEquals } from "../../src/schema.js";
import { isomorphic } from "../../src/ops/isomorphic.js";

/** The two legitimate schema-comparison modes (Sec4/6.2) -- chosen per
 * operation, never guessed. */
export type SchemaCompareMode = "exact" | "isomorphic";

/**
 * Structural, order-sensitive equality (`Doc.equals` already provides
 * this -- see the conformance-harness spec Sec4, no new library code
 * needed for Document comparison).
 *
 * `readOml` returns a `Node`, not a `Doc` -- wrap each side in `new
 * Doc(node)` (the `Doc` constructor accepts a `Node` directly) so
 * `Doc.equals` can do the comparison.
 */
export function compareDocument(actualOmlText: string, expectedOmlText: string): boolean {
  const actual = new Doc(readOml(actualOmlText));
  const expected = new Doc(readOml(expectedOmlText));
  return actual.equals(expected);
}

/**
 * Sec4/6.2: two legitimate meanings, chosen per operation.
 *
 * mode="exact": every record name and every field's label/type/cardinality
 * must match (normalize/prune/extract -- output naming is spec-determined).
 * mode="isomorphic": same structure up to a renaming of records (infer --
 * generated record names are implementation-derived, never canonical).
 */
export function compareSchema(
  actualOsdText: string,
  expectedOsdText: string,
  mode: SchemaCompareMode | (string & {}),
): boolean {
  const actual = parseSchema(actualOsdText);
  const expected = parseSchema(expectedOsdText);
  if (mode === "exact") {
    return schemaEquals(actual, expected);
  }
  if (mode === "isomorphic") {
    return isomorphic(actual, expected);
  }
  throw new Error(`unknown comparison mode ${JSON.stringify(mode)}; expected 'exact' or 'isomorphic'`);
}
