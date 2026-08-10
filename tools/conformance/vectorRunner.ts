#!/usr/bin/env node
/**
 * Runs omnist-spec's `test-suite/` JSON-vector suite (139 vectors, envelope
 * `name`/`spec`/`operation`/`purpose`/`input`/`expect` -- see
 * `vendor/omnist-spec/test-suite/README.md` and
 * `docs/08-conformance-and-errors.md` Sec8.5) against omnist-ts's own
 * library. This is a *second* runner alongside `runner.ts`'s
 * directory-per-fixture format (Track 1) -- the two vector shapes don't
 * share a natural code path (OML/OSD text vs. canonical-JSON-encoded
 * Document), so the drivers stay separate; only `referee.ts`'s comparison
 * primitives (`compareSchema`) and the `Doc`/`Doc.equals` machinery are
 * shared. Ported from Python's `omnist`'s `tools/conformance/vector_runner.py`
 * (itself the reference for the four empirical decisions below), adapted to
 * call this repo's library directly rather than shelling out to a CLI --
 * see `referee.ts`'s header note and `runner.ts`'s precedent for why.
 *
 * ## The four empirical decisions (omnist-ts issue #85, step 3)
 *
 * **1. Diagnostics matching mode: code-agnostic (Sec8.5.2 rule 4).**
 * Verified directly: running `schema.validate()` on a real type-mismatch
 * (`record R { "n": string } root R` against `n: 1`) produces
 * `{ path: "$.n", code: "type-mismatch" }` -- bare, un-prefixed. A real
 * vector's expected code for the same failure family is
 * `"validate.type-mismatch"` (operation-prefixed, per Sec8.3's taxonomy).
 * The codes don't match syntactically even though they mean the same thing;
 * omnist-ts's diagnostic codes predate Sec8.3 and were never renamed to
 * match it, the same situation Python's port is in. This runner therefore
 * always compares in code-agnostic mode: `ok` plus the *set* of `path`s,
 * never `code`. Message text is never compared either way (rule 1).
 *
 * **2. D-6 (integer/number kind collapse) -- CLOSED, issue #98.** Used to
 * document a skip here: omnist-ts's `Document` model had one JS numeric
 * type, so a `Scalar` carried no kind tag distinguishing `integer` from
 * `number` -- `matchesKind`/`valueKind` (`src/schema.ts`) derived the kind
 * from `Number.isInteger(v)`, a shape heuristic, and one vector
 * (`validate/scalar-kinds/number-does-not-satisfy-integer-even-when-whole`)
 * depended on the real distinction and had to be skipped. As of issue #98,
 * `integer`-kinded values are represented as native `bigint` (`number`
 * stays plain JS `number`), so `matchesKind`/`valueKind` now derive the
 * kind from `typeof v` -- a real, native distinction, not a shape guess.
 * That one vector runs for real now (no skip logic left in this file) and
 * passes. See `src/schema.ts`'s `matchesKind` doc comment and the issue
 * #98 design comment for the full mapping (including the sanctioned
 * `integer <: number` value-level subtyping relation, Sec6.3, which is a
 * separate, intentional rule -- not a reopening of D-6).
 *
 * **3. Runtime-configurable-limit vectors (`document-model/limits.json`).**
 * Present in this suite (6 vectors), assuming a runtime-configurable safety
 * limit (`declared_max_depth`/`declared_max_nodes`/`declared_max_int_digits`
 * in `input`). Confirmed against `src/document.ts`: `MAX_DEPTH`/`MAX_NODES`/
 * `MAX_INT_DIGITS` are module-level `const`s (issue #77 added `MAX_NODES` as
 * `1_000_000`), with no runtime-configuration surface. These SKIP, citing
 * "not yet implemented -- omnist-ts's safety limits are compile-time
 * constants, no runtime configuration surface".
 *
 * **4. Structured diagnostics on syntax errors.** Verified directly:
 * `readOml("a: [1, 2\n")` throws `ParseError` with `.errors` empty (only
 * `.message`, a plain string) -- `src/errors.ts`'s documented asymmetry
 * (`ParseError.errors` is populated only for `materialize`-driven
 * schema-conformance failures, never for syntax failures), matching
 * Python's `ParseError` exactly. `SchemaError` (osd-grammar syntax
 * failures) carries no structured fields at all, ever. So `oml-grammar`/
 * `osd-grammar` (and any `parse`/`parse_schema`) vectors asserting specific
 * `diagnostics` on a syntax-level failure SKIP (no `path`/`code` is
 * obtainable through the public API); vectors expecting only success, or a
 * bare failure with no diagnostics to check, run normally.
 *
 * A fifth point from the issue, confirmed rather than assumed: there is no
 * CLI-arg-parsing gap to work around here (unlike Python's `infer`
 * zero-samples CLI-bypass) -- `infer`/`inferWithReport` are already called
 * directly as library functions (mirroring `runner.ts`'s `runInfer`), so
 * `infer/errors/zero-samples-is-an-error` just runs and passes: `infer([])`
 * throws `SchemaError("cannot infer a schema from zero samples")` for real.
 *
 * Usage:
 *
 *     npx tsx tools/conformance/vectorRunner.ts
 *     npm run conformance:vectors
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import "../../src/index.js"; // side effect: registers the built-in formats
import { Doc, type Node, type Edge, type Scalar } from "../../src/document.js";
import { readOml } from "../../src/oml.js";
import { parseSchema, toOsd } from "../../src/osd.js";
import { materialize } from "../../src/deserialize.js";
import { extract as opsExtract } from "../../src/ops/extract.js";
import { lint as opsLint } from "../../src/ops/lint.js";
import { infer, inferWithReport } from "../../src/infer.js";
import { getFormat } from "../../src/registry.js";
import { WriteReport } from "../../src/report.js";
import { parseDateToken, parseDatetimeToken, TimeValue } from "../../src/temporal.js";
import { tagIntegerLiterals, bigintReviver } from "../../src/formats/json.js";

import { compareSchema } from "./referee.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VECTOR_SUITE_DIR = path.resolve(HERE, "..", "..", "vendor", "omnist-spec", "test-suite");

const LIMIT_KEYS = ["declared_max_depth", "declared_max_nodes", "declared_max_int_digits"] as const;

interface Diagnostic {
  readonly path: string;
  readonly code?: string;
}

// The envelope's own types are intentionally loose (`unknown`-ish JSON) --
// each driver narrows what it needs, mirroring Python's untyped dict access.
type JsonValue = string | number | bigint | boolean | null | JsonObject | JsonValue[];
interface JsonObject {
  [key: string]: JsonValue | undefined;
}

interface Vector {
  readonly name: string;
  readonly spec: string;
  readonly operation: string;
  readonly purpose: string;
  readonly input: JsonObject;
  readonly expect: JsonObject;
}

interface Result {
  readonly status: "pass" | "fail" | "skip";
  readonly message: string;
}

function pass(): Result {
  return { status: "pass", message: "ok" };
}
function fail(message: string): Result {
  return { status: "fail", message };
}
function skip(message: string): Result {
  return { status: "skip", message };
}

// ---------------------------------------------------------------------------
// Canonical document encoding (Sec8.5.4) -> a raw omnist-ts Document Node
// ---------------------------------------------------------------------------

interface EncodedScalar {
  readonly kind: string | null;
  readonly value: JsonValue;
}
interface EncodedNode {
  readonly scalar?: EncodedScalar;
  readonly edges?: [string, EncodedNode][];
}

function decodeScalar(kind: string | null, value: JsonValue): Scalar {
  if (kind === null) return null;
  switch (kind) {
    case "string":
    case "boolean":
      return value as string | boolean;
    case "integer":
      // Since issue #98, integer-kinded values are bigint-backed. A vector's
      // encoded value arrives here as: a native `bigint` (an integer-shaped
      // JSON literal, tagged and revived by the parse in iterVectors below,
      // so precision survived JSON.parse intact), or a JSON string (the
      // vector suite's own explicit string-encoding convention -- see the
      // "decodes a string-encoded integer value" test).
      if (typeof value === "bigint") return value;
      if (typeof value === "string") return BigInt(value);
      // A bare small-magnitude JSON number reaching here (rather than
      // bigint) would mean the tagger in iterVectors somehow missed an
      // integer-shaped literal -- defensive fallback, not an expected path.
      return BigInt(value as number);
    case "number":
      if (typeof value === "number") return value;
      // A number-kind field can still be encoded as an integer-shaped JSON
      // literal (e.g. `3` for a whole-number `number` field) -- it arrives
      // here as bigint via the same tag-and-revive path as the integer
      // case above, so convert it back to a JS number.
      if (typeof value === "bigint") return Number(value);
      return Number(value as string);
    case "date": {
      const d = parseDateToken(value as string);
      if (d === null) throw new Error(`invalid date literal ${JSON.stringify(value)}`);
      return d;
    }
    case "time":
      // A `time` scalar has no native JS representation; a genuinely
      // time-kinded value is a `TimeValue` wrapper (issue #96), not a plain
      // string -- see src/temporal.ts's TimeValue doc comment.
      return new TimeValue(value as string);
    case "datetime": {
      const d = parseDatetimeToken(value as string);
      if (d === null) throw new Error(`invalid datetime literal ${JSON.stringify(value)}`);
      return d;
    }
    default:
      throw new Error(`unknown scalar kind ${JSON.stringify(kind)}`);
  }
}

function decodeDocument(node: EncodedNode): Node {
  if (node.scalar !== undefined) {
    return decodeScalar(node.scalar.kind, node.scalar.value);
  }
  const edges = node.edges ?? [];
  return edges.map(([label, child]): Edge => ({ label, target: decodeDocument(child) }));
}

function paths(diagnostics: readonly Diagnostic[]): Set<string> {
  return new Set(diagnostics.map((d) => d.path));
}

function asDiagnostics(v: JsonValue | undefined): Diagnostic[] {
  return ((v as Diagnostic[] | undefined) ?? []) as Diagnostic[];
}

function errorMessage(e: unknown): string {
  /* v8 ignore next -- every error this library throws is an `Error`, see runner.ts's identical guard */
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// D-6 (integer/number kind collapse) is CLOSED as of issue #98: integer-
// kinded values are now bigint-backed, so matchesKind/valueKind
// (src/schema.ts) tell integer and number apart via native `typeof`, not
// Number.isInteger shape-guessing. The skip logic that used to live here
// (hasKindCollapseRisk/d6Affected, checked before dispatch in runValidate/
// runMaterialize below) is gone -- every vector runs for real now,
// including validate/scalar-kinds/number-does-not-satisfy-integer-even-
// when-whole, which used to be the one vector this collapse affected.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Operation drivers -- one function per operation, (vector) -> Result
// ---------------------------------------------------------------------------

