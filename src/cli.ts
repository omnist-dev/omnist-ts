#!/usr/bin/env node
/**
 * The `omnist` command-line interface.
 *
 * A thin wrapper over the public API exported from `src/index.ts` -- see
 * `docs/design/cli-spec.md` for the full command surface. Each command maps
 * to one or two calls into the library; this module adds no new behavior of
 * its own beyond argument parsing, file/stdio plumbing, and exit codes.
 * Ported from `omnist/cli.py`.
 */

import * as fs from "node:fs";
import {
  Doc,
  ParseError,
  SchemaError,
  WriteError,
  DocumentError,
  OmnistError,
  WriteReport,
  doc,
  readJson,
  readToml,
  readXml,
  readYaml,
  writeJson,
  writeToml,
  writeXml,
  writeYaml,
  checkJson,
  checkXml,
  checkToml,
  checkYaml,
  VERSION,
  type Node,
  type OmnistIssue,
} from "./index.js";
import { readOml, writeOml, checkOml } from "./oml.js";
import { infer, inferWithReport } from "./infer.js";
import { parseSchema, toOsd } from "./osd.js";
import { lint } from "./ops/lint.js";
import type { Schema, ValidationResult } from "./schema.js";

const FMT_CHOICES = ["json", "yaml", "toml", "xml", "oml"] as const;
type Fmt = (typeof FMT_CHOICES)[number];
const RESULT_FORMAT_CHOICES = ["text", "json", "oml"] as const;
type ResultFormat = (typeof RESULT_FORMAT_CHOICES)[number];

const READERS: Record<Fmt, (text: string, opts?: { schema?: Schema }) => Node> = {
  json: readJson,
  yaml: readYaml,
  toml: readToml,
  xml: readXml,
  oml: readOml,
};

// OML has no strict=/report= -- it's always exactly lossless, so it never
// needs them; the other four writers accept both.
type OtherFmt = "json" | "yaml" | "toml" | "xml";
const WRITERS: Record<OtherFmt, (node: Node, opts?: { strict?: boolean; report?: WriteReport }) => string> = {
  json: writeJson,
  yaml: writeYaml,
  toml: writeToml,
  xml: writeXml,
};

const CHECKERS: Record<Fmt, (node: Node) => WriteReport> = {
  json: checkJson,
  yaml: checkYaml,
  toml: checkToml,
  xml: checkXml,
  oml: checkOml,
};

// ---------------------------------------------------------------------------
// Minimal Python-json.dumps-compatible serializer: ", "/": " separators, no
// indent -- the stable --json contract (docs/stability.md) pins this exact
// spacing, which JSON.stringify's default (no spaces) does not match.
// ---------------------------------------------------------------------------

function pyJson(value: unknown): string {
  // None of this CLI's --json payloads ever carry an explicit null field
  // today (they're built from strings/booleans/arrays/objects only), but
  // this stays a general-purpose encoder rather than one hand-tuned to
  // today's payload shapes.
  /* v8 ignore next */
  if (value === null) return "null";
  if (Array.isArray(value)) return "[" + value.map(pyJson).join(", ") + "]";
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return "{" + entries.map(([k, v]) => JSON.stringify(k) + ": " + pyJson(v)).join(", ") + "}";
  }
  // boolean | number | string -- every payload this CLI builds is JSON.stringify-safe as-is.
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// IO plumbing
// ---------------------------------------------------------------------------

/** Reads `path`, or stdin when `path === "-"`. Stdin is read via
 * `ctx.readStdin` -- a real process's stdin (fd 0) by default, or an
 * injected string for in-process testing (mirroring how the Python suite
 * monkeypatches `sys.stdin`; Node's `fs.readFileSync` on built-in modules
 * isn't reliably spy-able across environments, so this is done via
 * explicit injection through {@link main}'s second argument instead). */
function readInput(ctx: Ctx, path: string): string {
  if (path === "-") {
    return ctx.readStdin();
  }
  return fs.readFileSync(path, "utf-8");
}

function writeOutput(stdout: Writer, path: string | undefined, text: string): void {
  const withNl = text.endsWith("\n") ? text : text + "\n";
  if (path === undefined || path === "-") {
    stdout.write(withNl);
  } else {
    fs.writeFileSync(path, withNl, "utf-8");
  }
}

