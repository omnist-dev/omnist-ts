import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { main } from "../src/cli.js";

// In-process harness mirroring the Python suite's `run(argv, stdin, capsys)`:
// stdout/stderr are captured via writable streams passed to main(); stdin is
// injected via main()'s own `opts.stdin` (see cli.ts's readInput doc comment
// for why this beats spying on fs.readFileSync for a "-" argument).
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

function writeTmp(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omnist-cli-"));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, "utf-8");
  return p;
}

describe("format", () => {
  it("arrays flag collapses repeated labels", () => {
    const p = writeTmp("in.oml", "b: 1\nb: 2\nb: 3\n");
    const { code, out } = run(["format", p, "--arrays"]);
    expect(code).toBe(0);
    expect(out).toBe("b: [1, 2, 3]\n");
  });

  it("without arrays flag leaves repeated labels alone", () => {
    const p = writeTmp("in.oml", "b: 1\nb: 2\nb: 3\n");
    const { code, out } = run(["format", p]);
    expect(code).toBe(0);
    expect(out).toBe("b: 1\nb: 2\nb: 3\n");
  });

  it("reformats oml from file to stdout", () => {
    const p = writeTmp("in.oml", 'a: 1\nb: "x"\n');
    const { code, out, err } = run(["format", p]);
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toBe('a: 1\nb: "x"\n');
  });

  it("writes to output file", () => {
    const src = writeTmp("in.oml", "a: 1\n");
    const dst = src + ".out";
    const { code, out } = run(["format", src, "-o", dst]);
    expect(code).toBe(0);
    expect(out).toBe("");
    expect(fs.readFileSync(dst, "utf-8")).toBe("a: 1\n");
  });

  it("reads from stdin", () => {
    const { code, out } = run(["format", "-"], "a: 1\n");
    expect(code).toBe(0);
    expect(out).toBe("a: 1\n");
  });

  it("round-trips canonically even if messy", () => {
    const p = writeTmp("in.oml", 'a:   1\nb:"x"\n');
    const { code, out } = run(["format", p]);
    expect(code).toBe(0);
    expect(out).toBe('a: 1\nb: "x"\n');
  });

  it("invalid oml is a clean error, not a traceback", () => {
    const p = writeTmp("bad.oml", "a: [[1, 2]]\n");
    const { code, out, err } = run(["format", p]);
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err.startsWith("error: ")).toBe(true);
  });

  it("missing file is a clean error", () => {
    const { code, err } = run(["format", "/nonexistent/nope.oml"]);
    expect(code).toBe(2);
    expect(err.startsWith("error: ")).toBe(true);
  });

  it("missing input argument is a usage error", () => {
    const { code } = run(["format"]);
    expect(code).toBe(2);
  });

  it("compact flag emits single-line output", () => {
    const p = writeTmp("in.oml", "a: 1\nb: { x: 1; y: 2 }\n");
    const { code, out } = run(["format", p, "--compact"]);
    expect(code).toBe(0);
    expect(out).toBe("a: 1; b: { x: 1; y: 2 }\n");
  });
});

describe("convert", () => {
  it("json to yaml", () => {
    const p = writeTmp("in.json", '{"a": 1}');
    const { code, out, err } = run(["convert", p, "--from", "json", "--to", "yaml"]);
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toBe("a: 1\n");
  });

  it("json to oml", () => {
    const p = writeTmp("in.json", '{"a": 1, "b": "x"}');
    const { code, out } = run(["convert", p, "--from", "json", "--to", "oml"]);
    expect(code).toBe(0);
    expect(out).toBe('a: 1\nb: "x"\n');
  });

  it("json to oml compact", () => {
    const p = writeTmp("in.json", '{"a": 1, "b": "x"}');
    const { code, out } = run(["convert", p, "--from", "json", "--to", "oml", "--compact"]);
    expect(code).toBe(0);
    expect(out).toBe('a: 1; b: "x"\n');
  });

  it("convert to oml with arrays flag collapses repeated labels", () => {
    const p = writeTmp("in.xml", "<root><b>1</b><b>2</b><b>3</b></root>");
    const { code, out } = run(["convert", p, "--from", "xml", "--to", "oml", "--arrays"]);
    expect(code).toBe(0);
    // issue #88: a schema-less XML read no longer coerces numeric-looking
    // element text to a number -- "1"/"2"/"3" stay strings.
    expect(out).toBe('root: {\n  b: ["1", "2", "3"]\n}\n');
  });

  it("writes to output file", () => {
    const src = writeTmp("in.json", '{"a": 1}');
    const dst = src + ".yaml";
    const { code, out } = run(["convert", src, "--from", "json", "--to", "yaml", "-o", dst]);
    expect(code).toBe(0);
    expect(out).toBe("");
    expect(fs.readFileSync(dst, "utf-8")).toBe("a: 1\n");
  });

  it("reads from stdin", () => {
    const { code, out } = run(["convert", "-", "--from", "json", "--to", "yaml"], '{"a": 1}');
    expect(code).toBe(0);
    expect(out).toBe("a: 1\n");
  });

  it("same format other than oml is allowed", () => {
    const p = writeTmp("in.json", '{"a":   1}');
    const { code, out } = run(["convert", p, "--from", "json", "--to", "json"]);
    expect(code).toBe(0);
    expect(out).toBe('{"a": 1}\n');
  });

  it("oml to oml is rejected", () => {
    const p = writeTmp("in.oml", "a: 1\n");
    const { code, out, err } = run(["convert", p, "--from", "oml", "--to", "oml"]);
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toContain("use `omnist format` instead");
  });

  it("schema-directed upgrade", () => {
    const p = writeTmp("in.json", '{"d": "2024-01-01"}');
    const schemaF = writeTmp("s.osd", 'record R { "d": date }\nroot R\n');
    const { code, out } = run(["convert", p, "--from", "json", "--to", "oml", "--schema", schemaF]);
    expect(code).toBe(0);
    expect(out).toBe("d: 2024-01-01\n");
  });

  it("schema conformance failure is a clean error", () => {
    const p = writeTmp("in.json", '{"a": 1, "b": "extra"}');
    const schemaF = writeTmp("s.osd", 'record R { "a": integer }\nroot R\n');
    const { code, out, err } = run(["convert", p, "--from", "json", "--to", "oml", "--schema", schemaF]);
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err.startsWith("error: ")).toBe(true);
  });

  it("multi-root to xml is a clean error, not a traceback", () => {
    const p = writeTmp("in.json", '{"a": 1, "b": 2}');
    const { code, err } = run(["convert", p, "--from", "json", "--to", "xml"]);
    expect(code).toBe(2);
    expect(err.startsWith("error: ")).toBe(true);
  });

  it("missing --to is a usage error", () => {
    const p = writeTmp("in.json", '{"a": 1}');
    const { code } = run(["convert", p, "--from", "json"]);
    expect(code).toBe(2);
  });

  it("unknown --to value is a usage error", () => {
    const p = writeTmp("in.json", '{"a": 1}');
    const { code } = run(["convert", p, "--from", "json", "--to", "bogus"]);
    expect(code).toBe(2);
  });

  it("malformed input is a clean error, not a traceback", () => {
    const p = writeTmp("in.json", "{not valid json");
    const { code, err } = run(["convert", p, "--from", "json", "--to", "yaml"]);
    expect(code).toBe(2);
    expect(err.startsWith("error: ")).toBe(true);
  });
});

