/**
 * YAML codec over the canonical Document (edge-list) model. Ported from the
 * YAML section of omnist/formats.py.
 *
 * YAML goes through the same JSON-shaped grouping (grouped()) as JSON --
 * same-label edges collapse into an array, a single occurrence stays bare
 * (the schema-less count-1 fallback -- see omnist-spec Sec7.3, writing,
 * and src/formats/json.ts's file-top comment).
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
import { buildNodeWithLimits, grouped, hasInterleaving, type Node, type Scalar } from "../document.js";
import { isoText, TimeValue, timeText } from "../temporal.js";
import {
  DEFAULT_MAX_DEPTH as MAX_DEPTH,
  digitsExceed,
  OverlongInteger,
  resolveLimits,
  type DocumentLimits,
} from "../limits.js";
import { EdgePaths } from "../paths.js";
import { checkEncodable } from "../encodable.js";
import { ParseError, WriteError } from "../errors.js";
import { finishWrite, WriteReport } from "../report.js";
import { materialize } from "../deserialize.js";
import type { Schema } from "../schema.js";
import { rejectSecondLeadingBom, stripLeadingBom } from "../bom.js";
import { codecSyntaxError, type CodecBlame } from "./codec-error.js";
import { checkInputSize } from "./input-size.js";
import { checkAliasExpansion, resolveMaxAliasExpansion, resolveMaxExpandedSlots } from "./yaml-alias.js";

/**
 * D-9 / D-28: wrap the `yaml` package's integer resolvers so an integer whose
 * value has more than `maxIntDigits` decimal digits is not converted. The
 * conversion of a huge literal to a `bigint` is superlinear in its digit
 * count, which is what the limit bounds; the literal resolves to an
 * {@link OverlongInteger} instead, which the builder refuses at the literal's
 * Document path (E-4a). The count is of the value in decimal, whatever the
 * spelling: a hex, octal or binary literal, an underscore and a leading zero
 * are not digits. Sexagesimal integers (`190:20:30`) are left to the builder's
 * check on the converted value.
 */
