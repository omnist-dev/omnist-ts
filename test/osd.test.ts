import { describe, expect, it } from "vitest";
import { doc } from "../src/document.js";
import { SchemaError } from "../src/errors.js";
import { parseSchema, toOsd } from "../src/osd.js";
import {
  ANY,
  field,
  record,
  ref,
  schema,
  schemaEquals,
  t,
} from "../src/schema.js";

// Ported from upstream omnist's tests/test_canonical.py and
// docs/design/schema-osd-grammar.md's worked examples (issue #4). Error
// assertions match error *type* (SchemaError) and a stable substring of the
// message, per the message-stability policy -- not the exact Python text.

function valid(text: string, data: unknown) {
  return parseSchema(text).validate(doc(data));
}

describe("parseSchema: validation-relevant parsing", () => {
  it("parses scalar kinds", () => {
    const s = 'record R { "n": integer, "s": string }\nroot R';
    expect(valid(s, { n: 1n, s: "x" }).ok).toBe(true);
    expect(valid(s, { n: "x", s: "x" }).ok).toBe(false);
  });

  it("parses required and optional fields via cardinality", () => {
    const s = 'record R { "name": string, "age" [0,1]: integer }\nroot R';
    expect(valid(s, { name: "a" }).ok).toBe(true);
    expect(valid(s, { name: "a", age: 3n }).ok).toBe(true);
    expect(valid(s, { age: 3 }).ok).toBe(false);
  });

  it("closed records reject unexpected fields", () => {
    const s = 'record R { "a": integer }\nroot R';
    const r = valid(s, { a: 1, b: 2 });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.message.includes("unexpected field"))).toBe(true);
  });

  it("array cardinality shorthand [0,]", () => {
    const s = 'record R { "xs" [0,]: integer }\nroot R';
    expect(valid(s, { xs: [1n, 2n, 3n] }).ok).toBe(true);
    expect(valid(s, {}).ok).toBe(true);
    const s2 = 'record R { "xs" [1,]: integer }\nroot R';
    expect(valid(s2, {}).ok).toBe(false);
    expect(valid(s2, { xs: [1n] }).ok).toBe(true);
  });

  it("exact cardinality shorthand [n]", () => {
    const s3 = 'record R { "xs" [2]: integer }\nroot R';
    expect(valid(s3, { xs: [1n, 2n] }).ok).toBe(true);
    expect(valid(s3, { xs: [1n] }).ok).toBe(false);
  });

  it("nullable scalar via string?", () => {
    const s = 'record R { "note": string? }\nroot R';
    expect(valid(s, { note: null }).ok).toBe(true);
    expect(valid(s, { note: "hi" }).ok).toBe(true);
    expect(valid(s, { note: 1 }).ok).toBe(false);
  });

  it("integer satisfies number", () => {
    const s = 'record R { "v": number }\nroot R';
    expect(valid(s, { v: 7 }).ok).toBe(true);
    expect(valid(s, { v: 7.5 }).ok).toBe(true);
    expect(valid(s, { v: "x" }).ok).toBe(false);
  });

  it("Ref and recursion", () => {
    const s = 'record Node { "value": integer, "kids" [0,]: Node }\nroot Node';
    expect(valid(s, { value: 1n, kids: [{ value: 2n, kids: [] }] }).ok).toBe(true);
    expect(valid(s, { value: 1n, kids: [{ value: "x", kids: [] }] }).ok).toBe(false);
  });

  it("'?' on a Ref is a SchemaError", () => {
    expect(() =>
      parseSchema('record A { "x": integer }\nrecord R { "a": A? }\nroot R'),
    ).toThrow(SchemaError);
    expect(() =>
      parseSchema('record A { "x": integer }\nrecord R { "a": A? }\nroot R'),
    ).toThrow(/cannot apply to the reference/);
  });

  it("there is no '|' union syntax -- tokenizer rejects the bare character", () => {
    expect(() => parseSchema('record R { "status": "open" | "closed" }\nroot R')).toThrow(
      SchemaError,
    );
  });

  it("a literal-valued field is rejected with a specific message", () => {
    expect(() => parseSchema('record R { "status": "open" }\nroot R')).toThrow(
      /scalar name or a reference/,
    );
    expect(() => parseSchema('record R { "n": 5 }\nroot R')).toThrow(
      /scalar name or a reference/,
    );
  });

  it("there is no 'union' keyword", () => {
    expect(() =>
      parseSchema('union License { "auto", "manual" }\nrecord R { "a": integer }\nroot R'),
    ).toThrow(SchemaError);
  });
});

