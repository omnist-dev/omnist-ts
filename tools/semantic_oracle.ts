#!/usr/bin/env node
/**
 * Brute-force semantic oracle for the schema algebra (issue #10, ported
 * from upstream `tools/semantic_oracle.py`, itself issue #158/PR-4 of the
 * #154 review's execution plan).
 *
 * Checks every schema-algebra operation against **set-theoretic ground
 * truth** -- the actual language `L(s) = { d in U : s.validate(d).ok }` of
 * a schema `s` over a finite, enumerated universe `U` of documents --
 * rather than against another algorithm. This is a *third*, independent
 * check: `compatibleWith` (`src/ops/subschema.ts`) and the
 * minimize+isomorphism Theorem-4 oracle (`src/ops/isomorphic.ts`,
 * cross-checked in `test/ops/minimize.test.ts`) are two algorithms that
 * could both share the same conceptual bug; brute-force enumeration
 * against `validate()` itself cannot, since `validate()` is the ground
 * truth definition of a schema's language in the first place.
 *
 * Usage:
 *
 *     npx tsx tools/semantic_oracle.ts
 *     npm run oracle
 *
 * Exits 1 (and prints every definite bug found) if any check fails in a
 * way that proves a real algebra bug; exits 0 otherwise, having printed
 * the summary counts (universe size, schema count, pairs checked,
 * vindication breakdown, extract cases).
 *
 * **Universe-sizing note**, same reasoning as upstream: this is a fresh,
 * independently-derived construction from the same description (root
 * edge-lists over labels `{a, b}`, leaves `{1, "x", null}`, children leaf
 * or depth-1, extended shapes witnessing cardinality up to 4), not a
 * byte-for-byte port of the Python file's exact counts.
 */

import { Doc, type Edge, type Node, type Scalar } from "../src/document.js";
import { SchemaError } from "../src/errors.js";
import { compatibleWith } from "../src/ops/subschema.js";
import { extract } from "../src/ops/extract.js";
import { isEmpty, prune } from "../src/ops/prune.js";
import { normalize } from "../src/ops/minimize.js";
import {
  ANY,
  Schema,
  field,
  ref,
  record,
  t,
  type Field,
  type FieldType,
} from "../src/schema.js";

// ---------------------------------------------------------------------------
// 1. Universe construction
// ---------------------------------------------------------------------------

const LEAVES: readonly Scalar[] = [1, "x", null];
const LABELS: readonly string[] = ["a", "b"];

// Sec.5.3a / I-22 universe guarantee (see upstream's identical comment):
// a fixed, O(1) set of single-edge root documents, one per label, so every
// scalar kind is guaranteed present in the base universe regardless of
// base_max/extended_max sizing -- widening LEAVES itself would blow up the
// combinatorial universe size for no benefit.
const SCALAR_WITNESS_LEAVES: readonly Scalar[] = [
  false, // boolean -- not `true`, which would collide with the integer witness `1`
  1.5, // number -- a float, distinct from the integer witness `1`
  new Date("2000-01-01T00:00:00.000Z"), // date-ish witness
  "00:00:00", // time (Document layer represents `time` as a plain string)
  new Date("2000-01-01T00:00:00.000Z"), // datetime-ish witness (see note below)
];

// The Document layer (src/document.ts) maps both `date` and `datetime`
// Schema scalar kinds onto the single native `Date` type -- unlike Python,
// which has distinct `datetime.date`/`datetime.datetime` classes. So a
// "date" witness and a "datetime" witness can't be structurally
// distinguished by kind at the Document layer alone; `ALL_SCALAR_KIND_LEAVES`
// below still lists 7 kind labels (matching the schema's own SCALAR_KINDS),
// but the date/datetime witness values are intentionally the same shape --
// see `matchesKind` in `src/schema.ts` for how the Schema layer tells them
// apart via `dateKind()` tagging on schema-directed parses, which this raw
// witness construction does not go through.
const ALL_SCALAR_KIND_LEAVES: readonly Scalar[] = [1, "x", ...SCALAR_WITNESS_LEAVES];

function toDoc(node: Node): Doc {
  return new Doc(node);
}

