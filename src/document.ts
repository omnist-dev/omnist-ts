/**
 * The Document model -- a canonical tree of ordered, labeled edges.
 *
 * Ported from `omnist/document.py`. A Document **node** is either
 *
 * - a **leaf** holding a scalar value (`string`/`number`/`boolean`/`Date`,
 *   or `null`), or
 * - an **internal node** holding an *ordered list of edges*, each a
 *   `{ label, target }` pair. **Labels may repeat** -- "many members" is
 *   the label `member` appearing several times, not a field pointing to an
 *   array.
 *
 * ```
 * Scalar = string | number | boolean | Date | null   // a leaf
 * Edge   = { label: string; target: Node }
 * Node   = Scalar | Edge[]                            // an internal node (ordered)
 * ```
 *
 * This single shape represents every supported format canonically,
 * including XML's interleaved repeated elements, which a plain object with
 * array-valued keys cannot. `Doc` is a thin, guarded wrapper around a node,
 * with navigation helpers. Order is preserved (it is data); schema
 * validation ignores it. See `docs/design/model.md`.
 *
 * ## Scalar-kind mapping (see model.md §10)
 *
 * Unlike Python (which has distinct `int`/`float`), JS has one `number`
 * type -- both the `integer` and `number` Schema scalar kinds (issue #3)
 * map onto plain `number` at the Document layer; kind *tracking* for those
 * two lives entirely in the Schema layer, not here.
 *
 * `date` and `datetime` both map onto the native `Date` object. JS has no
 * bare time-of-day type (no `date`-less "just a clock time" builtin), so a
 * genuinely `time`-kinded value is represented by `TimeValue`
 * (`src/temporal.ts`), a minimal wrapper around the ISO-8601 text (e.g.
 * `"12:00:00"`) that gives it the same kind of real object identity `Date`
 * already has for `date`/`datetime` (issue #96). A *plain* `string`, even
 * one shaped exactly like a valid time, is never treated as time-kinded --
 * that would make it indistinguishable from a genuinely time-kinded value
 * on write, which was the bug: `src/oml.ts`'s writer used to shape-guess a
 * plain string's kind from its content, silently promoting a plain string
 * to a real TIME literal.
 *
 * `TimeValue`'s tag is transparent everywhere except `src/oml.ts`'s writer
 * (the one place it must decide bare-vs-quoted output): `nodeEquals` below
 * unwraps it before comparing, so a `TimeValue` compares equal to an
 * identical plain string, and every other format's writer (JSON/YAML/TOML/
 * XML, none of which has native time-literal syntax) unwraps it to plain
 * text on write, same as `date`/`datetime`'s `Date` mapping already does.
 */

import { DocumentError } from "./errors.js";
import { TimeValue } from "./temporal.js";

const MAX_DEPTH = 200;
// Matches CPython's default sys.get_int_max_str_digits(); JS numbers can't
// represent integers with this many digits anyway (they'd already have lost
// precision converting to `number`), so this guard is dormant for `number`
// input but kept for parity/documentation with the Python cap it mirrors.
const MAX_INT_DIGITS = 4300;
// Total node count across a single buildNode() call -- the spec's third
// safety limit alongside MAX_DEPTH and MAX_INT_DIGITS (docs/02-document-model.md
// section 2.4): a document can be shallow (well under MAX_DEPTH) yet still
// unbounded in total size, e.g. one label repeated an arbitrary number of
// times. 1,000,000 is the reference default the Python port uses. See
// issue #77.
const MAX_NODES = 1_000_000;

/** Mutable counter threaded through a single buildNode() call tree so every
 * node built anywhere in the recursion shares one running total (mirrors
 * how `depth` is threaded, but depth resets per-branch while node count
 * must accumulate across the whole call). */
interface NodeCounter {
  count: number;
}

function countNode(counter: NodeCounter, path: string): void {
  counter.count++;
  if (counter.count > MAX_NODES) {
    throw new DocumentError(`${path}: node count exceeds the maximum (${MAX_NODES})`);
  }
}

