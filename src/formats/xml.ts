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
import { TimeValue } from "../temporal.js";
import { DocumentError, ParseError, WriteError } from "../errors.js";
import { finishWrite, WriteReport } from "../report.js";
import { dateKind } from "../temporal.js";
import { materialize } from "../deserialize.js";
import { recordField, type FieldType, type Schema, type ScalarType } from "../schema.js";
import { stripLeadingBom } from "../bom.js";
import { checkInputSize } from "./input-size.js";

const MAX_DEPTH = 200;

// Matches src/document.ts's own MAX_NODES (locally redefined here, same
// convention as this file's own MAX_DEPTH copy) -- see issue #77. xmlToNode
// builds its edge tree directly rather than going through buildNode(), so
// it needs its own running counter, threaded like `depth` is.
const MAX_NODES = 1_000_000;

// Matches src/document.ts's own MAX_INT_DIGITS (locally redefined here,
// same convention as this file's own MAX_DEPTH/MAX_NODES copies -- see
// json.ts's/toml.ts's identical constant for this port's precedent). PR
// #99's schema-directed integer path (xmlPretypeScalar, below) switched
// from Number(value) to BigInt(value) to fix issue #98's precision loss --
// but xmlToNode never goes through document.ts's buildNode()/
// checkIntDigits (see this file's top comment), so nothing else on this
// route ever caps digit count. BigInt(text) does work proportional to the
// digit count, so an uncapped, attacker-controlled digit string is exactly
// the superlinear cost MAX_INT_DIGITS exists to prevent -- this check has
// to run on the raw text, before BigInt() ever sees it, matching
// json.ts's/toml.ts's checkJsonIntegerDigits/checkTomlIntegerDigits.
const MAX_INT_DIGITS = 4300;

const PARSER_MAX_NESTED_TAGS = 100000;

const XML_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

// XML 1.0 only legally permits tab, LF, CR, and U+0020-U+D7FF,
// U+E000-U+FFFD, U+10000-U+10FFFF in character data. Built as a RegExp
// from an ASCII-only string (\x/\u escapes) rather than a literal with raw
// control/surrogate characters pasted into this file, matching the Python
// port's codepoint-range convention for _XML_ILLEGAL_RANGES.
// eslint-disable-next-line no-control-regex
const XML_ILLEGAL_CHAR = new RegExp("[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\uD800-\\uDFFF\\uFFFE\\uFFFF]");
// g-flagged twin of XML_ILLEGAL_CHAR, derived from .source so the two can
// never drift. .replace() needs the g flag to substitute every match, not
// just the first; kept separate from XML_ILLEGAL_CHAR (used with .test() in
// scanXmlNode) because a g-flagged regex used with .test() carries a
// stateful lastIndex that would silently skip matches across repeated calls.
const XML_ILLEGAL_CHAR_G = new RegExp(XML_ILLEGAL_CHAR.source, "g");

// issue #129: fast-xml-parser's default config (no `htmlEntities`) decodes
// only the 5 predefined XML entities (&amp; &lt; &gt; &apos; &quot;), not
// numeric character references -- confirmed live, `<x>a&#13;b</x>` reads
// back with the literal text "a&#13;b" unless `htmlEntities: true`, which
// would also decode the full named HTML entity set (&nbsp;, &copy;, ...),
// far wider than this port's narrow data-XML profile wants to silently
// interpret. Decode only the two numeric forms XML itself defines
// (decimal &#NNN; and hex &#xHHH;) as a narrow post-processing step
// instead, so writeXml's &#13; escape (and any other numeric reference a
// well-formed input happens to contain) round-trips exactly.
const NUMERIC_CHAR_REF = /&#(\d+);|&#x([0-9A-Fa-f]+);/g;