describe("OSD parser robustness (TestOsdRobustness)", () => {
  it("float cardinality raises SchemaError cleanly, not a crash", () => {
    expect(() => parseSchema('record R { "a" [1.5,3]: integer }\nroot R')).toThrow(SchemaError);
  });

  it("many flat (non-nested) definitions are not falsely depth-rejected", () => {
    let flat = "";
    for (let i = 0; i < 150; i++) flat += `record R${i} { "a": integer }\n`;
    const s = parseSchema(flat + "root R0");
    expect(s.root.name).toBe("R0");
  });

  it("a record named after a scalar keyword is rejected", () => {
    expect(() =>
      parseSchema('record string { "x": integer }\nrecord R { "a": string }\nroot R'),
    ).toThrow(SchemaError);
  });

  it("a record named after a non-scalar word is fine", () => {
    const s = parseSchema(
      'record Address { "city": string }\nrecord R { "a": Address }\nroot R',
    );
    expect(s.validate(doc({ a: { city: "X" } })).ok).toBe(true);
  });
});

describe("OSD error paths (TestOsdErrors)", () => {
  it("missing colon", () => {
    expect(() => parseSchema('record R { "a" integer }\nroot R')).toThrow(/expected ":"/);
  });

  it("garbage top-level token", () => {
    expect(() => parseSchema("bogus X\nroot R")).toThrow(/expected 'record' or 'root'/);
  });

  it("missing root declaration", () => {
    expect(() => parseSchema('record R { "a": integer }')).toThrow(/must declare a root/);
  });

  it("duplicate definition", () => {
    expect(() =>
      parseSchema('record A { "x": integer }\nrecord A { "y": string }\nroot A'),
    ).toThrow(/duplicate definition "A"/);
  });

  it("unquoted field label", () => {
    expect(() => parseSchema('record R { x: integer }\nroot R')).toThrow(
      /expected a quoted field name/,
    );
  });

  it("empty cardinality", () => {
    expect(() => parseSchema('record R { "a" []: integer }\nroot R')).toThrow(
      /empty cardinality/,
    );
  });

  it("missing closing brace", () => {
    expect(() => parseSchema('record R { "a": integer\nroot R')).toThrow(SchemaError);
  });

  it("unknown referenced name", () => {
    expect(() => parseSchema('record R { "a": Missing }\nroot R')).toThrow(
      /unknown type "Missing"/,
    );
  });

  it("a missing record name after the 'record' keyword is a plain-kind expectation error", () => {
    expect(() => parseSchema('record { "a": integer }\nroot R')).toThrow(/expected "name"/);
  });

  it("a missing root name after the 'root' keyword is a plain-kind expectation error", () => {
    expect(() => parseSchema('record R { "a": integer }\nroot')).toThrow(/expected "name"/);
  });
});