/** A leaf value. See the file-top comment for the scalar-kind mapping. */
export type Scalar = string | number | boolean | Date | TimeValue | null;

/** A single labeled edge: `(label, target)` in the Python source's terms. */
export interface Edge {
  readonly label: string;
  readonly target: Node;
}

/** A Document node: a leaf scalar, or an ordered list of labeled edges. */
export type Node = Scalar | Edge[];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function isScalar(v: unknown): v is Scalar {
  return (
    v === null ||
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "boolean" ||
    v instanceof Date ||
    v instanceof TimeValue
  );
}

function checkIntDigits(v: unknown, path: string): void {
  if (typeof v !== "number" || !Number.isInteger(v)) return;
  const digits = Math.abs(v).toString().length;
  /* v8 ignore start -- unreachable: JS's `number` is a float64, whose finite
   * range tops out around 1.8e308 (~309 digits), well under MAX_INT_DIGITS
   * (4300). Unlike Python (arbitrary-precision `int`), a JS number can never
   * reach this cap, so this branch can never fire. Kept anyway (rather than
   * deleted) so this function stays a direct structural match to Python's
   * `_check_int_digits`, documenting *why* the guard is dormant here -- see
   * the file-top comment's scalar-kind mapping note. */
  if (digits <= MAX_INT_DIGITS) return;
  throw new DocumentError(
    `${path}: integer has more than ${MAX_INT_DIGITS} digits, exceeding ` +
      "the digit limit (security: unbounded-digit int-to-str conversion " +
      "is superlinear)",
  );
}
/* v8 ignore stop */

