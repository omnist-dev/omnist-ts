/**
 * JSON codec over the canonical Document (edge-list) model. Ported from the
 * JSON section of omnist/formats.py.
 *
 * JSON goes through the JSON-shaped grouping (grouped()): same-label
 * edges collapse into an array, a single occurrence stays bare (the
 * schema-less count-1 fallback -- see docs/design/model.md section 9(1)).
 *
 * Writing is lenient by default: a Date leaf (JSON has no date type)
 * is written as an ISO-8601 string, and a NaN/Infinity/-Infinity
 * leaf (not valid JSON) is substituted with null -- each substitution is
 * recorded as an Adjustment in a WriteReport. Pass report to inspect, or
 * strict: true to throw on any adjustment. See src/report.ts.
 */

import { buildNode, grouped, type Node, type Scalar } from "../document.js";
import { ParseError, WriteError } from "../errors.js";
import { finishWrite, WriteReport } from "../report.js";
import { dateKind } from "../temporal.js";
import { materialize } from "../deserialize.js";
import type { Schema } from "../schema.js";

// Matches src/document.ts's own MAX_DEPTH (locally redefined here, same as
// src/oml.ts's own copy of the same guard constant -- see that file for
// this convention's precedent in this port).
const MAX_DEPTH = 200;

function checkWriteDepth(depth: number): void {
  /* v8 ignore start -- unreachable via the public API: buildNode (document.ts)
   * already rejects a node deeper than MAX_DEPTH at construction time, so no
   * node this writer ever sees can exceed it here. Kept as a defensive
   * backstop, same convention as oml.ts and document.ts's own dormant
   * depth/digit guards (see those files' comments). */
  if (depth > MAX_DEPTH) {
    throw new WriteError("nesting exceeds the maximum depth (" + String(MAX_DEPTH) + ")");
  }
  /* v8 ignore stop */
}

function* leaves(node: Node, path = "$", depth = 0): Generator<[string, Scalar]> {
  if (Array.isArray(node)) {
    checkWriteDepth(depth);
    const counts = new Map<string, number>();
    for (const { label, target } of node) {
      const i = counts.get(label) ?? 0;
      counts.set(label, i + 1);
      const p = i === 0 ? path + "." + label : path + "." + label + "[" + String(i) + "]";
      yield* leaves(target, p, depth + 1);
    }
  } else {
    yield [path, node];
  }
}

/** Options accepted by readJson. */
export interface ReadJsonOptions {
  schema?: Schema;
}

/** Parse JSON text into a Document node. */
export function readJson(text: string, opts: ReadJsonOptions = {}): Node {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (exc) {
    // JSON.parse always throws a SyntaxError (an Error instance) on
    // malformed input, never a bare value, so the non-Error branch below is
    // a defensive fallback that's never actually reached.
    /* v8 ignore next */
    const message = exc instanceof Error ? exc.message : String(exc);
    throw new ParseError("invalid JSON: " + message);
  }
  const node = buildNode(parsed);
  if (opts.schema === undefined) return node;
  return materialize(node, opts.schema) as Node;
}

/** Options accepted by writeJson. */
export interface WriteJsonOptions {
  indent?: number | null;
  strict?: boolean;
  report?: WriteReport;
}

/** Write a Document node as JSON text. */
export function writeJson(node: Node, opts: WriteJsonOptions = {}): string {
  const { indent = null, strict = false, report } = opts;
  const rep = scanJson(node);
  const prepared = strict ? node : prepareJson(node);
  const text = serializeTop(grouped(prepared), indent);
  return finishWrite(text, rep, report === undefined ? { strict } : { strict, report });
}

/** Report what writing JSON would adjust, without producing output. */
export function checkJson(node: Node): WriteReport {
  return scanJson(node);
}

