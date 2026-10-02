/**
 * The YAML alias limits: omnist-spec D-18, D-18a, D-19, D-20 and D-22
 * (docs/02-document-model.md Sec2.4.1). Runs on the `yaml` package's
 * Document AST -- which keeps `Alias` nodes -- BEFORE anything is
 * materialized (D-19), so an over-limit input is refused without paying for
 * the expansion it describes.
 *
 * The check is two passes over the reference graph, never the expanded tree:
 *
 * 1. {@link validateMergeShapes}: a merge value must be a mapping or a
 *    sequence of mappings (D-18a), and every alias must have an anchor.
 *    Anything else is `parse.codec-syntax`, and
 *    it wins over every `document.limit.*` code, so it runs before a single
 *    slot is counted.
 * 2. The count. For every candidate node `a` -- every anchored definition,
 *    AND every mapping and sequence whether or not anchored (the root
 *    container and an inline merge source included; a merge-position
 *    sequence excepted, below) -- it computes
 *
 *        W(a)  value slots materialized when `a` is expanded
 *        S(a)  value slots written in `a`'s own definition
 *        E(a)  = W(a) / S(a)
 *
 *    and rejects the input when E(a) exceeds the maximum
 *    (`document.limit.alias-expansion`). Scalars are never checked (W = S =
 *    1). Counting rules, per the spec:
 *
 *    - a container and a scalar each count one slot, the anchored node itself
 *      included, in both W and S; mapping keys are not value slots;
 *    - a plain alias `*b` counts ONE slot in S and contributes W(b) to W;
 *    - a merge-key reference `<<: *b` contributes W(b) - 1 to W (b's
 *      container is flattened into the referrer); the `<<` entry is ONE slot
 *      in S;
 *    - a sequence in merge-value position, `<<: [..]` or `<<: &s [..]`, is a
 *      CARRIER (D-18a): it holds no slot in W or S and is not a candidate,
 *      anchored or not. Each member contributes W(member) - 1; an inline or
 *      newly anchored mapping member adds its written slots less its
 *      container to the referrer's S;
 *    - `<<: *s` where `s` is a sequence contributes the same sum over its
 *      members (never W(s) - 1) and nothing to S but the one `<<` slot;
 *    - a sequence written as an ordinary value stays an ordinary candidate
 *      even when anchored; a plain alias `t: *s` of a carrier materializes
 *      the list: 1 + the sum of its members' W;
 *    - an inline mapping merge source contributes W - 1 to the referrer's W;
 *      its written values less its container add to the referrer's S; it is
 *      also a candidate in its own right.
 *
 *    After every candidate has passed, an input that contains at least one
 *    alias or merge key is refused when W(root) exceeds the maximum expanded
 *    size (D-22, `document.limit.expanded-size`); an input with neither is
 *    exempt however large.
 *
 * W is the structural count, blind to key collisions by design (D-19): it may
 * exceed what is finally materialized, never fall below it.
 *
 * The walk is iterative (an explicit stack, so a deeply nested document
 * cannot exhaust the JS stack here), single-pass, and memoizes W and S per
 * anchor when its definition completes; E is evaluated as each candidate
 * completes, so the first offender stops the walk. Counts are `bigint`
 * (arbitrary precision), so no count can overflow or wrap. A reference to an
 * anchor whose definition is still being walked -- the alias sits inside the
 * very definition it names, directly or through other anchors -- is a cycle:
 * W is unbounded and the input is rejected with the alias-expansion code
 * (D-20), with no E computed.
 */

import YAML from "yaml";
import { DocumentError, ParseError } from "../errors.js";
import { lineCol } from "../position.js";
import { codecSyntaxError } from "./codec-error.js";

/** The error code for every D-18/D-20 rejection (omnist-spec Sec8.3.2). */
export const ALIAS_EXPANSION_CODE = "document.limit.alias-expansion";

/** The error code for a D-22 rejection (omnist-spec Sec8.3.2). */
export const EXPANDED_SIZE_CODE = "document.limit.expanded-size";

