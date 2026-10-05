// omnist-spec v0.30.0-beta D-23 at the CLI: `--max-input-bytes N` on every
// subcommand that reads a Document (format, convert, check, validate, infer),
// validated like the library option; the file or stdin read stops at N + 1
// bytes; bytes are counted before decoding and before the BOM is stripped.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(HERE, "..", "src", "cli.ts");
const REPO_ROOT = path.resolve(HERE, "..");

function run(argv: string[], stdin?: string): { code: number; out: string; err: string } {
  const outBuf: string[] = [];
  const errBuf: string[] = [];
  const stream = (buf: string[]): NodeJS.WritableStream =>
    ({ write: (chunk: unknown) => (buf.push(String(chunk)), true) }) as unknown as NodeJS.WritableStream;
  const code = main(argv, {
    stdout: stream(outBuf),
    stderr: stream(errBuf),
    ...(stdin !== undefined ? { stdin } : {}),
  });
  return { code, out: outBuf.join(""), err: errBuf.join("") };
}

let counter = 0;
function tmpFile(name: string, content: string | Uint8Array): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omnist-cli-size-"));
  const p = path.join(dir, String(counter++) + "-" + name);
  fs.writeFileSync(p, content);
  return p;
}

const DOC = '{"a":"xxxxxxxxxxxx"}'; // 20 bytes
const SCHEMA = 'record R {\n  "a": string,\n}\nroot R\n';

// One invocation per subcommand that reads a Document; `FILE` is replaced by
// the document's path.
const COMMANDS: Array<[string, string[]]> = [
  ["convert", ["convert", "FILE", "--from", "json", "--to", "oml"]],
  ["check", ["check", "FILE", "--from", "json", "--to", "yaml"]],
  ["validate", ["validate", "FILE", "--from", "json", "--schema", "SCHEMA"]],
  ["infer", ["infer", "FILE", "--from", "json"]],
];

function argvFor(template: string[], file: string, schema: string, extra: string[]): string[] {
  return [...template.map((a) => (a === "FILE" ? file : a === "SCHEMA" ? schema : a)), ...extra];
}

