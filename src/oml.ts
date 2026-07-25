/**
 * OML (Omnist Markup Language) -- the native codec for the Document model.
 * Ported from `omnist/oml.py`. Normative grammar:
 * `docs/design/oml-grammar.md` in the Python repo.
 *
 * OML is omnist's own serialization format: every Document round-trips
 * through it exactly, with no adjustment ever needed (unlike JSON/YAML/
 * TOML/XML). This module implements OML-Core in full, plus the
 * OML-Extended raw-string (`'...'`) and triple-quoted multiline-string
 * (`"""..."""`) read-only spellings. The canonical writer only ever emits
 * OML-Core.
 *
 * ## Scalar-kind mapping vs. Python (see src/document.ts's file-top comment)
 *
 * Python's `omnist/oml.py` reads a source `DATE` token into a distinct
 * `datetime.date` object and a `DATETIME` token into a distinct
 * `datetime.datetime` object; the two never compare equal. This port's
 * Document model (`src/document.ts`) maps *both* onto the single native
 * `Date` type -- there is no `date`-without-time-of-day type in JS -- so
 * `readOml` maps a `DATE` token to a UTC midnight `Date` and a `DATETIME`
 * token to a `Date` at the parsed instant, and `writeOml` picks `DATE` vs.
 * `DATETIME` output shape by inspecting whether the `Date`'s UTC
 * time-of-day is exactly midnight. This is the same ambiguity
 * `src/document.ts` and `src/schema.ts` already document and accept for the
 * `Date` type generally (a real `Date` value alone can't signal which of
 * `date`/`datetime` it was meant to be) -- OML's zero-loss guarantee here
 * means `readOml(writeOml(node)) == node` at the *Document-node* level
 * (value equality, per `nodeEquals`), not byte-identical source-token-kind
 * preservation, which the Document model itself cannot represent losslessly
 * for a `Date` at exactly UTC midnight -- except where the source literal
 * carried an explicit UTC offset, which `src/temporal.ts` now records
 * out-of-band (issue #51) so `writeOml` re-emits the offset it was given
 * rather than silently normalizing the value to UTC. That normalization was
 * only round-trip-safe with this implementation on both ends: Python reads an
 * offset-less literal as a *naive local* datetime, so `2024-01-01T12:00:00Z`
 * written back as `2024-01-01T12:00:00` changed the value across
 * implementations. An offset-tagged datetime is also never collapsed to a bare
 * `DATE`, even at exactly midnight, since the offset is itself the signal that
 * a DATETIME was read.
 *
 * ## The `TIME` token and time-shaped strings (issue #52)
 *
 * A `TIME` token maps to a plain `string` (again matching `document.ts`'s
 * mapping -- JS has no bare time-of-day type). OML is the one format this port
 * supports whose grammar has a native `TIME` token, so quoting every such
 * string on the way out meant a valid OML document did not survive
 * `readOml` then `writeOml` unchanged: `a: 12:00` came back as `a: "12:00"`,
 * which a later reader -- or Python -- sees as a string, not a time. `writeOml`
 * therefore emits a bare `TIME` token for any string whose text is a valid TIME
 * literal (shape *and* range, via `parseTimeToken`, so e.g. `"24:00"` stays
 * quoted).
 *
 * The deliberate cost, stated because it is a real one: the Document model
 * cannot tell a string that came from a `TIME` token from an ordinary string of
 * the same shape, and no `WeakMap` tag can close that gap because a string is a
 * primitive with no identity to key on. So an ordinary `"12:00"` is promoted
 * to a `TIME` literal on write. That direction is the cheaper loss: it does not
 * affect the Document-level round trip at all (reading a `TIME` token yields
 * the same string back, so `readOml(writeOml(n)) == n` either way), whereas the
 * old behavior destroyed a token the format can carry. See
 * `docs/formats/oml.md`.
 *
 * ## Schema-directed reads (issue #7)
 *
 * `readOml(text, { schema })` accepts a `Schema` (issue #3, `src/schema.ts`)
 * and hands the parsed node to `materialize` (`src/deserialize.ts`, issue
 * #7), which both leaf-type-converts (e.g. a schema-declared `number`
 * field's integer-shaped value into a floating-point one, or a
 * `date`-shaped string into a `Date`) and shape-checks (cardinality,
 * closedness) in one pass -- see that module's file-top comment. If the
 * result can't be made to conform, `materialize` raises a `ParseError`
 * carrying the full structured issue list (every problem found, not just
 * the first); `readOml` lets that propagate as-is.
 */

import type { Edge, Node, Scalar } from "./document.js";
import { ParseError } from "./errors.js";
import { WriteReport } from "./report.js";
import type { Schema } from "./schema.js";
import { materialize } from "./deserialize.js";
import {
  datetimeOffset,
  parseDateToken,
  parseDatetimeToken,
  parseTimeToken,
} from "./temporal.js";

