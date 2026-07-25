/**
 * Tests for tools/check_doc_examples.ts -- the CI gate requiring a marker
 * on every new/changed code block in docs/*.md. Uses a throwaway git repo
 * per test so the check's git-diffing logic runs against real history, not
 * a mock. Calls the module in-process (not via subprocess) so coverage
 * traces it. Port of the Python project's tests/test_check_doc_examples.py.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FENCE_RE, MARKER_RE, main } from "../tools/check_doc_examples.js";

let repo: string;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf-8" });
}

function markOriginAtHead(): void {
  const sha = git("rev-parse", "HEAD").trim();
  writeFileSync(join(repo, ".git", "refs", "remotes", "origin", "master"), sha + "\n");
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "doc-examples-"));
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  mkdirSync(join(repo, "docs"));
  writeFileSync(join(repo, "docs", "guide.md"), "# Guide\n\nSome intro text.\n");
  git("add", "-A");
  git("commit", "-q", "-m", "initial");
  mkdirSync(join(repo, ".git", "refs", "remotes", "origin"), { recursive: true });
  markOriginAtHead();
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function guidePath(): string {
  return join(repo, "docs", "guide.md");
}

function appendAndCommit(text: string, message: string): void {
  const p = guidePath();
  writeFileSync(p, readFileSync(p, "utf-8") + text);
  git("add", "-A");
  git("commit", "-q", "-m", message);
}

function runCheck(): { code: number; out: string } {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };
  try {
    const code = main(["--base-ref", "origin/master"], repo);
    return { code, out: logs.join("\n") };
  } finally {
    console.log = orig;
  }
}

describe("check_doc_examples", () => {
  it("passes with no changes", () => {
    const { code, out } = runCheck();
    expect(code).toBe(0);
    expect(out).toContain("passed");
  });

  it("fails on a new unmarked block", () => {
    appendAndCommit("\n```python\nprint(1)\n```\n", "add unmarked block");
    const { code, out } = runCheck();
    expect(code).toBe(1);
    expect(out).toContain("no <!-- verified-by");
    expect(out).toContain("guide.md");
  });

  it("passes with a verified-by marker", () => {
    appendAndCommit(
      "\n```python\nprint(1)\n```\n<!-- verified-by: tests/test_docs.py::test_x -->\n",
      "add marked block",
    );
    const { code } = runCheck();
    expect(code).toBe(0);
  });

  it("handles a single-line hunk (no comma count in the diff header)", () => {
    // A one-line modification to an *existing* line, with no surrounding
    // lines added/removed, produces a "@@ -N +M @@" hunk header with no
    // ",count" suffix -- exercises the implicit-count-of-1 branch.
    const p = guidePath();
    writeFileSync(p, readFileSync(p, "utf-8").replace("Some intro text.", "Some intro text!"));
    git("add", "-A");
    git("commit", "-q", "-m", "tweak one line");
    const { code } = runCheck();
    expect(code).toBe(0);
  });

  it("passes with a doc-illustrative marker", () => {
    appendAndCommit(
      "\n```mermaid\ngraph LR\n  a --> b\n```\n<!-- doc-illustrative -->\n",
      "add illustrative block",
    );
    const { code } = runCheck();
    expect(code).toBe(0);
  });

  it("does not flag an unchanged existing block in a touched file", () => {
    appendAndCommit("\n```python\nprint('old')\n```\n", "pre-existing unmarked block");
    markOriginAtHead();
    appendAndCommit(
      "\n## New section\n\n```python\nprint('new')\n```\n<!-- verified-by: tests/test_docs.py::test_y -->\n",
      "add a new marked block, leave the old one alone",
    );
    const { code } = runCheck();
    expect(code).toBe(0);
  });

  it("skips a deleted doc file rather than crashing", () => {
    appendAndCommit("\n```python\nprint(1)\n```\n", "add unmarked block");
    markOriginAtHead();
    rmSync(guidePath());
    git("add", "-A");
    git("commit", "-q", "-m", "delete guide.md");
    const { code } = runCheck();
    expect(code).toBe(0);
  });

  it("recognizes fence and marker patterns", () => {
    expect(FENCE_RE.test("```python")).toBe(true);
    expect(FENCE_RE.test("not a fence")).toBe(false);
    expect(MARKER_RE.test("<!-- verified-by: a::b -->")).toBe(true);
    expect(MARKER_RE.test("<!-- doc-illustrative -->")).toBe(true);
    expect(MARKER_RE.test("<!-- some other comment -->")).toBe(false);
  });

  it("defaults --base-ref to origin/master when not passed", () => {
    const code = main([], repo);
    expect(code).toBe(0);
  });
});