describe("--max-input-bytes on each subcommand that reads a Document", () => {
  const schema = tmpFile("s.osd", SCHEMA);

  it.each(COMMANDS)("%s: exactly the maximum is accepted, one byte over is refused", (_name, template) => {
    const file = tmpFile("d.json", DOC);
    const ok = run(argvFor(template, file, schema, ["--max-input-bytes", "20"]));
    expect(ok.code).toBe(0);
    const over = run(argvFor(template, file, schema, ["--max-input-bytes", "19"]));
    expect(over.code).toBe(2);
    expect(over.err).toContain("input exceeds the maximum input size (19 bytes)");
  });

  it("format (OML): at and over the maximum", () => {
    const file = tmpFile("d.oml", 'a: "xxxxxxxxxxxx"\n'); // 18 bytes
    expect(run(["format", file, "--max-input-bytes", "18"]).code).toBe(0);
    expect(run(["format", file, "--max-input-bytes", "17"]).code).toBe(2);
  });

  it("the refusal says how to raise the limit", () => {
    const file = tmpFile("d.json", DOC);
    const { err } = run(["convert", file, "--from", "json", "--to", "oml", "--max-input-bytes", "5"]);
    expect(err).toContain("use --max-input-bytes to raise it");
  });

  it("--json: a structured document.limit.input-size error at $", () => {
    const file = tmpFile("d.json", DOC);
    const { code, out } = run(["convert", file, "--from", "json", "--to", "oml", "--max-input-bytes", "5", "--json"]);
    expect(code).toBe(2);
    const payload = JSON.parse(out) as { ok: boolean; errors: { path: string; code: string; message: string }[] };
    expect(payload.ok).toBe(false);
    expect(payload.errors).toHaveLength(1);
    expect(payload.errors[0]).toMatchObject({ path: "$", code: "document.limit.input-size" });
    expect(payload.errors[0]?.message).toContain("--max-input-bytes");
  });

  it("validate --json: the refusal is reported the same way", () => {
    const file = tmpFile("d.json", DOC);
    const { code, out } = run(["validate", file, "--from", "json", "--schema", schema, "--max-input-bytes", "5", "--json"]);
    expect(code).toBe(2);
    expect((JSON.parse(out) as { errors: { code: string }[] }).errors[0]?.code).toBe("document.limit.input-size");
  });

  it("infer: every input file is held to the maximum", () => {
    const small = tmpFile("a.json", '{"a":"x"}');
    const big = tmpFile("b.json", DOC);
    expect(run(["infer", small, big, "--from", "json", "--max-input-bytes", "20"]).code).toBe(0);
    expect(run(["infer", small, big, "--from", "json", "--max-input-bytes", "19"]).code).toBe(2);
  });

  it("the schema file is not a Document: --max-input-bytes does not bound it", () => {
    const file = tmpFile("d.json", '{"a":"x"}');
    expect(run(["validate", file, "--from", "json", "--schema", schema, "--max-input-bytes", "9"]).code).toBe(0);
  });

  it("without the flag the default (64 MiB) applies", () => {
    const file = tmpFile("d.json", DOC);
    expect(run(["convert", file, "--from", "json", "--to", "oml"]).code).toBe(0);
  });

  it("a larger maximum than the default is honoured by the reader as well as the CLI read", () => {
    const text = '{"a":"' + "x".repeat(70 * 1024 * 1024) + '"}';
    const file = tmpFile("big.json", text);
    expect(run(["convert", file, "--from", "json", "--to", "oml"]).code).toBe(2);
    const raised = run(["convert", file, "--from", "json", "--to", "oml", "--max-input-bytes", String(text.length)]);
    expect(raised.code).toBe(0);
  }, 60000);

  it("counts the bytes of a leading BOM, before decoding strips it", () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(DOC)]); // 23 bytes
    const file = tmpFile("bom.json", withBom);
    expect(run(["convert", file, "--from", "json", "--to", "oml", "--max-input-bytes", "23"]).code).toBe(0);
    const over = run(["convert", file, "--from", "json", "--to", "oml", "--max-input-bytes", "22"]);
    expect(over.code).toBe(2);
    expect(over.err).toContain("input exceeds the maximum input size (22 bytes)");
  });

  it("counts bytes, not characters: 10 e-acutes in a file are 20 bytes", () => {
    const file = tmpFile("mb.json", '{"a":"' + "\u{e9}".repeat(7) + '"}'); // 22 bytes, 15 characters
    expect(run(["convert", file, "--from", "json", "--to", "oml", "--max-input-bytes", "22"]).code).toBe(0);
    expect(run(["convert", file, "--from", "json", "--to", "oml", "--max-input-bytes", "21"]).code).toBe(2);
  });

  it("refuses an over-limit input BEFORE decoding it (invalid UTF-8 is not reported)", () => {
    const file = tmpFile("bad.json", new Uint8Array([0x7b, 0x80, 0x80, 0x80, 0x80, 0x7d])); // 6 bytes, invalid UTF-8
    const { code, err } = run(["convert", file, "--from", "json", "--to", "oml", "--max-input-bytes", "5"]);
    expect(code).toBe(2);
    expect(err).toContain("input exceeds the maximum input size");
    expect(err).not.toContain("not valid UTF-8");
  });
});

describe("stdin (injected) is held to the maximum as bytes", () => {
  it("accepts exactly the maximum and refuses one byte over", () => {
    expect(run(["convert", "-", "--from", "json", "--to", "oml", "--max-input-bytes", "20"], DOC).code).toBe(0);
    const over = run(["convert", "-", "--from", "json", "--to", "oml", "--max-input-bytes", "19"], DOC);
    expect(over.code).toBe(2);
    expect(over.err).toContain("use --max-input-bytes to raise it");
  });
});

