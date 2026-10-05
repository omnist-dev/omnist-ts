/**
 * The maximum input size (omnist-spec Sec2.4.2, D-23 to D-26).
 *
 * A reader MUST refuse an input of more than `maxInputBytes` bytes with
 * `document.limit.input-size` at `$` (D-23), and accept one of exactly that
 * many. The size is checked FIRST: before the byte-order mark is stripped
 * (the mark's three bytes count), before any decoding or parsing, so an
 * oversized input is refused even if it is also malformed.
 *
 * Bytes, not characters. A JS string is UTF-16, so its UTF-8 size is
 * computed (a code unit below U+0080 is one byte, below U+0800 two, a
 * surrogate pair four, anything else three; a lone surrogate is counted as
 * three, the size of the U+FFFD that would stand for it). The count is only
 * done when it can matter: a string with more code units than the maximum is
 * over it already (a code unit is at least a byte), and a string of at most
 * a third of the maximum is under it (a code unit is at most three bytes).
 *
 * Why a byte cap at all: it is the one thing that bounds the cost of a
 * parsing library's superlinear cases without this port writing its own
 * parsers (issue #110), and the spec's D-24 asks for a finite default. It
 * bounds the cost; it does not make a parse fast. See docs/limitations.md,
 * "The 64 MiB input-size limit", for what it does and does not bound.
 */

import { ParseError } from "../errors.js";

/** The error code for a D-23 refusal (omnist-spec Sec8.3.2). */
export const INPUT_SIZE_CODE = "document.limit.input-size";

/**
 * The default maximum input size: 64 MiB (`64 * 1024 * 1024` bytes). D-24 sets
 * no reference default; this port's is large enough that no document within
 * the MAX_NODES limit is refused (a 1,000,000-leaf XML document is well under
 * 50 MiB) and small enough to bound memory, which is what the 256 MiB
 * UTF-16-unit guard it replaces did not do.
 */
export const DEFAULT_MAX_INPUT_BYTES = 64 * 1024 * 1024;

const HINT = "pass maxInputBytes to raise it";

/**
 * Resolve a caller-supplied maximum: `undefined` selects
 * {@link DEFAULT_MAX_INPUT_BYTES}; otherwise it must be a safe integer of at
 * least 1, else a `RangeError`. Zero, a negative number, `NaN`, `Infinity`
 * and a fraction are refused rather than silently replaced: a limit is never
 * "none" (D-10, D-24), and a size limit of zero or less admits nothing.
 */
export function resolveMaxInputBytes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_INPUT_BYTES;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("maxInputBytes must be an integer of at least 1, got " + String(value));
  }
  return value;
}

/** The UTF-8 size of `text` in bytes (a lone surrogate counts as three). */
export function utf8Length(text: string): number {
  const len = text.length;
  let bytes = len;
  for (let i = 0; i < len; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) continue;
    if (c < 0x800) {
      bytes += 1;
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < len && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 2; // a surrogate pair: two code units, four bytes
      i++;
    } else {
      bytes += 2;
    }
  }
  return bytes;
}

/** The D-23 refusal: `document.limit.input-size` at `$`. */
export function inputSizeError(maxInputBytes: number, hint: string = HINT): ParseError {
  return new ParseError(
    "input exceeds the maximum input size (" + String(maxInputBytes) + " bytes); " + hint,
    [],
    INPUT_SIZE_CODE,
    "$",
  );
}

/**
 * D-23: refuse `text` if it is more than `maxInputBytes` bytes (the default
 * when `undefined`), accept it at exactly that many. Call it first, before the
 * byte-order mark is stripped and before anything else reads the text.
 */
export function checkInputSize(text: string, maxInputBytes: number | undefined, hint: string = HINT): void {
  const max = resolveMaxInputBytes(maxInputBytes);
  const units = text.length;
  if (units > max || (units * 3 > max && utf8Length(text) > max)) {
    throw inputSizeError(max, hint);
  }
}