describe("convert report/strict", () => {
  it("report writes and prints adjustment to stderr", () => {
    const p = writeTmp("in.json", '{"a": null}');
    const dst = p + ".toml";
    const { code, out, err } = run(["convert", p, "--from", "json", "--to", "toml", "--report", "-o", dst]);
    expect(code).toBe(0);
    expect(out).toBe("");
    expect(err).toContain("null");
    expect(fs.existsSync(dst)).toBe(true);
  });

  it("report with no adjustments still prints", () => {
    const p = writeTmp("in.json", '{"a": 1}');
    const { code, err } = run(["convert", p, "--from", "json", "--to", "yaml", "--report"]);
    expect(code).toBe(0);
    expect(err).toBe("no adjustments\n");
  });

  it("report result-format json", () => {
    const p = writeTmp("in.json", '{"a": null}');
    const { code, err } = run(["convert", p, "--from", "json", "--to", "toml", "--report", "--result-format", "json"]);
    expect(code).toBe(0);
    expect(err.startsWith("[{")).toBe(true);
    expect(err).toContain('"code"');
  });

  it("result-format without report has no effect", () => {
    const p = writeTmp("in.json", '{"a": null}');
    const { code, err } = run(["convert", p, "--from", "json", "--to", "toml", "--result-format", "json"]);
    expect(code).toBe(0);
    expect(err).toBe("");
  });

  it("strict refuses lossy write, exit 1", () => {
    const p = writeTmp("in.json", '{"a": null}');
    const dst = p + ".toml";
    const { code, out, err } = run(["convert", p, "--from", "json", "--to", "toml", "--strict", "-o", dst]);
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(fs.existsSync(dst)).toBe(false);
    expect(err.startsWith("error: ")).toBe(true);
  });

  it("strict succeeds when nothing to adjust", () => {
    const p = writeTmp("in.json", '{"a": 1}');
    const { code, out } = run(["convert", p, "--from", "json", "--to", "yaml", "--strict"]);
    expect(code).toBe(0);
    expect(out).toBe("a: 1\n");
  });

  it("strict to oml never fails since oml is always lossless", () => {
    const p = writeTmp("in.json", '{"a": null}');
    const { code } = run(["convert", p, "--from", "json", "--to", "oml", "--strict"]);
    expect(code).toBe(0);
  });

  it("multi-root to xml strict is still exit 2, not 1", () => {
    const p = writeTmp("in.json", '{"a": 1, "b": 2}');
    const { code, err } = run(["convert", p, "--from", "json", "--to", "xml", "--strict"]);
    expect(code).toBe(2);
    expect(err.startsWith("error: ")).toBe(true);
  });
});

describe("check", () => {
  it("reports without writing, exit always 0 by default", () => {
    const p = writeTmp("in.json", '{"a": null}');
    const { code, out, err } = run(["check", p, "--from", "json", "--to", "toml"]);
    expect(code).toBe(0);
    expect(out).toContain("null");
    expect(err).toBe("");
  });

  it("report result-format oml", () => {
    const p = writeTmp("in.json", '{"a": null}');
    const { code, out } = run(["check", p, "--from", "json", "--to", "toml", "--result-format", "oml"]);
    expect(code).toBe(0);
    expect(out).toContain("adjustments");
    expect(out).toContain("null");
  });

  it("no adjustments prints no adjustments", () => {
    const p = writeTmp("in.json", '{"a": 1}');
    const { code, out } = run(["check", p, "--from", "json", "--to", "yaml"]);
    expect(code).toBe(0);
    expect(out).toBe("no adjustments\n");
  });

  it("same format is allowed", () => {
    const p = writeTmp("in.json", '{"a": 1}');
    const { code, out } = run(["check", p, "--from", "json", "--to", "json"]);
    expect(code).toBe(0);
    expect(out).toBe("no adjustments\n");
  });

  it("strict exits 1 when something would adjust", () => {
    const p = writeTmp("in.json", '{"a": null}');
    const { code } = run(["check", p, "--from", "json", "--to", "toml", "--strict"]);
    expect(code).toBe(1);
  });

  it("strict exits 0 when nothing would adjust", () => {
    const p = writeTmp("in.json", '{"a": 1}');
    const { code } = run(["check", p, "--from", "json", "--to", "toml", "--strict"]);
    expect(code).toBe(0);
  });

  it("without strict always exits 0 even with adjustments", () => {
    const p = writeTmp("in.json", '{"a": null}');
    const { code } = run(["check", p, "--from", "json", "--to", "toml"]);
    expect(code).toBe(0);
  });

  it("result-format json", () => {
    const p = writeTmp("in.json", '{"a": null}');
    const { code, out } = run(["check", p, "--from", "json", "--to", "toml", "--result-format", "json"]);
    expect(code).toBe(0);
    expect(out.startsWith("[{")).toBe(true);
  });

  it("does not write anything: -o is rejected", () => {
    const p = writeTmp("in.json", '{"a": 1}');
    const { code } = run(["check", p, "--from", "json", "--to", "toml", "-o", "x.toml"]);
    expect(code).toBe(2);
  });

  it("malformed input is a clean error", () => {
    const p = writeTmp("in.json", "{not valid json");
    const { code, err } = run(["check", p, "--from", "json", "--to", "toml"]);
    expect(code).toBe(2);
    expect(err.startsWith("error: ")).toBe(true);
  });
});