function edgeRuns(childPool: readonly Node[], maxCount: number): Node[][] {
  const runs: Node[][] = [];
  const rec = (count: number, acc: Node[]): void => {
    if (count === 0) {
      runs.push([...acc]);
      return;
    }
    for (const c of childPool) {
      acc.push(c);
      rec(count - 1, acc);
      acc.pop();
    }
  };
  for (let c = 0; c <= maxCount; c++) rec(c, []);
  return runs;
}

function labelPairShapes(childPool: readonly Node[], maxCount: number): Node[] {
  const runs = edgeRuns(childPool, maxCount);
  const shapes: Node[] = [];
  for (const aRun of runs) {
    for (const bRun of runs) {
      const edges: Edge[] = [
        ...aRun.map((v): Edge => ({ label: "a", target: v })),
        ...bRun.map((v): Edge => ({ label: "b", target: v })),
      ];
      shapes.push(edges);
    }
  }
  return shapes;
}

function canonicalKey(node: Node): string {
  if (Array.isArray(node)) {
    return "[" + node.map((e) => JSON.stringify(e.label) + ":" + canonicalKey(e.target)).join(",") + "]";
  }
  if (node instanceof Date) return "D" + node.toISOString();
  return JSON.stringify(node);
}

function dedupe(nodes: readonly Node[]): Node[] {
  const seen = new Map<string, Node>();
  for (const n of nodes) {
    const k = canonicalKey(n);
    if (!seen.has(k)) seen.set(k, n);
  }
  return [...seen.values()];
}

/**
 * Build `(base, extended)` document universes.
 *
 * - **Base**: root edge-lists over `{a, b}`, `0..baseMax` edges per label;
 *   each edge's child is either a leaf or a depth-1 edge list (itself over
 *   `{a, b}`, leaf-valued, at most one edge total).
 * - **Extended**: base, plus (a) roots with `extendedMax`-count edges under
 *   a single label, and (b) 1-edge roots whose single child is itself a
 *   nested list with `extendedMax`-count edges.
 */
function buildUniverse(
  baseMax = 2,
  extendedMax: readonly number[] = [3, 4],
): { base: Node[]; extended: Node[] } {
  const depth1 = labelPairShapes(LEAVES, baseMax).filter((s) => (s as Edge[]).length <= 1);
  const childPool: readonly Node[] = [...LEAVES, ...depth1];
  const base = labelPairShapes(childPool, baseMax);

  const extra: Node[] = [];
  for (const lbl of LABELS) {
    for (const count of extendedMax) {
      for (const combo of cartesianProduct(LEAVES, count)) {
        extra.push(combo.map((v): Edge => ({ label: lbl, target: v })));
      }
    }
  }
  const nested: Node[] = [];
  for (const lbl2 of LABELS) {
    for (const count of extendedMax) {
      for (const combo of cartesianProduct(LEAVES, count)) {
        nested.push(combo.map((v): Edge => ({ label: lbl2, target: v })));
      }
    }
  }
  for (const lbl of LABELS) {
    for (const n of nested) {
      extra.push([{ label: lbl, target: n }]);
    }
  }

  const scalarWitnesses: Node[] = [];
  for (const lbl of LABELS) {
    for (const v of SCALAR_WITNESS_LEAVES) {
      scalarWitnesses.push([{ label: lbl, target: v }]);
    }
  }

  const baseFull = dedupe([...base, ...scalarWitnesses]);
  const baseKeys = new Set(baseFull.map(canonicalKey));
  const extended = dedupe([...baseFull, ...extra.filter((n) => !baseKeys.has(canonicalKey(n)))]);
  return { base: baseFull, extended };
}

