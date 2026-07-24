/**
 * Satisfiability analysis and schema pruning. Ported from
 * `omnist/ops/prune.py`.
 *
 * Implements the paper's "useless-state removal" (MakeUsefulSA) analog: a
 * record is *satisfiable* iff it admits at least one finite document, and
 * `prune` returns an equivalent schema with everything that can never
 * match removed. This is the precondition Algorithm 4 (SubschemaSA,
 * `ops/subschema.ts`) needs to be correct -- see `docs/design/model.md`
 * §12 for the full satisfiability subsection.
 *
 * Satisfiability is a least fixpoint over the env's records: a record is
 * satisfiable iff every field with `min >= 1` is either a `Scalar`/`any`
 * or a `Ref` to a satisfiable record. (Fields with `min === 0` never block
 * satisfiability -- they simply need not be emitted.) Scalars and `any`
 * are always satisfiable, so a record with no mandatory fields at all is
 * trivially satisfiable (the empty document for that record admits it).
 */

import { Schema, ref, record as makeRecord, field as makeField, type Field, type Record as OmnistRecord } from "../schema.js";

/**
 * The set of env record names that admit at least one finite document.
 *
 * Least fixpoint: start with nothing known-satisfiable and repeatedly add
 * any record all of whose mandatory (`min >= 1`) fields are already
 * satisfiable (a bare scalar/`any`, or a ref to an already-satisfiable
 * record). Monotonic on a finite env, so this always terminates.
 */
export function satisfiableSet(s: Schema): Set<string> {
  const sat = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, rec] of s.env) {
      if (sat.has(name)) continue;
      if (recordSatisfiable(rec, sat)) {
        sat.add(name);
        changed = true;
      }
    }
  }
  return sat;
}

function recordSatisfiable(rec: OmnistRecord, sat: ReadonlySet<string>): boolean {
  for (const f of rec.fields) {
    if (f.min < 1) continue; // optional -- never blocks satisfiability
    if (f.type.tag === "scalar" || f.type.tag === "any") continue;
    if (!sat.has(f.type.name)) return false;
  }
  return true;
}

/** True iff `s`'s root record is unsatisfiable -- the schema's language
 * (the set of documents it accepts) is empty. */
export function isEmpty(s: Schema): boolean {
  return !satisfiableSet(s).has(s.root.name);
}

/**
 * An equivalent schema with everything that can never match removed:
 *
 * - records unreachable from root (following refs) are dropped;
 * - fields with `max === 0` are dropped (never emittable);
 * - optional (`min === 0`) fields whose type is an unsatisfiable record
 *   are dropped (they could never actually be emitted either);
 * - records left unreachable/unsatisfiable after the above are dropped
 *   from the environment too.
 *
 * **Root-unsatisfiable case.** If the root record itself is unsatisfiable
 * (every finite document is rejected -- `isEmpty()` is true), field
 * pruning is *not* applied to the root: its mandatory fields are exactly
 * what make it unsatisfiable, and stripping them would silently produce a
 * *different*, satisfiable schema, contradicting "prune returns an
 * equivalent schema." Instead the root record is kept as-is and only the
 * rest of the environment is reduced to what's reachable from it (which,
 * being unsatisfiable, typically collapses to the cyclic core itself).
 */
export function prune(s: Schema): Schema {
  const sat = satisfiableSet(s);
  const rootOk = sat.has(s.root.name);

  const reachable = reachableForPrune(s, sat, rootOk);

  const newEnv = new Map<string, OmnistRecord>();
  for (const name of reachable) {
    // `reachable` only ever gains a name after confirming `s.env.has(name)`
    // (see `reachableForPrune`), and `s.env` doesn't change during the
    // walk, so this lookup always succeeds.
    const rec = s.env.get(name) as OmnistRecord;
    if (!rootOk && name === s.root.name) {
      newEnv.set(name, rec); // keep the unsatisfiable root intact
    } else {
      newEnv.set(name, pruneRecord(rec, sat));
    }
  }
  return new Schema(ref(s.root.name), newEnv);
}

function reachableForPrune(s: Schema, sat: ReadonlySet<string>, rootOk: boolean): Set<string> {
  const seen = new Set<string>();
  const stack = [s.root.name];
  while (stack.length > 0) {
    const name = stack.pop() as string;
    if (seen.has(name) || !s.env.has(name)) continue;
    seen.add(name);
    const rec = s.env.get(name) as OmnistRecord;
    const isUnprunedRoot = name === s.root.name && !rootOk;
    for (const f of rec.fields) {
      if (!isUnprunedRoot) {
        if (f.max === 0) continue;
        if (f.min === 0 && f.type.tag === "ref" && !sat.has(f.type.name)) continue;
      }
      if (f.type.tag === "ref") stack.push(f.type.name);
    }
  }
  return seen;
}

function pruneRecord(rec: OmnistRecord, sat: ReadonlySet<string>): OmnistRecord {
  const kept: Field[] = [];
  for (const f of rec.fields) {
    if (f.max === 0) continue;
    if (f.min === 0 && f.type.tag === "ref" && !sat.has(f.type.name)) continue;
    kept.push(makeField(f.label, f.type, f.min, f.max));
  }
  return makeRecord(...kept);
}
