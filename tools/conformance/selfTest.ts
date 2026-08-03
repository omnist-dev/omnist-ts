#!/usr/bin/env node
/**
 * Runs vendor/omnist-spec's conformance/fixtures/_referee-self-test/ --
 * proves the referee's own comparison logic is trustworthy before it
 * judges any real implementation output. Sec6 of omnist-spec's
 * docs/conformance-harness.md.
 *
 * Ported from Python's `omnist`'s `tools/conformance/self_test.py`
 * (itself ported from omnist-spec's `conformance/orchestrator/self_test.py`,
 * issue #283) with no change to the comparison logic -- only FIXTURES_DIR
 * now points at this repo's own pinned submodule.
 *
 * Usage:
 *
 *     npx tsx tools/conformance/selfTest.ts
 *     npm run conformance:self-test
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { compareDocument, compareSchema } from "./referee.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(
  HERE,
  "..",
  "..",
  "vendor",
  "omnist-spec",
  "conformance",
  "fixtures",
  "_referee-self-test",
);

function read(...parts: string[]): string {
  return readFileSync(path.join(...parts), "utf-8");
}

interface CaseResult {
  passed: boolean;
  message: string;
}

export function runCase(caseDir: string): CaseResult {
  const kind = read(caseDir, "kind.txt").trim();
  const expect = read(caseDir, "expect.txt").trim();
  if (expect !== "equal" && expect !== "not-equal") {
    return { passed: false, message: `bad expect.txt value ${JSON.stringify(expect)}` };
  }
  const expectEqual = expect === "equal";

  let actualEqual: boolean;
  if (kind === "document") {
    const a = read(caseDir, "a.oml");
    const b = read(caseDir, "b.oml");
    actualEqual = compareDocument(a, b);
  } else if (kind === "schema") {
    const mode = read(caseDir, "mode.txt").trim();
    const a = read(caseDir, "a.osd");
    const b = read(caseDir, "b.osd");
    actualEqual = compareSchema(a, b, mode);
  } else {
    return { passed: false, message: `bad kind.txt value ${JSON.stringify(kind)}` };
  }

  if (actualEqual === expectEqual) {
    return { passed: true, message: "ok" };
  }
  return {
    passed: false,
    message: `expected ${expectEqual ? "equal" : "not-equal"}, got ${actualEqual ? "equal" : "not-equal"}`,
  };
}

/**
 * Runs every case directory found under `fixturesDir` (defaults to this
 * repo's pinned `vendor/omnist-spec/conformance/fixtures/_referee-self-test/`)
 * and prints PASS/FAIL per case plus a summary line. Takes the directory as
 * a parameter (rather than hard-coding it, as Python's self_test.py's
 * module-level FIXTURES_DIR does) so tests can point it at a scratch
 * directory to exercise the not-a-directory/no-cases branches without
 * needing to delete the real submodule checkout.
 */
export function main(fixturesDir: string = FIXTURES_DIR): number {
  if (!statOrNull(fixturesDir)?.isDirectory()) {
    console.error(`no self-test fixtures found at ${fixturesDir}`);
    return 2;
  }

  const cases = readdirSync(fixturesDir)
    .map((name) => path.join(fixturesDir, name))
    .filter((p) => statSync(p).isDirectory())
    .sort();

  if (cases.length === 0) {
    console.error(`no self-test fixtures found at ${fixturesDir}`);
    return 2;
  }

  let failures = 0;
  for (const caseDir of cases) {
    const purposeFile = path.join(caseDir, "purpose.txt");
    const purpose = statOrNull(purposeFile) ? read(purposeFile).split("\n")[0] : "";
    const { passed, message } = runCase(caseDir);
    const status = passed ? "PASS" : "FAIL";
    console.log(`[${status}] ${path.basename(caseDir)} (${purpose}): ${message}`);
    if (!passed) failures += 1;
  }

  console.log(`\n${cases.length - failures}/${cases.length} self-test cases passed`);
  return failures ? 1 : 0;
}

function statOrNull(p: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

/* c8 ignore start -- entry point, not importable behavior (mirrors Python's
 * `if __name__ == "__main__":` exclusion in self_test.py) */
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
/* c8 ignore stop */