function cartesianProduct(pool: readonly Scalar[], count: number): Scalar[][] {
  if (count === 0) return [[]];
  const rest = cartesianProduct(pool, count - 1);
  const out: Scalar[][] = [];
  for (const v of pool) {
    for (const r of rest) out.push([v, ...r]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. Schema family: systematic + structural + nullable + seeded-random
// ---------------------------------------------------------------------------

const SCALARS = [t.string, t.integer, t.number, t.boolean, t.date, t.time, t.datetime] as const;
const CARDS: ReadonlyArray<[number, number | null]> = [
  [1, 1],
  [0, 1],
  [0, 2],
  [1, null],
  [0, 0],
  [2, 2],
];
const ANY_FIELD_PROB = 1 / 6;

function nullableOf(kind: FieldType): FieldType {
  // Defensive: this module only ever calls nullableOf() with a member of
  // SCALARS (see seededRandomFamily/nullableFamily), never a Ref or
  // AnyFieldType; kept for structural parity with a general-purpose
  // helper rather than narrowing the parameter type.
  /* v8 ignore next */
  if (kind.tag !== "scalar") return kind;
  return { ...kind, nullable: true };
}

function systematicFamily(): Schema[] {
  const out: Schema[] = [];
  for (const sc of SCALARS) {
    for (const [mn, mx] of CARDS) {
      out.push(new Schema(ref("R"), { R: record(field("a", sc, mn, mx)) }));
    }
  }
  return out;
}

function structuralFamily(): Schema[] {
  const emptyRecord = new Schema(ref("R"), { R: record() });
  const mandatoryCycle = new Schema(ref("R"), { R: record(field("self", ref("R"), 1, 1)) });
  const optionalSelfRecursion = new Schema(ref("R"), {
    R: record(field("child", ref("R"), 0, null), field("v", t.integer, 0, 1)),
  });
  return [emptyRecord, mandatoryCycle, optionalSelfRecursion];
}

function nullableFamily(): Schema[] {
  const out: Schema[] = [];
  for (const sc of SCALARS) {
    out.push(new Schema(ref("R"), { R: record(field("a", sc, 1, 1)) }));
    out.push(new Schema(ref("R"), { R: record(field("a", nullableOf(sc), 1, 1)) }));
  }
  return out;
}

/** A small deterministic LCG PRNG (no new runtime dependency, fully
 * reproducible across runs -- same role as Python's seeded `random.Random`,
 * a different but equally deterministic sequence). */
class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    // xorshift32 -- small, fast, deterministic.
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state / 0xffffffff;
  }
  int(minInclusive: number, maxInclusive: number): number {
    return minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1));
  }
  choice<T>(arr: readonly T[]): T {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return arr[this.int(0, arr.length - 1)]!;
  }
}

function seededRandomFamily(seed: number, count: number): Schema[] {
  const rng = new Rng(seed);
  const out: Schema[] = [];
  const labels = ["p", "q", "r"];
  for (let i = 0; i < count; i++) {
    const nFieldsA = rng.int(1, 3);
    const fieldsA: Field[] = [];
    const usedA = new Set<string>();
    let hasRef = false;
    for (let k = 0; k < nFieldsA; k++) {
      const lbl = rng.choice(labels);
      if (usedA.has(lbl)) continue;
      usedA.add(lbl);
      const [mn, mx] = rng.choice(CARDS);
      if (!hasRef && rng.next() < 0.5) {
        fieldsA.push(field(lbl, ref("B"), mn, mx));
        hasRef = true;
      } else if (rng.next() < ANY_FIELD_PROB) {
        fieldsA.push(field(lbl, ANY, mn, mx));
      } else {
        let sc: FieldType = rng.choice(SCALARS);
        if (rng.next() < 0.3) sc = nullableOf(sc);
        fieldsA.push(field(lbl, sc, mn, mx));
      }
    }
    // Defensive fallback that is actually unreachable: nFieldsA =
    // rng.int(1, 3) is always >= 1, and the loop's *first* iteration can
    // never hit the `usedA.has(lbl)` skip (usedA starts empty), so at
    // least one field is always appended. Kept as a guard in case the
    // loop bounds above ever change (mirrors upstream Python's identical
    // `# pragma: no cover` comment on this branch).
    /* v8 ignore next */
    if (fieldsA.length === 0) fieldsA.push(field("p", t.string, 0, 1));

    const nFieldsB = rng.int(1, 2);
    const fieldsB: Field[] = [];
    const usedB = new Set<string>();
    for (let k = 0; k < nFieldsB; k++) {
      const lbl = rng.choice(labels);
      if (usedB.has(lbl)) continue;
      usedB.add(lbl);
      const [mn, mx] = rng.choice(CARDS);
      if (rng.next() < ANY_FIELD_PROB) {
        fieldsB.push(field(lbl, ANY, mn, mx));
      } else {
        fieldsB.push(field(lbl, rng.choice(SCALARS), mn, mx));
      }
    }
    // Same reasoning as the fieldsA fallback above.
    /* v8 ignore next */
    if (fieldsB.length === 0) fieldsB.push(field("q", t.integer, 0, 1));

    out.push(new Schema(ref("A"), { A: record(...fieldsA), B: record(...fieldsB) }));
  }
  return out;
}