/** The Sec2.4 reference default maximum expansion factor (D-18): 50. */
export const DEFAULT_MAX_ALIAS_EXPANSION = 50;

/** The Sec2.4.1 reference default maximum expanded size (D-22): 1 000 000 slots. */
export const DEFAULT_MAX_EXPANDED_SLOTS = 1_000_000;

/**
 * Upper bound on a configured maximum. The spec measures its weakest
 * dangerous document at about E = 170, so a maximum far above that no longer
 * bounds amplification meaningfully; a larger value is rejected (D-10: the
 * limit must stay finite and meaningful).
 */
export const MAX_RECOMMENDED_ALIAS_EXPANSION = 10_000;

/**
 * Upper bound on a configured maximum expanded size: the spec's recommended
 * ceiling (D-22), 10 000 000 slots, beyond which an implementation should
 * have measured its own memory per slot.
 */
export const MAX_RECOMMENDED_EXPANDED_SLOTS = 10_000_000;

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

/**
 * Resolve a caller-supplied maximum expanded size by the same convention as
 * {@link resolveMaxAliasExpansion}: `undefined`, zero, negative and NaN select
 * {@link DEFAULT_MAX_EXPANDED_SLOTS}; a positive integer up to
 * {@link MAX_RECOMMENDED_EXPANDED_SLOTS} is used as given; anything else is a
 * `RangeError`.
 */
export function resolveMaxExpandedSlots(value: number | undefined): number {
  if (value === undefined || !(value > 0)) return DEFAULT_MAX_EXPANDED_SLOTS;
  if (!Number.isInteger(value) || value > MAX_RECOMMENDED_EXPANDED_SLOTS) {
    throw new RangeError(
      "maxExpandedSlots must be an integer from 1 to " +
        String(MAX_RECOMMENDED_EXPANDED_SLOTS) +
        " (zero or negative selects the default " +
        String(DEFAULT_MAX_EXPANDED_SLOTS) +
        "), got " +
        String(value),
    );
  }
  return value;
}

type Kind = "map" | "seq" | "scalar";

/**
 * One anchor's memoized counts; `done` is false while its definition is being
 * walked. `mw` is what `<<: *anchor` contributes when the anchor is a
 * sequence: the sum over its mapping members of W - 1.
 */
interface AnchorSlots {
  w: bigint;
  s: bigint;
  mw: bigint;
  kind: Kind;
  done: boolean;
}

/**
 * How a child folds into its parent: `key` (ignored), `plain` (a value slot),
 * `merge` (the value of a `<<` key that is a mapping: an alias or an inline
 * mapping), `carrier` (a sequence, literal or aliased, in merge-value
 * position).
 */
type Role = "key" | "plain" | "merge" | "carrier";

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
  /** Merge contribution of a sequence's mapping members: sum of W - 1, and of written S - 1. */
  mw: bigint;
  ms: bigint;
}

type Located = { range?: [number, number, number] | null | undefined };

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

function startOf(node: Located, text: string): [number, number] {
  return lineCol(text, (node.range as [number, number, number])[0]);
}

function limitError(node: Located, text: string, detail: string, code: string): DocumentError {
  const [line, col] = startOf(node, text);
  return new DocumentError("line " + String(line) + ", col " + String(col) + ": " + detail, code, "$");
}

/**
 * D-18a: a merge value is a mapping, or a sequence whose members are all
 * mappings. A scalar value, a scalar member, a sequence inside a merge
 * sequence, and an alias to a sequence of scalars are `parse.codec-syntax`
 * (E-31), raised before anything is counted so that a syntax error wins over
 * every limit code. So is an alias whose anchor is not defined: the input is
 * not well formed, and D-18 and D-22 count a well-formed graph.
 *
 * The walk is a preorder over the written tree in document order (an alias is
 * not followed: its target was visited where it was written), so an anchor is
 * registered before any alias to it is reached. A `<<` pair's value is checked
 * once its whole subtree has been visited, so an anchor defined inside the
 * merge value is known when an alias to it inside the same value is judged.
 */
