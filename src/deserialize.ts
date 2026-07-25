/**
 * Schema-directed deserialization: make a freshly-read node conform to a
 * {@link Schema}, or raise. Ported from `omnist/deserialize.py`. See
 * `docs/design/model.md` §10 (scalar/type mapping, "What deserialization
 * additionally converts" / "What deserialization rejects").
 *
 * Readers (`readOml`, and eventually `readJson`/etc.) hand back text-shaped
 * values: JSON/YAML/TOML have no `date`/`time` type, so a temporal field
 * arrives as an ISO-8601 string. Passing `schema` to a reader is the
 * request for a Document that's *guaranteed* to conform to that schema:
 * `materialize` walks the node together with the schema, upgrading each
 * leaf **only when the conversion is value-exact** (`"2024-01-01" -> Date`),
 * and checking every record's shape (closed fields, cardinality) along the
 * way, exactly as `Schema.validate` would. If anything can't be made to
 * conform -- an inexact scalar, an unknown field, a missing field, the
 * wrong cardinality -- `materialize` collects *every* such problem (not
 * just the first) and raises one {@link ParseError} with the full report,
 * both as a message string and structurally on `.errors`.
 *
 * This can't simply delegate to `Schema.validate` after the fact: `validate`
 * only ever *checks* a value already in its final form, with no notion of
 * upgrading, and it would mean a second, redundant top-down walk of the
 * same tree using different traversal code. Since `materialize` already
 * knows, at every node, exactly which field/type the schema expects there,
 * upgrading and shape-checking happen together in one pass.
 *
 * ## Scalar-kind mapping vs. Python (see `src/document.ts`'s file-top comment)
 *
 * Python has distinct `int`/`float`/`date`/`datetime` classes; this port's
 * Document model has one `number` type and maps both `date` and `datetime`
 * onto the single native `Date` type, and `time` onto a plain `string`
 * (there is no bare time-of-day type in JS). So here:
 *
 * - `integer` accepts an exact-integer JS `number` (`Number.isInteger`);
 *   `number` accepts any JS `number` -- there is nothing to "upgrade"
 *   numerically (unlike Python's `int -> float`), since JS has only one
 *   numeric representation. `boolean` never satisfies `integer`/`number`:
 *   Python needs an explicit check for this because `bool` subclasses
 *   `int`; JS has no such collision (`typeof true === "boolean"`, never
 *   `"number"`), so the exclusion falls out of the `typeof` check for free
 *   -- still covered by its own test (`test/deserialize.test.ts`) since
 *   it's exactly the kind of rule easy to lose track of porting between
 *   languages with different type systems.
 * - a `date`/`datetime` field accepts a real `Date` value as-is (an object
 *   already produced by a DATE/DATETIME-aware reader like `readOml`, or an
 *   already-materialized value) or an ISO-8601 string in the documented
 *   hyphenated/colon spelling, converted via `src/temporal.ts`'s
 *   `parseDateToken`/`parseDatetimeToken` (shared with `oml.ts`, so the two
 *   never drift). The *string* form stays mutually exclusive between `date`
 *   and `datetime` (a bare date string never satisfies `datetime`), exactly
 *   as `schema.ts`'s `matchesKind` already enforces for `validate` -- this
 *   module reuses `matchesKind` itself as the shape check, so `validate`
 *   and `materialize` can never disagree on whether a given string
 *   upgrades. `parseDateToken`/`parseDatetimeToken` also tag the `Date`
 *   they return with the kind that was actually read (issue #14's fix), so
 *   a `Date` produced *by this module* now satisfies only the kind it was
 *   materialized as when later re-validated against a different schema --
 *   matching Python's `isinstance`-based exclusion for that case. A real
 *   `Date` object handed to `materialize` from *outside* any schema-
 *   directed parse (untagged -- see `temporal.ts`'s file-top comment)
 *   still satisfies whichever of `date`/`datetime` the field declares:
 *   there is no signal to draw a kind from in that case, so it remains
 *   ambiguous by necessity, not something this module can resolve.
 * - a `time` field accepts a plain string in the documented spelling as-is
 *   (there is nothing further to convert it to at the Document layer).
 *
 * There's no `strict=` switch: a schema is either given, in which case the
 * result is guaranteed to conform (or an error is raised), or it isn't, in
 * which case the node is returned exactly as read, untouched.
 */

import type { Edge, Node, Scalar } from "./document.js";
import { ParseError, type OmnistIssue } from "./errors.js";
import {
  cardinalityStr,
  matchesKind,
  recordField,
  validationResultToString,
  type FieldType,
  type Record as SchemaRecord,
  type ScalarKind,
  type ScalarType,
  type Schema,
} from "./schema.js";
import { parseDateToken, parseDatetimeToken } from "./temporal.js";

/** A copy of `node` with leaf values upgraded to match `schema`, guaranteed
 * to conform to it -- raises {@link ParseError} (with every problem found,
 * not just the first, in both the message and the structured `.errors`
 * list) if it can't be made to. */
export function materialize(node: Node, schema: Schema): Node {
  const errors: OmnistIssue[] = [];
  const out = materializeType(node, schema, schema.root, "$", errors);
  if (errors.length > 0) {
    throw new ParseError(validationResultToString({ ok: false, errors }), errors);
  }
  return out;
}

