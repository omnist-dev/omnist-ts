/**
 * Bounded, deterministic CI version of the brute-force semantic oracle
 * (`tools/semantic_oracle.ts`, issue #10). Ported from upstream
 * `tests/test_semantic_oracle.py`.
 *
 * Runs the exact same five checks against the exact same set-theoretic
 * ground-truth definition (`L(s) = { d in U : s.validate(d).ok }`) as the
 * full tool, just over a much smaller universe and schema family so it
 * fits comfortably inside the normal test suite -- a *third* independent
 * correctness check on the schema algebra, alongside `compatibleWith`
 * (`src/ops/subschema.ts`) and the minimize+isomorphism Theorem-4 oracle
 * (`src/ops/isomorphic.ts`, cross-checked in `test/ops/minimize.test.ts`) --
 * see `docs/testing.md`'s "the triple-checked algebra" (upstream).
 */
import { describe, expect, it } from "vitest";
import {
  ALL_SCALAR_KIND_LEAVES,
  buildUniverse,
  checkCompatibleWith,
  checkExtract,
  checkIsEmpty,
  checkNormalizePrunePreserveLanguage,
  groundTruth,
  main,
  OracleResult,
  run,
  schemaFamily,
  seededRandomFamily,
  toDoc,
} from "../tools/semantic_oracle.js";
import { SCALAR_KINDS, type Schema } from "../src/schema.js";

// A deliberately small but still representative universe/family, same
// reasoning as upstream: base_max=1 keeps the base universe compact,
// extended_max=[2,3] adds cardinality witnesses on top, random_count=15
// keeps the O(n^2) compatibleWith sweep and the ground-truth computation
// small enough for the normal test suite.
const BASE_MAX = 1;
const EXTENDED_MAX = [2, 3];
const RANDOM_COUNT = 15;
const SEED = 158;

function runBounded(): OracleResult {
  const { base: baseNodes, extended: extNodes } = buildUniverse(BASE_MAX, EXTENDED_MAX);
  const baseDocs = baseNodes.map(toDoc);
  const extDocs = extNodes.map(toDoc);
  const schemas = schemaFamily(RANDOM_COUNT, SEED);

  const truth = groundTruth(schemas, baseDocs);
  const extTruth = groundTruth(schemas, extDocs);
  const docLabels = baseDocs.map((d) => (d.isLeaf ? new Set<string>() : new Set(d.edges().map(([lbl]) => lbl))));

  const result = new OracleResult();
  checkCompatibleWith(schemas, truth, extDocs, extTruth, result);
  checkIsEmpty(schemas, truth, result);
  checkNormalizePrunePreserveLanguage(schemas, truth, baseDocs, result);
  checkExtract(schemas, baseDocs, truth, docLabels, result);
  result.counts.base_docs = baseDocs.length;
  result.counts.extended_docs = extDocs.length;
  result.counts.schemas = schemas.length;
  return result;
}

