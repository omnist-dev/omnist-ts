/**
 * Text positions for OML and OSD diagnostics (spec Sec8.4, E-28, E-29).
 *
 * `line` starts at 1 and advances after each LF (CRLF is one break because
 * its CR belongs to the line it ends; a lone CR never advances it). `col` is
 * 1 plus the number of Unicode code points between the start of the line and
 * the failing offset: an astral character (a UTF-16 surrogate pair) counts as
 * one, not two. A lone surrogate is one code point.
 *
 * Cost: one linear scan of `text[0..pos)`. It runs only when a diagnostic is
 * created (once per failed parse), never per token, so a parse of any input
 * stays linear overall.
 */
export function lineCol(text: string, pos: number): [number, number] {
  let line = 1;
  let lineStart = 0;
  for (let i = text.indexOf("\n"); i !== -1 && i < pos; i = text.indexOf("\n", i + 1)) {
    line++;
    lineStart = i + 1;
  }
  let col = 1;
  for (let i = lineStart; i < pos; i++) {
    const c = text.charCodeAt(i);
    // A high surrogate followed by a low surrogate is one code point: skip the low half.
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < pos) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    col++;
  }
  return [line, col];
}
