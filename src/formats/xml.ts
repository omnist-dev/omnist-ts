/**
 * XML codec over the canonical Document (edge-list) model. Ported from the
 * XML section of omnist/formats.py.
 *
 * A deliberately narrow **data-XML** profile: elements only (no attributes,
 * no CDATA distinction, mixed content rejected). XML has exactly one
 * top-level element, so an XML Document always has a single top-level edge
 * -- see docs/formats/xml.md ("Single document element").
 *
 * ## Security: XXE / entity-expansion (SECURITY SENSITIVE -- read before editing)
 *
 * Python's port hard-requires `defusedxml` for `read_xml` specifically to
 * avoid XXE (XML External Entity) and entity-expansion ("billion laughs")
 * attacks -- see SECURITY.md and docs/formats/xml.md. `fast-xml-parser`
 * (the parser this module uses) is safe *by construction*, not by opt-in
 * configuration, which is why no extra hardening flags are needed here:
 *
 * - External entities (`<!ENTITY x SYSTEM "...">`) always throw --
 *   `DocTypeReader.readEntityExp` rejects the `SYSTEM` keyword
 *   unconditionally, regardless of any option. There is no code path in
 *   the library that ever fetches a URL or a local file while parsing.
 * - Parameter entities (`<!ENTITY % x "...">`, used in the classic
 *   "billion laughs" DTD trick to force exponential expansion) are
 *   likewise always rejected -- same function, unconditional `%` check.
 * - Only *internal* entities (`<!ENTITY x "literal text">`) are supported,
 *   and each one is capped by `maxEntitySize` (10000 chars by default,
 *   left at its default here) -- so even a chain of internal-entity
 *   references can't blow up into gigabytes of text.
 * - The library's own nested-tag counter (`maxNestedTags`) means a
 *   maliciously deep document fails inside the parser's own iterative
 *   (non-recursive) scan loop, not by exhausting the JS call stack.
 *
 * This was verified directly against the installed fast-xml-parser source
 * (`node_modules/fast-xml-parser/src/xmlparser/DocTypeReader.js`) and with
 * manual probes of a classic `SYSTEM`-entity XXE payload and a nested
 * "billion laughs" payload -- both fail closed. `test/formats/xml.test.ts`
 * ("XXE / entity-expansion safety") encodes the same payloads as
 * regression tests.
 *
 * `maxNestedTags` is raised well past this module's own MAX_DEPTH (200) so
 * that a legitimate 200-level document parses through PARSER.parse();
 * `readXml`'s own depth guard (mirroring `build_node`'s) is what actually
 * enforces the 200-level limit, exactly as `_xml_to_node` does in the
 * Python port. `XMLValidator.validate` (used up front to fail closed on
 * malformed XML -- unclosed tags, multiple document elements, etc.) has no
 * nesting-depth limit of its own to worry about; only the parser's
 * `maxNestedTags` matters here.
 */

import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { Edge, Node, Scalar } from "../document.js";
import {
  DEFAULT_MAX_DEPTH as MAX_DEPTH,
  depthIssue,
  digitsExceed,
  intDigitsIssue,
  nodesIssue,
  resolveLimits,
  type DocumentLimits,
  type LimitIssue,
  type ResolvedLimits,
} from "../limits.js";
import { childPath as edgePath, EdgePaths } from "../paths.js";
import { checkEncodable } from "../encodable.js";
import { isoText, TimeValue, timeText } from "../temporal.js";
import { DocumentError, ParseError, WriteError } from "../errors.js";
import { finishWrite, WriteReport } from "../report.js";
import { materialize } from "../deserialize.js";
import { recordField, type FieldType, type Schema, type ScalarType } from "../schema.js";
import { rejectSecondLeadingBom, stripLeadingBom } from "../bom.js";
import { codecSyntaxError } from "./codec-error.js";
import { checkInputSize } from "./input-size.js";

// The three safety limits (D-9) are limits.ts's. xmlToNode builds its edge
// tree directly rather than going through buildNode(), so it keeps its own
// running node count, threaded like `depth` is, under the same rules as
// buildNode (levels of nodes, the root being level 1; the root counts as a
// node). The schema-directed integer path (xmlPretypeScalar, below) checks the
// digit count on the text before BigInt() runs, since BigInt(text) is
// superlinear in the digit count.

function limitError(issue: LimitIssue): DocumentError {
  return new DocumentError(issue.message, issue.code, issue.path);
}

const PARSER_MAX_NESTED_TAGS = 100000;

const XML_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