function join(path: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${path}.${key}` : `${path}["${key}"]`;
}

// ---------------------------------------------------------------------------
// Building a node from a plain JS value (JSON-shaped)
// ---------------------------------------------------------------------------

/**
 * Turn a plain JS value into a canonical node.
 *
 * A plain object becomes an ordered edge list; a key whose value is an
 * array expands into one edge **per item** (the same label repeated). A
 * scalar becomes a leaf. A *bare* array (a top-level array, or an array
 * nested directly inside another array) has no labeled-edge form and
 * raises {@link DocumentError}.
 */
export function buildNode(
  value: unknown,
  path = "$",
  depth = 0,
  seen: ReadonlySet<unknown> = new Set(),
  counter: NodeCounter = { count: 0 },
): Node {
  if (depth > MAX_DEPTH) {
    throw new DocumentError(`${path}: nesting exceeds the maximum depth (${MAX_DEPTH})`);
  }
  countNode(counter, path);
  if (Array.isArray(value)) {
    throw new DocumentError(
      `${path}: a bare array has no labeled-edge form ` +
        "(arrays appear only as a repeated field)",
    );
  }
  if (isPlainObject(value) || value instanceof Map) {
    if (seen.has(value)) {
      throw new DocumentError(`${path}: cycle detected`);
    }
    const nextSeen = new Set(seen);
    nextSeen.add(value);
    const entries: Array<[unknown, unknown]> = value instanceof Map
      ? [...value.entries()]
      : Object.entries(value);
    const edges: Edge[] = [];
    for (const [k, v] of entries) {
      if (typeof k !== "string") {
        throw new DocumentError(`${path}: object key ${String(k)} is not a string`);
      }
      const kp = join(path, k);
      for (const child of children(v, kp, depth + 1, nextSeen, counter)) {
        edges.push({ label: k, target: child });
      }
    }
    return edges;
  }
  if (isScalar(value)) {
    checkIntDigits(value, path);
    return value;
  }
  throw new DocumentError(`${path}: ${typeName(value)} is not a Document value`);
}

function* children(
  v: unknown,
  path: string,
  depth: number,
  seen: ReadonlySet<unknown>,
  counter: NodeCounter,
): Generator<Node> {
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const item: unknown = v[i];
      if (Array.isArray(item)) {
        throw new DocumentError(`${path}[${i}]: an array of arrays has no labeled-edge form`);
      }
      yield buildNode(item, `${path}[${i}]`, depth + 1, seen, counter);
    }
  } else {
    yield buildNode(v, path, depth, seen, counter);
  }
}

function typeName(v: unknown): string {
  if (v !== null && typeof v === "object") return v.constructor.name;
  return typeof v;
}

// ---------------------------------------------------------------------------
// Doc -- guarded wrapper with navigation
// ---------------------------------------------------------------------------

/** A guarded handle on a Document node (a leaf value or an edge list). */
export class Doc {
  private _node: Node;
  readonly path: string;
  // The depth of this cursor's own node relative to the document root
  // (root is depth 0). Threaded through child()/edges() as cursors
  // descend, and into buildNode() from add()/set() so a splice is
  // rejected when the cursor's depth plus the new subtree's depth would
  // exceed MAX_DEPTH -- see issue #37: add()/set() used to call
  // buildNode() with no depth argument, restarting the MAX_DEPTH counter
  // at 0 on every mutation instead of accounting for how deep the cursor
  // already is.
  private readonly depth: number;

  constructor(node: Node, path = "$", depth = 0) {
    this._node = node;
    this.path = path;
    this.depth = depth;
  }

  /** Build a `Doc` from a plain JS value. */
  static of(value: unknown): Doc {
    return new Doc(buildNode(value));
  }

  // -- shape ------------------------------------------------------------

  get isLeaf(): boolean {
    return !Array.isArray(this._node);
  }

  get value(): Scalar {
    if (Array.isArray(this._node)) {
      throw new DocumentError(`${this.path}: not a leaf; use edges()`);
    }
    return this._node;
  }

  edges(): Array<[string, Doc]> {
    if (!Array.isArray(this._node)) {
      throw new DocumentError(`${this.path}: a leaf has no edges`);
    }
    const out: Array<[string, Doc]> = [];
    const counts = new Map<string, number>();
    for (const { label, target } of this._node) {
      const i = counts.get(label) ?? 0;
      counts.set(label, i + 1);
      const cp = i === 0 ? `${this.path}.${label}` : `${this.path}.${label}[${i}]`;
      out.push([label, new Doc(target, cp, this.depth + 1)]);
    }
    return out;
  }

  labels(): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const [label] of this.iter()) {
      if (!seen.has(label)) {
        seen.add(label);
        out.push(label);
      }
    }
    return out;
  }

  get(label: string): Doc[] {
    return this.edges()
      .filter(([lbl]) => lbl === label)
      .map(([, c]) => c);
  }

  getOne(label: string): Doc {
    const cs = this.get(label);
    if (cs.length !== 1) {
      throw new DocumentError(`${this.path}: expected exactly one ${label}, found ${cs.length}`);
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return cs[0]!;
  }

  count(label: string): number {
    let n = 0;
    for (const [lbl] of this.iter()) {
      if (lbl === label) n++;
    }
    return n;
  }

  private *iter(): Generator<[string, Node]> {
    if (Array.isArray(this._node)) {
      for (const { label, target } of this._node) {
        yield [label, target];
      }
    }
  }

  /** A cursor to the single child under `label` (editable if internal). */
  child(label: string): Doc {
    return this.getOne(label);
  }

  // -- editing (mutates the underlying edge list) ------------------------

  /**
   * Append an edge `(label, value)`. A repeated label is how an array
   * grows. Returns `this` for chaining.
   */
  add(label: string, value: unknown): Doc {
    this.requireInternal("add");
    // The new edge's target sits one level deeper than this cursor, so
    // seed buildNode with the cursor's own depth (not 0) -- see issue #37.
    const node = buildNode(value, `${this.path}.${label}`, this.depth + 1);
    (this._node as Edge[]).push({ label, target: node });
    return this;
  }

  /** Remove every edge under `label`. */
  remove(label: string): Doc {
    this.requireInternal("remove");
    const arr = this._node as Edge[];
    const filtered = arr.filter((e) => e.label !== label);
    arr.length = 0;
    arr.push(...filtered);
    return this;
  }

  /**
   * Replace all edges under `label` with a single new edge (positioned at
   * the first old occurrence); `set` = `remove` + `add`.
   */
  set(label: string, value: unknown): Doc {
    this.requireInternal("set");
    // Same reasoning as add(): seed buildNode with the cursor's own depth
    // so a splice is checked against where it is actually attached, not
    // restarted at 0 -- see issue #37.
    const node = buildNode(value, `${this.path}.${label}`, this.depth + 1);
    let first = -1;
    const kept: Edge[] = [];
    for (const e of this._node as Edge[]) {
      if (e.label === label) {
        if (first === -1) {
          first = kept.length;
          kept.push({ label, target: node });
        }
        // later duplicates are dropped
      } else {
        kept.push(e);
      }
    }
    if (first === -1) {
      kept.push({ label, target: node });
    }
    const arr = this._node as Edge[];
    arr.length = 0;
    arr.push(...kept);
    return this;
  }

  private requireInternal(op: string): void {
    if (!Array.isArray(this._node)) {
      throw new DocumentError(`${this.path}: cannot ${op} on a leaf`);
    }
  }

  // -- export -------------------------------------------------------------

  toData(): Node {
    return copyNode(this._node);
  }

  /**
   * A JSON-shaped projection: same-label edges grouped into an array.
   *
   * A label seen once stays a single value; a label seen more than once
   * becomes an array (the schema-less fallback of the count-1 rule, see
   * `docs/design/model.md` §9(1)).
   */
  toGrouped(): unknown {
    return grouped(this._node);
  }

  // -- dunders --------------------------------------------------------------

  equals(other: unknown): boolean {
    if (other instanceof Doc) {
      return nodeEquals(this._node, other._node);
    }
    try {
      return nodeEquals(this._node, buildNode(other));
    } catch {
      return false;
    }
  }

  toString(): string {
    return `Doc(${this.isLeaf ? "leaf" : "node"}: ${reprNode(this._node)})`;
  }
}

/** Build a `Doc` from a plain JS value, or pass an existing `Doc` through. */
export function doc(value: unknown): Doc {
  return value instanceof Doc ? value : Doc.of(value);
}

function copyNode(node: Node, depth = 0): Node {
  if (Array.isArray(node)) {
    if (depth > MAX_DEPTH) {
      throw new DocumentError(`nesting exceeds the maximum depth (${MAX_DEPTH})`);
    }
    return node.map(({ label, target }) => ({ label, target: copyNode(target, depth + 1) }));
  }
  return node;
}

/**
 * Replace every `TimeValue` leaf in a Node tree with its plain `.text`
 * string (issue #96). JSON/YAML/TOML have no native time-literal syntax
 * (unlike `Date`, which each of those writers/libraries handles itself),
 * so each of those three writers runs its Node through this first --
 * mirroring how `time` values already round-trip as plain strings through
 * those formats, regardless of provenance. OML's own writer (`src/oml.ts`)
 * deliberately does NOT call this: it is the one place the tag must stay
 * visible, to decide bare-vs-quoted output.
 */
export function unwrapTimeValues(node: Node, depth = 0): Node {
  if (Array.isArray(node)) {
    if (depth > MAX_DEPTH) {
      throw new DocumentError(`nesting exceeds the maximum depth (${MAX_DEPTH})`);
    }
    return node.map(({ label, target }) => ({
      label,
      target: unwrapTimeValues(target, depth + 1),
    }));
  }
  return node instanceof TimeValue ? node.text : node;
}

export function grouped(node: Node, depth = 0): unknown {
  if (!Array.isArray(node)) return node;
  if (depth > MAX_DEPTH) {
    throw new DocumentError(`nesting exceeds the maximum depth (${MAX_DEPTH})`);
  }
  const counts = new Map<string, number>();
  for (const { label } of node) {
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  // Security (issue #32): `label` is untrusted document data (it can come
  // straight from a parsed JSON/YAML/TOML key). A plain {} has
  // Object.prototype in its chain, so out[label] = value for
  // label === "__proto__" would not create an own property -- it would
  // invoke Object.prototype's [[Set]] accessor and reassign out's own
  // prototype to value, silently corrupting the object being built (and,
  // since isPlainObject/isPlainRecord require the exact Object.prototype
  // or null, breaking every downstream check that consumes this output).
  // Building with Object.create(null) instead means every key --
  // including "__proto__", "constructor", and "prototype" -- is stored as
  // an ordinary own property. This does not itself protect against
  // pollution of the *global* Object.prototype (that would require a
  // nested assignment like obj.__proto__.x = y, which this function never
  // does -- see the security regression tests in document.test.ts for
  // confirmation that global Object.prototype is never touched either
  // way).
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const { label, target } of node) {
    const g = grouped(target, depth + 1);
    // `label` was seen while populating `counts` above (same node, same
    // labels), so the lookup is always present.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    if (counts.get(label)! > 1) {
      const arr = out[label];
      if (Array.isArray(arr)) {
        arr.push(g);
      } else {
        out[label] = [g];
      }
    } else {
      out[label] = g;
    }
  }
  return out;
}

function nodeEquals(a: Node, b: Node, depth = 0): boolean {
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    // Defense in depth (issue #37): buildNode()/add()/set() should never
    // let a Doc's node exceed MAX_DEPTH now, but this function backs the
    // public equals() and must not let a raw RangeError (stack overflow)
    // escape in place of the library's own DocumentError contract if that
    // invariant is ever violated again (e.g. a Doc constructed directly
    // from a raw node, bypassing the public mutation API).
    if (depth > MAX_DEPTH) {
      throw new DocumentError(`nesting exceeds the maximum depth (${MAX_DEPTH})`);
    }
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      // Index is in-bounds for both (same length, loop bound by `a.length`);
      // non-null assertion only, no runtime branch.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const ea = a[i]!;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const eb = b[i]!;
      if (ea.label !== eb.label) return false;
      if (!nodeEquals(ea.target, eb.target, depth + 1)) return false;
    }
    return true;
  }
  const sa = a as Scalar;
  const sb = b as Scalar;
  if (sa instanceof Date || sb instanceof Date) {
    return sa instanceof Date && sb instanceof Date && sa.getTime() === sb.getTime();
  }
  // A `TimeValue`'s tag is invisible to Document equality (issue #96, same
  // reasoning as omnist-rs#99/PR#100's manual PartialEq): it compares equal
  // to an equivalent plain string, so a schema-materialized time value and
  // its pre-materialize string form are the same Document.
  const ua = sa instanceof TimeValue ? sa.text : sa;
  const ub = sb instanceof TimeValue ? sb.text : sb;
  return ua === ub;
}

function reprNode(node: Node): string {
  // No Date-specific handling needed: JSON.stringify already calls
  // Date.prototype.toJSON() (-> the ISO string) before either its default
  // serialization or a replacer function ever sees the value, so a `Date`
  // scalar renders as its ISO string for free.
  //
  // JSON.stringify recurses internally and would otherwise surface a raw
  // RangeError (stack overflow) instead of the library's own DocumentError
  // on an over-deep node. checkReprDepth() walks the tree first, purely to
  // enforce the same MAX_DEPTH guard the rest of the codebase relies on --
  // defense in depth (issue #37), same reasoning as nodeEquals() above.
  checkReprDepth(node);
  return JSON.stringify(node);
}

function checkReprDepth(node: Node, depth = 0): void {
  if (!Array.isArray(node)) return;
  if (depth > MAX_DEPTH) {
    throw new DocumentError(`nesting exceeds the maximum depth (${MAX_DEPTH})`);
  }
  for (const { target } of node) {
    checkReprDepth(target, depth + 1);
  }
}
