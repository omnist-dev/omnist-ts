/**
 * TOML codec over the canonical Document (edge-list) model. Ported from the
 * TOML section of omnist/formats.py.
 *
 * TOML goes through the same JSON-shaped grouping (grouped()) as JSON --
 * same-label edges collapse into an array-of-tables, a single occurrence
 * stays bare (see docs/design/model.md section 9(1)).
 *
 * Writing is lenient by default: TOML has no `null`, so a null-valued edge
 * is dropped and recorded as a "null.omitted" Adjustment (a warning) in a
 * WriteReport. Pass report to inspect, or strict: true to throw on any
 * adjustment. See src/report.ts. Unlike JSON, TOML's own grammar accepts
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
import { buildNode, grouped, type Node } from "../document.js";
import { ParseError, WriteError } from "../errors.js";
import { finishWrite, WriteReport } from "../report.js";
import { parseDateToken, parseDatetimeToken, dateKind } from "../temporal.js";
import { materialize } from "../deserialize.js";
import type { Schema } from "../schema.js";

// Matches src/formats/json.ts's own copy of the same guard constant -- see
// that file's comment for this convention's precedent in this port.
const MAX_DEPTH = 200;

function checkWriteDepth(depth: number): void {
  /* v8 ignore start -- unreachable via the public API: buildNode
   * (document.ts) already rejects a node deeper than MAX_DEPTH at
   * construction time, so no node this writer ever sees can exceed it
   * here. Kept as a defensive backstop, same convention as json.ts. */
  if (depth > MAX_DEPTH) {
    throw new WriteError("nesting exceeds the maximum depth (" + String(MAX_DEPTH) + ")");
  }
  /* v8 ignore stop */
}

// ---------------------------------------------------------------------------
// Local-vs-offset datetime tagging (issue #26)
// ---------------------------------------------------------------------------

/**
 * TOML distinguishes an offset datetime (`2024-01-01T12:00:00Z`) from a
 * local datetime with no offset (`2024-01-01T12:00:00`); smol-toml's
 * TomlDate.isLocal() reports which one a parsed literal was. This port's
 * Date-kind tagging (temporal.ts, issue #14) only tags date-vs-datetime, not
 * local-vs-offset -- there was no TOML-specific concept for it to track.
 * Rather than extend that shared, cross-format WeakMap with a dimension
 * only TOML cares about, tag it here instead: a second, module-local
 * WeakSet (same non-invasive by-identity technique, scoped to this file)
 * that remembers which datetimes convertTomlDates produced from a *local*
 * literal, so toTomlDate (below) can write them back out the same way
 * instead of defaulting to an offset ("Z") datetime -- fixing the
 * read/write asymmetry reported in issue #26.
 *
 * Confirmed structural (worth fixing), not parity-with-Python (which would
 * make it accepted, documented lossiness instead): Python's tomllib/
 * tomli_w round-trip this correctly today -- tomllib produces a naive
 * datetime.datetime for a local literal and an aware one for an offset
 * literal, and tomli_w's dumps() reproduces whichever it got (see
 * docs/formats/toml.md: "TOML round-trips date/time/datetime natively in
 * both directions"). So this was a genuine TS-specific gap against the
 * Python port, not something both ports already share -- worth closing
 * rather than just documenting.
 */
