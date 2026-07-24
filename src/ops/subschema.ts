/**
 * Subschema compatibility and equivalence. Ported from
 * `omnist/ops/subschema.py`.
 *
 * Implements the paper's Algorithm 4 (SubschemaSA) restricted to omnist's
 * counting cardinality languages; `equivalent` is bidirectional inclusion.
 *
 * Algorithm 4 assumes its precondition MakeUsefulSA (useless-state
 * removal, `ops/prune.ts`) has already run: the coinductive cycle rule
 * below only coincides with true (finite-document) language inclusion
 * once every A-side record is known satisfiable. Rather than requiring
 * callers to pre-prune, `compatibleWith` computes `a`'s satisfiable set
 * once up front and the recursive helpers consult it directly -- an
 * unsatisfiable A-side record is vacuously a subschema of anything (it
 * emits no documents at all), and an optional A-field whose type is
 * unsatisfiable is skipped (it can never actually be emitted, so it
 * imposes no obligation on B). See `docs/design/model.md` §12, "Why
 * compatible_with needs this", for the full argument -- this is the one
 * subtle correctness trap: without the vacuous-truth short-circuit below,
 * a mandatory ref cycle on the A side would make the naive coinductive
 * rule wrongly report incompatibility (or loop forever assuming `false`)
 * instead of the correct vacuous `true`.
 */

import { Schema, type AnyFieldType, type Record as OmnistRecord, type ScalarType, recordField } from "../schema.js";
import { satisfiableSet } from "./prune.js";

type Resolved = OmnistRecord | ScalarType | AnyFieldType;

function typeKey(t: { tag: string; name?: string; scalarKind?: string; nullable?: boolean }): string {
  if (t.tag === "ref") return `ref:${t.name}`;
  if (t.tag === "any") return "any";
  return `scalar:${t.scalarKind}:${t.nullable}`;
}

/** True if every document `a` accepts is also accepted by `b` (`a` is a
 * subschema / `b` is backward-compatible). */
export function compatibleWith(a: Schema, b: Schema): boolean {
  const satA = satisfiableSet(a);
  const memo = new Map<string, boolean>();
  return sub(a, a.root, b, b.root, satA, memo);
}

/** True if both schemas accept exactly the same documents. */
export function equivalent(a: Schema, b: Schema): boolean {
  return compatibleWith(a, b) && compatibleWith(b, a);
}

function sub(
  sa: Schema,
  ta: { tag: string; name?: string },
  sb: Schema,
  tb: { tag: string; name?: string },
  satA: ReadonlySet<string>,
  memo: Map<string, boolean>,
): boolean {
  if (ta.tag === "ref" && ta.name !== undefined && !satA.has(ta.name)) {
    return true; // vacuous: an unsatisfiable A-side record
  }
  const da = sa.resolve(ta as Parameters<Schema["resolve"]>[0]) as Resolved;
  const db = sb.resolve(tb as Parameters<Schema["resolve"]>[0]) as Resolved;
  // Keyed on the *unresolved* field types (ref name, or scalar kind +
  // nullable, or "any") rather than the resolved value's identity: `sa`
  // and `sb` are fixed for the whole `compatibleWith` call, so this is
  // exactly as discriminating as Python's `(id(da), id(db))` -- two
  // distinct scalar kinds must never share a cache entry, which a
  // tag-only key would get wrong.
  const memoKey = `${typeKey(ta)}::${typeKey(tb)}`;
  if (memo.has(memoKey)) return memo.get(memoKey) as boolean;
  memo.set(memoKey, true); // coinductive assumption while descending

  let result: boolean;
  if ("tag" in db && db.tag === "any") {
    result = true; // any absorbs all -- db = any is always sound
  } else if ("tag" in da && da.tag === "any") {
    result = false; // only any holds any; da = any, db != any -> false
  } else if ("tag" in da && da.tag === "scalar" && "tag" in db && db.tag === "scalar") {
    result = scalarSub(da, db);
  } else if ("fields" in da && "fields" in db) {
    result = recordSub(sa, da, sb, db, satA, memo);
  } else {
    result = false; // a value vs an object -- never compatible
  }
  memo.set(memoKey, result);
  return result;
}

function scalarSub(a: ScalarType, b: ScalarType): boolean {
  if (a.nullable && !b.nullable) return false;
  if (a.scalarKind === b.scalarKind) return true;
  return a.scalarKind === "integer" && b.scalarKind === "number"; // the one subset relation
}

function recordSub(
  sa: Schema,
  a: OmnistRecord,
  sb: Schema,
  b: OmnistRecord,
  satA: ReadonlySet<string>,
  memo: Map<string, boolean>,
): boolean {
  // Every label A may emit must be allowed by B, with a cardinality range
  // B's covers and a type B accepts.
  for (const fa of a.fields) {
    if (fa.max === 0) continue; // A never emits this label
    if (fa.min === 0 && fa.type.tag === "ref" && !satA.has(fa.type.name)) continue; // A never actually emits this label either
    const fb = recordField(b, fa.label);
    if (fb === undefined) return false; // B is closed and has no such field
    if (!(fb.min <= fa.min && le(fa.max, fb.max))) return false; // [fa.min,fa.max] not a subset of B's range
    if (!sub(sa, fa.type, sb, fb.type, satA, memo)) return false;
  }
  // Every label B *requires* must be guaranteed by A.
  for (const fb of b.fields) {
    if (fb.min >= 1) {
      const faOpt = recordField(a, fb.label);
      if (faOpt === undefined || faOpt.min < fb.min) return false;
    }
  }
  return true;
}

/** x <= y, treating null as +infinity (unbounded max). */
function le(x: number | null, y: number | null): boolean {
  if (y === null) return true;
  if (x === null) return false;
  return x <= y;
}
