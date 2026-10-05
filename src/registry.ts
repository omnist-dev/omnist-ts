/**
 * Format registry -- read/write a Document by format name, and register
 * plugins. Ported from `omnist/registry.py`.
 *
 * A {@link Format} bundles a name with `read(text) -> node` and
 * `write(node, opts?) -> text` callables, and an optional
 * `check(node) -> WriteReport` for simulating a write without producing
 * output. The built-in formats register themselves via {@link registerFormats}
 * (called once, from the modules that own them); {@link registerFormat}
 * adds your own, usable everywhere.
 */

import { OmnistError } from "./errors.js";
import type { WriteReport } from "./report.js";
import { checkInputSize } from "./formats/input-size.js";

/** A registered format plugin: a name plus read/write/check callables. */
export interface Format {
  /** Registered format name identifier (e.g. `"json"`, `"yaml"`, `"oml"`). */
  readonly name: string;
  /** text -> node. `opts` is format-specific (e.g. XML's `{ report }` for
   * read-time codec diagnostics, issue #123/D-3); most formats ignore it. Every
   * built-in reader honours `opts.maxInputBytes` (D-23); a plugin's may not,
   * which is why {@link readFormat} checks the size itself. */
  readonly read: (text: string, opts?: unknown) => unknown;
  /** (node, opts?) -> text */
  readonly write: (node: unknown, opts?: unknown) => string;
  /** node -> WriteReport; simulates a write without producing output. */
  readonly check?: (node: unknown) => WriteReport;
}

const REGISTRY = new Map<string, Format>();

/** Register (or replace) a format plugin. */
export function registerFormat(fmt: Format): void {
  REGISTRY.set(fmt.name, fmt);
}

/** The registered {@link Format} for `name` (throws if unknown). */
export function getFormat(name: string): Format {
  const fmt = REGISTRY.get(name);
  if (fmt === undefined) {
    // Unreachable in practice: this module is only ever imported alongside
    // index.ts, which registers the built-in formats (json, oml, ...) before
    // any getFormat call can run, so REGISTRY is never actually empty here.
    // Kept as a defensive fallback, same convention as this port's other
    // dormant guards (see document.ts).
    /* v8 ignore start */
    const known = [...REGISTRY.keys()].sort().join(", ") || "(none)";
    /* v8 ignore stop */
    throw new OmnistError("unknown format " + JSON.stringify(name) + "; registered: " + known);
  }
  return fmt;
}

/**
 * Read `text` with the registered format `name`, under the maximum input size
 * of D-23 (`opts.maxInputBytes`, default 64 MiB): an input over it is refused
 * with `document.limit.input-size` at `$` BEFORE the format's reader runs, so
 * a plugin reader that ignores the option is bounded too. `opts` is passed to
 * the reader unchanged.
 */
export function readFormat(name: string, text: string, opts: { maxInputBytes?: number } = {}): unknown {
  const fmt = getFormat(name);
  checkInputSize(text, opts.maxInputBytes);
  return fmt.read(text, opts);
}

/** The names of all registered formats, sorted. */
export function formats(): string[] {
  return [...REGISTRY.keys()].sort();
}
