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
 * compares validate/materialize diagnostics in code-agnostic mode: `ok` plus the *set* of `path`s,
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
 * **4 (AMENDED, v0.18.0-beta sweep). Structured diagnostics on syntax
 * errors.** The paragraph below was written when no syntax error carried
 * structure, and the runner skipped every such vector. Since issue #108
 * OML/OSD lexical and parse errors carry a `line:col` `path` and a `parse.*`
 * `code`, and the data-XML profile refusals carry `format.*` codes with path
 * `$`. `compareThrownDiagnostics` therefore skips ONLY when the thrown error
 * lacks a `path` and/or `code`, and otherwise compares path and code for real.
 * Original text follows.
 *
 * **4. Structured diagnostics on syntax errors.** (Historical: written when
 * no OML error carried structure; `readOml("a: [1, 2")` now carries
 * `parse.unexpected-token` and a `line:col` path.) Verified directly at the
 * time: an OML syntax error threw `ParseError` with `.errors` empty -- `src/errors.ts`'s documented asymmetry
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
import { spawnSync } from "node:child_process";

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
const REPO_ROOT = path.resolve(HERE, "..", "..");
const VECTOR_SUITE_DIR = path.resolve(REPO_ROOT, "vendor", "omnist-spec", "test-suite");
const CLI_PATH = path.resolve(REPO_ROOT, "src", "cli.ts");

// Allowlist of `declared_max_*` keys (test-suite/README.md, "declared-limit
// keys"). A vector carrying one was written against a vector-local limit,
// not this port's default, so it MUST be skipped -- never run against the
// wrong threshold, which either fails for the wrong reason or (worse)
// passes without exercising the boundary. Re-check this list against the
// README's on every spec bump: a key missing here is silently treated as
// an ordinary vector.
const LIMIT_KEYS = [
  "declared_max_depth",
  "declared_max_nodes",
  "declared_max_int_digits",
  "declared_max_alias_expansion", // Sec2.4.1 D-18; enforced by no port yet (ledger DIV-3)
] as const;

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
  // Defensive: every call site in this file only calls asDiagnostics after
  // its own expect.diagnostics !== undefined check (or, for
  // compareThrownDiagnostics call sites, the caller already made the same
  // check), so v is never actually undefined here in practice; kept as a
  // backstop against a future call site that forgets the guard.
  /* v8 ignore next */
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

/**
 * A reader threw and the vector expects `ok: false` with `diagnostics`.
 * Compare the (path, code) the error itself carries against the expected
 * set (Sec8.5.2: paths compared as a set, message text never). SKIP only
 * when the error genuinely lacks the structure the vector compares -- no
 * `path` and/or no `code` (a bare message, e.g. a JSON/TOML/YAML codec
 * syntax error or a schema-conformance failure raised as a plain
 * ParseError). Whatever the error does carry is verified, never assumed.
 */
function compareThrownDiagnostics(e: unknown, expected: readonly Diagnostic[]): Result {
  // The thrown error's own class names the reason (never a guess from the vector).
  const kind = (e as object).constructor.name;
  const err = e as { path?: string; code?: string };
  if (err.path === undefined || err.code === undefined) {
    // E-20 "not yet implemented" (no ledger entry required): the diagnostic
    // values exist in the message text but not as structured `code`/`path`
    // fields. Tracked by omnist-ts#149 for SchemaError (the schema.* codes of
    // Sec8.3.3/Sec8.4.1: 20 vectors today); any other error class that reaches
    // this branch is skipped for the same reason, named honestly, uncited.
    const tracked = kind === "SchemaError" ? " (omnist-ts#149)" : "";
    return skip(`not yet implemented -- ${kind} carries no structured code/path for this diagnostic${tracked}`);
  }
  const expPaths = paths(expected);
  const actPaths = new Set([err.path]);
  if (!setsEqual(expPaths, actPaths)) {
    return fail(`diagnostic paths differ: expected ${setStr(expPaths)}, got ${setStr(actPaths)}`);
  }
  const expCodes = new Set(expected.map((d) => d.code));
  if (!setsEqual(expCodes, new Set([err.code]))) {
    return fail(`diagnostic codes differ: expected ${setStr(expCodes)}, got ${setStr(new Set([err.code]))}`);
  }
  return pass();
}

