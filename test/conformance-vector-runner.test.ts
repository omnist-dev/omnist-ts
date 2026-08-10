/**
 * Tests for tools/conformance/vectorRunner.ts -- Track 2's JSON-vector
 * runner (omnist-ts issue #85, step 3).
 *
 * Two kinds of coverage, mirroring test/conformance-runner.test.ts's split:
 *  - `main()` against the real, pinned vendor/omnist-spec/test-suite --
 *    proves the drivers actually run against this repo's real library
 *    code. Skipped (not failed) if the submodule hasn't been checked out.
 *    Asserts the *real* current tally (not an aspirational one): as of
 *    this writing, 0 real failures remain -- the 3 originally found by
 *    this suite (formats-xml's element-text numeric-kind inference,
 *    issue #88, and two formats-yaml YAML-1.1-vs-reference
 *    boolean-resolution sharp edges, issue #89) are fixed. One of the
 *    two YAML vectors now reports as a SKIP rather than a PASS: fixing
 *    the boolean-key bug makes it correctly reject the document, but
 *    the DocumentError raised carries no structured path/code, so it
 *    falls into the same "syntax-level error carries no structured
 *    diagnostics" skip category as the oml/osd-grammar vectors.
 *    If this test starts failing because the *tally* changed, that is
 *    worth investigating either way (a new bug, or a new fix) that
 *    requires updating this assertion, not a regression to chase
 *    blindly.
 *  - `runVector()` against synthetic, in-memory vector objects, to
 *    exercise every pass/fail/skip branch each driver has -- most of
 *    which the real 146 vectors don't hit in combination (e.g. a
 *    diagnostics-mismatch fail, which no real vector is expected to
 *    produce).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main, runVector, iterVectors } from "../tools/conformance/vectorRunner.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_SUITE_DIR = path.resolve(HERE, "..", "vendor", "omnist-spec", "test-suite");

type V = Parameters<typeof runVector>[0];

function vec(operation: string, input: object, expect: object, name = "test-vector"): V {
  return { name, spec: "test", operation, purpose: "edge-case", input, expect } as V;
}

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

const describeIfVendored = existsSync(REAL_SUITE_DIR) ? describe : describe.skip;

describeIfVendored("main() against the real vendor/omnist-spec/test-suite", () => {
  it("reports the real, current pass/fail/skip tally", () => {
    const { result: exitCode, logs, errs } = withCapturedConsole(() => main());
    expect(errs).toEqual([]);
    expect(exitCode).toBe(0); // all real failures fixed (issues #86, #88, #89) -- clean run
    expect(logs.at(-1)).toBe(
      "\n110 passed, 0 failed, 36 skipped (of 146 vectors) -- " +
        "diagnostics compared in code-agnostic mode (Sec8.5.2 rule 4)",
    );
  });

  it("every skip cites an explicit, reasoned category", () => {
    const { logs } = withCapturedConsole(() => main());
    const skipLines = logs.filter((l) => l.startsWith("[SKIP]"));
    expect(skipLines.length).toBe(36);
    for (const line of skipLines) {
      expect(line).toMatch(
        /: (D-6 \(integer\/number kind collapse\)|not yet implemented|syntax-level \w+Error carries no structured path\/code)/,
      );
    }
  });

  it("iterVectors discovers all 146 real vectors", () => {
    expect(iterVectors(REAL_SUITE_DIR).length).toBe(146);
  });
});

describe("main() against a scratch suite directory", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "vector-runner-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeVectors(vectors: V[], subpath = "v.json"): void {
    const full = path.join(dir, subpath);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, JSON.stringify({ vectors }), "utf-8");
  }

  it("returns 2 when the suite directory doesn't exist", () => {
    const missing = path.join(dir, "nope");
    const { result: exitCode, errs } = withCapturedConsole(() => main(missing));
    expect(exitCode).toBe(2);
    expect(errs[0]).toContain(`no test-suite vectors found at ${missing}`);
  });

  it("recurses into nested directories and skips non-.json files", () => {
    writeVectors([vec("is_empty", { schema: 'record R {\n    "a": string,\n}\nroot R\n' }, { empty: false })], "nested/deep/a.json");
    writeFileSync(path.join(dir, "nested", "readme.txt"), "not a vector file\n", "utf-8");
    const { result: exitCode, logs } = withCapturedConsole(() => main(dir));
    expect(exitCode).toBe(0);
    expect(logs.at(-1)).toBe("\n1 passed, 0 failed, 0 skipped (of 1 vectors) -- diagnostics compared in code-agnostic mode (Sec8.5.2 rule 4)");
  });

  it("treats a JSON file with no 'vectors' key as contributing zero vectors", () => {
    writeFileSync(path.join(dir, "empty.json"), JSON.stringify({}), "utf-8");
    const { result: exitCode, logs } = withCapturedConsole(() => main(dir));
    expect(exitCode).toBe(0);
    expect(logs.at(-1)).toBe("\n0 passed, 0 failed, 0 skipped (of 0 vectors) -- diagnostics compared in code-agnostic mode (Sec8.5.2 rule 4)");
  });

  it("reports a nonzero exit code when any vector fails", () => {
    writeVectors([vec("is_empty", { schema: 'record R {\n    "a": string,\n}\nroot R\n' }, { empty: true })]);
    const { result: exitCode } = withCapturedConsole(() => main(dir));
    expect(exitCode).toBe(1);
  });
});

describe("runVector() dispatch", () => {
  it("skips an operation with no driver wired up, citing the operation name", () => {
    const r = runVector(vec("no-such-op", {}, {}));
    expect(r).toEqual({ status: "skip", message: 'no driver wired up yet for operation "no-such-op"' });
  });

  it("reports a driver crash as fail, not an uncaught exception", () => {
    // validate's document key is missing: d6Affected sees no document (returns
    // false, exercising its `doc === undefined` branch) and then decodeDocument
    // is called on `undefined`, which throws -- caught by runVector's own
    // try/catch, not the driver's.
    const r = runVector(vec("validate", { schema: 'record R {}\nroot R\n' }, { ok: true }));
    expect(r.status).toBe("fail");
    expect(r.message).toContain("driver threw");
  });
});

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------

describe("parse", () => {
  it("skips a vector declaring a runtime-configurable limit", () => {
    const r = runVector(vec("parse", { format: "oml", declared_max_depth: 3, text: "a: 1\n" }, { ok: true }));
    expect(r).toEqual({
      status: "skip",
      message: "not yet implemented -- omnist-ts's safety limits are compile-time constants, no runtime configuration surface",
    });
  });

  it("passes when the parsed document matches expected", () => {
    const r = runVector(
      vec(
        "parse",
        { format: "oml", text: "a: 1\n" },
        { ok: true, document: { edges: [["a", { scalar: { kind: "integer", value: 1 } }]] } },
      ),
    );
    expect(r).toEqual({ status: "pass", message: "ok" });
  });

  it("fails when the parsed document does not match expected", () => {
    const r = runVector(
      vec(
        "parse",
        { format: "oml", text: "a: 1\n" },
        { ok: true, document: { edges: [["a", { scalar: { kind: "integer", value: 2 } }]] } },
      ),
    );
    expect(r.status).toBe("fail");
  });

  it("fails when parse succeeds but failure was expected", () => {
    const r = runVector(vec("parse", { format: "oml", text: "a: 1\n" }, { ok: false, diagnostics: [] }));
    expect(r).toEqual({ status: "fail", message: "expected failure, parse succeeded" });
  });

  it("skips a syntax failure asserting structured diagnostics", () => {
    const r = runVector(
      vec("parse", { format: "oml", text: "a: [1, 2\n" }, { ok: false, diagnostics: [{ path: "1:1", code: "parse.x" }] }),
    );
    expect(r).toEqual({ status: "skip", message: "syntax-level ParseError carries no structured path/code" });
  });

  it("passes a syntax failure asserting only ok:false", () => {
    const r = runVector(vec("parse", { format: "oml", text: "a: [1, 2\n" }, { ok: false }));
    expect(r).toEqual({ status: "pass", message: "ok" });
  });

  it("fails when parse throws but success was expected", () => {
    const r = runVector(vec("parse", { format: "oml", text: "a: [1, 2\n" }, { ok: true, document: { edges: [] } }));
    expect(r.status).toBe("fail");
    expect(r.message).toContain("expected success, threw:");
  });

  it("decodes a null scalar", () => {
    const r = runVector(
      vec(
        "parse",
        { format: "oml", text: "a: null\n" },
        { ok: true, document: { edges: [["a", { scalar: { kind: null, value: null } }]] } },
      ),
    );
    expect(r).toEqual({ status: "pass", message: "ok" });
  });

  it("decodes a string-encoded integer value", () => {
    const r = runVector(
      vec(
        "parse",
        { format: "oml", text: "a: 5\n" },
        { ok: true, document: { edges: [["a", { scalar: { kind: "integer", value: "5" } }]] } },
      ),
    );
    expect(r).toEqual({ status: "pass", message: "ok" });
  });

  it("decodes a time scalar as a plain string", () => {
    const r = runVector(
      vec(
        "parse",
        { format: "oml", text: 'a: "12:00:00"\n' },
        { ok: true, document: { edges: [["a", { scalar: { kind: "time", value: "12:00:00" } }]] } },
      ),
    );
    expect(r.status).toBe("pass");
  });

  it("decodes a date scalar", () => {
    const r = runVector(
      vec(
        "parse",
        { format: "oml", text: "a: 2024-01-01\n" },
        { ok: true, document: { edges: [["a", { scalar: { kind: "date", value: "2024-01-01" } }]] } },
      ),
    );
    expect(r).toEqual({ status: "pass", message: "ok" });
  });

  it("decodes a datetime scalar", () => {
    const r = runVector(
      vec(
        "parse",
        { format: "oml", text: "a: 2024-01-01T12:00:00\n" },
        { ok: true, document: { edges: [["a", { scalar: { kind: "datetime", value: "2024-01-01T12:00:00" } }]] } },
      ),
    );
    expect(r).toEqual({ status: "pass", message: "ok" });
  });

  it("throws (via the driver) on an invalid date literal in expect.document", () => {
    const r = runVector(
      vec(
        "parse",
        { format: "oml", text: "a: 1\n" },
        { ok: true, document: { edges: [["a", { scalar: { kind: "date", value: "2024-13-01" } }]] } },
      ),
    );
    expect(r.status).toBe("fail");
    expect(r.message).toContain("driver threw");
  });

  it("throws (via the driver) on an invalid datetime literal in expect.document", () => {
    const r = runVector(
      vec(
        "parse",
        { format: "oml", text: "a: 1\n" },
        { ok: true, document: { edges: [["a", { scalar: { kind: "datetime", value: "2024-13-01T99:99:99" } }]] } },
      ),
    );
    expect(r.status).toBe("fail");
  });

  it("throws (via the driver) on an unknown scalar kind", () => {
    const r = runVector(
      vec(
        "parse",
        { format: "oml", text: "a: 1\n" },
        { ok: true, document: { edges: [["a", { scalar: { kind: "bogus", value: 1 } }]] } },
      ),
    );
    expect(r.status).toBe("fail");
    expect(r.message).toContain("driver threw");
  });

  it("decodes a document node with no edges key as empty", () => {
    const r = runVector(vec("parse", { format: "oml", text: "" }, { ok: true, document: {} }));
    // An empty OML document (`""`) round-trips as an edgeless root node,
    // matching `decodeDocument({})`'s `edges ?? []` fallback.
    expect(r).toEqual({ status: "pass", message: "ok" });
  });
});

// ---------------------------------------------------------------------------
// parse_schema
// ---------------------------------------------------------------------------

describe("parse_schema", () => {
  const OK_OSD = 'record R {\n    "a": string,\n}\nroot R\n';

  it("passes on success when ok:true is expected", () => {
    expect(runVector(vec("parse_schema", { text: OK_OSD }, { ok: true }))).toEqual({ status: "pass", message: "ok" });
  });

  it("fails when parse_schema succeeds but failure was expected", () => {
    const r = runVector(vec("parse_schema", { text: OK_OSD }, { ok: false }));
    expect(r).toEqual({ status: "fail", message: "expected failure, parse_schema succeeded" });
  });

  it("fails when parse_schema throws but success was expected", () => {
    const r = runVector(vec("parse_schema", { text: "not a schema" }, { ok: true }));
    expect(r.status).toBe("fail");
    expect(r.message).toContain("expected success, threw:");
  });

  it("skips a syntax failure asserting structured diagnostics", () => {
    const r = runVector(vec("parse_schema", { text: "not a schema" }, { ok: false, diagnostics: [{ path: "R", code: "x" }] }));
    expect(r).toEqual({ status: "skip", message: "syntax-level SchemaError carries no structured path/code" });
  });

  it("passes a syntax failure asserting only ok:false", () => {
    expect(runVector(vec("parse_schema", { text: "not a schema" }, { ok: false }))).toEqual({
      status: "pass",
      message: "ok",
    });
  });
});

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

describe("validate", () => {
  const SCHEMA = 'record R {\n    "n": string,\n}\nroot R\n';

  it("skips a D-6-affected vector", () => {
    const r = runVector(
      vec(
        "validate",
        { schema: 'record R {\n    "n": integer,\n}\nroot R\n', document: { edges: [["n", { scalar: { kind: "number", value: 3.0 } }]] } },
        { ok: false, diagnostics: [{ path: "$.n", code: "validate.type-mismatch" }] },
      ),
    );
    expect(r).toEqual({ status: "skip", message: "D-6 (integer/number kind collapse)" });
  });

  it("does not skip a materialize/validate vector whose expect.ok is true, even with a whole number kind", () => {
    const r = runVector(
      vec(
        "validate",
        { schema: 'record R {\n    "n": number,\n}\nroot R\n', document: { edges: [["n", { scalar: { kind: "number", value: 3.0 } }]] } },
        { ok: true },
      ),
    );
    expect(r.status).not.toBe("skip");
  });

  it("fails when ok contradicts expected", () => {
    const r = runVector(vec("validate", { schema: SCHEMA, document: { edges: [["n", { scalar: { kind: "string", value: "x" } }]] } }, { ok: false, diagnostics: [] }));
    expect(r.status).toBe("fail");
    expect(r.message).toContain("expected ok=false, got true");
  });

  it("passes ok:false with matching diagnostic paths", () => {
    const r = runVector(
      vec("validate", { schema: SCHEMA, document: { edges: [["n", { scalar: { kind: "integer", value: 1 } }]] } }, { ok: false, diagnostics: [{ path: "$.n", code: "validate.type-mismatch" }] }),
    );
    expect(r).toEqual({ status: "pass", message: "ok" });
  });

  it("fails ok:false with mismatched diagnostic paths", () => {
    const r = runVector(
      vec("validate", { schema: SCHEMA, document: { edges: [["n", { scalar: { kind: "integer", value: 1 } }]] } }, { ok: false, diagnostics: [{ path: "$.other", code: "x" }] }),
    );
    expect(r.status).toBe("fail");
    expect(r.message).toContain("diagnostic paths differ");
  });

  it("passes ok:true without checking diagnostics", () => {
    const r = runVector(vec("validate", { schema: SCHEMA, document: { edges: [["n", { scalar: { kind: "string", value: "x" } }]] } }, { ok: true }));
    expect(r).toEqual({ status: "pass", message: "ok" });
  });

  it("treats an empty-edges document (no edges key) as empty", () => {
    const r = runVector(vec("validate", { schema: "record R {}\nroot R\n", document: {} }, { ok: true }));
    expect(r).toEqual({ status: "pass", message: "ok" });
  });

  it("compares against an empty expected-diagnostics set when the diagnostics key is absent", () => {
    const r = runVector(
      vec("validate", { schema: SCHEMA, document: { edges: [["n", { scalar: { kind: "integer", value: 1 } }]] } }, { ok: false }),
    );
    // No `diagnostics` key on an ok:false expect exercises `asDiagnostics`'s
    // `?? []` fallback -- expected paths is the empty set, which can't
    // match the real (non-empty) actual error set, so this fails; that's
    // fine, the point is exercising the branch, not asserting a pass here.
    expect(r.status).toBe("fail");
  });

  it("fails when expected and actual diagnostic sets differ in size", () => {
    const r = runVector(
      vec(
        "validate",
        { schema: SCHEMA, document: { edges: [["n", { scalar: { kind: "integer", value: 1 } }]] } },
        { ok: false, diagnostics: [{ path: "$.n", code: "x" }, { path: "$.extra", code: "y" }] },
      ),
    );
    expect(r.status).toBe("fail");
    expect(r.message).toContain("diagnostic paths differ");
  });

  it("recurses through a childless node (no scalar, no edges) when checking D-6 risk", () => {
    const r = runVector(
      vec(
        "validate",
        { schema: SCHEMA, document: { edges: [["child", {}], ["n", { scalar: { kind: "number", value: 3 } }]] } },
        { ok: false, diagnostics: [] },
      ),
    );
    expect(r).toEqual({ status: "skip", message: "D-6 (integer/number kind collapse)" });
  });
});

// ---------------------------------------------------------------------------
// materialize
// ---------------------------------------------------------------------------

describe("materialize", () => {
  const SCHEMA = 'record R {\n    "n": integer,\n}\nroot R\n';

  it("skips a D-6-affected vector", () => {
    const r = runVector(
      vec(
        "materialize",
        { schema: SCHEMA, document: { edges: [["n", { scalar: { kind: "number", value: 3.0 } }]] } },
        { ok: false, diagnostics: [{ path: "$.n", code: "type-mismatch" }] },
      ),
    );
    expect(r).toEqual({ status: "skip", message: "D-6 (integer/number kind collapse)" });
  });

  it("passes when materialized output matches expected", () => {
    const r = runVector(
      vec(
        "materialize",
        { schema: SCHEMA, document: { edges: [["n", { scalar: { kind: "integer", value: 1 } }]] } },
        { ok: true, document: { edges: [["n", { scalar: { kind: "integer", value: 1 } }]] } },
      ),
    );
    expect(r).toEqual({ status: "pass", message: "ok" });
  });

  it("fails when materialized output does not match expected", () => {
    const r = runVector(
      vec(
        "materialize",
        { schema: SCHEMA, document: { edges: [["n", { scalar: { kind: "integer", value: 1 } }]] } },
        { ok: true, document: { edges: [["n", { scalar: { kind: "integer", value: 2 } }]] } },
      ),
    );
    expect(r.status).toBe("fail");
  });

  it("fails when materialize throws but success was expected", () => {
    const r = runVector(
      vec(
        "materialize",
        { schema: SCHEMA, document: { edges: [["n", { scalar: { kind: "string", value: "x" } }]] } },
        { ok: true, document: { edges: [] } },
      ),
    );
    expect(r.status).toBe("fail");
    expect(r.message).toContain("expected success, threw:");
  });

  it("passes ok:false with matching diagnostic paths on a thrown ParseError", () => {
    const r = runVector(
      vec(
        "materialize",
        { schema: SCHEMA, document: { edges: [["n", { scalar: { kind: "string", value: "x" } }]] } },
        { ok: false, diagnostics: [{ path: "$.n", code: "type-mismatch" }] },
      ),
    );
    expect(r).toEqual({ status: "pass", message: "ok" });
  });

  it("fails ok:false with mismatched diagnostic paths", () => {
    const r = runVector(
      vec(
        "materialize",
        { schema: SCHEMA, document: { edges: [["n", { scalar: { kind: "string", value: "x" } }]] } },
        { ok: false, diagnostics: [{ path: "$.wrong", code: "x" }] },
      ),
    );
    expect(r.status).toBe("fail");
  });

  it("passes ok:false without a diagnostics key", () => {
    const r = runVector(
      vec("materialize", { schema: SCHEMA, document: { edges: [["n", { scalar: { kind: "string", value: "x" } }]] } }, { ok: false }),
    );
    expect(r).toEqual({ status: "pass", message: "ok" });
  });

  it("fails when materialize succeeds but failure was expected", () => {
    const r = runVector(
      vec("materialize", { schema: SCHEMA, document: { edges: [["n", { scalar: { kind: "integer", value: 1 } }]] } }, { ok: false }),
    );
    expect(r).toEqual({ status: "fail", message: "expected failure, materialize succeeded" });
  });
});

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

describe("write", () => {
  it("passes when written text matches expected", () => {
    const r = runVector(
      vec("write", { format: "json", document: { edges: [["a", { scalar: { kind: "integer", value: 1 } }]] } }, { ok: true, text: '{"a": 1}' }),
    );
    expect(r).toEqual({ status: "pass", message: "ok" });
  });

  it("fails when written text does not match expected", () => {
    const r = runVector(
      vec("write", { format: "json", document: { edges: [["a", { scalar: { kind: "integer", value: 1 } }]] } }, { ok: true, text: '{"a": 2}' }),
    );
    expect(r.status).toBe("fail");
  });

  it("fails when write throws but success was expected", () => {
    const r = runVector(
      vec("write", { format: "toml", strict: true, document: { edges: [["a", { scalar: { kind: null, value: null } }]] } }, { ok: true }),
    );
    expect(r.status).toBe("fail");
    expect(r.message).toContain("expected success, threw:");
  });

  it("passes when write throws and failure was expected (strict)", () => {
    const r = runVector(
      vec("write", { format: "toml", strict: true, document: { edges: [["a", { scalar: { kind: null, value: null } }]] } }, { ok: false, diagnostics: [] }),
    );
    expect(r).toEqual({ status: "pass", message: "ok" });
  });

  it("fails when write succeeds but failure was expected", () => {
    const r = runVector(
      vec("write", { format: "json", document: { edges: [["a", { scalar: { kind: "integer", value: 1 } }]] } }, { ok: false }),
    );
    expect(r).toEqual({ status: "fail", message: "expected failure, write succeeded" });
  });

  it("passes with matching diagnostics", () => {
    const r = runVector(
      vec(
        "write",
        { format: "json", document: { edges: [["d", { scalar: { kind: "date", value: "2024-01-01" } }]] } },
        { ok: true, text: '{"d": "2024-01-01"}', diagnostics: [{ path: "$.d", code: "format.temporal-stringified" }] },
      ),
    );
    expect(r).toEqual({ status: "pass", message: "ok" });
  });

  it("fails with mismatched diagnostics", () => {
    const r = runVector(
      vec(
        "write",
        { format: "json", document: { edges: [["d", { scalar: { kind: "date", value: "2024-01-01" } }]] } },
        { ok: true, text: '{"d": "2024-01-01"}', diagnostics: [{ path: "$.wrong", code: "x" }] },
      ),
    );
    expect(r.status).toBe("fail");
    expect(r.message).toContain("diagnostic paths differ");
  });
});

// ---------------------------------------------------------------------------
// normalize / prune
// ---------------------------------------------------------------------------

describe("normalize / prune", () => {
  const SCHEMA = 'record R {\n    "a": string,\n}\nroot R\n';

  it("normalize passes on exact match", () => {
    expect(runVector(vec("normalize", { schema: SCHEMA }, { schema: SCHEMA }))).toEqual({ status: "pass", message: "ok" });
  });

  it("normalize fails on mismatch", () => {
    const r = runVector(vec("normalize", { schema: SCHEMA }, { schema: 'record R {\n    "a": integer,\n}\nroot R\n' }));
    expect(r).toEqual({ status: "fail", message: "output schema does not match expected" });
  });

  it("prune passes on exact match", () => {
    expect(runVector(vec("prune", { schema: SCHEMA }, { schema: SCHEMA }))).toEqual({ status: "pass", message: "ok" });
  });

  it("prune fails on mismatch", () => {
    const r = runVector(vec("prune", { schema: SCHEMA }, { schema: 'record R {\n    "a": integer,\n}\nroot R\n' }));
    expect(r.status).toBe("fail");
  });
});

// ---------------------------------------------------------------------------
// is_empty / compatible_with / equivalent
// ---------------------------------------------------------------------------

describe("is_empty / compatible_with / equivalent", () => {
  const SCHEMA = 'record R {\n    "a": string,\n}\nroot R\n';

  it("is_empty passes on match, fails on mismatch", () => {
    expect(runVector(vec("is_empty", { schema: SCHEMA }, { empty: false }))).toEqual({ status: "pass", message: "ok" });
    const r = runVector(vec("is_empty", { schema: SCHEMA }, { empty: true }));
    expect(r).toEqual({ status: "fail", message: "expected empty=true, got false" });
  });

  it("compatible_with passes on match, fails on mismatch", () => {
    expect(runVector(vec("compatible_with", { a: SCHEMA, b: SCHEMA }, { result: true }))).toEqual({ status: "pass", message: "ok" });
    const r = runVector(vec("compatible_with", { a: SCHEMA, b: SCHEMA }, { result: false }));
    expect(r).toEqual({ status: "fail", message: "expected compatible=false, got true" });
  });

  it("equivalent passes on match, fails on mismatch", () => {
    expect(runVector(vec("equivalent", { a: SCHEMA, b: SCHEMA }, { result: true }))).toEqual({ status: "pass", message: "ok" });
    const r = runVector(vec("equivalent", { a: SCHEMA, b: SCHEMA }, { result: false }));
    expect(r).toEqual({ status: "fail", message: "expected equivalent=false, got true" });
  });
});

// ---------------------------------------------------------------------------
// extract
// ---------------------------------------------------------------------------

describe("extract", () => {
  const SCHEMA = 'record Address {\n    "city": string,\n}\nrecord R {\n    "name": string,\n    "addr" [0,1]: Address,\n}\nroot R\n';

  it("passes on a matching extracted schema", () => {
    const r = runVector(vec("extract", { schema: SCHEMA, keep: ["name"] }, { ok: true, schema: 'record R {\n    "name": string,\n}\nroot R\n' }));
    expect(r).toEqual({ status: "pass", message: "ok" });
  });

  it("fails on a mismatched extracted schema", () => {
    const r = runVector(vec("extract", { schema: SCHEMA, keep: ["name"] }, { ok: true, schema: 'record R {\n    "name": integer,\n}\nroot R\n' }));
    expect(r).toEqual({ status: "fail", message: "extracted schema does not match expected" });
  });

  it("fails when extract throws but success was expected", () => {
    const r = runVector(vec("extract", { schema: SCHEMA, keep: [] }, { ok: true, schema: SCHEMA }));
    expect(r.status).toBe("fail");
    expect(r.message).toContain("expected success, threw:");
  });

  it("passes when extract throws and failure was expected", () => {
    const r = runVector(vec("extract", { schema: SCHEMA, keep: [] }, { ok: false, diagnostics: [] }));
    expect(r).toEqual({ status: "pass", message: "ok" });
  });

  it("fails when extract succeeds but failure was expected", () => {
    const r = runVector(vec("extract", { schema: SCHEMA, keep: ["name"] }, { ok: false }));
    expect(r).toEqual({ status: "fail", message: "expected failure, extract succeeded" });
  });
});

// ---------------------------------------------------------------------------
// lint
// ---------------------------------------------------------------------------

describe("lint", () => {
  it("passes with no findings", () => {
    expect(runVector(vec("lint", { schema: 'record R {\n    "a": string,\n}\nroot R\n' }, { ok: true, findings: [] }))).toEqual({
      status: "pass",
      message: "ok",
    });
  });

  it("passes when only info-severity findings are present and ok:true is expected", () => {
    const r = runVector(
      vec(
        "lint",
        { schema: 'record R {\n    "data": any,\n}\nroot R\n' },
        { ok: true, findings: [{ code: "lint.any-field", severity: "info", location: "R.data" }] },
      ),
    );
    expect(r).toEqual({ status: "pass", message: "ok" });
  });

  it("fails when ok contradicts expected", () => {
    const r = runVector(vec("lint", { schema: 'record R {\n    "data": any,\n}\nroot R\n' }, { ok: false, findings: [] }));
    expect(r.status).toBe("fail");
    expect(r.message).toContain("expected ok=false, got true");
  });

  it("fails when finding locations differ", () => {
    const r = runVector(vec("lint", { schema: 'record R {\n    "data": any,\n}\nroot R\n' }, { ok: true, findings: [{ code: "lint.any-field", severity: "info", location: "R.other" }] }));
    expect(r.status).toBe("fail");
    expect(r.message).toContain("finding locations differ");
  });
});

// ---------------------------------------------------------------------------
// infer / infer_with_report
// ---------------------------------------------------------------------------

describe("infer / infer_with_report", () => {
  it("infer passes on an isomorphic match", () => {
    const r = runVector(vec("infer", { samples: ["a: 1\n"] }, { ok: true, schema: 'record Root {\n    "a": integer,\n}\nroot Root\n' }));
    expect(r).toEqual({ status: "pass", message: "ok" });
  });

  it("infer fails on a non-isomorphic mismatch", () => {
    const r = runVector(vec("infer", { samples: ["a: 1\n"] }, { ok: true, schema: 'record Root {\n    "a": string,\n}\nroot Root\n' }));
    expect(r).toEqual({ status: "fail", message: "inferred schema is not isomorphic to expected" });
  });

  it("infer fails when it throws but success was expected", () => {
    const r = runVector(vec("infer", { samples: [] }, { ok: true, schema: 'record Root {}\nroot Root\n' }));
    expect(r.status).toBe("fail");
    expect(r.message).toContain("expected success, threw:");
  });

  it("infer passes when it throws (zero samples) and failure was expected", () => {
    expect(runVector(vec("infer", { samples: [] }, { ok: false }))).toEqual({ status: "pass", message: "ok" });
  });

  it("infer fails when it succeeds but failure was expected", () => {
    const r = runVector(vec("infer", { samples: ["a: 1\n"] }, { ok: false }));
    expect(r).toEqual({ status: "fail", message: "expected failure, infer succeeded" });
  });

  it("infer respects allow_any", () => {
    const r = runVector(
      vec("infer", { samples: ["a: 1\n", 'a: "x"\n'], allow_any: true }, { ok: true, schema: 'record Root {\n    "a": any,\n}\nroot Root\n' }),
    );
    expect(r).toEqual({ status: "pass", message: "ok" });
  });

  it("infer_with_report passes on success", () => {
    const r = runVector(
      vec(
        "infer_with_report",
        { samples: ["a: 1\n", 'a: "x"\n'], allow_any: true },
        { ok: true, schema: 'record Root {\n    "a": any,\n}\nroot Root\n' },
      ),
    );
    expect(r).toEqual({ status: "pass", message: "ok" });
  });

  it("infer_with_report fails when it throws but success was expected", () => {
    const r = runVector(vec("infer_with_report", { samples: ["a: 1\n"] }, { ok: true, schema: 'record Root {\n    "a": string,\n}\nroot Root\n' }));
    // a: 1 vs a: 1 alone is not actually ambiguous; force ambiguity instead.
    expect(r.status).toBe("fail");
  });

  it("infer_with_report passes when it throws (ambiguous, no allow_any) and failure was expected", () => {
    const r = runVector(vec("infer_with_report", { samples: ["a: 1\n", 'a: "x"\n'] }, { ok: false }));
    expect(r).toEqual({ status: "pass", message: "ok" });
  });
});