interface Writer {
  write(text: string): void;
}

function makeWriter(stream: NodeJS.WritableStream): Writer {
  return { write: (text: string) => void stream.write(text) };
}

// ---------------------------------------------------------------------------
// Shared encoders
// ---------------------------------------------------------------------------

function encodeValidationResult(result: ValidationResult, fmt: ResultFormat): string {
  if (fmt === "text") {
    return result.ok
      ? "valid"
      : "invalid:\n" + result.errors.map((e) => `  at ${e.path}: ${e.message}`).join("\n");
  }
  const payload = {
    ok: result.ok,
    errors: result.errors.map((e) => ({ path: e.path, message: e.message })),
  };
  if (fmt === "json") return pyJson(payload);
  return writeOml(doc(payload).toData());
}

function encodeWriteReport(rep: WriteReport, fmt: ResultFormat): string {
  if (fmt === "text") return rep.toString();
  const payload = rep.adjustments.map((a) => ({ path: a.path, code: a.code, message: a.message, severity: a.severity }));
  if (fmt === "json") return pyJson(payload);
  return writeOml(doc({ adjustments: payload }).toData());
}

function encodeBoolResult(key: string, value: boolean, fmt: ResultFormat): string {
  if (fmt === "text") return value ? "true" : "false";
  if (fmt === "json") return pyJson({ [key]: value });
  return writeOml(doc({ [key]: value }).toData());
}

function writeToFormat(
  fmt: Fmt,
  node: Node,
  opts: { strict: boolean; report: WriteReport | undefined; compact: boolean; arrays: boolean },
): string {
  if (fmt === "oml") {
    return writeOml(node, { indent: opts.compact ? null : 2, arrays: opts.arrays });
  }
  const writer = WRITERS[fmt as OtherFmt];
  return opts.report !== undefined
    ? writer(node, { strict: opts.strict, report: opts.report })
    : writer(node, { strict: opts.strict });
}

// ---------------------------------------------------------------------------
// Uniform error/failure emission
// ---------------------------------------------------------------------------

function jsonValidateOk(): string {
  return pyJson({ ok: true });
}

function jsonValidateErrors(message: string, errors: readonly OmnistIssue[]): string {
  const payload = {
    ok: false,
    message,
    errors: errors.map((e) => ({ path: e.path, code: e.code, message: e.message })),
  };
  return pyJson(payload);
}

function jsonError(exc: unknown): string {
  const errors = exc instanceof ParseError ? exc.errors : [];
  return jsonValidateErrors(errorMessage(exc), errors);
}

function errorMessage(exc: unknown): string {
  // Unreachable via the public surface: every catch site that reaches
  // this only ever holds an Error (an OmnistError subtype, a UsageError,
  // or an fs error). Defensive backstop for a non-Error throw.
  /* v8 ignore next */
  return exc instanceof Error ? exc.message : String(exc);
}

interface Ctx {
  json: boolean;
  stdout: Writer;
  stderr: Writer;
  readStdin: () => string;
}

/** Uniform in-handler error emission. Under --json, print a machine-readable
 * error object to stdout; otherwise the free-text `error: ...` to stderr.
 * Exit `code` is returned unchanged either way. `exc` may be an exception or
 * a bare message string (for the convert oml/oml usage guard). */
function fail(ctx: Ctx, exc: string | unknown, code: number): number {
  if (ctx.json) {
    if (typeof exc === "string") {
      ctx.stdout.write(jsonValidateErrors(exc, []) + "\n");
    } else {
      ctx.stdout.write(jsonError(exc) + "\n");
    }
  } else {
    const msg = typeof exc === "string" ? exc : errorMessage(exc);
    ctx.stderr.write(`error: ${msg}\n`);
  }
  return code;
}

const ARRAYS_OSD_ONLY_MSG = "--arrays applies only to OML output (format, convert --to oml)";

// ---------------------------------------------------------------------------
// Argument parsing -- a small hand-rolled parser (no CLI framework
// dependency), close enough to argparse's contract for this surface:
// required flags, choice validation, boolean/string flags, `-o`/`--output`
// alias, positionals (single, or "+": one-or-more). Any usage problem
// throws UsageError, caught by main() -> prints to stderr, exit 2.
// ---------------------------------------------------------------------------

class UsageError extends Error {}

