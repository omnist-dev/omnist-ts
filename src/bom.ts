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

const BOM = "\uFEFF";

/**
 * Strip exactly ONE U+FEFF, and only at offset zero. A doubled mark leaves
 * the second one in place as ordinary content (which each reader then treats
 * on its own terms); a U+FEFF anywhere else is untouched.
 */
export function stripLeadingBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(1) : text;
}
