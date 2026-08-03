/**
 * Tests for tools/conformance/runner.ts -- Track 1's fixture runner.
 *
 * Two kinds of coverage, mirroring test/conformance-self-test.test.ts's
 * split:
 *  - `main()` with no argument, run against the real, pinned
 *    vendor/omnist-spec submodule fixtures -- proves the 11 operation
 *    drivers actually pass against this repo's real library code, not
 *    just synthetic cases. Skipped (not failed) if the submodule hasn't
 *    been checked out.
 *  - `runOperation()` against scratch fixture directories built in a tmp
 *    dir, to exercise every pass/fail/skip branch each driver has, most
 *    of which the real 19 fixtures deliberately don't exercise (they're
 *    all currently-passing happy/error cases, not runner-logic stress
 *    tests).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main, runOperation } from "../tools/conformance/runner.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_FIXTURES_DIR = path.resolve(HERE, "..", "vendor", "omnist-spec", "conformance", "fixtures");

function withCapturedConsole<T>(fn: () => T): { result: T; logs: string[]; errs: string[] } {
  const logs: string[] = [];
  const errs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (msg?: unknown) => {
    logs.push(String(msg));
  };
  console.error = (msg?: unknown) => {
    errs.push(String(msg));
  };
  try {
    return { result: fn(), logs, errs };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

const describeIfVendored = existsSync(REAL_FIXTURES_DIR) ? describe : describe.skip;

describeIfVendored("main() against the real vendor/omnist-spec submodule", () => {
  it("passes every real fixture across all 11 operations", () => {
    const { result: exitCode, logs, errs } = withCapturedConsole(() => main());
    expect(errs).toEqual([]);
    expect(exitCode).toBe(0);
    for (const line of logs) {
      if (line.startsWith("[")) expect(line.startsWith("[PASS]")).toBe(true);
    }
    expect(logs.at(-1)).toBe("\n19 passed, 0 failed, 0 skipped (across 11 operation(s))");
  });

  it("runs a single named operation when given explicit argv", () => {
    const { result: exitCode, logs } = withCapturedConsole(() => main(["is_empty"]));
    expect(exitCode).toBe(0);
    expect(logs.at(-1)).toBe("\n2 passed, 0 failed, 0 skipped (across 1 operation(s))");
  });
});

describe("main() against a scratch fixtures directory", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "conformance-runner-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeCase(operation: string, name: string, files: Record<string, string>): string {
    const caseDir = path.join(dir, operation, name);
    mkdirSync(caseDir, { recursive: true });
    for (const [file, contents] of Object.entries(files)) {
      const full = path.join(caseDir, file);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, contents, "utf-8");
    }
    return caseDir;
  }

  it("returns 2 when the fixtures directory doesn't exist", () => {
    const missing = path.join(dir, "nope");
    const { result: exitCode, errs } = withCapturedConsole(() => main([], missing));
    expect(exitCode).toBe(2);
    expect(errs[0]).toContain(`no fixtures found at ${missing}`);
  });

  it("returns 0 when an operation directory doesn't exist (empty run)", () => {
    const { result: exitCode, logs } = withCapturedConsole(() => main(["write"], dir));
    expect(exitCode).toBe(0);
    expect(logs.at(-1)).toBe("\n0 passed, 0 failed, 0 skipped (across 1 operation(s))");
  });

  it("returns 0 when the operation path exists but is a file, not a directory", () => {
    writeFileSync(path.join(dir, "write"), "not a directory\n", "utf-8");
    const { result: exitCode, logs } = withCapturedConsole(() => main(["write"], dir));
    expect(exitCode).toBe(0);
    expect(logs.at(-1)).toBe("\n0 passed, 0 failed, 0 skipped (across 1 operation(s))");
  });

  it("returns 0 when the operation directory exists but has no case dirs", () => {
    mkdirSync(path.join(dir, "write"), { recursive: true });
    const { result: exitCode, logs } = withCapturedConsole(() => main(["write"], dir));
    expect(exitCode).toBe(0);
    expect(logs.at(-1)).toBe("\n0 passed, 0 failed, 0 skipped (across 1 operation(s))");
  });

  it("skips a case with no runner wired up, citing an explicit reason", () => {
    // Cast past the operation union: exercises the `runnerFn === undefined`
    // branch, which can't happen for any of the 11 real operation names.
    writeCase("no-such-op", "case-one", { "purpose.txt": "checks the skip path\n" });
    const [passed, failed, skipped] = runOperation(
      "no-such-op" as Parameters<typeof runOperation>[0],
      dir,
    );
    expect([passed, failed, skipped]).toEqual([0, 0, 1]);
  });

  it("treats a case dir with no purpose.txt as an empty purpose", () => {
    writeCase("is_empty", "case-one", {
      "input.osd": 'record R {\n    "a": string,\n}\nroot R\n',
      "expected.txt": "false\n",
    });
    const { logs } = withCapturedConsole(() => main(["is_empty"], dir));
    expect(logs[0]).toBe("[PASS] is_empty/case-one (): ok");
  });

  // -- write --------------------------------------------------------------

  it("write: fails when readOml throws on malformed input", () => {
    writeCase("write", "bad-input", {
      "input.oml": "@@@ not valid oml @@@\n",
      "expected.oml": "a: 1\n",
    });
    const { logs } = withCapturedConsole(() => main(["write"], dir));
    expect(logs[0]).toContain("[FAIL] write/bad-input (): threw:");
  });

  it("write: fails when output does not match expected", () => {
    writeCase("write", "mismatch", { "input.oml": "a: 1\n", "expected.oml": "a: 2\n" });
    const { logs } = withCapturedConsole(() => main(["write"], dir));
    expect(logs[0]).toBe(
      "[FAIL] write/mismatch (): output does not match expected (structural comparison)",
    );
  });

  // -- validate -------------------------------------------------------------

  it("validate: fails when actual ok contradicts expected ok", () => {
    writeCase("validate", "mismatch", {
      "schema.osd": 'record R {\n    "a": string,\n}\nroot R\n',
      "input.oml": "a: 1\n",
      "expected/ok.txt": "true\n",
    });
    const { logs } = withCapturedConsole(() => main(["validate"], dir));
    expect(logs[0]).toBe("[FAIL] validate/mismatch (): expected ok=true, got false");
  });

  // -- materialize ------------------------------------------------------

  it("materialize: fails when materialize throws but success was expected", () => {
    writeCase("materialize", "throws", {
      "schema.osd": 'record R {\n    "a": string,\n}\nroot R\n',
      "input.oml": "a: 1\n",
      "expected/ok.txt": "true\n",
    });
    const { logs } = withCapturedConsole(() => main(["materialize"], dir));
    expect(logs[0]).toContain("[FAIL] materialize/throws (): expected success, threw:");
  });

  it("materialize: fails when materialized output does not match expected", () => {
    writeCase("materialize", "mismatch", {
      "schema.osd": 'record R {\n    "a": string,\n}\nroot R\n',
      "input.oml": 'a: "1"\n',
      "expected/ok.txt": "true\n",
      "expected/output.oml": 'a: "2"\n',
    });
    const { logs } = withCapturedConsole(() => main(["materialize"], dir));
    expect(logs[0]).toBe(
      "[FAIL] materialize/mismatch (): materialized output does not match expected",
    );
  });

  it("materialize: fails when materialize succeeds but failure was expected", () => {
    writeCase("materialize", "unexpected-success", {
      "schema.osd": 'record R {\n    "a": string,\n}\nroot R\n',
      "input.oml": 'a: "1"\n',
      "expected/ok.txt": "false\n",
    });
    const { logs } = withCapturedConsole(() => main(["materialize"], dir));
    expect(logs[0]).toBe(
      "[FAIL] materialize/unexpected-success (): expected failure, materialize succeeded",
    );
  });

  // -- normalize / prune --------------------------------------------------

  it("normalize: fails when output schema does not match expected", () => {
    writeCase("normalize", "mismatch", {
      "input.osd": 'record R {\n    "a": string,\n}\nroot R\n',
      "expected.osd": 'record R {\n    "a": integer,\n}\nroot R\n',
    });
    const { logs } = withCapturedConsole(() => main(["normalize"], dir));
    expect(logs[0]).toBe(
      "[FAIL] normalize/mismatch (): output schema does not match expected (exact structural comparison)",
    );
  });

  it("prune: fails when output schema does not match expected", () => {
    writeCase("prune", "mismatch", {
      "input.osd": 'record R {\n    "a": string,\n}\nroot R\n',
      "expected.osd": 'record R {\n    "a": integer,\n}\nroot R\n',
    });
    const { logs } = withCapturedConsole(() => main(["prune"], dir));
    expect(logs[0]).toBe(
      "[FAIL] prune/mismatch (): output schema does not match expected (exact structural comparison)",
    );
  });

  // -- is_empty / compatible_with / equivalent -----------------------------

  it("is_empty: fails when actual contradicts expected", () => {
    writeCase("is_empty", "mismatch", {
      "input.osd": 'record R {\n    "a": string,\n}\nroot R\n',
      "expected.txt": "true\n",
    });
    const { logs } = withCapturedConsole(() => main(["is_empty"], dir));
    expect(logs[0]).toBe("[FAIL] is_empty/mismatch (): expected empty=true, got false");
  });

  it("compatible_with: fails when actual contradicts expected", () => {
    const osd = 'record R {\n    "a": string,\n}\nroot R\n';
    writeCase("compatible_with", "mismatch", {
      "a.osd": osd,
      "b.osd": osd,
      "expected.txt": "false\n",
    });
    const { logs } = withCapturedConsole(() => main(["compatible_with"], dir));
    expect(logs[0]).toBe("[FAIL] compatible_with/mismatch (): expected compatible=false, got true");
  });

  it("equivalent: fails when actual contradicts expected", () => {
    const osd = 'record R {\n    "a": string,\n}\nroot R\n';
    writeCase("equivalent", "mismatch", {
      "a.osd": osd,
      "b.osd": osd,
      "expected.txt": "false\n",
    });
    const { logs } = withCapturedConsole(() => main(["equivalent"], dir));
    expect(logs[0]).toBe("[FAIL] equivalent/mismatch (): expected equivalent=false, got true");
  });

  // -- extract --------------------------------------------------------------

  it("extract: fails when extract throws but success was expected", () => {
    writeCase("extract", "throws", {
      "schema.osd": 'record R {\n    "a": string,\n}\nroot R\n',
      "keep.txt": "\n",
      "expected/ok.txt": "true\n",
    });
    const { logs } = withCapturedConsole(() => main(["extract"], dir));
    expect(logs[0]).toContain("[FAIL] extract/throws (): expected success, threw:");
  });

  it("extract: fails when extracted schema does not match expected", () => {
    writeCase("extract", "mismatch", {
      "schema.osd": 'record R {\n    "a": string,\n    "b" [0,1]: string,\n}\nroot R\n',
      "keep.txt": "a,b",
      "expected/ok.txt": "true\n",
      "expected/output.osd": 'record R {\n    "a": string,\n}\nroot R\n',
    });
    const { logs } = withCapturedConsole(() => main(["extract"], dir));
    expect(logs[0]).toBe("[FAIL] extract/mismatch (): extracted schema does not match expected");
  });

  it("extract: fails when extract succeeds but failure was expected", () => {
    writeCase("extract", "unexpected-success", {
      "schema.osd": 'record R {\n    "a": string,\n}\nroot R\n',
      "keep.txt": "a",
      "expected/ok.txt": "false\n",
    });
    const { logs } = withCapturedConsole(() => main(["extract"], dir));
    expect(logs[0]).toBe(
      "[FAIL] extract/unexpected-success (): expected failure (keep set invalidates root), extract succeeded",
    );
  });

  // -- infer ----------------------------------------------------------------

  it("infer: fails when infer throws but success was expected", () => {
    writeCase("infer", "throws", {
      "samples/1.oml": "a: 1\n",
      "samples/2.oml": 'a: "x"\n',
      "expected/ok.txt": "true\n",
    });
    const { logs } = withCapturedConsole(() => main(["infer"], dir));
    expect(logs[0]).toContain("[FAIL] infer/throws (): expected success, threw:");
  });

  it("infer: fails when inferred schema is not isomorphic to expected", () => {
    writeCase("infer", "mismatch", {
      "samples/1.oml": "a: 1\n",
      "expected/ok.txt": "true\n",
      "expected/output.osd": 'record Root {\n    "a": string,\n}\nroot Root\n',
    });
    const { logs } = withCapturedConsole(() => main(["infer"], dir));
    expect(logs[0]).toBe("[FAIL] infer/mismatch (): inferred schema is not isomorphic to expected");
  });

  it("infer: fails when infer succeeds but failure was expected", () => {
    writeCase("infer", "unexpected-success", {
      "samples/1.oml": "a: 1\n",
      "expected/ok.txt": "false\n",
    });
    const { logs } = withCapturedConsole(() => main(["infer"], dir));
    expect(logs[0]).toBe(
      "[FAIL] infer/unexpected-success (): expected failure (ambiguous type, no allowAny), infer succeeded",
    );
  });

  it("infer: respects allow_any.txt when present and true", () => {
    writeCase("infer", "allow-any", {
      "samples/1.oml": "a: 1\n",
      "samples/2.oml": 'a: "x"\n',
      "allow_any.txt": "true\n",
      "expected/ok.txt": "true\n",
      "expected/output.osd": 'record Root {\n    "a": any,\n}\nroot Root\n',
    });
    const { logs } = withCapturedConsole(() => main(["infer"], dir));
    expect(logs[0]).toBe("[PASS] infer/allow-any (): ok");
  });

  // -- lint -------------------------------------------------------------

  it("lint: fails when findings (code/severity/location) don't match expected", () => {
    writeCase("lint", "mismatch", {
      "input.osd": 'record R {\n    "a": any,\n}\nroot R\n',
      "expected.json": JSON.stringify({ ok: true, findings: [] }),
    });
    const { logs } = withCapturedConsole(() => main(["lint"], dir));
    expect(logs[0]).toContain("[FAIL] lint/mismatch ():");
  });

  it("lint: passes when findings match with message text ignored", () => {
    writeCase("lint", "match", {
      "input.osd": 'record R {\n    "a": any,\n}\nroot R\n',
      "expected.json": JSON.stringify({
        ok: false,
        findings: [{ code: "any-field", severity: "info", location: "R.a", message: "anything at all" }],
      }),
    });
    const { logs } = withCapturedConsole(() => main(["lint"], dir));
    expect(logs[0]).toBe("[PASS] lint/match (): ok");
  });
});