// Matches src/document.ts's own MAX_DEPTH and MAX_INT_DIGITS constants
// (locally redefined here, same as src/schema.ts's own MAX_DEPTH -- see
// that file's precedent for this "each module keeps its own copy of the
// shared guard constant" convention in this port).
const MAX_DEPTH = 200;
const MAX_INT_DIGITS = 4300;

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokKind =
  | "SEP"
  | "STRING"
  | "LBRACE"
  | "RBRACE"
  | "LBRACKET"
  | "RBRACKET"
  | "COMMA"
  | "COLON"
  | "DATETIME"
  | "DATE"
  | "TIME"
  | "NUMDEC"
  | "NUMEXP"
  | "NEGINF"
  | "NANLIT"
  | "POSINF"
  | "INTEGER"
  | "IDENT"
  | "EOF";

// The master regex's raw named-group alternatives -- a superset of TokKind:
// several groups (SEPWS, DQUOTE3, DQFAST, DQUOTE, RAW, SQUOTE) are resolved
// into a TokKind (or consumed entirely, e.g. skipped whitespace) inside
// Scanner.next rather than being a token kind in their own right.
type GroupName =
  | "SEPWS"
  | "DQUOTE3"
  | "DQFAST"
  | "DQUOTE"
  | "RAW"
  | "SQUOTE"
  | Exclude<TokKind, "SEP" | "STRING" | "EOF">;

// Static, allocation-free list of GroupName in MASTER's alternation order --
// used by Scanner.next to find which named group matched without calling
// Object.keys(m.groups) (a fresh array + linear scan) on every single token.
// See issue #35: on a 100k-edge document this dispatch runs ~400k-500k
// times, so avoiding the per-call allocation matters.
const GROUP_NAMES: readonly GroupName[] = [
  "SEPWS",
  "DQUOTE3",
  "DQFAST",
  "DQUOTE",
  "RAW",
  "SQUOTE",
  "LBRACE",
  "RBRACE",
  "LBRACKET",
  "RBRACKET",
  "COMMA",
  "COLON",
  "DATETIME",
  "DATE",
  "TIME",
  "NUMDEC",
  "NUMEXP",
  "NEGINF",
  "NANLIT",
  "POSINF",
  "INTEGER",
  "IDENT",
];

const RESERVED: ReadonlySet<string> = new Set(["null", "true", "false"]);
const RESERVED_NUMBER: ReadonlySet<string> = new Set(["nan", "inf", "-inf"]);

// Matches src/schema.ts's DATE_RE/TIME_RE/DATETIME_RE shapes (kept as an
// independent definition here, same as Python's oml.py imports the shared
// pattern *source* from schema.py to avoid drift -- schema.ts doesn't
// export its regex constants yet, so this is a parallel definition of the
// same grammar rather than a shared import; see the PR description).
const DATE_SRC = String.raw`\d{4}-\d{2}-\d{2}`;
const TIME_BODY_SRC = String.raw`\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:[+-]\d{2}:\d{2})?`;
const DATETIME_SRC = `${DATE_SRC}T${TIME_BODY_SRC}`;

// The TIME token's shape, anchored, for the writer's `isTimeLiteral` check
// (issue #52). Built from the same `TIME_BODY_SRC` the tokenizer uses, so the
// reader and the writer cannot disagree about what a TIME literal looks like.
const TIME_ONLY_RE = new RegExp(`^(?:${TIME_BODY_SRC})$`);

// One compiled alternation, tried in the exact priority order the grammar
// (docs/design/oml-grammar.md §1) specifies -- see that file and
// omnist/oml.py's own _MASTER for the rationale behind the ordering
// (DQUOTE3 before DQFAST, DATETIME before DATE before TIME, the three
// reserved float spellings before INTEGER/IDENT). JS's `y` (sticky) flag
// anchors each attempt at `lastIndex` exactly, giving the same "match at
// this exact position or fail" semantics as Python's `re.Pattern.match`.
const MASTER_SRC =
  String.raw`(?<SEPWS>(?:[ \t]|#[^\n]*|\r\n|\n|;)+)` +
  `|(?<DQUOTE3>""")` +
  String.raw`|(?<DQFAST>"[^"\\\x00-\x1f]*")` +
  `|(?<DQUOTE>")` +
  String.raw`|(?<RAW>'[^']*')` +
  `|(?<SQUOTE>')` +
  String.raw`|(?<LBRACE>\{)` +
  String.raw`|(?<RBRACE>\})` +
  String.raw`|(?<LBRACKET>\[)` +
  String.raw`|(?<RBRACKET>\])` +
  `|(?<COMMA>,)` +
  `|(?<COLON>:)` +
  `|(?<DATETIME>${DATETIME_SRC})` +
  `|(?<DATE>${DATE_SRC})` +
  `|(?<TIME>${TIME_BODY_SRC})` +
  String.raw`|(?<NUMDEC>-?\d+\.\d+(?:[eE][+-]?\d+)?)` +
  String.raw`|(?<NUMEXP>-?\d+[eE][+-]?\d+)` +
  String.raw`|(?<NEGINF>-inf(?![A-Za-z0-9-]))` +
  String.raw`|(?<NANLIT>nan(?![A-Za-z0-9-]))` +
  String.raw`|(?<POSINF>inf(?![A-Za-z0-9-]))` +
  String.raw`|(?<INTEGER>-?\d+)` +
  String.raw`|(?<IDENT>[A-Za-z_][A-Za-z0-9_-]*)`;