function schemaFamily(randomCount = 82, seed = 158): Schema[] {
  return [...systematicFamily(), ...structuralFamily(), ...nullableFamily(), ...seededRandomFamily(seed, randomCount)];
}

// ---------------------------------------------------------------------------
// 3. Ground truth: L(s) over a universe, as a Set<number> of doc indices
// ---------------------------------------------------------------------------

function groundTruth(schemas: readonly Schema[], docs: readonly Doc[]): Set<number>[] {
  return schemas.map((s) => {
    const accepted = new Set<number>();
    docs.forEach((d, i) => {
      if (s.validate(d).ok) accepted.add(i);
    });
    return accepted;
  });
}

function isSubset<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// 4. Targeted minimal witness construction (for vindicating False answers)
// ---------------------------------------------------------------------------

const MINIMAL_LEAF: Record<string, Scalar> = {
  string: "x",
  integer: 1,
  number: 1.5,
  boolean: true,
  date: new Date("2000-01-01T00:00:00.000Z"),
  time: "00:00:00",
  datetime: new Date("2000-01-01T00:00:00.000Z"),
};

function minimalValue(schema: Schema, ty: FieldType, depth: number, building: ReadonlySet<string>): Node {
  if (ty.tag === "any") return null;
  // Defensive: MINIMAL_LEAF has an entry for all seven ScalarKind values
  // (see its literal above), so the `?? null` fallback can never actually
  // fire; kept in case a new scalar kind is ever added to schema.ts's
  // SCALAR_KINDS without this map being updated in step.
  /* v8 ignore next */
  if (ty.tag === "scalar") return MINIMAL_LEAF[ty.scalarKind] ?? null;
  if (building.has(ty.name) || depth > 50) return []; // cycle guard
  const rec = schema.env.get(ty.name);
  // Defensive: Schema's constructor (checkRefs) already validates every
  // Ref against `env` at construction time, so a `ty` reaching this point
  // has necessarily already resolved once; kept as a guard against a
  // hypothetical future caller that builds a Schema bypassing that check.
  /* v8 ignore next */
  if (rec === undefined) return [];
  const edges: Edge[] = [];
  for (const f of rec.fields) {
    if (f.min < 1) continue;
    const v = minimalValue(schema, f.type, depth + 1, new Set([...building, ty.name]));
    for (let i = 0; i < f.min; i++) edges.push({ label: f.label, target: v });
  }
  return edges;
}

function minimalWitness(schema: Schema): Node {
  const node = minimalValue(schema, schema.root, 0, new Set());
  // Defensive: schema.root is always a RefType (Schema's constructor
  // requires it), so minimalValue's root call always returns an edge
  // list, never a bare scalar/null; the `: []` arm is unreachable via the
  // public surface.
  /* v8 ignore next */
  return Array.isArray(node) ? node : [];
}

