#!/usr/bin/env node
/**
 * Runs real (non-self-test) fixtures under vendor/omnist-spec's
 * conformance/fixtures/<operation>/ against omnist-ts's own library, per
 * omnist-spec's docs/conformance-harness.md Sec3's fixture format. Sec8.5.5's
 * reporting discipline: pass, fail, or skip -- skip is first-class, never
 * folded into pass.
 *
 * Ported from Python's `omnist`'s `tools/conformance/runner.py` (itself
 * ported from omnist-spec's `conformance/orchestrator/runner.py`, issue
 * #283). Unlike Python's version, this repo is a library with a full
 * functional API, so each operation calls omnist-ts's library directly
 * (see tools/conformance/referee.ts's header note) instead of shelling out
 * to a CLI -- a thrown error takes the place of a nonzero exit code, and
 * function return values take the place of parsed JSON stdout.
 *
 * Usage:
 *
 *     npx tsx tools/conformance/runner.ts [operation ...]
 *     npm run conformance:runner
 *
 * (with no arguments, runs every operation directory that has fixtures)
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { Doc } from "../../src/document.js";
import { readOml, writeOml } from "../../src/oml.js";
import { parseSchema, toOsd } from "../../src/osd.js";
import { materialize } from "../../src/deserialize.js";
import { extract as opsExtract } from "../../src/ops/extract.js";
import { lint as opsLint, type LintFinding } from "../../src/ops/lint.js";
import { infer, inferWithReport } from "../../src/infer.js";

import { compareDocument, compareSchema } from "./referee.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(
  HERE,
  "..",
  "..",
  "vendor",
  "omnist-spec",
  "conformance",
  "fixtures",
);

const ALL_OPERATIONS = [
  "write",
  "validate",
  "materialize",
  "normalize",
  "prune",
  "is_empty",
  "compatible_with",
  "equivalent",
  "extract",
  "infer",
  "lint",
] as const;

type Operation = (typeof ALL_OPERATIONS)[number];

interface CaseResult {
  status: "pass" | "fail";
  message: string;
}

function read(...parts: string[]): string {
  return readFileSync(path.join(...parts), "utf-8");
}

function exists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function purpose(caseDir: string): string {
  const p = path.join(caseDir, "purpose.txt");
  // `?? ""` is defensive only: `String.split` always returns a non-empty
  // array, so index 0 is never actually undefined -- required purely to
  // satisfy `noUncheckedIndexedAccess`.
  /* v8 ignore next */
  return exists(p) ? (read(p).split("\n")[0] ?? "") : "";
}

function pass(): CaseResult {
  return { status: "pass", message: "ok" };
}

function fail(message: string): CaseResult {
  return { status: "fail", message };
}

/** Message text from a thrown error, mirroring Python's `stderr.strip()`
 * on a nonzero-exit CLI invocation. */