describe("semantic oracle: bounded CI run", () => {
  it("finds zero definite bugs over a small but structurally representative universe", () => {
    const result = runBounded();
    expect(result.definiteBugs, `semantic oracle found ${result.definiteBugs.length} bug(s): ${result.definiteBugs.slice(0, 5).join("; ")}`).toEqual([]);
    // Sanity: a regression that made the universe/family accidentally
    // empty would otherwise "pass" this test vacuously.
    expect(result.counts.base_docs).toBeGreaterThan(30);
    expect(result.counts.schemas).toBeGreaterThanOrEqual(60);
    expect(result.counts.pairs_checked).toBe((result.counts.schemas ?? 0) ** 2);
    expect(result.counts.is_empty_checked).toBe(result.counts.schemas);
    expect(result.counts.extract_cases_checked).toBeGreaterThan(0);
  });

  it("keeps needs-manual-review bounded (a bounded-universe artifact, not a failure)", () => {
    // Unlike upstream's Python oracle (whose witness heuristics were tuned
    // against a larger default universe), this bounded TS universe's
    // targeted-witness search leaves a larger fraction of False
    // compatibleWith answers unvindicated at this small a size -- verified
    // empirically (a real run here lands at 62 of 62*62=3844 pairs, ~1.6%),
    // not assumed. The important invariant stays definiteBugs === []
    // (checked above); this is a soft sanity ceiling against the
    // needs-review set silently exploding (e.g. from a regressed witness
    // heuristic), not a strict correctness requirement -- see
    // tools/semantic_oracle.ts's checkCompatibleWith docstring.
    const result = runBounded();
    expect(result.needsReview.length).toBeLessThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------
// Witness-guarantee: the universe must contain a leaf witness for every
// scalar kind (plus null and an edge-list), or `compatibleWith`'s False
// answers for `any <sub> T` can't be vindicated.
// ---------------------------------------------------------------------------

function scalarKindOf(value: unknown): string {
  if (typeof value === "boolean") return "boolean";
  // Since issue #98, integer-kinded values are bigint-backed and
  // number-kinded values stay plain JS `number` -- a real, native
  // distinction, not the old Number.isInteger shape guess.
  if (typeof value === "bigint") return "integer";
  if (typeof value === "number") return "number";
  if (typeof value === "string") {
    if (/^\d{2}:\d{2}:\d{2}$/.test(value)) return "time";
    return "string";
  }
  if (value instanceof Date) return "datetime"; // see tools/semantic_oracle.ts's date/datetime note
  throw new Error(
    `unclassifiable witness value: ${typeof value === "bigint" ? String(value) : JSON.stringify(value)}`,
  );
}

describe("ALL_SCALAR_KIND_LEAVES", () => {
  it("covers string/integer/number/boolean/time and null, with date/datetime collapsed at the Document layer", () => {
    // Document-layer date/datetime collapse (src/document.ts): a real Date
    // witness can't be told apart from "date" vs "datetime" without a
    // schema-directed parse tag, so ALL_SCALAR_KIND_LEAVES's date and
    // datetime witnesses both read back as "datetime" here -- expected,
    // not a bug (see tools/semantic_oracle.ts's file-top note). The five
    // kinds this Document-layer classifier CAN distinguish must all be
    // present exactly once each, though.
    const kinds = ALL_SCALAR_KIND_LEAVES.map(scalarKindOf);
    const distinguishable = new Set([...SCALAR_KINDS].filter((k) => k !== "date"));
    for (const kind of distinguishable) {
      expect(kinds).toContain(kind);
    }
    expect(ALL_SCALAR_KIND_LEAVES.length).toBe(SCALAR_KINDS.length);
  });
});

describe("universe construction", () => {
  it("guarantees at least one edge-list (non-leaf) document and a null witness", () => {
    for (const [baseMax, extendedMax] of [[1, [2, 3]] as const, [2, [3, 4]] as const]) {
      const { base } = buildUniverse(baseMax, extendedMax);
      const docs = base.map(toDoc);
      expect(docs.some((d) => !d.isLeaf)).toBe(true);
      const anyNull = docs.some((d) => {
        const walk = (n: unknown): boolean => {
          if (n === null) return true;
          if (Array.isArray(n)) return n.some((e: { target: unknown }) => walk(e.target));
          return false;
        };
        return walk(d.toData());
      });
      expect(anyNull).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The vindication test: `any`-typed root fields must have their False
// compatibleWith answers concretely vindicated, never fall to needs-review.
// ---------------------------------------------------------------------------

describe("any <sub> T vindication", () => {
  it("vindicates both any<sub>scalar and any<sub>record False answers, never needs-review", async () => {
    const { Schema, field, ref, record, t, ANY } = await import("../src/schema.js");
    const anySchema = new Schema(ref("R"), { R: record(field("a", ANY, 1, 1)) });
    const scalarSchema = new Schema(ref("R"), { R: record(field("a", t.integer, 1, 1)) });
    const recordSchema = new Schema(ref("R"), {
      R: record(field("a", ref("Inner"), 1, 1)),
      Inner: record(field("z", t.integer, 1, 1)),
    });

    const { base: baseNodes, extended: extNodes } = buildUniverse(1, [2, 3]);
    const baseDocs = baseNodes.map(toDoc);
    const extDocs = extNodes.map(toDoc);
    const schemas: Schema[] = [anySchema, scalarSchema, recordSchema];
    const truth = groundTruth(schemas, baseDocs);
    const extTruth = groundTruth(schemas, extDocs);

    const result = new OracleResult();
    checkCompatibleWith(schemas, truth, extDocs, extTruth, result);
    expect(result.definiteBugs).toEqual([]);
    expect(result.needsReview, `any<sub>T False answers must be vindicated: ${result.needsReview.join("; ")}`).toEqual([]);
    const vindicatedTotal =
      (result.counts.vindicated_by_base_subset ?? 0) +
      (result.counts.vindicated_by_extended ?? 0) +
      (result.counts.vindicated_by_witness ?? 0);
    expect(vindicatedTotal).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// seededRandomFamily: determinism and `any`-emission
// ---------------------------------------------------------------------------

describe("seededRandomFamily", () => {
  it("is fully deterministic for a fixed seed", () => {
    const fam1 = seededRandomFamily(158, 20);
    const fam2 = seededRandomFamily(158, 20);
    expect(fam1.length).toBe(fam2.length);
    for (let i = 0; i < fam1.length; i++) {
      const s1 = fam1[i] as Schema;
      const s2 = fam2[i] as Schema;
      expect(s1.root).toEqual(s2.root);
      expect([...s1.env.keys()].sort()).toEqual([...s2.env.keys()].sort());
      for (const name of s1.env.keys()) {
        const f1 = (s1.env.get(name)?.fields ?? []).map((f) => [f.label, f.type, f.min, f.max]);
        const f2 = (s2.env.get(name)?.fields ?? []).map((f) => [f.label, f.type, f.min, f.max]);
        expect(f1).toEqual(f2);
      }
    }
  });

  it("emits a small minority of `any`-typed fields, never zero, never all", () => {
    const fam = seededRandomFamily(158, 82);
    let anyCount = 0;
    let totalFields = 0;
    for (const s of fam) {
      for (const rec of s.env.values()) {
        for (const f of rec.fields) {
          totalFields++;
          if (f.type.tag === "any") anyCount++;
        }
      }
    }
    expect(anyCount).toBeGreaterThan(0);
    expect(anyCount).toBeLessThan(totalFields * 0.4);
  });
});

// ---------------------------------------------------------------------------
// Branch coverage for each check's own definite-bug-detection code: real
// compatibleWith/isEmpty/normalize/prune/extract never disagree with
// ground truth here (checked above -- zero bugs), so these branches never
// fire from a real run. Same fabricated-truth technique as upstream's
// Python suite: hand each check function a deliberately wrong `truth`
// array so the mismatch it's designed to catch is guaranteed to fire,
// isolating the detection branch itself without needing a real algebra
// bug to exist.
// ---------------------------------------------------------------------------

describe("check* definite-bug branches (fabricated truth, isolating detection code)", () => {
  it("checkCompatibleWith reports a definite bug when a True answer's language isn't actually a subset", async () => {
    const { Schema, field, ref, record, t } = await import("../src/schema.js");
    const a = new Schema(ref("R"), { R: record(field("a", t.integer, 1, 1)) });
    const b = new Schema(ref("R"), { R: record(field("a", t.integer, 1, 1)) });
    const { base: baseNodes } = buildUniverse(1, [2]);
    const baseDocs = baseNodes.map(toDoc);
    // a and b are genuinely equivalent, so real compatibleWith(a, b) is
    // true -- exactly what this branch needs, paired with a fabricated
    // truth where a accepts a doc b doesn't (a lie, isolating the branch).
    const fakeTruth = [new Set([0]), new Set<number>()];
    const result = new OracleResult();
    checkCompatibleWith([a, b], fakeTruth, baseDocs, [new Set(), new Set()], result);
    expect(result.definiteBugs.length).toBe(1);
    expect(result.definiteBugs[0]).toContain("says true but");
  });

  it("checkIsEmpty reports a definite bug when isEmpty(s) is true but the fabricated truth is non-empty", async () => {
    const { Schema, field, ref, record } = await import("../src/schema.js");
    const cyclic = new Schema(ref("R"), { R: record(field("self", ref("R"), 1, 1)) }); // genuinely unsatisfiable
    const fakeTruth = [new Set([0, 1])]; // lie: claims a non-empty language
    const result = new OracleResult();
    checkIsEmpty([cyclic], fakeTruth, result);
    expect(result.definiteBugs.length).toBe(1);
    expect(result.definiteBugs[0]).toContain("L(s) is non-empty");
    expect(result.counts.is_empty_checked).toBe(1);
  });

  it("checkNormalizePrunePreserveLanguage reports definite bugs for both operations on a language mismatch", async () => {
    const { Schema, field, ref, record, t } = await import("../src/schema.js");
    const s = new Schema(ref("R"), { R: record(field("a", t.integer, 1, 1)) });
    const { base: baseNodes } = buildUniverse(1, [2]);
    const baseDocs = baseNodes.map(toDoc);
    const fakeTruth = [new Set<number>()]; // lie: claims s accepts nothing
    const result = new OracleResult();
    checkNormalizePrunePreserveLanguage([s], fakeTruth, baseDocs, result);
    expect(result.definiteBugs.length).toBe(2);
    expect(result.definiteBugs.every((m) => m.includes("changes the language"))).toBe(true);
    expect(result.definiteBugs.some((m) => m.startsWith("normalize("))).toBe(true);
    expect(result.definiteBugs.some((m) => m.startsWith("prune("))).toBe(true);
  });

  it("checkNormalizePrunePreserveLanguage covers both the extra-doc and missing-doc mismatch messages", async () => {
    const { Schema, field, ref, record, t } = await import("../src/schema.js");
    const nonEmpty = new Schema(ref("R"), { R: record(field("a", t.integer, 1, 1)) });
    const { base: baseNodes } = buildUniverse(1, [2]);
    const baseDocs = baseNodes.map(toDoc);

    // Case A (already covered above): fake truth UNDER-claims (empty) vs
    // a real non-empty language -> extra defined, missing undefined.

    // Case B: fake truth OVER-claims (every doc index) vs the real
    // language, which for a [1,1] integer field does NOT include every
    // base-universe doc (e.g. it excludes docs shaped for label "b" or
    // non-integer values) -- so missing is defined, extra undefined.
    const fakeTruthOverclaims = [new Set(baseDocs.map((_, i) => i))];
    const result = new OracleResult();
    checkNormalizePrunePreserveLanguage([nonEmpty], fakeTruthOverclaims, baseDocs, result);
    expect(result.definiteBugs.length).toBe(2);
    expect(result.definiteBugs.every((m) => m.includes("changes the language"))).toBe(true);
  });

  it("checkExtract reports a definite bug when the fabricated truth disagrees with extract's real output", async () => {
    const { Schema, field, ref, record, t } = await import("../src/schema.js");
    const s = new Schema(ref("R"), { R: record(field("a", t.integer, 1, 1)) });
    const { base: baseNodes } = buildUniverse(1, [2]);
    const baseDocs = baseNodes.map(toDoc);
    const docLabels = baseDocs.map((d) => (d.isLeaf ? new Set<string>() : new Set(d.edges().map(([lbl]) => lbl))));
    const fakeTruth = [new Set<number>()]; // lie: claims s accepts nothing
    const result = new OracleResult();
    checkExtract([s], baseDocs, fakeTruth, docLabels, result);
    expect(result.definiteBugs.length).toBeGreaterThan(0);
    expect(result.definiteBugs.every((m) => m.includes("disagrees with ground truth"))).toBe(true);
    expect(result.counts.extract_cases_checked).toBeGreaterThan(0);
  });
});

// The needs-manual-review fallthrough branch (a False compatibleWith
// answer that no witness in base/extended/targeted can vindicate) is
// already exercised for real by the bounded-universe run above (62
// instances observed empirically, see that test's comment) -- no
// fabrication needed for that branch.

// ---------------------------------------------------------------------------
// run()/main(): the driver, over a small (patched-in-place-by-arguments)
// universe so this stays fast, exercising the verbose print paths.
// ---------------------------------------------------------------------------

describe("run(): driver", () => {
  it("verbose run prints a summary and returns zero definite bugs", () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    let result: OracleResult;
    try {
      result = run({
        randomCount: 3,
        verbose: true,
        universeBuilder: () => buildUniverse(1, [2]),
      });
    } finally {
      console.log = orig;
    }
    const out = logs.join("\n");
    expect(out).toContain("universe:");
    expect(out).toContain("schema family:");
    expect(out).toContain("ground truth computed");
    expect(out).toContain("checks run");
    expect(out).toContain("=== Summary ===");
    expect(out).toContain("DEFINITE BUGS: 0");
    expect(result.definiteBugs).toEqual([]);
  });

  it("quiet run suppresses all output", () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      const result = run({
        randomCount: 3,
        verbose: false,
        universeBuilder: () => buildUniverse(1, [2]),
      });
      expect(result.counts.is_empty_checked).toBeGreaterThan(0);
    } finally {
      console.log = orig;
    }
    expect(logs).toEqual([]);
  });

  it("prints each definite bug when found (fabricated via afterChecks, for print-loop coverage)", () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    let result: OracleResult;
    try {
      result = run({
        randomCount: 3,
        verbose: true,
        universeBuilder: () => buildUniverse(1, [2]),
        afterChecks: (r) => r.definiteBugs.push("fabricated bug for print-loop coverage"),
      });
    } finally {
      console.log = orig;
    }
    const out = logs.join("\n");
    expect(out).toContain("DEFINITE BUGS: 1");
    expect(out).toContain("  BUG: fabricated bug for print-loop coverage");
    expect(result.definiteBugs).toEqual(["fabricated bug for print-loop coverage"]);
  });
});

describe("main(): CLI entry point contract", () => {
  it("returns 0 and prints PASSED when run() finds no definite bugs", () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    let code: number;
    try {
      code = main(() => new OracleResult());
    } finally {
      console.log = orig;
    }
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("PASSED: zero definite bugs.");
  });

  it("returns 1 and prints FAILED (with count) when run() finds definite bugs", () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    let code: number;
    try {
      code = main(() => {
        const bad = new OracleResult();
        bad.definiteBugs.push("fabricated bug for branch coverage");
        return bad;
      });
    } finally {
      console.log = orig;
    }
    expect(code).toBe(1);
    expect(logs.join("\n")).toContain("FAILED: 1 definite bug(s) found.");
  });

  it("run() over the bounded universe never finds a definite bug (end-to-end sanity)", () => {
    const result = run({ randomCount: 3, verbose: false, universeBuilder: () => buildUniverse(1, [2]) });
    expect(result.definiteBugs.length).toBe(0);
  });
});
