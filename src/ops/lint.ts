/**
 * Non-destructive structural diagnostics for a schema. Ported from
 * `omnist/ops/lint.py`.
 *
 * `validate` checks a *document* against a schema; `lint` checks the
 * *schema itself* for structural problems that parse fine but mean parts
 * of the schema can never do anything. It **reports, never mutates** --
 * that line is the whole design. `prune` and `normalize` are the
 * transforms that *fix* these issues; `lint` only diagnoses them.
 *
 * Four checks:
 *
 * - `unsatisfiable-record` (`warning`) -- a reachable record no finite
 *   document can match (e.g. a mandatory ref cycle). Reuses
 *   `prune.satisfiableSet`'s complement, intersected with reachable.
 * - `unreachable-record` (`warning`) -- a record defined in `env` but not
 *   reachable from `root` by following any ref. A plain reachability walk
 *   (no pruning): every ref-typed field is followed regardless of
 *   cardinality.
 * - `duplicate-record` (`warning`) -- two or more structurally identical
 *   records under different names. Reuses `minimize.equivalenceClasses`
 *   on the *raw* schema, so duplicates are reported as authored.
 * - `any-field` (`info`) -- an inventory of every `any`-typed field, so a
 *   human can audit the schema's deliberate openings. Advisory only;
 *   never fails the exit code on its own.
 */

import type { Schema, Record as OmnistRecord } from "../schema.js";
import { equivalenceClasses } from "./minimize.js";
import { satisfiableSet } from "./prune.js";

/** One structural diagnostic. `code` is a stable machine-readable
 * identifier (`unsatisfiable-record`, `unreachable-record`,
 * `duplicate-record`, `any-field`); `severity` is `warning` or `info`;
 * `location` is a record name (or `record.label` for `any-field`);
 * `message` is a human-readable, actionable description. */
export interface LintFinding {
  readonly code: string;
  readonly severity: "warning" | "info";
  readonly location: string;
  readonly message: string;
}

function reachable(s: Schema): Set<string> {
  const seen = new Set<string>();
  const stack = [s.root.name];
  while (stack.length > 0) {
    const name = stack.pop() as string;
    if (seen.has(name) || !s.env.has(name)) continue;
    seen.add(name);
    const rec = s.env.get(name) as OmnistRecord;
    for (const f of rec.fields) {
      if (f.type.tag === "ref") stack.push(f.type.name);
    }
  }
  return seen;
}

function setDifference<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): T[] {
  return [...a].filter((x) => !b.has(x));
}

/** Structural diagnostics for `s` -- see the module doc for the four
 * checks. Returns findings sorted deterministically by `(code,
 * location)`. Never mutates `s`. */
export function lint(s: Schema): LintFinding[] {
  const findings: LintFinding[] = [];

  const reach = reachable(s);
  const sat = satisfiableSet(s);

  // unsatisfiable-record: reachable but not satisfiable
  for (const name of setDifference(reach, sat).sort()) {
    findings.push({
      code: "unsatisfiable-record",
      severity: "warning",
      location: name,
      message: `record ${JSON.stringify(name)} is reachable but unsatisfiable -- no finite document can match it (e.g. a mandatory ref cycle)`,
    });
  }

  // unreachable-record: defined in env but not reachable from root
  for (const name of setDifference(new Set(s.env.keys()), reach).sort()) {
    findings.push({
      code: "unreachable-record",
      severity: "warning",
      location: name,
      message: `record ${JSON.stringify(name)} is defined but never reachable from the root; drop it with \`schema prune\``,
    });
  }

  // duplicate-record: structurally identical records under different names
  for (const block of equivalenceClasses(s)) {
    if (block.length > 1) {
      const group = [...block].sort();
      const location = group.join(", ");
      const keep = group[0] as string;
      const others = group.slice(1).map((n) => JSON.stringify(n)).join(", ");
      findings.push({
        code: "duplicate-record",
        severity: "warning",
        location,
        message: `records ${others} are structurally identical to ${JSON.stringify(keep)}; merge them with \`schema normalize\``,
      });
    }
  }

  // any-field: inventory of every any-typed field
  for (const name of [...s.env.keys()].sort()) {
    const rec = s.env.get(name) as OmnistRecord;
    for (const f of rec.fields) {
      if (f.type.tag === "any") {
        findings.push({
          code: "any-field",
          severity: "info",
          location: `${name}.${f.label}`,
          message: `field ${JSON.stringify(f.label)} of record ${JSON.stringify(name)} is typed \`any\` (accepts any value unchecked)`,
        });
      }
    }
  }

  // Plain relational operators on strings compare by UTF-16 code unit
  // (codepoint order for BMP characters), matching Python's default
  // tuple-key sort exactly. localeCompare (without an explicit locale)
  // does Unicode-collation-aware comparison instead, which can invert
  // the order of differently-cased names (e.g. "aaa" vs. "B") relative
  // to Python -- see issue #56.
  const compare = (a: string, b: string): number => Number(a > b) - Number(a < b);
  findings.sort((a, b) => (a.code === b.code ? compare(a.location, b.location) : compare(a.code, b.code)));
  return findings;
}