const MASTER = new RegExp(MASTER_SRC, "y");

const ESCAPES: ReadonlyMap<string, string> = new Map([
  ['"', '"'],
  ["\\", "\\"],
  ["/", "/"],
  ["b", "\b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
]);

const HEX4_RE = /^[0-9A-Fa-f]{4}$/;

function isSepSpan(text: string): boolean {
  return text.includes("\n") || text.includes(";") || text.includes("\r");
}

/** A token as `[kind, start, end]` -- no materialized Token class/list, same
 * as `omnist/oml.py`'s `_Scanner`/`_Parser` pair. */
type Tok = readonly [TokKind, number, number];

class Scanner {
  readonly s: string;
  readonly n: number;
  pos: number;

  constructor(text: string) {
    this.s = text.startsWith("﻿") ? text.slice(1) : text;
    this.n = this.s.length;
    this.pos = 0;
  }

  lineCol(pos: number): [number, number] {
    const s = this.s;
    let line = 1;
    let lastNl = -1;
    for (let i = 0; i < pos; i++) {
      if (s[i] === "\n") {
        line++;
        lastNl = i;
      }
    }
    const col = lastNl !== -1 ? pos - lastNl : pos + 1;
    return [line, col];
  }

  errorAt(pos: number, msg: string): ParseError {
    const [line, col] = this.lineCol(pos);
    return new ParseError(`line ${line}, col ${col}: ${msg}`);
  }

  errorEof(msg: string): ParseError {
    // Quirk preserved from the Python scanner: an EOF token carries no
    // position, so any "got EOF" error names line 0, col 0 rather than the
    // source's actual end position. See omnist/oml.py's _Scanner.error_eof.
    return new ParseError(`line 0, col 0: ${msg}`);
  }

  next(): Tok {
    const s = this.s;
    const n = this.n;
    let pos = this.pos;
    for (;;) {
      if (pos >= n) {
        this.pos = pos;
        return ["EOF", pos, pos];
      }
      MASTER.lastIndex = pos;
      const m = MASTER.exec(s);
      if (m === null || m.index !== pos) {
        throw this.errorAt(pos, `stray character ${JSON.stringify(s[pos])}`);
      }
      // MASTER always has named groups (the whole pattern is one alternation
      // of `(?<name>...)` groups), so a successful match always has `.groups`.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const groups = m.groups!;
      let kind: GroupName | undefined;
      // Walk the static GROUP_NAMES array instead of Object.keys(groups):
      // no per-call allocation, and a plain indexed for-loop over a small
      // fixed array beats both Object.keys().find() and a for-in loop over
      // the (null-prototype) match-groups object -- measured in the PR for
      // issue #35.
      for (let gi = 0; gi < GROUP_NAMES.length; gi++) {
        // In-bounds index; see the bounds check in the loop condition.
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const k = GROUP_NAMES[gi]!;
        if (groups[k] !== undefined) {
          kind = k;
          break;
        }
      }
      const end = MASTER.lastIndex;
      /* v8 ignore start -- unreachable: MASTER always has exactly one named
       * alternative matched whenever `m` is non-null (the whole pattern is
       * one top-level alternation of named groups; a successful match
       * always sets exactly one), so `kind` can never actually be
       * `undefined` here. Kept as a defensive backstop, not a tested path. */
      if (kind === undefined) {
        throw this.errorAt(pos, "internal tokenizer error: no group matched");
      }
      /* v8 ignore stop */
      if (kind === "SEPWS") {
        if (isSepSpan(m[0])) {
          this.pos = end;
          return ["SEP", pos, end];
        }
        pos = end;
        continue;
      }
      if (kind === "DQUOTE3") {
        const [start, mend] = this.scanMultiline(pos);
        this.pos = mend;
        return ["STRING", start, mend];
      }
      if (kind === "DQUOTE") {
        const [start, mend] = this.scanStringSlow(pos);
        this.pos = mend;
        return ["STRING", start, mend];
      }
      if (kind === "DQFAST" || kind === "RAW") {
        this.pos = end;
        return ["STRING", pos, end];
      }
      if (kind === "SQUOTE") {
        throw this.errorAt(pos, "unterminated raw string (missing closing ')");
      }
      this.pos = end;
      return [kind, pos, end];
    }
  }

  private scanStringSlow(start: number): [number, number] {
    const s = this.s;
    const n = this.n;
    let i = start + 1;
    for (;;) {
      if (i >= n) {
        throw this.errorAt(start, 'unterminated string (missing closing ")');
      }
      // In-bounds index; see the bounds check just above.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const ch = s[i]!;
      if (ch === '"') return [start, i + 1];
      if (ch === "\\") {
        i = this.skipEscape(start, i);
        continue;
      }
      if (ch.charCodeAt(0) < 0x20) {
        throw this.errorAt(
          start,
          `control character U+${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")} in string`,
        );
      }
      i += 1;
    }
  }

  private scanMultiline(start: number): [number, number] {
    const s = this.s;
    const n = this.n;
    let i = start + 3;
    if (s.slice(i, i + 1) === "\n") {
      i += 1;
    } else if (s.slice(i, i + 2) === "\r\n") {
      i += 2;
    }
    for (;;) {
      if (i >= n) {
        throw this.errorAt(
          start,
          'unterminated multiline string (missing closing """)',
        );
      }
      // In-bounds index; see the bounds check just above.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const ch = s[i]!;
      if (ch === '"') {
        let run = 0;
        let j = i;
        while (j < n && s[j] === '"') {
          run += 1;
          j += 1;
        }
        if (run >= 3) return [start, i + 3];
        i = j;
        continue;
      }
      if (ch === "\\") {
        i = this.skipEscape(start, i);
        continue;
      }
      if (ch === "\t" || ch === "\n" || ch.charCodeAt(0) >= 0x20) {
        i += 1;
        continue;
      }
      throw this.errorAt(
        start,
        `control character U+${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")} in multiline string`,
      );
    }
  }

  /** Validate (don't decode) one escape sequence starting at `s[i] ==
   * '\\'`; return the position just past it. Decoding happens later, only
   * if the token is actually consumed by the parser. Errors report
   * `tokStart` (the enclosing string's opening quote), matching Python's
   * `_skip_escape`. */
  private skipEscape(tokStart: number, i: number): number {
    const s = this.s;
    const n = this.n;
    if (i + 1 >= n) {
      throw this.errorAt(tokStart, "unterminated escape sequence");
    }
    // In-bounds index; see the bounds check just above.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const c = s[i + 1]!;
    if (ESCAPES.has(c)) return i + 2;
    if (c === "u") {
      const hexs = s.slice(i + 2, i + 6);
      if (hexs.length !== 4 || !HEX4_RE.test(hexs)) {
        throw this.errorAt(tokStart, "invalid \\u escape (need 4 hex digits)");
      }
      const cp = parseInt(hexs, 16);
      const j = i + 6;
      if (cp >= 0xd800 && cp <= 0xdbff) {
        const hex2 = s.slice(j + 2, j + 6);
        if (s.slice(j, j + 2) === "\\u" && hex2.length === 4 && HEX4_RE.test(hex2)) {
          const low = parseInt(hex2, 16);
          if (low >= 0xdc00 && low <= 0xdfff) {
            return j + 6;
          }
        }
        throw this.errorAt(
          tokStart,
          `unpaired high surrogate \\u${hexs} (needs a following low-surrogate ` +
            "\\uDC00-\\uDFFF escape)",
        );
      }
      if (cp >= 0xdc00 && cp <= 0xdfff) {
        throw this.errorAt(tokStart, `unpaired low surrogate \\u${hexs}`);
      }
      return j;
    }
    throw this.errorAt(tokStart, `invalid escape \\${c}`);
  }
}

// ---------------------------------------------------------------------------
// Value decoding -- deferred until the parser actually consumes a token.
// ---------------------------------------------------------------------------

function decodeDquote(text: string): string {
  if (!text.includes("\\")) return text.slice(1, -1);
  const out: string[] = [];
  let i = 1;
  const n = text.length - 1;
  while (i < n) {
    // In-bounds index; see the bounds check just above.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const ch = text[i]!;
    if (ch === "\\") {
      const [esc, next] = decodeEscape(text, i);
      out.push(esc);
      i = next;
    } else {
      out.push(ch);
      i += 1;
    }
  }
  return out.join("");
}

function decodeMultiline(text: string): string {
  let body = text.slice(3, -3);
  if (body.slice(0, 1) === "\n") {
    body = body.slice(1);
  } else if (body.slice(0, 2) === "\r\n") {
    body = body.slice(2);
  }
  if (!body.includes("\\")) return body;
  const out: string[] = [];
  let i = 0;
  const n = body.length;
  while (i < n) {
    // In-bounds index; see the bounds check just above.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const ch = body[i]!;
    if (ch === "\\") {
      const [esc, next] = decodeEscape(body, i);
      out.push(esc);
      i = next;
    } else {
      out.push(ch);
      i += 1;
    }
  }
  return out.join("");
}

function decodeEscape(s: string, i: number): [string, number] {
  // In-bounds index; see the bounds check just above.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const c = s[i + 1]!;
  const simple = ESCAPES.get(c);
  if (simple !== undefined) return [simple, i + 2];
  // c === "u" (the only remaining valid case, already validated by the
  // scanner's skipEscape).
  const hexs = s.slice(i + 2, i + 6);
  const cp = parseInt(hexs, 16);
  const j = i + 6;
  if (cp >= 0xd800 && cp <= 0xdbff) {
    const low = parseInt(s.slice(j + 2, j + 6), 16);
    // JS strings are UTF-16 code-unit sequences: concatenating the raw
    // high/low surrogate code units directly (rather than combining them
    // into one Unicode scalar value first, as Python must) already forms
    // the correct astral character.
    return [String.fromCharCode(cp) + String.fromCharCode(low), j + 6];
  }
  return [String.fromCharCode(cp), j];
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class Parser {
  private readonly sc: Scanner;
  private kind: TokKind;
  private start: number;
  private end: number;

  constructor(scanner: Scanner) {
    this.sc = scanner;
    [this.kind, this.start, this.end] = scanner.next();
  }

  private advance(): Tok {
    const cur: Tok = [this.kind, this.start, this.end];
    [this.kind, this.start, this.end] = this.sc.next();
    return cur;
  }

  private skipSep(): void {
    while (this.kind === "SEP") this.advance();
  }

  private errorFor(kind: TokKind, pos: number, msg: string): ParseError {
    if (kind === "EOF") return this.sc.errorEof(msg);
    return this.sc.errorAt(pos, msg);
  }

  parseDocument(): Node {
    this.skipSep();
    let node: Node;
    if (this.kind === "EOF") {
      node = [];
    } else if (this.kind === "LBRACE") {
      node = this.parseValue(0);
    } else if (this.looksLikeEdge()) {
      node = this.parseNodeEdges(0);
    } else {
      node = this.parseScalar();
    }
    this.skipSep();
    if (this.kind !== "EOF") {
      const text = this.tokText(this.kind, this.start, this.end);
      throw this.sc.errorAt(
        this.start,
        "unexpected trailing content after the document body " +
          `(token ${this.kind} ${JSON.stringify(text)})`,
      );
    }
    return node;
  }

  private looksLikeEdge(): boolean {
    if (this.kind === "STRING") {
      return this.peekKindAfterCurrent() === "COLON";
    }
    if (this.kind === "IDENT") {
      const text = this.sc.s.slice(this.start, this.end);
      if (RESERVED.has(text)) return false;
      return this.peekKindAfterCurrent() === "COLON";
    }
    return false;
  }

  /** One token of lookahead past the current token, without consuming it:
   * save the scanner position, pull the next token, restore. */
  private peekKindAfterCurrent(): TokKind {
    const saved = this.sc.pos;
    const [kind] = this.sc.next();
    this.sc.pos = saved;
    return kind;
  }

  private parseNodeEdges(depth: number): Edge[] {
    const edges: Edge[] = [];
    this.skipSep();
    while (this.kind !== "RBRACE" && this.kind !== "EOF") {
      const label = this.parseLabel();
      const [colonKind, colonStart, colonEnd] = this.advance();
      if (colonKind !== "COLON") {
        const text = this.tokText(colonKind, colonStart, colonEnd);
        throw this.errorFor(
          colonKind,
          colonStart,
          `expected ':' after label ${JSON.stringify(label)}, got ${colonKind} ${JSON.stringify(text)}`,
        );
      }
      if (this.kind === "LBRACKET") {
        for (const element of this.parseArray(depth)) {
          edges.push({ label, target: element });
        }
      } else {
        const value = this.parseValue(depth);
        edges.push({ label, target: value });
      }
      // Cast: TS's control-flow narrowing assumes the `while` guard above
      // still holds here, but `this.kind` was reassigned in between by
      // `parseValue`/`parseArray` (via `advance`) -- a known TS limitation
      // with mutable class-field narrowing across method calls in a loop.
      const kindNow = this.kind as TokKind;
      if (kindNow === "RBRACE" || kindNow === "EOF") break;
      if (kindNow !== "SEP") {
        const text = this.tokText(this.kind, this.start, this.end);
        throw this.sc.errorAt(
          this.start,
          "expected a separator (newline or ';') or '}' after the value for " +
            `${JSON.stringify(label)}, got ${this.kind} ${JSON.stringify(text)}`,
        );
      }
      this.skipSep();
    }
    return edges;
  }

  /** A token's display text for error messages. See omnist/oml.py's
   * `_tok_text` for the preserved-verbatim asymmetry: a raw string (E2)
   * displays its decoded value, but a dquote/multiline string displays its
   * raw source slice (delimiters included). */
  private tokText(kind: TokKind, start: number, end: number): string {
    if (kind === "STRING" && this.sc.s.slice(start, start + 1) === "'") {
      return this.stringValue(start, end);
    }
    return this.sc.s.slice(start, end);
  }

  private parseLabel(): string {
    const [kind, start, end] = this.advance();
    if (kind === "STRING") return this.stringValue(start, end);
    if (kind === "IDENT") {
      const text = this.sc.s.slice(start, end);
      if (RESERVED.has(text)) {
        throw this.sc.errorAt(
          start,
          `${JSON.stringify(text)} is a reserved word and cannot be a bare label; ` +
            `quote it: "${text}"`,
        );
      }
      return text;
    }
    const text = this.tokText(kind, start, end);
    throw this.errorFor(kind, start, `expected a label, got ${kind} ${JSON.stringify(text)}`);
  }

  private parseValue(depth: number): Node {
    if (this.kind === "LBRACE") {
      if (depth + 1 > MAX_DEPTH) {
        // No "line X, col Y:" prefix here, matching omnist/oml.py's
        // parse_value exactly (a bare ParseError for this one message).
        throw new ParseError(`nesting exceeds the maximum depth (${MAX_DEPTH})`);
      }
      this.advance();
      this.skipSep();
      const edges = this.parseNodeEdges(depth + 1);
      this.skipSep();
      const [closeKind, closeStart, closeEnd] = this.advance();
      if (closeKind !== "RBRACE") {
        const text = this.tokText(closeKind, closeStart, closeEnd);
        throw this.errorFor(
          closeKind,
          closeStart,
          `expected '}', got ${closeKind} ${JSON.stringify(text)}`,
        );
      }
      return edges;
    }
    return this.parseScalar();
  }

  /** `'[' element (',' element)* [','] ']'` -- pure edge-multiplication
   * sugar (issue #218 upstream), expanded here into the returned element
   * list; the caller splices these into the edge list as repeated
   * same-label edges. Never itself a Document-model value. */
  private parseArray(depth: number): Node[] {
    const openStart = this.start;
    this.advance(); // consume '['
    this.skipSep();
    if (this.kind === "RBRACKET") {
      throw this.sc.errorAt(openStart, "empty array is not allowed");
    }
    const elements: Node[] = [];
    for (;;) {
      if (this.kind === "LBRACKET") {
        throw this.sc.errorAt(
          this.start,
          "nested array is not allowed (arrays may only contain scalars, " +
            "null, or brace subtrees)",
        );
      }
      elements.push(this.parseValue(depth));
      this.skipSep();
      if (this.kind === "COMMA") {
        this.advance();
        this.skipSep();
        // Cast: same TS narrowing limitation as parseNodeEdges above.
        if ((this.kind as TokKind) === "RBRACKET") break; // trailing comma
        continue;
      }
      break;
    }
    const [closeKind, closeStart, closeEnd] = this.advance();
    if (closeKind !== "RBRACKET") {
      const text = this.tokText(closeKind, closeStart, closeEnd);
      throw this.errorFor(
        closeKind,
        closeStart,
        `expected ',' or ']' in array, got ${closeKind} ${JSON.stringify(text)}`,
      );
    }
    return elements;
  }

  private parseScalar(): Scalar {
    const [kind, start, end] = this.advance();
    switch (kind) {
      case "STRING":
        return this.stringValue(start, end);
      case "INTEGER": {
        const text = this.sc.s.slice(start, end);
        const digits = text[0] === "-" ? text.slice(1) : text;
        if (digits.length > MAX_INT_DIGITS) {
          throw this.sc.errorAt(
            start,
            `integer literal has ${digits.length} digits, exceeding the ` +
              `${MAX_INT_DIGITS}-digit limit (security: unbounded-digit ` +
              "int-to-str conversion is superlinear)",
          );
        }
        return Number(text);
      }
      case "NUMDEC":
      case "NUMEXP":
        return Number(this.sc.s.slice(start, end));
      case "NANLIT":
        return NaN;
      case "POSINF":
        return Infinity;
      case "NEGINF":
        return -Infinity;
      case "DATE": {
        const text = this.sc.s.slice(start, end);
        const d = parseDateToken(text);
        if (d === null) {
          throw this.sc.errorAt(end, `invalid date ${JSON.stringify(text)}`);
        }
        return d;
      }
      case "TIME": {
        const text = this.sc.s.slice(start, end);
        if (parseTimeToken(text) === null) {
          throw this.sc.errorAt(end, `invalid time ${JSON.stringify(text)}`);
        }
        // Document-model mapping: `time` has no native JS type, so it is a
        // plain string (see file-top comment and src/document.ts).
        return text;
      }
      case "DATETIME": {
        const text = this.sc.s.slice(start, end);
        const d = parseDatetimeToken(text);
        if (d === null) {
          throw this.sc.errorAt(end, `invalid datetime ${JSON.stringify(text)}`);
        }
        return d;
      }
      case "IDENT": {
        const text = this.sc.s.slice(start, end);
        if (text === "null") return null;
        if (text === "true") return true;
        if (text === "false") return false;
        throw this.sc.errorAt(
          start,
          `bare word ${JSON.stringify(text)} is not a valid value here; ` +
            "strings must be quoted",
        );
      }
      default: {
        const text = this.tokText(kind, start, end);
        throw this.errorFor(kind, start, `expected a value, got ${kind} ${JSON.stringify(text)}`);
      }
    }
  }

  private stringValue(start: number, end: number): string {
    const text = this.sc.s.slice(start, end);
    if (text[0] === "'") return text.slice(1, -1);
    if (text.slice(0, 3) === '"""') return decodeMultiline(text);
    return decodeDquote(text);
  }
}

// ---------------------------------------------------------------------------
// Public read/write
// ---------------------------------------------------------------------------

export interface ReadOmlOptions {
  /** If given, the parsed document is run through `materialize` (issue #7,
   * `src/deserialize.ts`) against this schema: leaf values are upgraded
   * (e.g. an ISO date string to a `Date`) and the shape is checked
   * (cardinality, closedness), guaranteeing the result conforms -- or
   * raising `ParseError` with the full structured issue list otherwise. */
  readonly schema?: Schema;
}

/** Parse OML source into a canonical Document node (edge list or leaf). */
export function readOml(text: string, opts: ReadOmlOptions = {}): Node {
  const scanner = new Scanner(text);
  const node = new Parser(scanner).parseDocument();
  if (opts.schema !== undefined) {
    return materialize(node, opts.schema);
  }
  return node;
}

export interface WriteOmlOptions {
  /** Pretty-mode indent width in spaces (default 2). `null` renders a
   * single-line, machine-oriented form instead: edges joined by `"; "`, no
   * newlines/padding -- mirroring `write_json`'s own `indent: null`
   * convention. Both forms round-trip through `readOml`. */
  readonly indent?: number | null;
  /** Collapse maximal runs of >= 2 consecutive same-label edges into
   * `label: [v1, v2, ...]` array syntax (issue #218 upstream). A run of
   * length 1 still writes as a plain scalar edge; a run is never merged
   * across an edge with a different label in between. Default `false`
   * produces output byte-identical to `arrays` not existing at all. */
  readonly arrays?: boolean;
}

/**
 * Render a canonical Document node as OML source.
 *
 * OML is lossless for every Document: there is never an adjustment to
 * report, so there is no `strict`/`report` writer machinery -- the write
 * always succeeds exactly.
 */
export function writeOml(node: Node, opts: WriteOmlOptions = {}): string {
  const indent = opts.indent === undefined ? 2 : opts.indent;
  const arrays = opts.arrays ?? false;
  if (!Array.isArray(node)) return writeScalar(node);
  if (indent === null) return writeEdgesCompact(node, arrays, 0);
  return writeEdges(node, 0, indent, arrays, 0);
}

/** OML can hold every Document losslessly; always returns an empty {@link WriteReport}. */
export function checkOml(node: Node): WriteReport {
  void node; // OML is lossless: nothing to inspect, always an empty report.
  return new WriteReport();
}

/** Group `edges` into maximal runs of consecutive same-label edges,
 * preserving order -- never reorders; a run only ever contains edges that
 * were already adjacent in the input. */
function groupRuns(edges: readonly Edge[]): Array<[string, Node[]]> {
  const runs: Array<[string, Node[]]> = [];
  for (const { label, target } of edges) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last[0] === label) {
      last[1].push(target);
    } else {
      runs.push([label, [target]]);
    }
  }
  return runs;
}

