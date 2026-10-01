/**
 * The YAML alias expansion limit: omnist-spec D-18, D-19 and D-20
 * (docs/02-document-model.md Sec2.4.1). Runs on the `yaml` package's
 * Document AST -- which keeps `Alias` nodes -- BEFORE anything is
 * materialized (D-19), so an over-limit input is refused without paying for
 * the expansion it describes.
 *
 * For every candidate node `a` -- every anchored definition, AND every
 * mapping and sequence whether or not anchored (the root container and an
 * inline merge source included) -- the check computes from the reference
 * graph alone:
 *
 *     W(a)  value slots materialized when `a` is expanded
 *     S(a)  value slots written in `a`'s own definition
 *     E(a)  = W(a) / S(a)
 *
 * and rejects the input when E(a) exceeds the maximum. Scalars are never
 * checked (W = S = 1). Counting rules, per the spec:
 *
 * - a container and a scalar each count one slot, the anchored node itself
 *   included, in both W and S; mapping keys are not value slots;
 * - a plain alias `*b` counts ONE slot in S and contributes W(b) to W;
 * - a merge-key reference `<<: *b` contributes W(b) - 1 to W (b's container
 *   is flattened into the referrer); the `<<` entry is ONE slot in S;
 * - `<<: [*p, *q]`: each alias contributes W(target) - 1, the carrier
 *   sequence holds no slot of its own, the `<<` entry is one slot in S;
 * - an inline mapping merge source contributes W - 1 to the referrer's W;
 *   its written values add to the referrer's S (its container is the one
 *   `<<` slot); it is also a candidate in its own right.
 *
 * W is the structural count, blind to key collisions by design (D-19): it
 * may exceed what is finally materialized, never fall below it.
 *
 * The walk is iterative (an explicit stack, so a deeply nested document
 * cannot exhaust the JS stack here), single-pass, and memoizes W and S per
 * anchor when its definition completes; E is evaluated as each candidate
 * completes, so the first offender stops the walk. Counts are `bigint`
 * (arbitrary precision), so no count can overflow or wrap under the limit.
 * A reference to an anchor whose definition is still being walked -- the
 * alias sits inside the very definition it names, directly or through other
 * anchors -- is a cycle: W is unbounded and the input is rejected with the
 * same code (D-20), with no E computed.
 */

import YAML from "yaml";
import { DocumentError } from "../errors.js";
import { lineCol } from "../position.js";

/** The error code for every D-18/D-20 rejection (omnist-spec Sec8.3.2). */
export const ALIAS_EXPANSION_CODE = "document.limit.alias-expansion";

/** The Sec2.4 reference default maximum expansion factor (D-18): 50. */
export const DEFAULT_MAX_ALIAS_EXPANSION = 50;

/**
 * Upper bound on a configured maximum. The spec measures its weakest
 * dangerous document at about E = 170, so a maximum far above that no longer
 * bounds amplification meaningfully; a larger value is rejected (D-10: the
 * limit must stay finite and meaningful).
 */
export const MAX_RECOMMENDED_ALIAS_EXPANSION = 10_000;

/**
 * Resolve a caller-supplied maximum to the value the reader enforces:
 * `undefined`, zero, negative and NaN select the default (never "no limit",
 * D-10); a positive integer up to {@link MAX_RECOMMENDED_ALIAS_EXPANSION} is
 * used as given; anything else (too large, infinite, fractional) is a
 * `RangeError`.
 */
export function resolveMaxAliasExpansion(value: number | undefined): number {
  if (value === undefined || !(value > 0)) return DEFAULT_MAX_ALIAS_EXPANSION;
  if (!Number.isInteger(value) || value > MAX_RECOMMENDED_ALIAS_EXPANSION) {
    throw new RangeError(
      "maxAliasExpansion must be an integer from 1 to " +
        String(MAX_RECOMMENDED_ALIAS_EXPANSION) +
        " (zero or negative selects the default " +
        String(DEFAULT_MAX_ALIAS_EXPANSION) +
        "), got " +
        String(value),
    );
  }
  return value;
}

/** One anchor's memoized W and S; `done` is false while its definition is being walked. */
interface AnchorSlots {
  w: bigint;
  s: bigint;
  done: boolean;
}

/**
 * How a child folds into its parent: `key` (ignored), `plain` (a value
 * slot), `merge` (the value of a `<<` key: an alias or an inline mapping),
 * `carrier` (a literal sequence directly under `<<`), `item` (an element of
 * a carrier sequence).
 */
type Role = "key" | "plain" | "merge" | "carrier" | "item";

interface Frame {
  readonly node: YAML.YAMLMap | YAML.YAMLSeq;
  readonly isMap: boolean;
  readonly total: number;
  readonly role: Role;
  readonly slots: AnchorSlots | undefined;
  step: number;
  /** W and S as the node is written and expanded in a plain (value) position. */
  w: bigint;
  s: bigint;
  /** Merge contribution of a carrier sequence (meaningful when role is "carrier"). */
  mw: bigint;
  ms: bigint;
}

/**
 * True when a mapping key is the YAML merge key `<<`, mirroring the `yaml`
 * package's own test (so a quoted `"<<"` is an ordinary key here exactly as
 * it is when materializing).
 */
