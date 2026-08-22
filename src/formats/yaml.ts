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
 *   call out (see docs/examples/github-actions.md's `on:` workflow key).
 *   Narrowed to match the reference implementation's own resolver
 *   (PyYAML's default `SafeLoader`), which only treats the full-word
 *   aliases -- `on`/`off`/`yes`/`no`/`true`/`false` and their case
 *   variants -- as booleans, NOT the bare single-letter `y`/`Y`/`n`/`N`
 *   that full YAML 1.1 also allows (issue #89's vector 1: `n: 12:00:00`
 *   must keep the plain string label `"n"`, not resolve it to `false`).
 *   `customBoolTags` below narrows the package's default yaml-1.1 bool
 *   tag regexes to this reference-matching set, for both read and write.
 * - when a *mapping key* resolves (under yaml-1.1's implicit-scalar
 *   rules) to anything other than a string -- a boolean via the alias
 *   set above, `null` via `~`/`null`, a number, etc. -- the document is
 *   rejected outright rather than silently stringified to a label
 *   (issue #89's vector 2, the "Norway problem": `on:\n  push: true\n`
 *   must throw, not quietly become the label `"true"`). This falls out
 *   of parsing with `mapAsMap: true` (which preserves each key's
 *   resolved type instead of coercing it to a string the way a plain JS
 *   object's keys always are) and reusing `buildNode`'s existing
 *   non-string-key rejection (`DocumentError`, src/document.ts) --  the
 *   same path JSON's reader would hit for a non-string key, since a Map
 *   with a non-string key is already a case `buildNode` rejects.
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
import { buildNode, grouped, unwrapTimeValues, type Node, type Scalar } from "../document.js";
import { ParseError, WriteError } from "../errors.js";
import { finishWrite, WriteReport } from "../report.js";
import { materialize } from "../deserialize.js";
import type { Schema } from "../schema.js";
import { checkInputSize } from "./input-size.js";

// Matches src/document.ts's own MAX_DEPTH (locally redefined here, same as
// src/formats/json.ts's own copy of the same guard constant -- see that
// file for this convention's precedent in this port).
const MAX_DEPTH = 200;

// Matches src/document.ts's own MAX_INT_DIGITS / src/formats/json.ts's own
// copy of the same guard constant. Needed as a pre-parse text-level check
// for the same reason json.ts/toml.ts need one: since issue #98,
// YAML.parse runs with { intAsBigInt: true } (native support in the yaml
// package), so an over-long integer literal no longer silently overflows
// to `Infinity` -- it would happily become an enormous, exact `bigint`
// instead, unbounded, which is exactly the unbounded-digit int-to-str
// superlinear-conversion risk this cap exists to prevent (see issue #54
// and document.ts's own checkIntDigits).
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

/**
 * Narrow the `yaml` package's default `"yaml-1.1"` boolean tag to match
 * the reference implementation's own resolver (PyYAML's `SafeLoader`),
 * which only recognizes the full-word aliases -- `on`/`off`/`yes`/`no`/
 * `true`/`false` and their case variants -- not the bare `y`/`Y`/`n`/`N`
 * that full YAML 1.1 also treats as boolean (issue #89, vector 1).
 *
 * `customTags` (a `yaml` package option) is called with the schema's
 * default tag list; every tag is passed through unchanged except the two
 * `tag:yaml.org,2002:bool` tags (identified by `identify`, the same way
 * the package itself tells them apart), whose `test` regex is replaced.
 * Everything else about the tag (its `resolve`/`stringify`, its `tag`
 * name) is preserved by spreading the original.
 */
function customBoolTags(tags: YAML.Tags): YAML.Tags {
  return tags.map((tag) => {
    // A Tags entry is either a preset tag name (string, left untouched --
    // yaml-1.1's preset already includes bool by name, so this branch
    // does run in practice) or a full tag object; only the latter can be
    // yaml-1.1's bool tag pair.
    if (typeof tag === "string" || tag.tag !== "tag:yaml.org,2002:bool") {
      return tag;
    }
    // Only ScalarTag ever carries this tag name -- the cast reflects
    // that, since CollectionTag never uses this tag name in practice.
    const boolTag = tag as YAML.ScalarTag;
    // Both of yaml-1.1's bool tags define identify() (that's how the
    // package itself tells its own trueTag/falseTag apart); the
    // assertion documents that this narrowing only ever runs against
    // those two, never a hand-rolled tag missing identify().
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return boolTag.identify!(true)
      ? { ...boolTag, test: /^(?:[Yy]es|YES|[Tt]rue|TRUE|[Oo]n|ON)$/ }
      : { ...boolTag, test: /^(?:[Nn]o|NO|[Ff]alse|FALSE|[Oo]ff|OFF)$/ };
  });
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
/** Options for parsing YAML text into a Document node. */
export interface ReadYamlOptions {
  /** Optional {@link Schema} for schema-directed materialization (spec §4). */
  schema?: Schema;
}

/** Parse YAML text into a Document node. */
export function readYaml(text: string, opts: ReadYamlOptions = {}): Node {
  checkInputSize(text, "YAML");
  checkYamlIntegerDigits(text);
  let parsed: unknown;
  try {
    // mapAsMap preserves each mapping key's own resolved type (so a key
    // that resolves to a boolean under yaml-1.1's implicit-scalar rules
    // arrives as a JS `Map` with an actual `boolean` key) instead of
    // coercing every key to a string the way parsing to a plain JS
    // object always would -- see the file-top comment's second bullet
    // and issue #89's vector 2. buildNode (src/document.ts) already
    // rejects a Map with a non-string key with a DocumentError.
    parsed = YAML.parse(text, { schema: "yaml-1.1", mapAsMap: true, customTags: customBoolTags, intAsBigInt: true });
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
/** Options for serializing a Document node into YAML text. */
export interface WriteYamlOptions {
  /** If true, throws {@link WriteError} if any lossy adjustments are made. */
  strict?: boolean;
  /** Optional {@link WriteReport} accumulator to collect adjustments into. */
  report?: WriteReport;
}

/** Write a Document node as YAML text. */
export function writeYaml(node: Node, opts: WriteYamlOptions = {}): string {
  const { strict = false, report } = opts;
  const rep = scanYaml(node);
  // No native YAML time-literal syntax (issue #96): unwrap any
  // TimeValue leaf to its plain text first, same as a plain string.
  const doc = new YAML.Document(undefined, {
    schema: "yaml-1.1",
    customTags: customBoolTags,
    sortMapEntries: false,
  });
  doc.contents = doc.createNode(grouped(unwrapTimeValues(node))) as never;
  // Force every plain JS `number` scalar (never a bigint -- those are
  // genuinely integer-kinded and stringify bare via the yaml package's
  // own native bigint support) to render with at least one fraction
  // digit, even when whole (e.g. -0 -> "-0.0", not "-0"). Without this,
  // a whole-valued number-kind leaf writes as a bare digit token
  // indistinguishable from an integer, and since issue #98 that reads
  // back as a genuinely different kind (bigint) -- see oml.ts's
  // writeScalar and toml.ts's numbersAsFloat option for the same fix in
  // those two writers. Scoped per-node (via minFractionDigits), not a
  // stringify-wide option like TOML's, since the yaml package exposes
  // this as a Scalar-node property rather than a global stringify flag.
  YAML.visit(doc, {
    Scalar(_key, scalarNode) {
      if (typeof scalarNode.value === "number" && Number.isFinite(scalarNode.value)) {
        scalarNode.minFractionDigits = 1;
      }
    },
  });
  const text = doc.toString() as string;
  return finishWrite(text, rep, report === undefined ? { strict } : { strict, report });
}

/** Report what writing YAML would adjust, without producing output. */
/** Simulates writing a node to YAML without emitting text, returning any lossy adjustments (spec §4). */
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
