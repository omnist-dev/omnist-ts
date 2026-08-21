/**
 * Exceptions used across omnist. Ported from `omnist/errors.py`.
 *
 * TS has no distinct warning type suitable for `UnsafeXMLWarning`'s original
 * role (a `UserWarning` subclass); it is kept as an unused `Error` subclass
 * for API parity with the Python port, same as upstream keeps it exported
 * but unraised (see the Python docstring: XML now hard-requires a safe
 * parser rather than falling back with a warning).
 */

/** Base class for all omnist errors. */
export class OmnistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * The schema text or structure is invalid.
 *
 * `code` and `path` are optional and populated only where the throw site
 * has a stable machine-readable code to offer (currently: `osd.ts`'s
 * lexical/tokenization errors, using the `parse.*` family from
 * `omnist-spec` Sec8.3.1 -- extended by spec#46 to cover OSD's own lexing
 * stage the same way it already covered OML's -- with a `line:col` `path`
 * per Sec8.4). Every other `SchemaError` throw site in this package
 * continues to pass only a message; both fields are simply `undefined`
 * there. This is an additive widening of an existing public type, not a
 * breaking change: no existing call site or catch site needs updating.
 */
export class SchemaError extends OmnistError {
  /** Stable machine-readable error code (omnist-spec Sec8.3), when the throw site has one. */
  readonly code: string | undefined;
  /** Location of the error -- a `line:col` text-position path for lexical errors (Sec8.4), when known. */
  readonly path: string | undefined;

  constructor(message: string, code?: string, path?: string) {
    super(message);
    this.code = code;
    this.path = path;
  }
}

/**
 * A schema-conformance problem found during {@link materialize}: a path,
 * a message, and a machine-readable code. Mirrors `omnist.schema.Error`.
 */
/**
 * Machine-readable description of a single validation, lint, or parse issue (spec §5).
 */
export interface OmnistIssue {
  /** Path inside the document or schema where the issue occurred (e.g. `"$.user.age"`). */
  readonly path: string;
  /** Human-readable explanation of the issue. */
  readonly message: string;
  /** Stable machine-readable error code matching `omnist-spec` §5. */
  readonly code: string;
}

/**
 * A document could not be read from its format (outside the supported profile).
 *
 * Format-syntax failures (invalid JSON/YAML/TOML/XML text) carry only the
 * message -- `.errors` is empty. Schema-conformance failures from
 * `materialize` carry the full structured list of every problem found (path,
 * message, machine-readable code), not just the first one.
 */
export class ParseError extends OmnistError {
  /** Detailed list of structural or schema-conformance issues encountered. */
  readonly errors: readonly OmnistIssue[];

  constructor(message: string, errors: readonly OmnistIssue[] = []) {
    super(message);
    this.errors = errors;
  }
}

/**
 * A value is not a legal Document, or a Document operation is invalid.
 *
 * Raised by the `Doc` API when an import or mutation would produce something
 * outside the Document model -- an unsupported value type, a non-string
 * object key, a cycle -- or when an operation doesn't fit the node (e.g.
 * `get` on a scalar). The message carries the offending path.
 */
export class DocumentError extends OmnistError {}

/**
 * A cursor was used after its node was removed from the document.
 *
 * Holding a `Doc` cursor and then removing that node (or a node above it)
 * leaves the cursor pointing at a subtree no longer in the document. Using
 * it raises this instead of silently editing an orphan.
 */
export class DetachedNode extends DocumentError {}

/**
 * A document cannot be represented losslessly in the target format.
 *
 * Raised only in `strict: true` mode. `.report` holds the full
 * `WriteReport` of every adjustment that would have been needed, so callers
 * can inspect the structured list, not just the text.
 */
export class WriteError extends OmnistError {
  // Typed `unknown` here rather than importing WriteReport, to avoid a
  // circular import between errors.ts and report.ts; report.ts narrows it.
  /** Attached adjustment report when written in strict mode or reporting is enabled. */
  readonly report: unknown;

  constructor(message: string, report: unknown = undefined) {
    super(message);
    this.report = report;
  }
}

/**
 * Unused by `readXml` -- kept exported for parity with the Python port's
 * `UnsafeXMLWarning`, which is itself unraised (a safe XML parser is a hard
 * requirement, not a fallback-with-warning). Nothing in omnist raises it.
 */
export class UnsafeXMLWarning extends Error {}