function runParse(v: Vector): Result {
  const inp = v.input;
  if (LIMIT_KEYS.some((k) => inp[k] !== undefined)) {
    return skip("not yet implemented -- omnist-ts's safety limits are compile-time constants, no runtime configuration surface");
  }
  const expect = v.expect;
  const fmt = inp.format as string;
  const text = inp.text as string;
  let node: Node;
  try {
    node = getFormat(fmt).read(text) as Node;
  } catch (e) {
    if (expect.ok === false) {
      if (expect.diagnostics !== undefined) {
        return skip("syntax-level ParseError carries no structured path/code");
      }
      return pass();
    }
    return fail(`expected success, threw: ${errorMessage(e)}`);
  }
  if (expect.ok !== true) {
    return fail("expected failure, parse succeeded");
  }
  const expected = decodeDocument(expect.document as EncodedNode);
  if (new Doc(node).equals(new Doc(expected))) return pass();
  return fail("parsed document does not match expected");
}

function runParseSchema(v: Vector): Result {
  const expect = v.expect;
  try {
    parseSchema(v.input.text as string);
  } catch (e) {
    if (expect.ok === false) {
      if (expect.diagnostics !== undefined) {
        return skip("syntax-level SchemaError carries no structured path/code");
      }
      return pass();
    }
    return fail(`expected success, threw: ${errorMessage(e)}`);
  }
  if (expect.ok !== true) return fail("expected failure, parse_schema succeeded");
  return pass();
}

