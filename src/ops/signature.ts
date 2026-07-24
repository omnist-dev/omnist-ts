/**
 * Field-signature helpers for schema minimization (and isomorphism).
 * Ported from `omnist/ops/signature.py`.
 *
 * `localSignature` is the target-blind structural key used as the
 * *initial* partition for MinimizeSA (`ops/minimize.ts`): a key including
 * ref target names would be too strong a starting point -- records that
 * turn out to be equivalent because their ref targets are themselves
 * equivalent-but-differently-named would never even land in the same
 * starting block. It captures a field's label, cardinality, and
 * scalar-or-ref *shape*, but excludes ref target names (those are compared
 * by evolving block id during refinement instead).
 */

import type { Field, FieldType, Record as OmnistRecord } from "../schema.js";

/** A field's shape, target-blind: `["scalar", kind, nullable]` or
 * `["ref"]` or `["any"]`. */
export type ShapeKey = readonly ["scalar", string, boolean] | readonly ["ref"] | readonly ["any"];

/** One field's signature entry: `[label, min, max, shape]`. */
export type FieldSignature = readonly [string, number, number | null, ShapeKey];

/** A record's target-blind structural key: `["record", fields]`, fields
 * sorted by label. See module doc for why ref targets are excluded. */
export type LocalSignature = readonly ["record", readonly FieldSignature[]];

function shapeKey(type: FieldType): ShapeKey {
  if (type.tag === "any") return ["any"];
  if (type.tag === "ref") return ["ref"];
  return ["scalar", type.scalarKind, type.nullable];
}

function fieldSignature(f: Field): FieldSignature {
  return [f.label, f.min, f.max, shapeKey(f.type)];
}

/**
 * Target-blind structural key for a record: fields sorted by label, each
 * keyed by `(label, min, max, shape)` where `shape` is `("scalar", kind,
 * nullable)` for a scalar field, `("ref",)` for a ref field, or `("any",)`
 * for an `any` field -- the target record's *name* is deliberately
 * excluded, since minimization must be free to merge records whose ref
 * targets are themselves later found equivalent under different names.
 *
 * Fields are sorted by label rather than kept in declaration order:
 * validation ignores field order (a `Record` is a *set* of labeled
 * fields), and OSD's printed field order is purely cosmetic. Two records
 * that declare the same fields in a different order accept exactly the
 * same documents and so MUST land in the same initial partition block --
 * keying by declaration order would incorrectly split them and could
 * prevent them from ever merging.
 */
export function localSignature(rec: OmnistRecord): LocalSignature {
  // Field labels are unique within a record (`record()` rejects
  // duplicates), so two entries never compare equal here.
  const fields = [...rec.fields].map(fieldSignature).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return ["record", fields];
}

/** Deterministic string encoding of a `LocalSignature`, suitable as a
 * `Map`/grouping key (structural values aren't usable as `Map` keys
 * directly in JS). */
export function localSignatureKey(rec: OmnistRecord): string {
  return JSON.stringify(localSignature(rec));
}
