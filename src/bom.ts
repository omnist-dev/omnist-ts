/**
 * Shared leading byte-order-mark handling (spec D-15, docs/02-document-model.md
 * Sec2.5). Every READ surface -- OML, OSD, and each codec -- calls
 * {@link stripLeadingBom} at the very front of its reader so BOM handling
 * lives in exactly one place.
 *
 * The mark is written as an escaped "\uFEFF" here and everywhere else in this
 * repo, never as a raw invisible character in source (an invisible literal is
 * invisible to grep and is how a duplicate open-coded strip once went unseen).
 */

import { ParseError } from "./errors.js";

const BOM = "\uFEFF";

/**
 * Strip exactly ONE U+FEFF, and only at offset zero. A doubled mark leaves
 * the second one in place as ordinary content (which each reader then treats
 * on its own terms); a U+FEFF anywhere else is untouched.
 */
export function stripLeadingBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(1) : text;
}

/**
 * D-21 (Sec2.5): after D-15's strip, a U+FEFF still standing at offset zero
 * of the remaining text MUST be rejected, at text position `1:1` (computed on
 * the text that remains), with `parse.codec-syntax` on the four codecs (E-24:
 * a byte-level precondition this spec imposes ahead of the codec). It is an
 * explicit pre-check, never left to the codec's library: `yaml` and
 * `fast-xml-parser` would otherwise silently swallow the second mark (a
 * second, undeclared strip). OML and OSD reject it on their own lexers
 * (`parse.unexpected-token`, `1:1`), so they do not call this.
 *
 * Call with the text ALREADY passed through {@link stripLeadingBom}.
 */
export function rejectSecondLeadingBom(strippedText: string, format: string): void {
  if (strippedText.startsWith(BOM)) {
    throw new ParseError(
      `invalid ${format}: a second leading byte-order mark is rejected (only one is consumed)`,
      [],
      "parse.codec-syntax",
      "1:1",
    );
  }
}