function runValidate(v: Vector): Result {
  const inp = v.input;
  const expect = v.expect;
  const schema = parseSchema(inp.schema as string);
  const doc = new Doc(decodeDocument(inp.document as EncodedNode));
  const result = schema.validate(doc);
  if (result.ok !== (expect.ok as boolean)) {
    return fail(`expected ok=${String(expect.ok)}, got ${String(result.ok)}`);
  }
  if (expect.ok === false) {
    const expPaths = paths(asDiagnostics(expect.diagnostics));
    const actPaths = paths(result.errors as unknown as Diagnostic[]);
    if (!setsEqual(expPaths, actPaths)) {
      return fail(`diagnostic paths differ: expected ${setStr(expPaths)}, got ${setStr(actPaths)}`);
    }
  }
  return pass();
}

function runMaterialize(v: Vector): Result {
  const inp = v.input;
  const expect = v.expect;
  const schema = parseSchema(inp.schema as string);
  const input = decodeDocument(inp.document as EncodedNode);
  if (expect.ok === true) {
    let actual: Node;
    try {
      actual = materialize(input, schema);
    } catch (e) {
      return fail(`expected success, threw: ${errorMessage(e)}`);
    }
    const expected = decodeDocument(expect.document as EncodedNode);
    if (new Doc(actual).equals(new Doc(expected))) return pass();
    return fail("materialized document does not match expected");
  }
  try {
    materialize(input, schema);
  } catch (e) {
    if (expect.diagnostics !== undefined) {
      // Defensive: materialize (src/deserialize.ts) only ever throws
      // ParseError with errors populated from the real conformance-check
      // failures that caused the throw, never undefined or empty -- the
      // `?? []` below has no reachable false case through this driver.
      /* v8 ignore next */
      const issues = (e as { errors?: Diagnostic[] }).errors ?? [];
      const expPaths = paths(asDiagnostics(expect.diagnostics));
      const actPaths = paths(issues);
      if (!setsEqual(expPaths, actPaths)) {
        return fail(`diagnostic paths differ: expected ${setStr(expPaths)}, got ${setStr(actPaths)}`);
      }
    }
    return pass();
  }
  return fail("expected failure, materialize succeeded");
}