/**
 * E-27 / D-14 (`omnist-spec` Sec8.5.3, Sec2.5): a `bytes_hex` vector's
 * input is bytes, not text a JSON vector file can carry, and D-14 binds at
 * this package's one byte-oriented entry point: its CLI (`src/cli.ts`'s
 * `readInput`/`decodeStrictUtf8` -- see that file's doc comment). Every
 * library reader takes a `string`, which is UTF-16 and cannot hold
 * ill-formed UTF-8 at all, so presenting these bytes to one instead --
 * the shortcut every other vector in this runner takes -- would either
 * throw a `TypeError` on `undefined` (there is no `text` field) or, worse,
 * require decoding the bytes into a string first, which is exactly the
 * "decode with replacement" E-27 forbids (Node's own `Buffer#toString`/
 * `fs.readFileSync(path, "utf-8")` substitute `U+FFFD` rather than fail --
 * confirmed live, see `src/cli.ts`'s `decodeStrictUtf8` doc comment). So
 * these 14 vectors alone are driven through a real CLI subprocess, fed the
 * raw bytes on stdin -- the same path `main()`'s real-fd-0 branch takes,
 * untouched by the in-process `opts.stdin` string-injection seam used
 * everywhere else in this codebase (that seam can't carry invalid UTF-8;
 * a JS string is always well-formed UTF-16, decoded upstream of it).
 */
function runCli(args: readonly string[], stdinBytes: Uint8Array): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["--import", "tsx", CLI_PATH, ...args], {
    input: Buffer.from(stdinBytes),
    cwd: REPO_ROOT,
    encoding: "utf-8",
  });
  // Defensive: result.status is only ever null if the child was killed by
  // a signal (never happens here -- every bytes_hex vector's CLI
  // invocation runs to a normal exit), and result.stdout/.stderr are only
  // ever undefined if spawnSync itself failed to launch the child or
  // "encoding" were omitted, neither of which any real vector exercises.
  /* v8 ignore next */
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Parses this CLI's own `--json` error payload (`jsonValidateErrors` in
 * `src/cli.ts`): `{ ok, message, errors: [{ path, code, message }] }`. */
function parseCliJsonError(stdout: string): { path?: string; code?: string } | undefined {
  try {
    const payload = JSON.parse(stdout) as { errors?: { path?: string; code?: string }[] };
    return payload.errors?.[0];
  } catch {
    return undefined;
  }
}

function runParseBytesHex(v: Vector): Result {
  const inp = v.input;
  const expect = v.expect;
  const bytes = hexToBytes(inp.bytes_hex as string);
  const fmt = inp.format as string;
  // `convert --from X --to oml` reads via the exact same `readInput` path
  // `convert`/`format`/`schema format` use for a real file (Sec8.5.3's
  // driver-through-the-CLI requirement), and re-expressing the result as
  // OML lets a *successful* read be checked against `expect.document`
  // through this runner's own `readOml`/`decodeDocument`/`Doc.equals`
  // machinery -- the CLI's `--json` success payload for `convert` is just
  // the written text, not a vector-comparable encoding, so there is
  // nothing to gain by parsing it directly instead.
  const args = fmt === "oml" ? ["format", "-", "--json"] : ["convert", "--from", fmt, "--to", "oml", "-", "--json"];
  const { code, stdout, stderr } = runCli(args, bytes);
  if (expect.ok === true) {
    if (code !== 0) {
      return fail(`expected success, CLI exited ${code}: ${stderr || stdout}`);
    }
    let node: Node;
    try {
      node = readOml(stdout);
    } catch (e) {
      // Defensive: the CLI's own OML writer only ever emits OML this
      // package's own reader accepts.
      /* v8 ignore next */
      return fail(`CLI succeeded but its OML output did not parse back: ${errorMessage(e)}`);
    }
    if (expect.document !== undefined) {
      const expected = decodeDocument(expect.document as EncodedNode);
      if (!new Doc(node).equals(new Doc(expected))) {
        return fail("parsed document does not match expected");
      }
    }
    return pass();
  }
  // expect.ok === false
  if (code === 0) {
    return fail("expected failure, CLI exited 0");
  }
  if (expect.diagnostics !== undefined) {
    const err = parseCliJsonError(stdout);
    if (err?.path === undefined || err?.code === undefined) {
      return fail(`CLI's --json error payload carried no structured path/code: ${stdout || stderr}`);
    }
    const expected = asDiagnostics(expect.diagnostics);
    const expPaths = paths(expected);
    if (!setsEqual(expPaths, new Set([err.path]))) {
      return fail(`diagnostic paths differ: expected ${setStr(expPaths)}, got {${JSON.stringify(err.path)}}`);
    }
    const expCodes = new Set(expected.map((d) => d.code));
    if (!setsEqual(expCodes, new Set([err.code]))) {
      return fail(`diagnostic codes differ: expected ${setStr(expCodes)}, got {${JSON.stringify(err.code)}}`);
    }
  }
  return pass();
}

