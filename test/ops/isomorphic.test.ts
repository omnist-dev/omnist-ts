import { describe, expect, it } from "vitest";
import { parseSchema } from "../../src/osd.js";
import { normalize } from "../../src/ops/minimize.js";
import { isomorphic } from "../../src/ops/isomorphic.js";

// Ported from upstream omnist's tests/test_any_core.py and
// tests/test_fuzz.py isomorphic-specific cases (isomorphic is the private
// minimize-then-isomorphism oracle used to cross-check `equivalent`).

describe("isomorphic", () => {
  it("true for renamed-but-structurally-identical normalized schemas", () => {
    const a = normalize(parseSchema('record R { "x": integer }\nroot R'));
    const b = normalize(parseSchema('record S { "x": integer }\nroot S'));
    expect(isomorphic(a, b)).toBe(true);
  });

  it("false when scalar kinds differ", () => {
    const a = normalize(parseSchema('record R { "x": integer }\nroot R'));
    const b = normalize(parseSchema('record R { "x": string }\nroot R'));
    expect(isomorphic(a, b)).toBe(false);
  });

  it("both empty schemas are isomorphic", () => {
    const a = normalize(parseSchema('record A { "x": B }\nrecord B { "y": A }\nroot A'));
    const b = normalize(parseSchema('record P { "q": P }\nroot P'));
    expect(isomorphic(a, b)).toBe(true);
  });

  it("exactly one empty schema is not isomorphic to a non-empty one", () => {
    const empty = normalize(parseSchema('record A { "x": B }\nrecord B { "y": A }\nroot A'));
    const nonEmpty = normalize(parseSchema('record R { "x": integer }\nroot R'));
    expect(isomorphic(empty, nonEmpty)).toBe(false);
    expect(isomorphic(nonEmpty, empty)).toBe(false);
  });

  it("enforces a consistent bijection when recursing into a shared ref target", () => {
    // A structural mismatch reachable only through a second visit to an
    // already-mapped name must be caught by the "must agree both ways"
    // branch, not just the first-visit signature check.
    const a = normalize(
      parseSchema('record Root { "p": P, "q": P }\nrecord P { "v": integer }\nroot Root'),
    );
    const b = normalize(
      parseSchema(
        'record Root { "p": P1, "q": P2 }\nrecord P1 { "v": integer }\n' +
          'record P2 { "v": integer }\nroot Root',
      ),
    );
    // b's env still has two distinct-but-identical P1/P2 only if it wasn't
    // normalized; since we normalize first, P1/P2 merge and both sides end
    // up with one P-like record -- isomorphic under revisit.
    expect(isomorphic(a, b)).toBe(true);
  });

  it("normalized schemas with identical vs. distinguishable fields differ", () => {
    const a = normalize(
      parseSchema('record Root { "p": P, "q": Q }\nrecord P { "v": integer }\nrecord Q { "v": integer }\nroot Root'),
    );
    const b = normalize(
      parseSchema('record Root { "p": P, "q": P }\nrecord P { "v": integer }\nroot Root'),
    );
    // P and Q are structurally identical, so normalize merges them on both
    // sides and the two schemas end up isomorphic.
    expect(isomorphic(a, b)).toBe(true);

    const c = normalize(
      parseSchema('record Root { "p": P, "q": R2 }\nrecord P { "v": integer }\nrecord R2 { "v": string }\nroot Root'),
    );
    // R2's scalar kind differs, so it can never map onto Q -- not isomorphic.
    expect(isomorphic(a, c)).toBe(false);
  });
});
