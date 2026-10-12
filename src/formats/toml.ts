/**
 * TOML codec over the canonical Document (edge-list) model. Ported from the
 * TOML section of omnist/formats.py.
 *
 * TOML goes through the same JSON-shaped grouping (grouped()) as JSON --
 * same-label edges collapse into an array-of-tables, a single occurrence
 * stays bare (see omnist-spec Sec7.3, writing).
 *
 * A null-valued leaf fails to write unconditionally (TOML has no `null`,
 * and dropping the edge would leave no trace): `write.unsupported-value`.
 * Pass report to inspect adjustments, or strict: true to throw on any. See
 * src/report.ts. Unlike JSON, TOML's own grammar accepts
 * `nan`/`inf`/`-inf` float literals directly, so (also unlike JSON) writing
 * a NaN/Infinity leaf needs no adjustment at all.
 *
 * Uses `smol-toml` for both parsing and stringifying. `smol-toml`'s
 * `TomlDate` subclasses `Date` and tags which of TOML's three temporal
 * kinds (date / local-or-offset datetime / local time) a value came from --
 * that's what lets read/write round-trip a date or datetime natively
 * (see convertTomlDates/toTomlDate below), same as Python's tomllib/
 * tomli_w round-trip real date/datetime/time objects. TOML's own bare
 * `time` literal has no analogue in this port's Document model though
 * (`Scalar` only maps `date`/`datetime` onto `Date` -- see src/temporal.ts's
 * file-top comment: "a time scalar stays a plain string at the Document
 * layer, there is nothing to convert it to"), so a TOML time literal reads
 * as a plain ISO-ish string and writes back out as a TOML string, not a
 * TOML time literal. That's an intentional, pre-existing asymmetry with
 * Python's `datetime.time`, not a smol-toml gap.
 */

import { parse as parseToml, stringify as stringifyToml, TomlDate, type TomlError } from "smol-toml";
import { buildNodeWithLimits, findLeaf, grouped, hasInterleaving, type Node } from "../document.js";
import {
  DEFAULT_MAX_DEPTH as MAX_DEPTH,
  intDigitsIssue,
  resolveLimits,
  type DocumentLimits,
  type ResolvedLimits,
} from "../limits.js";
import { EdgePaths } from "../paths.js";
import { checkEncodable } from "../encodable.js";
import { datetimeOffset, isoText, TimeValue, timeHasOffset, timeText } from "../temporal.js";
import { ParseError, WriteError } from "../errors.js";
import { finishWrite, WriteReport } from "../report.js";
import { parseDateToken, parseDatetimeToken, dateKind } from "../temporal.js";
import { materialize } from "../deserialize.js";
import type { Schema } from "../schema.js";
import { rejectSecondLeadingBom, stripLeadingBom } from "../bom.js";
import { codecSyntaxError, type CodecBlame } from "./codec-error.js";
import { checkInputSize } from "./input-size.js";