describe("validate", () => {
  const SCHEMA = 'record R { "a": integer }\nroot R\n';

  it("valid document exits 0, text", () => {
    const docF = writeTmp("d.json", '{"a": 1}');
    const schemaF = writeTmp("s.osd", SCHEMA);
    const { code, out, err } = run(["validate", docF, "--from", "json", "--schema", schemaF]);
    expect(code).toBe(0);
    expect(out).toBe("valid\n");
    expect(err).toBe("");
  });

  it("invalid document exits 1, text", () => {
    const docF = writeTmp("d.json", '{"a": 1, "b": "extra"}');
    const schemaF = writeTmp("s.osd", SCHEMA);
    const { code, out } = run(["validate", docF, "--from", "json", "--schema", schemaF]);
    expect(code).toBe(1);
    expect(out).toBe("invalid:\n  at $.b: unexpected field\n");
  });

  it("result-format json", () => {
    const docF = writeTmp("d.json", '{"a": 1, "b": "extra"}');
    const schemaF = writeTmp("s.osd", SCHEMA);
    const { code, out } = run(["validate", docF, "--from", "json", "--schema", schemaF, "--result-format", "json"]);
    expect(code).toBe(1);
    expect(out).toBe('{"ok": false, "errors": [{"path": "$.b", "message": "unexpected field"}]}\n');
  });

  it("result-format oml", () => {
    const docF = writeTmp("d.json", '{"a": 1}');
    const schemaF = writeTmp("s.osd", SCHEMA);
    const { code, out } = run(["validate", docF, "--from", "json", "--schema", schemaF, "--result-format", "oml"]);
    expect(code).toBe(0);
    expect(out).toBe("ok: true\n");
  });

  it("does not upgrade scalars", () => {
    const docF = writeTmp("d.json", '{"d": "2024-01-01"}');
    const schemaF = writeTmp("s.osd", 'record R { "d": date }\nroot R\n');
    const { code, out } = run(["validate", docF, "--from", "json", "--schema", schemaF]);
    expect(code).toBe(0);
    expect(out).toBe("valid\n");
  });

  it("unknown --from value is a usage error", () => {
    const docF = writeTmp("d.json", '{"a": 1}');
    const { code } = run(["validate", docF, "--from", "bogus", "--schema", "s.osd"]);
    expect(code).toBe(2);
  });

  it("missing --schema is a usage error", () => {
    const docF = writeTmp("d.json", '{"a": 1}');
    const { code } = run(["validate", docF, "--from", "json"]);
    expect(code).toBe(2);
  });

  it("malformed input is a clean error, not a traceback", () => {
    const docF = writeTmp("d.json", "{not valid json");
    const schemaF = writeTmp("s.osd", SCHEMA);
    const { code, err } = run(["validate", docF, "--from", "json", "--schema", schemaF]);
    expect(code).toBe(2);
    expect(err.startsWith("error: ")).toBe(true);
  });

  it("malformed schema is a clean error, not a traceback", () => {
    const docF = writeTmp("d.json", '{"a": 1}');
    const schemaF = writeTmp("s.osd", 'record R { "a": integer }\n');
    const { code, err } = run(["validate", docF, "--from", "json", "--schema", schemaF]);
    expect(code).toBe(2);
    expect(err.startsWith("error: ")).toBe(true);
  });

  it("--json flag valid document", () => {
    const docF = writeTmp("d.json", '{"a": 1}');
    const schemaF = writeTmp("s.osd", SCHEMA);
    const { code, out, err } = run(["validate", docF, "--from", "json", "--schema", schemaF, "--json"]);
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(JSON.parse(out)).toEqual({ ok: true });
  });

  it("--json flag conformance failure reports every error", () => {
    const docF = writeTmp("d.json", '{"b": "extra"}');
    const schemaF = writeTmp("s.osd", SCHEMA);
    const { code, out, err } = run(["validate", docF, "--from", "json", "--schema", schemaF, "--json"]);
    expect(code).toBe(1);
    expect(err).toBe("");
    const payload = JSON.parse(out);
    expect(payload.ok).toBe(false);
    expect(typeof payload.message).toBe("string");
    expect(payload.message.length).toBeGreaterThan(0);
    const errors: Record<string, string> = {};
    for (const e of payload.errors) errors[`${e.path}|${e.code}`] = e.message;
    expect(errors["$.b|unexpected-field"]).toBe("unexpected field");
    expect(errors["$|cardinality"]).toBe('field "a" occurs 0 time(s), expected exactly 1');
    expect(payload.errors.length).toBe(2);
  });

  it("--json flag syntax failure has empty errors", () => {
    const docF = writeTmp("d.json", "{not valid json");
    const schemaF = writeTmp("s.osd", SCHEMA);
    const { code, out, err } = run(["validate", docF, "--from", "json", "--schema", schemaF, "--json"]);
    expect(code).toBe(2);
    expect(err).toBe("");
    const payload = JSON.parse(out);
    expect(payload.ok).toBe(false);
    expect(payload.errors).toEqual([]);
    expect(payload.message).toContain("invalid JSON");
  });

  it("default output unchanged when --json absent", () => {
    const docF = writeTmp("d.json", '{"a": 1, "b": "extra"}');
    const schemaF = writeTmp("s.osd", SCHEMA);
    const { code, out, err } = run(["validate", docF, "--from", "json", "--schema", schemaF]);
    expect(code).toBe(1);
    expect(out).toBe("invalid:\n  at $.b: unexpected field\n");
    expect(err).toBe("");
  });

  it("--json flag with a malformed schema (SchemaError) is a clean json error", () => {
    const docF = writeTmp("d.json", '{"a": 1}');
    const schemaF = writeTmp("s.osd", 'record R { "a": integer }\n'); // no root
    const { code, out, err } = run(["validate", docF, "--from", "json", "--schema", schemaF, "--json"]);
    expect(code).toBe(2);
    expect(err).toBe("");
    const payload = JSON.parse(out);
    expect(payload.ok).toBe(false);
    expect(payload.errors).toEqual([]);
  });

  it("--json flag with a missing document file is a clean json error", () => {
    const schemaF = writeTmp("s.osd", SCHEMA);
    const { code, out, err } = run(["validate", "/nonexistent/nope.json", "--from", "json", "--schema", schemaF, "--json"]);
    expect(code).toBe(2);
    expect(err).toBe("");
    const payload = JSON.parse(out);
    expect(payload.ok).toBe(false);
  });
});

