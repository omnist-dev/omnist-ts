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
 *
 * ## Date-kind tagging (issue #14)
 *
 * `document.ts` maps both `date` and `datetime` onto the single native
 * `Date` type, so a bare `Date` value carries no signal of which kind it
 * was meant to be. `parseDateToken`/`parseDatetimeToken` are the two (and
 * only) places in this port that construct a `Date` from text whose kind
 * *is* known -- the caller (`oml.ts`'s tokenizer, or `deserialize.ts`'s
 * `materialize`) already knows whether it read a DATE or a DATETIME token.
 * Each records that kind, out-of-band, in `DATE_KIND` (a `WeakMap` keyed
 * by object identity, so it never touches the `Date` instance itself --
 * no risk of collision with `Date`'s own properties, and it works even for
 * a frozen `Date`). `schema.ts`'s `matchesKind` consults `dateKind()` to
 * resolve the date-vs-datetime ambiguity for any `Date` that passed through
 * one of these two functions.
 *
 * This is deliberately narrow: a `Date` constructed any other way (e.g.
 * `new Date()` directly, by application code, never touching this module)
 * is untagged and stays ambiguous -- `matchesKind` still accepts it for
 * either kind, exactly as before. That's not a gap this module tries to
 * close; there is no signal to draw a kind from in that case. What this
 * *does* close is the concrete, reported gap (issue #14): a `Date` that
 * came from a schema-directed read (`readOml`'s DATE/DATETIME tokens, or
 * `materialize` upgrading an ISO string) now carries the kind that read
 * established, so it validates correctly against a *different* schema that
 * disagrees on `date` vs `datetime` for the same label -- matching
 * upstream Python's `isinstance`-based mutual exclusion for that case,
 * which is the only case Python's real `datetime.date`/`datetime.datetime`
 * classes could ever observe in the first place (a `date`/`datetime` value
 * only ever originates from a parse or a schema-directed construction in
 * Python too; there's no "bare, unattributed" `date` object floating
 * around outside one).
 *
 * ## UTC-offset tagging (issue #51)
 *
 * The same problem one level down. A DATETIME literal may carry an explicit
 * UTC offset (`2024-01-01T12:00:00-08:00`) or none at all
 * (`2024-01-01T12:00:00`); `parseDatetimeToken` normalizes both to a `Date`,
 * which is a bare instant and remembers neither. Writing such a value back out
 * therefore used to drop the offset entirely, so `writeOml` turned
 * `a: 2024-01-01T12:00:00-08:00` into `a: 2024-01-01T20:00:00` -- the same
 * instant to *this* implementation (which reads an offset-less literal as
 * UTC), but a different one to Python, which reads an offset-less literal as a
 * naive local datetime. The value drifted across implementations.
 *
 * So `parseDatetimeToken` also records the source literal's offset, in minutes
 * east of UTC, in `DATETIME_OFFSET` -- the same by-identity `WeakMap`
 * technique as `DATE_KIND`, and `undefined` for an offset-less literal.
 * `oml.ts`'s writer consults `datetimeOffset()` and re-emits the offset it was
 * given, so an OML datetime is text-stable through a read/write round trip.
 *
 * Issue #26 solved the narrower local-vs-offset half of this for TOML with a
 * module-local `WeakSet` in `src/formats/toml.ts`, and deferred the choice of
 * where the tag should live on the grounds that only one codec cared. Two now
 * do, so the tag lives here. `toml.ts` keeps its own `WeakSet` rather than
 * sharing this map, for a reason that is not inertia: TOML datetimes are
 * parsed by `smol-toml`, not by this module, so there is no shared *producer*
 * to hang the tag on -- and TOML only needs the local-vs-offset bit, since
 * `tomli_w` (and this port, matching it) writes every aware datetime as `Z`
 * rather than preserving the source offset. OML preserves the offset itself,
 * which needs the full minute count.
 */

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

const DATE_TOKEN_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_TOKEN_RE =
  /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(?:([+-])(\d{2}):(\d{2}))?$/;

/** The date-vs-datetime kind a `Date` was constructed as, when known. See
 * the file-top comment ("Date-kind tagging"). */
export type DateKind = "date" | "datetime";

const DATE_KIND = new WeakMap<Date, DateKind>();

/** Minutes east of UTC, for a `Date` built from a DATETIME literal that
 * carried an explicit offset. See the file-top comment ("UTC-offset
 * tagging"). */
const DATETIME_OFFSET = new WeakMap<Date, number>();

function tagDateKind(d: Date, kind: DateKind): Date {
  DATE_KIND.set(d, kind);
  return d;
}

/** The kind a `Date` was tagged with by `parseDateToken`/`parseDatetimeToken`,
 * or `undefined` if it was never tagged (e.g. constructed directly, outside
 * any schema-directed read). Exported for `schema.ts`'s `matchesKind`. */
export function dateKind(d: Date): DateKind | undefined {
  return DATE_KIND.get(d);
}

/** The UTC offset, in minutes east of UTC, of the DATETIME literal
 * `parseDatetimeToken` built this `Date` from, or `undefined` if that literal
 * carried no offset (or the `Date` never came from this module at all).
 * Exported for `oml.ts`'s writer -- see the file-top comment ("UTC-offset
 * tagging", issue #51). Note that `0` (`+00:00`) and `undefined` (no offset)
 * are meaningfully different and must not be conflated: OML, like TOML, writes
 * them back as different literals. */
export function datetimeOffset(d: Date): number | undefined {
  return DATETIME_OFFSET.get(d);
}

/** Parse a `YYYY-MM-DD` date token into a UTC-midnight `Date`, or `null` if
 * the calendar date is out of range (e.g. month 13, or day 30 in a
 * 28/29/30-day month). Callers are expected to have already shape-checked
 * `text` (e.g. via `schema.ts`'s `matchesKind`/`isIsoDateString`, or the
 * OML tokenizer's `DATE_SRC` lexical rule) -- this only re-validates the
 * calendar, not the string shape. The returned `Date` is tagged `"date"`
 * (see the file-top comment). */
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
  return tagDateKind(new Date(Date.UTC(y, mo - 1, d)), "date");
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
 * `Date` at the parsed instant, or `null` if either half is out of range.
 * The returned `Date` is tagged `"datetime"` (see the file-top comment). */
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
  const out = tagDateKind(new Date(epoch), "datetime");
  // Remember the source literal's offset so a writer can re-emit it (issue
  // #51). An offset-less literal is left untagged, which is *not* the same as
  // tagging it 0 -- see `datetimeOffset`.
  if (time.offsetMin !== null) DATETIME_OFFSET.set(out, time.offsetMin);
  return out;
}

