/**
 * Adjustment reports for lossy writes. Ported from `omnist/report.py`.
 *
 * Writing a Document to a format that can't hold every value (TOML has no
 * `null`; JSON/XML have no date type) means the writer has to *adjust* the
 * data. Each adjustment is recorded as an {@link Adjustment} in a
 * {@link WriteReport} rather than lost silently. The same report drives
 * three behaviours:
 *
 * - **lenient** (default) -- adjust and move on; ignore the report if you like.
 * - **inspect** -- pass `report` to a writer (or call `check*`) to see what
 *   changed without stopping.
 * - **strict** -- `strict: true` raises {@link WriteError} (carrying the
 *   report) if anything had to be adjusted.
 *
 * Each adjustment has a `severity`: `"warning"` (conventional / recoverable
 * -- a date written as a string) or `"error"` (likely to surprise or
 * corrupt -- a `null` dropped, `NaN` in JSON). `strict` ignores severity and
 * raises on anything.
 */

import { WriteError } from "./errors.js";

/** How surprising/damaging an adjustment is. `strict` raises on either. */
export type Severity = "warning" | "error";

/**
 * One adjustment a (lossy) writer had to make. Mirrors `report.py`'s
 * `Adjustment` NamedTuple.
 */
export interface Adjustment {
  /** e.g. "\$.order.total" -- same path style as validation. */
  readonly path: string;
  /** stable, machine-checkable, e.g. "null.omitted". */
  readonly code: string;
  /** human-readable sentence. */
  readonly message: string;
  /** Severity level of this adjustment (`"warning"` or `"error"`). */
  readonly severity: Severity;
}

/**
 * Everything a writer adjusted. Mirrors `report.py`'s `WriteReport`.
 *
 * Python's `WriteReport.__bool__` returns `not self.errors`, so `if
 * check_toml(doc): ...` reads as "safe". JS has no boolean-coercion
 * operator overload, so that's exposed here as the explicit {@link ok}
 * getter instead -- same truth table, called out rather than implicit.
 */
export class WriteReport {
  /** All adjustments recorded during write operations. */
  readonly adjustments: Adjustment[] = [];

  /** Record an adjustment into this report. */
  add(path: string, code: string, message: string, severity: Severity): void {
    this.adjustments.push({ path, code, message, severity });
  }

  /** Filtered list of adjustments with `"warning"` severity. */
  get warnings(): Adjustment[] {
    return this.adjustments.filter((a) => a.severity === "warning");
  }

  /** Filtered list of adjustments with `"error"` severity. */
  get errors(): Adjustment[] {
    return this.adjustments.filter((a) => a.severity === "error");
  }

  /** `true` iff there are no error-severity entries (warnings are fine). */
  get ok(): boolean {
    return this.errors.length === 0;
  }

  /** Total count of recorded adjustments. */
  get length(): number {
    return this.adjustments.length;
  }

  /** Returns an iterator over all recorded adjustments. */
  [Symbol.iterator](): Iterator<Adjustment> {
    return this.adjustments[Symbol.iterator]();
  }

  /** Formats all adjustments into a human-readable multi-line string. */
  toString(): string {
    if (this.adjustments.length === 0) return "no adjustments";
    return this.adjustments.map((a) => a.severity + ": " + a.path + ": " + a.message).join("\n");
  }
}

/** Options for {@link finishWrite}: the standard strict/report handling. */
export interface FinishWriteOptions {
  /** If true, throws {@link WriteError} if any adjustments occurred. */
  strict?: boolean;
  /** Optional {@link WriteReport} accumulator to collect adjustments into. */
  report?: WriteReport;
}

/**
 * Apply the standard `strict`/`report` handling to a writer's result.
 *
 * If `report` is given, `rep`'s adjustments are copied into it (appended,
 * not replacing anything already there). If `strict` and `rep` has any
 * adjustments, throws {@link WriteError} carrying `rep`. Otherwise returns
 * `text`.
 */
export function finishWrite(text: string, rep: WriteReport, opts: FinishWriteOptions = {}): string {
  const { strict = false, report } = opts;
  if (report !== undefined) {
    report.adjustments.push(...rep.adjustments);
  }
  if (strict && rep.adjustments.length > 0) {
    throw new WriteError(String(rep), rep);
  }
  return text;
}