function limitIntTags(tags: YAML.Tags, maxIntDigits: number): YAML.Tags {
  const radixOf: Readonly<Record<string, 2 | 8 | 16>> = { BIN: 2, OCT: 8, HEX: 16 };
  return tags.map((tag) => {
    if (typeof tag === "string" || tag.tag !== "tag:yaml.org,2002:int") return tag;
    // Only ScalarTag ever carries this tag name (the same cast as customBoolTags).
    const intTag = tag as YAML.ScalarTag;
    const format = intTag.format;
    if (format === "TIME") return tag;
    const radix = format === undefined ? 10 : (radixOf[format] as 2 | 8 | 16);
    const prefix = radix === 10 ? 0 : radix === 8 ? 1 : 2;
    return {
      ...intTag,
      resolve(str: string, onError: (message: string) => void, options: YAML.ParseOptions): unknown {
        const digits = str.replace(/^[-+]/, "").replace(/_/g, "").slice(prefix);
        return digitsExceed(digits, radix, maxIntDigits) ? new OverlongInteger() : intTag.resolve(str, onError, options);
      },
    };
  });
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

/**
 * A scalar this writer spells itself (E-37, D-29): the `yaml` package would
 * write a `Date` through its timestamp tag (converting to UTC and truncating to
 * milliseconds) and a negative zero without its sign, so these leaves are
 * replaced by a literal whose text is the exact spelling. `quoted` is a
 * double-quoted string (a `time`, which YAML 1.1 has no literal for).
 */
class YamlLiteral {
  readonly text: string;
  readonly quoted: boolean;
  constructor(text: string, quoted: boolean) {
    this.text = text;
    this.quoted = quoted;
  }
}

const literalTag: YAML.ScalarTag = {
  identify: (v) => v instanceof YamlLiteral,
  default: true,
  tag: "tag:yaml.org,2002:str",
  /* v8 ignore next -- write-only tag: the type requires a resolver, a read never selects it */
  resolve: (str) => str,
  stringify: (item) => {
    const lit = item.value as YamlLiteral;
    return lit.quoted ? JSON.stringify(lit.text) : lit.text;
  },
};

function writeTags(tags: YAML.Tags): YAML.Tags {
  return [literalTag, ...customBoolTags(tags)];
}

/** Replace each temporal and negative-zero leaf of a Node tree by a {@link YamlLiteral}. */
function literalize(node: Node, depth = 0): Node {
  if (Array.isArray(node)) {
    checkWriteDepth(depth);
    return node.map(({ label, target }) => ({ label, target: literalize(target, depth + 1) }));
  }
  if (node instanceof Date) return new YamlLiteral(isoText(node), false) as unknown as Node;
  if (node instanceof TimeValue) return new YamlLiteral(timeText(node), true) as unknown as Node;
  if (Object.is(node, -0)) return new YamlLiteral("-0.0", false) as unknown as Node;
  return node;
}

/** The characters YAML 1.1 does not print and PyYAML escapes (C-14), beyond the C0 range the package escapes. */
const UNPRINTABLE = /[\x7f\x80-\x84\x86-\x9f\ufffe\uffff]/;

/**
 * C-17: narrow the `yaml` package's YAML 1.1 number tags to what PyYAML's
 * `SafeLoader` resolves. The package is looser in four ways: a decimal integer
 * may start with `0` (`08` is the string, since only `0` and leading-zero
 * octal `010` are integers), a sexagesimal integer may start with `0` (`0:5`
 * is a string), an exponent needs no point (`1e3` is a string), and an
 * exponent needs a sign (`1.0e3` is a string, `1.0e+3` a number). A float also
 * needs a digit beside its point (`.` alone is a string).
 */
function narrowNumberTags(tags: YAML.Tags): YAML.Tags {
  return tags.map((tag) => {
    const scalar = tag as YAML.ScalarTag; // a preset name (a string) has no .tag and falls through unchanged
    if (scalar.tag === "tag:yaml.org,2002:int") {
      if (scalar.format === undefined) return { ...scalar, test: /^[-+]?(?:0|[1-9][0-9_]*)$/ };
      if (scalar.format === "TIME") return { ...scalar, test: /^[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+$/ };
    } else if (scalar.tag === "tag:yaml.org,2002:float") {
      if (scalar.format === undefined && scalar.test?.test("1.5") === true) {
        return { ...scalar, test: /^[-+]?(?:[0-9][0-9_]*\.[0-9_]*|\.[0-9_]+)$/ };
      }
      if (scalar.format === "EXP") {
        return { ...scalar, test: /^[-+]?(?:[0-9][0-9_]*\.[0-9_]*|\.[0-9_]+)[eE][-+][0-9]+$/ };
      }
    }
    return tag;
  });
}

/**
 * C-12: a merge key contributes its entries first, whatever its position in
 * the mapping, so a `<<` written after an explicit key still puts the merged
 * entries before that mapping's own (an own key overrides a merged value in
 * place). The mapping's merge pairs are moved to the front, in their order.
 */
function hoistMergeKeys(doc: YAML.Document.Parsed): void {
  YAML.visit(doc, {
    Map(_key, map) {
      const isMerge = (p: YAML.Pair): boolean => YAML.isScalar(p.key) && typeof p.key.value === "symbol";
      if (map.items.some(isMerge)) map.items = [...map.items.filter(isMerge), ...map.items.filter((p) => !isMerge(p))];
    },
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
    const paths = new EdgePaths(path, node);
    for (const { label, target } of node) {
      const p = paths.next(label);
      yield [p, label, Array.isArray(target) ? undefined : target];
      yield* labeledEdges(target, p, depth + 1);
    }
  }
}

/** Options accepted by readYaml. */
/** Options for parsing YAML text into a Document node. */
export interface ReadYamlOptions extends DocumentLimits {
  /** Optional {@link Schema} for schema-directed materialization (spec §4). */
  schema?: Schema;
  /**
   * The maximum alias expansion factor (spec D-18, §2.4.1): the ratio of the
   * value slots an anchored node, mapping, or sequence materializes to the
   * slots it is written with. Input over it is rejected with
   * `document.limit.alias-expansion`, before any alias is expanded. Default
   * 50; an integer from 1 to 10000. Zero or negative selects the default
   * (never "no limit"); a larger or non-integer value throws a `RangeError`.
   */
  maxAliasExpansion?: number;
  /**
   * The maximum expanded size (spec D-22, §2.4.1): the value slots one input
   * materializes. An input that contains at least one alias or merge key is
   * rejected with `document.limit.expanded-size` when it materializes more,
   * after the expansion-factor check and before any alias is expanded; an
   * input with neither is exempt however large. Default 1 000 000; an integer
   * from 1 to 10 000 000. Zero or negative selects the default (never "no
   * limit"); a larger or non-integer value throws a `RangeError`.
   */
  maxExpandedSlots?: number;
  /**
   * The largest input, in UTF-8 bytes, that is read at all (spec D-23,
   * Sec2.4.2): a larger input is refused with `document.limit.input-size` at
   * `$` before it is decoded or parsed; one of exactly this size is accepted.
   * A leading byte-order mark counts. Default 64 MiB; an integer of at least
   * 1, else a `RangeError`.
   */
  maxInputBytes?: number;
}

/** Turn a failure from the `yaml` package into the `parse.codec-syntax` error. */
function yamlSyntaxError(exc: unknown, text: string): ParseError {
  // The library always throws an Error instance (a YAMLParseError, or a
  // ReferenceError), never a bare value, so the non-Error branch below is a
  // defensive fallback that's never actually reached. (A malformed merge
  // value and an unresolved alias are caught earlier, with a position, by the
  // shape pass in yaml-alias.ts.)
  /* v8 ignore next */
  const message = exc instanceof Error ? exc.message : String(exc);
  // A YAMLParseError carries `pos: [start, end]` (UTF-16 offsets into the
  // text). Anything else the library throws names no position: 1:1.
  const pos = (exc as { pos?: unknown }).pos;
  const at: CodecBlame = Array.isArray(pos) && typeof pos[0] === "number" ? { offset: pos[0] } : undefined;
  return codecSyntaxError("YAML", message.split(String.fromCharCode(10))[0] as string, text, at);
}

/**
 * The library's own duplicate-key check (`DUPLICATE_KEY`, "Map keys must be
 * unique") compares each key with every key before it, so it is quadratic in
 * the keys of one mapping: 10,000 keys cost seconds and 50,000 minutes, a
 * denial of service the input-size cap does not bound (issue #157). A parse
 * therefore runs with the check off, and {@link findDuplicateKey} does the
 * same test in one linear pass.
 */
function parseYamlDocument(
  text: string,
  uniqueKeys: boolean,
  maxIntDigits: number,
  lineCounter?: YAML.LineCounter,
): YAML.Document.Parsed {
  return YAML.parseDocument(text, {
    schema: "yaml-1.1",
    customTags: (tags) => limitIntTags(narrowNumberTags(customBoolTags(tags)), maxIntDigits),
    intAsBigInt: true,
    uniqueKeys,
    ...(lineCounter === undefined ? {} : { lineCounter }),
  });
}

/** The budget for re-parsing a document that has a duplicate key with the
 * library's own (quadratic) check, so the error is exactly the library's: the
 * sum over the document's mappings of keys squared, within that of one
 * mapping of 4,096 keys (about half a second). A document over the budget --
 * one huge mapping, or many large ones -- is reported from the linear scan
 * instead, so the total re-parse cost is bounded however the keys are spread. */
const EXACT_DUPLICATE_ERROR_BUDGET = 4096 * 4096;

interface DuplicateKey {
  /** The offsets of the earliest-in-the-text duplicate key. */
  start: number;
  end: number;
  /** The sum over every mapping in the document of its keys squared. */
  cost: number;
}

/**
 * Finds a duplicate mapping key in one linear pass over every mapping, with
 * the library's own equality: two scalar keys are the same when their
 * resolved values are `===` (so `1` and `"1"` differ, as do two `NaN`s); a
 * non-scalar key is never equal to another. Returns the earliest duplicate in
 * the text, or undefined when there is none.
 */
function findDuplicateKey(doc: YAML.Document.Parsed): DuplicateKey | undefined {
  let found: { start: number; end: number } | undefined;
  let cost = 0;
  YAML.visit(doc, {
    Map(_key, map) {
      cost += map.items.length * map.items.length;
      const seen = new Set<unknown>();
      for (const pair of map.items) {
        const k = pair.key;
        if (!YAML.isScalar(k)) continue;
        const v = k.value;
        // Set uses SameValueZero, which differs from `===` only for NaN.
        if (Number.isNaN(v)) continue;
        if (seen.has(v)) {
          const [start, end] = k.range as [number, number, number];
          if (found === undefined || start < found.start) found = { start, end };
          return;
        }
        seen.add(v);
      }
    },
  });
  return found === undefined ? undefined : { ...found, cost };
}

/** The error for a duplicate key found by {@link findDuplicateKey}, or the
 * library's first error when that comes earlier in the text. */
function duplicateKeyError(
  lineCounter: YAML.LineCounter,
  start: number,
  end: number,
  first: YAML.YAMLError | undefined,
): Error {
  if (first !== undefined && first.pos[0] < start) return first;
  const { line, col } = lineCounter.linePos(start);
  const message = "Map keys must be unique at line " + String(line) + ", column " + String(col) + ":";
  return new YAML.YAMLParseError([start, end], "DUPLICATE_KEY", message);
}

/** The YAML 1.1 collection tags outside the supported profile (spec C-13). */
const FORBIDDEN_TAGS: ReadonlySet<string> = new Set([
  "tag:yaml.org,2002:omap",
  "tag:yaml.org,2002:pairs",
  "tag:yaml.org,2002:set",
]);

/**
 * C-13: a node tagged `!!omap`, `!!pairs` or `!!set` is well-formed YAML that
 * the Document model has no shape for (an ordered map of single-key maps, a
 * list of key/value pairs, a set); it is refused, as `format.tag-forbidden`
 * at `$`, not read as the plain collection it resembles.
 */
function rejectForbiddenTags(doc: YAML.Document.Parsed): void {
  YAML.visit(doc, {
    Collection(_key, node) {
      if (node.tag !== undefined && FORBIDDEN_TAGS.has(node.tag)) {
        const name = "!!" + node.tag.slice("tag:yaml.org,2002:".length);
        throw new ParseError(
          "YAML tag " + name + " is outside the supported profile and is refused",
          [],
          "format.tag-forbidden",
          "$",
        );
      }
    },
  });
}

/**
 * D-27: only an untagged (or `!!merge`-tagged) plain `<<` is the merge key;
 * `!!str <<` is the ordinary string key `"<<"`. The package treats any plain
 * `<<` as a merge key whatever its tag, so a plain scalar key that resolved to
 * the string `<<` (which only an explicit `!!str` can do) is marked quoted,
 * which the package reads as an ordinary key.
 */
function makeStringMergeKeysOrdinary(doc: YAML.Document.Parsed): void {
  YAML.visit(doc, {
    Pair(_key, pair) {
      const k = pair.key;
      if (YAML.isScalar(k) && k.type === "PLAIN" && k.value === "<<") k.type = "QUOTE_DOUBLE";
    },
  });
}

/** Parse YAML text into a Document node. */
export function readYaml(text: string, opts: ReadYamlOptions = {}): Node {
  const limits = resolveLimits(opts);
  const maxAliasExpansion = resolveMaxAliasExpansion(opts.maxAliasExpansion);
  const maxExpandedSlots = resolveMaxExpandedSlots(opts.maxExpandedSlots);
  checkInputSize(text, opts.maxInputBytes); // D-23: first, the BOM's bytes counted
  text = stripLeadingBom(text); // D-15: one leading U+FEFF
  rejectSecondLeadingBom(text, "YAML"); // D-21: a second one is an error
  // Parse to the library's Document AST, which keeps Alias nodes, so the
  // D-18/D-22 checks can run on the reference graph BEFORE anything is expanded.
  let doc: YAML.Document.Parsed;
  try {
    const lineCounter = new YAML.LineCounter();
    doc = parseYamlDocument(text, false, limits.maxIntDigits, lineCounter);
    const dup = findDuplicateKey(doc);
    if (dup !== undefined) {
      if (dup.cost <= EXACT_DUPLICATE_ERROR_BUDGET) {
        // The library's own check, with its own error ordering and position:
        // quadratic in the keys of one mapping, so only within the budget.
        doc = parseYamlDocument(text, true, limits.maxIntDigits);
      } else {
        // Too much quadratic work to repeat: report the duplicate from the
        // linear scan, at the duplicate key's own position.
        throw duplicateKeyError(lineCounter, dup.start, dup.end, doc.errors[0]);
      }
    }
    // What YAML.parse itself does with a failed parse: throw the first error.
    if (doc.errors.length > 0) throw doc.errors[0];
  } catch (exc) {
    throw yamlSyntaxError(exc, text);
  }
  rejectForbiddenTags(doc);
  makeStringMergeKeysOrdinary(doc);
  hoistMergeKeys(doc);
  checkAliasExpansion(doc.contents, maxAliasExpansion, text, maxExpandedSlots);
  let parsed: unknown;
  try {
    // mapAsMap preserves each mapping key's own resolved type (so a key
    // that resolves to a boolean under yaml-1.1's implicit-scalar rules
    // arrives as a JS `Map` with an actual `boolean` key) instead of
    // coercing every key to a string the way parsing to a plain JS
    // object always would -- see the file-top comment's second bullet
    // and issue #89's vector 2. buildNode (src/document.ts) already
    // rejects a Map with a non-string key with a DocumentError.
    // maxAliasCount: -1 switches off the library's own alias guard (a
    // count against a fixed 100 that would pre-empt the D-18 check above
    // with a bare codec-syntax error); the D-18/D-22 checks have already
    // bounded the expansion, so the library's guard has nothing left to do.
    parsed = doc.toJS({ mapAsMap: true, maxAliasCount: -1 });
  } catch (exc) {
    throw yamlSyntaxError(exc, text);
  }
  const node = buildNodeWithLimits(parsed, limits);
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
    customTags: writeTags,
    sortMapEntries: false,
  });
  doc.contents = doc.createNode(grouped(literalize(node))) as never;
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
      } else if (typeof scalarNode.value === "string" && UNPRINTABLE.test(scalarNode.value)) {
        scalarNode.type = "QUOTE_DOUBLE";
      }
    },
  });
  // E-34: YAML 1.1 folds a raw U+0085 inside a scalar as a line break. Every
  // scalar holding one is written double-quoted, where the escape `\N` is the
  // one spelling that reads back as the single character.
  // C-14: the other unprintable characters are escaped the way PyYAML does,
  // lowercase hex, inside the double-quoted scalars the visit above forced.
  const text = (doc.toString() as string)
    .split("\x85")
    .join("\\N")
    .replace(/[\x7f\x80-\x9f]/g, (c) => "\\x" + (c.codePointAt(0) as number).toString(16).padStart(2, "0"))
    .replace(/[\ufffe\uffff]/g, (c) => "\\u" + (c.codePointAt(0) as number).toString(16));
  return finishWrite(text, rep, report === undefined ? { strict } : { strict, report });
}

