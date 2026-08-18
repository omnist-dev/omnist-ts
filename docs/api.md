# API reference

> Looking for the complete generated TypeDoc documentation? See the <a href="/api/index.html" target="_self">TypeDoc API Reference</a>.
> (Plain markdown link syntax can't carry a `target` attribute -- without it, VitePress's client-side
> router intercepts the click and silently does nothing, since `/api/index.html` isn't one of its own
> routes. The top nav's "TypeDoc" link works because it's configured with `target: "_self"` in
> `.vitepress/config.ts`; this is the same fix applied inline.)

Every public name exported from `@omnist-dev/omnist` (see `src/index.ts`),
grouped by area, with signatures. This mirrors the Python package's
`__all__` -- see [layout.md](layout.md) for which `src/*.ts` module owns
each group.

## Errors

- `class OmnistError extends Error` -- the base of every error this
  library throws.
- `class SchemaError extends OmnistError`
- `class ParseError extends OmnistError`
- `class WriteError extends OmnistError`
- `class DocumentError extends OmnistError`
- `class DetachedNode extends OmnistError`
- `class UnsafeXMLWarning extends OmnistError`
- `type OmnistIssue` -- the shape of a single validation/lint finding.

## Documents

- `class Doc` -- a guarded wrapper around a `Node`.
  - `static of(value: unknown): Doc`
  - `constructor(node: Node, path?: string)`
  - `get isLeaf(): boolean`
  - `get value(): Scalar`
  - `edges(): Array<[string, Doc]>`
  - `labels(): string[]`
  - `get(label: string): Doc[]`
  - `getOne(label: string): Doc`
  - `count(label: string): number`
  - `child(label: string): Doc`
  - `add(label: string, value: unknown): Doc`
  - `remove(label: string): Doc`
  - `set(label: string, value: unknown): Doc`
  - `toData(): Node`
  - `toGrouped(): unknown`
  - `equals(other: unknown): boolean`
- `function doc(value: unknown): Doc` -- builds a `Doc` from a plain JS
  value, or passes an existing `Doc` through.
- `type Node = Scalar | Edge[]`
- `type Edge = { label: string; target: Node }`
- `type Scalar = string | number | boolean | Date | null`

## Schema model

- `class Schema` -- a root `RefType` plus an environment of named
  `Record`s.
  - `constructor(root: RefType, env?)`
  - `readonly root: RefType`
  - `readonly env: ReadonlyMap<string, Record>`
  - `resolve(type: FieldType): Record | ScalarType | AnyFieldType`
  - `validate(d: Doc): ValidationResult`
  - `validates(d: Doc): boolean`
  - `compatibleWith(other: Schema): boolean`
  - `equivalent(other: Schema): boolean`
  - `normalize(): Schema`
  - `prune(): Schema`
  - `isEmpty(): boolean`
- `function schema(root: RefType | string, env?): Schema`
- `function record(...fields: Field[]): Record`
- `function field(label: string, type: FieldType, min?: number, max?: number | null): Field`
- `function ref(name: string): RefType`
- `function nullable(scalarType: ScalarType | AnyFieldType): ScalarType`
- `const t: { string, integer, number, boolean, date, time, datetime }` --
  the seven pre-built `ScalarType`s.
- `const ANY: AnyFieldType`
- `const SCALAR_KINDS: readonly ScalarKind[]`
- `function cardinalityStr(f: Field): string`
- `function recordField(rec: Record, label: string): Field | undefined`
- `function fieldTypeEquals(a, b): boolean`
- `function recordEquals(a, b): boolean`
- `function schemaEquals(a, b): boolean`
- `function matchesKind(value: unknown, name: ScalarKind): boolean`
- `function valueKind(v: unknown): ScalarKind`
- `function validationResultToString(res: ValidationResult): string`
- Types: `ScalarKind`, `FieldType`, `ScalarType`, `RefType`, `AnyFieldType`,
  `Field`, `Record`, `ValidationResult`.

## OSD

- `function parseSchema(text: string): Schema`
- `function toOsd(schema: Schema, opts?: ToOsdOptions): string`
- `type ToOsdOptions`

## Operations

- `function infer(samples: readonly unknown[], options?: InferOptions): Schema`
- `function inferWithReport(samples, options?): { schema: Schema; report: AnyFallback[] }`
- `type InferOptions = { rootName?: string; allowAny?: boolean }`
- `type AnyFallback`
- `function materialize(node: Node, schema: Schema): Node` -- schema-directed
  deserialization (upgrades value-exact leaves to match the schema).
- `function lint(s: Schema): LintFinding[]`
- `type LintFinding`
- `Schema.prototype.compatibleWith(other)` / `.equivalent(other)` /
  `.normalize()` / `.prune()` / `.isEmpty()` -- the schema-comparison and
  -reduction operations. Package `exports` only publish the top-level
  `@omnist-dev/omnist` module (see `package.json`), so `extract`,
  `isomorphic`, and the standalone `ops/*` functions these methods
  delegate to are internal implementation detail, not public API, in this
  release.

## Formats

Every format module exports the same three-function shape:

- `readJson(text, opts?: ReadJsonOptions): Node` / `writeJson(node, opts?: WriteJsonOptions): string` / `checkJson(node): WriteReport`
- `readOml(text, opts?): Node` / `writeOml(node, opts?: WriteOmlOptions): string` / `checkOml(node): WriteReport`
- `readXml(text, opts?: ReadXmlOptions): Node` / `writeXml(node, opts?: WriteXmlOptions): string` / `checkXml(node): WriteReport`
- `readToml(text, opts?: ReadTomlOptions): Node` / `writeToml(node, opts?: WriteTomlOptions): string` / `checkToml(node): WriteReport`
- `readYaml(text, opts?: ReadYamlOptions): Node` / `writeYaml(node, opts?: WriteYamlOptions): string` / `checkYaml(node): WriteReport`

See [Formats](formats/overview.md) for the per-format mapping and caveats.

## Adjustment reports

- `class WriteReport` -- `.adjustments: Adjustment[]`, `.ok: boolean`.
- `type Adjustment = { code: string; path: string; message: string; severity: Severity }`
- `type Severity`
- `function finishWrite(opts: FinishWriteOptions): WriteReport`
- `type FinishWriteOptions`

## Format registry

- `function registerFormat(f: Format): void`
- `function getFormat(name: string): Format`
- `function formats(): string[]`
- `type Format = { name: string; read; write; check }`

## Version

- `const VERSION = "0.0.1-alpha"`
