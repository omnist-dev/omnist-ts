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

const MAX_DEPTH = 200;

// Matches src/document.ts's own MAX_NODES (locally redefined here, same
// convention as this file's own MAX_DEPTH copy) -- see issue #77. xmlToNode
// builds its edge tree directly rather than going through buildNode(), so
// it needs its own running counter, threaded like `depth` is.
const MAX_NODES = 1_000_000;

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

const PARSER = new XMLParser({
  preserveOrder: true,
  trimValues: false,
  parseTagValue: false,
  ignoreAttributes: true,
  maxNestedTags: PARSER_MAX_NESTED_TAGS,
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

export interface ReadXmlOptions {
  schema?: Schema;
}

export function readXml(text: string, opts: ReadXmlOptions = {}): Node {
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
  const tag = Object.keys(root)[0] as string;
  const nodeCounter = { count: 0 };
  const node: Node = [
    { label: local(tag), target: xmlToNode(root[tag] as XmlEntry[], "$", 0, nodeCounter) },
  ];
  if (opts.schema === undefined) return node;
  const pretyped = xmlPretype(node, opts.schema, opts.schema.root);
  return materialize(pretyped, opts.schema) as Node;
}

function xmlToNode(
  entries: XmlEntry[],
  path: string,
  depth: number,
  counter: { count: number },
): Node {
  if (depth > MAX_DEPTH) {
    throw new DocumentError(path + ": nesting exceeds the maximum depth (" + String(MAX_DEPTH) + ")");
  }
  counter.count++;
  if (counter.count > MAX_NODES) {
    throw new DocumentError(path + ": node count exceeds the maximum (" + String(MAX_NODES) + ")");
  }
  const elementEntries = entries.filter((e) => !("#text" in e));
  if (elementEntries.length === 0) {
    /* v8 ignore next */
    const text = entries.map((e) => String(e["#text"] ?? "")).join("");
    return text;
  }
  let ownText = "";
  let sawFirstElement = false;
  let lastElementLabel: string | null = null;
  let tailText = "";
  const out: { label: string; target: Node }[] = [];
  for (const entry of entries) {
    if ("#text" in entry) {
      /* v8 ignore next */
      const t = String(entry["#text"] ?? "");
      if (!sawFirstElement) {
        ownText += t;
      } else {
        tailText += t;
      }
      continue;
    }
    if (sawFirstElement && tailText.trim() !== "") {
      throw new ParseError(
        path + "." + String(lastElementLabel) + ": mixed content (text alongside child elements) is outside the data-XML profile",
      );
    }
    tailText = "";
    sawFirstElement = true;
    const childTag = Object.keys(entry)[0] as string;
    const childLabel = local(childTag);
    lastElementLabel = childLabel;
    out.push({
      label: childLabel,
      target: xmlToNode(entry[childTag] as XmlEntry[], path + "." + childLabel, depth + 1, counter),
    });
  }
  if (ownText.trim() !== "") {
    throw new ParseError(path + ": mixed content (text alongside child elements) is outside the data-XML profile");
  }
  if (tailText.trim() !== "") {
    throw new ParseError(
      path + "." + String(lastElementLabel) + ": mixed content (text alongside child elements) is outside the data-XML profile",
    );
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
  if (s.scalarKind === "integer" && INT_RE.test(value)) return BigInt(value);
  if (s.scalarKind === "number" && FLOAT_RE.test(value)) return Number(value);
  return value;
}

// fast-xml-parser aliases an element literally named __proto__ to the
// internal marker "#__proto__" (xmlNode.js addChild/add: unconditionally,
// on every parse, to stop the tag name from ever reaching a raw property
// assignment on one of its own plain objects). It never applies the same
// treatment to "constructor" or "prototype" -- those pass through
// untouched, verified directly against the installed source and by the
// "leaves constructor/prototype element labels untouched" test below. The
// alias is unconditional and keyed on exact equality, not an opt-out
// option, so there is no parser flag to disable it; this module corrects
// the label back afterwards instead. The corrected string can never
// collide with a genuine input tag: "#" is not a legal XML name-start
// character (XML_NAME below, and the spec's NameStartChar production), so
// no well-formed document can contain an element actually named
// "#__proto__" -- every occurrence this function sees originated from
// the parser's own aliasing, and undoing it is lossless.
const FAST_XML_PARSER_PROTO_ALIAS = "#__proto__";

function local(tag: string): string {
  const real = tag === FAST_XML_PARSER_PROTO_ALIAS ? "__proto__" : tag;
  const i = real.lastIndexOf(":");
  return i === -1 ? real : real.slice(i + 1);
}

export interface WriteXmlOptions {
  strict?: boolean;
  report?: WriteReport;
}

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
      rep.add(
        path,
        "shape.empty_ambiguous",
        "empty internal node (no edges) written as <tag /> and reads back as the empty-string leaf '', not []",
        "warning",
      );
      return;
    }
    const counts = new Map<string, number>();
    for (const { label, target } of node) {
      const i = counts.get(label) ?? 0;
      counts.set(label, i + 1);
      const p = i === 0 ? path + "." + label : path + "." + label + "[" + String(i) + "]";
      if (!XML_NAME.test(label)) {
        rep.add(p, "key.sanitized", "label " + JSON.stringify(label) + " isn't a valid XML name; written sanitized", "warning");
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
      rep.add(
        path,
        "string.illegal_xml_char",
        "string contains a character XML 1.0 cannot represent (e.g. a C0 control other than tab/LF/CR); it is replaced with U+FFFD on write so the output stays well-formed",
        "error",
      );
    }
    if (vText.includes("\r")) {
      rep.add(
        path,
        "string.cr_normalized",
        "string contains a carriage return ('\\r'); XML mandates line-ending normalization on parse, so '\\r' (and '\\r\\n') read back as '\\n'",
        "warning",
      );
    }
  }
}

function elementXml(tag: string, node: Node, level: number): string {
  if (Array.isArray(node)) {
    checkWriteDepth(level);
    if (node.length === 0) return "<" + tag + " />";
    const childPad = "  ".repeat(level + 1);
    const parts = node.map(({ label, target }) => childPad + elementXml(xmlName(label), target, level + 1));
    const closePad = "  ".repeat(level);
    return "<" + tag + ">\n" + parts.join("\n") + "\n" + closePad + "</" + tag + ">";
  }
  const text = xmlSanitize(xmlText(node));
  if (text === "") return "<" + tag + " />";
  return "<" + tag + ">" + escapeXmlText(text) + "</" + tag + ">";
}

function xmlName(name: string): string {
  if (XML_NAME.test(name)) return name;
  let safe = name.replace(/[^A-Za-z0-9_.-]/g, "_");
  if (safe === "" || !XML_NAME.test(safe)) safe = "_" + safe;
  return safe;
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
