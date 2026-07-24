/**
 * Subschema extraction (paper Algorithm 5, ExtractSubschema). Ported from
 * `omnist/ops/extract.py`.
 *
 * Given a schema and a set of *permissible labels* `keep` (the paper's
 * `X'`), produces the minimal subschema that recognizes only documents
 * built from those labels -- the headline application in the paper is
 * trimming a large shared schema down to just what a single document type
 * needs.
 *
 * Algorithm:
 *
 * 1. For every record in the env, delete any field whose label is not in
 *    `keep`.
 * 2. If a deleted field had `min >= 1` (mandatory), that record is
 *    *invalidated* -- the paper's "state removed": there is no way to
 *    build a document at that record's shape without a label that's no
 *    longer available, so the record itself can no longer be produced.
 * 3. **Propagate.** A record with a *mandatory* field whose type is an
 *    invalidated record is itself invalidated (that field can never be
 *    filled), and so on transitively -- a least-fixpoint closure, same
 *    shape as `ops/prune.ts`'s satisfiability fixpoint.
 * 4. If the root ends up invalidated, there is no valid subschema for
 *    this `keep` set at all: `extract` throws `SchemaError` naming the
 *    first offending label and record, so the failure is actionable.
 * 5. Otherwise, invalidated records (and fields typed to them, along with
 *    any fields already dropped in step 1) are gone; the result is run
 *    through `prune` and `normalize` (Algorithm 5's own final MakeUseful +
 *    Minimize step) to land in the same canonical minimal form
 *    `normalize()` produces elsewhere.
 *
 * **Design decision: mandatory deletion is an error, not
 * silently-optional.** An alternative design could relax a deleted
 * mandatory field to optional instead of invalidating its record. This
 * implementation deliberately does not do that: silently loosening
 * cardinality would mean `extract`'s result no longer reflects the
 * paper's Algorithm 5 semantics (which reports "no valid subschema"
 * rather than inventing a weaker one), and it would hide a likely mistake
 * -- asking to keep a leaf label without any of the mandatory structure
 * that leads to it is far more often a bug in the caller's `keep` set
 * than an intentional relaxation. Callers who do want the relaxed
 * behavior can trivially get it by editing field cardinalities before
 * calling `extract`.
 */

import { SchemaError } from "../errors.js";
import { Schema, ref, record as makeRecord, type Field, type Record as OmnistRecord } from "../schema.js";
import { normalize } from "./minimize.js";
import { prune } from "./prune.js";

/** The minimal subschema of `s` that only recognizes documents built from
 * labels in `keep`. Throws `SchemaError` if deleting the other labels
 * would invalidate the root record (see module doc). */
export function extract(s: Schema, keep: Iterable<string>): Schema {
  const keepSet = new Set(keep);

  // Step 1+2: per-record field deletion, tracking which records are
  // directly invalidated by the loss of a mandatory field, and the first
  // offending (label, record) pair for the error message.
  const trimmed = new Map<string, OmnistRecord>();
  const invalidated = new Set<string>();
  let firstOffender: readonly [string, string] | undefined;

  for (const [name, rec] of s.env) {
    const keptFields: Field[] = [];
    for (const f of rec.fields) {
      if (keepSet.has(f.label)) {
        keptFields.push(f);
      } else if (f.min >= 1) {
        if (!invalidated.has(name) && firstOffender === undefined) {
          firstOffender = [f.label, name];
        }
        invalidated.add(name);
      }
    }
    trimmed.set(name, makeRecord(...keptFields));
  }

  // Step 3: propagate invalidation -- a record with a mandatory field
  // typed to an invalidated record is itself invalidated. Least fixpoint,
  // same shape as prune.ts's satisfiableSet.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, rec] of trimmed) {
      if (invalidated.has(name)) continue;
      for (const f of rec.fields) {
        if (f.min >= 1 && f.type.tag === "ref" && invalidated.has(f.type.name)) {
          // firstOffender is always already set here: this branch can
          // only run once `invalidated` is non-empty, and it's only ever
          // seeded by step 1, which sets firstOffender itself before
          // propagation ever begins.
          invalidated.add(name);
          changed = true;
          break;
        }
      }
    }
  }

  // Step 4: root invalidated -> no valid subschema.
  if (invalidated.has(s.root.name)) {
    /* v8 ignore start -- seeded by step 1 before any propagation; kept as
     * a defensive guard, structural parity with the Python assert. */
    if (firstOffender === undefined) {
      throw new SchemaError("no valid subschema: root invalidated with no recorded offender");
    }
    /* v8 ignore stop */
    const [label, recordName] = firstOffender;
    throw new SchemaError(
      `no valid subschema: removing label ${JSON.stringify(label)} deletes a mandatory field of record ${JSON.stringify(recordName)}`,
    );
  }

  // Step 5: drop invalidated records and any fields (mandatory or not)
  // that still point at one -- an optional field typed to an invalidated
  // record can never be satisfied either, so prune() will remove it, but
  // we drop it here too so the intermediate Schema stays ref-consistent
  // (env values must all be reachable/defined; an invalidated record is
  // about to disappear from the env entirely).
  const newEnv = new Map<string, OmnistRecord>();
  for (const [name, rec] of trimmed) {
    if (invalidated.has(name)) continue;
    const fields = rec.fields.filter((f) => !(f.type.tag === "ref" && invalidated.has(f.type.name)));
    newEnv.set(name, makeRecord(...fields));
  }

  const result = new Schema(ref(s.root.name), newEnv);
  return normalize(prune(result));
}
