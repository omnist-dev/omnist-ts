/**
 * Infer a `Schema` from example Documents, on the canonical model. Ported
 * from `omnist/infer.py`. See `docs/design/model.md` §11 (inference
 * algorithm).
 *
 * Given one or more sample Documents, draft a `record` schema that accepts
 * them:
 *
 * - a label present in every sample with count 1 becomes a required field
 *   (`[1,1]`); absent in some samples -> `[0,1]`; seen more than once -> an
 *   array (`[min,]`);
 * - scalar children become one `Scalar` (nullable if any sample was null).
 *   Samples disagreeing on scalar shape raise, except `integer`/`number`
 *   mixing, which collapses to `number` (the one subset relation between
 *   scalars) -- see `docs/design/model.md`;
 * - object children become a nested, named `record` (recursively).
 *
 * Since the model has no inline records, nested records are given generated
 * names derived from their label.
 *
 * `infer` deliberately does **not** auto-normalize: the raw result keeps a
 * 1:1 correspondence between sample labels and generated record names,
 * which is easier to read and hand-edit, and may therefore contain
 * structurally-identical duplicate records. Call `.normalize()` on the
 * result where a canonical minimal schema is wanted.
 */

import { DocumentError, SchemaError } from "./errors.js";
import { Doc, buildNode, type Edge, type Node } from "./document.js";
import {
  ANY,
  Schema,
  field,
  record,
  ref,
  valueKind,
  type Field,
  type FieldType,
  type Record as SchemaRecord,
  type ScalarKind,
} from "./schema.js";

// Matches src/document.ts's own (unexported) MAX_DEPTH -- see src/schema.ts
// and src/oml.ts's precedent for each module keeping its own copy of this
// constant rather than exporting it across an unrelated module boundary.
const MAX_DEPTH = 200;

/**
 * A single field `infer` opened as `any` under `allowAny`.
 *
 * `location` reads `RecordName.label`; `reason` says why the field could
 * not be given a single precise type.
 */
export interface AnyFallback {
  /** The record and field location opened as `any` (e.g. `"Root.payload"`). */
  readonly location: string;
  /** Explanation of why the field fell back to `any`. */
  readonly reason: string;
}

/**
 * Options for schema inference (spec §6.8).
 */
export interface InferOptions {
  /** The name given to the root record in the generated environment.
   * Defaults to `"Root"`. */
  readonly rootName?: string;
  /** When `true`, a field that can't be given one precise type opens to
   * `any` (recorded in the returned report) instead of raising. */
  readonly allowAny?: boolean;
}

/** Build a `Node` from a sample: an existing `Doc` is used as-is (via
 * `toData()`), a plain value is run through `buildNode`. */
function sampleNode(sample: unknown): Node {
  return sample instanceof Doc ? sample.toData() : buildNode(sample);
}

/** Infer a `Schema` accepting every one of `samples`, discarding the
 * `allowAny` fallback report. See {@link inferWithReport}. */
export function infer(samples: readonly unknown[], options: InferOptions = {}): Schema {
  return inferWithReport(samples, options).schema;
}

/**
 * Result returned by {@link inferWithReport}.
 */
export interface InferResult {
  /** The drafted {@link Schema}. */
  readonly schema: Schema;
  /** Array of fields opened as `any` during inference. */
  readonly report: readonly AnyFallback[];
}

/** Infer a `Schema` accepting every one of `samples`, plus a report of any
 * field opened to `any` (only ever non-empty when `allowAny` is `true`). */
export function inferWithReport(
  samples: readonly unknown[],
  options: InferOptions = {},
): InferResult {
  const rootName = options.rootName ?? "Root";
  const allowAny = options.allowAny ?? false;
  const nodes = samples.map(sampleNode);
  if (nodes.length === 0) {
    throw new SchemaError("cannot infer a schema from zero samples");
  }
  if (nodes.some((n) => !Array.isArray(n))) {
    throw new SchemaError("infer expects object (record) samples at the root");
  }
  const env = new Map<string, SchemaRecord>();
  const used = new Set<string>();
  const fallbacks: AnyFallback[] = [];
  inferRecord(nodes as Edge[][], rootName, env, used, allowAny, fallbacks, 0);
  return { schema: new Schema(ref(rootName), env), report: fallbacks };
}

function identifier(s: string): string {
  let out = "";
  for (const c of s) {
    out += /[A-Za-z0-9_]/.test(c) ? c : "_";
  }
  const stripped = out.replace(/^[0-9_]+/, "");
  return stripped || out;
}

function unique(base: string, used: Set<string>): string {
  let name = identifier(base) || "Rec";
  name = name.charAt(0).toUpperCase() + name.slice(1);
  let cand = name;
  let i = 2;
  while (used.has(cand)) {
    cand = `${name}${i}`;
    i += 1;
  }
  used.add(cand);
  return cand;
}

