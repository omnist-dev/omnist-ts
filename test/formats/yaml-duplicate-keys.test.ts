import { describe, expect, it } from "vitest";
import { DocumentError, ParseError } from "../../src/errors.js";
import { readYaml } from "../../src/formats/yaml.js";

// Issue #157: the yaml library's duplicate-key check is quadratic in the keys
// of one block mapping (10,000 keys ~ 10 s, 50,000 ~ 3 min), and the input-size
// cap does not bound it. readYaml runs the library with the check off and does
// the same test in one linear pass; these pin both the speed and that the
// duplicate-key behaviour is unchanged.

const mapping = (n: number): string => Array.from({ length: n }, (_, i) => `key${i}: value${i}\n`).join("");

function parseError(text: string): ParseError {
  try {
    readYaml(text);
  } catch (e) {
    expect(e).toBeInstanceOf(ParseError);
    return e as ParseError;
  }
  throw new Error("expected a ParseError");
}

describe("readYaml: a large block mapping is linear (issue #157)", () => {
  // 30,000 keys took ~25 s before the fix and ~1 s after; the bound is far
  // from both, so it is not flaky on a slow runner.
  it("reads a 30,000-key block mapping well inside a generous bound", () => {
    const started = performance.now();
    const node = readYaml(mapping(30000));
    const elapsed = performance.now() - started;
    expect(Array.isArray(node) && node.length).toBe(30000);
    expect(elapsed).toBeLessThan(10000);
  }, 60000);

  it("reads a 30,000-key flow mapping and a 30,000-item sequence just as fast", () => {
    const flow = "{" + Array.from({ length: 30000 }, (_, i) => `k${i}: ${i}`).join(", ") + "}\n";
    const seq = "s:\n" + Array.from({ length: 30000 }, (_, i) => `  - ${i}\n`).join("");
    const started = performance.now();
    readYaml(flow);
    readYaml(seq);
    expect(performance.now() - started).toBeLessThan(25000);
  }, 60000);
});

describe("readYaml: duplicate mapping keys are still refused", () => {
  it("names the second key's position and keeps the library's message", () => {
    const e = parseError("a: 1\na: 2\n");
    expect(e.code).toBe("parse.codec-syntax");
    expect(e.path).toBe("2:1");
    expect(e.message).toBe("invalid YAML: line 2, col 1: Map keys must be unique at line 2, column 1:");
  });

  it("reports the library's own position, which is the end of the previous token", () => {
    const e = parseError("b:\n  d: \n  d: 2\na: 1\na: 3\n");
    expect(e.path).toBe("2:6");
  });

  it("refuses a duplicate in a flow mapping, a nested mapping and a !!set", () => {
    expect(parseError("{a: 1, a: 2}\n").path).toBe("1:8");
    expect(parseError("x:\n  p: 1\n  p: 2\n").path).toBe("3:3");
    expect(parseError("!!set {a, b, a}\n").path).toBe("1:14");
  });

  it("compares resolved scalar values: 1 and \"1\" differ, 1 and 0x1 do not", () => {
    // not a duplicate (an integer key and a string key), refused later as a non-string label
    expect(() => readYaml('1: a\n"1": b\n')).toThrow(DocumentError);
    expect(parseError("1: a\n0x1: b\n").message).toContain("Map keys must be unique");
    expect(parseError("true: a\nyes: b\n").message).toContain("Map keys must be unique");
  });

  it("never treats two NaN keys, or two non-scalar keys, as duplicates (the library's `===`)", () => {
    // Neither is a duplicate-key error; both are refused later, as before,
    // because a Document label must be a string.
    expect(() => readYaml(".nan: 1\n.nan: 2\n")).toThrow(DocumentError);
    expect(() => readYaml("? [a]\n: 1\n? [a]\n: 2\n")).toThrow(DocumentError);
  });

  it("an earlier unrelated syntax error still wins over a later duplicate", () => {
    const e = parseError("a: [1\n" + "k: 1\nk: 2\n");
    expect(e.message).not.toContain("Map keys must be unique");
  });
});

describe("readYaml: a duplicate key in a huge mapping is found without the quadratic check", () => {
  const big = mapping(5000); // above the exact-error threshold (4,096 keys)

  it("reports the duplicate at its own position, quickly", () => {
    const started = performance.now();
    const e = parseError(big + "key7: again\n");
    expect(performance.now() - started).toBeLessThan(10000);
    expect(e.code).toBe("parse.codec-syntax");
    expect(e.path).toBe("5001:1");
    expect(e.message).toBe("invalid YAML: line 5001, col 1: Map keys must be unique at line 5001, column 1:");
  }, 60000);

  it("reports the earliest duplicate in the text: a nested one before a later one of its parent", () => {
    // The parent's duplicate (line 5004) is met first by the walk; the nested
    // one (line 5003) is earlier in the text and must win.
    const e = parseError(big + "n:\n  p: 1\n  p: 2\nkey3: again\n");
    expect(e.path).toBe("5003:3");
    // Two separate mappings: the later one never replaces the earlier.
    const f = parseError(big + "key1: x\n".repeat(1) + "z:\n  q: 1\n  q: 2\n");
    expect(f.path).toBe("5001:1");
  }, 60000);

  it("an earlier library error is reported instead of a later duplicate", () => {
    const e = parseError("a: 1\n  b: 2\n" + big + "key7: again\n");
    expect(e.message).not.toContain("Map keys must be unique");
  }, 60000);

  it("many large mappings with one duplicate do not trigger a quadratic re-parse", () => {
    // 40 mappings of 4,095 keys (each under the old per-mapping threshold),
    // the duplicate in the last: the old gate re-parsed the whole document with
    // the library's quadratic check (~24 s more); the total budget refuses to. The parse itself is ~5 s.
    const group = (g: number, dup: boolean): string =>
      `m${g}:\n` + Array.from({ length: 4095 }, (_, i) => `  k${i}: v\n`).join("") + (dup ? "  k7: again\n" : "");
    const text = Array.from({ length: 40 }, (_, g) => group(g, g === 39)).join("");
    // Timed against the same document without the duplicate, so a loaded
    // runner scales both: the re-parse costs ~5x the parse (24 s vs 4.7 s).
    const baseStart = performance.now();
    readYaml(Array.from({ length: 40 }, (_, g) => group(g, false)).join(""));
    const base = performance.now() - baseStart;
    const started = performance.now();
    const e = parseError(text);
    expect(performance.now() - started).toBeLessThan(2.5 * base + 2000);
    expect(e.message).toContain("Map keys must be unique");
    expect(e.path).toBe(String(40 * 4096 + 1) + ":3");
  }, 60000);

  it("a duplicate in the first, middle or last of several large mappings is found", () => {
    const group = (g: number, dup: boolean): string =>
      `m${g}:\n` + Array.from({ length: 3000 }, (_, i) => `  k${i}: v\n`).join("") + (dup ? "  k7: again\n" : "");
    for (const at of [0, 2, 4]) {
      const text = Array.from({ length: 5 }, (_, g) => group(g, g === at)).join("");
      expect(parseError(text).message).toContain("Map keys must be unique");
    }
  }, 60000);

  it("a later library error does not hide the duplicate before it", () => {
    const e = parseError(big + "key7: again\nx: [1\n");
    expect(e.message).toContain("Map keys must be unique");
    expect(e.path).toBe("5001:1");
  }, 60000);
});