describe("infer", () => {
  it("drafts schema from multiple samples", () => {
    const f1 = writeTmp("a.json", '{"host": "a"}');
    const f2 = writeTmp("b.json", '{"host": "b", "port": 80}');
    const { code, out, err } = run(["infer", f1, f2, "--from", "json"]);
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toContain('"host": string');
    expect(out).toContain('"port" [0,1]: integer');
    expect(out.startsWith("record Root {")).toBe(true);
  });

  it("single sample", () => {
    const f1 = writeTmp("a.json", '{"x": 1}');
    const { code, out } = run(["infer", f1, "--from", "json"]);
    expect(code).toBe(0);
    expect(out).toContain('"x": integer');
  });

  it("writes to output file", () => {
    const f1 = writeTmp("a.json", '{"x": 1}');
    const dst = f1 + ".osd";
    const { code, out } = run(["infer", f1, "--from", "json", "-o", dst]);
    expect(code).toBe(0);
    expect(out).toBe("");
    expect(fs.readFileSync(dst, "utf-8")).toContain('"x": integer');
  });

  it("conflicting scalars is a clean error, not a traceback", () => {
    const f1 = writeTmp("a.json", '{"v": 1}');
    const f2 = writeTmp("b.json", '{"v": "x"}');
    const { code, err } = run(["infer", f1, f2, "--from", "json"]);
    expect(code).toBe(2);
    expect(err.startsWith("error: ")).toBe(true);
  });

  it("missing input is a usage error", () => {
    const { code } = run(["infer", "--from", "json"]);
    expect(code).toBe(2);
  });

  it("missing --from is a usage error", () => {
    const f1 = writeTmp("a.json", '{"x": 1}');
    const { code } = run(["infer", f1]);
    expect(code).toBe(2);
  });

  it("compact flag emits single-line osd", () => {
    const f1 = writeTmp("a.json", '{"x": 1}');
    const { code, out } = run(["infer", f1, "--from", "json", "--compact"]);
    expect(code).toBe(0);
    expect(out.trim()).not.toContain("\n");
    expect(out).toContain('"x": integer');
  });

  it("allow-any opens conflict, schema on stdout, report on stderr", () => {
    const f1 = writeTmp("a.json", '{"v": 1, "data": {"x": 1}}');
    const f2 = writeTmp("b.json", '{"v": "x", "data": 5}');
    const { code, out, err } = run(["infer", f1, f2, "--from", "json", "--allow-any"]);
    expect(code).toBe(0);
    expect(out.startsWith("record Root {")).toBe(true);
    expect(out).toContain(": any,");
    expect(err).toContain("opened 2 field(s) as `any`:");
    expect(err).toContain("Root.data — mixes objects and values");
    expect(err).toContain("Root.v — values of more than one scalar kind (integer, string)");
  });

  it("allow-any with clean samples prints no report", () => {
    const f1 = writeTmp("a.json", '{"x": 1}');
    const { code, out, err } = run(["infer", f1, "--from", "json", "--allow-any"]);
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toContain('"x": integer');
  });

  it("without allow-any conflict still errors", () => {
    const f1 = writeTmp("a.json", '{"v": 1}');
    const f2 = writeTmp("b.json", '{"v": "x"}');
    const { code, err } = run(["infer", f1, f2, "--from", "json"]);
    expect(code).toBe(2);
    expect(err.startsWith("error: ")).toBe(true);
  });

  it("--arrays flag is rejected", () => {
    const f1 = writeTmp("a.json", '{"x": 1}');
    const { code, out, err } = run(["infer", f1, "--from", "json", "--arrays"]);
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toBe("error: --arrays applies only to OML output (format, convert --to oml)\n");
  });
});