function decodeNumericCharRefs(text: string): string {
  return text.replace(NUMERIC_CHAR_REF, (_m, dec: string | undefined, hex: string | undefined) =>
    String.fromCodePoint(Number.parseInt((dec ?? hex) as string, dec !== undefined ? 10 : 16)),
  );
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
export interface ReadXmlOptions {
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
}

// Data-XML profile (docs/formats/xml.md): a DOCTYPE declaration of any kind,
// and any entity reference other than the five predefined ones, MUST fail
// the read -- on sight, not on use. Comments, CDATA sections and processing
// instructions are stripped first: a `<!DOCTYPE` or `&name;` inside one is
// inert text, not a declaration or a reference. Numeric character
// references (`&#13;`, `&#xD;`) are character references, not entity
// references, and stay legal (decodeNumericCharRefs handles them).
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
  text = stripLeadingBom(text); // D-15: one leading U+FEFF, then nothing else
  checkInputSize(text, "XML");
  refuseOutOfProfile(text);
  const valid = XMLValidator.validate(text);
  if (valid !== true) {
    throw new ParseError("invalid XML: " + valid.err.msg);
  }
  let parsed: XmlEntry[];
  try {
    parsed = PARSER.parse(text) as XmlEntry[];
  } catch (exc) {
    /* v8 ignore next */
    const message = exc instanceof Error ? exc.message : String(exc);
    throw new ParseError("invalid XML: " + message);
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
    (e) => !("#text" in e) && Object.keys(e).length > 0 && !Object.keys(e)[0]?.startsWith("?"),
  );
  /* v8 ignore start -- defensive backstop: XMLValidator.validate already
   * requires exactly one element node for well-formed XML, and the "?"-key
   * filter above accounts for the one non-element top-level entry
   * (the XML declaration) empirically observed in preserveOrder output.
   * No known well-formed input reaches this branch; kept rather than
   * asserted non-null, per this file's own defensive-check convention. */
  if (roots.length !== 1) {
    throw new ParseError("invalid XML: expected exactly one document element");
  }
  /* v8 ignore stop */
  const root = roots[0] as XmlEntry;
  const tag = tagKeyOf(root);
  const rootLabel = local(tag);
  const rootPath = "$." + rootLabel;
  reportDroppedAttributesAndNamespace(root, tag, rootPath, opts.report);
  const nodeCounter = { count: 0 };
  const node: Node = [
    { label: rootLabel, target: xmlToNode(root[tag] as XmlEntry[], rootPath, 0, nodeCounter, opts.report) },
  ];
  if (opts.schema === undefined) return node;
  const pretyped = xmlPretype(node, opts.schema, opts.schema.root);
  return materialize(pretyped, opts.schema) as Node;
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
): Node {
  if (depth > MAX_DEPTH) {
    throw new DocumentError(path + ": nesting exceeds the maximum depth (" + String(MAX_DEPTH) + ")");
  }
  const elementEntries = entries.filter((e) => !("#text" in e));
  if (elementEntries.length === 0) {
    /* v8 ignore next */
    const text = decodeNumericCharRefs(entries.map((e) => String(e["#text"] ?? "")).join(""));
    return text;
  }
  // Only an actual node (an edge list -- spec section 2.2 `node = [ edge, ... ]`)
  // counts against MAX_NODES; a scalar leaf's target is a `value`,
  // categorically distinct from `node`, and must not be counted (issue #107).
  counter.count++;
  if (counter.count > MAX_NODES) {
    throw new DocumentError(path + ": node count exceeds the maximum (" + String(MAX_NODES) + ")");
  }
  let ownText = "";
  let sawFirstElement = false;
  let lastElementLabel: string | null = null;
  let tailText = "";
  const out: { label: string; target: Node }[] = [];
  for (const entry of entries) {
    if ("#text" in entry) {
      /* v8 ignore next */
      const t = decodeNumericCharRefs(String(entry["#text"] ?? ""));
      if (!sawFirstElement) {
        ownText += t;
      } else {
        tailText += t;
      }
      continue;
    }
    if (sawFirstElement && tailText.trim() !== "") {
      throw mixedContentError(path + "." + String(lastElementLabel));
    }
    tailText = "";
    sawFirstElement = true;
    const childTag = tagKeyOf(entry);
    const childLabel = local(childTag);
    lastElementLabel = childLabel;
    const childPath = path + "." + childLabel;
    reportDroppedAttributesAndNamespace(entry, childTag, childPath, report);
    out.push({
      label: childLabel,
      target: xmlToNode(entry[childTag] as XmlEntry[], childPath, depth + 1, counter, report),
    });
  }
  if (ownText.trim() !== "") {
    throw mixedContentError(path);
  }
  if (tailText.trim() !== "") {
    throw mixedContentError(path + "." + String(lastElementLabel));
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
function xmlPretype(node: Node, schema: Schema, type: FieldType): Node {
  const resolved = schema.resolve(type);
  if ("tag" in resolved && resolved.tag === "any") return node;
  if ("tag" in resolved && resolved.tag === "scalar") return xmlPretypeScalar(node, resolved);
  if (!Array.isArray(node)) return node;
  return node.map(({ label, target }) => {
    const f = recordField(resolved, label);
    return { label, target: f ? xmlPretype(target, schema, f.type) : target };
  });
}

function xmlPretypeScalar(value: Node, s: ScalarType): Node {
  // value is always the string xmlToNode produced -- xmlPretype is only
  // ever called on a freshly-built XML node, never a value from elsewhere.
  if (typeof value !== "string") return value;
  if (s.scalarKind === "boolean" && (value === "true" || value === "false")) {
    return value === "true";
  }
  if (s.scalarKind === "integer" && INT_RE.test(value)) {
    // Digit-count cap before BigInt() ever runs (issue #98 follow-up):
    // BigInt(text) is superlinear in digit count, and unlike JSON/TOML's
    // text-scanning checks, INT_RE has already confirmed `value` is
    // nothing but an optional leading '-' plus digits, so a plain
    // length check (minus the sign) is exact here -- no comment/string
    // skipping needed, this is already an isolated element-text scalar.
    const digits = value.startsWith("-") ? value.length - 1 : value.length;
    if (digits > MAX_INT_DIGITS) {
      throw new ParseError(
        "invalid XML: integer literal has more than " +
          String(MAX_INT_DIGITS) +
          " digits, exceeding the digit limit (security: unbounded-digit " +
          "int-to-str conversion is superlinear); matches this port's " +
          "digit cap elsewhere (src/document.ts's MAX_INT_DIGITS)",
      );
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
  if (!Array.isArray(node) || node.length !== 1) {
    throw new WriteError(
      "XML needs exactly one document element; the root node must have a single top-level edge (a single-rooted Document)",
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
      );
    }
    const counts = new Map<string, number>();
    for (const { label, target } of node) {
      const i = counts.get(label) ?? 0;
      counts.set(label, i + 1);
      const p = i === 0 ? path + "." + label : path + "." + label + "[" + String(i) + "]";
      if (!XML_NAME.test(label)) {
        // issue #126: no single well-defined substitute exists for a label
        // XML's own name syntax can't represent -- sanitizing invents
        // content, and two different labels (e.g. "my label" and
        // "my_label") can sanitize to the same tag, silently producing an
        // indistinguishable-from-legitimate repeated-label Document on
        // read-back. Unconditional failure, not a strict-only adjustment.
        throw new WriteError(
          "path " + p + ": label " + JSON.stringify(label) + " isn't a valid XML name and has no safe substitute",
        );
      }
      scanXmlNode(target, p, rep, depth + 1);
    }
    return;
  }
  const v = node;
  if (v === null) {
    rep.add(path, "null.omitted", "null written as an empty element", "warning");
  } else if (v instanceof Date || v instanceof TimeValue) {
    rep.add(path, "temporal.stringified", "temporal value written as text (reads back as a string)", "warning");
  } else if (typeof v === "boolean" || typeof v === "number" || typeof v === "bigint") {
    // #288-equivalent (issue #88): readXml no longer infers scalar kind
    // from text shape on a schema-less read, so a non-string scalar
    // written to XML (XML has no native typed literals -- everything is
    // text) now reads back as a string, not its original type. Previously
    // silent (the old shape-based coercion happened to undo this on
    // read); now reported like every other type-losing write.
    rep.add(
      path,
      "value.stringified",
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

function isoOf(d: Date): string {
  const kind = dateKind(d);
  const datePart =
    String(d.getUTCFullYear()).padStart(4, "0") +
    "-" +
    String(d.getUTCMonth() + 1).padStart(2, "0") +
    "-" +
    String(d.getUTCDate()).padStart(2, "0");
  const isMidnight =
    d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
  if (kind === "date" || (kind === undefined && isMidnight)) return datePart;
  const ms = d.getUTCMilliseconds();
  const frac = ms === 0 ? "" : "." + String(ms).padStart(3, "0");
  return (
    datePart +
    "T" +
    String(d.getUTCHours()).padStart(2, "0") +
    ":" +
    String(d.getUTCMinutes()).padStart(2, "0") +
    ":" +
    String(d.getUTCSeconds()).padStart(2, "0") +
    frac
  );
}

function xmlText(v: Scalar): string {
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v === null) return "";
  if (v instanceof Date) return isoOf(v);
  // No native XML time-literal syntax (issue #96): a genuinely time-kinded
  // value still writes as its plain text, same as a plain string would.
  if (v instanceof TimeValue) return v.text;
  return String(v);
}

function xmlSanitize(text: string): string {
  return text.replace(XML_ILLEGAL_CHAR_G, "�");
}

function escapeXmlText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
