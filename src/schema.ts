/**
 * The Schema model -- two state kinds plus naming. Ported from
 * `omnist/schema.py`. See `docs/design/model.md` §5 (Schema model) and §7
 * (Conformance), and `docs/design/ts-implementation-notes.md` §1 for the
 * TS-specific type-shape decisions this file builds against.
 *
 * - **Record** -- a closed set of fields, each `(label, type, cardinality)`;
 *   constrained by its child labels. Cardinality is the *unordered* number
 *   of times a label may appear.
 * - **Scalar** -- one of exactly seven predefined value kinds (`string`,
 *   `integer`, `number`, `boolean`, `date`, `time`, `datetime`), optionally
 *   nullable. There is no user-declared scalar/value-domain composition -- a
 *   field's value side is always exactly one of the seven, never a union, an
 *   enum, or a literal.
 * - **Ref** -- a pointer into the schema's named environment (records only);
 *   enables reuse and recursion.
 * - **`any`** -- a declared leaf whose value is unchecked (the model's one
 *   deliberate opening; see `docs/design/any-type-spec.md`).
 *
 * A field's `type` is a `FieldType`: a `ScalarType`, a `RefType`, or
 * `AnyFieldType` -- never a fourth thing, never a combination. There are no
 * inline records and no separate array type -- "array" is just a field with
 * cardinality `max > 1`. Validation ignores order.
 */

import { SchemaError, type OmnistIssue } from "./errors.js";
import { Doc } from "./document.js";
import {
  dateKind,
  parseDateToken,
  parseDatetimeToken,
  parseTimeToken,
} from "./temporal.js";
import { compatibleWith as opsCompatibleWith, equivalent as opsEquivalent } from "./ops/subschema.js";
import { normalize as opsNormalize } from "./ops/minimize.js";
import { extract as opsExtract } from "./ops/extract.js";
import { prune as opsPrune, isEmpty as opsIsEmpty } from "./ops/prune.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const SCALAR_KINDS = [
  "string",
  "integer",
  "number",
  "boolean",
  "date",
  "time",
  "datetime",
] as const;

export type ScalarKind = (typeof SCALAR_KINDS)[number];

const SCALAR_KIND_SET: ReadonlySet<string> = new Set(SCALAR_KINDS);
const RESERVED_RECORD_NAMES: ReadonlySet<string> = new Set<string>([...SCALAR_KINDS, "any"]);

/** A field's type: exactly one of a scalar, a ref, or `any` -- never a
 * combination. See `docs/design/ts-implementation-notes.md` §1 for why this
 * is a discriminated union rather than a class hierarchy. */
export type FieldType = ScalarType | RefType | AnyFieldType;

/** One of the seven predefined value kinds, optionally nullable. */
export interface ScalarType {
  readonly tag: "scalar";
  readonly scalarKind: ScalarKind;
  readonly nullable: boolean;
}

/** A reference to a named record in a schema's environment. */
export interface RefType {
  readonly tag: "ref";
  readonly name: string;
}

/** The `any` type: accepts every legal Document value. Not a `ScalarType`
 * (it has no kind and no nullable flag -- null is already included) and not
 * a `RefType` (it names nothing). */
export interface AnyFieldType {
  readonly tag: "any";
}

/** The `any` field type value. There is only ever one shape of it; reuse
 * this constant rather than writing `{ tag: "any" }` at each call site. */
export const ANY: AnyFieldType = { tag: "any" };

function makeScalarType(scalarKind: ScalarKind, nullable = false): ScalarType {
  /* v8 ignore start -- unreachable via the public surface: this helper is
   * only ever called internally, below, with the seven literal `ScalarKind`
   * values that build the `t` namespace. There is no exported `Scalar(...)`
   * constructor a caller could pass a bad kind to (unlike Python's public
   * `Scalar(name)`) -- `FieldType`'s `scalarKind` is a closed TS union, so
   * the only way to defeat it at the type level is an explicit type
   * assertion, which is a caller bug this guard documents rather than one
   * this port can meaningfully test. Kept (not deleted) for structural
   * parity with `omnist/schema.py`'s `Scalar.__init__` name check. */
  if (!SCALAR_KIND_SET.has(scalarKind)) {
    throw new SchemaError(
      `unknown scalar ${JSON.stringify(scalarKind)}; expected one of ${JSON.stringify(
        [...SCALAR_KINDS].sort(),
      )}`,
    );
  }
  /* v8 ignore stop */
  return { tag: "scalar", scalarKind, nullable };
}

