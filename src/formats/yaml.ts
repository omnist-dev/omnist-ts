/**
 * YAML codec over the canonical Document (edge-list) model. Ported from the
 * YAML section of omnist/formats.py.
 *
 * YAML goes through the same JSON-shaped grouping (grouped()) as JSON --
 * same-label edges collapse into an array, a single occurrence stays bare
 * (the schema-less count-1 fallback -- see docs/design/model.md section
 * 9(1) and src/formats/json.ts's file-top comment).
 *
 * Uses the `yaml` npm package (an optionalDependency for consumers, a
 * devDependency here for testing). Both reading and writing use the
 * `"yaml-1.1"` schema rather than the package's default (`"core"`, YAML
 * 1.2) -- that is the schema whose implicit-scalar resolution matches
 * PyYAML's own `safe_load`/`safe_dump`, which is what the Python port's
 * documented behavior (docs/formats/yaml.md) is pinned to:
 *
 * - an unquoted ISO-8601-looking scalar resolves to a native date/datetime
 *   (Document's `Date`), with no schema needed -- unlike JSON, whose
 *   dates always arrive as plain strings;
 * - a bare `on`/`off`/`yes`/`no` scalar (as a value or a mapping key)
 *   resolves to a boolean -- the YAML 1.1 boolean-coercion quirk the docs
 *   call out (see docs/examples/github-actions.md's `on:` workflow key);
 * - a bare time-of-day (`12:00:00`) resolves to YAML's sexagesimal integer
 *   scalar (`43200`), not a time value -- there is no standalone
 *   "time of day" type in YAML's core schema, so this is the underlying
 *   library's own resolver, not something omnist imposes.
 *
 * Writing a `Date` leaf hands it to the `yaml` package directly (rather
 * than pre-stringifying, the way json.ts's writer does for its ISO-string
 * fallback) -- YAML has a native date/datetime type, so the library's own
 * midnight-vs-full-instant formatting applies, matching PyYAML's
 * `yaml.dump` of a real `datetime.date`/`datetime.datetime` object. Unlike
 * JSON, no `float.special` substitution is needed either: YAML's `.nan`/
 * `.inf`/`-.inf` scalars round-trip NaN/Infinity/-Infinity natively.
 *
 * Document's `time` scalar-kind has no distinct representation at this
 * layer -- src/document.ts's file-top comment: a `time` value is just a
 * plain `string`, indistinguishable from any other string without a
 * schema. So, unlike Python's `check_yaml` (which flags a `datetime.time`
 * leaf as `temporal.stringified`), that adjustment code has nothing to
 * fire on here: there is no way to construct a Document leaf this port
 * would recognize as "a time, not a string" in the first place.
 */

import YAML from "yaml";
import { buildNode, grouped, type Node, type Scalar } from "../document.js";
import { ParseError, WriteError } from "../errors.js";
import { finishWrite, WriteReport } from "../report.js";
import { materialize } from "../deserialize.js";
import type { Schema } from "../schema.js";

// Matches src/document.ts's own MAX_DEPTH (locally redefined here, same as
// src/formats/json.ts's own copy of the same guard constant -- see that
// file for this convention's precedent in this port).
const MAX_DEPTH = 200;

// Matches src/document.ts's own MAX_INT_DIGITS / src/formats/json.ts's own
// copy of the same guard constant (see json.ts's comment for why this
// needs to be checked against the raw source text, not the parsed value:
// by the time YAML.parse hands back a JS `number`, an over-long integer
// literal has already silently become `Infinity`, indistinguishable from a
// genuine `.inf` scalar -- see issue #54).
const MAX_INT_DIGITS = 4300;

/**
 * Scan raw YAML text for a bare integer-shaped token (all digits, no `.`,
 * `e`/`E`, or surrounding letters -- so not a float literal and not part
 * of a larger word) whose digit count exceeds MAX_INT_DIGITS, skipping
 * quoted scalars and comments.
 *
 * This is a heuristic, not a full YAML tokenizer: it does not track block
 * scalar (`|`/`>`) indentation, so an over-long digit run that appears
 * inside literal block-scalar *text* (not a bare integer value) could in
 * principle be misflagged. That mirrors this port's other documented,
 * accepted format-layer gaps (e.g. the YAML "<<" merge-key limitation --
 * docs/formats/yaml.md) rather than a full YAML grammar reimplementation,
 * which is out of scope for this fix (see issue #54's discussion of BigInt
 * threading being out of scope for the same reason).
 */