describe("--max-input-bytes is validated like the library option", () => {
  const bad = ["0", "-1", "1.5", "abc", "", "1e3", "0x10", " 5", "9007199254740993", "Infinity"];
  it.each(bad)("refuses %j as a usage error", (value) => {
    const file = tmpFile("d.json", DOC);
    const { code, err } = run(["convert", file, "--from", "json", "--to", "oml", `--max-input-bytes=${value}`]);
    expect(code).toBe(2);
    expect(err).toContain("argument --max-input-bytes: must be an integer of at least 1");
  });

  it("accepts the space-separated form", () => {
    const file = tmpFile("d.json", DOC);
    expect(run(["convert", file, "--from", "json", "--to", "oml", "--max-input-bytes", "20"]).code).toBe(0);
  });

  it("a missing value is a usage error", () => {
    const file = tmpFile("d.json", DOC);
    expect(run(["convert", file, "--from", "json", "--to", "oml", "--max-input-bytes"]).code).toBe(2);
  });

  it("is not accepted by a schema subcommand (which reads no Document)", () => {
    const file = tmpFile("s.osd", SCHEMA);
    expect(run(["schema", "format", file, "--max-input-bytes", "20"]).code).toBe(2);
  });
});

describe("the file read stops at maximum + 1 bytes", () => {
  it("reads a file larger than one chunk: exactly the maximum accepted, one over refused", () => {
    const n = 1024 * 1024 + 100;
    const body = '{"a":1}' + " ".repeat(n - 7);
    const file = tmpFile("chunks.json", body);
    expect(fs.statSync(file).size).toBe(n);
    expect(run(["convert", file, "--from", "json", "--to", "oml", "--max-input-bytes", String(n)]).code).toBe(0);
    const over = run(["convert", file, "--from", "json", "--to", "oml", "--max-input-bytes", String(n - 1)]);
    expect(over.code).toBe(2);
    expect(over.err).toContain("input exceeds the maximum input size");
  });

  it("a file a whole number of chunks long", () => {
    const n = 2 * 1024 * 1024;
    const file = tmpFile("exact.json", '{"a":1}' + " ".repeat(n - 7));
    expect(run(["convert", file, "--from", "json", "--to", "oml", "--max-input-bytes", String(n)]).code).toBe(0);
    expect(run(["convert", file, "--from", "json", "--to", "oml", "--max-input-bytes", String(n - 1)]).code).toBe(2);
  });

  it("an empty file is under any maximum", () => {
    const file = tmpFile("empty.oml", "");
    expect(run(["format", file, "--max-input-bytes", "1"]).code).toBe(0);
  });

  // An endless source proves the read stops: were the whole input read first,
  // this would never return (or would exhaust memory). Linux only.
  const itLinux = process.platform === "linux" ? it : it.skip;

  itLinux("a file that never ends (/dev/zero) is refused after max + 1 bytes", () => {
    const r = spawnSync(
      process.execPath,
      ["--import", "tsx", CLI_PATH, "convert", "/dev/zero", "--from", "json", "--to", "oml", "--max-input-bytes", "100000"],
      { cwd: REPO_ROOT, encoding: "utf-8", timeout: 60000 },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("input exceeds the maximum input size (100000 bytes)");
  }, 70000);

  itLinux("standard input that never ends is refused after max + 1 bytes", () => {
    const fd = fs.openSync("/dev/zero", "r");
    try {
      const r = spawnSync(
        process.execPath,
        ["--import", "tsx", CLI_PATH, "convert", "-", "--from", "json", "--to", "oml", "--max-input-bytes", "100000"],
        { cwd: REPO_ROOT, encoding: "utf-8", timeout: 60000, stdio: [fd, "pipe", "pipe"] },
      );
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("input exceeds the maximum input size (100000 bytes)");
    } finally {
      fs.closeSync(fd);
    }
  }, 70000);

  itLinux("real stdin within the maximum is read and converted", () => {
    const r = spawnSync(
      process.execPath,
      ["--import", "tsx", CLI_PATH, "convert", "-", "--from", "json", "--to", "oml", "--max-input-bytes", "20"],
      { cwd: REPO_ROOT, encoding: "utf-8", timeout: 60000, input: DOC },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('a: "xxxxxxxxxxxx"\n');
  }, 70000);
});