/** The seven scalars, plus `any`, under one namespace: `t.string`,
 * `t.integer`, ..., `t.any`. Each scalar is ready to use directly as a
 * field's type, e.g. `field("name", t.string)`. */
export const t = {
  string: makeScalarType("string"),
  integer: makeScalarType("integer"),
  number: makeScalarType("number"),
  boolean: makeScalarType("boolean"),
  date: makeScalarType("date"),
  time: makeScalarType("time"),
  datetime: makeScalarType("datetime"),
  get any(): AnyFieldType {
    return ANY;
  },
};

/** The seven scalars as standalone, ready-to-use constants -- the same
 * values as `t.string`, `t.integer`, ... but reachable without going
 * through the `t` namespace, matching Python's `omnist.STRING`,
 * `omnist.INTEGER`, etc. (see `omnist/__init__.py` `__all__`). Prefer
 * `t.string` in new code -- these exist for parity with the Python public
 * surface and for callers who already have a bare-name habit from there. */
export const STRING: ScalarType = t.string;
export const INTEGER: ScalarType = t.integer;
export const NUMBER: ScalarType = t.number;
export const BOOLEAN: ScalarType = t.boolean;
export const DATE: ScalarType = t.date;
export const TIME: ScalarType = t.time;
export const DATETIME: ScalarType = t.datetime;

/** A copy of `scalar` that also accepts `null` (the `?` form). Raises if
 * given `any` -- `any` already includes `null`, so `any?` is redundant. */
export function nullable(scalarType: ScalarType | AnyFieldType): ScalarType {
  if (scalarType.tag === "any") {
    throw new SchemaError("any already includes null; 'any?' is redundant");
  }
  return scalarType.nullable ? scalarType : { ...scalarType, nullable: true };
}

/** A reference to a named record. */
export function ref(name: string): RefType {
  return { tag: "ref", name };
}

/** One named, cardinality-bound field slot of a record: `label` of `type`,
 * occurring `[min, max]` times (`max === null` is unbounded). */
export interface Field {
  readonly label: string;
  readonly type: FieldType;
  readonly min: number;
  readonly max: number | null;
}

/** Builds a `Field`, validating its type and cardinality. */
export function field(
  label: string,
  type: FieldType,
  min = 1,
  max: number | null = 1,
): Field {
  if (
    type.tag !== "scalar" &&
    type.tag !== "ref" &&
    type.tag !== "any"
  ) {
    throw new SchemaError(
      `field ${JSON.stringify(label)} type must be a Ref, Scalar, or t.any, got ${JSON.stringify(type)}`,
    );
  }
  if (min < 0 || (max !== null && max < min)) {
    throw new SchemaError(
      `field ${JSON.stringify(label)} has an invalid cardinality [${min},${max ?? ""}]`,
    );
  }
  return { label, type, min, max };
}

/** A human-readable rendering of a field's cardinality, e.g. "exactly 1",
 * "0 or 1", "at least 1", "between 2 and 5". */
export function cardinalityStr(f: Field): string {
  if (f.min === 1 && f.max === 1) return "exactly 1";
  if (f.min === 0 && f.max === 1) return "0 or 1";
  if (f.max === null) return `at least ${f.min}`;
  return `between ${f.min} and ${f.max}`;
}

/** A closed set of named fields (constrained by its child labels). */
export interface Record {
  readonly fields: readonly Field[];
}

/** Builds a `Record` from its fields; raises on a duplicate label. */
export function record(...fields: Field[]): Record {
  const seen = new Set<string>();
  for (const f of fields) {
    if (seen.has(f.label)) {
      throw new SchemaError(`duplicate field label ${JSON.stringify(f.label)} in a record`);
    }
    seen.add(f.label);
  }
  return { fields: [...fields] };
}