describe("schema format", () => {
  it("reformats osd from file to stdout", () => {
    const p = writeTmp("in.osd", 'record R { "a": integer }\nroot R\n');
    const { code, out, err } = run(["schema", "format", p]);
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toBe('record R {\n    "a": integer,\n}\nroot R\n');
  });

  it("writes to output file", () => {
    const src = writeTmp("in.osd", 'record R { "a": integer }\nroot R\n');
    const dst = src + ".out";
    const { code, out } = run(["schema", "format", src, "-o", dst]);
    expect(code).toBe(0);
    expect(out).toBe("");
    expect(fs.readFileSync(dst, "utf-8")).toBe('record R {\n    "a": integer,\n}\nroot R\n');
  });

  it("reads from stdin", () => {
    const { code, out } = run(["schema", "format", "-"], 'record R { "a": integer }\nroot R\n');
    expect(code).toBe(0);
    expect(out).toBe('record R {\n    "a": integer,\n}\nroot R\n');
  });

  it("invalid osd is a clean error, not a traceback", () => {
    const p = writeTmp("bad.osd", 'record R { "a": integer }\n');
    const { code, out, err } = run(["schema", "format", p]);
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err.startsWith("error: ")).toBe(true);
  });

  it("missing schema-file argument is a usage error", () => {
    const { code } = run(["schema", "format"]);
    expect(code).toBe(2);
  });

  it("missing schema subcommand is a usage error", () => {
    const { code } = run(["schema"]);
    expect(code).toBe(2);
  });

  it("compact flag emits single-line output", () => {
    const p = writeTmp("in.osd", 'record R { "a": integer }\nroot R\n');
    const { code, out } = run(["schema", "format", p, "--compact"]);
    expect(code).toBe(0);
    expect(out).toBe('record R { "a": integer } root R\n');
  });

  it("--arrays flag is rejected", () => {
    const p = writeTmp("in.osd", 'record R { "a": integer }\nroot R\n');
    const { code, out, err } = run(["schema", "format", p, "--arrays"]);
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toBe("error: --arrays applies only to OML output (format, convert --to oml)\n");
  });
});

describe("schema normalize", () => {
  it("merges structurally identical records", () => {
    const p = writeTmp(
      "in.osd",
      'record A { "x": integer }\nrecord B { "x": integer }\nrecord R { "a": A, "b": B }\nroot R\n',
    );
    const { code, out, err } = run(["schema", "normalize", p]);
    expect(code).toBe(0);
    expect(err).toBe("");
    expect((out.match(/record /g) ?? []).length).toBe(2);
  });

  it("writes to output file", () => {
    const src = writeTmp("in.osd", 'record R { "a": integer }\nroot R\n');
    const dst = src + ".out";
    const { code } = run(["schema", "normalize", src, "-o", dst]);
    expect(code).toBe(0);
    expect(fs.readFileSync(dst, "utf-8")).toBe('record R {\n    "a": integer,\n}\nroot R\n');
  });

  it("invalid osd is a clean error", () => {
    const p = writeTmp("bad.osd", 'record R { "a": integer }\n');
    const { code, err } = run(["schema", "normalize", p]);
    expect(code).toBe(2);
    expect(err.startsWith("error: ")).toBe(true);
  });

  it("compact flag emits single-line output", () => {
    const p = writeTmp("in.osd", 'record R { "a": integer }\nroot R\n');
    const { code, out } = run(["schema", "normalize", p, "--compact"]);
    expect(code).toBe(0);
    expect(out).toBe('record R { "a": integer } root R\n');
  });

  it("--arrays flag is rejected", () => {
    const p = writeTmp("in.osd", 'record R { "a": integer }\nroot R\n');
    const { code, out, err } = run(["schema", "normalize", p, "--arrays"]);
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toBe("error: --arrays applies only to OML output (format, convert --to oml)\n");
  });
});

describe("schema extract", () => {
  it("happy path", () => {
    const p = writeTmp("in.osd", 'record R { "must": integer, "opt" [0,1]: string }\nroot R\n');
    const { code, out, err } = run(["schema", "extract", p, "--keep", "must"]);
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toBe('record R {\n    "must": integer,\n}\nroot R\n');
  });

  it("multiple keep labels", () => {
    const p = writeTmp("in.osd", 'record R { "a": integer, "b": string, "c" [0,1]: integer }\nroot R\n');
    const { code, out } = run(["schema", "extract", p, "--keep", "a,b"]);
    expect(code).toBe(0);
    expect(out).toBe('record R {\n    "a": integer,\n    "b": string,\n}\nroot R\n');
  });

  it("compact flag emits single-line output", () => {
    const p = writeTmp("in.osd", 'record R { "a": integer }\nroot R\n');
    const { code, out } = run(["schema", "extract", p, "--keep", "a", "--compact"]);
    expect(code).toBe(0);
    expect(out).toBe('record R { "a": integer } root R\n');
  });

  it("writes to output file", () => {
    const src = writeTmp("in.osd", 'record R { "a": integer }\nroot R\n');
    const dst = src + ".out";
    const { code, out } = run(["schema", "extract", src, "--keep", "a", "-o", dst]);
    expect(code).toBe(0);
    expect(out).toBe("");
    expect(fs.readFileSync(dst, "utf-8")).toBe('record R {\n    "a": integer,\n}\nroot R\n');
  });

  it("mandatory deletion is exit 1, not 2", () => {
    const p = writeTmp("in.osd", 'record R { "must": integer, "opt" [0,1]: string }\nroot R\n');
    const { code, out, err } = run(["schema", "extract", p, "--keep", "opt"]);
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toBe('error: no valid subschema: removing label "must" deletes a mandatory field of record "R"\n');
  });

  it("missing --keep is a usage error", () => {
    const p = writeTmp("in.osd", 'record R { "a": integer }\nroot R\n');
    const { code } = run(["schema", "extract", p]);
    expect(code).toBe(2);
  });

  it("invalid osd is a clean error", () => {
    const p = writeTmp("bad.osd", 'record R { "a": integer }\n');
    const { code, err } = run(["schema", "extract", p, "--keep", "a"]);
    expect(code).toBe(2);
    expect(err.startsWith("error: ")).toBe(true);
  });

  it("empty keep extracts nothing", () => {
    const p = writeTmp("in.osd", 'record R { "opt" [0,1]: string }\nroot R\n');
    const { code, out } = run(["schema", "extract", p, "--keep", ""]);
    expect(code).toBe(0);
    expect(out).toBe("record R {\n}\nroot R\n");
  });
});