function writeEdges(
  edges: readonly Edge[],
  depth: number,
  indent: number,
  arrays: boolean,
  nodeDepth: number,
): string {
  const pad = " ".repeat(indent * depth);
  const lines: string[] = [];
  const runs = arrays ? groupRuns(edges) : edges.map((e): [string, Node[]] => [e.label, [e.target]]);
  for (const [label, children] of runs) {
    const lab = writeLabel(label);
    if (arrays && children.length > 1) {
      const items = children
        .map((c) => writeArrayElement(c, depth, indent, arrays, nodeDepth))
        .join(", ");
      lines.push(`${pad}${lab}: [${items}]`);
      continue;
    }
    const child = children[0] as Node;
    if (Array.isArray(child)) {
      if (child.length === 0) {
        lines.push(`${pad}${lab}: {}`);
      } else {
        const inner = writeEdges(child, depth + 1, indent, arrays, nodeDepth + 1);
        lines.push(`${pad}${lab}: {\n${inner}\n${pad}}`);
      }
    } else {
      lines.push(`${pad}${lab}: ${writeScalar(child)}`);
    }
  }
  return lines.join("\n");
}

/** One element inside a pretty-mode `[...]` -- brace subtrees render
 * single-line regardless of the surrounding indent mode (arrays never
 * wrap). */
