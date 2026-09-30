/**
 * Codec syntax errors (spec E-31, E-11, DIV-8): every JSON, YAML, TOML and
 * XML SYNTAX error a reader raises is `parse.codec-syntax` with a `path` that
 * is a real `line:col` text position inside the input -- never omitted, never
 * `0:0`. WHICH character is blamed is left to the codec library; where the
 * library reports nothing usable the position is `1:1` (E-31).
 *
 * A column this module converts itself is counted in code points (E-28), so
 * a library that counts UTF-16 units (smol-toml, fast-xml-parser) or hands
 * back an offset (yaml, JSON.parse) is normalized through the shared
 * {@link lineCol}.
 */

import { ParseError } from "../errors.js";
import { lineCol } from "../position.js";

/** Where a library blamed: a UTF-16 offset, a 1-based line/UTF-16 column, or nothing. */
export type CodecBlame =
  | { readonly offset: number }
  | { readonly line: number; readonly col?: number | undefined }
  | undefined;

const LF = String.fromCharCode(10);

/** The UTF-16 offset a blame resolves to, clamped into `[0, text.length]`. */
function blameOffset(text: string, at: NonNullable<CodecBlame>): number {
  if ("offset" in at) return Math.max(0, Math.min(at.offset, text.length));
  // line/col: find the start of the 1-based line, then add the column.
  let start = 0;
  for (let l = 1; l < at.line; l++) {
    const nl = text.indexOf(LF, start);
    if (nl === -1) return text.length;
    start = nl + 1;
  }
  const nextNl = text.indexOf(LF, start);
  const lineEnd = nextNl === -1 ? text.length : nextNl;
  const col = at.col === undefined ? 1 : Math.max(1, at.col);
  return Math.min(start + col - 1, lineEnd);
}

/** Build the `parse.codec-syntax` {@link ParseError} for a codec library failure. */
export function codecSyntaxError(format: string, detail: string, text: string, at?: CodecBlame): ParseError {
  const [line, col] = at === undefined ? [1, 1] : lineCol(text, blameOffset(text, at));
  return new ParseError(
    `invalid ${format}: line ${line}, col ${col}: ${detail}`,
    [],
    "parse.codec-syntax",
    `${line}:${col}`,
  );
}