function checkYamlIntegerDigits(text: string): void {
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text.charAt(i);
    if (c === "#" && (i === 0 || /\s/.test(text.charAt(i - 1)))) {
      while (i < n && text.charAt(i) !== "\n") i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < n && text.charAt(i) !== quote) {
        if (quote === '"' && text.charAt(i) === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === "-" || (c >= "0" && c <= "9")) {
      let j = c === "-" ? i + 1 : i;
      const digitsStart = j;
      while (j < n && text.charAt(j) >= "0" && text.charAt(j) <= "9") j++;
      const digitsLen = j - digitsStart;
      const next = text.charAt(j);
      const isFloat = next === "." || next === "e" || next === "E";
      // Unlike JSON (where a bare digit outside quotes can only ever start
      // a number), YAML plain scalars freely mix letters and digits (an
      // id/hash/token like "abc123..." or "key456"). Only treat this run
      // as a candidate standalone integer literal -- not part of a larger
      // word -- if it's not glued to a word character on either side.
      const isWordChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
      const precededByWord = i > 0 && isWordChar(text.charAt(i - 1));
      const followedByWord = !isFloat && isWordChar(next);
      if (!isFloat && !precededByWord && !followedByWord && digitsLen > MAX_INT_DIGITS) {
        throw new ParseError(
          "invalid YAML: integer literal has more than " +
            String(MAX_INT_DIGITS) +
            " digits, exceeding the digit limit (security: unbounded-digit " +
            "int-to-str conversion is superlinear); matches this port's " +
            "digit cap elsewhere (src/document.ts's MAX_INT_DIGITS) and " +
            "CPython's own int-to-str digit cap",
        );
      }
      i = j;
      continue;
    }
    i++;
  }
}

function checkWriteDepth(depth: number): void {
  // NOT unreachable (issue #37): writeYaml takes a raw `Node`, a publicly
  // exported type -- a caller can hand-build one (or splice a subtree in
  // via Doc.add()/Doc.set()) that exceeds MAX_DEPTH without ever going
  // through buildNode()'s own guard. This branch is a real, exercised
  // backstop, not a dormant one; see test/formats/yaml.test.ts's
  // depth-guard test.
  if (depth > MAX_DEPTH) {
    throw new WriteError("nesting exceeds the maximum depth (" + String(MAX_DEPTH) + ")");
  }
}

/** Yield [path, label, value] for every edge (a leaf value, or undefined
 * for a container), so scanYaml can flag a NEL character in either
 * position -- mirrors formats.py's _scan_yaml_labels. */
function* labeledEdges(
  node: Node,
  path = "$",
  depth = 0,
): Generator<[string, string, Scalar | undefined]> {
  if (Array.isArray(node)) {
    checkWriteDepth(depth);
    const counts = new Map<string, number>();
    for (const { label, target } of node) {
      const i = counts.get(label) ?? 0;
      counts.set(label, i + 1);
      const p = i === 0 ? path + "." + label : path + "." + label + "[" + String(i) + "]";
      yield [p, label, Array.isArray(target) ? undefined : target];
      yield* labeledEdges(target, p, depth + 1);
    }
  }
}

/** Options accepted by readYaml. */
export interface ReadYamlOptions {
  schema?: Schema;
}

/** Parse YAML text into a Document node. */
export function readYaml(text: string, opts: ReadYamlOptions = {}): Node {
  checkYamlIntegerDigits(text);
  let parsed: unknown;
  try {
    parsed = YAML.parse(text, { schema: "yaml-1.1" });
  } catch (exc) {
    // YAML.parse always throws a YAMLError (an Error instance) on malformed
    // input, never a bare value, so the non-Error branch below is a
    // defensive fallback that's never actually reached.
    /* v8 ignore next */
    const message = exc instanceof Error ? exc.message : String(exc);
    throw new ParseError("invalid YAML: " + message);
  }
  const node = buildNode(parsed);
  if (opts.schema === undefined) return node;
  return materialize(node, opts.schema);
}

/** Options accepted by writeYaml. */
export interface WriteYamlOptions {
  strict?: boolean;
  report?: WriteReport;
}

/** Write a Document node as YAML text. */
export function writeYaml(node: Node, opts: WriteYamlOptions = {}): string {
  const { strict = false, report } = opts;
  const rep = scanYaml(node);
  const text = YAML.stringify(grouped(node), {
    schema: "yaml-1.1",
    sortMapEntries: false,
  }) as string;
  return finishWrite(text, rep, report === undefined ? { strict } : { strict, report });
}

/** Report what writing YAML would adjust, without producing output. */
export function checkYaml(node: Node): WriteReport {
  return scanYaml(node);
}

function scanYaml(node: Node): WriteReport {
  const rep = new WriteReport();
  for (const [path, label, value] of labeledEdges(node)) {
    if (label.includes("\x85")) {
      rep.add(
        path,
        "string.line-break-char",
        "label contains U+0085 (NEL); written double-quoted to round-trip correctly",
        "warning",
      );
    }
    if (typeof value === "string" && value.includes("\x85")) {
      rep.add(
        path,
        "string.line-break-char",
        "value contains U+0085 (NEL); written double-quoted to round-trip correctly",
        "warning",
      );
    }
  }
  return rep;
}