describe("OSD lexical error codes (spec Sec8.3.1, extended by spec#46 to cover OSD)", () => {
  it("unexpected character gets parse.unexpected-token and a line:col path", () => {
    let err: SchemaError | undefined;
    try {
      parseSchema('record R { "a": integer }\nroot R\n%');
    } catch (e) {
      err = e as SchemaError;
    }
    expect(err).toBeInstanceOf(SchemaError);
    expect(err?.code).toBe("parse.unexpected-token");
    expect(err?.path).toBe("3:1");
  });

  it("unterminated string gets parse.unterminated-string", () => {
    let err: SchemaError | undefined;
    try {
      parseSchema('record R { "a');
    } catch (e) {
      err = e as SchemaError;
    }
    expect(err).toBeInstanceOf(SchemaError);
    expect(err?.code).toBe("parse.unterminated-string");
    expect(err?.path).toBe("1:12");
  });

  it("a trailing backslash right before end of input is still unterminated-string, not a crash", () => {
    let err: SchemaError | undefined;
    try {
      parseSchema('record R { "a\\');
    } catch (e) {
      err = e as SchemaError;
    }
    expect(err).toBeInstanceOf(SchemaError);
    expect(err?.code).toBe("parse.unterminated-string");
  });

  it("a literal control character inside a string gets parse.control-character", () => {
    let err: SchemaError | undefined;
    try {
      parseSchema('record R { "a\tb": integer }\nroot R');
    } catch (e) {
      err = e as SchemaError;
    }
    expect(err).toBeInstanceOf(SchemaError);
    expect(err?.code).toBe("parse.control-character");
    expect(err?.path).toBe("1:14");
  });

  it("a weak backslash escape of an arbitrary character is accepted, not an invalid-escape error", () => {
    // OSD strings use weak unescaping (spec Sec5.3.1): \X decodes to the
    // literal character X for any X -- there is no parse.invalid-escape
    // case reachable from OSD, unlike OML.
    expect(() => parseSchema('record R { "a\\qb": integer }\nroot R')).not.toThrow();
  });

  it("non-lexical SchemaError throw sites still carry no code/path (unchanged, additive-only scope)", () => {
    let err: SchemaError | undefined;
    try {
      parseSchema('record R { "a": integer }');
    } catch (e) {
      err = e as SchemaError;
    }
    expect(err).toBeInstanceOf(SchemaError);
    expect(err?.code).toBeUndefined();
    expect(err?.path).toBeUndefined();
  });
});

describe("grammar quoting rule and 'any' handling", () => {
  it("quoted string is always the label; unquoted name is always a type", () => {
    const s = parseSchema('record R { "a": string }\nroot R');
    expect(s.validate(doc({ a: "x" })).ok).toBe(true);
  });

  it("string escapes have no named-escape table: \\n becomes literal n", () => {
    const s = parseSchema('record R { "a\\nb": string }\nroot R');
    expect(s.validate(doc({ anb: "x" })).ok).toBe(true);
  });

  it("cardinality shapes: [1,5] [5,] [,5] [,]", () => {
    expect(() => parseSchema('record R { "a" [1,5]: string }\nroot R')).not.toThrow();
    expect(() => parseSchema('record R { "a" [5,]: string }\nroot R')).not.toThrow();
    expect(() => parseSchema('record R { "a" [,5]: string }\nroot R')).not.toThrow();
    expect(() => parseSchema('record R { "a" [,]: string }\nroot R')).not.toThrow();
  });

  it("negative or inverted cardinality tokenizes fine but Field rejects it", () => {
    expect(() => parseSchema('record R { "a" [-1]: string }\nroot R')).toThrow(SchemaError);
    expect(() => parseSchema('record R { "a" [1,0]: string }\nroot R')).toThrow(SchemaError);
  });

  it("cardinality must be a whole number", () => {
    expect(() => parseSchema('record R { "a" [1.5]: string }\nroot R')).toThrow(
      /whole number/,
    );
  });

  it("any type parses and accepts every value", () => {
    const s = parseSchema('record R { "data": any }\nroot R');
    expect(s.validate(doc({ data: "x" })).ok).toBe(true);
    expect(s.validate(doc({ data: 5 })).ok).toBe(true);
    expect(s.validate(doc({ data: null })).ok).toBe(true);
  });

  it("cardinality is orthogonal to 'any'", () => {
    expect(() => parseSchema('record R { "data" [0,]: any }\nroot R')).not.toThrow();
  });

  it("'any?' is redundant and rejected", () => {
    expect(() => parseSchema('record R { "data": any? }\nroot R')).toThrow(
      /'any' already includes null/,
    );
  });

  it("record named 'any' is a reserved-name SchemaError", () => {
    expect(() => parseSchema('record any { "a": string }\nroot any')).toThrow(
      /reserved type name/,
    );
  });

  it("capitalized 'Any' is an ordinary ref-type, not the reserved keyword", () => {
    expect(() => parseSchema('record R { "data": Any }\nroot R')).toThrow(
      /unknown type "Any"/,
    );
  });

  it("comments are discarded anywhere whitespace is valid", () => {
    const s = parseSchema('# comment\nrecord R { "a": string } # trailing\nroot R');
    expect(s.validate(doc({ a: "x" })).ok).toBe(true);
  });

  it("trailing comma after the last field is accepted", () => {
    expect(() => parseSchema('record R { "a": string, }\nroot R')).not.toThrow();
  });
});