describe("schema compatible-with", () => {
  const V1 = 'record R { "host": string }\nroot R\n';
  const V2 = 'record R { "host": string, "port" [0,1]: integer }\nroot R\n';

  it("compatible, text", () => {
    const a = writeTmp("v1.osd", V1);
    const b = writeTmp("v2.osd", V2);
    const { code, out } = run(["schema", "compatible-with", a, b]);
    expect(code).toBe(0);
    expect(out).toBe("true\n");
  });

  it("incompatible, text", () => {
    const a = writeTmp("v2.osd", V2);
    const b = writeTmp("v1.osd", V1);
    const { code, out } = run(["schema", "compatible-with", a, b]);
    expect(code).toBe(1);
    expect(out).toBe("false\n");
  });

  it("result-format json", () => {
    const a = writeTmp("v1.osd", V1);
    const b = writeTmp("v2.osd", V2);
    const { code, out } = run(["schema", "compatible-with", a, b, "--result-format", "json"]);
    expect(code).toBe(0);
    expect(out).toBe('{"compatible": true}\n');
  });

  it("result-format oml", () => {
    const a = writeTmp("v1.osd", V1);
    const b = writeTmp("v2.osd", V2);
    const { code, out } = run(["schema", "compatible-with", a, b, "--result-format", "oml"]);
    expect(code).toBe(0);
    expect(out).toBe("compatible: true\n");
  });

  it("malformed schema is a clean error", () => {
    const a = writeTmp("bad.osd", 'record R { "a": integer }\n');
    const b = writeTmp("v1.osd", V1);
    const { code, err } = run(["schema", "compatible-with", a, b]);
    expect(code).toBe(2);
    expect(err.startsWith("error: ")).toBe(true);
  });
});

describe("schema prune", () => {
  it("drops unreachable and dead", () => {
    const p = writeTmp(
      "in.osd",
      'record R { "x": integer, "ghost" [0,0]: string }\nrecord Orphan { "y": string }\nroot R\n',
    );
    const { code, out } = run(["schema", "prune", p]);
    expect(code).toBe(0);
    expect(out).not.toContain("Orphan");
    expect(out).not.toContain("ghost");
    expect(out).toContain('"x": integer');
  });

  it("compact", () => {
    const p = writeTmp("in.osd", 'record R { "x": integer }\nroot R\n');
    const { code, out } = run(["schema", "prune", p, "--compact"]);
    expect(code).toBe(0);
    expect(out.trim()).not.toContain("\n");
  });

  it("invalid osd exits 2", () => {
    const p = writeTmp("in.osd", "this is not osd");
    const { code } = run(["schema", "prune", p]);
    expect(code).toBe(2);
  });
});

describe("schema is-empty", () => {
  it("empty schema is true, exit 0", () => {
    const p = writeTmp("in.osd", 'record A { "x": B }\nrecord B { "y": A }\nroot A\n');
    const { code, out } = run(["schema", "is-empty", p]);
    expect(code).toBe(0);
    expect(out).toBe("true\n");
  });

  it("satisfiable schema is false, exit 1", () => {
    const p = writeTmp("in.osd", 'record R { "x": integer }\nroot R\n');
    const { code, out } = run(["schema", "is-empty", p]);
    expect(code).toBe(1);
    expect(out).toBe("false\n");
  });

  it("json result-format", () => {
    const p = writeTmp("in.osd", 'record R { "x": integer }\nroot R\n');
    const { code, out } = run(["schema", "is-empty", p, "--result-format", "json"]);
    expect(code).toBe(1);
    expect(out.trim()).toBe('{"empty": false}');
  });
});

describe("schema equivalent", () => {
  it("equivalent, text", () => {
    const a = writeTmp("a.osd", 'record R { "x": integer }\nroot R\n');
    const b = writeTmp("b.osd", 'record R { "x": integer }\nroot R\n');
    const { code, out } = run(["schema", "equivalent", a, b]);
    expect(code).toBe(0);
    expect(out).toBe("true\n");
  });

  it("not equivalent, text", () => {
    const a = writeTmp("a.osd", 'record R { "x": integer }\nroot R\n');
    const b = writeTmp("b.osd", 'record R { "x": integer, "y" [0,1]: string }\nroot R\n');
    const { code, out } = run(["schema", "equivalent", a, b]);
    expect(code).toBe(1);
    expect(out).toBe("false\n");
  });

  it("result-format json", () => {
    const a = writeTmp("a.osd", 'record R { "x": integer }\nroot R\n');
    const b = writeTmp("b.osd", 'record R { "x": integer, "y" [0,1]: string }\nroot R\n');
    const { code, out } = run(["schema", "equivalent", a, b, "--result-format", "json"]);
    expect(code).toBe(1);
    expect(out).toBe('{"equivalent": false}\n');
  });
});