/** The field named `label` in `rec`, or `undefined` if there is none. */
export function recordField(rec: Record, label: string): Field | undefined {
  return rec.fields.find((f) => f.label === label);
}

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

/** The outcome of `Schema.validate`: whether the document conforms, plus
 * every conformance problem found (not just the first). Mirrors Python's
 * `ValidationResult`. */
export interface ValidationResult {
  readonly ok: boolean;
  readonly errors: readonly OmnistIssue[];
}

function validationResultToString(res: ValidationResult): string {
  if (res.ok) return "valid";
  return "invalid:\n" + res.errors.map((e) => `  at ${e.path}: ${e.message}`).join("\n");
}

// ---------------------------------------------------------------------------
// Structural equality
// ---------------------------------------------------------------------------

/** Structural equality for `FieldType` values (TS has no dunder overload
 * for `==`, so this replaces Python's `Scalar.__eq__`/`Ref.__eq__`/
 * `AnyType.__eq__`). */
export function fieldTypeEquals(a: FieldType, b: FieldType): boolean {
  if (a.tag !== b.tag) return false;
  if (a.tag === "scalar" && b.tag === "scalar") {
    return a.scalarKind === b.scalarKind && a.nullable === b.nullable;
  }
  if (a.tag === "ref" && b.tag === "ref") {
    return a.name === b.name;
  }
  return true; // both "any"
}

function fieldEquals(a: Field, b: Field): boolean {
  return (
    a.label === b.label && a.min === b.min && a.max === b.max && fieldTypeEquals(a.type, b.type)
  );
}

/** Structural equality for `Record` values: same fields, in the same
 * declared order (order is cosmetic for validation, per model.md §13, but
 * this helper -- like Python's implicit list equality -- is order-sensitive;
 * callers needing an order-independent comparison should sort first). */
export function recordEquals(a: Record, b: Record): boolean {
  if (a.fields.length !== b.fields.length) return false;
  return a.fields.every((f, i) => fieldEquals(f, b.fields[i] as Field));
}

/** Structural equality for `Schema` values: same root and same environment
 * (record-for-record, name-for-name). */
export function schemaEquals(a: Schema, b: Schema): boolean {
  if (!fieldTypeEquals(a.root, b.root)) return false;
  const aNames = [...a.env.keys()].sort();
  const bNames = [...b.env.keys()].sort();
  if (aNames.length !== bNames.length) return false;
  return aNames.every((name, i) => {
    if (name !== bNames[i]) return false;
    const ra = a.env.get(name);
    const rb = b.env.get(name);
    return ra !== undefined && rb !== undefined && recordEquals(ra, rb);
  });
}

// ---------------------------------------------------------------------------
// Value matching
// ---------------------------------------------------------------------------

// The one definition of the documented temporal spellings (hyphenated date,
// colon time, 'T'-joined datetime), matching `omnist/schema.py`'s
// `_DATE_RE`/`_TIME_RE`/`_DATETIME_RE`. Deliberately narrower than what
// `Date`'s own ISO parsing accepts, e.g. ISO 8601 basic format or week
// dates -- a shape check runs before any conversion is attempted.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?([+-]\d{2}:\d{2})?$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?([+-]\d{2}:\d{2})?$/;

