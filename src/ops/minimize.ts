/**
 * Schema minimization: partition-refinement to the canonical minimal form.
 * Ported from `omnist/ops/minimize.py`.
 *
 * Implements the paper's Algorithm 2 (MinimizeSA) -- the same family as DFA
 * minimization by partition refinement (Hopcroft/Moore-style state
 * merging). `normalize(s)` returns an equivalent schema with the *fewest
 * possible* env records, unique up to record naming.
 *
 * Algorithm:
 *
 * 1. `s = prune(s)` -- mandatory first step. Two semantically-equal
 *    records must not be kept apart by never-emittable fields or
 *    unreachable records; pruning first is what makes the partition
 *    canonical.
 * 2. **Initial partition**: env records grouped by `localSignature` -- a
 *    target-blind structural key, so records that might turn out
 *    equivalent via differently-named ref targets still start in the same
 *    block.
 * 3. **Refine**: split any block whose members disagree, for some label,
 *    on which *block* their same-labeled ref-typed field points to.
 *    Repeat until no block splits (a fixpoint -- always reached on a
 *    finite env). This is exactly DFA-minimization-style refinement: two
 *    states are equivalent iff every transition leads to equivalent
 *    states.
 * 4. **Merge**: collapse each stable block to a single representative --
 *    its lexicographically smallest member name (deterministic) -- and
 *    remap every ref and the root to representatives.
 *
 * Special case: an unsatisfiable (empty-language) root. `prune()`
 * deliberately leaves such a root's fields untouched, so partition
 * refinement over the unsatisfiable core isn't meaningful -- there's no
 * "fewest records" notion to compute when the schema accepts no finite
 * document at all. In that case `normalize` just returns the pruned schema
 * unchanged.
 */

import {
  Schema,
  ref,
  record as makeRecord,
  field as makeField,
  type FieldType,
  type Record as OmnistRecord,
} from "../schema.js";
import { isEmpty, prune } from "./prune.js";
import { localSignature, localSignatureKey } from "./signature.js";

function groupBy<T>(names: readonly string[], key: (n: string) => T): string[][] {
  const groups = new Map<string, string[]>();
  for (const n of names) {
    const k = JSON.stringify(key(n));
    const arr = groups.get(k);
    if (arr) {
      arr.push(n);
    } else {
      groups.set(k, [n]);
    }
  }
  return [...groups.values()];
}

function refineKey(rec: OmnistRecord, blockOf: ReadonlyMap<string, number>): unknown {
  // `blockOf.get(...)` is always defined for a ref field's target: every
  // name reachable via a field type is a key of `s.env` (a `Schema`
  // invariant enforced by its constructor), and `blockOf` is built, just
  // above, from every name in `s.env` -- so the ref branch never falls
  // through to `undefined`.
  const fields = [...rec.fields]
    .map((f) => [f.label, f.min, f.max, f.type.tag === "ref" ? (blockOf.get(f.type.name) as number) : null] as const)
    // Field labels are unique within a record (`record()` rejects
    // duplicates), so two entries here never compare equal -- the tie
    // branch below is unreachable and kept only for a total ordering.
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return [localSignature(rec), fields];
}

/**
 * Partitions `s.env`'s record names into structural-equivalence classes
 * via MinimizeSA-style partition refinement (module doc, steps 2-3): an
 * initial `localSignature` grouping refined to a fixpoint by which
 * *block* each same-labeled ref field points to.
 *
 * Operates on `s.env` exactly as given -- it does **not** prune first, so
 * unreachable or unsatisfiable records are still classified. `normalize`
 * calls this after its own `prune`/`isEmpty` steps; `lint` calls it on the
 * raw schema so structurally-identical records are reported as authored.
 * Each returned block is a list of names; a block of length > 1 is a set
 * of records with identical structure.
 */
export function equivalenceClasses(s: Schema): string[][] {
  const names = [...s.env.keys()].sort();
  let blockOf = new Map<string, number>();
  let blocks = groupBy(names, (n) => localSignatureKey(s.env.get(n) as OmnistRecord));
  blocks.forEach((block, i) => {
    for (const n of block) blockOf.set(n, i);
  });

  let changed = true;
  while (changed) {
    changed = false;
    const newBlocks: string[][] = [];
    const newBlockOf = new Map<string, number>();
    for (const block of blocks) {
      const subBlocks = groupBy(block, (n) => refineKey(s.env.get(n) as OmnistRecord, blockOf));
      for (const sub of subBlocks) {
        const idx = newBlocks.length;
        newBlocks.push(sub);
        for (const n of sub) newBlockOf.set(n, idx);
      }
    }
    if (newBlocks.length !== blocks.length) changed = true;
    blocks = newBlocks;
    blockOf = newBlockOf;
  }
  return blocks;
}

function remapType(type: FieldType, rep: ReadonlyMap<string, string>): FieldType {
  // `rep` has an entry for every name in `s.env` (built over `blocks`,
  // which partitions all of `s.env`'s names) -- a ref field's target is
  // always one of those names (the same `Schema` invariant as above), so
  // this lookup never falls through to the field's own (unmapped) name.
  if (type.tag === "ref") return ref(rep.get(type.name) as string);
  return type;
}

function remapRecord(rec: OmnistRecord, rep: ReadonlyMap<string, string>): OmnistRecord {
  return makeRecord(...rec.fields.map((f) => makeField(f.label, remapType(f.type, rep), f.min, f.max)));
}

/**
 * The canonical minimal schema equivalent to `s`: fewest env records,
 * unique up to record naming. See module doc for the algorithm (paper's
 * Algorithm 2, MinimizeSA).
 */
export function normalize(s: Schema): Schema {
  const pruned = prune(s);
  if (isEmpty(pruned)) return pruned;

  const names = [...pruned.env.keys()].sort();
  const blocks = equivalenceClasses(pruned);

  const rep = new Map<string, string>();
  for (const block of blocks) {
    const keep = [...block].sort()[0] as string;
    for (const n of block) rep.set(n, keep);
  }

  const newEnv = new Map<string, OmnistRecord>();
  for (const name of names) {
    if (rep.get(name) === name) {
      newEnv.set(name, remapRecord(pruned.env.get(name) as OmnistRecord, rep));
    }
  }
  // Same invariant as `remapType`: `pruned.root.name` is always a key of
  // `pruned.env` (the `Schema` constructor enforces the root ref is
  // valid), and `rep` covers every env name.
  const newRoot = ref(rep.get(pruned.root.name) as string);
  return new Schema(newRoot, newEnv);
}