describe("schema lint", () => {
  it("clean schema, text, exit 0", () => {
    const p = writeTmp("in.osd", 'record R { "x": integer }\nroot R\n');
    const { code, out } = run(["schema", "lint", p]);
    expect(code).toBe(0);
    expect(out.trim()).toBe("no findings");
  });

  it("unreachable warning, text, exit 1", () => {
    const p = writeTmp("in.osd", 'record R { "x": integer }\nrecord Orphan { "y": string }\nroot R\n');
    const { code, out } = run(["schema", "lint", p]);
    expect(code).toBe(1);
    expect(out).toContain("unreachable-record");
    expect(out).toContain("Orphan");
  });

  it("json output shape", () => {
    const p = writeTmp("in.osd", 'record R { "x": integer }\nrecord Orphan { "y": string }\nroot R\n');
    const { code, out } = run(["schema", "lint", p, "--json"]);
    expect(code).toBe(1);
    const payload = JSON.parse(out);
    expect(payload.ok).toBe(false);
    expect(payload.findings[0].code).toBe("unreachable-record");
    expect(new Set(Object.keys(payload.findings[0]))).toEqual(new Set(["code", "severity", "location", "message"]));
  });

  it("info only is ok, exit 0", () => {
    const p = writeTmp("in.osd", 'record R { "data": any }\nroot R\n');
    const { code, out } = run(["schema", "lint", p, "--json"]);
    expect(code).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.ok).toBe(true);
    expect(payload.findings[0].code).toBe("any-field");
  });

  it("severity warning filters out info", () => {
    const p = writeTmp("in.osd", 'record R { "data": any }\nroot R\n');
    const { code, out } = run(["schema", "lint", p, "--severity", "warning", "--json"]);
    expect(code).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.findings).toEqual([]);
  });

  it("reads from stdin", () => {
    const { code, out } = run(["schema", "lint", "-"], 'record R { "x": integer }\nroot R\n');
    expect(code).toBe(0);
    expect(out.trim()).toBe("no findings");
  });

  it("invalid osd exits 2", () => {
    const p = writeTmp("in.osd", "this is not osd");
    const { code } = run(["schema", "lint", p]);
    expect(code).toBe(2);
  });
});

describe("top level", () => {
  it("missing command is a usage error", () => {
    const { code } = run([]);
    expect(code).toBe(2);
  });

  it("unknown command is a usage error", () => {
    const { code } = run(["bogus"]);
    expect(code).toBe(2);
  });

  it("--version prints version and exits 0", () => {
    const { code, out } = run(["--version"]);
    expect(code).toBe(0);
    expect(out).toMatch(/^omnist \S+\n$/);
  });

  it("--help includes description and exits 0", () => {
    const { code, out } = run(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("canonical data model");
  });

  it("unknown schema subcommand is a usage error", () => {
    const { code, err } = run(["schema", "bogus"]);
    expect(code).toBe(2);
    expect(err).toContain("error: ");
  });
});

describe("argument parsing edge cases", () => {
  it("unrecognized flag is a usage error", () => {
    const p = writeTmp("in.oml", "a: 1\n");
    const { code, err } = run(["format", p, "--nonexistent"]);
    expect(code).toBe(2);
    expect(err).toContain("error: ");
  });

  it("flag missing its value is a usage error", () => {
    const p = writeTmp("in.json", '{"a": 1}');
    const { code } = run(["convert", p, "--from", "json", "--to"]);
    expect(code).toBe(2);
  });

  it("--flag=value inline syntax works", () => {
    const p = writeTmp("in.json", '{"a": 1}');
    const { code, out } = run(["convert", p, "--from=json", "--to=yaml"]);
    expect(code).toBe(0);
    expect(out).toBe("a: 1\n");
  });

  it("--flag=value inline syntax rejects an invalid choice", () => {
    const p = writeTmp("in.json", '{"a": 1}');
    const { code } = run(["convert", p, "--from=json", "--to=bogus"]);
    expect(code).toBe(2);
  });

  it("defaults to real process.stdout/stderr when opts is omitted", () => {
    const captured: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      captured.push(String(chunk));
      return true;
    });
    try {
      const code = main(["--version"]);
      expect(code).toBe(0);
      expect(captured.join("")).toMatch(/^omnist \S+\n$/);
    } finally {
      spy.mockRestore();
    }
  });

});