function writeArrayElement(
  child: Node,
  depth: number,
  indent: number,
  arrays: boolean,
  nodeDepth: number,
): string {
  if (Array.isArray(child)) {
    if (child.length === 0) return "{}";
    const inner = writeEdgesCompact(child, arrays, nodeDepth + 1);
    return `{ ${inner} }`;
  }
  return writeScalar(child);
}

function writeEdgesCompact(edges: readonly Edge[], arrays: boolean, nodeDepth: number): string {
  const parts: string[] = [];
  const runs = arrays ? groupRuns(edges) : edges.map((e): [string, Node[]] => [e.label, [e.target]]);
  for (const [label, children] of runs) {
    const lab = writeLabel(label);
    if (arrays && children.length > 1) {
      const items = children.map((c) => writeArrayElement(c, 0, 0, arrays, nodeDepth)).join(", ");
      parts.push(`${lab}: [${items}]`);
      continue;
    }
    const child = children[0] as Node;
    if (Array.isArray(child)) {
      if (child.length === 0) {
        parts.push(`${lab}: {}`);
      } else {
        const inner = writeEdgesCompact(child, arrays, nodeDepth + 1);
        parts.push(`${lab}: { ${inner} }`);
      }
    } else {
      parts.push(`${lab}: ${writeScalar(child)}`);
    }
  }
  return parts.join("; ");
}