function validateMergeShapes(root: unknown, text: string): void {
  const anchors = new Map<string, unknown>();
  // The work list holds nodes, and a `<<` pair (a YAML.Pair is never a node)
  // standing for "check this pair's value, its subtree now fully visited".
  const todo: unknown[] = [root];
  const reject = (at: Located, detail: string): ParseError => {
    const [line, col] = startOf(at, text);
    return codecSyntaxError("YAML", detail, text, { line, col });
  };
  /** The offending node of a merge value, or undefined when it is well formed. */
  const malformed = (value: unknown): Located | undefined => {
    const target = YAML.isAlias(value) ? anchors.get(value.source) : value;
    if (YAML.isMap(target)) return undefined;
    if (!YAML.isSeq(target)) return value as Located;
    for (const member of target.items) {
      if (!YAML.isMap(YAML.isAlias(member) ? anchors.get(member.source) : member)) {
        // Blame the merge site: the alias when the sequence is referred to, else the member.
        return (YAML.isAlias(value) ? value : member) as Located;
      }
    }
    return undefined;
  };
  while (todo.length > 0) {
    const node = todo.pop();
    if (YAML.isPair(node)) {
      const bad = malformed(node.value);
      if (bad !== undefined) {
        throw reject(bad, "a merge key's value must be a mapping or a sequence of mappings");
      }
      continue;
    }
    if (YAML.isAlias(node)) {
      if (!anchors.has(node.source)) throw reject(node, "unresolved alias: the anchor is not defined before this point");
      continue;
    }
    if (YAML.isNode(node) && node.anchor !== undefined) anchors.set(node.anchor, node);
    if (YAML.isMap(node)) {
      for (let i = node.items.length - 1; i >= 0; i--) {
        const pair = node.items[i] as YAML.Pair;
        if (isMergeKey(pair.key)) todo.push(pair);
        todo.push(pair.value, pair.key);
      }
    } else if (YAML.isSeq(node)) {
      for (let i = node.items.length - 1; i >= 0; i--) todo.push(node.items[i]);
    }
  }
}

/**
 * Enforce D-18/D-18a/D-19/D-20/D-22 over a parsed YAML document's root node.
 * Throws a `parse.codec-syntax` {@link ParseError} for a malformed merge or an
 * unresolved alias, or a
 * {@link DocumentError} at path `$` with code `document.limit.alias-expansion`
 * when any candidate node's expansion factor exceeds `max` or an anchor
 * refers to itself, or with code `document.limit.expanded-size` when the
 * input contains an alias or merge key and `W(root)` exceeds `maxSlots`. `max`
 * and `maxSlots` are already-resolved positive integers; `text` is the
 * source, used only to report positions.
 */
