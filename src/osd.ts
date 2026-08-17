/**
 * OSD (Omnist Schema Definition) -- the text language for the Schema model.
 * Ported from `omnist/osd.py`. Normative grammar:
 * `docs/design/schema-osd-grammar.md` in the Python repo.
 *
 * ```
 * schema      := record* 'root' NAME
 * record      := 'record' NAME '{' field (',' field)* ','? '}'
 * field       := STRING cardinality? ':' type
 * cardinality := '[' INT? (',' INT?)? ']'          -- [m,n] [m,] [,n] [n]; absent = [1,1]
 * type        := SCALARNAME '?'? | 'any' | NAME    -- one scalar, `any`, or one Ref
 * ```
 *
 * Quoting rule: a `"quoted"` token is a data string (always a field label --
 * there is no other use for a string literal in this grammar); an unquoted
 * identifier is a schema name (a scalar keyword, `any`, or a `Ref`).
 *
 * There is no value-domain composition: no `|`, no enum, no literal-valued
 * fields, and no `union`/`domain` declaration. A field's type is always
 * either one of the seven scalars, optionally `?`, `any`, or a `Ref` to a
 * named record. See `docs/design/model.md` for why: a composable
 * value-domain made schema-directed deserialization ambiguous.
 */

import { SchemaError } from "./errors.js";
import {
  ANY,
  SCALAR_KINDS,
  type FieldType,
  type Record as OmnistRecord,
  type ScalarKind,
  Schema,
  field,
  nullable,
  record,
  ref,
  t,
} from "./schema.js";

const SCALAR_KIND_SET: ReadonlySet<string> = new Set(SCALAR_KINDS);
const RESERVED_TYPE_NAMES: ReadonlySet<string> = new Set([...SCALAR_KINDS, "any"]);

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokenKind = "string" | "number" | "name" | "punct" | "eof";

interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  readonly pos: number;
}

