# DevOps playbook (ported from omnist Python)

This is the standing operating procedure for AI-agent-driven development on
this repo, carried over from the upstream Python project
([omnist-dev/omnist](https://github.com/omnist-dev/omnist)). The public
writeup of the original version is
[lee.yt/posts/the-devops-team-that-never-sleeps](https://lee.yt/posts/the-devops-team-that-never-sleeps/);
this file is the working reference, adapted for a TypeScript toolchain and
annotated with lessons learned since that post was written.

## The eight rules

1. **Agree on the plan before any code.** Argue the design out first; once
   settled, it doesn't get re-litigated mid-build.
2. **Make the spec precise enough that no one has to come ask.**
   Agreed-but-fuzzy isn't done — pin the awkward cases (empty input, error
   text) or the builder guesses, and guessing is where unsupervised work
   goes wrong. For structural/placement decisions specifically, do the
   full-context review *before* proposing a location, not after being
   asked.
3. **The agent that builds it never gets to sign it off.** A different
   agent (or the controller, re-running it) reviews every change —
   correctness against spec, speed against explicit targets. Exception,
   stated explicitly rather than silently taken: for a single-line, purely
   cosmetic change with no logic surface, already confirmed some other
   way, self-verification is an acceptable substitute for a full
   independent-verification dispatch — but say out loud that's what's
   happening and why.
4. **Match the model to the task** (see tier table below). This is a
   scale-dependent rule — it pays off on a multi-day/unattended build with
   many independent chunks of work. For small increments inside a single
   interactive session, doing mechanical/algorithmic/design work directly
   is fine.
5. **Run in parallel only what's truly independent.** If one task's output
   feeds another, sequence them, don't race them. Check *informational*
   dependency too, not just file-ownership — two tasks that don't share a
   file can still share meaning (e.g. both need the same upstream design
   decision resolved first).
6. **Test like you don't trust yourself.** 100% coverage, fuzzing/property
   tests, doc examples that run as tests — and for behavior changes, prove
   the test can fail before trusting it can pass (see "Red before green"
   below). This extends past coverage numbers: a claim that code is
   *unreachable* needs the same empirical proof as a claim that code is
   *covered* — don't delete "dead" code on inspection alone; run an actual
   adversarial/exhaustive check and show the result before removing it.
7. **Ship code, tests, and docs together, or don't ship.** One unit per
   version, never one out of step with the others. This includes the
   version bump itself — a release that's "just docs" still gets its bump
   and changelog entry in the *same* PR, not a follow-up PR caught after
   the fact.
8. **Leave a trail for everything.** Spec, outcome, and every surprise
   found along the way all get written down. Filing the issue-as-spec
   first shouldn't be skipped for expedience just because the plan was
   already agreed in chat — if it gets skipped anyway for a small change,
   that's a conscious trade-off to name, not a default.

## The tech lead and the team

One **master agent** (the controller) plays tech lead — doesn't write
code, runs the team: breaks the signed-off plan into tasks, assigns tier,
decides parallel-vs-sequential, starts/tracks workers, sends finished work
to a *different* worker to review, files an issue when work uncovers a new
problem, merges only on clean review.

**Worker tiers:**

| Tier | Model | Good for | Example tasks |
|---|---|---|---|
| Mechanical | Cheapest, fastest | Rote, mechanical right answer | find-and-replace, version bumps across the same files, running the suite, opening a branch/PR |
| Algorithmic | Balanced | Real logic, but a spec already says what "correct" is | implementing a feature to a written issue, root-causing a failed test run, **verifying another agent's work against the spec**, extracting a function while proving behavior unchanged |
| Design | Most capable | Open-ended, no spec yet, consequences that outlive the change | deciding a design question and writing down why, turning that into a spec, proposing a fix + flagging the tech lead to replan when work uncovers a deeper problem, ordering a multi-step release so no half-finished state is unsafe to ship |

Why tier at all: a capable model costs far more per task, so cheap work on
a cheap model keeps the token bill sane. Quality doesn't ride on the call
anyway — a second agent reviews everything regardless of who built it.

## The loop (9 steps, each with its own audit-trail artifact)

1. File an issue with the actual spec in the body (design + reasoning, not
   "fix X") — artifact: the issue body.
2. Cut a branch, pick the tier, start an implementer — artifact: branch
   name references the issue.
3. Build to the spec (worker agent) — artifact: commits + opened PR.
4. Run the full suite in CI — artifact: pass/fail logs on the PR.
5. Verify independently, correctness + performance — artifact: a written
   verdict with evidence.
6. If verification finds a problem, fix and re-verify; if the plan itself
   has to change, say so on the issue — artifact: a comment, never a
   silent patch.
7. If work uncovers a *separate* problem, file a new issue — artifact: new
   issue linked back to where it was found.
8. Merge, tag, release — artifact: changelog entry, tag, release notes.
9. Close the issue with a summary of what actually happened, including any
   divergence from plan — artifact: the closing comment (plan vs. reality,
   one place).

Three places hold the whole story: the spec (issue body, written before
work starts), the outcomes (PR + closing comment, including deviations),
new discoveries (written the moment they surface). Anyone arriving cold —
including a future session with no memory of this one — can reconstruct
any change from the tracker alone.

**Plan-approval gate is a distinct step from filing the issue.** Filing a
well-specified issue is not the same as the user having read and approved
it — launching an implementer must wait for explicit sign-off after the
plan is shown, every time.

## Red before green

For any change to library code — new behavior or a bug fix — the
implementer writes the test(s) first, runs them, and shows the actual
**failure** output in the report, before touching the implementation. Only
then does it implement to green, and shows the actual **passing** output
too. The independent verifier's job explicitly includes **reproducing the
red state itself**. A test nobody has watched fail is unverified as a real
test.

**Scoped by tier:**
- **Design-tier changes** (new capability class, touches the algebra):
  test obligations get specified in the plan/issue itself, before
  implementation starts.
- **Algorithmic-tier changes** (bug fixes, features against an existing
  spec): implementer owns red-then-green; verifier reproduces it.
- **Mechanical/docs-only work**: no TDD — most of it has no behavior claim
  to drive with a failing test. Existing behavior gets a **characterization
  test** instead (written once, green from the start, protecting against
  regression).
- A mechanical-looking task that turns out to be a bug fix graduates to
  the algorithmic-tier rule regardless of diff size.

## 100% coverage standard

Every release ships at 100% line coverage across the whole repo — the
library itself *and* the test/tooling files that exercise it, not just the
`src/` package.

Gaps are small and mechanically classifiable, not open-ended:

1. **Defensive trip-wires** — an assertion inside a negative test that, by
   construction, never executes while the suite passes. Annotate with the
   toolchain's coverage-ignore comment (TS/Istanbul: `/* c8 ignore next */`
   or equivalent) plus a one-line reason — don't write a test that
   deliberately breaks the library to hit it.
2. **Rare-but-real branches** — a genuine code path a fuzzer/property test
   rarely generates by chance. Force it deterministically with a direct
   unit test or an explicit seeded example, not left to random-seed luck.
3. **Unreachable dead code** — confirmed via an actual exhaustive/adversarial
   check (not just static reading) before deleting.

Update every doc that quotes the coverage percentage in the same release
that changes it.

## Doc-example CI gate

Every code example shown in the docs must be tested and CI-enforced per
PR, not just audited once and left to rot. The pattern (ported from
Python's `tools/check_doc_examples.py`):

- A script diffs `docs/**/*.md` against the PR's base branch.
- For every fenced code block **added or changed**, requires a marker
  immediately before/after it: `<!-- verified-by: path/to/test.ts::testName -->`
  naming the test that asserts the block's exact literal output, or
  `<!-- doc-illustrative -->` as an explicit opt-out for diagrams/tables/
  grammar fragments with no runnable claim.
- Wired into CI as its own job, `pull_request`-only, with full git history
  fetched so the base-ref diff actually works.
- **Known, deliberate gap**: this only checks a marker is *present*, not
  that a `verified-by` marker is *honest* (the named test really does
  assert the doc's exact text, not a derived property standing in for
  it). This was evaluated in the Python project (issue
  [omnist-dev/omnist#249](https://github.com/omnist-dev/omnist/issues/249))
  and deliberately **not built** — the marker-presence gate already fixes
  the dominant failure mode ("no test at all"), and the residual risk is
  better handled by periodic manual re-audits (a parallel multi-agent pass
  over every doc file, cross-referencing actual test bodies, not test
  names) before each minor release, than by solving "verify a test's
  intent" in general. Don't re-litigate this without a concrete case where
  the "wrong test" pattern is actually recurring.

**Why this matters, concretely**: the motivating incident was a doc
example showing a hardcoded version string that drifted for 5+ releases,
undetected, because the test guarding it checked the *live* version, never
the doc's own displayed text. A test existing with a plausible name is not
proof the doc's actual content is checked.

## When the port disagrees with upstream Python

Porting will surface cases where this implementation's behavior differs
from the Python original. Two different situations, two different
responses — don't default to "match Python" without asking which one
you're in:

1. **The difference is a bug in *this* port** (a mistranslation of the
   spec, a missed edge case). Fix the port to match Python. This is the
   default assumption — check it first.
2. **The difference exists because Python's behavior is itself wrong**
   against the formal spec (`docs/design/model.md` and the other design
   docs in the upstream repo), and you have concrete evidence for that —
   a worked example from the spec that Python gets wrong, a property the
   algebra is supposed to guarantee that Python violates, a genuine
   correctness bug independent of language. In this case:
   - **Do not silently replicate the wrong behavior** just to match
     upstream. Implement the port against the *spec*, not against
     Python's actual output, when the two disagree.
   - **File an issue on `omnist-dev/omnist`** (the Python repo, not this
     one) describing the discrepancy: the spec section it violates, a
     concrete input/output pair showing the wrong behavior, and a
     suggested direction for the fix. Don't just flag it — give the
     upstream maintainer(s) enough to act on without re-deriving the
     finding themselves.
   - Note the divergence and the upstream issue number in this repo's own
     issue/PR for the port work, so anyone reading this repo's history
     understands *why* it doesn't match Python's current released
     behavior.
   - Don't assume the upstream issue will be fixed quickly, or fixed the
     way you suggested — the port's behavior is the port maintainer's
     call either way, but it should be a *deliberate* call, made with the
     evidence in hand, not an accidental one from copying a bug forward
     into a second language.

The bar for "evidence" here is the same rigor this playbook already
expects elsewhere (rule 6, red-before-green): a concrete, reproducible
input/output pair or a specific spec citation, not "this looks off."
Confirm it against the formal spec doc, not just intuition, before filing.

## Toolchain mapping (Python → TypeScript)

| Python | TypeScript equivalent |
|---|---|
| `pytest` | `vitest` (already in this repo) |
| `ruff check` | `eslint` (already configured) |
| `mypy --strict` | `tsc --noEmit` / strict mode in `tsconfig.json` |
| `coverage run -m pytest && coverage report` | `vitest run --coverage` (v8/Istanbul provider) |
| `mkdocs build --strict` | whatever static-doc-site generator this repo adopts, if any — otherwise this step is N/A |
| PyPI publish on tag push | npm publish on tag push (GitHub Actions, `npm publish` with provenance) |
| `hypothesis` property-based fuzzing | `fast-check` |

## What NOT to carry over unexamined

This playbook is a starting point, not gospel — some of it was learned the
hard way on the Python side and may not transfer cleanly:

- Coverage tooling differs enough (Istanbul/v8 vs. `coverage.py`) that the
  exact pragma syntax and gap-classification workflow will need
  re-deriving, not copy-pasted.
- TypeScript's structural typing changes how much a port can lean on the
  type system to prevent the kind of correctness bugs the Python
  version's `mypy --strict` gate caught — decide early whether that gap
  needs to be closed with more runtime validation/tests, not assumed away.
- The audit-trail loop assumes a GitHub issue tracker; if this repo ends
  up somewhere else, adapt the artifacts, not just the tool names.