function isMergeKey(key: unknown): boolean {
  return (
    YAML.isScalar(key) &&
    key.type === "PLAIN" &&
    (key.value === "<<" || (typeof key.value === "symbol" && key.value.description === "<<"))
  );
}

function limitError(node: { range?: [number, number, number] | null | undefined }, text: string, detail: string): DocumentError {
  const [line, col] = lineCol(text, (node.range as [number, number, number])[0]);
  return new DocumentError(
    "line " + String(line) + ", col " + String(col) + ": " + detail,
    ALIAS_EXPANSION_CODE,
    "$",
  );
}

/**
 * Enforce D-18/D-19/D-20 over a parsed YAML document's root node. Throws a
 * {@link DocumentError} with code `document.limit.alias-expansion` at path
 * `$` when any candidate node's expansion factor exceeds `max` (an already
 * resolved positive integer) or an anchor refers to itself. `text` is the
 * source, used only to report the offending node's line and column.
 */
export function checkAliasExpansion(root: unknown, max: number, text: string): void {
  if (!YAML.isMap(root) && !YAML.isSeq(root)) return; // a scalar root has no candidate
  const limit = BigInt(max);
  const anchors = new Map<string, AnchorSlots>();
  const stack: Frame[] = [];

  const register = (node: YAML.Node): AnchorSlots | undefined => {
    if (node.anchor === undefined) return undefined;
    const slots: AnchorSlots = { w: 1n, s: 1n, done: false };
    anchors.set(node.anchor, slots);
    return slots;
  };
  const enter = (node: YAML.YAMLMap | YAML.YAMLSeq, role: Role): void => {
    const isMap = YAML.isMap(node);
    stack.push({
      node,
      isMap,
      total: isMap ? node.items.length * 2 : node.items.length,
      role,
      slots: register(node),
      step: 0,
      w: 1n,
      s: 1n,
      mw: 0n,
      ms: 0n,
    });
  };
  const fold = (parent: Frame, role: Role, w: bigint, s: bigint, isAlias: boolean): void => {
    if (role === "key") return;
    if (role === "plain" || role === "item") {
      parent.w += w;
      parent.s += s;
    }
    // A merged source's container is flattened away: W - 1. An alias is
    // counted in S by the single `<<` entry; an inline mapping adds its own
    // written slots less its container (that container IS the `<<` slot).
    // A plain-position parent is the map itself; for a carrier's item the
    // contribution accumulates in mw/ms until the carrier completes.
    if (role === "merge") {
      parent.w += w - 1n;
      if (!isAlias) parent.s += s - 1n;
    } else if (role === "item") {
      parent.mw += w - 1n;
      if (!isAlias) parent.ms += s - 1n;
    }
  };

  enter(root, "plain");
  while (stack.length > 0) {
    const f = stack[stack.length - 1] as Frame;
    if (f.step < f.total) {
      const j = f.step++;
      let child: unknown;
      let role: Role;
      if (f.isMap) {
        const pair = (f.node as YAML.YAMLMap).items[j >> 1] as YAML.Pair;
        const merging = isMergeKey(pair.key);
        if ((j & 1) === 0) {
          child = pair.key;
          role = "key";
          // The `<<` entry is one written slot, whatever its value holds.
          if (merging) f.s += 1n;
        } else {
          child = pair.value;
          role = !merging ? "plain" : YAML.isSeq(child) ? "carrier" : "merge";
        }
      } else {
        child = (f.node as YAML.YAMLSeq).items[j];
        role = f.role === "carrier" ? "item" : "plain";
      }
      if (YAML.isAlias(child)) {
        const target = anchors.get(child.source);
        if (target !== undefined && !target.done) {
          throw limitError(
            child,
            text,
            "an anchor refers to itself, directly or through other anchors (unbounded alias expansion)",
          );
        }
        // An unresolved alias (no such anchor yet) is left for the library's
        // own error when it materializes; it counts as one slot here.
        fold(f, role, target === undefined ? 1n : target.w, 1n, true);
      } else if (YAML.isMap(child) || YAML.isSeq(child)) {
        enter(child, role);
      } else {
        // A scalar (or an empty node): W = S = 1, never a candidate itself.
        if (YAML.isScalar(child)) {
          const slots = register(child);
          if (slots !== undefined) slots.done = true;
        }
        fold(f, role, 1n, 1n, false);
      }
      continue;
    }
    stack.pop();
    // Every mapping and sequence is a candidate (a carrier only when anchored).
    if ((f.role !== "carrier" || f.slots !== undefined) && f.w > limit * f.s) {
      throw limitError(
        f.node,
        text,
        "alias expansion factor of this " +
          (f.isMap ? "mapping" : "sequence") +
          " exceeds the configured maximum (" +
          String(max) +
          ")",
      );
    }
    if (f.slots !== undefined) {
      f.slots.w = f.w;
      f.slots.s = f.s;
      f.slots.done = true;
    }
    const parent = stack[stack.length - 1];
    if (parent !== undefined) {
      if (f.role === "carrier") {
        parent.w += f.mw;
        parent.s += f.ms;
      } else {
        fold(parent, f.role, f.w, f.s, false);
      }
    }
  }
}