// Shape check, then range/calendar check via `src/temporal.ts` -- NOT via
// `Date.parse` (issues #49 and #50). `Date.parse` is wrong for this job twice
// over: it rolls a day overflow forward rather than failing, so
// `Date.parse("2024-02-30")` returns 1 March and a nonexistent calendar date
// used to satisfy `date`; and the ECMAScript Date Time String Format permits
// `24:00` as end-of-day, so hour 24 used to satisfy `time`. Python rejects
// both (`date.fromisoformat("2024-02-30")` and `time.fromisoformat("24:00")`
// each raise `ValueError`), and model.md section 10 requires a string that is
// not a valid bare ISO date to be rejected.
//
// Routing these through `parseDateToken`/`parseTimeToken`/`parseDatetimeToken`
// -- the same functions `oml.ts`'s tokenizer and `deserialize.ts`'s
// `materialize` already use -- puts the range and calendar rules in exactly
// one place, so the validation layer and the parse layer cannot drift apart
// again. That drift was issue #49's second, worse symptom: `validate` and
// `materialize` disagreed on `"2024-02-30"`, violating the invariant
// `deserialize.ts` states in its own file header.
//
// The `*_RE` shape test still runs first, both because it is the documented
// spelling gate (narrower than the tokenizer regexes' supersets are allowed to
// be) and because `temporal.ts` documents that its callers shape-check first.

function isIsoDateString(v: unknown): boolean {
  return typeof v === "string" && DATE_RE.test(v) && parseDateToken(v) !== null;
}

function isIsoTimeString(v: unknown): boolean {
  return typeof v === "string" && TIME_RE.test(v) && parseTimeToken(v) !== null;
}

function isIsoDatetimeString(v: unknown): boolean {
  return typeof v === "string" && DATETIME_RE.test(v) && parseDatetimeToken(v) !== null;
}

/**
 * `date`/`time`/`datetime` and real objects, in TS vs. Python.
 *
 * Python has distinct `datetime.date`/`datetime.datetime` classes, so a real
 * object unambiguously satisfies exactly one of `date`/`datetime` (never
 * both), matching model.md §10's mutual-exclusion rule for the object form.
 * The Document layer here has no such distinction -- `src/document.ts`
 * maps *both* `date` and `datetime` onto the single native `Date` type (see
 * its file-top comment) -- so a real `Date` value carries no signal, by
 * itself, of which kind its field was meant to declare, UNLESS it came from
 * a schema-directed parse (`readOml`'s DATE/DATETIME tokens, or
 * `deserialize.ts`'s `materialize` upgrading an ISO string). Those two call
 * sites go through `src/temporal.ts`'s `parseDateToken`/`parseDatetimeToken`,
 * which tag the returned `Date` with the kind that was actually read (issue
 * #14). `dateKind()` below consults that tag when present.
 *
 * This resolves the issue #14 gap for the case that actually matters: the
 * *same* Document, materialized once against a schema that says `date`, no
 * longer also satisfies a different schema that says `datetime` for the
 * same label -- matching Python's `isinstance`-based exclusion. A `Date`
 * that never passed through a schema-directed parse (e.g. `new Date()`
 * constructed directly by application code) carries no tag and stays
 * ambiguous by necessity: there is no signal to draw a kind from, so it is
 * still accepted for whichever of `date`/`datetime` the field declares, as
 * before. That residual case is not a bug this change tries to close --
 * see `temporal.ts`'s file-top comment for the full reasoning.
 *
 * The *string* form was already, and remains, mutually exclusive on its own
 * terms regardless of tagging: a bare ISO date string never also satisfies
 * `datetime`, and vice versa.
 */
export function matchesKind(value: unknown, name: ScalarKind): boolean {
  switch (name) {
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "date":
      if (value instanceof Date) return dateKind(value) !== "datetime";
      return isIsoDateString(value);
    case "time":
      return isIsoTimeString(value);
    case "datetime":
      if (value instanceof Date) return dateKind(value) !== "date";
      // `date`/`datetime` stay mutually exclusive on the string form, matching
      // Python's `_is_iso(..., datetime) and not _is_iso(..., date)`: no extra
      // exclusion clause is needed for it, since `DATETIME_RE` requires the
      // 'T' separator that `DATE_RE` forbids. (Before issue #49 one was
      // needed, because `Date.parse` accepted a bare date string as a
      // datetime, defaulting the missing time to midnight UTC.)
      return isIsoDatetimeString(value);
    /* v8 ignore start -- exhaustiveness guard: ScalarKind is a closed
     * 7-member union; every member is handled above, so this default can
     * never fire through the public API (only via an explicit type
     * assertion defeating the closed union, a caller bug this documents). */
    default:
      return false;
    /* v8 ignore stop */
  }
}