/**
 * Provenance wrapper for a genuinely 	ime-kinded value (issue #96, same
 * fix shape as omnist-rs#99/PR#100's RawNode::TemporalLeaf). date/
 * datetime get identity for free from Date being a real object, tagged
 * via the WeakMaps above; a bare JS string primitive has no identity to
 * key a WeakMap on, so 	ime -- which has no native JS temporal type at
 * all -- needs its own wrapper instead. The wrapper's own type *is* the
 * tag: a 	ime-kinded value's canonical in-memory representation is a
 * TimeValue instance, never a bare string, from the moment it is
 * genuinely known to be time-kinded (src/oml.ts's TIME token grammar, or
 * src/deserialize.ts's schema-directed materialize upgrade -- the two
 * real construction points, mirroring Rust's).
 *
 * Transparent everywhere except src/oml.ts's writer (which is the one
 * place the tag must be *visible*, to decide bare-vs-quoted output): it
 * unwraps to its .text string in Document equality (document.ts's
 * 
odeEquals), schema validation (schema.ts's matchesKind), and every
 * other format's writer (JSON/YAML/TOML/XML have no native time syntax, so
 * they always emit plain text regardless of provenance).
 */
/**
 * An ISO 8601 clock time value wrapper (spec §2.2).
 */
export class TimeValue {
  /**
   * Construct a new {@link TimeValue} wrapping an ISO 8601 clock time string.
   */
  constructor(
    /** The canonical ISO 8601 clock time string (e.g. `"12:30:00"`). */
    public readonly text: string,
  ) {}

  /** Returns the ISO 8601 clock time string. */
  toString(): string {
    return this.text;
  }

  /** Returns the ISO 8601 clock time string for JSON serialization. */
  toJSON(): string {
    return this.text;
  }
}