function checkWriteDepth(depth: number): void {
  // Originally a real, exercised backstop (issue #37): writeToml takes a
  // raw `Node`, a publicly exported type -- a caller can hand-build one
  // (or splice a subtree in via Doc.add()/Doc.set()) that exceeds
  // MAX_DEPTH without ever going through buildNode()'s own guard.
  //
  // Shadowed since D-3 (issue #123): writeToml/checkToml now call
  // hasInterleaving(node) -- document.ts, same MAX_DEPTH=200 threshold --
  // before stripNulls/toTomlValue ever run, and it must run against the
  // pre-strip node for correctness (see writeToml's own comment), so this
  // guard can no longer observably fire first. Kept anyway as defense in
  // depth against future refactors that change that ordering.
  /* v8 ignore start -- shadowed by hasInterleaving's identical guard, see above */
  if (depth > MAX_DEPTH) {
    throw new WriteError("nesting exceeds the maximum depth (" + String(MAX_DEPTH) + ")");
  }
  /* v8 ignore stop */
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

/** Stricter than isPlainObject above: only a literal {} or Object.create(null)
 * record counts, matching json.ts's isPlainRecord -- toTomlValue uses this
 * (not isPlainObject) so an arbitrary class instance is rejected as
 * unsupported rather than silently serialized via its own properties. */
function isPlainRecord(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** A TOML time literal has no calendar date. smol-toml's toISOString()
 * gives "HH:MM:SS.mmm" for it; trim a zero fraction, matching Python's
 * datetime.time.isoformat(). */
function timeOf(d: TomlDate): string {
  const iso = d.toISOString();
  return iso.endsWith(".000") ? iso.slice(0, -4) : iso;
}

/** A trailing literal "Z" isn't accepted by src/temporal.ts's offset
 * grammar (it only spells UTC as "+00:00"), so normalize before handing
 * the text to parseDatetimeToken. */
function normalizeOffset(iso: string): string {
  return iso.endsWith("Z") ? iso.slice(0, -1) + "+00:00" : iso;
}

/** Recursively replace every smol-toml TomlDate in a parsed TOML value with
 * this port's own Scalar form: a plain string for a bare time literal, or a
 * tagged Date (see temporal.ts) for a date/datetime literal -- so buildNode
 * never has to know smol-toml's TomlDate exists. */
function convertTomlDates(value: unknown): unknown {
  if (value instanceof TomlDate) {
    if (value.isTime()) return timeOf(value);
    // parseDateToken/parseDatetimeToken only return null for a calendar
    // that doesn't exist (e.g. day 30 in February); smol-toml's own parser
    // has already range-checked the literal by this point (TomlDate's
    // constructor rejects an invalid date -- see smol-toml's date.js), so
    // the fallback is defensive, not reachable from a text this
    // port's own parseToml call above accepted.
    if (value.isDate()) {
      /* v8 ignore next -- see the block comment above: unreachable. */
      return parseDateToken(value.toISOString()) ?? value;
    }
    const dt = parseDatetimeToken(normalizeOffset(value.toISOString()));
    /* v8 ignore next -- see the block comment above: unreachable. */
    if (dt === null) return value;
    // A local datetime (no offset in the source literal) parses to a Date
    // tagged "datetime" with no offset, which toTomlDate (below) writes back
    // as a local date-time (issue #26); an offset literal keeps its offset.
    return dt;
  }
  if (Array.isArray(value)) return value.map(convertTomlDates);
  if (isPlainObject(value)) {
    // Security (issue #32 follow-up): `value` here is smol-toml's own
    // parsed table, which smol-toml itself builds with a null prototype --
    // so a TOML `[__proto__]` table is a genuine own "__proto__" data
    // property on `value`, not the accessor. Copying it into a plain {}
    // via out[k] = v re-triggers the exact bug grouped() was hardened
    // against (see document.ts's issue #32 comment): out[k] = v for
    // k === "__proto__" invokes Object.prototype's [[Set]] accessor and
    // reassigns out's own prototype instead of creating an own property,
    // silently corrupting the result -- which is what previously made
    // readToml throw a spurious DocumentError on a `[__proto__]` table
    // (the corrupted root object failed buildNode's isPlainObject check
    // further downstream). Object.create(null) makes every key, including
    // "__proto__", an ordinary own property.
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [k, v] of Object.entries(value)) out[k] = convertTomlDates(v);
    return out;
  }
  return value;
}

/** Options accepted by readToml. */
/** Options for parsing TOML text into a Document node. */
export interface ReadTomlOptions extends DocumentLimits {
  /** Optional {@link Schema} for schema-directed materialization (spec §4). */
  schema?: Schema;
  /**
   * The largest input, in UTF-8 bytes, that is read at all (spec D-23,
   * Sec2.4.2): a larger input is refused with `document.limit.input-size` at
   * `$` before it is decoded or parsed; one of exactly this size is accepted.
   * A leading byte-order mark counts. Default 64 MiB; an integer of at least
   * 1, else a `RangeError`.
   */
  maxInputBytes?: number;
}

/**
 * Parse TOML text into a Document node.
 *
 * Integers beyond ±2^53-1 (Number.MAX_SAFE_INTEGER): TOML's spec
 * requires support for 64-bit signed integers, but this port's Document
 * model unifies Python's separate int/float onto a single JS `number`
 * (see schema.ts/document.ts), and JS numbers can't represent an integer
 * beyond 2^53-1 losslessly. smol-toml enforces this at parse time -- an
 * integer literal outside that range throws ("integer value cannot be
 * represented losslessly", confirmed during issue #8/PR #24's review) --
 * which surfaces here as a ParseError, same as any other malformed input.
 * This is accepted, not a bug: Python's tomllib/tomli_w support arbitrary-
 * precision integers because Python's own `int` does, but adding that here
 * would mean a parallel BigInt-shaped numeric pipeline throughout this
 * port, a structural change out of scope for the TOML codec alone (see
 * issue #25). Rejecting with a clear ParseError, rather than silently
 * losing precision, matches this port's numeric model everywhere else.
 */
// D-9 / D-28: smol-toml is called with { integersAsBigInt: true }, so an
// over-long decimal literal would become an enormous, exact `bigint`, and that
// conversion is superlinear in the digit count -- the cost the digit limit
// exists to bound. The builder checks every converted integer by value (so a
// hex, octal, binary or underscored literal is counted by what it denotes,
// D-28, and refused at its own Document path), and that is enough for a
// literal that is cheap to convert. A decimal literal longer than this is
// found in the text first, so it can be refused before smol-toml converts it.
const CHEAP_LITERAL = 64;

/**
 * Scan raw TOML text for a bare decimal integer-shaped token (not a float, a
 * date or part of a larger word) of more than `max` digits, underscores not
 * counted, and longer than {@link CHEAP_LITERAL}; skipping comments and
 * quoted scalars. Returns its offsets, sign included. A heuristic, not a
 * tokenizer: a token it finds is only ever a candidate.
 */
function findHugeDecimal(text: string, max: number): { start: number; end: number } | undefined {
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text.charAt(i);
    if (c === "#") {
      while (i < n && text.charAt(i) !== "\n") i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < n && text.charAt(i) !== quote) {
        if (quote === '"' && text.charAt(i) === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === "-" || c === "+" || (c >= "0" && c <= "9")) {
      let j = c === "-" || c === "+" ? i + 1 : i;
      const digitsStart = j;
      let underscores = 0;
      while (j < n && ((text.charAt(j) >= "0" && text.charAt(j) <= "9") || text.charAt(j) === "_")) {
        if (text.charAt(j) === "_") underscores++;
        j++;
      }
      const digits = j - digitsStart - underscores;
      const next = text.charAt(j);
      const isFloatOrDate = next === "." || next === "e" || next === "E" || next === "-" || next === ":";
      const isWordChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
      const precededByWord = i > 0 && isWordChar(text.charAt(i - 1));
      if (!isFloatOrDate && !precededByWord && digits > max && digits > CHEAP_LITERAL) {
        return { start: i, end: j };
      }
      i = j;
      continue;
    }
    i++;
  }
  return undefined;
}

/**
 * The Document path of the literal found by {@link findHugeDecimal}, without
 * converting it: the same text is parsed with the literal replaced, offset for
 * offset, by a quoted string no value in the text equals, and the string's
 * path is looked up in the resulting Document. `undefined` when the candidate
 * was no value (a bare key made of digits) or the text fails for another
 * reason -- the ordinary parse that follows then reports the truth.
 */
function hugeDecimalPath(text: string, at: { start: number; end: number }, limits: ResolvedLimits): string | undefined {
  const len = at.end - at.start;
  let k = 0;
  while (text.includes("omnist-overlong-" + String(k) + "-")) k++;
  const content = ("omnist-overlong-" + String(k) + "-").padEnd(len - 2, "x");
  const defused = text.slice(0, at.start) + '"' + content + '"' + text.slice(at.end);
  try {
    const node = buildNodeWithLimits(convertTomlDates(parseToml(defused, { integersAsBigInt: true })), limits);
    return findLeaf(node, (leaf) => leaf === content);
  } catch {
    return undefined;
  }
}

/** Parses TOML text into a Document node (spec §4). */
export function readToml(text: string, opts: ReadTomlOptions = {}): Node {
  const limits = resolveLimits(opts);
  checkInputSize(text, opts.maxInputBytes); // D-23: first, the BOM's bytes counted
  text = stripLeadingBom(text); // D-15: one leading U+FEFF
  rejectSecondLeadingBom(text, "TOML"); // D-21: a second one is an error
  const huge = findHugeDecimal(text, limits.maxIntDigits);
  if (huge !== undefined) {
    const at = hugeDecimalPath(text, huge, limits);
    if (at !== undefined) {
      const issue = intDigitsIssue(limits.maxIntDigits, at);
      throw new ParseError(issue.message, [], issue.code, issue.path);
    }
  }
  let parsed: unknown;
  try {
    parsed = parseToml(text, { integersAsBigInt: true });
  } catch (exc) {
    // smol-toml's parse always throws a TomlError (an Error instance) on
    // malformed input, never a bare value, so the non-Error branch below
    // is a defensive fallback that's never actually reached -- same
    // convention as json.ts's readJson catch.
    /* v8 ignore next */
    const message = exc instanceof Error ? exc.message : String(exc);
    // smol-toml's TomlError carries a 1-based `line` and `column` (UTF-16 units).
    // Every TomlError sets both (smol-toml's constructor), so no fallback.
    const e = exc as { line: number; column: number };
    const at: CodecBlame = { line: e.line, col: e.column };
    throw codecSyntaxError("TOML", message.split(String.fromCharCode(10))[0] as string, text, at);
  }
  const node = buildNodeWithLimits(convertTomlDates(parsed), limits);
  if (opts.schema === undefined) return node;
  return materialize(node, opts.schema) as Node;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** issue #127: writing a null-valued leaf to TOML (which has no null
 * token) now fails unconditionally, rather than silently dropping the
 * edge and warning -- unlike every other codec adjustment, there is no
 * substitute value to fall back to for a dropped edge, only its absence,
 * and reading the output back leaves zero trace the edge ever existed
 * (the same "no safe substitute" principle as the label/NaN fixes in
 * src/formats/xml.ts and json.ts). Name kept from the pre-fix
 * "drop and report" behavior (mirrors formats.py's old _strip_nulls)
 * since it still walks the tree the same way; it now throws instead of
 * stripping. */
function stripNulls(node: Node, path: string, rep: WriteReport, depth = 0): Node {
  if (!Array.isArray(node)) return node;
  checkWriteDepth(depth);
  const out: { label: string; target: Node }[] = [];
  const paths = new EdgePaths(path, node);
  for (const { label, target } of node) {
    const p = paths.next(label);
    if (target === null) {
      throw new WriteError(
        "path " + p + ": a null-valued leaf has no TOML representation and no safe substitute " +
          "(TOML has no null token, and silently dropping the edge is unrecoverable data loss)",
        undefined,
        "write.unsupported-value",
        p,
      );
    }
    if (target instanceof TimeValue && timeHasOffset(target)) {
      rep.add(p, "format.temporal-stringified", "offset time has no TOML literal; written as a string", "warning");
    }
    out.push({ label, target: stripNulls(target, p, rep, depth + 1) });
  }
  return out;
}

function typeName(v: unknown): string {
  if (v !== null && typeof v === "object") return v.constructor.name;
  return typeof v;
}

/**
 * A value smol-toml writes verbatim: it stringifies any `Date` by calling
 * `toISOString()`, so a subclass whose `toISOString()` returns the exact TOML
 * spelling gives this writer control of the literal (E-37: the offset, the
 * seconds and every fraction digit are kept; smol-toml's own `TomlDate`
 * would convert to UTC and truncate to milliseconds).
 */
class TomlLiteral extends Date {
  private readonly literal: string;
  constructor(literal: string) {
    super(0);
    this.literal = literal;
  }
  override toISOString(): string {
    return this.literal;
  }
}

/** A Date leaf's TOML literal (E-37). A date or datetime read from or built as a
 * literal is written at its own offset (or none: a local date-time), with the
 * `T` separator. A bare `Date` that never came from a literal is an instant: an
 * offset ("Z") datetime in UTC, mirroring how tomli_w writes an aware (UTC)
 * Python datetime. */
function toTomlDate(d: Date): Date {
  if (dateKind(d) === undefined) return TomlDate.wrapAsOffsetDateTime(d);
  const text = isoText(d);
  // An offset of zero is TOML's `Z` (E-37 leaves +00:00 vs Z unspecified; TOML spells UTC `Z`).
  return new TomlLiteral(datetimeOffset(d) === 0 ? text.slice(0, -6) + "Z" : text);
}

/** Convert a stripped-of-nulls, grouped (JSON-shaped) Document value into
 * the plain JS shape smol-toml's stringify expects: real objects/arrays
 * (grouped() already produces those) with TomlDate swapped in wherever
 * json.ts's serializer would instead stringify a Date. */
function toTomlValue(value: unknown, depth: number): unknown {
  if (value instanceof Date) return toTomlDate(value);
  // A time without an offset is TOML's local time (E-37 rule 3); one with an
  // offset has no TOML literal and is written as a double-quoted string
  // (rule 4; scanToml reports it).
  if (value instanceof TimeValue) {
    return timeHasOffset(value) ? timeText(value) : new TomlLiteral(timeText(value));
  }
  if (typeof value === "bigint") return value;
  // D-29: the sign of negative zero is data; smol-toml's toFixed(1) loses it.
  if (Object.is(value, -0)) return new TomlLiteral("-0.0");
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    checkWriteDepth(depth);
    return value.map((v) => toTomlValue(v, depth + 1));
  }
  if (isPlainRecord(value)) {
    checkWriteDepth(depth);
    // Security (issue #32 follow-up): `value` here can be grouped()'s own
    // Object.create(null) output (already safe against a "__proto__"
    // label), but this loop then re-copies it into a plain {} via
    // out[k] = v, re-triggering the same bug at every nested table, not
    // just the document root -- grouped() only protects its own top-level
    // build. See document.ts's issue #32 comment for the full mechanism:
    // out[k] = v for k === "__proto__" invokes Object.prototype's [[Set]]
    // accessor and reassigns out's own prototype to v instead of storing
    // it, silently dropping the __proto__-labeled data from TOML output.
    // Object.create(null) makes every key, including "__proto__", an
    // ordinary own property.
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [k, v] of Object.entries(value)) out[k] = toTomlValue(v, depth + 1);
    return out;
  }
  // null can't reach here: stripNulls (above) has already removed every
  // null edge before grouped() ever runs.
  throw new TypeError("cannot serialize " + typeName(value));
}