function targetedWitnesses(schema: Schema): Node[] {
  const base = minimalWitness(schema) as Edge[];
  const rootRec = schema.env.get(schema.root.name);
  const out: Node[] = [base];
  // Defensive: same guarantee as minimalValue's `rec` lookup above --
  // Schema's constructor already validates schema.root resolves in
  // schema.env at construction time.
  /* v8 ignore next */
  if (rootRec === undefined) return out;
  for (const f of rootRec.fields) {
    const v = minimalValue(schema, f.type, 1, new Set([schema.root.name]));
    const rest = base.filter((e) => e.label !== f.label);
    const counts = new Set<number>([Math.max(f.min, 1), Math.max(f.min, 1) + 1]);
    if (f.max !== null) {
      counts.add(f.max);
      counts.add(f.max + 1);
    } else {
      counts.add(3);
      counts.add(4);
      counts.add(5);
    }
    const values: Node[] = [v];
    if (f.type.tag === "any") {
      values.push(...ALL_SCALAR_KIND_LEAVES);
      values.push([{ label: "z", target: 1 }]);
    }
    for (const val of values) {
      for (const n of [...counts].filter((c) => c >= 0).sort((a, b) => a - b)) {
        const edges: Edge[] = [...rest];
        for (let i = 0; i < n; i++) edges.push({ label: f.label, target: val });
        out.push(edges);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 5. The five checks
// ---------------------------------------------------------------------------

export class OracleResult {
  definiteBugs: string[] = [];
  needsReview: string[] = [];
  counts: Record<string, number> = {};
}

function checkCompatibleWith(
  schemas: readonly Schema[],
  truth: readonly Set<number>[],
  extDocs: readonly Doc[],
  extTruth: readonly Set<number>[],
  result: OracleResult,
): void {
  const n = schemas.length;
  let checkedPairs = 0;
  let falseTotal = 0;
  let vindicatedByBaseSubset = 0;
  let vindicatedByExtended = 0;
  let vindicatedByWitness = 0;
  let needsReviewPairs = 0;

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      checkedPairs++;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const a = schemas[i]!;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const b = schemas[j]!;
      const answer = compatibleWith(a, b);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const la = truth[i]!;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const lb = truth[j]!;
      if (answer) {
        if (!isSubset(la, lb)) {
          const bad = [...la].filter((x) => !lb.has(x)).sort((x, y) => x - y)[0];
          result.definiteBugs.push(
            `compatibleWith(schema[${i}], schema[${j}]) says true but L(a) is not subset of L(b): base-universe doc index [${bad}] is accepted by a, rejected by b`,
          );
        }
        continue;
      }
      falseTotal++;
      if (!isSubset(la, lb)) {
        vindicatedByBaseSubset++;
        continue;
      }
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const ela = extTruth[i]!;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const elb = extTruth[j]!;
      if (!isSubset(ela, elb)) {
        vindicatedByExtended++;
        continue;
      }
      let found = false;
      for (const witness of targetedWitnesses(a)) {
        const wd = toDoc(witness);
        const wa = a.validate(wd).ok;
        const wb = b.validate(wd).ok;
        if (wa && !wb) {
          vindicatedByWitness++;
          found = true;
          break;
        }
      }
      if (!found) {
        needsReviewPairs++;
        result.needsReview.push(
          `compatibleWith(schema[${i}], schema[${j}]) says false; no witness found in base/extended universes or any targeted witness -- needs manual review, not treated as a failure`,
        );
      }
    }
  }

  result.counts.pairs_checked = checkedPairs;
  result.counts.false_answers = falseTotal;
  result.counts.vindicated_by_base_subset = vindicatedByBaseSubset;
  result.counts.vindicated_by_extended = vindicatedByExtended;
  result.counts.vindicated_by_witness = vindicatedByWitness;
  result.counts.needs_review_pairs = needsReviewPairs;
  void extDocs;
}

function checkIsEmpty(schemas: readonly Schema[], truth: readonly Set<number>[], result: OracleResult): void {
  let checked = 0;
  schemas.forEach((s, i) => {
    checked++;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const la = truth[i]!;
    if (isEmpty(s) && la.size > 0) {
      const first = [...la].sort((a, b) => a - b)[0];
      result.definiteBugs.push(`isEmpty(schema[${i}]) says true but L(s) is non-empty over the base universe (doc index [${first}])`);
    }
  });
  result.counts.is_empty_checked = checked;
}

function checkNormalizePrunePreserveLanguage(
  schemas: readonly Schema[],
  truth: readonly Set<number>[],
  docs: readonly Doc[],
  result: OracleResult,
): void {
  let checked = 0;
  schemas.forEach((s, i) => {
    checked++;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const la = truth[i]!;
    for (const [name, op] of [
      ["normalize", normalize],
      ["prune", prune],
    ] as const) {
      const s2 = op(s);
      const l2 = new Set<number>();
      docs.forEach((d, k) => {
        if (s2.validate(d).ok) l2.add(k);
      });
      const same = l2.size === la.size && isSubset(l2, la) && isSubset(la, l2);
      if (!same) {
        const extra = [...l2].filter((x) => !la.has(x)).sort((a, b) => a - b)[0];
        const missing = [...la].filter((x) => !l2.has(x)).sort((a, b) => a - b)[0];
        result.definiteBugs.push(
          `${name}(schema[${i}]) changes the language over the base universe: extra=[${extra ?? ""}] missing=[${missing ?? ""}]`,
        );
      }
    }
  });
  result.counts.normalize_prune_checked = checked;
}

const EXTRACT_LABEL_SETS: ReadonlySet<string>[] = [
  new Set([]),
  new Set(["a"]),
  new Set(["b"]),
  new Set(["a", "b"]),
  new Set(["p"]),
  new Set(["q"]),
  new Set(["p", "q"]),
  new Set(["p", "q", "r"]),
];

function checkExtract(
  schemas: readonly Schema[],
  docs: readonly Doc[],
  truth: readonly Set<number>[],
  docLabels: readonly ReadonlySet<string>[],
  result: OracleResult,
): void {
  let checked = 0;
  let skipped = 0;
  schemas.forEach((s, i) => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const la = truth[i]!;
    for (const keep of EXTRACT_LABEL_SETS) {
      let extracted: Schema;
      try {
        extracted = extract(s, keep);
      } catch (e) {
        // Defensive: extract() only ever throws SchemaError (see
        // src/ops/extract.ts's own contract); a different exception here
        // would itself be a library bug this oracle isn't designed to
        // characterize, not a normal "no valid subschema" outcome. Kept
        // as a guard rather than swallowed, matching this codebase's
        // convention for documented-dormant defensive code.
        /* v8 ignore next */
        if (!(e instanceof SchemaError)) throw e;
        skipped++;
        continue;
      }
      checked++;
      for (let k = 0; k < docs.length; k++) {
        const expected = la.has(k) && isSubset(docLabels[k] as ReadonlySet<string>, keep);
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const actual = extracted.validate(docs[k]!).ok;
        if (expected !== actual) {
          result.definiteBugs.push(
            `extract(schema[${i}], [${[...keep].sort().join(",")}]) disagrees with ground truth on base-universe doc index ${k}: expected=${expected} actual=${actual}`,
          );
          break;
        }
      }
    }
  });
  result.counts.extract_cases_checked = checked;
  result.counts.extract_cases_skipped = skipped;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export interface RunOptions {
  randomCount?: number;
  verbose?: boolean;
  universeBuilder?: (baseMax?: number, extendedMax?: readonly number[]) => { base: Node[]; extended: Node[] };
  /** Test-only injection point: runs after the four real checks, given a
   * chance to mutate `result` (e.g. append a fabricated bug) before the
   * summary is printed -- isolates the bug-listing print loop below
   * without needing a real algebra bug to exist. Unused by `main()`. */
  afterChecks?: (result: OracleResult) => void;
}

export function run(opts: RunOptions = {}): OracleResult {
  const { randomCount = 96, verbose = true, universeBuilder = buildUniverse, afterChecks } = opts;
  const t0 = Date.now();
  const { base: baseNodes, extended: extNodes } = universeBuilder();
  const baseDocs = baseNodes.map(toDoc);
  const extDocs = extNodes.map(toDoc);
  if (verbose) {
    console.log(`universe: base=${baseDocs.length} docs, extended=${extDocs.length} docs (${((Date.now() - t0) / 1000).toFixed(2)}s)`);
  }

  const t1 = Date.now();
  const schemas = schemaFamily(randomCount);
  if (verbose) console.log(`schema family: ${schemas.length} schemas (${((Date.now() - t1) / 1000).toFixed(2)}s)`);

  const t2 = Date.now();
  const truth = groundTruth(schemas, baseDocs);
  const extTruth = groundTruth(schemas, extDocs);
  if (verbose) console.log(`ground truth computed over base+extended universes (${((Date.now() - t2) / 1000).toFixed(2)}s)`);

  // Defensive: buildUniverse's base documents are always root edge-lists
  // (labelPairShapes never emits a bare scalar root), so `d.isLeaf` is
  // always false here; the `new Set<string>()` arm is unreachable for any
  // universe this module constructs, kept only for structural parity with
  // the same ternary in test/semantic-oracle.test.ts's runBounded() and
  // checkExtract's own doc-label convention.
  /* v8 ignore next */
  const docLabels: ReadonlySet<string>[] = baseDocs.map((d) => (d.isLeaf ? new Set<string>() : new Set(d.edges().map(([lbl]) => lbl))));

  const result = new OracleResult();
  const t3 = Date.now();
  checkCompatibleWith(schemas, truth, extDocs, extTruth, result);
  checkIsEmpty(schemas, truth, result);
  checkNormalizePrunePreserveLanguage(schemas, truth, baseDocs, result);
  checkExtract(schemas, baseDocs, truth, docLabels, result);
  afterChecks?.(result);
  if (verbose) {
    console.log(`checks run (${((Date.now() - t3) / 1000).toFixed(2)}s)`);
    console.log(`total wall time: ${((Date.now() - t0) / 1000).toFixed(2)}s`);
  }

  if (verbose) {
    console.log();
    console.log("=== Summary ===");
    console.log(`documents: base=${baseDocs.length}, extended=${extDocs.length}`);
    console.log(`schemas: ${schemas.length}`);
    for (const [k, v] of Object.entries(result.counts)) console.log(`  ${k}: ${v}`);
    console.log(`needs-manual-review pairs: ${result.needsReview.length} (not a failure -- bounded-universe artifact, per issue #10)`);
    console.log(`DEFINITE BUGS: ${result.definiteBugs.length}`);
    for (const msg of result.definiteBugs.slice(0, 20)) console.log(`  BUG: ${msg}`);
  }

  return result;
}

/** `runFn` is a test-only injection point (defaults to the real `run`) so
 * `main`'s PASSED/FAILED branches can both be exercised without paying for
 * a real full-size run in the normal test suite. */
export function main(runFn: (opts?: RunOptions) => OracleResult = run): number {
  const result = runFn({ verbose: true });
  if (result.definiteBugs.length > 0) {
    console.log(`\nFAILED: ${result.definiteBugs.length} definite bug(s) found.`);
    return 1;
  }
  console.log("\nPASSED: zero definite bugs.");
  return 0;
}

// Exported for the bounded CI test (test/semantic-oracle.test.ts).
export {
  ALL_SCALAR_KIND_LEAVES,
  buildUniverse,
  checkCompatibleWith,
  checkExtract,
  checkIsEmpty,
  checkNormalizePrunePreserveLanguage,
  groundTruth,
  schemaFamily,
  seededRandomFamily,
  toDoc,
  targetedWitnesses,
  minimalWitness,
};

// Only run when invoked directly (`npx tsx tools/semantic_oracle.ts`), not
// on import from the test suite -- mirrors upstream's `if __name__ ==
// "__main__"` guard. `import.meta.url` vs `process.argv[1]` is the
// idiomatic ESM equivalent.
const isMain = (): boolean => {
  try {
     
    return process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
  /* v8 ignore start -- defensive: process.argv/import.meta.url access has no
   * realistic failure mode in a Node ESM context; kept as a guard against a
   * future runtime where either could throw, matching this codebase's
   * convention (see e.g. src/document.ts's checkIntDigits) of keeping a
   * documented-dormant defensive branch rather than deleting it. */
  } catch {
    return false;
  }
  /* v8 ignore stop */
};

/* v8 ignore start -- process-entry scaffolding, exercised only via the
 * standalone `npx tsx tools/semantic_oracle.ts` invocation (documented in
 * the PR body's full-size run output), never via `import` from the test
 * suite; a real (unmocked) `run()` call takes on the order of a minute,
 * too slow to invoke as a subprocess from the normal test suite just to
 * cover this one line -- same reasoning as upstream's identical guard. */
if (isMain()) {
  process.exit(main());
}
/* v8 ignore stop */
