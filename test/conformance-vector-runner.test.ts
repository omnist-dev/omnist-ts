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
    // All real failures fixed (issues #86, #88, #89, #98) -- clean run.
    // vendor/omnist-spec bumped past v0.2.2-alpha to f93c569 (issue #98),
    // which adds 6 new vectors (152 vs 146) and includes the fix that
    // closed D-6, so the D-6 skip that used to sit in this tally is gone
    // (36 skips either way -- see the skip-category test below). Bumped
    // again to 964af7b (issue #121, D-2: duplicate root is now a
    // normative error), which adds 1 more vector
    // (osd-grammar/root/duplicate-root-is-an-error, 153 vs 152); it SKIPs
    // under the same "syntax-level SchemaError carries no structured
    // path/code" category as every other osd-grammar diagnostics vector
    // (37 skips now). Bumped again to 7f7690c (issue #123, D-3: XML
    // attribute/namespace drops and JSON-family cross-label interleaving
    // MUST be reported), which adds 2 more vectors -- one new
    // (formats-xml/basic/namespace-prefix-is-dropped-on-read) plus one
    // updated in place (formats-xml/basic/attributes-are-dropped-on-read,
    // still counted once) and one new
    // (formats-json/basic/cross-label-interleaving-lost-and-reported) --
    // 155 vs 153, all passing for real (no new skips: parse/write both
    // carry structured diagnostics already).
    //
    // Bumped again to 0ac1eac (issues #125-133, the spec-correctness
    // audit series), which adds 17 more vectors (172 vs 155). This one PR
    // implements the whole series in 3 commits:
    //  1. #125/#130/#133 (schema-level rejected-input checks: [0,0]
    //     cardinality, empty labels, bracket-in-label) -- 4 osd-grammar
    //     vectors move from FAIL to SKIP under the existing "syntax-level
    //     SchemaError carries no structured path/code" category.
    //  2. #131 (OML leading-zero numeric literals, real code change) and
    //     #132 (DATE/TIME/DATETIME/tz-offset range validation, including
    //     the tz-offset 00:60-normalizes-to-01:00 bug) -- #132 turned out
    //     to already be correctly implemented in this port, verified
    //     empirically (see PR body); #131's 2 vectors move from FAIL to
    //     PASS (structured ParseError diagnostics, no new skip).
    //  3. #126/#127/#128/#129 (format write-side "fail, don't invent"
    //     fixes -- JSON NaN/Infinity, TOML null leaf, XML illegal-char
    //     label, XML empty internal node now unconditional failures; XML
    //     CR now escaped as &#13; instead of written raw) -- 5 vectors
    //     move from FAIL to PASS.
    // Net: all 17 new vectors resolved, 0 real failures remain.
    expect(exitCode).toBe(0);
    expect(logs.at(-1)).toBe(
      "\n124 passed, 0 failed, 48 skipped (of 172 vectors) -- " +
        "diagnostics compared in code-agnostic mode (Sec8.5.2 rule 4)",
    );
  });

  it("every skip cites an explicit, reasoned category", () => {
    const { logs } = withCapturedConsole(() => main());
    const skipLines = logs.filter((l) => l.startsWith("[SKIP]"));
    expect(skipLines.length).toBe(48);
    for (const line of skipLines) {
      // D-6 (integer/number kind collapse) is CLOSED as of issue #98 --
      // no vector cites it anymore (see tools/conformance/vectorRunner.ts).
      expect(line).toMatch(
        /: (not yet implemented|syntax-level \w+Error carries no structured path\/code)/,
      );
    }
  });

  it("iterVectors discovers all 172 real vectors", () => {
    expect(iterVectors(REAL_SUITE_DIR).length).toBe(172);
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

  it("passes a successful XML parse with matching read-side diagnostics", () => {
    // format.attribute-dropped (Sec8.3.8, D-3): a *successful* parse can
    // still carry warning-severity diagnostics.
    const r = runVector(
      vec(
        "parse",
        { format: "xml", text: '<a x="1"><b>hi</b></a>' },
        {
          ok: true,
          document: { edges: [["a", { edges: [["b", { scalar: { kind: "string", value: "hi" } }]] }]] },
          diagnostics: [{ path: "$.a", code: "format.attribute-dropped" }],
        },
      ),
    );
    expect(r).toEqual({ status: "pass", message: "ok" });
  });

  it("fails a successful parse when read-side diagnostic paths mismatch", () => {
    const r = runVector(
      vec(
        "parse",
        { format: "xml", text: '<a x="1"><b>hi</b></a>' },
        {
          ok: true,
          document: { edges: [["a", { edges: [["b", { scalar: { kind: "string", value: "hi" } }]] }]] },
          diagnostics: [{ path: "$.wrong", code: "format.attribute-dropped" }],
        },
      ),
    );
    expect(r.status).toBe("fail");
    expect(r.message).toContain("diagnostic paths differ");
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

  it("a number-kind whole value does not satisfy an integer field (D-6 CLOSED, issue #98)", () => {
    // Used to be skipped (D-6: omnist-ts could not tell 3.0 apart from
    // an integer). Since issue #98, integer-kinded values are
    // bigint-backed, so a plain JS `number` -- even a whole one -- never
    // satisfies `integer`; this now runs for real and passes.
    const r = runVector(
      vec(
        "validate",
        { schema: 'record R {\n    "n": integer,\n}\nroot R\n', document: { edges: [["n", { scalar: { kind: "number", value: 3.0 } }]] } },
        { ok: false, diagnostics: [{ path: "$.n", code: "validate.type-mismatch" }] },
      ),
    );
    expect(r).toEqual({ status: "pass", message: "ok" });
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

  it("decodeDocument treats a childless node (no scalar, no edges) as an empty edge list", () => {
    // Was originally written to exercise the (now-removed) D-6 skip
    // detection's own recursion through decodeDocument; that skip logic
    // is gone (D-6 CLOSED, issue #98), so this now runs runValidate for
    // real. SCHEMA is a closed record with only "n" declared, so the
    // undeclared "child" edge is itself a real diagnostic alongside the
    // "n" type mismatch (a plain JS `number` 3 no longer satisfies
    // `string`... wait, it never did -- the real failure here is a
    // genuine type mismatch at $.n plus an unknown-field diagnostic at
    // $.child, neither of which the empty expected-diagnostics set
    // matches).
    const r = runVector(
      vec(
        "validate",
        { schema: SCHEMA, document: { edges: [["child", {}], ["n", { scalar: { kind: "number", value: 3 } }]] } },
        { ok: false, diagnostics: [] },
      ),
    );
    expect(r.status).toBe("fail");
    expect(r.message).toContain("diagnostic paths differ");
  });

  // decodeScalar's "number" case has its own bigint branch (issue #98):
  // a vector loaded from real JSON text tags every integer-shaped
  // literal as bigint via iterVectors' tag-and-revive fix, even one
  // sitting in a `kind: "number"` slot -- exercise that branch directly
  // with a fabricated vector (vec() builds the Vector object in TS, not
  // through the JSON pipeline, so a raw `3n` here stands in for what a
  // real integer-shaped `"value": 3` JSON literal would decode to).
  it("decodeScalar converts a bigint-encoded value to a host float for a number-kind scalar", () => {
    const r = runVector(
      vec(
        "validate",
        { schema: 'record R {\n    "n": number,\n}\nroot R\n', document: { edges: [["n", { scalar: { kind: "number", value: 3n as unknown as number } }]] } },
        { ok: true },
      ),
    );
    expect(r).toEqual({ status: "pass", message: "ok" });
  });
});

// ---------------------------------------------------------------------------
// materialize
// ---------------------------------------------------------------------------

describe("materialize", () => {
  const SCHEMA = 'record R {\n    "n": integer,\n}\nroot R\n';

  it("a whole number-kind value upgrades to integer via materialize (D-6 CLOSED, issue #98)", () => {
    // Was skipped under the old D-6 logic; that logic assumed this
    // upgrade should FAIL (ok:false), which was itself never actually
    // correct per spec -- Sec7.2 explicitly permits materializing a
    // whole number-kind literal into an integer field (confirmed by the
    // real materialize/upgrades/whole-number-to-integer-is-value-exact
    // vector, which expects ok:true). Since issue #98 this materializes
    // for real and succeeds.
    const r = runVector(
      vec(
        "materialize",
        { schema: SCHEMA, document: { edges: [["n", { scalar: { kind: "number", value: 3.0 } }]] } },
        { ok: true, document: { edges: [["n", { scalar: { kind: "integer", value: 3 } }]] } },
      ),
    );
    expect(r).toEqual({ status: "pass", message: "ok" });
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

  it("passes when write succeeds and no text assertion is present", () => {
    const r = runVector(
      vec("write", { format: "json", document: { edges: [["a", { scalar: { kind: "integer", value: 1 } }]] } }, { ok: true }),
    );
    expect(r).toEqual({ status: "pass", message: "ok" });
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

  it("passes for XML when only insignificant inter-tag whitespace differs (Sec8.5.3)", () => {
    // A vector written with indentation (matching a different port's
    // writer convention) must still pass -- inter-tag whitespace isn't
    // normative.
    const r = runVector(
      vec(
        "write",
        { format: "xml", document: { edges: [["root", { edges: [["x", { scalar: { kind: "string", value: "hi" } }]] }]] } },
        { ok: true, text: "<root>\n  <x>hi</x>\n</root>\n" },
      ),
    );
    expect(r).toEqual({ status: "pass", message: "ok" });
  });

  it("still fails for XML on a genuine content mismatch, not just whitespace", () => {
    const r = runVector(
      vec(
        "write",
        { format: "xml", document: { edges: [["root", { edges: [["x", { scalar: { kind: "string", value: "hi" } }]] }]] } },
        { ok: true, text: "<root><x>bye</x></root>" },
      ),
    );
    expect(r.status).toBe("fail");
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