function runWrite(v: Vector): Result {
  const inp = v.input;
  const expect = v.expect;
  const fmt = inp.format as string;
  const node = decodeDocument(inp.document as EncodedNode);
  const strict = inp.strict === true;
  const report = new WriteReport();
  let text: string;
  try {
    text = getFormat(fmt).write(node, { strict, report });
  } catch (e) {
    if (expect.ok === false) return pass();
    return fail(`expected success, threw: ${errorMessage(e)}`);
  }
  if (expect.ok !== true) return fail("expected failure, write succeeded");
  if (expect.text !== undefined && text.trim() !== (expect.text as string).trim()) {
    return fail(`expected text ${JSON.stringify(expect.text)}, got ${JSON.stringify(text.trim())}`);
  }
  if (expect.diagnostics !== undefined) {
    const expPaths = paths(asDiagnostics(expect.diagnostics));
    const actPaths = paths(report.adjustments as unknown as Diagnostic[]);
    if (!setsEqual(expPaths, actPaths)) {
      return fail(`diagnostic paths differ: expected ${setStr(expPaths)}, got ${setStr(actPaths)}`);
    }
  }
  return pass();
}

function runSchemaProducing(v: Vector, fn: (text: string) => string): Result {
  const schema = fn(v.input.schema as string);
  if (compareSchema(schema, v.expect.schema as string, "exact")) return pass();
  return fail("output schema does not match expected");
}