describe("toOsd: serialization and round-trip", () => {
  const OSD_CASES = [
    'record R { "n": integer }\nroot R',
    'record R { "n": integer, "s": string? }\nroot R',
    'record R { "status": string }\nroot R',
    'record R { "v": number }\nroot R',
    'record R { "xs" [0,]: integer }\nroot R',
    'record R { "xs" [1,5]: string }\nroot R',
    'record R { "xs" [2]: integer }\nroot R',
    'record R { "first name": string }\nroot R',
    'record M { "name": string }\nrecord R { "m" [0,]: M }\nroot R',
    'record Node { "v": integer, "kids" [0,]: Node }\nroot Node',
  ];

  it.each(OSD_CASES)("round-trips through toOsd/parseSchema (pretty): %s", (text) => {
    const s = parseSchema(text);
    const s2 = parseSchema(toOsd(s));
    expect(schemaEquals(s, s2)).toBe(true);
  });

  it.each(OSD_CASES)("round-trips through toOsd/parseSchema (compact): %s", (text) => {
    const s = parseSchema(text);
    const s2 = parseSchema(toOsd(s, { indent: null }));
    expect(schemaEquals(s, s2)).toBe(true);
  });

  it("pretty-prints with trailing comma, matching the grammar example", () => {
    const s = parseSchema('record R { "a" [0,3]: string? }\nroot R');
    expect(toOsd(s)).toBe('record R {\n    "a" [0,3]: string?,\n}\nroot R\n');
  });

  it("compact form (indent: null) is single-line with no trailing comma", () => {
    const s = parseSchema('record R { "a": string }\nroot R');
    expect(toOsd(s, { indent: null })).toBe('record R { "a": string } root R\n');
  });

  it("compact form exact string for a multi-record schema", () => {
    const s = parseSchema(
      'record Member { "name": string, "role": string }\n' +
        'record Team { "name": string, "members" [1,]: Member, ' +
        '"lead" [0,1]: string }\nroot Team',
    );
    expect(toOsd(s, { indent: null })).toBe(
      'record Member { "name": string, "role": string } ' +
        'record Team { "name": string, "members" [1,]: Member, ' +
        '"lead" [0,1]: string } root Team\n',
    );
  });

  it("round-trips a schema built directly via the builder API", () => {
    const s = schema(ref("Team"), {
      Member: record(field("name", t.string), field("role", t.string, 0, 1)),
      Team: record(
        field("name", t.string),
        field("members", ref("Member"), 1, null),
        field("tags", t.string, 0, null),
        field("data", ANY),
      ),
    });
    const s2 = parseSchema(toOsd(s));
    expect(schemaEquals(s, s2)).toBe(true);
  });
});

describe("model.md Appendix worked example", () => {
  it("parses and validates the Database/Service example", () => {
    const text = `record Database {
    "type":   string,
    "server": string,
    "port":   integer,
}
record Service {
    "host":            string,
    "port":            integer,
    "databases" [1,]:  Database,
    "tags" [0,]:       string,
}
root Service`;
    const s = parseSchema(text);
    const data = {
      host: "api.internal",
      port: 8443n,
      databases: [
        { type: "prod", server: "db1.internal.example.com", port: 5432n },
        { type: "test", server: "db2.internal.example.com", port: 5433n },
      ],
      tags: ["prod", "us-east"],
    };
    const result = s.validate(doc(data));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