describe("global --json machine mode", () => {
  const SCHEMA = 'record R { "a": integer }\nroot R\n';

  function assertJsonError(out: string, err: string, code: number, expectedCode: number): void {
    expect(code).toBe(expectedCode);
    expect(err).toBe("");
    const payload = JSON.parse(out);
    expect(payload.ok).toBe(false);
    expect("message" in payload).toBe(true);
    expect(Array.isArray(payload.errors)).toBe(true);
  }

  it("format error json", () => {
    const p = writeTmp("bad.oml", "a: [[1, 2]]\n");
    const base = run(["format", p]);
    const { code, out, err } = run(["format", p, "--json"]);
    assertJsonError(out, err, code, base.code);
  });

  it("convert error json", () => {
    const p = writeTmp("in.json", "{bad");
    const base = run(["convert", p, "--from", "json", "--to", "yaml"]);
    const { code, out, err } = run(["convert", p, "--from", "json", "--to", "yaml", "--json"]);
    assertJsonError(out, err, code, base.code);
  });

  it("convert oml/oml guard json", () => {
    const p = writeTmp("in.oml", "a: 1\n");
    const base = run(["convert", p, "--from", "oml", "--to", "oml"]);
    expect(base.code).toBe(2);
    expect(base.err.startsWith("error: ")).toBe(true);
    const { code, out, err } = run(["convert", p, "--from", "oml", "--to", "oml", "--json"]);
    assertJsonError(out, err, code, 2);
    expect(JSON.parse(out).message).toContain("not supported");
  });

  it("convert WriteError under strict json exit 1", () => {
    const p = writeTmp("in.json", '{"a": null}');
    const dst = p + ".toml";
    const { code, out, err } = run(["convert", p, "--from", "json", "--to", "toml", "--strict", "-o", dst, "--json"]);
    assertJsonError(out, err, code, 1);
    expect(fs.existsSync(dst)).toBe(false);
  });

  it("check error json", () => {
    const p = writeTmp("in.json", "{bad");
    const base = run(["check", p, "--from", "json", "--to", "toml"]);
    const { code, out, err } = run(["check", p, "--from", "json", "--to", "toml", "--json"]);
    assertJsonError(out, err, code, base.code);
  });

  it("infer error json", () => {
    const p = writeTmp("in.json", "{bad");
    const base = run(["infer", p, "--from", "json"]);
    const { code, out, err } = run(["infer", p, "--from", "json", "--json"]);
    assertJsonError(out, err, code, base.code);
  });

  it("schema format error json", () => {
    const p = writeTmp("bad.osd", 'record R { "a": integer }\n');
    const base = run(["schema", "format", p]);
    const { code, out, err } = run(["schema", "format", p, "--json"]);
    assertJsonError(out, err, code, base.code);
  });

  it("schema extract SchemaError json exit 1", () => {
    const p = writeTmp("in.osd", 'record R { "must": integer, "opt" [0,1]: string }\nroot R\n');
    const base = run(["schema", "extract", p, "--keep", "opt"]);
    expect(base.code).toBe(1);
    const { code, out, err } = run(["schema", "extract", p, "--keep", "opt", "--json"]);
    assertJsonError(out, err, code, 1);
  });

  it("schema is-empty error json", () => {
    const p = writeTmp("bad.osd", 'record R { "a": integer }\n');
    const base = run(["schema", "is-empty", p]);
    const { code, out, err } = run(["schema", "is-empty", p, "--json"]);
    assertJsonError(out, err, code, base.code);
  });

  it("schema compatible-with error json", () => {
    const a = writeTmp("bad.osd", 'record R { "a": integer }\n');
    const b = writeTmp("b.osd", 'record R { "a": integer }\nroot R\n');
    const base = run(["schema", "compatible-with", a, b]);
    const { code, out, err } = run(["schema", "compatible-with", a, b, "--json"]);
    assertJsonError(out, err, code, base.code);
  });

  it("check success json matches result-format", () => {
    const p = writeTmp("in.json", '{"a": null}');
    const ref = run(["check", p, "--from", "json", "--to", "toml", "--result-format", "json"]);
    const { code, out, err } = run(["check", p, "--from", "json", "--to", "toml", "--json"]);
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toBe(ref.out);
    JSON.parse(out);
  });

  it("is-empty success json", () => {
    const p = writeTmp("s.osd", SCHEMA);
    const { code, out, err } = run(["schema", "is-empty", p, "--json"]);
    expect(code).toBe(1);
    expect(err).toBe("");
    expect(JSON.parse(out)).toEqual({ empty: false });
  });

  it("compatible-with success json", () => {
    const a = writeTmp("a.osd", SCHEMA);
    const b = writeTmp("b.osd", SCHEMA);
    const { code, out } = run(["schema", "compatible-with", a, b, "--json"]);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ compatible: true });
  });

  it("equivalent success json", () => {
    const a = writeTmp("a.osd", SCHEMA);
    const b = writeTmp("b.osd", SCHEMA);
    const { code, out } = run(["schema", "equivalent", a, b, "--json"]);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ equivalent: true });
  });

  it("format success text unchanged under json", () => {
    const p = writeTmp("in.oml", "a: 1\n");
    const { code, out } = run(["format", p, "--json"]);
    expect(code).toBe(0);
    expect(out).toBe("a: 1\n");
  });

  it("convert success text unchanged under json", () => {
    const p = writeTmp("in.json", '{"a": 1}');
    const { code, out } = run(["convert", p, "--from", "json", "--to", "yaml", "--json"]);
    expect(code).toBe(0);
    expect(out).toBe("a: 1\n");
  });

  it("infer success text unchanged under json", () => {
    const p = writeTmp("in.json", '{"a": 1}');
    const ref = run(["infer", p, "--from", "json"]);
    const { code, out } = run(["infer", p, "--from", "json", "--json"]);
    expect(code).toBe(ref.code);
    expect(out).toBe(ref.out);
  });

  it("schema format success text unchanged under json", () => {
    const p = writeTmp("in.osd", 'record R { "a": integer }\nroot R\n');
    const ref = run(["schema", "format", p]);
    const { code, out } = run(["schema", "format", p, "--json"]);
    expect(code).toBe(ref.code);
    expect(out).toBe(ref.out);
  });

  it("schema extract success text unchanged under json", () => {
    const p = writeTmp("in.osd", 'record R { "a": integer }\nroot R\n');
    const ref = run(["schema", "extract", p, "--keep", "a"]);
    const { code, out } = run(["schema", "extract", p, "--keep", "a", "--json"]);
    expect(code).toBe(ref.code);
    expect(out).toBe(ref.out);
  });

  it("missing required arg with --json is still a usage error", () => {
    const p = writeTmp("in.json", '{"a": 1}');
    const { code, err } = run(["convert", p, "--to", "yaml", "--json"]);
    expect(code).toBe(2);
    expect(err.length).toBeGreaterThan(0);
  });

  it("validate --json success unchanged", () => {
    const docF = writeTmp("d.json", '{"a": 1}');
    const schemaF = writeTmp("s.osd", SCHEMA);
    const { code, out } = run(["validate", docF, "--from", "json", "--schema", schemaF, "--json"]);
    expect(code).toBe(0);
    expect(out).toBe('{"ok": true}\n');
  });

  it("validate --json conformance failure unchanged", () => {
    const docF = writeTmp("d.json", '{"a": 1, "b": "extra"}');
    const schemaF = writeTmp("s.osd", SCHEMA);
    const { code, out } = run(["validate", docF, "--from", "json", "--schema", schemaF, "--json"]);
    expect(code).toBe(1);
    expect(out).toBe(
      '{"ok": false, "message": "invalid:\\n  at $.b: unexpected field", ' +
        '"errors": [{"path": "$.b", "code": "unexpected-field", "message": "unexpected field"}]}\n',
    );
  });

  it("lint --json shape unchanged", () => {
    const p = writeTmp("s.osd", 'record R { "a": integer }\nroot R\n');
    const { code, out } = run(["schema", "lint", p, "--json"]);
    expect(code).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.ok).toBe(true);
    expect("findings" in payload).toBe(true);
  });
});
