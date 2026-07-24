/**
 * Schema isomorphism -- the paper's Algorithm 3, step 3. Ported from
 * `omnist/ops/isomorphic.py`.
 *
 * Theorem 4 (the paper): two schemas are equivalent iff their minimized
 * (normalized) forms are isomorphic. That gives a second,
 * algorithm-independent decision procedure for `equivalent` -- structurally
 * unrelated to bidirectional `compatibleWith` (`ops/subschema.ts`), so the
 * two can be cross-checked against each other in tests.
 *
 * `isomorphic` is intentionally **not** re-exported from `index.ts`: the
 * public API commits to `equivalent` (the cheaper, single algorithm)
 * staying the definition of schema equality. This module exists purely as
 * an independent oracle for property tests (issue #10).
 *
 * Algorithm: parallel traversal from both roots, building a bijection
 * `nameA -> nameB` (and its inverse) between env record names as the
 * traversal discovers pairs. At each visited record pair, `localSignature`
 * must match (same target-blind shape); since `localSignature` sorts
 * fields by label and ref/scalar shape is part of the key, fields on the
 * two sides line up one-to-one by label once the signatures agree. For
 * each ref-typed field, the two targets are recursively required to be
 * isomorphic, with the bijection enforced consistently in both
 * directions: if a name has already been mapped, revisiting it must reach
 * the same partner every time (and vice versa).
 *
 * Both inputs are assumed already normalized (pruned + minimized) by the
 * caller -- this module does not call `normalize` itself, matching the
 * paper's Algorithm 3, which runs isomorphism testing as a step *after*
 * MinimizeSA, not as a self-contained schema comparison.
 */

import type { Schema, Record as OmnistRecord } from "../schema.js";
import { isEmpty } from "./prune.js";
import { localSignature } from "./signature.js";

/**
 * True iff normalized schemas `a` and `b` are isomorphic: there is a
 * bijection between their env record names under which the two root
 * records (and everything reachable from them) match exactly.
 *
 * **Empty-schema convention.** If both `a` and `b` are unsatisfiable
 * (`isEmpty()` true for both), they're treated as isomorphic -- both
 * accept the empty language, and Theorem 4's equivalence claim
 * (`equivalent(a, b) === isomorphic(normalize(a), normalize(b))`) only
 * holds if this case says true, since two unsatisfiable schemas are
 * always `equivalent` (vacuously, both directions of `compatibleWith`
 * hold) regardless of how different their (necessarily
 * still-unpruned-at-the-root -- see `prune()`'s doc) record shapes look.
 * If exactly one is empty, they are *not* isomorphic: one accepts no
 * documents, the other accepts at least one, so they can't be equivalent
 * and must not be reported as isomorphic either.
 */
export function isomorphic(a: Schema, b: Schema): boolean {
  const emptyA = isEmpty(a);
  const emptyB = isEmpty(b);
  if (emptyA || emptyB) return emptyA && emptyB;

  const mapAb = new Map<string, string>();
  const mapBa = new Map<string, string>();
  return walk(a, a.root.name, b, b.root.name, mapAb, mapBa);
}

function walk(
  a: Schema,
  na: string,
  b: Schema,
  nb: string,
  mapAb: Map<string, string>,
  mapBa: Map<string, string>,
): boolean {
  if (mapAb.has(na) || mapBa.has(nb)) {
    // Already visited on at least one side: the bijection must agree both
    // ways, or the schemas aren't isomorphic.
    return mapAb.get(na) === nb && mapBa.get(nb) === na;
  }

  mapAb.set(na, nb);
  mapBa.set(nb, na);

  const ra = a.env.get(na) as OmnistRecord;
  const rb = b.env.get(nb) as OmnistRecord;
  if (JSON.stringify(localSignature(ra)) !== JSON.stringify(localSignature(rb))) return false;

  // localSignature sorts fields by label and includes the label in its
  // key, so two records with equal signatures declare exactly the same
  // set of labels -- fields on the two sides line up one-to-one by label.
  const fieldsB = new Map(rb.fields.map((f) => [f.label, f] as const));
  for (const fa of ra.fields) {
    const fb = fieldsB.get(fa.label);
    if (fa.type.tag === "ref" && fb?.type.tag === "ref") {
      if (!walk(a, fa.type.name, b, fb.type.name, mapAb, mapBa)) return false;
    }
  }
  return true;
}
