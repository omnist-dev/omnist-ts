import { describe, expect, it } from "vitest";
import { doc } from "../../src/document.js";
import { DocumentError, ParseError, WriteError } from "../../src/errors.js";
import { WriteReport } from "../../src/report.js";
import { readXml, writeXml, checkXml } from "../../src/formats/xml.js";

describe("readXml", () => {
  it("parses a document with a standard XML declaration prologue", () => {
    // Regression test: fast-xml-parser's preserveOrder output surfaces the
    // "<?xml version="1.0"?>" declaration as its own top-level entry
    // (keyed "?xml"), which used to be miscounted as a second document
    // element -- so effectively every real-world XML document (which
    // almost always opens with this declaration) failed to parse. See
    // examples/sitemap/convert.ts and docs/formats/xml.md.
    const d = readXml('<?xml version="1.0" encoding="UTF-8"?><root><a>1</a></root>');
    expect(d).toEqual([{ label: "root", target: [{ label: "a", target: 1 }] }]);
  });

  it("parses a document with a leading comment and an XML declaration", () => {
    const d = readXml(
      '<?xml version="1.0"?>' + String.fromCharCode(10) +
        '<!-- a provenance comment -->' + String.fromCharCode(10) +
        '<root><a>1</a></root>',
    );
    expect(d).toEqual([{ label: "root", target: [{ label: "a", target: 1 }] }]);
  });

  it("parses a single-rooted document into a single top-level edge", () => {
    const d = readXml("<team><name>P</name><member>x</member><member>y</member></team>");
    expect(d).toEqual([
      { label: "team", target: [
        { label: "name", target: "P" },
        { label: "member", target: "x" },
        { label: "member", target: "y" },
      ] },
    ]);
  });

  it("preserves interleaving of repeated labels", () => {
    const d = readXml("<t><m>a</m><x>1</x><m>b</m></t>");
    expect(d).toEqual([
      { label: "t", target: [
        { label: "m", target: "a" },
        { label: "x", target: 1 },
        { label: "m", target: "b" },
      ] },
    ]);
  });

  it("coerces empty/bool-ish text; leaves non-coercible text as string", () => {
    const d = readXml("<r><a></a><b>true</b><c>false</c></r>");
    expect(d).toEqual([
      { label: "r", target: [
        { label: "a", target: "" },
        { label: "b", target: true },
        { label: "c", target: false },
      ] },
    ]);
  });

  it("coerces int/float/bool text but not date-shaped text", () => {
    const d = readXml("<r><n>30</n><f>3.5</f><ok>true</ok><d>2024-01-01</d></r>");
    expect(d).toEqual([
      { label: "r", target: [
        { label: "n", target: 30 },
        { label: "f", target: 3.5 },
        { label: "ok", target: true },
        { label: "d", target: "2024-01-01" },
      ] },
    ]);
  });

  it("strips namespace prefixes from tag names", () => {
    const d = readXml("<n:a>x</n:a>");
    expect(d).toEqual([{ label: "a", target: "x" }]);
  });

  it("raises ParseError on invalid XML", () => {
    expect(() => readXml("<unclosed>")).toThrow(ParseError);
    expect(() => readXml("<unclosed>")).toThrow(/invalid XML/);
  });

  it("raises ParseError on multiple root elements", () => {
    expect(() => readXml("<a>1</a><b>2</b>")).toThrow(ParseError);
  });

  describe("mixed content is rejected", () => {
    it("rejects text before a child element", () => {
      expect(() => readXml("<p>Hello <b>w</b></p>")).toThrow(ParseError);
      expect(() => readXml("<p>Hello <b>w</b></p>")).toThrow(/mixed content/);
    });

    it("rejects tail text after a child element", () => {
      expect(() => readXml("<p><b>w</b> tail</p>")).toThrow(ParseError);
      expect(() => readXml("<p><b>w</b> tail</p>")).toThrow(/mixed content/);
    });

    it("rejects tail text between two child elements (mid-sequence, not just trailing)", () => {
      expect(() => readXml("<p><b>w</b> tail <c>x</c></p>")).toThrow(ParseError);
      expect(() => readXml("<p><b>w</b> tail <c>x</c></p>")).toThrow(/mixed content/);
    });

    it("names the element in the error", () => {
      try {
        readXml("<p>Hello <b>w</b></p>");
        throw new Error("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ParseError);
        expect(String((e as Error).message)).toContain("$");
      }
    });

    it("accepts whitespace-only text/tail (pretty-printed XML)", () => {
      expect(readXml("<p>\n  <b>w</b>\n</p>")).toEqual([
        { label: "p", target: [{ label: "b", target: "w" }] },
      ]);
      expect(readXml("<p>  <b>w</b>  <c>x</c>  </p>")).toEqual([
        { label: "p", target: [
          { label: "b", target: "w" },
          { label: "c", target: "x" },
        ] },
      ]);
    });

    it("write_xml's own pretty-printed output still reads back", () => {
      const d: unknown = [
        { label: "team", target: [
          { label: "name", target: "P" },
          { label: "member", target: "x" },
          { label: "member", target: "y" },
        ] },
      ];
      expect(readXml(writeXml(d as never))).toEqual(d);
    });
  });

  describe("depth guard", () => {
    it("parses at the 200-level depth boundary", () => {
      let s = "<v>1</v>";
      for (let i = 0; i < 200; i++) s = "<a>" + s + "</a>";
      expect(() => readXml(s)).not.toThrow();
    });

    it("raises DocumentError one level past the boundary", () => {
      let s = "<v>1</v>";
      for (let i = 0; i < 201; i++) s = "<a>" + s + "</a>";
      expect(() => readXml(s)).toThrow(DocumentError);
      expect(() => readXml(s)).toThrow(/nesting exceeds the maximum depth/);
    });

    it("raises cleanly (not a stack overflow) for very deep input", () => {
      let s = "<v>1</v>";
      for (let i = 0; i < 2000; i++) s = "<a>" + s + "</a>";
      expect(() => readXml(s)).toThrow(DocumentError);
    });
  });

  describe("schema-directed reads", () => {
    it("materializes via a schema when opts.schema is given", async () => {
      const { parseSchema } = await import("../../src/osd.js");
      const s = parseSchema("record Inner { \"n\": number }\nrecord R { \"r\": Inner }\nroot R");
      const node = readXml("<r><n>1</n></r>", { schema: s });
      expect(node).toEqual([{ label: "r", target: [{ label: "n", target: 1 }] }]);
    });
  });

  describe("XXE / entity-expansion safety (security-critical)", () => {
    it("does not resolve an external SYSTEM entity (classic XXE payload)", () => {
      const payload =
        '<?xml version="1.0"?>' +
        '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' +
        "<a>&xxe;</a>";
      // A vulnerable parser would either throw while trying to fetch the
      // file, or (worse) silently inline the file's contents into the
      // parsed text. Neither is acceptable: this must fail closed with a
      // ParseError, and if it doesn't throw, the text must never contain
      // filesystem content.
      expect(() => readXml(payload)).toThrow(ParseError);
    });

    it("does not expand a nested internal-entity 'billion laughs' payload", () => {
      const payload =
        '<?xml version="1.0"?>' +
        '<!DOCTYPE lolz [<!ENTITY lol "lol">' +
        '<!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]>' +
        "<a>&lol2;</a>";
      // Must not hang/blow up memory, and must not silently expand to the
      // exponential text. Either throwing or reading back a small,
      // unexpanded value is acceptable -- explosive expansion is not.
      let result: unknown;
      let threw = false;
      try {
        result = readXml(payload);
      } catch {
        threw = true;
      }
      if (!threw) {
        const text = JSON.stringify(result);
        expect(text.length).toBeLessThan(1000);
        expect(text).not.toContain("lollollollollollollollollollol");
      }
    });

    it("rejects a DOCTYPE declaring a parameter entity", () => {
      const payload =
        '<?xml version="1.0"?>' +
        '<!DOCTYPE foo [<!ENTITY % pe "bogus"> %pe;]>' +
        "<a>x</a>";
      expect(() => readXml(payload)).toThrow(ParseError);
    });
  });

  describe("__proto__-labeled elements (prototype-pollution hardening)", () => {
    it("reads a __proto__ element as the real tag name, not fast-xml-parser's #__proto__ alias", () => {
      // fast-xml-parser aliases an element literally named __proto__ to
      // "#__proto__" internally (xmlNode.js addChild: if tagname is
      // "__proto__" it is reassigned to "#__proto__") to protect its own
      // object construction. readXml must undo that alias so the
      // document's label is the real tag name the input actually used.
      const node = readXml("<root><__proto__><polluted>true</polluted></__proto__><kept>1</kept></root>");
      expect(node).toEqual([
        {
          label: "root",
          target: [
            { label: "__proto__", target: [{ label: "polluted", target: true }] },
            { label: "kept", target: 1 },
          ],
        },
      ]);
    });

    it("round-trips a __proto__ element through write and read unchanged", () => {
      const xml = "<root><__proto__><polluted>true</polluted></__proto__><kept>1</kept></root>";
      const node = readXml(xml);
      const written = writeXml(node);
      expect(written).not.toContain("___proto__");
      expect(written).toContain("<__proto__>");
      expect(readXml(written)).toEqual(node);
    });

    it("does not pollute Object.prototype when reading a __proto__ element", () => {
      const before = ({} as Record<string, unknown>).polluted;
      readXml("<root><__proto__><polluted>true</polluted></__proto__></root>");
      expect(({} as Record<string, unknown>).polluted).toBe(before);
      expect(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")).toBe(false);
    });

    it("__proto__ as the document (root) element itself also reads back correctly", () => {
      const node = readXml("<__proto__><a>1</a></__proto__>");
      expect(node).toEqual([{ label: "__proto__", target: [{ label: "a", target: 1 }] }]);
    });

    it("leaves constructor/prototype element labels untouched (fast-xml-parser does not alias those)", () => {
      const node = readXml("<root><constructor><x>1</x></constructor><prototype><y>2</y></prototype></root>");
      expect(node).toEqual([
        {
          label: "root",
          target: [
            { label: "constructor", target: [{ label: "x", target: 1 }] },
            { label: "prototype", target: [{ label: "y", target: 2 }] },
          ],
        },
      ]);
    });
  });
});

describe("writeXml", () => {
  it("requires exactly one top-level edge", () => {
    expect(() => writeXml([{ label: "a", target: 1 }, { label: "b", target: 2 }])).toThrow(WriteError);
  });

  it("sanitizes a label that isn't a valid XML name", () => {
    const out = writeXml([{ label: "a b", target: "1" }]);
    expect(out).toContain("<a_b>");
  });

  it("prefixes an underscore when a label starts with a digit", () => {
    const out = writeXml([{ label: "1tag", target: "x" }]);
    expect(out).toContain("<_1tag>");
  });

  it("round-trips bool/null/date leaves as text", () => {
    const d = [
      { label: "r", target: [
        { label: "flag", target: true },
        { label: "nothing", target: null },
        { label: "d", target: new Date(Date.UTC(2024, 0, 1)) },
      ] },
    ];
    const out = writeXml(d);
    expect(out).toContain("<flag>true</flag>");
    expect(/<nothing \/>|<nothing\/>|<nothing><\/nothing>/.test(out)).toBe(true);
    expect(out).toContain("<d>2024-01-01</d>");
  });

  it("writes a zero-millisecond non-midnight time with no fractional part", () => {
    const d = new Date(Date.UTC(2024, 0, 1, 12, 30, 45, 0));
    const out = writeXml([{ label: "a", target: [{ label: "t", target: d }] }]);
    expect(out).toContain("<t>2024-01-01T12:30:45</t>");
  });

  it("round-trips a false boolean leaf as text", () => {
    const out = writeXml([{ label: "a", target: [{ label: "flag", target: false }] }]);
    expect(out).toContain("<flag>false</flag>");
  });

  it("writes fractional-second time-of-day text for a sub-second Date", () => {
    const d = new Date(Date.UTC(2024, 0, 1, 12, 30, 45, 123));
    const out = writeXml([{ label: "a", target: [{ label: "t", target: d }] }]);
    expect(out).toContain("12:30:45.123");
  });

  it("matches the documented example output exactly", () => {
    expect(writeXml([{ label: "order", target: [{ label: "id", target: "A1" }] }])).toBe(
      "<order>\n  <id>A1</id>\n</order>\n",
    );
  });

  it("a leaf-only root has no trailing newline", () => {
    expect(writeXml([{ label: "a", target: 1 }])).toBe("<a>1</a>");
  });

  it("round-trips through readXml", () => {
    const d = readXml("<team><name>P</name><member>x</member><member>y</member></team>");
    expect(readXml(writeXml(d))).toEqual(d);
  });
});

describe("checkXml", () => {
  it("reports null.omitted for a null leaf", () => {
    const node = doc({ a: null }).toData();
    const rep = checkXml(node);
    expect(rep.adjustments.map((a) => a.code)).toEqual(["null.omitted"]);
  });

  it("reports key.sanitized and temporal.stringified together", () => {
    const node = doc({ r: { "a b": 1, d: new Date(Date.UTC(2024, 0, 1)) } }).toData();
    const rep = checkXml(node);
    const codes = new Set(rep.adjustments.map((a) => a.code));
    expect(codes.has("key.sanitized")).toBe(true);
    expect(codes.has("temporal.stringified")).toBe(true);
  });

  it("reports string.ambiguous for a numeric-looking string leaf", () => {
    const node = [{ label: "a", target: "30" }];
    const rep = checkXml(node);
    expect(rep.adjustments.map((a) => a.code)).toEqual(["string.ambiguous"]);
  });

  it("reports shape.empty_ambiguous for an empty internal node", () => {
    const emptyInternal = [{ label: "A", target: [] }];
    const emptyLeaf = [{ label: "A", target: "" }];
    expect(writeXml(emptyInternal)).toBe(writeXml(emptyLeaf));
    const repInternal = checkXml(emptyInternal);
    expect(repInternal.adjustments.map((a) => a.code)).toEqual(["shape.empty_ambiguous"]);
    expect(readXml(writeXml(emptyInternal))).toEqual([{ label: "A", target: "" }]);
    const repLeaf = checkXml(emptyLeaf);
    expect(repLeaf.adjustments.length).toBe(0);
    expect(readXml(writeXml(emptyLeaf))).toEqual(emptyLeaf);
  });

  it("reports string.illegal_xml_char with error severity and substitutes U+FFFD on write", () => {
    const node = [{ label: "a", target: "x\x01y" }];
    const rep = checkXml(node);
    expect(rep.adjustments.map((a) => a.code)).toEqual(["string.illegal_xml_char"]);
    expect(rep.errors.length).toBe(1);
    const out = writeXml(node);
    expect(out).toContain("x�y");
  });

  it("replaces ALL illegal XML characters on write, not just the first (issue #36)", () => {
    // Regression test: XML_ILLEGAL_CHAR has no `g` flag (it doubles as a
    // .test() predicate in scanXmlNode), so passing it directly to
    // .replace() only substituted the FIRST illegal character and left
    // every subsequent one as a raw byte in the output. fast-xml-parser
    // reads that malformed output back without complaint, but a
    // conformant parser (e.g. Python's xml.etree.ElementTree, which the
    // omnist Python port uses) rejects it as not well-formed.
    const bad = "a" + String.fromCharCode(1) + "b" + String.fromCharCode(2) + "c";
    const node = [{ label: "r", target: [{ label: "v", target: bad }] }];
    const out = writeXml(node);

    const illegal = [...out]
      .map((c) => c.charCodeAt(0))
      .filter((n) => n < 0x20 && n !== 9 && n !== 10 && n !== 13);
    expect(illegal).toEqual([]);
    expect(out).toContain("a�b�c");

    // Bonus verification: the sanitized output round-trips through
    // readXml (fast-xml-parser) and, more importantly, contains no raw
    // control characters at all -- the property a strict, conformant XML
    // 1.0 parser (like Python's ElementTree) requires to accept it.
    expect(readXml(out)).toEqual([
      { label: "r", target: [{ label: "v", target: "a�b�c" }] },
    ]);
  });

  it("reports string.cr_normalized as a warning, leaving \\r as-is on write", () => {
    const node = [{ label: "a", target: "x\ry" }];
    const rep = checkXml(node);
    expect(rep.adjustments.map((a) => a.code)).toEqual(["string.cr_normalized"]);
    expect(rep.warnings.length).toBe(1);
  });
});

describe("strict/report integration", () => {
  it("strict throws WriteError carrying the report; report= collects adjustments", () => {
    const node = doc({ r: { a: 1, b: null } }).toData();
    const rep = new WriteReport();
    expect(() => writeXml(node, { strict: true, report: rep })).toThrow(WriteError);
    expect(rep.adjustments.map((a) => a.code)).toEqual(["null.omitted"]);
  });
});

describe("isoOf / xmlText branch coverage", () => {
  it("writes a datetime with zero milliseconds (non-midnight) without a fractional part", () => {
    const node = [{ label: "r", target: [{ label: "at", target: new Date(Date.UTC(2024, 0, 1, 13, 30, 45, 0)) }] }];
    const out = writeXml(node);
    expect(out).toContain("<at>2024-01-01T13:30:45</at>");
  });

  it("writes both true and false boolean leaves as text", () => {
    const node = [{ label: "r", target: [
      { label: "t", target: true },
      { label: "f", target: false },
    ] }];
    const out = writeXml(node);
    expect(out).toContain("<t>true</t>");
    expect(out).toContain("<f>false</f>");
  });
});

describe("checkWriteDepth is a real, reachable guard (issue #37)", () => {
  it("writeXml rejects a hand-built Node deeper than MAX_DEPTH", () => {
    let inner: import("../../src/document.js").Node = 1;
    for (let i = 0; i < 250; i++) {
      inner = [{ label: "a", target: inner }];
    }
    const node: import("../../src/document.js").Node = [{ label: "root", target: inner }];
    expect(() => writeXml(node)).toThrow(/nesting exceeds the maximum depth \(200\)/);
  });
});