// XML 1.0 only legally permits tab, LF, CR, and U+0020-U+D7FF,
// U+E000-U+FFFD, U+10000-U+10FFFF in character data. Built as a RegExp
// from an ASCII-only string (\x/\u escapes) rather than a literal with raw
// control/surrogate characters pasted into this file, matching the Python
// port's codepoint-range convention for _XML_ILLEGAL_RANGES.
// A surrogate is illegal only when LONE: a valid pair is an astral character
// (U+10000-U+10FFFF), which XML permits; the earlier blanket
// \uD800-\uDFFF range refused every astral character (found by C-9's
// "a valid pair still writes" test).
const XML_ILLEGAL_CHAR = new RegExp(
  "[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\uFFFE\\uFFFF]" +
    "|[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])" +
    "|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]",
);
// g-flagged twin of XML_ILLEGAL_CHAR, derived from .source so the two can
// never drift. .replace() needs the g flag to substitute every match, not
// just the first; kept separate from XML_ILLEGAL_CHAR (used with .test() in
// scanXmlNode) because a g-flagged regex used with .test() carries a
// stateful lastIndex that would silently skip matches across repeated calls.
const XML_ILLEGAL_CHAR_G = new RegExp(XML_ILLEGAL_CHAR.source, "g");

// C-16: entities are decoded exactly once, in a single pass over the raw text.
// The parser runs with `processEntities: false` (it would decode the five
// predefined entities itself, and a second pass for the numeric references
// would then re-read `&amp;#65;` as `A`), so this one pass is the only
// decoding. The five predefined entities and the two numeric forms XML defines
// (decimal `&#NNN;` and hexadecimal `&#xHHH;`, lowercase `x`) are replaced by
// the character they name and the result is never scanned again; this is also
// what lets writeXml's `&#13;` escape round-trip. Anything else was refused
// earlier (assertXmlCharacters, refuseOutOfProfile), so every reference
// reaching here is one of these and names a character of XML 1.0's `Char`.
const XML_REFERENCE = /&(?:(lt|gt|amp|quot|apos)|#([0-9]+)|#x([0-9A-Fa-f]+));/g;
const PREDEFINED_CHAR: Readonly<Record<string, string>> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decodeReferences(text: string): string {
  return text.replace(
    XML_REFERENCE,
    (_m, name: string | undefined, dec: string | undefined, hex: string | undefined) =>
      name !== undefined
        ? (PREDEFINED_CHAR[name] as string)
        : String.fromCodePoint(Number.parseInt((dec ?? hex) as string, dec !== undefined ? 10 : 16)),
  );
}

/** True if `cp` is a code point of XML 1.0's `Char` production. */
function isXmlChar(cp: number): boolean {
  return (
    cp === 0x9 || cp === 0xa || cp === 0xd || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

const CHAR_REFERENCE = /&#(?:([0-9]+)|x([0-9A-Fa-f]+));/y;

/**
 * C-16: text holds only XML 1.0 `Char`s, and a numeric character reference is
 * well-formed and names one. Both are `parse.codec-syntax`, at the offending
 * position. The character check covers the whole input (text, CDATA, attribute
 * values, comments, processing instructions, names); the reference check skips
 * the inert sections (a comment, CDATA section or processing instruction holds
 * its `&#` as literal text).
 */
function assertXmlCharacters(text: string): void {
  const bad = XML_ILLEGAL_CHAR.exec(text);
  if (bad !== null) {
    throw codecSyntaxError("XML", "character outside the XML 1.0 Char production", text, { offset: bad.index });
  }
  const live = text.replace(XML_INERT, (m) => m.replace(/[^\n]/g, " "));
  for (let at = live.indexOf("&#"); at !== -1; at = live.indexOf("&#", at + 2)) {
    CHAR_REFERENCE.lastIndex = at;
    const m = CHAR_REFERENCE.exec(live);
    if (m === null) {
      throw codecSyntaxError("XML", "malformed character reference", text, { offset: at });
    }
    const dec = m[1];
    const digits = (dec ?? m[2]) as string;
    // A value too long to be a code point is out of range without being parsed.
    const cp = digits.replace(/^0+/, "").length > 8 ? Infinity : Number.parseInt(digits, dec !== undefined ? 10 : 16);
    if (!isXmlChar(cp)) {
      throw codecSyntaxError("XML", "character reference to a character outside the XML 1.0 Char production", text, { offset: at });
    }
  }
}

// fast-xml-parser 5.x (GHSA-gh4j-gqv2-49f6) added a second, *configurable*
// prototype-pollution guard beyond the hard-rejected __proto__/constructor/
// prototype trio (see the "prototype-pollution hardening" tests below): by
// default it silently renames an element named hasOwnProperty, toString,
// valueOf, __defineGetter__/__defineSetter__/__lookupGetter__/
// __lookupSetter__ by prefixing it with "__" (OptionsBuilder.js's
// defaultOnDangerousProperty). That protection exists for the library's
// non-preserveOrder mode, where a parsed tag name can become a raw object
// property key. This module always parses with preserveOrder: true, so a
// tag name only ever ends up as a plain string value inside an array entry
// -- never as a live property key on an object this module or its callers
// touch -- making the rename unnecessary here and, left enabled, a silent
// data-corrupting relabeling (readXml(writeXml(doc)) would return a
// different label than it was given). Disabled by returning the name
// unchanged; verified this doesn't reopen a real pollution path via this
// file's own "does not pollute Object.prototype" tests below.
// ignoreAttributes was `true` until issue #123 (D-3): omnist-spec Sec8.3.8
// now requires readXml to REPORT a dropped attribute (format.attribute-
// dropped) rather than silently discard it, which means the parser has to
// hand attributes back at all. With preserveOrder: true, an element's
// attributes surface as a sibling ":@" key on that element's own object
// (e.g. `{ a: [...children], ":@": { "@_x": "1" } }`) -- verified directly
// against the installed fast-xml-parser -- never as a live object property
// keyed by the attribute's own name, so this still can't reopen the
// prototype-pollution surface onDangerousProperty guards against below.
// Attribute *values* are never used for anything (the data-XML profile has
// nowhere to put them) -- only whether ":@" is present/non-empty, to decide
// whether to emit the diagnostic -- so parseAttributeValue is left at its
// default (raw text, no coercion).
const PARSER = new XMLParser({
  preserveOrder: true,
  trimValues: false,
  parseTagValue: false,
  ignoreAttributes: false,
  processEntities: false,
  cdataPropName: "#cdata",
  maxNestedTags: PARSER_MAX_NESTED_TAGS,
  onDangerousProperty: (name: string) => name,
});

type XmlEntry = Record<string, unknown>;

function checkWriteDepth(depth: number): void {
  // NOT unreachable (issue #37): writeXml takes a raw `Node`, a publicly
  // exported type -- a caller can hand-build one (or splice a subtree in
  // via Doc.add()/Doc.set()) that exceeds MAX_DEPTH without ever going
  // through buildNode()'s own guard. This branch is a real, exercised
  // backstop, not a dormant one; see test/formats/xml.test.ts's
  // depth-guard test.
  if (depth > MAX_DEPTH) {
    throw new WriteError("nesting exceeds the maximum depth (" + String(MAX_DEPTH) + ")");
  }
}

/** Options for parsing XML text into a Document node. */
export interface ReadXmlOptions extends DocumentLimits {
  /** Optional {@link Schema} for schema-directed materialization (spec §4). */
  schema?: Schema;
  /** Optional {@link WriteReport} accumulator to collect read-time codec
   * diagnostics into (issue #123/D-3): `format.attribute-dropped` and
   * `format.namespace-dropped`, one per element an attribute or a
   * namespace prefix was discarded from. Reused from write.ts's
   * WriteReport rather than a parallel "ReadReport" type -- both are the
   * same shape (path/code/message/severity), and this is the only reader
   * in the port that has anything to report yet. */
  report?: WriteReport;
  /**
   * The largest input, in UTF-8 bytes, that is read at all (spec D-23,
   * Sec2.4.2): a larger input is refused with `document.limit.input-size` at
   * `$` before it is decoded or parsed; one of exactly this size is accepted.
   * A leading byte-order mark counts. Default 64 MiB; an integer of at least
   * 1, else a `RangeError`.
   */
  maxInputBytes?: number;
}

// Data-XML profile (docs/formats/xml.md): a DOCTYPE declaration of any kind,
// and any entity reference other than the five predefined ones, MUST fail
// the read -- on sight, not on use. Comments, CDATA sections and processing
// instructions are stripped first: a `<!DOCTYPE` or `&name;` inside one is
// inert text, not a declaration or a reference. Numeric character
// references (`&#13;`, `&#xD;`) are character references, not entity
// references, and stay legal (decodeReferences handles them).
const XML_INERT = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>/g;
const PREDEFINED_ENTITIES = new Set(["lt", "gt", "amp", "quot", "apos"]);
const ENTITY_REF = /&([^#;\s&<][^;\s&<]*);/g;

function refuseOutOfProfile(text: string): void {
  const live = text.replace(XML_INERT, "");
  if (live.includes("<!DOCTYPE")) {
    throw new ParseError(
      "XML DOCTYPE declaration is outside the data-XML profile and is refused",
      [],
      "format.dtd-forbidden",
      "$",
    );
  }
  for (const m of live.matchAll(ENTITY_REF)) {
    if (!PREDEFINED_ENTITIES.has(m[1] as string)) {
      throw new ParseError(
        `XML entity reference &${m[1] as string}; is outside the data-XML profile and is refused`,
        [],
        "format.entity-forbidden",
        "$",
      );
    }
  }
}

// A data-XML profile refusal (docs/formats/xml.md; spec Sec8.3.8 E-7): the input
// is well-formed XML that Omnist declines, not a syntax error. Carries the
// spec code and the whole-input path `$` the vectors pin (no Document
// exists to descend into once a read is refused); `where` names the element
// in the message only.
function mixedContentError(where: string): ParseError {
  return new ParseError(
    where + ": mixed content (text alongside child elements) is outside the data-XML profile",
    [],
    "format.mixed-content",
    "$",
  );
}

/** Parses XML text into a Document node (spec §4). */
export function readXml(text: string, opts: ReadXmlOptions = {}): Node {
  const limits = resolveLimits(opts);
  checkInputSize(text, opts.maxInputBytes); // D-23: first, the BOM's bytes counted
  text = stripLeadingBom(text); // D-15: one leading U+FEFF
  rejectSecondLeadingBom(text, "XML"); // D-21: a second one is an error
  // Well-formedness FIRST: malformed input is a syntax error
  // (parse.codec-syntax) even when it also contains a DOCTYPE or an entity
  // reference; only well-formed XML can be a profile *refusal* (docs/formats/
  // xml.md: "Every document above is well-formed XML"; E-24). Verified:
  // fast-xml-parser's validator treats a DOCTYPE and an undeclared entity
  // reference (`<r>&foo;</r>`) as well-formed, so it does not pre-empt the
  // refusal below, and it rejects `<r><a>&foo;</a>` (unclosed) on its own.
  let valid: ReturnType<typeof XMLValidator.validate>;
  try {
    valid = XMLValidator.validate(text);
  } catch (exc) {
    // The validator matches an attribute with a backtracking regex, which
    // exhausts the call stack on a value of about 5 MB or more (the size
    // depends on the stack already in use). That is a limit of the reader, not
    // a malformed document: refuse it with a coded diagnostic instead of
    // letting a RangeError escape.
    /* v8 ignore else -- the validator throws nothing but a stack overflow */
    if (exc instanceof RangeError) {
      throw codecSyntaxError("XML", "an attribute value is too long for this reader to validate", text);
    }
    /* v8 ignore next */
    throw exc;
  }
  if (valid !== true) {
    // The validator reports a 1-based `line` (and usually `col`, UTF-16 units).
    throw codecSyntaxError("XML", valid.err.msg, text, { line: valid.err.line, col: valid.err.col });
  }
  assertXmlCharacters(text);
  refuseOutOfProfile(text);
  // The depth limit is enforced here, on the text, in one linear pass: the
  // parser's own cost grows faster than linearly with the nesting depth (a
  // 100,000-deep document took minutes to parse before this check), so a
  // document past the limit must never reach it.
  if (xmlNestingExceeds(text, limits.maxDepth)) {
    throw limitError(depthIssue(limits.maxDepth));
  }
  let parsed: XmlEntry[];
  try {
    parsed = PARSER.parse(text) as XmlEntry[];
  } catch (exc) {
    /* v8 ignore next */
    const message = exc instanceof Error ? exc.message : String(exc);
    throw codecSyntaxError("XML", message, text);
  }
  // fast-xml-parser's preserveOrder output keeps top-level non-element
  // nodes alongside the real root: an XML declaration ("<?xml ...?>")
  // surfaces as its own top-level entry keyed "?xml" (verified empirically
  // -- this was previously assumed unreachable and was wrong: any ordinary
  // XML document with a standard declaration hit this and threw). Comments
  // are already dropped by the parser itself with these options. Filter out
  // processing-instruction entries (key starting with "?") before counting
  // roots, so a standard "<?xml version="1.0"?>" prologue -- present on
  // effectively all real-world XML -- doesn't get miscounted as a second
  // document element.
  const roots = parsed.filter(
    (e) => !isTextEntry(e) && Object.keys(e).length > 0 && !Object.keys(e)[0]?.startsWith("?"),
  );
  // Several top-level elements (`<a/><b/>`) validate as true under
  // fast-xml-parser but are not well-formed XML: a syntax error, with no
  // position from the library (E-31: 1:1).
  if (roots.length !== 1) {
    throw codecSyntaxError("XML", "expected exactly one document element", text);
  }
  const root = roots[0] as XmlEntry;
  const tag = tagKeyOf(root);
  const rootLabel = local(tag);
  const rootPath = "$." + rootLabel;
  reportDroppedAttributesAndNamespace(root, tag, rootPath, opts.report);
  // The Document root (the node holding the one element edge) is the first node.
  const nodeCounter = { count: 1 };
  const node: Node = [
    { label: rootLabel, target: xmlToNode(root[tag] as XmlEntry[], rootPath, 0, nodeCounter, opts.report, limits) },
  ];
  if (opts.schema === undefined) return node;
  const pretyped = xmlPretype(node, opts.schema, opts.schema.root, "$", limits.maxIntDigits);
  return materialize(pretyped, opts.schema) as Node;
}

/**
 * True when the element nesting of well-formed XML `text` is deeper than the
 * depth limit allows: an element with element children at nesting `e` (the
 * document element is 1) is a node at level `e + 1`, so a document is refused
 * when its elements nest more than `maxDepth` deep. One pass over the text,
 * no recursion and no allocation proportional to the depth, stopping at the
 * first excess. Comments, CDATA sections and processing instructions are
 * skipped, and `>` inside a quoted attribute value does not end a tag. The
 * text has already been validated, so it is well-formed here.
 */
function xmlNestingExceeds(text: string, maxDepth: number): boolean {
  let depth = 0;
  const n = text.length;
  let i = text.indexOf("<");
  while (i !== -1 && i < n) {
    let next: number;
    if (text.startsWith("<!--", i)) {
      next = text.indexOf("-->", i + 4);
    } else if (text.startsWith("<![CDATA[", i)) {
      next = text.indexOf("]]>", i + 9);
    } else if (text.startsWith("<?", i)) {
      next = text.indexOf("?>", i + 2);
    } else if (text.startsWith("</", i)) {
      depth--;
      next = text.indexOf(">", i + 2);
    } else {
      // A start tag: find the `>` that ends it, outside any quoted value.
      let j = i + 1;
      let quote = "";
      for (; j < n; j++) {
        const c = text.charAt(j);
        if (quote !== "") {
          if (c === quote) quote = "";
        } else if (c === '"' || c === "'") {
          quote = c;
        } else if (c === ">") {
          break;
        }
      }
      if (text.charAt(j - 1) !== "/") {
        depth++;
        if (depth > maxDepth) return true;
      }
      next = j;
    }
    /* v8 ignore next -- the text is validated, so every construct is closed */
    if (next === -1) return false;
    i = text.indexOf("<", next + 1);
  }
  return false;
}

/** True for a character-data entry of a preserveOrder element: text, or a CDATA section. */
function isTextEntry(entry: XmlEntry): boolean {
  return "#text" in entry || "#cdata" in entry;
}

/** The characters of a character-data entry: text has its references decoded (once), a CDATA section is literal. */
function textOfEntry(entry: XmlEntry): string {
  if ("#text" in entry) return decodeReferences(String(entry["#text"]));
  return String(((entry["#cdata"] as XmlEntry[])[0] as XmlEntry)["#text"]);
}

/** The element's own tag key inside a preserveOrder entry object -- the
 * one key that isn't ":@" (attributes) or "#text". */
function tagKeyOf(entry: XmlEntry): string {
  // v8 ignore next -- every entry reaching this helper (the document root,
  // or a non-#text entry inside xmlToNode's loop) always has a real tag
  // key; XMLValidator.validate/the parser itself reject a bare ":@" with
  // no element.
  /* v8 ignore next */
  return (Object.keys(entry).find((k) => k !== ":@") ?? "") as string;
}

/** Reports `format.attribute-dropped` / `format.namespace-dropped`
 * (Sec8.3.8, issue #123/D-3) for one parsed element, if `report` is given.
 * `path` is the element's own Document path -- the same convention
 * `format.float-special` uses for the value it substituted (Sec8.3.8's
 * comment on the attribute-dropped vector). Attributes are discarded
 * unconditionally by this reader (the data-XML profile has no
 * attribute-carrying place in the Document model); a namespace prefix is
 * discarded by `local()` the same way, both silently before this issue. */
function reportDroppedAttributesAndNamespace(
  entry: XmlEntry,
  tag: string,
  path: string,
  report: WriteReport | undefined,
): void {
  if (report === undefined) return;
  if (tag.includes(":")) {
    report.add(
      path,
      "format.namespace-dropped",
      "namespace prefix discarded on read; the element reads as its local name only",
      "warning",
    );
  }
  const attrs = entry[":@"];
  if (attrs !== undefined && typeof attrs === "object" && attrs !== null && Object.keys(attrs).length > 0) {
    report.add(path, "format.attribute-dropped", "XML attribute(s) discarded on read", "warning");
  }
}

function xmlToNode(
  entries: XmlEntry[],
  path: string,
  depth: number,
  counter: { count: number },
  report: WriteReport | undefined,
  limits: ResolvedLimits,
): Node {
  const elementEntries = entries.filter((e) => !isTextEntry(e));
  if (elementEntries.length === 0) {
    return entries.map(textOfEntry).join("");
  }
  // Only an actual node (an edge list -- spec section 2.2 `node = [ edge, ... ]`)
  // counts against MAX_NODES; a scalar leaf's target is a `value`,
  // categorically distinct from `node`, and must not be counted (issue #107).
  // A node at `depth` (the first element's being 0) is level depth + 2 of the
  // nesting: the Document root is level 1.
  /* v8 ignore start -- unreachable: readXml has refused a document nested past
   * maxDepth (xmlNestingExceeds) before this walk starts. Kept as the walk's own
   * guard, since it is recursive. */
  if (depth + 2 > limits.maxDepth) {
    throw limitError(depthIssue(limits.maxDepth));
  }
  /* v8 ignore stop */
  counter.count++;
  if (counter.count > limits.maxNodes) {
    throw limitError(nodesIssue(limits.maxNodes));
  }
  let ownText = "";
  let sawFirstElement = false;
  let lastElementLabel: string | null = null;
  let tailText = "";
  const out: { label: string; target: Node }[] = [];
  // E-10: a label that repeats among this node's element children carries
  // its occurrence index on every edge (first included), so the paths below
  // -- the nested ones and the dropped-attribute/namespace reports -- agree
  // with the writers' and every other port's.
  const edgePaths = new EdgePaths(
    path,
    elementEntries.map((e) => ({ label: local(tagKeyOf(e)) })),
  );
  for (const entry of entries) {
    if (isTextEntry(entry)) {
      const t = textOfEntry(entry);
      if (!sawFirstElement) {
        ownText += t;
      } else {
        tailText += t;
      }
      continue;
    }
    if (sawFirstElement && tailText.trim() !== "") {
      throw mixedContentError(edgePath(path, String(lastElementLabel)));
    }
    tailText = "";
    sawFirstElement = true;
    const childTag = tagKeyOf(entry);
    const childLabel = local(childTag);
    lastElementLabel = childLabel;
    const childPath = edgePaths.next(childLabel);
    reportDroppedAttributesAndNamespace(entry, childTag, childPath, report);
    out.push({
      label: childLabel,
      target: xmlToNode(entry[childTag] as XmlEntry[], childPath, depth + 1, counter, report, limits),
    });
  }
  if (ownText.trim() !== "") {
    throw mixedContentError(path);
  }
  if (tailText.trim() !== "") {
    throw mixedContentError(edgePath(path, String(lastElementLabel)));
  }
  return out;
}

// JSON-number-literal syntax, matching Python's reference regexes exactly
// (omnist/formats.py, `_XML_INT_RE`/`_XML_NUM_RE`): no leading `+`, no
// leading zeros except a bare `0` itself, and (for FLOAT_RE) no bare
// leading `.` -- e.g. "+5", "007", and ".5" are all rejected here, left as
// strings, and reported by materialize()'s value-exact check.
const INT_RE = /^-?(0|[1-9]\d*)$/;
const FLOAT_RE = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;

// #288-equivalent fix (issue #88): XML has no native typed literals (unlike
// YAML/TOML, which have real typed scalar syntax), so a schema-less
// readXml must leave every element's text as a `string` scalar
// unconditionally -- matching JSON/OML's schema-less behavior. Shape-based
// coercion ("30" -> 30, "true" -> true) used to run unconditionally in
// xmlToNode above; it has been removed from that path.
//
// When a schema IS given, though, materialize() (src/deserialize.ts)
// would otherwise reject every numeric/boolean field pulled from XML,
// since materialize() deliberately requires a value-exact match (a string
// is never accepted for an integer/number/boolean field, on any format --
// that's what lets JSON/YAML/TOML/OML tell "the author wrote a string on
// purpose" apart from "this format has no typed literals at all"). XML is
// the one format where every scalar arrives as text with no distinction,
// so recovering boolean/integer/number from that text -- guided by what
// the schema *declares* the field to be, not by shape-guessing -- has to
// happen here, locally, before materialize() ever sees the value. This
// mirrors Python's `_xml_pretype`/`_xml_pretype_scalar` (omnist/formats.py,
// v0.8.0) without copying its exact shape.
function xmlPretype(node: Node, schema: Schema, type: FieldType, path: string, maxIntDigits: number): Node {
  const resolved = schema.resolve(type);
  if ("tag" in resolved && resolved.tag === "any") return node;
  if ("tag" in resolved && resolved.tag === "scalar") return xmlPretypeScalar(node, resolved, path, maxIntDigits);
  if (!Array.isArray(node)) return node;
  const paths = new EdgePaths(path, node);
  return node.map(({ label, target }) => {
    const f = recordField(resolved, label);
    const p = paths.next(label);
    return { label, target: f ? xmlPretype(target, schema, f.type, p, maxIntDigits) : target };
  });
}

function xmlPretypeScalar(value: Node, s: ScalarType, path: string, maxIntDigits: number): Node {
  // value is always the string xmlToNode produced -- xmlPretype is only
  // ever called on a freshly-built XML node, never a value from elsewhere.
  if (typeof value !== "string") return value;
  if (s.scalarKind === "boolean" && (value === "true" || value === "false")) {
    return value === "true";
  }
  if (s.scalarKind === "integer" && INT_RE.test(value)) {
    // Digit-count cap before BigInt() ever runs (issue #98 follow-up, E-4a):
    // BigInt(text) is superlinear in digit count. INT_RE has already
    // confirmed `value` is nothing but an optional leading '-' plus digits,
    // so the count is exact here. The refusal is the one the OML reader gives
    // for the same Document: `document.limit.int-digits` at the leaf's path.
    if (digitsExceed(value.startsWith("-") ? value.slice(1) : value, 10, maxIntDigits)) {
      const issue = intDigitsIssue(maxIntDigits, path);
      throw new ParseError(issue.message, [], issue.code, issue.path);
    }
    return BigInt(value);
  }
  if (s.scalarKind === "number" && FLOAT_RE.test(value)) return Number(value);
  return value;
}

// fast-xml-parser 5.x (bumped from 4.x, GHSA-gh4j-gqv2-49f6) rejects an
// element literally named __proto__, constructor, or prototype outright
// (OrderedObjParser.js's sanitizeName throws before a node is ever built)
// -- readXml's own catch-and-wrap turns that into a ParseError, so this
// module no longer needs to intercept and undo an internal aliasing step;
// 4.x's "#__proto__" marker (and this function's job of undoing it) is
// unreachable under 5.x. See "prototype-pollution hardening" tests below.
function local(tag: string): string {
  const i = tag.lastIndexOf(":");
  return i === -1 ? tag : tag.slice(i + 1);
}

/** Options for serializing a Document node into XML text. */
export interface WriteXmlOptions {
  /** If true, throws {@link WriteError} if any lossy adjustments are made (e.g. invalid XML tag sanitization). */
  strict?: boolean;
  /** Optional {@link WriteReport} accumulator to collect adjustments into. */
  report?: WriteReport;
}

/** Serializes a Document node into XML text (spec §4). */
export function writeXml(node: Node, opts: WriteXmlOptions = {}): string {
  const { strict = false, report } = opts;
  checkEncodable(node); // C-9, unconditional, and before any structural refusal
  if (!Array.isArray(node) || node.length !== 1) {
    throw new WriteError(
      "XML needs exactly one document element; the root node must have a single top-level edge (a single-rooted Document)",
      undefined,
      "format.multiple-roots",
      "$",
    );
  }
  const rep = scanXml(node);
  const { label, target } = node[0] as Edge;
  const tag = xmlName(label);
  let text = elementXml(tag, target, 0);
  if (Array.isArray(target) && target.length > 0) text += "\n";
  return finishWrite(text, rep, report === undefined ? { strict } : { strict, report });
}

/** Simulates writing a node to XML without emitting text, returning any lossy adjustments (spec §4). */
export function checkXml(node: Node): WriteReport {
  checkEncodable(node); // C-9, unconditional: a string with no UTF-8 encoding
  return scanXml(node);
}

function scanXml(node: Node): WriteReport {
  const rep = new WriteReport();
  scanXmlNode(node, "$", rep, 0);
  return rep;
}

function scanXmlNode(node: Node, path: string, rep: WriteReport, depth: number): void {
  if (Array.isArray(node)) {
    checkWriteDepth(depth);
    if (node.length === 0) {
      // issue #128: an empty internal node and an empty-string leaf have
      // no distinct XML spelling -- both would write as the self-closing
      // <tag />, and read back identically (always as the empty-string
      // leaf), with no diagnostic distinguishing the two cases that
      // collided. Unconditional failure, not a strict-only adjustment.
      throw new WriteError(
        "path " + path + ": an empty internal node (no edges) has no XML spelling -- " +
          "it would write as the same <tag /> as an empty-string leaf and be " +
          "indistinguishable from one on read-back",
        undefined,
        "write.unsupported-value",
        path,
      );
    }
    const paths = new EdgePaths(path, node);
    for (const { label, target } of node) {
      const p = paths.next(label);
      if (!XML_NAME.test(label)) {
        // issue #126: no single well-defined substitute exists for a label
        // XML's own name syntax can't represent -- sanitizing invents
        // content, and two different labels (e.g. "my label" and
        // "my_label") can sanitize to the same tag, silently producing an
        // indistinguishable-from-legitimate repeated-label Document on
        // read-back. Unconditional failure, not a strict-only adjustment.
        throw new WriteError(
          "path " + p + ": label " + JSON.stringify(label) + " isn't a valid XML name and has no safe substitute",
          undefined,
          "write.unsupported-value",
          p,
        );
      }
      scanXmlNode(target, p, rep, depth + 1);
    }
    return;
  }
  const v = node;
  if (v === null) {
    // spec C-10: XML has no null token, and `<a/>` reads back as the empty
    // string, a different valid Document. Unconditional failure (same
    // treatment as a TOML null), at the null leaf's indexed path (E-10).
    throw new WriteError(
      "path " + path + ": a null leaf has no XML spelling -- it would write as the same " +
        "<tag /> as an empty-string leaf and read back as the empty string",
      undefined,
      "write.unsupported-value",
      path,
    );
  } else if (v instanceof Date || v instanceof TimeValue) {
    // E-5: a temporal leaf takes this code and never also the value one.
    rep.add(path, "format.temporal-stringified", "temporal value written as text (reads back as a string)", "warning");
  } else if (typeof v === "boolean" || typeof v === "number" || typeof v === "bigint") {
    // #288-equivalent (issue #88): readXml no longer infers scalar kind
    // from text shape on a schema-less read, so a non-string scalar
    // written to XML (XML has no native typed literals -- everything is
    // text) now reads back as a string, not its original type. Previously
    // silent (the old shape-based coercion happened to undo this on
    // read); now reported like every other type-losing write.
    rep.add(
      path,
      "format.value-stringified",
      "non-string scalar written as text (reads back as a string)",
      "warning",
    );
  }
  const vText = v instanceof TimeValue ? v.text : v;
  if (typeof vText === "string") {
    if (XML_ILLEGAL_CHAR.test(vText)) {
      // issue #126: same "no safe substitute" principle as the label case
      // above -- U+FFFD is a different, made-up value, not a lossless
      // representation of the original string. Unconditional failure.
      throw new WriteError(
        "path " + path + ": string contains a character XML 1.0 cannot represent " +
          "(e.g. a C0 control other than tab/LF/CR) and has no safe substitute",
        undefined,
        "write.unsupported-value",
        path,
      );
    }
    // issue #129: a literal '\r' is NOT reported as lossy any more --
    // elementXml now escapes it as the numeric character reference
    // '&#13;', which (unlike a raw '\r') is exempt from XML's mandatory
    // line-ending normalization on parse and survives intact. Genuinely
    // lossless, so there is nothing to report here.
  }
}

function elementXml(tag: string, node: Node, level: number): string {
  if (Array.isArray(node)) {
    checkWriteDepth(level);
    // issue #128: unreachable -- scanXml() always throws first for an
    // empty internal node anywhere in the tree, before elementXml ever
    // runs. Kept as defense in depth (elementXml is also reachable from
    // a hand-rolled internal call that bypasses scanXml's validation).
    /* v8 ignore next */
    if (node.length === 0) return "<" + tag + " />";
    const childPad = "  ".repeat(level + 1);
    const parts = node.map(({ label, target }) => childPad + elementXml(xmlName(label), target, level + 1));
    const closePad = "  ".repeat(level);
    return "<" + tag + ">\n" + parts.join("\n") + "\n" + closePad + "</" + tag + ">";
  }
  const text = xmlSanitize(xmlText(node));
  if (text === "") return "<" + tag + " />";
  // issue #129: escape a literal '\r' as the numeric character reference
  // '&#13;' (not written raw) -- XML normalizes raw '\r'/'\r\n' line
  // endings to '\n' on parse, so a raw '\r' and a raw '\n' are otherwise
  // indistinguishable on read-back; '&#13;' is exempt from that
  // normalization and round-trips exactly. Applied after escapeXmlText so
  // the '#'/';' in the reference itself is never re-escaped.
  return "<" + tag + ">" + escapeXmlText(text).replace(/\r/g, "&#13;") + "</" + tag + ">";
}

// issue #126: scanXmlNode (always run first, via scanXml(), by both
// writeXml() and checkXml()) already rejects every invalid label with an
// unconditional WriteError before elementXml/xmlName is ever called on
// one -- so the sanitization fallback below is unreachable through the
// public API any more. Kept (not deleted) as defense in depth: xmlName is
// also reachable from a hand-rolled internal call that bypasses
// scanXmlNode's validation, and this function's job is exactly to
// guarantee a *safe* result regardless of caller discipline.
function xmlName(name: string): string {
  /* v8 ignore start -- the false branch (an invalid name) is
   * unreachable through the public API, see the comment above */
  if (XML_NAME.test(name)) return name;
  let safe = name.replace(/[^A-Za-z0-9_.-]/g, "_");
  if (safe === "" || !XML_NAME.test(safe)) safe = "_" + safe;
  return safe;
  /* v8 ignore stop */
}

function xmlText(v: Scalar): string {
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof Date) return isoText(v);
  // No native XML time-literal syntax (issue #96): a genuinely time-kinded
  // value still writes as its plain text, same as a plain string would.
  if (v instanceof TimeValue) return timeText(v);
  return String(v);
}

function xmlSanitize(text: string): string {
  return text.replace(XML_ILLEGAL_CHAR_G, "�");
}

function escapeXmlText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
