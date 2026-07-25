#!/usr/bin/env node
/**
 * Fail CI if a PR adds or changes a fenced code block in docs/*.md without
 * either a `verified-by` marker (naming the test that checks its exact
 * literal output) or an explicit `doc-illustrative` opt-out.
 *
 * This does not verify a marker is honest -- it only requires one to
 * exist. Port of the Python project's tools/check_doc_examples.py; see
 * that project's issue #249 for the stronger check (confirming the named
 * test's captured output actually contains the doc's literal text).
 *
 * Usage: tsx tools/check_doc_examples.ts [--base-ref origin/master]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

export const FENCE_RE = /^```/;
export const MARKER_RE = /<!--\s*(verified-by:\s*[^>]+?|doc-illustrative)\s*-->/;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

export function changedDocFiles(cwd: string, baseRef: string): string[] {
  const out = git(cwd, "diff", "--name-only", `${baseRef}...HEAD`, "--", "docs/");
  return out
    .split("\n")
    .filter((p) => p.length > 0 && p.endsWith(".md"));
}

export function changedLineNumbers(cwd: string, path: string, baseRef: string): Set<number> {
  const out = git(cwd, "diff", "-U0", `${baseRef}...HEAD`, "--", path);
  const changed = new Set<number>();
  const hunkRe = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
  for (const line of out.split("\n")) {
    const m = hunkRe.exec(line);
    if (m !== null) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- group 1 always captures on a match
      const start = parseInt(m[1]!, 10);
      const count = m[2] !== undefined ? parseInt(m[2], 10) : 1;
      for (let i = start; i < start + count; i++) changed.add(i);
    }
  }
  return changed;
}

/** [(fenceOpenLine, fenceCloseLine)] -- 1-indexed, inclusive. */
export function findBlocks(path: string): Array<[number, number]> {
  const lines = readFileSync(path, "utf-8").split("\n");
  const blocks: Array<[number, number]> = [];
  let i = 0;
  while (i < lines.length) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- i is always in-bounds by the loop condition
    if (FENCE_RE.test(lines[i]!)) {
      const start = i + 1;
      let j = i + 1;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- j is always in-bounds by the while condition
      while (j < lines.length && !lines[j]!.startsWith("```")) j++;
      blocks.push([start, j + 1]);
      i = j + 1;
    } else {
      i++;
    }
  }
  return blocks;
}

/** A marker directly before the fence or directly after it counts. */
export function hasMarker(path: string, blockEndLine: number): boolean {
  const lines = readFileSync(path, "utf-8").split("\n");
  for (const offset of [-2, -1, 0, 1]) {
    const idx = blockEndLine + offset - 1;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- idx bounds just checked above
    if (idx >= 0 && idx < lines.length && MARKER_RE.test(lines[idx]!)) return true;
  }
  return false;
}

export function main(argv: string[] = process.argv.slice(2), cwd: string = process.cwd()): number {
  let baseRef = "origin/master";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base-ref" && argv[i + 1] !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- just checked !== undefined
      baseRef = argv[i + 1]!;
      i++;
    }
  }

  const problems: string[] = [];
  for (const relPath of changedDocFiles(cwd, baseRef)) {
    const path = `${cwd}/${relPath}`;
    if (!existsSync(path)) continue;
    const changed = changedLineNumbers(cwd, relPath, baseRef);
    for (const [start, end] of findBlocks(path)) {
      let touched = false;
      for (let n = start; n <= end; n++) {
        if (changed.has(n)) {
          touched = true;
          break;
        }
      }
      if (!touched) continue;
      if (!hasMarker(path, end)) {
        problems.push(
          `${relPath}:${start}-${end}: new/changed code block has no ` +
            "<!-- verified-by: path::testName --> or <!-- doc-illustrative --> marker",
        );
      }
    }
  }

  if (problems.length > 0) {
    console.log("Doc-example coverage check failed:\n");
    for (const p of problems) console.log(`  ${p}`);
    console.log(
      "\nEvery code block that shows literal output needs a verified-by " +
        "marker naming the test that asserts that exact text, or a " +
        "doc-illustrative marker if it's a diagram/table/grammar fragment " +
        "with no runnable claim. See docs/testing.md.",
    );
    return 1;
  }

  console.log("Doc-example coverage check passed.");
  return 0;
}

/* c8 ignore start -- entry point, not importable behavior */
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
/* c8 ignore stop */