const LOCAL_DATETIME = new WeakSet<Date>();

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
    // Tag a *local* datetime (no offset in the source literal) so
    // toTomlDate (below) can write it back out the same way -- see the
    // LOCAL_DATETIME comment above (issue #26).
    if (value.isLocal()) LOCAL_DATETIME.add(dt);
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
export interface ReadTomlOptions {
  schema?: Schema;
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
export function readToml(text: string, opts: ReadTomlOptions = {}): Node {
  let parsed: unknown;
  try {
    parsed = parseToml(text);
  } catch (exc) {
    // smol-toml's parse always throws a TomlError (an Error instance) on
    // malformed input, never a bare value, so the non-Error branch below
    // is a defensive fallback that's never actually reached -- same
    // convention as json.ts's readJson catch.
    /* v8 ignore next */
    const message = exc instanceof Error ? exc.message : String(exc);
    throw new ParseError("invalid TOML: " + message);
  }
  const node = buildNode(convertTomlDates(parsed));
  if (opts.schema === undefined) return node;
  return materialize(node, opts.schema) as Node;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Drop edges whose value is null (TOML can't hold null), recording each --
 * mirrors formats.py's _strip_nulls. */
function stripNulls(node: Node, path: string, rep: WriteReport, depth = 0): Node {
  if (!Array.isArray(node)) return node;
  checkWriteDepth(depth);
  const out: { label: string; target: Node }[] = [];
  const counts = new Map<string, number>();
  for (const { label, target } of node) {
    const i = counts.get(label) ?? 0;
    counts.set(label, i + 1);
    const p = i === 0 ? path + "." + label : path + "." + label + "[" + String(i) + "]";
    if (target === null) {
      rep.add(p, "null.omitted", "null value dropped (TOML has no null)", "warning");
      continue;
    }
    out.push({ label, target: stripNulls(target, p, rep, depth + 1) });
  }
  return out;
}

function typeName(v: unknown): string {
  if (v !== null && typeof v === "object") return v.constructor.name;
  return typeof v;
}

/** A Date leaf's kind (see temporal.ts's dateKind) picks which TOML
 * temporal literal it's written as: a tagged "date" becomes a local TOML
 * date. A tagged "datetime" becomes either a local or an offset ("Z") TOML
 * datetime depending on whether it was read from a local literal (see the
 * LOCAL_DATETIME tagging above, issue #26); an untagged Date -- this port's
 * own Date is always UTC-based, see document.ts's file-top comment --
 * always becomes an offset datetime, mirroring how tomli_w writes an aware
 * (UTC) Python datetime. */
function toTomlDate(d: Date): TomlDate {
  if (dateKind(d) === "date") return TomlDate.wrapAsLocalDate(d);
  // A datetime read in from a *local* (no-offset) TOML literal round-trips
  // back out the same way (issue #26); anything else -- a tagged
  // "datetime" read from an offset literal, or an untagged Date this
  // port's own Date is always UTC-based, see document.ts's file-top
  // comment) -- becomes an offset ("Z") TOML datetime, mirroring how
  // tomli_w writes an aware (UTC) Python datetime.
  if (LOCAL_DATETIME.has(d)) return TomlDate.wrapAsLocalDateTime(d);
  return TomlDate.wrapAsOffsetDateTime(d);
}

/** Convert a stripped-of-nulls, grouped (JSON-shaped) Document value into
 * the plain JS shape smol-toml's stringify expects: real objects/arrays
 * (grouped() already produces those) with TomlDate swapped in wherever
 * json.ts's serializer would instead stringify a Date. */
function toTomlValue(value: unknown, depth: number): unknown {
  if (value instanceof Date) return toTomlDate(value);
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
export interface WriteTomlOptions {
  strict?: boolean;
  report?: WriteReport;
}

/** Write a Document node as TOML text. */
export function writeToml(node: Node, opts: WriteTomlOptions = {}): string {
  const { strict = false, report } = opts;
  const rep = new WriteReport();
  const stripped = stripNulls(node, "$", rep);
  const grp = grouped(stripped);
  if (!isPlainObject(grp)) {
    throw new WriteError("TOML needs a top-level table (the root must be an object)");
  }
  const tomlValue = toTomlValue(grp, 0) as Record<string, unknown>;
  const text = stringifyToml(tomlValue as never);
  return finishWrite(text, rep, report === undefined ? { strict } : { strict, report });
}

/** Report what writing TOML would adjust, without producing output. */
export function checkToml(node: Node): WriteReport {
  const rep = new WriteReport();
  stripNulls(node, "$", rep);
  return rep;
}

export type { TomlError };