function runNormalize(v: Vector): Result {
  return runSchemaProducing(v, (text) => toOsd(parseSchema(text).normalize()));
}

function runPrune(v: Vector): Result {
  return runSchemaProducing(v, (text) => toOsd(parseSchema(text).prune()));
}

function runIsEmpty(v: Vector): Result {
  const schema = parseSchema(v.input.schema as string);
  const actual = schema.isEmpty();
  const expected = v.expect.empty as boolean;
  if (actual !== expected) return fail(`expected empty=${String(expected)}, got ${String(actual)}`);
  return pass();
}

function runCompatibleWith(v: Vector): Result {
  const a = parseSchema(v.input.a as string);
  const b = parseSchema(v.input.b as string);
  const actual = a.compatibleWith(b);
  const expected = v.expect.result as boolean;
  if (actual !== expected) return fail(`expected compatible=${String(expected)}, got ${String(actual)}`);
  return pass();
}

function runEquivalent(v: Vector): Result {
  const a = parseSchema(v.input.a as string);
  const b = parseSchema(v.input.b as string);
  const actual = a.equivalent(b);
  const expected = v.expect.result as boolean;
  if (actual !== expected) return fail(`expected equivalent=${String(expected)}, got ${String(actual)}`);
  return pass();
}

function runExtract(v: Vector): Result {
  const inp = v.input;
  const expect = v.expect;
  const schema = parseSchema(inp.schema as string);
  const keep = inp.keep as string[];
  if (expect.ok === true) {
    let actual: string;
    try {
      actual = toOsd(opsExtract(schema, keep));
    } catch (e) {
      return fail(`expected success, threw: ${errorMessage(e)}`);
    }
    if (compareSchema(actual, expect.schema as string, "exact")) return pass();
    return fail("extracted schema does not match expected");
  }
  try {
    opsExtract(schema, keep);
  } catch {
    return pass();
  }
  return fail("expected failure, extract succeeded");
}

function runLint(v: Vector): Result {
  const schema = parseSchema(v.input.schema as string);
  const findings = opsLint(schema);
  const expect = v.expect;
  const expectOk = expect.ok as boolean;
  // "ok" is false only when a *warning*-severity finding exists --
  // info-severity findings (e.g. "any-field") are advisory only and MUST
  // NOT flip ok to false (docs/06-schema-algebra.md Sec6.11, confirmed
  // against lint/basic/any-field-is-informational-not-a-warning, which
  // expects ok:true alongside a non-empty findings list). This differs
  // from Track 1's runner.ts, whose 19 real fixtures never happen to
  // exercise an info-only case, so its `findings.length === 0` shortcut
  // for ok was never wrong there -- it would be here.
  const actualOk = findings.every((f) => f.severity !== "warning");
  if (actualOk !== expectOk) {
    return fail(`expected ok=${String(expectOk)}, got ${String(actualOk)}`);
  }
  // Sec8.5.3: findings compared as a set of {code, location} -- mirrors
  // Python's vector_runner.py, which (like this driver) compares by
  // location only, the discriminating field in practice (mirrors
  // runner.ts's Track-1 lint driver's own location-set comparison too).
  const expLocs = new Set((expect.findings as { location: string }[]).map((f) => f.location));
  const actLocs = new Set(findings.map((f) => f.location));
  if (!setsEqual(expLocs, actLocs)) {
    return fail(`finding locations differ: expected ${setStr(expLocs)}, got ${setStr(actLocs)}`);
  }
  return pass();
}

