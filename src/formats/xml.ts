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
import { DocumentError, ParseError, WriteError } from "../errors.js";
import { finishWrite, WriteReport } from "../report.js";
import { dateKind } from "../temporal.js";
import { materialize } from "../deserialize.js";
import type { Schema } from "../schema.js";

const MAX_DEPTH = 200;

const PARSER_MAX_NESTED_TAGS = 100000;

const XML_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

// XML 1.0 only legally permits tab, LF, CR, and U+0020-U+D7FF,
// U+E000-U+FFFD, U+10000-U+10FFFF in character data. Built as a RegExp
// from an ASCII-only string (\x/\u escapes) rather than a literal with raw
// control/surrogate characters pasted into this file, matching the Python
// port's codepoint-range convention for _XML_ILLEGAL_RANGES.
// eslint-disable-next-line no-control-regex
const XML_ILLEGAL_CHAR = new RegExp("[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\uD800-\\uDFFF\\uFFFE\\uFFFF]");

const PARSER = new XMLParser({
  preserveOrder: true,
  trimValues: false,
  parseTagValue: false,
  ignoreAttributes: true,
  maxNestedTags: PARSER_MAX_NESTED_TAGS,
});

type XmlEntry = Record<string, unknown>;

function checkWriteDepth(depth: number): void {
  /* v8 ignore start -- unreachable via the public API: a Node this writer
   * ever sees was built by buildNode (document.ts), which already rejects
   * nesting past MAX_DEPTH at construction time. Kept as a defensive
   * backstop, same convention as json.ts's checkWriteDepth. */
  if (depth > MAX_DEPTH) {
    throw new WriteError("nesting exceeds the maximum depth (" + String(MAX_DEPTH) + ")");
  }
  /* v8 ignore stop */
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
  const node: Node = [{ label: local(tag), target: xmlToNode(root[tag] as XmlEntry[], "$", 0) }];
  if (opts.schema === undefined) return node;
  return materialize(node, opts.schema) as Node;
}

function xmlToNode(entries: XmlEntry[], path: string, depth: number): Node {
  if (depth > MAX_DEPTH) {
    throw new DocumentError(path + ": nesting exceeds the maximum depth (" + String(MAX_DEPTH) + ")");
  }
  const elementEntries = entries.filter((e) => !("#text" in e));
  if (elementEntries.length === 0) {
    /* v8 ignore next */
    const text = entries.map((e) => String(e["#text"] ?? "")).join("");
    return coerce(text);
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
    out.push({ label: childLabel, target: xmlToNode(entry[childTag] as XmlEntry[], path + "." + childLabel, depth + 1) });
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

const INT_RE = /^[+-]?\d+$/;
const FLOAT_RE = /^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/;

function coerce(text: string): Scalar {
  if (text === "") return "";
  const low = text.toLowerCase();
  if (low === "true") return true;
  if (low === "false") return false;
  const trimmed = text.trim();
  if (INT_RE.test(trimmed)) return Number(trimmed);
  if (FLOAT_RE.test(trimmed)) return Number(trimmed);
  return text;
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
  } else if (v instanceof Date) {
    rep.add(path, "temporal.stringified", "temporal value written as text (reads back as a string)", "warning");
  } else if (typeof v === "string" && typeof coerce(v) !== "string") {
    rep.add(
      path,
      "string.ambiguous",
      "string " + JSON.stringify(v) + " looks like another type and reads back as that type",
      "warning",
    );
  }
  if (typeof v === "string") {
    if (XML_ILLEGAL_CHAR.test(v)) {
      rep.add(
        path,
        "string.illegal_xml_char",
        "string contains a character XML 1.0 cannot represent (e.g. a C0 control other than tab/LF/CR); it is replaced with U+FFFD on write so the output stays well-formed",
        "error",
      );
    }
    if (v.includes("\r")) {
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
  return String(v);
}

function xmlSanitize(text: string): string {
  return text.replace(XML_ILLEGAL_CHAR, "�");
}

function escapeXmlText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
