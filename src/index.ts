/**
 * omnist -- one canonical data model, many formats.
 *
 * TypeScript port of https://github.com/omnist-dev/omnist. Public surface
 * mirrors the Python package's `__all__` (see `omnist/__init__.py`); modules
 * are added here as each is ported (see the repo's plan/README for status).
 */

export {
  OmnistError,
  SchemaError,
  ParseError,
  WriteError,
  DocumentError,
  DetachedNode,
  UnsafeXMLWarning,
  type OmnistIssue,
} from "./errors.js";

export {
  Doc,
  doc,
  type Node,
  type Edge,
  type Scalar,
} from "./document.js";

export const VERSION = "0.0.1-alpha";
