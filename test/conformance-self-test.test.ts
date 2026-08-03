/**
 * Tests for tools/conformance/selfTest.ts.
 *
 * Two kinds of coverage here:
 *  - `main()` with no argument, run against the real, pinned
 *    vendor/omnist-spec submodule fixtures -- proves the referee actually
 *    passes its own self-test with this repo's real library code, not just
 *    synthetic cases. Skipped (not failed) if the submodule hasn't been
 *    checked out (`git submodule update --init`).
 *  - `main()`/`runCase()` against scratch fixture directories built in a
 *    tmp dir, to exercise the malformed-input and no-fixtures branches
 *    that the real submodule fixtures don't (deliberately) contain.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main, runCase } from "../tools/conformance/selfTest.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_FIXTURES_DIR = path.resolve(
  HERE,
  "..",
  "vendor",
  "omnist-spec",
  "conformance",
  "fixtures",
  "_referee-self-test",
);

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
  // KNOWN FAILURE (found by this self-test, not yet fixed or triaged as of
  // this writing -- see the harness's step-1 report): case
  // 01-schema-exact-equal-different-field-order fails. omnist-ts's
  // `schemaEquals`/`recordEquals` (src/schema.ts) compare a record's
  // `fields` array positionally, so two records that differ only in field
  // *declaration order* compare unequal in exact mode. Python's reference
  // implementation (`omnist/schema.py`'s `Record.__eq__`) and this fixture
  // both treat fields as an unordered set for equality -- declaration
  // order is documented as not semantically significant (model.md Sec13).
  // This looks like a genuine omnist-ts bug, not a referee bug: per the
  // conformance-harness plan this must be triaged/fixed as its own,
  // separate step rather than silently worked around here. Update this
  // test (and the exact case count) once that's resolved.
  it("passes every case except the known field-order exact-equality bug", () => {
    const { result: exitCode, logs, errs } = withCapturedConsole(() => main());
    expect(errs).toEqual([]);
    expect(exitCode).toBe(1);
    expect(logs[0]).toBe(
      "[FAIL] 01-schema-exact-equal-different-field-order (edge-case): expected equal, got not-equal",
    );
    for (const line of logs.slice(1, -2)) {
      if (line.startsWith("[")) expect(line.startsWith("[PASS]")).toBe(true);
    }
    expect(logs.at(-1)).toBe("\n9/10 self-test cases passed");
  });
});

describe("main() against a scratch fixtures directory", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "conformance-self-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeCase(name: string, files: Record<string, string>): void {
    const caseDir = path.join(dir, name);
    mkdirSync(caseDir, { recursive: true });
    for (const [file, contents] of Object.entries(files)) {
      writeFileSync(path.join(caseDir, file), contents, "utf-8");
    }
  }

  it("returns 2 when the fixtures directory doesn't exist", () => {
    const missing = path.join(dir, "nope");
    const { result: exitCode, errs } = withCapturedConsole(() => main(missing));
    expect(exitCode).toBe(2);
    expect(errs).toEqual([`no self-test fixtures found at ${missing}`]);
  });

  it("returns 2 when the fixtures directory exists but has no case dirs", () => {
    const { result: exitCode, errs } = withCapturedConsole(() => main(dir));
    expect(exitCode).toBe(2);
    expect(errs).toEqual([`no self-test fixtures found at ${dir}`]);
  });

  it("passes a well-formed document case without a purpose.txt", () => {
    writeCase("01-doc", {
      "kind.txt": "document\n",
      "expect.txt": "equal\n",
      "a.oml": "a: 1\n",
      "b.oml": "a: 1\n",
    });
    const { result: exitCode, logs } = withCapturedConsole(() => main(dir));
    expect(exitCode).toBe(0);
    expect(logs[0]).toBe("[PASS] 01-doc (): ok");
  });

  it("uses only the first line of a multi-line purpose.txt", () => {
    writeCase("01-doc", {
      "kind.txt": "document\n",
      "expect.txt": "equal\n",
      "purpose.txt": "first line\nsecond line\n",
      "a.oml": "a: 1\n",
      "b.oml": "a: 1\n",
    });
    const { logs } = withCapturedConsole(() => main(dir));
    expect(logs[0]).toBe("[PASS] 01-doc (first line): ok");
  });

  it("fails a case whose actual result contradicts expect.txt", () => {
    writeCase("01-doc", {
      "kind.txt": "document\n",
      "expect.txt": "equal\n",
      "a.oml": "a: 1\n",
      "b.oml": "a: 2\n",
    });
    const { result: exitCode, logs } = withCapturedConsole(() => main(dir));
    expect(exitCode).toBe(1);
    expect(logs[0]).toBe("[FAIL] 01-doc (): expected equal, got not-equal");
    expect(logs[1]).toBe("\n0/1 self-test cases passed");
  });

  it("fails a case whose actual equal result contradicts an expected not-equal", () => {
    writeCase("01-doc", {
      "kind.txt": "document\n",
      "expect.txt": "not-equal\n",
      "a.oml": "a: 1\n",
      "b.oml": "a: 1\n",
    });
    const { result: exitCode, logs } = withCapturedConsole(() => main(dir));
    expect(exitCode).toBe(1);
    expect(logs[0]).toBe("[FAIL] 01-doc (): expected not-equal, got equal");
  });

  it("runs a schema case in both exact and isomorphic modes", () => {
    writeCase("01-schema", {
      "kind.txt": "schema\n",
      "expect.txt": "equal\n",
      "mode.txt": "isomorphic\n",
      "a.osd": 'record R {\n    "a": string,\n}\nroot R\n',
      "b.osd": 'record S {\n    "a": string,\n}\nroot S\n',
    });
    const { result: exitCode } = withCapturedConsole(() => main(dir));
    expect(exitCode).toBe(0);
  });

  it("reports a bad expect.txt value as a failing case", () => {
    writeCase("01-bad", {
      "kind.txt": "document\n",
      "expect.txt": "maybe\n",
      "a.oml": "a: 1\n",
      "b.oml": "a: 1\n",
    });
    const { result: exitCode, logs } = withCapturedConsole(() => main(dir));
    expect(exitCode).toBe(1);
    expect(logs[0]).toBe("[FAIL] 01-bad (): bad expect.txt value \"maybe\"");
  });

  it("reports a bad kind.txt value as a failing case", () => {
    writeCase("01-bad", {
      "kind.txt": "nonsense\n",
      "expect.txt": "equal\n",
    });
    const result = runCase(path.join(dir, "01-bad"));
    expect(result).toEqual({ passed: false, message: 'bad kind.txt value "nonsense"' });
  });
});
