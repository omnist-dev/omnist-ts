/**
 * ISO-8601-string -> `Date` conversion, shared by `src/oml.ts` (reading the
 * DATE/TIME/DATETIME literal tokens) and `src/deserialize.ts` (issue #7,
 * upgrading a schema-declared `date`/`datetime` field from a JSON/YAML/
 * TOML/XML-shaped ISO string). Split into its own module, rather than
 * defined in `oml.ts` and imported by `deserialize.ts`, specifically to
 * avoid a `oml.ts` <-> `deserialize.ts` import cycle: `oml.ts`'s `readOml`
 * calls `materialize` (in `deserialize.ts`) to honor its `schema` option,
 * so `deserialize.ts` cannot itself import from `oml.ts`.
 *
 * Calendar-validated (rejects e.g. day 30 in February) and UTC-based (no
 * host-timezone dependence), matching `src/document.ts`'s file-top comment
 * on the `date`/`datetime` -> `Date` mapping this port uses.
 */

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

const DATE_TOKEN_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_TOKEN_RE =
  /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(?:([+-])(\d{2}):(\d{2}))?$/;

/** Parse a `YYYY-MM-DD` date token into a UTC-midnight `Date`, or `null` if
 * the calendar date is out of range (e.g. month 13, or day 30 in a
 * 28/29/30-day month). Callers are expected to have already shape-checked
 * `text` (e.g. via `schema.ts`'s `matchesKind`/`isIsoDateString`, or the
 * OML tokenizer's `DATE_SRC` lexical rule) -- this only re-validates the
 * calendar, not the string shape. */
export function parseDateToken(text: string): Date | null {
  const m = DATE_TOKEN_RE.exec(text);
  /* v8 ignore start -- unreachable via either caller: `oml.ts`'s tokenizer
   * only calls this with text already matched by its DATE/DATETIME lexical
   * rule, and `deserialize.ts` only calls this after `schema.ts`'s
   * `matchesKind` has shape-checked the string, both a strict superset-shape
   * of `DATE_TOKEN_RE`, so the exec above always succeeds. Kept as a
   * defensive backstop matching this function's `| null` return contract. */
  if (!m) return null;
  /* v8 ignore stop */
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12) return null;
  if (d < 1 || d > daysInMonth(y, mo)) return null;
  return new Date(Date.UTC(y, mo - 1, d));
}

interface TimeParts {
  hh: number;
  mm: number;
  ss: number;
  ms: number;
  offsetMin: number | null;
}

/** Parse a bare `HH:MM[:SS[.ffffff]][+-HH:MM]` time-of-day token into its
 * components, or `null` if out of range. Exported for `oml.ts`'s TIME token
 * shape/range check; `deserialize.ts` doesn't need this directly since a
 * `time` scalar stays a plain string at the Document layer (see
 * `document.ts`'s file-top comment) -- there is nothing to convert it to. */
export function parseTimeToken(text: string): TimeParts | null {
  const m = TIME_TOKEN_RE.exec(text);
  /* v8 ignore start -- unreachable via the public API: this is only ever
   * called with text already matched by the tokenizer's TIME/DATETIME
   * lexical rule (TIME_BODY_SRC), which TIME_TOKEN_RE mirrors exactly, so
   * the exec above always succeeds. Kept as a defensive backstop matching
   * this function's `| null` return contract. */
  if (!m) return null;
  /* v8 ignore stop */
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const ss = m[3] !== undefined ? Number(m[3]) : 0;
  if (hh > 23 || mm > 59 || ss > 59) return null;
  let ms = 0;
  if (m[4] !== undefined) {
    ms = Number((m[4] + "000").slice(0, 3));
  }
  let offsetMin: number | null = null;
  if (m[5] !== undefined) {
    const sign = m[5] === "-" ? -1 : 1;
    const oh = Number(m[6]);
    const om = Number(m[7]);
    if (oh > 23 || om > 59) return null;
    offsetMin = sign * (oh * 60 + om);
  }
  return { hh, mm, ss, ms, offsetMin };
}

/** Parse a `YYYY-MM-DDTHH:MM[:SS[.ffffff]][+-HH:MM]` datetime token into a
 * `Date` at the parsed instant, or `null` if either half is out of range. */
export function parseDatetimeToken(text: string): Date | null {
  const tIdx = text.indexOf("T");
  /* v8 ignore start -- unreachable via either caller: `oml.ts`'s tokenizer
   * only calls this with a DATETIME token's matched text, and
   * `deserialize.ts` only calls this after `matchesKind` has shape-checked
   * the string against the `datetime` kind -- both DATETIME_SRC (the
   * tokenizer's regex) and `schema.ts`'s `DATETIME_RE` are literally
   * `DATE_SRC + "T" + TIME_BODY_SRC`, so `text` always contains a "T". Kept
   * as a defensive backstop matching this function's `| null` return
   * contract, not a reachable branch. */
  if (tIdx === -1) return null;
  /* v8 ignore stop */
  const date = parseDateToken(text.slice(0, tIdx));
  if (date === null) return null;
  const time = parseTimeToken(text.slice(tIdx + 1));
  if (time === null) return null;
  let epoch = date.getTime() + ((time.hh * 60 + time.mm) * 60 + time.ss) * 1000 + time.ms;
  if (time.offsetMin !== null) {
    epoch -= time.offsetMin * 60000;
  }
  return new Date(epoch);
}
