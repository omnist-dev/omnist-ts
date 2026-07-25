/** Executes the exact CLI examples shown in docs/cli.md against the real
 * fixture files in examples/cli/, so the docs can't silently drift from
 * what running them actually produces -- ported from Python's
 * tests/test_cli_examples.py. Assumes cwd is the repo root (vitest's
 * default when run from the package root). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { main } from "../src/cli.js";
import { VERSION } from "../src/index.js";

let outBuf: string[];
let errBuf: string[];

function makeCaptureStream(buf: string[]): NodeJS.WritableStream {
  return { write: (chunk: unknown) => (buf.push(String(chunk)), true) } as unknown as NodeJS.WritableStream;
}

function run(argv: string[], stdin?: string): { code: number; out: string; err: string } {
  outBuf = [];
  errBuf = [];
  const code = main(argv, {
    stdout: makeCaptureStream(outBuf),
    stderr: makeCaptureStream(errBuf),
    ...(stdin !== undefined ? { stdin } : {}),
  });
  return { code, out: outBuf.join(""), err: errBuf.join("") };
}

beforeEach(() => {
  outBuf = [];
  errBuf = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("version and help example", () => {
  it("--version", () => {
    const { code, out } = run(["--version"]);
    expect(code).toBe(0);
    expect(out).toBe(`omnist ${VERSION}\n`);
  });

  it("--help includes the command summary", () => {
    const { code, out } = run(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("omnist");
    expect(out).toContain("format");
    expect(out).toContain("convert");
    expect(out).toContain("check");
    expect(out).toContain("validate");
    expect(out).toContain("infer");
    expect(out).toContain("schema");
  });
});

describe("machine mode --json examples", () => {
  it("check lossy --json", () => {
    const { code, out, err } = run([
      "check",
      "examples/cli/lossy.json",
      "--from",
      "json",
      "--to",
      "toml",
      "--json",
    ]);
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toBe(
      '[{"path": "$.age", "code": "null.omitted", ' +
        '"message": "null value dropped (TOML has no null)", "severity": "warning"}]\n',
    );
  });

  it("convert --strict lossy --json", () => {
    const { code, out, err } = run([
      "convert",
      "examples/cli/lossy.json",
      "--from",
      "json",
      "--to",
      "toml",
      "--strict",
      "--json",
    ]);
    expect(code).toBe(1);
    expect(err).toBe("");
    expect(out).toBe(
      '{"ok": false, "message": "warning: $.age: null value dropped (TOML has no null)", "errors": []}\n',
    );
  });

  it("compatible-with --json", () => {
    const { code, out } = run([
      "schema",
      "compatible-with",
      "examples/cli/v1.osd",
      "examples/cli/v2.osd",
      "--json",
    ]);
    expect(code).toBe(0);
    expect(out).toBe('{"compatible": true}\n');
  });
});

describe("format example", () => {
  it("messy-person.oml reformats", () => {
    const { code, out, err } = run(["format", "examples/cli/messy-person.oml"]);
    expect(code).toBe(0);
    expect(out).toBe('name: "Ann"\nage: 30\n');
    expect(err).toBe("");
  });

  it("pipe example", () => {
    const { code, out } = run(["format", "-"], 'name:   "Ann"');
    expect(code).toBe(0);
    expect(out).toBe('name: "Ann"\n');
  });

  it("messy-person.oml compact", () => {
    const { code, out } = run(["format", "examples/cli/messy-person.oml", "--compact"]);
    expect(code).toBe(0);
    expect(out).toBe('name: "Ann"; age: 30\n');
  });
});

describe("convert examples", () => {
  it("person.json to oml", () => {
    const { code, out } = run(["convert", "examples/cli/person.json", "--from", "json", "--to", "oml"]);
    expect(code).toBe(0);
    expect(out).toBe('person: {\n  name: "Ann"\n  age: 30\n}\n');
  });

  it("person.xml to oml with schema", () => {
    const { code, out } = run([
      "convert",
      "examples/cli/person.xml",
      "--from",
      "xml",
      "--to",
      "oml",
      "--schema",
      "examples/cli/person.osd",
    ]);
    expect(code).toBe(0);
    expect(out).toBe('person: {\n  name: "Ann"\n  age: 30\n}\n');
  });

  it("toml to json via stdin", () => {
    const tomlText = fs.readFileSync("examples/cli/person.toml", "utf-8");
    const { code, out } = run(["convert", "-", "--from", "toml", "--to", "json"], tomlText);
    expect(code).toBe(0);
    expect(out).toBe('{"person": {"name": "Ann", "age": 30}}\n');
  });

  it("report on lossy json to toml", () => {
    const { code, out, err } = run([
      "convert",
      "examples/cli/lossy.json",
      "--from",
      "json",
      "--to",
      "toml",
      "--report",
    ]);
    expect(code).toBe(0);
    expect(out).toBe('name = "Ann"\n');
    expect(err).toBe("warning: $.age: null value dropped (TOML has no null)\n");
  });

  it("strict on lossy json to toml", () => {
    const { code, out, err } = run([
      "convert",
      "examples/cli/lossy.json",
      "--from",
      "json",
      "--to",
      "toml",
      "--strict",
    ]);
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toBe("error: warning: $.age: null value dropped (TOML has no null)\n");
  });
});

describe("check examples", () => {
  it("lossy json to toml", () => {
    const { code, out } = run(["check", "examples/cli/lossy.json", "--from", "json", "--to", "toml"]);
    expect(code).toBe(0);
    expect(out).toBe("warning: $.age: null value dropped (TOML has no null)\n");
  });

  it("lossy json to toml strict", () => {
    const { code, out } = run([
      "check",
      "examples/cli/lossy.json",
      "--from",
      "json",
      "--to",
      "toml",
      "--strict",
    ]);
    expect(code).toBe(1);
    expect(out).toBe("warning: $.age: null value dropped (TOML has no null)\n");
  });
});

describe("infer example", () => {
  it("sample1 + sample2", () => {
    const { code, out } = run([
      "infer",
      "examples/cli/sample1.json",
      "examples/cli/sample2.json",
      "--from",
      "json",
    ]);
    expect(code).toBe(0);
    expect(out).toBe('record Root {\n    "name": string,\n    "age" [0,1]: integer,\n}\nroot Root\n');
  });
});

describe("infer allow-any example", () => {
  it("messy1 + messy2 --allow-any", () => {
    const { code, out, err } = run([
      "infer",
      "examples/cli/messy1.json",
      "examples/cli/messy2.json",
      "--from",
      "json",
      "--allow-any",
    ]);
    expect(code).toBe(0);
    expect(out).toBe('record Root {\n    "data": any,\n    "score": any,\n}\nroot Root\n');
    expect(err).toBe(
      "opened 2 field(s) as `any`:\n" +
        "  Root.data — mixes objects and values\n" +
        "  Root.score — values of more than one scalar kind (integer, string)\n",
    );
  });
});

describe("validate examples", () => {
  it("person.json is valid", () => {
    const { code, out } = run([
      "validate",
      "examples/cli/person.json",
      "--from",
      "json",
      "--schema",
      "examples/cli/person.osd",
    ]);
    expect(code).toBe(0);
    expect(out).toBe("valid\n");
  });

  it("invalid-person.json, text", () => {
    const { code, out } = run([
      "validate",
      "examples/cli/invalid-person.json",
      "--from",
      "json",
      "--schema",
      "examples/cli/person.osd",
    ]);
    expect(code).toBe(1);
    expect(out).toBe(
      "invalid:\n" +
        '  at $.person.age: expected integer, got string ("thirty")\n' +
        '  at $.person: field "name" occurs 0 time(s), expected exactly 1\n',
    );
  });

  it("invalid-person.json, result-format json", () => {
    const { code, out } = run([
      "validate",
      "examples/cli/invalid-person.json",
      "--from",
      "json",
      "--schema",
      "examples/cli/person.osd",
      "--result-format",
      "json",
    ]);
    expect(code).toBe(1);
    expect(out).toBe(
      '{"ok": false, "errors": [' +
        '{"path": "$.person.age", "message": "expected integer, got string (\\"thirty\\")"}, ' +
        '{"path": "$.person", "message": "field \\"name\\" occurs 0 time(s), expected exactly 1"}' +
        "]}\n",
    );
  });

  it("person.json --json", () => {
    const { code, out } = run([
      "validate",
      "examples/cli/person.json",
      "--from",
      "json",
      "--schema",
      "examples/cli/person.osd",
      "--json",
    ]);
    expect(code).toBe(0);
    expect(out).toBe('{"ok": true}\n');
  });

  it("invalid-person.json --json", () => {
    const { code, out } = run([
      "validate",
      "examples/cli/invalid-person.json",
      "--from",
      "json",
      "--schema",
      "examples/cli/person.osd",
      "--json",
    ]);
    expect(code).toBe(1);
    expect(out).toBe(
      '{"ok": false, "message": "invalid:\\n' +
        '  at $.person.age: expected integer, got string (\\"thirty\\")\\n' +
        '  at $.person: field \\"name\\" occurs 0 time(s), expected exactly 1", ' +
        '"errors": [' +
        '{"path": "$.person.age", "code": "type-mismatch", ' +
        '"message": "expected integer, got string (\\"thirty\\")"}, ' +
        '{"path": "$.person", "code": "cardinality", ' +
        '"message": "field \\"name\\" occurs 0 time(s), expected exactly 1"}' +
        "]}\n",
    );
  });

  it("syntax failure --json via stdin", () => {
    const { code, out } = run(
      ["validate", "-", "--from", "json", "--schema", "examples/cli/person.osd", "--json"],
      "{not valid json",
    );
    expect(code).toBe(2);
    // The exact JS engine's JSON.parse error text isn't part of the
    // stability contract (only `code` values and exit codes are pinned,
    // per docs/stability.md) -- assert the stable shape and exit code,
    // not the engine-specific parse-error wording.
    const payload = JSON.parse(out) as { ok: boolean; message: string; errors: unknown[] };
    expect(payload.ok).toBe(false);
    expect(payload.message).toContain("invalid JSON");
    expect(payload.errors).toEqual([]);
  });
});

describe("schema format example", () => {
  it("messy-person.osd reformats", () => {
    const { code, out } = run(["schema", "format", "examples/cli/messy-person.osd"]);
    expect(code).toBe(0);
    expect(out).toBe('record Person {\n    "name": string,\n    "age" [0,1]: integer,\n}\nroot Person\n');
  });

  it("messy-person.osd compact", () => {
    const { code, out } = run(["schema", "format", "examples/cli/messy-person.osd", "--compact"]);
    expect(code).toBe(0);
    expect(out).toBe('record Person { "name": string, "age" [0,1]: integer } root Person\n');
  });
});

describe("schema prune example", () => {
  it("prune via stdin", () => {
    const { code, out } = run(
      ["schema", "prune", "-"],
      'record R { "x": integer, "ghost" [0,0]: string }\nrecord Orphan { "y": string }\nroot R\n',
    );
    expect(code).toBe(0);
    expect(out).toBe('record R {\n    "x": integer,\n}\nroot R\n');
  });
});

describe("schema is-empty example", () => {
  it("is-empty via stdin", () => {
    const { code, out } = run(
      ["schema", "is-empty", "-"],
      'record A { "x": B }\nrecord B { "y": A }\nroot A\n',
    );
    expect(code).toBe(0);
    expect(out).toBe("true\n");
  });
});

describe("schema lint example", () => {
  it("duplicate-records.osd", () => {
    const { code, out } = run(["schema", "lint", "examples/cli/duplicate-records.osd"]);
    expect(code).toBe(1);
    expect(out).toBe(
      "warning: duplicate-record: Customer, Employee: records " +
        '"Employee" are structurally identical to "Customer"; ' +
        "merge them with `schema normalize`\n",
    );
  });
});

describe("schema normalize example", () => {
  it("merges duplicate records", () => {
    const { code, out } = run(["schema", "normalize", "examples/cli/duplicate-records.osd"]);
    expect(code).toBe(0);
    expect(out).toBe(
      'record Company {\n' +
        '    "employee": Customer,\n' +
        '    "customer": Customer,\n' +
        "}\n" +
        "record Customer {\n" +
        '    "name": string,\n' +
        "}\n" +
        "root Company\n",
    );
  });
});

describe("schema extract example", () => {
  it("quote-order.osd drops order side", () => {
    const { code, out } = run([
      "schema",
      "extract",
      "examples/cli/quote-order.osd",
      "--keep",
      "quote,line,desc,price",
    ]);
    expect(code).toBe(0);
    expect(out).toBe(
      'record Line {\n' +
        '    "desc": string,\n' +
        '    "price": number,\n' +
        "}\n" +
        "record Quote {\n" +
        '    "line" [1,]: Line,\n' +
        "}\n" +
        "record Root {\n" +
        '    "quote" [0,1]: Quote,\n' +
        "}\n" +
        "root Root\n",
    );
  });

  it("mandatory deletion error via stdin", () => {
    const { code, out, err } = run(
      ["schema", "extract", "-", "--keep", "opt"],
      'record R { "must": integer, "opt" [0,1]: string }\nroot R\n',
    );
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toBe(
      'error: no valid subschema: removing label "must" deletes a mandatory field of record "R"\n',
    );
  });
});

describe("schema compatible-with example", () => {
  it("v1 compatible with v2", () => {
    const { code, out } = run(["schema", "compatible-with", "examples/cli/v1.osd", "examples/cli/v2.osd"]);
    expect(code).toBe(0);
    expect(out).toBe("true\n");
  });
});

describe("schema equivalent example", () => {
  it("v1 not equivalent to v2", () => {
    const { code, out } = run(["schema", "equivalent", "examples/cli/v1.osd", "examples/cli/v2.osd"]);
    expect(code).toBe(1);
    expect(out).toBe("false\n");
  });
});