/** The most specific scalar kind a JS value matches, for error messages.
 * Mirrors `omnist/schema.py`'s `value_kind`; `integer` is reported even
 * though it also matches `number`. A real `Date` is reported as `datetime`
 * (the Document layer's single representation for both `date` and
 * `datetime`, see `matchesKind`'s doc comment above -- `datetime` is the
 * more general of the two, so it is the more informative guess absent a
 * declared field kind to disambiguate against). */
export function valueKind(v: unknown): ScalarKind {
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  if (v instanceof Date) return "datetime";
  return "string";
}

// Note: not called for `null` -- `conformScalar` handles the null case
// separately (its own `null-not-allowed` branch) before ever reaching a
// `matches_kind` failure, so by the time an error message needs a type
// name, the value is already known non-null.
function typeName(v: unknown): string {
  return valueKind(v);
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const MAX_DEPTH = 200;

/** A schema: a root reference plus an environment of named records. */
export class Schema {
  readonly root: RefType;
  readonly env: ReadonlyMap<string, Record>;

  constructor(root: RefType, env?: ReadonlyMap<string, Record> | Readonly<globalThis.Record<string, Record>>) {
    if (root.tag !== "ref") {
      throw new SchemaError("a schema root must be a Ref to a named record");
    }
    this.root = root;
    this.env = env instanceof Map ? new Map(env) : new Map(Object.entries(env ?? {}));
    this.checkRefs();
  }

  /** An `AnyFieldType` or `ScalarType` resolves to itself; a `RefType` is a
   * single environment lookup -- env values are always Records (enforced by
   * `checkRefs`), so ref chains cannot occur. */
  resolve(type: FieldType): Record | ScalarType | AnyFieldType {
    if (type.tag === "any" || type.tag === "scalar") return type;
    const rec = this.env.get(type.name);
    if (rec === undefined) {
      throw new SchemaError(`unknown type ${JSON.stringify(type.name)}`);
    }
    return rec;
  }

  private checkRefs(): void {
    for (const [name, rec] of this.env) {
      if (RESERVED_RECORD_NAMES.has(name)) {
        if (name === "any") {
          throw new SchemaError(`'any' is a reserved type name and cannot be used as a record name`);
        }
        throw new SchemaError(
          `${JSON.stringify(name)} is a reserved scalar name; a record cannot be ` +
            "defined with this name, or it could never be referenced " +
            "(a bare name in a type position always means the builtin scalar)",
        );
      }
      if (rec === null || typeof rec !== "object" || !Array.isArray(rec.fields)) {
        throw new SchemaError(`environment entry ${JSON.stringify(name)} must be a Record, got ${JSON.stringify(rec)}`);
      }
    }
    const walk = (type: FieldType): void => {
      if (type.tag === "ref" && !this.env.has(type.name)) {
        throw new SchemaError(`unknown type ${JSON.stringify(type.name)}`);
      }
    };
    walk(this.root);
    for (const rec of this.env.values()) {
      for (const f of rec.fields) walk(f.type);
    }
  }

  // -- validation -----------------------------------------------------

  /** Full conformance per model.md §7: cardinality, closedness, and target
   * type matching. Collects every problem found, not just the first. */
  validate(d: Doc): ValidationResult {
    if (!(d instanceof Doc)) {
      throw new TypeError("validate() expects a Doc; wrap your data with doc(...)");
    }
    const errors: OmnistIssue[] = [];
    this.conform(d, this.root, errors, 0);
    return { ok: errors.length === 0, errors };
  }

  /** `true` iff `validate(d).ok`. */
  accepts(d: Doc): boolean {
    return this.validate(d).ok;
  }

  private conform(d: Doc, type: FieldType, errors: OmnistIssue[], depth: number): void {
    /* v8 ignore start -- unreachable via the public surface: `Doc.of`/
     * `buildNode` (src/document.ts) already enforce the same MAX_DEPTH
     * (200) while constructing the Document being validated, so a `Doc`
     * whose nesting exceeds it can never exist to reach this check. Kept
     * for structural parity with `omnist/schema.py`'s `Schema._conform`
     * depth guard, and as a defense-in-depth backstop against a future
     * `Doc` constructed by a path that skips `buildNode`'s guard. */
    if (depth > MAX_DEPTH) {
      throw new SchemaError(`${d.path}: nesting exceeds the maximum depth (${MAX_DEPTH})`);
    }
    /* v8 ignore stop */
    const resolved = this.resolve(type);
    if ("tag" in resolved && resolved.tag === "any") return;
    if ("tag" in resolved && resolved.tag === "scalar") {
      this.conformScalar(d, resolved, errors);
    } else {
      this.conformRecord(d, resolved as Record, errors, depth);
    }
  }

  private conformScalar(d: Doc, s: ScalarType, errors: OmnistIssue[]): void {
    if (!d.isLeaf) {
      errors.push({ path: d.path, message: `expected a ${s.scalarKind} value, got an object`, code: "shape-mismatch" });
      return;
    }
    const v = d.value;
    if (v === null) {
      if (!s.nullable) {
        errors.push({ path: d.path, message: "null not allowed here", code: "null-not-allowed" });
      }
      return;
    }
    if (!matchesKind(v, s.scalarKind)) {
      errors.push({
        path: d.path,
        message: `expected ${s.scalarKind}, got ${typeName(v)} (${JSON.stringify(v)})`,
        code: "type-mismatch",
      });
    }
  }

  private conformRecord(d: Doc, rec: Record, errors: OmnistIssue[], depth: number): void {
    if (d.isLeaf) {
      errors.push({ path: d.path, message: "expected an object, got a value", code: "shape-mismatch" });
      return;
    }
    const counts = new Map<string, number>();
    for (const [label, child] of d.edges()) {
      counts.set(label, (counts.get(label) ?? 0) + 1);
      const f = recordField(rec, label);
      if (f === undefined) {
        errors.push({ path: child.path, message: "unexpected field", code: "unexpected-field" });
      } else {
        this.conform(child, f.type, errors, depth + 1);
      }
    }
    for (const f of rec.fields) {
      const c = counts.get(f.label) ?? 0;
      if (c < f.min || (f.max !== null && c > f.max)) {
        errors.push({
          path: d.path,
          message: `field ${JSON.stringify(f.label)} occurs ${c} time(s), expected ${cardinalityStr(f)}`,
          code: "cardinality",
        });
      }
    }
  }

  // -- comparison (delegate to operations; issue #6) -------------------

  /** True if every document this schema accepts is also accepted by
   * `other`. Delegates to `ops/subschema.ts`. */
  compatibleWith(other: Schema): boolean {
    return opsCompatibleWith(this, other);
  }

  /** True if both schemas accept exactly the same documents. Delegates to
   * `ops/subschema.ts`. */
  equivalent(other: Schema): boolean {
    return opsEquivalent(this, other);
  }

  /** The canonical minimal schema equivalent to this one. Delegates to
   * `ops/minimize.ts`. */
  normalize(): Schema {
    return opsNormalize(this);
  }

  /** The minimal subschema recognizing only documents built from `labels`.
   * Delegates to `ops/extract.ts`. */
  extract(...labels: string[]): Schema {
    return opsExtract(this, labels);
  }

  /** An equivalent schema with everything that can never match removed.
   * Delegates to `ops/prune.ts`. */
  prune(): Schema {
    return opsPrune(this);
  }

  /** True iff this schema's root record is unsatisfiable. Delegates to
   * `ops/prune.ts`. */
  isEmpty(): boolean {
    return opsIsEmpty(this);
  }
}

/** Builds a `Schema` from a root ref (or record name) and its environment. */
export function schema(root: RefType | string, env: Readonly<globalThis.Record<string, Record>> = {}): Schema {
  const r = typeof root === "string" ? ref(root) : root;
  return new Schema(r, env);
}

// Re-exported for callers that want a `str(ValidationResult)`-equivalent,
// matching Python's `ValidationResult.__str__`.
export { validationResultToString };