/** Options accepted by writeToml. */
/** Options for serializing a Document node into TOML text. */
export interface WriteTomlOptions {
  /** If true, throws {@link WriteError} if any lossy adjustments are made (e.g. dropping nulls). */
  strict?: boolean;
  /** Optional {@link WriteReport} accumulator to collect adjustments into. */
  report?: WriteReport;
}

/** Write a Document node as TOML text. */
export function writeToml(node: Node, opts: WriteTomlOptions = {}): string {
  const { strict = false, report } = opts;
  checkEncodable(node); // C-9, unconditional: a string with no UTF-8 encoding
  const rep = new WriteReport();
  // Sec8.3.8/D-3 (issue #123): same grouping rule as JSON's/YAML's
  // (grouped(), document.ts) -- TOML's array-of-tables collapsing loses
  // genuine cross-label interleaving unless reported. Checked against the
  // original node, before stripNulls: null-dropping is an unrelated
  // adjustment and must not change whether interleaving is detected.
  if (hasInterleaving(node)) {
    rep.add("$", "format.interleaving-lost", "cross-label interleaving lost: TOML's grouping rule collapses same-label edges together regardless of position", "warning");
  }
  const stripped = stripNulls(node, "$", rep);
  const grp = grouped(stripped);
  if (!isPlainObject(grp)) {
    throw new WriteError("TOML needs a top-level table (the root must be an object)");
  }
  const tomlValue = toTomlValue(grp, 0) as Record<string, unknown>;
  // numbersAsFloat forces every plain JS `number` leaf (never a bigint
  // -- those are genuinely integer-kinded and stringify bare) to render
  // with an explicit decimal point, even when whole (e.g. -0 -> "-0.0",
  // not "0"). Without this, a whole-valued number-kind leaf would write
  // as a bare digit token indistinguishable from an integer, and since
  // issue #98 that reads back as a genuinely different kind (bigint) --
  // smol-toml has no per-value formatting hook, so this has to be a
  // stringify-wide option; it is safe wide because every `number`
  // reaching this point is already number-kind by construction (checked
  // live: a bigint leaf is unaffected by this option).
  const text = stringifyToml(tomlValue as never, { numbersAsFloat: true });
  return finishWrite(text, rep, report === undefined ? { strict } : { strict, report });
}

/** Report what writing TOML would adjust, without producing output. */
export function checkToml(node: Node): WriteReport {
  checkEncodable(node); // C-9, unconditional: a string with no UTF-8 encoding
  const rep = new WriteReport();
  if (hasInterleaving(node)) {
    rep.add("$", "format.interleaving-lost", "cross-label interleaving lost: TOML's grouping rule collapses same-label edges together regardless of position", "warning");
  }
  stripNulls(node, "$", rep);
  return rep;
}

export type { TomlError };