interface FlagSpec {
  readonly type: "boolean" | "string";
  readonly choices?: readonly string[];
  readonly aliases?: readonly string[];
}

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | boolean>;
}

function parseFlags(args: string[], spec: Record<string, FlagSpec>): ParsedArgs {
  const aliasToName = new Map<string, string>();
  for (const [name, s] of Object.entries(spec)) {
    aliasToName.set("--" + name, name);
    for (const a of s.aliases ?? []) aliasToName.set(a, name);
  }
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  let i = 0;
  while (i < args.length) {
    const tok = args[i] as string;
    if (tok.startsWith("-") && tok !== "-" && tok !== "--") {
      let flagTok = tok;
      let inlineValue: string | undefined;
      const eq = tok.indexOf("=");
      if (tok.startsWith("--") && eq !== -1) {
        flagTok = tok.slice(0, eq);
        inlineValue = tok.slice(eq + 1);
      }
      const name = aliasToName.get(flagTok);
      if (name === undefined) {
        throw new UsageError(`unrecognized argument: ${tok}`);
      }
      const s = spec[name] as FlagSpec;
      if (s.type === "boolean") {
        flags.set(name, true);
        i += 1;
      } else if (inlineValue !== undefined) {
        if (s.choices !== undefined && !s.choices.includes(inlineValue)) {
          throw new UsageError(`argument --${name}: invalid choice: '${inlineValue}' (choose from ${s.choices.join(", ")})`);
        }
        flags.set(name, inlineValue);
        i += 1;
      } else {
        const value = args[i + 1];
        if (value === undefined) {
          throw new UsageError(`argument --${name}: expected one argument`);
        }
        if (s.choices !== undefined && !s.choices.includes(value)) {
          throw new UsageError(`argument --${name}: invalid choice: '${value}' (choose from ${s.choices.join(", ")})`);
        }
        flags.set(name, value);
        i += 2;
      }
    } else {
      positionals.push(tok);
      i += 1;
    }
  }
  return { positionals, flags };
}

function getStr(p: ParsedArgs, name: string): string | undefined {
  const v = p.flags.get(name);
  return typeof v === "string" ? v : undefined;
}

function getBool(p: ParsedArgs, name: string): boolean {
  return p.flags.get(name) === true;
}

function requireStr(p: ParsedArgs, name: string, flagLabel: string): string {
  const v = getStr(p, name);
  if (v === undefined) throw new UsageError(`the following arguments are required: --${flagLabel}`);
  return v;
}

function requirePositional(p: ParsedArgs, index: number, label: string): string {
  const v = p.positionals[index];
  if (v === undefined) throw new UsageError(`the following arguments are required: ${label}`);
  return v;
}

const JSON_FLAG: FlagSpec = { type: "boolean" };
const OUTPUT_FLAG: FlagSpec = { type: "string", aliases: ["-o"] };
const COMPACT_FLAG: FlagSpec = { type: "boolean" };
const ARRAYS_FLAG: FlagSpec = { type: "boolean" };
const FROM_FLAG: FlagSpec = { type: "string", choices: FMT_CHOICES };
const TO_FLAG: FlagSpec = { type: "string", choices: FMT_CHOICES };
const RESULT_FORMAT_FLAG: FlagSpec = { type: "string", choices: RESULT_FORMAT_CHOICES };

