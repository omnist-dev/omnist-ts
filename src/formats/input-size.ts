/**
 * Coarse, library-agnostic pre-parse size guard shared by all four
 * external-library-backed format codecs (json.ts, yaml.ts, toml.ts,
 * xml.ts). See issue #110.
 *
 * Each of those codecs hands its raw input text to an external parsing
 * library (native `JSON.parse`, the `yaml` package, `smol-toml`,
 * `fast-xml-parser`) *before* this repo's own MAX_DEPTH/MAX_NODES checks
 * in buildNode() (src/document.ts) ever run. Those checks bound the
 * *materialized* Document -- they cannot bound work the external library
 * does while producing the intermediate parsed value in the first place.
 * Issue #110's research found that none of the four libraries is a naive
 * stack-recursive parser: V8's JSON.parse does not recurse on the JS
 * stack for nesting; fast-xml-parser's own maxNestedTags guard -- see
 * src/formats/xml.ts's file-top comment -- already rejects a
 * maliciously-deep document inside its own iterative scan loop, well
 * before this repo's checks would see it; smol-toml has its own
 * mutually-recursive-descent depth cap (`maxDepth`, default 1000,
 * enforced in extractValue/parseArray/parseInlineTable, throwing
 * "document contains excessively nested structures" -- this repo's
 * `parseToml` call doesn't override it, so the library's default guard
 * is live and unmodified); the `yaml` package caps alias/anchor
 * expansion via maxAliasCount (default 100), though it has no guard
 * against a plain deeply-nested document (its own compose-node.js source
 * comment acknowledges this can stack-overflow). So three of the four
 * already have *some* structural protection against maliciously deep
 * input, and no single demonstrated crash/hang justified further
 * per-library structural changes. But none of the four libraries bounds
 * the *size* of the raw input text before starting work on it, so an
 * attacker-controlled, arbitrarily large input (e.g. a multi-gigabyte
 * string) can still force substantial CPU/memory use inside the library
 * before any of this repo's own limits get a chance to apply -- that
 * shared gap, not a lack of any per-library depth protection, is what
 * this check closes.
 *
 * This check is intentionally coarse: it bounds input *size* in bytes,
 * not structural *depth* the way MAX_DEPTH does -- reproducing MAX_DEPTH's
 * structural guarantee at the raw-text level would mean writing a
 * bespoke pre-parser for each of four different grammars, which is
 * exactly the complexity this port delegates to the external libraries
 * in the first place. A size cap does not need to be structurally
 * precise to be useful: it closes the "attacker sends a 10GB string"
 * case cheaply (a single length comparison) and meaningfully shrinks the
 * exposure window for the rest, without requiring this port to
 * understand any library's internal parsing behavior.
 *
 * The limit is deliberately generous relative to a legitimate
 * MAX_NODES-sized (1,000,000 node) document. Even in fast-xml-parser's
 * verbose tag-per-node encoding, a document with 1,000,000 minimal leaf
 * nodes (e.g. `<a>0</a>` repeated) serializes to well under 50 MiB; JSON/
 * YAML/TOML are all more compact per node than that. 256 MiB leaves
 * roughly a 5x margin over that worst-case verbose estimate, so no
 * legitimate MAX_NODES-scale document can ever be rejected by this check
 * -- see src/formats/*.test.ts for the sanity check against an actual
 * MAX_NODES-sized document.
 *
 * `text.length` (UTF-16 code units) is used rather than an exact UTF-8
 * byte count: computing the real byte count would mean encoding the
 * entire string up front, which is exactly the O(n) work over
 * attacker-controlled input this check exists to avoid doing before
 * deciding whether to proceed at all. UTF-16 code-unit count is within a
 * small constant factor of UTF-8 byte count for any realistic input
 * (equal for ASCII, at most ~1.5x under for BMP text since a UTF-16
 * surrogate pair -- 4 bytes -- encodes a code point that UTF-8 also
 * spends 4 bytes on), which is more than precise enough for a coarse,
 * order-of-magnitude guard -- this is not trying to replicate MAX_NODES's
 * exact-count guarantee.
 */

import { ParseError } from "../errors.js";

/**
 * 256 MiB. See this file's top comment for how this number was chosen
 * relative to a MAX_NODES-sized document.
 */
export const MAX_INPUT_BYTES = 256 * 1024 * 1024;

/**
 * Reject oversized raw input text before it reaches any external parsing
 * library. Call this first, before the library's own parse function.
 */
export function checkInputSize(text: string, format: string): void {
  if (text.length > MAX_INPUT_BYTES) {
    throw new ParseError(
      "invalid " +
        format +
        ": input is " +
        String(text.length) +
        " UTF-16 code units, exceeding the " +
        String(MAX_INPUT_BYTES) +
        "-byte input size limit (security: this bound is checked before " +
        "the underlying parsing library runs, so a maliciously large " +
        "input is rejected up front instead of being handed to the " +
        "library in full -- see issue #110)",
    );
  }
}