function errorMessage(e: unknown): string {
  // Every error the library actually throws is an `Error` (in practice,
  // an `OmnistError` subclass, src/errors.ts) -- the `String(e)` fallback
  // is a defensive backstop, not a reachable path via this repo's public
  // API.
  /* v8 ignore next */
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Per-operation drivers
// ---------------------------------------------------------------------------

function runWrite(caseDir: string): CaseResult {
  let actual: string;
  try {
    actual = writeOml(readOml(read(caseDir, "input.oml")));
  } catch (e) {
    return fail(`threw: ${errorMessage(e)}`);
  }
  const expected = read(caseDir, "expected.oml");
  if (compareDocument(actual, expected)) return pass();
  return fail("output does not match expected (structural comparison)");
}

function runValidate(caseDir: string): CaseResult {
  const expectOk = read(caseDir, "expected", "ok.txt").trim() === "true";
  const schema = parseSchema(read(caseDir, "schema.osd"));
  const doc = new Doc(readOml(read(caseDir, "input.oml")));
  const result = schema.validate(doc);
  if (result.ok !== expectOk) {
    return fail(`expected ok=${expectOk}, got ${result.ok}`);
  }
  return pass();
}

function runMaterialize(caseDir: string): CaseResult {
  const expectOk = read(caseDir, "expected", "ok.txt").trim() === "true";
  const schema = parseSchema(read(caseDir, "schema.osd"));
  const input = readOml(read(caseDir, "input.oml"));
  if (expectOk) {
    let actual: string;
    try {
      actual = writeOml(materialize(input, schema));
    } catch (e) {
      return fail(`expected success, threw: ${errorMessage(e)}`);
    }
    const expected = read(caseDir, "expected", "output.oml");
    if (compareDocument(actual, expected)) return pass();
    return fail("materialized output does not match expected");
  }
  try {
    materialize(input, schema);
  } catch {
    return pass();
  }
  return fail("expected failure, materialize succeeded");
}

function runNormalize(caseDir: string): CaseResult {
  const schema = parseSchema(read(caseDir, "input.osd"));
  let actual: string;
  try {
    actual = toOsd(schema.normalize());
    /* v8 ignore start -- defensive: unlike Python's CLI-wrapper track (where
     * a malformed schema.osd or an internal error surfaces as a nonzero
     * exit code caught here), `parseSchema` above already either produced
     * a valid `Schema` or threw before this try block -- `Schema.normalize`
     * (src/schema.ts, delegating to src/ops/minimize.ts) has no throwing
     * path for any well-formed `Schema`. Kept for structural parity with
     * Python's runner.py and as a backstop against a future normalize()
     * that does throw. */
  } catch (e) {
    return fail(`threw: ${errorMessage(e)}`);
  }
  /* v8 ignore stop */
  const expected = read(caseDir, "expected.osd");
  if (compareSchema(actual, expected, "exact")) return pass();
  return fail("output schema does not match expected (exact structural comparison)");
}

function runPrune(caseDir: string): CaseResult {
  const schema = parseSchema(read(caseDir, "input.osd"));
  let actual: string;
  try {
    actual = toOsd(schema.prune());
    /* v8 ignore start -- defensive: same reasoning as runNormalize's above --
     * `Schema.prune` (delegating to src/ops/prune.ts) has no throwing path
     * for any well-formed `Schema` produced by `parseSchema`. */
  } catch (e) {
    return fail(`threw: ${errorMessage(e)}`);
  }
  /* v8 ignore stop */
  const expected = read(caseDir, "expected.osd");
  if (compareSchema(actual, expected, "exact")) return pass();
  return fail("output schema does not match expected (exact structural comparison)");
}

function runIsEmpty(caseDir: string): CaseResult {
  const schema = parseSchema(read(caseDir, "input.osd"));
  const expected = read(caseDir, "expected.txt").trim() === "true";
  const actual = schema.isEmpty();
  if (actual !== expected) return fail(`expected empty=${expected}, got ${actual}`);
  return pass();
}

function runCompatibleWith(caseDir: string): CaseResult {
  const a = parseSchema(read(caseDir, "a.osd"));
  const b = parseSchema(read(caseDir, "b.osd"));
  const expected = read(caseDir, "expected.txt").trim() === "true";
  const actual = a.compatibleWith(b);
  if (actual !== expected) return fail(`expected compatible=${expected}, got ${actual}`);
  return pass();
}

function runEquivalent(caseDir: string): CaseResult {
  const a = parseSchema(read(caseDir, "a.osd"));
  const b = parseSchema(read(caseDir, "b.osd"));
  const expected = read(caseDir, "expected.txt").trim() === "true";
  const actual = a.equivalent(b);
  if (actual !== expected) return fail(`expected equivalent=${expected}, got ${actual}`);
  return pass();
}

function runExtract(caseDir: string): CaseResult {
  const keep = read(caseDir, "keep.txt")
    .trim()
    .split(",")
    .filter((s) => s.length > 0);
  const schema = parseSchema(read(caseDir, "schema.osd"));
  const expectOk = read(caseDir, "expected", "ok.txt").trim() === "true";
  if (expectOk) {
    let actual: string;
    try {
      actual = toOsd(opsExtract(schema, keep));
    } catch (e) {
      return fail(`expected success, threw: ${errorMessage(e)}`);
    }
    const expected = read(caseDir, "expected", "output.osd");
    if (compareSchema(actual, expected, "exact")) return pass();
    return fail("extracted schema does not match expected");
  }
  try {
    opsExtract(schema, keep);
  } catch {
    return pass();
  }
  return fail("expected failure (keep set invalidates root), extract succeeded");
}

function runInfer(caseDir: string): CaseResult {
  const samplesDir = path.join(caseDir, "samples");
  const sampleFiles = readdirSync(samplesDir).sort();
  const allowAnyFile = path.join(caseDir, "allow_any.txt");
  const allowAny = exists(allowAnyFile) && read(allowAnyFile).trim() === "true";
  const samples = sampleFiles.map((f) => new Doc(readOml(read(samplesDir, f))));

  const expectOk = read(caseDir, "expected", "ok.txt").trim() === "true";
  if (expectOk) {
    let actual: string;
    try {
      actual = toOsd(infer(samples, { allowAny }));
    } catch (e) {
      return fail(`expected success, threw: ${errorMessage(e)}`);
    }
    const expected = read(caseDir, "expected", "output.osd");
    // isomorphic, not exact: Sec6.10 -- infer's generated record names are
    // implementation-derived, never canonical.
    if (compareSchema(actual, expected, "isomorphic")) return pass();
    return fail("inferred schema is not isomorphic to expected");
  }
  try {
    inferWithReport(samples, { allowAny });
  } catch {
    return pass();
  }
  return fail("expected failure (ambiguous type, no allowAny), infer succeeded");
}

/** Message text is never compared (Sec8.5's own matching rule 1) -- strip
 * it so a fixture's expected.json doesn't have to pin exact wording, only
 * code/severity/location. */
function dropMessages(payload: { ok: boolean; findings: readonly LintFinding[] }) {
  return {
    ok: payload.ok,
    findings: payload.findings.map((f) => ({
      code: f.code,
      severity: f.severity,
      location: f.location,
    })),
  };
}

function runLint(caseDir: string): CaseResult {
  const schema = parseSchema(read(caseDir, "input.osd"));
  // Findings MUST already be sorted deterministically by (code, location)
  // per Sec6.11 -- a direct list-equality comparison (not set/unordered)
  // is itself a conformance check, not just convenient.
  const findings = opsLint(schema);
  const actual = dropMessages({ ok: findings.length === 0, findings });
  const expectedRaw = JSON.parse(read(caseDir, "expected.json")) as {
    ok: boolean;
    findings: LintFinding[];
  };
  const expected = dropMessages(expectedRaw);
  if (JSON.stringify(actual) === JSON.stringify(expected)) return pass();
  return fail(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const RUNNERS: Partial<Record<Operation, (caseDir: string) => CaseResult>> = {
  write: runWrite,
  validate: runValidate,
  materialize: runMaterialize,
  normalize: runNormalize,
  prune: runPrune,
  is_empty: runIsEmpty,
  compatible_with: runCompatibleWith,
  equivalent: runEquivalent,
  extract: runExtract,
  infer: runInfer,
  lint: runLint,
};

/** Returns [passed, failed, skipped] counts for one operation directory. */
export function runOperation(operation: Operation, fixturesDir: string = FIXTURES_DIR): [number, number, number] {
  const opDir = path.join(fixturesDir, operation);
  if (!exists(opDir) || !statSync(opDir).isDirectory()) return [0, 0, 0];
  const cases = readdirSync(opDir)
    .map((name) => path.join(opDir, name))
    .filter((p) => statSync(p).isDirectory())
    .sort();
  if (cases.length === 0) return [0, 0, 0];

  const runnerFn = RUNNERS[operation];
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const caseDir of cases) {
    const caseName = path.basename(caseDir);
    const why = purpose(caseDir);
    if (runnerFn === undefined) {
      console.log(`[SKIP] ${operation}/${caseName} (${why}): no runner wired up yet for this operation`);
      skipped += 1;
      continue;
    }
    const { status, message } = runnerFn(caseDir);
    console.log(`[${status.toUpperCase()}] ${operation}/${caseName} (${why}): ${message}`);
    if (status === "pass") passed += 1;
    else failed += 1;
  }
  return [passed, failed, skipped];
}

export function main(argv: string[] = [], fixturesDir: string = FIXTURES_DIR): number {
  if (!exists(fixturesDir) || !statSync(fixturesDir).isDirectory()) {
    console.error(
      `no fixtures found at ${fixturesDir} -- has the vendor/omnist-spec ` +
        "submodule been checked out? (git submodule update --init)",
    );
    return 2;
  }

  const operations = (argv.length > 0 ? argv : [...ALL_OPERATIONS].sort()) as Operation[];
  let totalPass = 0;
  let totalFail = 0;
  let totalSkip = 0;
  for (const op of operations) {
    const [p, f, s] = runOperation(op, fixturesDir);
    totalPass += p;
    totalFail += f;
    totalSkip += s;
  }

  console.log(
    `\n${totalPass} passed, ${totalFail} failed, ${totalSkip} skipped ` +
      `(across ${operations.length} operation(s))`,
  );
  return totalFail ? 1 : 0;
}

/* c8 ignore start -- entry point, not importable behavior (mirrors Python's
 * `if __name__ == "__main__":` exclusion in runner.py) */
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
/* c8 ignore stop */