// \z-equivalent ($ with no multiline flag also matches just before a
// trailing "\n" in some engines; JS's $ without /m only matches end-of-
// string, but a literal trailing "\n" character is still *in* the string
// before that end, so a naive test could wrongly accept it -- guard
// explicitly, matching omnist/oml.py's own #170 regression comment).
const BARE_LABEL_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function writeLabel(label: string): string {
  if (
    BARE_LABEL_RE.test(label) &&
    !label.includes("\n") &&
    !RESERVED.has(label) &&
    !RESERVED_NUMBER.has(label)
  ) {
    return label;
  }
  return writeString(label);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function pad4(n: number): string {
  return String(n).padStart(4, "0");
}

function writeDate(v: Date): string {
  // An offset-tagged datetime (issue #51) is written at its source offset's
  // wall-clock time with that offset spelled out, and never collapsed to a bare
  // DATE: the tag is proof a DATETIME literal was read, so the midnight
  // heuristic below has no work to do.
  const offsetMin = datetimeOffset(v);
  if (offsetMin !== undefined) {
    const wall = new Date(v.getTime() + offsetMin * 60000);
    const sign = offsetMin < 0 ? "-" : "+";
    const abs = Math.abs(offsetMin);
    const offset = `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
    return `${writeDatePart(wall)}T${writeTimePart(wall)}${offset}`;
  }
  const isMidnight =
    v.getUTCHours() === 0 &&
    v.getUTCMinutes() === 0 &&
    v.getUTCSeconds() === 0 &&
    v.getUTCMilliseconds() === 0;
  if (isMidnight) return writeDatePart(v);
  return `${writeDatePart(v)}T${writeTimePart(v)}`;
}

function writeDatePart(v: Date): string {
  return `${pad4(v.getUTCFullYear())}-${pad2(v.getUTCMonth() + 1)}-${pad2(v.getUTCDate())}`;
}

function writeTimePart(v: Date): string {
  const ms = v.getUTCMilliseconds();
  const frac = ms === 0 ? "" : `.${String(ms).padStart(3, "0")}`;
  return `${pad2(v.getUTCHours())}:${pad2(v.getUTCMinutes())}:${pad2(v.getUTCSeconds())}${frac}`;
}

/** Whether a string is a valid OML TIME literal, and can therefore be written
 * back as a bare TIME token rather than a quoted string (issue #52). Both
 * halves are required: `TIME_ONLY_RE` is the token's shape and
 * `parseTimeToken` its range/component check, so `"24:00"` -- shaped like a
 * time but not one -- stays quoted. See the file-top comment. */
function isTimeLiteral(s: string): boolean {
  return TIME_ONLY_RE.test(s) && parseTimeToken(s) !== null;
}

function writeScalar(v: Scalar): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (Number.isNaN(v)) return "nan";
    if (!Number.isFinite(v)) return v < 0 ? "-inf" : "inf";
    return String(v);
  }
  if (v instanceof Date) return writeDate(v);
  if (typeof v === "string") return isTimeLiteral(v) ? v : writeString(v);
  throw new TypeError(`${typeName(v)} has no OML scalar form`);
}

function typeName(v: unknown): string {
  if (v !== null && typeof v === "object") return v.constructor.name;
  return typeof v;
}

function writeString(s: string): string {
  const out: string[] = ['"'];
  for (const ch of s) {
    if (ch === '"') out.push('\\"');
    else if (ch === "\\") out.push("\\\\");
    else if (ch === "\n") out.push("\\n");
    else if (ch === "\r") out.push("\\r");
    else if (ch === "\t") out.push("\\t");
    else if (ch.length === 1 && ch.charCodeAt(0) < 0x20) {
      out.push(`\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
    } else {
      out.push(ch);
    }
  }
  out.push('"');
  return out.join("");
}