function materializeType(
  node: Node,
  schema: Schema,
  t: FieldType,
  path: string,
  errors: OmnistIssue[],
): Node {
  const resolved = schema.resolve(t);
  if ("tag" in resolved && resolved.tag === "any") return node;
  if ("tag" in resolved && resolved.tag === "scalar") {
    return materializeScalar(node, resolved, path, errors);
  }
  return materializeRecord(node, schema, resolved as SchemaRecord, path, errors);
}

function materializeRecord(
  node: Node,
  schema: Schema,
  rec: SchemaRecord,
  path: string,
  errors: OmnistIssue[],
): Node {
  if (!Array.isArray(node)) {
    errors.push({ path, message: "expected an object, got a value", code: "shape-mismatch" });
    return node;
  }
  const out: Edge[] = [];
  const counts = new Map<string, number>();
  for (const { label, target } of node) {
    const i = counts.get(label) ?? 0;
    counts.set(label, i + 1);
    const p = i === 0 ? `${path}.${label}` : `${path}.${label}[${i}]`;
    const f = recordField(rec, label);
    if (f === undefined) {
      errors.push({ path: p, message: "unexpected field", code: "unexpected-field" });
      out.push({ label, target });
    } else {
      out.push({ label, target: materializeType(target, schema, f.type, p, errors) });
    }
  }
  for (const f of rec.fields) {
    const c = counts.get(f.label) ?? 0;
    if (c < f.min || (f.max !== null && c > f.max)) {
      errors.push({
        path,
        message: `field ${JSON.stringify(f.label)} occurs ${c} time(s), expected ${cardinalityStr(f)}`,
        code: "cardinality",
      });
    }
  }
  return out;
}

function materializeScalar(
  value: Node,
  s: ScalarType,
  path: string,
  errors: OmnistIssue[],
): Node {
  if (Array.isArray(value)) {
    errors.push({
      path,
      message: `expected a ${s.scalarKind} value, got an object`,
      code: "shape-mismatch",
    });
    return value;
  }
  if (value === null) {
    if (!s.nullable) {
      errors.push({ path, message: "null not allowed here", code: "null-not-allowed" });
    }
    return value;
  }
  switch (s.scalarKind) {
    case "string":
      if (typeof value === "string") return value;
      break;
    case "boolean":
      if (typeof value === "boolean") return value;
      break;
    case "integer":
      // `typeof value === "number"` is false for a JS boolean, so no
      // separate bool exclusion is needed here (see file-top comment) --
      // covered by its own test regardless.
      if (typeof value === "number" && Number.isInteger(value)) return value;
      break;
    case "number":
      if (typeof value === "number") return value;
      break;
    case "date":
    case "time":
    case "datetime": {
      const converted = materializeTemporal(value, s.scalarKind);
      if (converted !== NO_CONVERSION) return converted;
      break;
    }
  }
  errors.push({
    path,
    message: `${JSON.stringify(value)} cannot be read as ${s.scalarKind} (not a value-exact conversion)`,
    code: "type-mismatch",
  });
  return value;
}

const NO_CONVERSION = Symbol("no-conversion");

function materializeTemporal(
  value: Exclude<Scalar, null>,
  kind: Extract<ScalarKind, "date" | "time" | "datetime">,
): Scalar | typeof NO_CONVERSION {
  // A real `Date` object is checked the same way the string branch below
  // is: via `matchesKind`, so a `Date` tagged by `parseDateToken`/
  // `parseDatetimeToken` (issue #14's fix) with a kind that disagrees with
  // this field's declared `kind` is rejected here -- at materialize time --
  // rather than silently passed through and only failing later on
  // re-validation. That mirrors the string branch's own comment: `validate`
  // and `materialize` can never disagree. An untagged `Date` (never
  // produced by a schema-directed parse -- e.g. constructed directly by
  // application code) has no tag to disagree with, so `matchesKind` still
  // accepts it for either `date` or `datetime`, preserving the pre-#14
  // permissive behavior for that one case -- ambiguous by necessity, see
  // `temporal.ts`'s file-top comment; this is a documented residual
  // limitation, not a gap. `time` never produces a `Date` (there is no bare
  // time-of-day type), so this branch is unreachable for `kind === "time"`.
  if (value instanceof Date) return matchesKind(value, kind) ? value : NO_CONVERSION;
  if (typeof value !== "string") return NO_CONVERSION;
  // The exact same shape check `Schema.validate` uses (`matchesKind`), so
  // `validate` and `materialize` can never disagree on whether a string
  // upgrades -- see file-top comment.
  if (!matchesKind(value, kind)) return NO_CONVERSION;
  if (kind === "time") return value; // stays a plain string at this layer
  const converted = kind === "date" ? parseDateToken(value) : parseDatetimeToken(value);
  /* v8 ignore start -- unreachable via the public surface: `matchesKind`
   * (schema.ts) already ran the same shape check `parseDateToken`/
   * `parseDatetimeToken` (temporal.ts) do -- both are built from the same
   * documented hyphenated/colon spelling -- so having passed the guard
   * above, the parse below cannot fail. Kept as a defensive backstop
   * matching this function's total-return contract. */
  if (converted === null) return NO_CONVERSION;
  /* v8 ignore stop */
  return converted;
}