function resultFormatOf(p: ParsedArgs): ResultFormat {
  return (getStr(p, "result-format") ?? "text") as ResultFormat;
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

function cmdFormat(p: ParsedArgs, ctx: Ctx): number {
  const input = requirePositional(p, 0, "input");
  const compact = getBool(p, "compact");
  const arrays = getBool(p, "arrays");
  const output = getStr(p, "output");
  const node = readOml(readInput(ctx, input));
  writeOutput(ctx.stdout, output, writeOml(node, { indent: compact ? null : 2, arrays }));
  return 0;
}

function cmdConvert(p: ParsedArgs, ctx: Ctx): number {
  const input = requirePositional(p, 0, "input");
  const from = requireStr(p, "from", "from") as Fmt;
  const to = requireStr(p, "to", "to") as Fmt;
  if (from === "oml" && to === "oml") {
    return fail(ctx, "--from oml --to oml is not supported here; use `omnist format` instead", 2);
  }
  const schemaPath = getStr(p, "schema");
  const strict = getBool(p, "strict");
  const wantReport = getBool(p, "report");
  const compact = getBool(p, "compact");
  const arrays = getBool(p, "arrays");
  const output = getStr(p, "output");
  const resultFormat = resultFormatOf(p);

  const schema = schemaPath !== undefined ? parseSchema(readInput(ctx, schemaPath)) : undefined;
  const node = schema !== undefined ? READERS[from](readInput(ctx, input), { schema }) : READERS[from](readInput(ctx, input));
  const report = wantReport ? new WriteReport() : undefined;
  let text: string;
  try {
    text = writeToFormat(to, node, { strict, report, compact, arrays });
  } catch (exc) {
    if (exc instanceof WriteError && exc.report !== undefined) {
      // --strict refused a lossy write -- a definite "no," not a
      // usage/parse failure, so it's grouped with exit 1, not the
      // generic exit 2 the top-level catch would give it.
      return fail(ctx, exc, 1);
    }
    throw exc; // a structural failure (e.g. multi-root XML) -- exit 2
  }
  writeOutput(ctx.stdout, output, text);
  if (wantReport) {
    ctx.stderr.write(encodeWriteReport(report as WriteReport, resultFormat) + "\n");
  }
  return 0;
}

function cmdCheck(p: ParsedArgs, ctx: Ctx): number {
  const input = requirePositional(p, 0, "input");
  const from = requireStr(p, "from", "from") as Fmt;
  const to = requireStr(p, "to", "to") as Fmt;
  const strict = getBool(p, "strict");
  const node = READERS[from](readInput(ctx, input));
  const rep = CHECKERS[to](node);
  const fmt: ResultFormat = ctx.json ? "json" : resultFormatOf(p);
  ctx.stdout.write(encodeWriteReport(rep, fmt) + "\n");
  if (strict) return rep.length === 0 ? 0 : 1;
  return 0;
}

function cmdValidate(p: ParsedArgs, ctx: Ctx): number {
  const input = requirePositional(p, 0, "input");
  const from = requireStr(p, "from", "from") as Fmt;
  const schemaPath = requireStr(p, "schema", "schema");
  if (ctx.json) {
    let node: Node;
    let d: Doc;
    let s: Schema;
    try {
      node = READERS[from](readInput(ctx, input));
      d = new Doc(node);
      s = parseSchema(readInput(ctx, schemaPath));
    } catch (exc) {
      // `new Doc(node)` can't itself throw DocumentError here: `node` was
      // already built (and validated) by READERS[from]'s own buildNode
      // call, so the only realistic failures on this path are a format-
      // syntax ParseError, a malformed --schema (SchemaError), or a
      // missing/unreadable file (an fs error). A DocumentError or anything
      // else still propagates correctly -- to main()'s own catch, which
      // handles the same ctx.json branching for every OmnistError subtype.
      // Unreachable via the public surface, see the comment above: kept as
      // a defensive backstop that rethrows to main()'s own catch instead
      // of silently swallowing anything else.
      /* v8 ignore next */
      if (!(exc instanceof ParseError || exc instanceof SchemaError || isFsError(exc))) throw exc;
      const errors = exc instanceof ParseError ? exc.errors : [];
      ctx.stdout.write(jsonValidateErrors(errorMessage(exc), errors) + "\n");
      return 2;
    }
    const result = s.validate(d);
    if (result.ok) {
      ctx.stdout.write(jsonValidateOk() + "\n");
      return 0;
    }
    ctx.stdout.write(jsonValidateErrors(encodeValidationResult(result, "text"), result.errors) + "\n");
    return 1;
  }
  const node = READERS[from](readInput(ctx, input));
  const d = new Doc(node);
  const s = parseSchema(readInput(ctx, schemaPath));
  const result = s.validate(d);
  ctx.stdout.write(encodeValidationResult(result, resultFormatOf(p)) + "\n");
  return result.ok ? 0 : 1;
}

function isFsError(exc: unknown): boolean {
  return exc instanceof Error && "code" in exc && typeof (exc as { code?: unknown }).code === "string";
}

function cmdInfer(p: ParsedArgs, ctx: Ctx): number {
  if (getBool(p, "arrays")) {
    return fail(ctx, ARRAYS_OSD_ONLY_MSG, 2);
  }
  if (p.positionals.length === 0) {
    throw new UsageError("the following arguments are required: input");
  }
  const from = requireStr(p, "from", "from") as Fmt;
  const compact = getBool(p, "compact");
  const allowAny = getBool(p, "allow-any");
  const output = getStr(p, "output");
  const reader = READERS[from];
  const docs = p.positionals.map((path) => new Doc(reader(readInput(ctx, path))));
  let s: Schema;
  if (allowAny) {
    const { schema, report } = inferWithReport(docs, { allowAny: true });
    s = schema;
    if (report.length > 0) {
      ctx.stderr.write(`opened ${report.length} field(s) as \`any\`:\n`);
      for (const fb of report) {
        ctx.stderr.write(`  ${fb.location} — ${fb.reason}\n`);
      }
    }
  } else {
    s = infer(docs);
  }
  writeOutput(ctx.stdout, output, toOsd(s, { indent: compact ? null : 4 }));
  return 0;
}

function cmdSchemaFormat(p: ParsedArgs, ctx: Ctx): number {
  if (getBool(p, "arrays")) return fail(ctx, ARRAYS_OSD_ONLY_MSG, 2);
  const schemaFile = requirePositional(p, 0, "schema_file");
  const compact = getBool(p, "compact");
  const output = getStr(p, "output");
  const s = parseSchema(readInput(ctx, schemaFile));
  writeOutput(ctx.stdout, output, toOsd(s, { indent: compact ? null : 4 }));
  return 0;
}

function cmdSchemaNormalize(p: ParsedArgs, ctx: Ctx): number {
  if (getBool(p, "arrays")) return fail(ctx, ARRAYS_OSD_ONLY_MSG, 2);
  const schemaFile = requirePositional(p, 0, "schema_file");
  const compact = getBool(p, "compact");
  const output = getStr(p, "output");
  const s = parseSchema(readInput(ctx, schemaFile));
  writeOutput(ctx.stdout, output, toOsd(s.normalize(), { indent: compact ? null : 4 }));
  return 0;
}

function cmdSchemaPrune(p: ParsedArgs, ctx: Ctx): number {
  const schemaFile = requirePositional(p, 0, "schema_file");
  const compact = getBool(p, "compact");
  const output = getStr(p, "output");
  const s = parseSchema(readInput(ctx, schemaFile));
  writeOutput(ctx.stdout, output, toOsd(s.prune(), { indent: compact ? null : 4 }));
  return 0;
}

function cmdSchemaIsEmpty(p: ParsedArgs, ctx: Ctx): number {
  const schemaFile = requirePositional(p, 0, "schema_file");
  const s = parseSchema(readInput(ctx, schemaFile));
  const result = s.isEmpty();
  const fmt: ResultFormat = ctx.json ? "json" : resultFormatOf(p);
  ctx.stdout.write(encodeBoolResult("empty", result, fmt) + "\n");
  return result ? 0 : 1;
}

function cmdSchemaExtract(p: ParsedArgs, ctx: Ctx): number {
  const schemaFile = requirePositional(p, 0, "schema_file");
  const keep = requireStr(p, "keep", "keep");
  const compact = getBool(p, "compact");
  const output = getStr(p, "output");
  const s = parseSchema(readInput(ctx, schemaFile));
  const labels = keep.split(",").filter((l) => l !== "");
  let extracted: Schema;
  try {
    extracted = s.extract(...labels);
  } catch (exc) {
    // Unreachable via the public surface: Schema.extract (src/ops/
    // extract.ts) only ever throws SchemaError. Defensive backstop.
    /* v8 ignore next */
    if (!(exc instanceof SchemaError)) throw exc;
    // A definite "no valid subschema" -- exit 1, not the generic 2 an
    // uncaught SchemaError would otherwise get.
    return fail(ctx, exc, 1);
  }
  writeOutput(ctx.stdout, output, toOsd(extracted, { indent: compact ? null : 4 }));
  return 0;
}

function cmdSchemaLint(p: ParsedArgs, ctx: Ctx): number {
  const schemaFile = requirePositional(p, 0, "schema_file");
  const severity = (getStr(p, "severity") ?? "info") as "info" | "warning";
  const order: Record<string, number> = { info: 0, warning: 1 };
  const threshold = order[severity] as number;
  const s = parseSchema(readInput(ctx, schemaFile));
  const findings = lint(s).filter((f) => (order[f.severity] as number) >= threshold);
  const hasWarning = findings.some((f) => f.severity === "warning");
  if (getBool(p, "json")) {
    const payload = {
      ok: !hasWarning,
      findings: findings.map((f) => ({ code: f.code, severity: f.severity, location: f.location, message: f.message })),
    };
    ctx.stdout.write(pyJson(payload) + "\n");
  } else {
    if (findings.length === 0) {
      ctx.stdout.write("no findings\n");
    } else {
      for (const f of findings) {
        ctx.stdout.write(`${f.severity}: ${f.code}: ${f.location}: ${f.message}\n`);
      }
    }
  }
  return hasWarning ? 1 : 0;
}

function cmdSchemaCompatibleWith(p: ParsedArgs, ctx: Ctx): number {
  const a = requirePositional(p, 0, "a");
  const b = requirePositional(p, 1, "b");
  const sa = parseSchema(readInput(ctx, a));
  const sb = parseSchema(readInput(ctx, b));
  const result = sa.compatibleWith(sb);
  const fmt: ResultFormat = ctx.json ? "json" : resultFormatOf(p);
  ctx.stdout.write(encodeBoolResult("compatible", result, fmt) + "\n");
  return result ? 0 : 1;
}

function cmdSchemaEquivalent(p: ParsedArgs, ctx: Ctx): number {
  const a = requirePositional(p, 0, "a");
  const b = requirePositional(p, 1, "b");
  const sa = parseSchema(readInput(ctx, a));
  const sb = parseSchema(readInput(ctx, b));
  const result = sa.equivalent(sb);
  const fmt: ResultFormat = ctx.json ? "json" : resultFormatOf(p);
  ctx.stdout.write(encodeBoolResult("equivalent", result, fmt) + "\n");
  return result ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Top-level dispatch
// ---------------------------------------------------------------------------

const TOP_LEVEL_HELP = `usage: omnist [-h] [--version] {format,convert,check,validate,infer,schema} ...

One canonical data model for JSON, YAML, TOML, XML, and OML -- read, validate,
and write any of them. See docs/cli.md for the full command reference.

positional arguments:
  {format,convert,check,validate,infer,schema}
    format              canonicalize an OML document (the only format with no
                        other tool for this)
    convert             convert a document between formats (one in, one out)
    check               report what writing as --to would adjust, without ever
                        writing
    validate            check a document against a schema (no schema-directed
                        upgrading)
    infer               draft a schema from example documents (all the same
                        format)
    schema              operate on a Schema (OSD)

options:
  -h, --help            show this help message and exit
  --version             show program's version number and exit
`;

const SCHEMA_SUBCOMMANDS = new Set([
  "format",
  "normalize",
  "prune",
  "is-empty",
  "extract",
  "lint",
  "compatible-with",
  "equivalent",
]);

const FORMAT_SPEC: Record<string, FlagSpec> = {
  json: JSON_FLAG,
  compact: COMPACT_FLAG,
  arrays: ARRAYS_FLAG,
  output: OUTPUT_FLAG,
};
const CONVERT_SPEC: Record<string, FlagSpec> = {
  json: JSON_FLAG,
  from: FROM_FLAG,
  to: TO_FLAG,
  schema: { type: "string" },
  strict: { type: "boolean" },
  report: { type: "boolean" },
  "result-format": RESULT_FORMAT_FLAG,
  compact: COMPACT_FLAG,
  arrays: ARRAYS_FLAG,
  output: OUTPUT_FLAG,
};
const CHECK_SPEC: Record<string, FlagSpec> = {
  json: JSON_FLAG,
  from: FROM_FLAG,
  to: TO_FLAG,
  strict: { type: "boolean" },
  "result-format": RESULT_FORMAT_FLAG,
};
const VALIDATE_SPEC: Record<string, FlagSpec> = {
  json: JSON_FLAG,
  from: FROM_FLAG,
  schema: { type: "string" },
  "result-format": RESULT_FORMAT_FLAG,
};
const INFER_SPEC: Record<string, FlagSpec> = {
  json: JSON_FLAG,
  from: FROM_FLAG,
  compact: COMPACT_FLAG,
  arrays: ARRAYS_FLAG,
  "allow-any": { type: "boolean" },
  output: OUTPUT_FLAG,
};
const SCHEMA_FORMAT_SPEC: Record<string, FlagSpec> = {
  json: JSON_FLAG,
  compact: COMPACT_FLAG,
  arrays: ARRAYS_FLAG,
  output: OUTPUT_FLAG,
};
const SCHEMA_PRUNE_SPEC: Record<string, FlagSpec> = {
  json: JSON_FLAG,
  compact: COMPACT_FLAG,
  output: OUTPUT_FLAG,
};
const SCHEMA_IS_EMPTY_SPEC: Record<string, FlagSpec> = {
  json: JSON_FLAG,
  "result-format": RESULT_FORMAT_FLAG,
};
const SCHEMA_EXTRACT_SPEC: Record<string, FlagSpec> = {
  json: JSON_FLAG,
  keep: { type: "string" },
  compact: COMPACT_FLAG,
  output: OUTPUT_FLAG,
};
const SCHEMA_LINT_SPEC: Record<string, FlagSpec> = {
  json: JSON_FLAG,
  severity: { type: "string", choices: ["info", "warning"] },
};
const SCHEMA_COMPAT_SPEC: Record<string, FlagSpec> = {
  json: JSON_FLAG,
  "result-format": RESULT_FORMAT_FLAG,
};

function dispatch(command: string, schemaCommand: string | undefined, rest: string[], ctx: Ctx): number {
  switch (command) {
    case "format": {
      const p = parseFlags(rest, FORMAT_SPEC);
      ctx.json = getBool(p, "json");
      return cmdFormat(p, ctx);
    }
    case "convert": {
      const p = parseFlags(rest, CONVERT_SPEC);
      ctx.json = getBool(p, "json");
      return cmdConvert(p, ctx);
    }
    case "check": {
      const p = parseFlags(rest, CHECK_SPEC);
      ctx.json = getBool(p, "json");
      return cmdCheck(p, ctx);
    }
    case "validate": {
      const p = parseFlags(rest, VALIDATE_SPEC);
      ctx.json = getBool(p, "json");
      return cmdValidate(p, ctx);
    }
    case "infer": {
      const p = parseFlags(rest, INFER_SPEC);
      ctx.json = getBool(p, "json");
      return cmdInfer(p, ctx);
    }
    case "schema": {
      if (schemaCommand === undefined) {
        throw new UsageError("the following arguments are required: schema_command");
      }
      if (!SCHEMA_SUBCOMMANDS.has(schemaCommand)) {
        throw new UsageError(`invalid choice: '${schemaCommand}'`);
      }
      switch (schemaCommand) {
        case "format": {
          const p = parseFlags(rest, SCHEMA_FORMAT_SPEC);
          ctx.json = getBool(p, "json");
          return cmdSchemaFormat(p, ctx);
        }
        case "normalize": {
          const p = parseFlags(rest, SCHEMA_FORMAT_SPEC);
          ctx.json = getBool(p, "json");
          return cmdSchemaNormalize(p, ctx);
        }
        case "prune": {
          const p = parseFlags(rest, SCHEMA_PRUNE_SPEC);
          ctx.json = getBool(p, "json");
          return cmdSchemaPrune(p, ctx);
        }
        case "is-empty": {
          const p = parseFlags(rest, SCHEMA_IS_EMPTY_SPEC);
          ctx.json = getBool(p, "json");
          return cmdSchemaIsEmpty(p, ctx);
        }
        case "extract": {
          const p = parseFlags(rest, SCHEMA_EXTRACT_SPEC);
          ctx.json = getBool(p, "json");
          return cmdSchemaExtract(p, ctx);
        }
        case "lint": {
          const p = parseFlags(rest, SCHEMA_LINT_SPEC);
          ctx.json = false; // lint's --json is handled internally, not via the shared fail() path
          return cmdSchemaLint(p, ctx);
        }
        case "compatible-with": {
          const p = parseFlags(rest, SCHEMA_COMPAT_SPEC);
          ctx.json = getBool(p, "json");
          return cmdSchemaCompatibleWith(p, ctx);
        }
        case "equivalent": {
          const p = parseFlags(rest, SCHEMA_COMPAT_SPEC);
          ctx.json = getBool(p, "json");
          return cmdSchemaEquivalent(p, ctx);
        }
        /* v8 ignore start -- unreachable: schemaCommand is checked against
         * SCHEMA_SUBCOMMANDS above, so every member is handled by one of
         * the cases here. */
        default:
          throw new UsageError(`invalid choice: '${String(schemaCommand)}'`);
        /* v8 ignore stop */
      }
    }
    /* v8 ignore start -- unreachable: main()'s own dispatch only calls this
     * for one of the five top-level commands or "schema", already checked
     * before dispatch() is invoked. */
    default:
      throw new UsageError(`invalid choice: '${command}'`);
    /* v8 ignore stop */
  }
}

/** Runs the `omnist` CLI. Returns the process exit code; never calls
 * `process.exit` itself, so it can be invoked in-process (tests) or from a
 * thin `bin` entry point that does. */
export function main(
  argv: readonly string[],
  opts?: { stdout?: NodeJS.WritableStream; stderr?: NodeJS.WritableStream; stdin?: string },
): number {
  const stdout = makeWriter(opts?.stdout ?? process.stdout);
  const stderr = makeWriter(opts?.stderr ?? process.stderr);
  // The real-fd-0 branch is exercised by the manual "pipe a fixture
  // through `node dist/cli.js ...`" verification (see the PR
  // description), not by the in-process test suite: spying on Node's
  // built-in `fs.readFileSync` isn't reliable across environments (it
  // throws "Cannot redefine property" here), so `opts.stdin` injection is
  // the tested seam instead -- see readInput's doc comment.
  /* v8 ignore next */
  const readStdin = (): string => (opts?.stdin !== undefined ? opts.stdin : fs.readFileSync(0, "utf-8"));
  const args = [...argv];

  if (args.includes("--version")) {
    stdout.write(`omnist ${VERSION}\n`);
    return 0;
  }
  if (args.includes("--help") || args.includes("-h")) {
    stdout.write(TOP_LEVEL_HELP);
    return 0;
  }

  const command = args[0];
  if (command === undefined) {
    stderr.write("usage: omnist [-h] [--version] {format,convert,check,validate,infer,schema} ...\n");
    stderr.write("error: the following arguments are required: command\n");
    return 2;
  }
  const validCommands = new Set(["format", "convert", "check", "validate", "infer", "schema"]);
  if (!validCommands.has(command)) {
    stderr.write("usage: omnist [-h] [--version] {format,convert,check,validate,infer,schema} ...\n");
    stderr.write(`error: argument command: invalid choice: '${command}'\n`);
    return 2;
  }

  let rest = args.slice(1);
  let schemaCommand: string | undefined;
  if (command === "schema") {
    schemaCommand = rest[0];
    if (schemaCommand !== undefined && !schemaCommand.startsWith("-")) {
      rest = rest.slice(1);
    } else {
      schemaCommand = undefined;
    }
  }

  const ctx: Ctx = { json: false, stdout, stderr, readStdin };
  try {
    return dispatch(command, schemaCommand, rest, ctx);
  } catch (exc) {
    if (exc instanceof UsageError) {
      stderr.write(`usage: omnist ${command}${schemaCommand !== undefined ? " " + schemaCommand : ""} ...\n`);
      stderr.write(`error: ${exc.message}\n`);
      return 2;
    }
    const isKnown =
      exc instanceof ParseError ||
      exc instanceof SchemaError ||
      exc instanceof WriteError ||
      exc instanceof DocumentError ||
      exc instanceof OmnistError ||
      isFsError(exc);
    // Every command handler only ever throws a UsageError or an
    // OmnistError subclass (or an fs error) -- the rethrow below is a
    // defensive backstop for anything else, unreachable via the public
    // surface.
    /* v8 ignore next */
    if (!isKnown) throw exc;
    if (ctx.json) {
      stdout.write(jsonError(exc) + "\n");
    } else {
      stderr.write(`error: ${errorMessage(exc)}\n`);
    }
    return 2;
  }
}

// Module entry point -- exercised only by direct execution (`node dist/
// cli.js ...`, i.e. the package's `bin`), never by importing this module
// (tests import `main` directly and call it themselves), so it's excluded
// from coverage the same way omnist/cli.py's own `if __name__ ==
// "__main__"` block is (see that file's `# pragma: no cover`).
/* v8 ignore start */
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
/* v8 ignore stop */