function runInferCommon(v: Vector, withReport: boolean): Result {
  const inp = v.input;
  const expect = v.expect;
  const samples = (inp.samples as string[]).map((s) => new Doc(readOml(s)));
  const allowAny = inp.allow_any === true;
  let schema;
  try {
    schema = withReport ? inferWithReport(samples, { allowAny }).schema : infer(samples, { allowAny });
  } catch (e) {
    if (expect.ok === false) return pass();
    return fail(`expected success, threw: ${errorMessage(e)}`);
  }
  if (expect.ok !== true) return fail("expected failure, infer succeeded");
  const expectedSchema = parseSchema(expect.schema as string);
  // isomorphic, not exact: infer's generated record names are
  // implementation-derived, never canonical (mirrors runner.ts's runInfer
  // and Python's vector_runner.py's _run_infer).
  if (compareSchema(toOsd(schema), toOsd(expectedSchema), "isomorphic")) return pass();
  return fail("inferred schema is not isomorphic to expected");
}

function runInfer(v: Vector): Result {
  return runInferCommon(v, false);
}

function runInferWithReport(v: Vector): Result {
  return runInferCommon(v, true);
}

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function setStr<T>(s: Set<T>): string {
  return `{${[...s].map((x) => JSON.stringify(x)).join(", ")}}`;
}

const RUNNERS: Record<string, (v: Vector) => Result> = {
  parse: runParse,
  parse_schema: runParseSchema,
  validate: runValidate,
  materialize: runMaterialize,
  write: runWrite,
  normalize: runNormalize,
  prune: runPrune,
  is_empty: runIsEmpty,
  compatible_with: runCompatibleWith,
  equivalent: runEquivalent,
  extract: runExtract,
  infer: runInfer,
  infer_with_report: runInferWithReport,
  lint: runLint,
};

// ---------------------------------------------------------------------------
// Vector discovery + dispatch
// ---------------------------------------------------------------------------

function walkJsonFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      out.push(...walkJsonFiles(p));
    } else if (name.endsWith(".json")) {
      out.push(p);
    }
  }
  return out;
}

export function iterVectors(suiteDir: string = VECTOR_SUITE_DIR): Vector[] {
  const vectors: Vector[] = [];
  for (const file of walkJsonFiles(suiteDir)) {
    // Vector files can themselves contain a bare large-integer JSON
    // literal in `expect.document` (e.g. the issue #98 target vector,
    // document-model/limits/integer-beyond-fixed-width-still-parses-
    // under-default-limit) -- a plain JSON.parse here would silently
    // round it to float64 before decodeScalar ever saw it, corrupting
    // the very expectation being checked against. Reuse json.ts's
    // tag-and-revive fix so an integer-shaped literal survives as a
    // native bigint (see decodeScalar's "integer" case below).
    const raw = readFileSync(file, "utf-8");
    const data = JSON.parse(tagIntegerLiterals(raw), bigintReviver) as { vectors?: Vector[] };
    vectors.push(...(data.vectors ?? []));
  }
  return vectors;
}

export function runVector(v: Vector): Result {
  const fn = RUNNERS[v.operation];
  if (fn === undefined) {
    return skip(`no driver wired up yet for operation ${JSON.stringify(v.operation)}`);
  }
  try {
    return fn(v);
  } catch (e) {
    // A driver crash is a fail, never silently swallowed.
    return fail(`driver threw ${errorMessage(e)}`);
  }
}

function exists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

export function main(suiteDir: string = VECTOR_SUITE_DIR): number {
  if (!exists(suiteDir) || !statSync(suiteDir).isDirectory()) {
    console.error(
      `no test-suite vectors found at ${suiteDir} -- has the vendor/omnist-spec ` +
        "submodule been checked out? (git submodule update --init)",
    );
    return 2;
  }

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const v of iterVectors(suiteDir)) {
    const { status, message } = runVector(v);
    console.log(`[${status.toUpperCase()}] ${v.name}: ${message}`);
    if (status === "pass") passed += 1;
    else if (status === "skip") skipped += 1;
    else failed += 1;
  }

  const total = passed + failed + skipped;
  console.log(
    `\n${passed} passed, ${failed} failed, ${skipped} skipped (of ${total} vectors) -- ` +
      "diagnostics compared in code-agnostic mode (Sec8.5.2 rule 4)",
  );
  return failed ? 1 : 0;
}

/* c8 ignore start -- entry point, not importable behavior */
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
/* c8 ignore stop */