/** Report what writing YAML would adjust, without producing output. */
/** Simulates writing a node to YAML without emitting text, returning any lossy adjustments (spec §4). */
export function checkYaml(node: Node): WriteReport {
  return scanYaml(node);
}

function scanYaml(node: Node): WriteReport {
  checkEncodable(node); // C-9, unconditional: a string with no UTF-8 encoding
  const rep = new WriteReport();
  for (const [path, label, value] of labeledEdges(node)) {
    if (label.includes("\x85")) {
      rep.add(
        path,
        "format.string-line-break-char",
        "label contains U+0085 (NEL); written double-quoted to round-trip correctly",
        "warning",
      );
    }
    if (value instanceof TimeValue) {
      rep.add(path, "format.temporal-stringified", "YAML has no time-of-day literal; written as a string", "warning");
    }
    if (typeof value === "string" && value.includes("\x85")) {
      rep.add(
        path,
        "format.string-line-break-char",
        "value contains U+0085 (NEL); written double-quoted to round-trip correctly",
        "warning",
      );
    }
  }
  // Sec8.3.8/D-3 (issue #123): same grouping rule as JSON's (grouped(),
  // document.ts) -- YAML mappings collapse same-label edges regardless of
  // position, so genuine cross-label interleaving is lost unless reported.
  if (hasInterleaving(node)) {
    rep.add("$", "format.interleaving-lost", "cross-label interleaving lost: YAML's grouping rule collapses same-label edges together regardless of position", "warning");
  }
  return rep;
}