function runParseSchemaBytesHex(v: Vector): Result {
  const expect = v.expect;
  const bytes = hexToBytes(v.input.bytes_hex as string);
  const { code, stdout, stderr } = runCli(["schema", "format", "-", "--json"], bytes);
  if (expect.ok === true) {
    // Defensive: a failing CLI invocation always writes its error to
    // stderr in this codebase (main()'s own catch, both the UsageError
    // and OmnistError branches) -- the "|| stdout" fallback covers a
    // hypothetical stderr-silent failure no real vector produces.
    /* v8 ignore next */
    if (code !== 0) return fail(`expected success, CLI exited ${code}: ${stderr || stdout}`);
    return pass();
  }
  if (code === 0) return fail("expected failure, CLI exited 0");
  if (expect.diagnostics !== undefined) {
    const err = parseCliJsonError(stdout);
    // jsonError (src/cli.ts) only ever emits an error object with both
    // `path` and `code` set (from `.errors`, whose `OmnistIssue` shape
    // requires both, or from the top-level-code/path fallback, which
    // requires both before using either) or with neither (the final
    // fallback, `errors: []`, caught above as `err === undefined`) -- a
    // path-without-code or code-without-path payload cannot come from
    // this CLI's own error rendering, so only one side of this check is
    // reachable through a real subprocess run.
    /* v8 ignore next */
    if (err?.path === undefined || err?.code === undefined) {
      return fail(`CLI's --json error payload carried no structured path/code: ${stdout || stderr}`);
    }
    const expected = asDiagnostics(expect.diagnostics);
    const expPaths = paths(expected);
    if (!setsEqual(expPaths, new Set([err.path]))) {
      return fail(`diagnostic paths differ: expected ${setStr(expPaths)}, got {${JSON.stringify(err.path)}}`);
    }
    const expCodes = new Set(expected.map((d) => d.code));
    if (!setsEqual(expCodes, new Set([err.code]))) {
      return fail(`diagnostic codes differ: expected ${setStr(expCodes)}, got {${JSON.stringify(err.code)}}`);
    }
  }
  return pass();
}