export function checkAliasExpansion(
  root: unknown,
  max: number,
  text: string,
  maxSlots: number = DEFAULT_MAX_EXPANDED_SLOTS,
): void {
  if (!YAML.isMap(root) && !YAML.isSeq(root)) return; // a scalar root has no candidate
  validateMergeShapes(root, text);
  const limit = BigInt(max);
  const slotLimit = BigInt(maxSlots);
  const anchors = new Map<string, AnchorSlots>();
  const stack: Frame[] = [];
  let sawReference = false; // an alias or a merge key: D-22 applies

  const register = (node: YAML.Node, kind: Kind): AnchorSlots | undefined => {
    if (node.anchor === undefined) return undefined;
    const slots: AnchorSlots = { w: 1n, s: 1n, mw: 0n, kind, done: false };
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
      slots: register(node, isMap ? "map" : "seq"),
      step: 0,
      w: 1n,
      s: 1n,
      mw: 0n,
      ms: 0n,
    });
  };
  /** A written (non-alias) child completes: fold it into its parent. */
  const foldNode = (parent: Frame, role: Role, w: bigint, s: bigint, kind: Kind, mw: bigint, ms: bigint): void => {
    if (role === "plain") {
      parent.w += w;
      parent.s += s;
      // A mapping member of a sequence is what a merge of that sequence flattens.
      if (!parent.isMap && kind === "map") {
        parent.mw += w - 1n;
        parent.ms += s - 1n;
      }
    } else if (role === "merge") {
      // An inline mapping merge source: its container is flattened away, and
      // that container is the `<<` slot already counted in S.
      parent.w += w - 1n;
      parent.s += s - 1n;
    } else if (role === "carrier") {
      parent.w += mw;
      parent.s += ms;
    }
  };
  /** An alias child: it reads its target's memo and writes one slot. */
  const foldAlias = (parent: Frame, role: Role, target: AnchorSlots): void => {
    if (role === "plain") {
      parent.w += target.w;
      parent.s += 1n;
      if (!parent.isMap && target.kind === "map") parent.mw += target.w - 1n;
    } else if (role === "merge") {
      parent.w += target.w - 1n;
    } else if (role === "carrier") {
      parent.w += target.mw;
    }
  };

  enter(root, "plain");
  while (stack.length > 0) {
    const f = stack[stack.length - 1] as Frame;
    if (f.step < f.total) {
      const j = f.step++;
      let child: unknown;
      let role: Role;
      let merging = false;
      if (f.isMap) {
        const pair = (f.node as YAML.YAMLMap).items[j >> 1] as YAML.Pair;
        merging = isMergeKey(pair.key);
        if ((j & 1) === 0) {
          child = pair.key;
          role = "key";
          // The `<<` entry is one written slot, whatever its value holds.
          if (merging) {
            f.s += 1n;
            sawReference = true;
          }
        } else {
          child = pair.value;
          role = merging ? "merge" : "plain";
        }
      } else {
        child = (f.node as YAML.YAMLSeq).items[j];
        role = "plain";
      }
      if (YAML.isAlias(child)) {
        sawReference = true;
        // The shape pass has already refused an alias with no anchor.
        const target = anchors.get(child.source) as AnchorSlots;
        if (!target.done) {
          throw limitError(
            child,
            text,
            "an anchor refers to itself, directly or through other anchors (unbounded alias expansion)",
            ALIAS_EXPANSION_CODE,
          );
        }
        if (role === "merge" && target.kind === "seq") role = "carrier";
        foldAlias(f, role, target);
      } else if (YAML.isMap(child) || YAML.isSeq(child)) {
        enter(child, role === "merge" && YAML.isSeq(child) ? "carrier" : role);
      } else {
        // A scalar (or an empty node): W = S = 1, never a candidate itself.
        if (YAML.isScalar(child)) {
          const slots = register(child, "scalar");
          if (slots !== undefined) slots.done = true;
        }
        foldNode(f, role, 1n, 1n, "scalar", 0n, 0n);
      }
      continue;
    }
    stack.pop();
    // Every mapping and sequence is a candidate, except a merge-position
    // sequence: a carrier is a syntactic wrapper, anchored or not (D-18a).
    if (f.role !== "carrier" && f.w > limit * f.s) {
      throw limitError(
        f.node,
        text,
        "alias expansion factor of this " +
          (f.isMap ? "mapping" : "sequence") +
          " exceeds the configured maximum (" +
          String(max) +
          ")",
        ALIAS_EXPANSION_CODE,
      );
    }
    if (f.slots !== undefined) {
      f.slots.w = f.w;
      f.slots.s = f.s;
      f.slots.mw = f.mw;
      f.slots.done = true;
    }
    const parent = stack[stack.length - 1];
    if (parent === undefined) {
      // The root, last of all: D-22, only once every candidate passed D-18.
      if (sawReference && f.w > slotLimit) {
        throw limitError(
          f.node,
          text,
          "the input expands to " + String(f.w) + " value slots, over the maximum expanded size (" + String(maxSlots) + ")",
          EXPANDED_SIZE_CODE,
        );
      }
    } else {
      foldNode(parent, f.role, f.w, f.s, f.isMap ? "map" : "seq", f.mw, f.ms);
    }
  }
}