function inferRecord(
  nodes: readonly Edge[][],
  name: string,
  env: Map<string, SchemaRecord>,
  used: Set<string>,
  allowAny: boolean,
  fallbacks: AnyFallback[],
  depth: number,
): void {
  /* v8 ignore start -- unreachable via the public surface: `buildNode`
   * (src/document.ts, called by `sampleNode` above for every sample) already
   * enforces this same MAX_DEPTH (200) while constructing each sample node,
   * so a set of sample nodes whose record nesting exceeds it can never
   * reach `inferRecord` in the first place -- matching src/schema.ts's own
   * MAX_DEPTH guard, which documents the identical reasoning. Kept for
   * structural parity with `omnist/infer.py`'s `_infer_record` depth guard,
   * and as a defense-in-depth backstop against a future caller that builds
   * nodes by a path other than `buildNode`. */
  if (depth > MAX_DEPTH) {
    throw new DocumentError(`nesting exceeds the maximum depth (${MAX_DEPTH})`);
  }
  /* v8 ignore stop */
  used.add(name);
  // Pass 1: which labels exist at all, in first-seen order. Pass 2: one
  // count per sample for *every* label, defaulting to 0 for samples that
  // don't have it -- regardless of which sample first introduced the
  // label. Doing this in two passes (rather than backfilling as labels are
  // discovered) keeps the result independent of sample order: a label
  // missing from an early sample but present in a later one must still
  // come out optional, not required.
  const order: string[] = [];
  const seenLabels = new Set<string>();
  for (const node of nodes) {
    for (const { label } of node) {
      if (!seenLabels.has(label)) {
        seenLabels.add(label);
        order.push(label);
      }
    }
  }

  const children = new Map<string, Node[]>(order.map((label) => [label, []]));
  const perSampleCounts = new Map<string, number[]>(order.map((label) => [label, []]));
  for (const node of nodes) {
    const countsHere = new Map<string, number>();
    for (const { label, target } of node) {
      // Present in `children`/`perSampleCounts` -- every label is seeded
      // above from these same nodes.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      children.get(label)!.push(target);
      countsHere.set(label, (countsHere.get(label) ?? 0) + 1);
    }
    for (const label of order) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      perSampleCounts.get(label)!.push(countsHere.get(label) ?? 0);
    }
  }

  const fields: Field[] = [];
  for (const label of order) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const counts = perSampleCounts.get(label)!;
    const lo = Math.min(...counts);
    const hi = Math.max(...counts);
    let cmin: number;
    let cmax: number | null;
    if (hi > 1) {
      cmin = 0;
      cmax = null; // an array: be permissive on length
    } else {
      cmin = lo;
      cmax = 1; // 0 or 1 -> optional/required
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const childNodes = children.get(label)!;
    const typ = inferType(childNodes, label, name, env, used, allowAny, fallbacks, depth);
    fields.push(field(label, typ, cmin, cmax));
  }
  env.set(name, record(...fields));
}

function inferType(
  childNodes: readonly Node[],
  label: string,
  recordName: string,
  env: Map<string, SchemaRecord>,
  used: Set<string>,
  allowAny: boolean,
  fallbacks: AnyFallback[],
  depth: number,
): FieldType {
  const isObj = childNodes.map((c) => Array.isArray(c));
  if (isObj.every(Boolean)) {
    const recName = unique(label, used);
    inferRecord(childNodes as Edge[][], recName, env, used, allowAny, fallbacks, depth + 1);
    return ref(recName);
  }
  if (isObj.some(Boolean)) {
    if (allowAny) {
      fallbacks.push({ location: `${recordName}.${label}`, reason: "mixes objects and values" });
      return ANY;
    }
    throw new SchemaError(
      `label ${JSON.stringify(label)} mixes objects and values; cannot infer one type`,
    );
  }
  // all scalars
  const names = new Set<ScalarKind>();
  let hasNull = false;
  for (const v of childNodes) {
    if (v === null) {
      hasNull = true;
    } else {
      names.add(valueKind(v));
    }
  }
  if (names.has("number")) {
    names.delete("integer"); // the one subset relation
  }
  if (names.size === 0) {
    return { tag: "scalar", scalarKind: "string", nullable: hasNull };
  }
  if (names.size > 1) {
    const sorted = [...names].sort();
    if (allowAny) {
      fallbacks.push({
        location: `${recordName}.${label}`,
        reason: `values of more than one scalar kind (${sorted.join(", ")})`,
      });
      return ANY;
    }
    throw new SchemaError(
      `label ${JSON.stringify(label)} has values of more than one scalar ` +
        `(${sorted.join(", ")}); cannot infer one scalar type`,
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const kind = [...names][0]!;
  return { tag: "scalar", scalarKind: kind, nullable: hasNull };
}