function runParse(v: Vector): Result {
  const inp = v.input;
  if (inp.bytes_hex !== undefined) {
    return runParseBytesHex(v);
  }
  if (inp.declared_max_alias_expansion !== undefined) {
    // Sec8.5.5 E-20 "not yet implemented": D-18 (alias expansion factor) is
    // not enforced here, and there is no configuration surface to set the
    // vector's declared limit on either. Cites DIV-3 (docs/09 Sec9.4), the
    // spec's own record of the rollout gap. All six vectors in
    // formats-yaml/alias-expansion.json carry this key, so all six skip
    // rather than some reporting a false pass at this port's own default.
    return skip(
      "not yet implemented -- D-18 alias expansion limit is not enforced and has no runtime configuration surface (DIV-3)",
    );
  }
  if (LIMIT_KEYS.some((k) => inp[k] !== undefined)) {
    return skip("not yet implemented -- omnist-ts's safety limits are compile-time constants, no runtime configuration surface");
  }
  const expect = v.expect;
  const fmt = inp.format as string;
  const text = inp.text as string;
  // Read-time codec diagnostics (issue #123/D-3: format.attribute-dropped/
  // format.namespace-dropped) are only ever emitted by readXml today, via
  // this same WriteReport-shaped accumulator readXml's ReadXmlOptions.report
  // expects -- passed unconditionally here since every other reader simply
  // ignores an opts object it doesn't recognize (registry.ts's Format.read
  // takes `opts?: unknown`, format-specific).
  const report = new WriteReport();
  let node: Node;
  try {
    node = getFormat(fmt).read(text, { report }) as Node;
  } catch (e) {
    if (expect.ok === false) {
      if (expect.diagnostics !== undefined) {
        return compareThrownDiagnostics(e, asDiagnostics(expect.diagnostics));
      }
      return pass();
    }
    return fail(`expected success, threw: ${errorMessage(e)}`);
  }
  if (expect.ok !== true) {
    return fail("expected failure, parse succeeded");
  }
  const expected = decodeDocument(expect.document as EncodedNode);
  if (!new Doc(node).equals(new Doc(expected))) {
    return fail("parsed document does not match expected");
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

function runParseSchema(v: Vector): Result {
  const expect = v.expect;
  if (v.input.bytes_hex !== undefined) {
    return runParseSchemaBytesHex(v);
  }
  let schema: ReturnType<typeof parseSchema>;
  try {
    schema = parseSchema(v.input.text as string);
  } catch (e) {
    if (expect.ok === false) {
      if (expect.diagnostics !== undefined) {
        return compareThrownDiagnostics(e, asDiagnostics(expect.diagnostics));
      }
      return pass();
    }
    return fail(`expected success, threw: ${errorMessage(e)}`);
  }
  if (expect.ok !== true) return fail("expected failure, parse_schema succeeded");
  // OSD-15 (Sec5.9): the `osd-grammar/canonical-output/*` vectors pin the
  // *writer*'s canonical escaping, not just that parsing succeeded -- the
  // vector's `expect.schema` is the exact OSD text `toOsd` must reproduce
  // from what `parseSchema` built. Not every parse_schema vector carries
  // this field (most only assert `ok`), so it's compared only when present.
  if (expect.schema !== undefined) {
    let written: string;
    // Defensive: OSD-14 (Sec5.9) means toOsd can only ever throw for a
    // label with a C0 control character, and parseSchema -- the only way
    // a real vector schema reaches this driver -- can never build one
    // (Sec5.3.1 bans the raw byte in a string body, escape context
    // included, so it never survives tokenization). The only way to
    // construct such a Schema is the builder API (src/schema.ts field/
    // record/schema), which no vector-driven code path uses -- see
    // test/osd.test.ts's "OSD-14" describe block for the tests that
    // exercise this throw for real. Unreachable through this driver by
    // construction, not by omission; kept as a backstop.
    /* v8 ignore start */
    try {
      written = toOsd(schema);
    } catch (e) {
      return fail("expected write to succeed, threw: " + errorMessage(e));
    }
    /* v8 ignore stop */
    if (!compareSchemaTextExact(written, expect.schema as string)) {
      return fail("written schema does not match expected byte for byte: got " + JSON.stringify(written));
    }
  }
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
  if (expect.ok === false && expect.diagnostics !== undefined) {
    const expected = asDiagnostics(expect.diagnostics);
    const actual = result.errors as unknown as Diagnostic[];
    const expPaths = paths(expected);
    const actPaths = paths(actual);
    if (!setsEqual(expPaths, actPaths)) {
      return fail(`diagnostic paths differ: expected ${setStr(expPaths)}, got ${setStr(actPaths)}`);
    }
    // schema.ts's validate() always attaches a code to every
    // ValidationResult error (validate.type-mismatch, validate.cardinality,
    // ...) -- compared here for real now; it previously was not (paths
    // only), confirmed by mutation on a scratch copy of the vendored suite.
    const expCodes = new Set(expected.map((d) => d.code));
    const actCodes = new Set(actual.map((d) => d.code));
    if (!setsEqual(expCodes, actCodes)) {
      return fail(`diagnostic codes differ: expected ${setStr(expCodes)}, got ${setStr(actCodes)}`);
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
      const expected = asDiagnostics(expect.diagnostics);
      const expPaths = paths(expected);
      const actPaths = paths(issues);
      if (!setsEqual(expPaths, actPaths)) {
        return fail(`diagnostic paths differ: expected ${setStr(expPaths)}, got ${setStr(actPaths)}`);
      }
      // Every OmnistIssue materialize's ParseError.errors carries (deserialize.ts)
      // has a non-optional `code` -- compared here for real now; it
      // previously was not (paths only), confirmed by mutation on a
      // scratch copy of the vendored suite (materialize/rejections/
      // quoted-numeral-string-does-not-upgrade-to-integer's code mutated
      // to garbage still reported a false pass before this fix).
      const expCodes = new Set(expected.map((d) => d.code));
      const actCodes = new Set(issues.map((d) => d.code));
      if (!setsEqual(expCodes, actCodes)) {
        return fail(`diagnostic codes differ: expected ${setStr(expCodes)}, got ${setStr(actCodes)}`);
      }
    }
    return pass();
  }
  return fail("expected failure, materialize succeeded");
}

/**
 * Sec8.5.3: strip whitespace strictly between '>' and '<' before comparing
 * a write vector's expected/actual text for XML. Safe because this library
 * never produces mixed-content XML (Document model Sec2: a node has either
 * child edges or one scalar value, never both), so this whitespace can
 * only ever be inter-tag formatting, never real text data.
 */
function normalizeXmlWhitespace(text: string): string {
  return text.replace(/>\s+</g, "><");
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
    if (expect.ok === false) {
      // Sec8.5.3: several formats-json/formats-toml/formats-xml write
      // failure vectors carry `expect.diagnostics` (write.unsupported-value,
      // format.multiple-roots) -- compared for real now that WriteError
      // carries `code`/`path` at these throw sites (src/formats/json.ts,
      // toml.ts, xml.ts).
      if (expect.diagnostics !== undefined) {
        return compareThrownDiagnostics(e, asDiagnostics(expect.diagnostics));
      }
      return pass();
    }
    return fail(`expected success, threw: ${errorMessage(e)}`);
  }
  if (expect.ok !== true) return fail("expected failure, write succeeded");
  if (expect.text !== undefined) {
    let got = text.trim();
    let want = (expect.text as string).trim();
    if (fmt === "xml") {
      got = normalizeXmlWhitespace(got);
      want = normalizeXmlWhitespace(want);
    }
    if (got !== want) {
      return fail(`expected text ${JSON.stringify(expect.text)}, got ${JSON.stringify(text.trim())}`);
    }
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

/**
 * Sec8.5.3: normalize/prune/extract's `expect.schema` is documented as
 * "compared byte for byte per Sec5.9's canonical-output requirement" --
 * not a structural re-parse. `compareSchema(..., "exact")` re-parses both
 * sides and compares Schema *models*, which is the right tool for
 * `parse_schema`'s bare `{ok}` vectors (no canonical-text promise) but the
 * wrong one here: it cannot catch a writer that is structurally correct
 * but formats differently from the canonical form (verified: changing
 * toOsd's default indent from 4 to 2 spaces on a scratch copy left every
 * normalize/prune/extract vector green under the structural comparison).
 * Exact string equality is what Sec5.9's canonical-output promise
 * actually requires; the vector's own `expect.schema` text is already in
 * toOsd's canonical form (verified against the vendored vectors), so no
 * trimming or normalization is applied on either side.
 */
function compareSchemaTextExact(actual: string, expected: string): boolean {
  return actual === expected;
}

function runSchemaProducing(v: Vector, fn: (text: string) => string): Result {
  const schema = fn(v.input.schema as string);
  if (compareSchemaTextExact(schema, v.expect.schema as string)) return pass();
  return fail(`output schema does not match expected byte for byte: got ${JSON.stringify(schema)}`);
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
    // Sec6.9 (docs/06-schema-algebra.md): a satisfiable extract result is
    // run through prune then normalize and "lands in the same canonical
    // form normalize produces everywhere else -- including its canonical
    // output order", so this is the same byte-for-byte promise
    // normalize/prune's own `expect.schema` carries, not a structural one.
    if (compareSchemaTextExact(actual, expect.schema as string)) return pass();
    return fail(`extracted schema does not match expected byte for byte: got ${JSON.stringify(actual)}`);
  }
  try {
    opsExtract(schema, keep);
  } catch (e) {
    // A-11: extract fails via SchemaError with no structured code/path at
    // this throw site today (unlike osd.ts's lexical errors) -- the same
    // "genuinely lacks the structure" shape compareThrownDiagnostics
    // already skips for, applied here since this driver doesn't route
    // through that helper.
    if (expect.diagnostics !== undefined) {
      const err = e as { path?: string; code?: string };
      // Defensive: src/ops/extract.ts's one reachable throw site
      // (A-11) always attaches `algebra.extract-invalidates-root` and a
      // record-name path now; the other SchemaError it can throw (no
      // recorded offender) is itself unreachable there, structurally
      // seeded by step 1 before any propagation -- see that file's own
      // `/* v8 ignore */` comment. Kept as a backstop in case that
      // invariant ever changes.
      /* v8 ignore next 3 */
      if (err.path === undefined || err.code === undefined) {
        return skip("not yet implemented -- SchemaError carries no structured code/path for extract's A-11 failure (omnist-ts#149)");
      }
      const expected = asDiagnostics(expect.diagnostics);
      const expPaths = paths(expected);
      if (!setsEqual(expPaths, new Set([err.path]))) {
        return fail(`diagnostic paths differ: expected ${setStr(expPaths)}, got {${JSON.stringify(err.path)}}`);
      }
      const expCodes = new Set(expected.map((d) => d.code));
      if (!setsEqual(expCodes, new Set([err.code]))) {
        return fail(`diagnostic codes differ: expected ${setStr(expCodes)}, got {${JSON.stringify(err.code)}}`);
      }
    }
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
  // Sec8.5.3: findings compared as a set of {code, location} (message
  // text never compared, per Sec8.5.2 rule 1). Verified by mutation that
  // `code` matters and was not actually being compared: every one of this
  // suite's 5 lint vectors happens to have a unique `location`, so a
  // location-only comparison (the previous version of this driver)
  // reported a false pass when a vector's expected `code` was mutated to
  // something wrong -- confirmed, then reverted, on a scratch copy of the
  // vendored suite.
  const key = (f: { code: string; location: string }): string => `${f.code}\u0000${f.location}`;
  const expFindings = new Set((expect.findings as { code: string; location: string }[]).map(key));
  const actFindings = new Set(findings.map(key));
  if (!setsEqual(expFindings, actFindings)) {
    return fail(`findings differ: expected ${setStr(expFindings)}, got ${setStr(actFindings)}`);
  }
  return pass();
}

function fallbackSetStr(fallbacks: readonly { location: string; reason: string }[]): string {
  return setStr(new Set(fallbacks.map((f) => JSON.stringify(f))));
}

function runInferCommon(v: Vector, withReport: boolean): Result {
  const inp = v.input;
  const expect = v.expect;
  const samples = (inp.samples as string[]).map((s) => new Doc(readOml(s)));
  const allowAny = inp.allow_any === true;
  let schema;
  let fallbacks: readonly { location: string; reason: string }[] = [];
  try {
    if (withReport) {
      const result = inferWithReport(samples, { allowAny });
      schema = result.schema;
      fallbacks = result.report;
    } else {
      schema = infer(samples, { allowAny });
    }
  } catch (e) {
    if (expect.ok === false) {
      if (expect.diagnostics !== undefined) {
        return compareThrownDiagnostics(e, asDiagnostics(expect.diagnostics));
      }
      return pass();
    }
    return fail(`expected success, threw: ${errorMessage(e)}`);
  }
  if (expect.ok !== true) return fail("expected failure, infer succeeded");
  const expectedSchema = parseSchema(expect.schema as string);
  // isomorphic, not exact: infer's generated record names are
  // implementation-derived, never canonical (mirrors runner.ts's runInfer
  // and Python's vector_runner.py's _run_infer).
  if (!compareSchema(toOsd(schema), toOsd(expectedSchema), "isomorphic")) {
    return fail("inferred schema is not isomorphic to expected");
  }
  // Sec8.5.3: infer_with_report's `fallbacks` is "always present on
  // success", compared as a set the same way `lint`'s findings are --
  // order is never significant (S-21's opening order is a fixpoint-walk
  // artifact, not a promise).
  if (expect.fallbacks !== undefined) {
    const expected = expect.fallbacks as { location: string; reason: string }[];
    const expSet = new Set(expected.map((f) => JSON.stringify(f)));
    const actSet = new Set(fallbacks.map((f) => JSON.stringify(f)));
    if (!setsEqual(expSet, actSet)) {
      return fail(`fallbacks differ: expected ${fallbackSetStr(expected)}, got ${fallbackSetStr(fallbacks)}`);
    }
  }
  return pass();
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
      "diagnostic paths always compared, codes compared where the error carries one (Sec8.5.2)",
  );
  return failed ? 1 : 0;
}

/* c8 ignore start -- entry point, not importable behavior */
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
/* c8 ignore stop */
