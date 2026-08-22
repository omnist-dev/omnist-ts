/**
 * omnist -- one canonical data model, many formats.
 *
 * TypeScript port of https://github.com/omnist-dev/omnist. Public surface
 * mirrors the Python package's __all__ (see omnist/__init__.py); modules
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

export { type TimeValue } from "./temporal.js";

export {
  WriteReport,
  finishWrite,
  type Adjustment,
  type Severity,
  type FinishWriteOptions,
} from "./report.js";

export {
  registerFormat,
  getFormat,
  formats,
  type Format,
} from "./registry.js";

export {
  Schema,
  schema,
  t,
  ANY,
  field,
  record,
  ref,
  nullable,
  cardinalityStr,
  recordField,
  fieldTypeEquals,
  recordEquals,
  schemaEquals,
  matchesKind,
  valueKind,
  validationResultToString,
  SCALAR_KINDS,
  STRING,
  INTEGER,
  NUMBER,
  BOOLEAN,
  DATE,
  TIME,
  DATETIME,
  type ScalarKind,
  type FieldType,
  type ScalarType,
  type RefType,
  type AnyFieldType,
  type Field,
  type Record,
  type ValidationResult,
} from "./schema.js";

export { parseSchema, toOsd, type ToOsdOptions } from "./osd.js";

export {
  infer,
  inferWithReport,
  type AnyFallback,
  type InferOptions,
  type InferResult,
} from "./infer.js";

export { materialize } from "./deserialize.js";

export { lint, type LintFinding } from "./ops/lint.js";
export { satisfiableSet } from "./ops/prune.js";
export { equivalenceClasses } from "./ops/minimize.js";


export {
  readJson,
  writeJson,
  checkJson,
  type ReadJsonOptions,
  type WriteJsonOptions,
} from "./formats/json.js";

export {
  readOml,
  writeOml,
  checkOml,
  type ReadOmlOptions,
  type WriteOmlOptions,
} from "./oml.js";

export {
  readXml,
  writeXml,
  checkXml,
  type ReadXmlOptions,
  type WriteXmlOptions,
} from "./formats/xml.js";

export {
  readToml,
  writeToml,
  checkToml,
  type ReadTomlOptions,
  type WriteTomlOptions,
} from "./formats/toml.js";

export {
  readYaml,
  writeYaml,
  checkYaml,
  type ReadYamlOptions,
  type WriteYamlOptions,
} from "./formats/yaml.js";

// ---------------------------------------------------------------------------
// Built-in format registration -- mirrors omnist/registry.py's
// _register_builtins, called once from omnist/__init__.py on import.
// YAML/TOML/XML register themselves here too once their modules land
// (issue #8's parallel format PRs); JSON and OML are this module's own
// scope.
// ---------------------------------------------------------------------------

import type { WriteReport as _WriteReport } from "./report.js";
import { registerFormat as _registerFormat } from "./registry.js";
import { readJson as _readJson, writeJson as _writeJson, checkJson as _checkJson } from "./formats/json.js";
import { readOml as _readOml, writeOml as _writeOml, checkOml as _checkOml } from "./oml.js";
import { readXml as _readXml, writeXml as _writeXml, checkXml as _checkXml } from "./formats/xml.js";
import { readToml as _readToml, writeToml as _writeToml, checkToml as _checkToml } from "./formats/toml.js";
import { readYaml as _readYaml, writeYaml as _writeYaml, checkYaml as _checkYaml } from "./formats/yaml.js";

_registerFormat({
  name: "json",
  read: _readJson,
  write: _writeJson as (node: unknown, opts?: unknown) => string,
  check: _checkJson as (node: unknown) => _WriteReport,
});

_registerFormat({
  name: "oml",
  read: _readOml,
  write: _writeOml as (node: unknown, opts?: unknown) => string,
  check: _checkOml as unknown as (node: unknown) => _WriteReport,
});

_registerFormat({
  name: "xml",
  read: _readXml,
  write: _writeXml as (node: unknown, opts?: unknown) => string,
  check: _checkXml as (node: unknown) => _WriteReport,
});

_registerFormat({
  name: "toml",
  read: _readToml,
  write: _writeToml as (node: unknown, opts?: unknown) => string,
  check: _checkToml as (node: unknown) => _WriteReport,
});

_registerFormat({
  name: "yaml",
  read: _readYaml,
  write: _writeYaml as (node: unknown, opts?: unknown) => string,
  check: _checkYaml as (node: unknown) => _WriteReport,
});

/** The package version of `@omnist-dev/omnist`, matching `package.json`. */
export const VERSION = "0.2.0-alpha";