// One alternation, tried left to right at each position -- mirrors the
// Python tokenizer's single regex. Whitespace and comments are matched so
// they can be skipped, but never emitted as tokens.
const TOKEN_RE =
  /(?<ws>\s+)|(?<comment>#[^\n]*)|(?<string>"(?:\\.|[^"\\])*")|(?<number>-?\d+\.\d+|-?\d+)|(?<name>[A-Za-z_][A-Za-z0-9_]*)|(?<punct>[{}[\]:,?])/y;

function tokenize(text: string): Token[] {
  const toks: Token[] = [];
  let i = 0;
  TOKEN_RE.lastIndex = 0;
  while (i < text.length) {
    TOKEN_RE.lastIndex = i;
    const m = TOKEN_RE.exec(text);
    if (!m || m.index !== i) {
      throw new SchemaError(`unexpected character ${JSON.stringify(text[i])} at ${i}`);
    }
    i = TOKEN_RE.lastIndex;
    const groups = m.groups as Record<string, string | undefined>;
    if (groups.ws !== undefined || groups.comment !== undefined) continue;
    let kind: TokenKind;
    if (groups.string !== undefined) kind = "string";
    else if (groups.number !== undefined) kind = "number";
    else if (groups.name !== undefined) kind = "name";
    else kind = "punct";
    toks.push({ kind, text: m[0], pos: m.index });
  }
  toks.push({ kind: "eof", text: "", pos: text.length });
  return toks;
}

function unquote(s: string): string {
  return s.slice(1, -1).replace(/\\(.)/gs, "$1");
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

interface RawField {
  label: string;
  type: FieldType;
  min: number;
  max: number | null;
}

class Parser {
  private readonly toks: readonly Token[];
  private i = 0;

  constructor(toks: readonly Token[]) {
    this.toks = toks;
  }

  private peek(): Token {
    return this.toks[this.i] as Token;
  }

  private next(): Token {
    const t2 = this.toks[this.i] as Token;
    this.i += 1;
    return t2;
  }

  private expect(kind: TokenKind, text?: string): Token {
    const t2 = this.next();
    if (t2.kind !== kind || (text !== undefined && t2.text !== text)) {
      const want = text ?? kind;
      throw new SchemaError(`expected ${JSON.stringify(want)} at ${t2.pos}, got ${JSON.stringify(t2.text)}`);
    }
    return t2;
  }

  parse(): Schema {
    const env = new Map<string, OmnistRecord>();
    let root: string | null = null;
    while (this.peek().kind !== "eof") {
      const tk = this.peek();
      if (tk.kind === "name" && tk.text === "record") {
        const [name, rec, namePos] = this.parseRecord();
        this.define(env, name, rec, namePos);
      } else if (tk.kind === "name" && tk.text === "root") {
        this.next();
        root = this.expect("name").text;
      } else {
        throw new SchemaError(`expected 'record' or 'root' at ${tk.pos}, got ${JSON.stringify(tk.text)}`);
      }
    }
    if (root === null) {
      throw new SchemaError("a schema must declare a root");
    }
    return new Schema(ref(root), env);
  }

  private define(env: Map<string, OmnistRecord>, name: string, rec: OmnistRecord, namePos: number): void {
    if (RESERVED_TYPE_NAMES.has(name)) {
      if (name === "any") {
        throw new SchemaError(`'any' is a reserved type name and cannot be used as a record name at ${namePos}`);
      }
      throw new SchemaError(
        `${JSON.stringify(name)} is a reserved scalar name; a record cannot be ` +
          "defined with this name, or it could never be referenced " +
          "(a bare name in a type position always means the builtin scalar)",
      );
    }
    if (env.has(name)) {
      throw new SchemaError(`duplicate definition ${JSON.stringify(name)}`);
    }
    env.set(name, rec);
  }

  private parseRecord(): [string, OmnistRecord, number] {
    this.expect("name", "record");
    const nameTok = this.expect("name");
    const name = nameTok.text;
    this.expect("punct", "{");
    const fields: RawField[] = [];
    while (this.peek().text !== "}") {
      fields.push(this.parseField());
      if (this.peek().text === ",") {
        this.next();
      } else {
        break;
      }
    }
    this.expect("punct", "}");
    return [name, record(...fields.map((f) => field(f.label, f.type, f.min, f.max))), nameTok.pos];
  }

  private parseField(): RawField {
    const labelTok = this.next();
    if (labelTok.kind !== "string") {
      throw new SchemaError(`expected a quoted field name at ${labelTok.pos}, got ${JSON.stringify(labelTok.text)}`);
    }
    const label = unquote(labelTok.text);
    let lo = 1;
    let hi: number | null = 1;
    if (this.peek().text === "[") {
      [lo, hi] = this.parseCardinality();
    }
    this.expect("punct", ":");
    const typ = this.parseType();
    return { label, type: typ, min: lo, max: hi };
  }

  private parseCardinality(): [number, number | null] {
    this.expect("punct", "[");
    let first: number | null = null;
    if (this.peek().kind === "number") {
      first = this.parseCardinalityInt();
    }
    let lo: number;
    let hi: number | null;
    if (this.peek().text === ",") {
      this.next();
      let second: number | null = null;
      if (this.peek().kind === "number") {
        second = this.parseCardinalityInt();
      }
      lo = first ?? 0;
      hi = second;
    } else {
      if (first === null) {
        throw new SchemaError(`empty cardinality at ${this.peek().pos}`);
      }
      lo = hi = first;
    }
    this.expect("punct", "]");
    return [lo, hi];
  }

  private parseCardinalityInt(): number {
    const t2 = this.next();
    if (t2.text.includes(".")) {
      throw new SchemaError(`cardinality must be a whole number, got ${JSON.stringify(t2.text)} at ${t2.pos}`);
    }
    return parseInt(t2.text, 10);
  }

  private parseType(): FieldType {
    const t2 = this.next();
    if (t2.kind !== "name") {
      throw new SchemaError(
        `expected a scalar name or a reference at ${t2.pos}, got ${JSON.stringify(t2.text)} ` +
          "(enums and literal-valued fields are not supported -- a " +
          "field's type is always one scalar or a reference to a " +
          "named record)",
      );
    }
    if (t2.text === "any") {
      if (this.peek().text === "?") {
        const q = this.next();
        throw new SchemaError(`'any' already includes null; 'any?' is redundant at ${q.pos}`);
      }
      return ANY;
    }
    let nullableFlag = false;
    if (this.peek().text === "?") {
      this.next();
      nullableFlag = true;
    }
    if (SCALAR_KIND_SET.has(t2.text)) {
      const scalarType = t[t2.text as ScalarKind];
      return nullableFlag ? nullable(scalarType) : scalarType;
    }
    if (nullableFlag) {
      throw new SchemaError(
        `'?' cannot apply to the reference ${JSON.stringify(t2.text)}; use ` +
          "cardinality [0,1] for an optional field",
      );
    }
    return ref(t2.text);
  }
}

/** Parse OSD text into a {@link Schema}. */
export function parseSchema(text: string): Schema {
  return new Parser(tokenize(text)).parse();
}

// ---------------------------------------------------------------------------
// Serialize a Schema back to OSD text
// ---------------------------------------------------------------------------

/**
 * Options for serializing a {@link Schema} to OSD schema text.
 */
export interface ToOsdOptions {
  /** Pretty-mode indent width in spaces (default 4). `null` renders a
   * single-line, machine-oriented form instead: record defs and the `root`
   * statement joined by spaces, fields joined by `", "`, no trailing comma
   * -- mirroring `write_oml`/`write_json`'s own `indent: null` convention.
   * Both forms round-trip through `parseSchema`. */
  readonly indent?: number | null;
}

/** Serialize a {@link Schema} back to OSD text. */
export function toOsd(schema: Schema, opts: ToOsdOptions = {}): string {
  const indent = opts.indent === undefined ? 4 : opts.indent;
  const parts: string[] = [...schema.env.entries()].map(([name, rec]) => renderRecord(name, rec, indent));
  parts.push(`root ${schema.root.name}`);
  if (indent === null) {
    return parts.join(" ") + "\n";
  }
  return parts.join("\n") + "\n";
}

function renderRecord(name: string, rec: OmnistRecord, indent: number | null): string {
  if (indent === null) {
    const fields = rec.fields.map(renderField).join(", ");
    return `record ${name} { ${fields} }`;
  }
  const pad = " ".repeat(indent);
  const out = [`record ${name} {`];
  for (const f of rec.fields) {
    out.push(`${pad}${renderField(f)},`);
  }
  out.push("}");
  return out.join("\n");
}

function renderField(f: { label: string; type: FieldType; min: number; max: number | null }): string {
  const card = f.min === 1 && f.max === 1 ? "" : ` ${renderCard(f.min, f.max)}`;
  return `"${f.label}"${card}: ${renderType(f.type)}`;
}

function renderCard(lo: number, hi: number | null): string {
  if (lo === hi) return `[${lo}]`;
  return `[${lo},${hi === null ? "" : hi}]`;
}

function renderType(type: FieldType): string {
  if (type.tag === "any") return "any";
  if (type.tag === "ref") return type.name;
  return `${type.scalarKind}${type.nullable ? "?" : ""}`;
}