function scanJson(node: Node): WriteReport {
  const rep = new WriteReport();
  for (const [path, v] of leaves(node)) {
    if (v instanceof Date) {
      rep.add(path, "temporal.stringified", "temporal value written as an ISO-8601 string", "warning");
    } else if (typeof v === "number" && !Number.isFinite(v)) {
      rep.add(path, "float.special", String(v) + " is not valid JSON; wrote null", "error");
    }
  }
  return rep;
}

/** Lenient-mode substitution: a NaN/Infinity leaf becomes null so the
 * written text is always valid JSON (mirrors XML's illegal-char -> U+FFFD
 * substitution). strict: true skips this and refuses via WriteError
 * instead, so it never sees the substituted value. */
function prepareJson(node: Node, depth = 0): Node {
  if (Array.isArray(node)) {
    checkWriteDepth(depth);
    return node.map(({ label, target }) => ({ label, target: prepareJson(target, depth + 1) }));
  }
  if (typeof node === "number" && !Number.isFinite(node)) {
    return null;
  }
  return node;
}

function isoOf(d: Date): string {
  const kind = dateKind(d);
  const datePart =
    String(d.getUTCFullYear()).padStart(4, "0") +
    "-" +
    String(d.getUTCMonth() + 1).padStart(2, "0") +
    "-" +
    String(d.getUTCDate()).padStart(2, "0");
  const isMidnight =
    d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
  if (kind === "date" || (kind === undefined && isMidnight)) return datePart;
  const ms = d.getUTCMilliseconds();
  const frac = ms === 0 ? "" : "." + String(ms).padStart(3, "0");
  return (
    datePart +
    "T" +
    String(d.getUTCHours()).padStart(2, "0") +
    ":" +
    String(d.getUTCMinutes()).padStart(2, "0") +
    ":" +
    String(d.getUTCSeconds()).padStart(2, "0") +
    frac
  );
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function typeName(v: unknown): string {
  if (v !== null && typeof v === "object") return v.constructor.name;
  return typeof v;
}

/** Python's json.dumps default separators (no indent): ", " between
 * items, ": " between key and value. With indent, items are one per
 * line, comma-terminated, no trailing space; key/value stays ": ". */
function serializeTop(value: unknown, indent: number | null | undefined): string {
  return serialize(value, indent ?? null, 0);
}

function serialize(value: unknown, indent: number | null, level: number): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN";
    if (value === Infinity) return "Infinity";
    if (value === -Infinity) return "-Infinity";
    return String(value);
  }
  if (value instanceof Date) return JSON.stringify(isoOf(value));
  if (Array.isArray(value)) return serializeArray(value, indent, level);
  if (isPlainRecord(value)) return serializeObject(value, indent, level);
  throw new TypeError("cannot serialize " + typeName(value));
}

function serializeArray(items: unknown[], indent: number | null, level: number): string {
  // Unreachable via writeJson's pipeline: grouped() (document.ts) only ever
  // turns a repeated label into a JS array when it has 2+ occurrences, so a
  // grouped value is never a 0-length array. Kept for parity with
  // serializeObject's analogous guard, which the top-level empty-node case
  // does exercise.
  /* v8 ignore start */
  if (items.length === 0) return "[]";
  /* v8 ignore stop */
  const parts = items.map((v) => serialize(v, indent, level + 1));
  return wrap("[", "]", parts, indent, level);
}

function serializeObject(obj: Record<string, unknown>, indent: number | null, level: number): string {
  const keys = Object.keys(obj);
  if (keys.length === 0) return "{}";
  const parts = keys.map((k) => JSON.stringify(k) + ": " + serialize(obj[k], indent, level + 1));
  return wrap("{", "}", parts, indent, level);
}

function wrap(open: string, close: string, parts: string[], indent: number | null, level: number): string {
  if (indent === null) return open + parts.join(", ") + close;
  const pad = " ".repeat(indent * (level + 1));
  const closePad = " ".repeat(indent * level);
  return open + "\n" + parts.map((p) => pad + p).join(",\n") + "\n" + closePad + close;
}
