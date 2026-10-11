/**
 * The three universal safety limits of omnist-spec D-9 (Sec2.4): nesting
 * depth, node count and the digit length of an integer, with their
 * diagnostics (`document.limit.depth`, `document.limit.nodes` and
 * `document.limit.int-digits`, Sec8.3.2, E-4a) and the one place that resolves
 * a caller-supplied value.
 *
 * Every reader takes the three as options (`maxDepth`, `maxNodes`,
 * `maxIntDigits`), the way it takes `maxInputBytes`; each defaults to the
 * reference value of the spec. A value is a safe integer of at least 1, else
 * a `RangeError`: a limit is never "none" (D-10).
 */

/** Maximum nesting depth: levels of node nesting counted from the Document root, which is level 1. */
export const DEFAULT_MAX_DEPTH = 200;
/** Maximum node count: the nodes built for one Document, the root included, scalar leaves not. */
export const DEFAULT_MAX_NODES = 1_000_000;
/** Maximum integer digits: the decimal digits of an integer's value, sign excluded (D-28). */
export const DEFAULT_MAX_INT_DIGITS = 4300;

/** The error code for a nesting-depth refusal. */
export const DEPTH_CODE = "document.limit.depth";
/** The error code for a node-count refusal. */
export const NODES_CODE = "document.limit.nodes";
/** The error code for an integer-digit refusal. */
export const INT_DIGITS_CODE = "document.limit.int-digits";

/** The caller-settable safety limits (spec D-9). Each is a safe integer of at least 1, else a `RangeError`. */
export interface DocumentLimits {
  /**
   * The deepest nesting accepted, counted in levels of node nesting from the
   * Document root (the root is level 1): at 3, `a: { b: { c: 1 } }` is read
   * and `a: { b: { c: { d: 1 } } }` is refused with `document.limit.depth` at
   * `$`. Default 200. Raising it far is bounded by the JavaScript call stack.
   */
  readonly maxDepth?: number;
  /**
   * The most nodes one Document may hold, the root included and scalar leaves
   * not. More is refused with `document.limit.nodes` at `$`. Default 1 000 000.
   */
  readonly maxNodes?: number;
  /**
   * The most decimal digits an integer's value may have, sign excluded; a hex,
   * octal, binary or underscored literal is counted by the value it denotes
   * (D-28). More is refused with `document.limit.int-digits` at the literal's
   * Document path. Default 4300.
   */
  readonly maxIntDigits?: number;
}

/** {@link DocumentLimits} with every value resolved. */
export interface ResolvedLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxIntDigits: number;
}

/** The reference limits of the spec. */
export const DEFAULT_LIMITS: ResolvedLimits = {
  maxDepth: DEFAULT_MAX_DEPTH,
  maxNodes: DEFAULT_MAX_NODES,
  maxIntDigits: DEFAULT_MAX_INT_DIGITS,
};

function resolveOne(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(name + " must be an integer of at least 1, got " + String(value));
  }
  return value;
}

/** Resolve the caller's limits: `undefined` selects the default, anything but a safe integer of at least 1 is a `RangeError`. */
export function resolveLimits(opts: DocumentLimits = {}): ResolvedLimits {
  return {
    maxDepth: resolveOne("maxDepth", opts.maxDepth, DEFAULT_MAX_DEPTH),
    maxNodes: resolveOne("maxNodes", opts.maxNodes, DEFAULT_MAX_NODES),
    maxIntDigits: resolveOne("maxIntDigits", opts.maxIntDigits, DEFAULT_MAX_INT_DIGITS),
  };
}

/** A limit refusal's message, code and Document path, for the caller to wrap in its own error class. */
export interface LimitIssue {
  readonly message: string;
  readonly code: string;
  readonly path: string;
}

/** `document.limit.depth` at `$` (E-4a). */
export function depthIssue(max: number): LimitIssue {
  return { message: "nesting exceeds the maximum depth (" + String(max) + ")", code: DEPTH_CODE, path: "$" };
}

/** `document.limit.nodes` at `$` (E-4a). */
export function nodesIssue(max: number): LimitIssue {
  return { message: "node count exceeds the maximum (" + String(max) + ")", code: NODES_CODE, path: "$" };
}

/** `document.limit.int-digits` at the Document path of the literal (E-4a, E-10). */
export function intDigitsIssue(max: number, path: string): LimitIssue {
  return {
    message:
      path +
      ": integer has more than " +
      String(max) +
      " digits, exceeding the digit limit (security: unbounded-digit int-to-str conversion is superlinear)",
    code: INT_DIGITS_CODE,
    path,
  };
}

/**
 * Stands in a parsed tree for an integer literal whose value has more decimal
 * digits than the limit. A reader that can see the digits before it converts
 * them (JSON, YAML and OML) puts this where the integer would be instead of
 * building a huge `bigint` from untrusted text; the builder then refuses the
 * tree at the literal's Document path. It never reaches a caller.
 */
export class OverlongInteger {
  /** Marks the type; the instance carries nothing else. */
  readonly overlong = true;
}

const LOG10: Readonly<Record<number, number>> = { 2: Math.log10(2), 8: Math.log10(8), 16: Math.log10(16) };
const PREFIX: Readonly<Record<number, string>> = { 2: "0b", 8: "0o", 16: "0x" };

/**
 * Does the integer written as `digits` (no sign, no prefix, no underscores) in
 * `radix` have more than `max` decimal digits (D-28)? A decimal literal is
 * measured by its length once leading zeros are gone. In another radix the
 * count is bracketed from the length alone, so a huge literal is decided
 * without converting it; the conversion runs only when the value is within a
 * digit or two of the limit.
 */
export function digitsExceed(digits: string, radix: 2 | 8 | 10 | 16, max: number): boolean {
  let start = 0;
  while (start < digits.length - 1 && digits.charAt(start) === "0") start++;
  const d = digits.length - start;
  if (radix === 10) return d > max;
  const per = LOG10[radix] as number;
  // The value is at least radix^(d-1) and below radix^d; the margins absorb floating-point error.
  const lowest = Math.floor((d - 1) * per - 1e-9) + 1;
  if (lowest > max) return true;
  const highest = Math.ceil(d * per + 1e-9);
  if (highest <= max) return false;
  return BigInt((PREFIX[radix] as string) + digits.slice(start)).toString().length > max;
}

/** Does `v` have more than `max` decimal digits, sign excluded (D-28)? Decided without a decimal conversion of a huge value. */
export function bigintExceeds(v: bigint, max: number): boolean {
  return digitsExceed((v < 0n ? -v : v).toString(16), 16, max);
}
