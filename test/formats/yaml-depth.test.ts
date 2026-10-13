import { describe, expect, it } from "vitest";
import { readYaml } from "../../src/formats/yaml.js";
import { readToml } from "../../src/formats/toml.js";

// Cross-port check 4 (omnist-ts#169): deep nesting is a limit diagnostic in every
// format, never a stack overflow. The YAML library recurses, and a stack overflow
// caught inside its regular expressions made the NEXT parse abort the process
// (V8 fatal "RegExpCompiler Allocation failed"), so these run one after another.

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
}

describe("a deeply nested YAML document is document.limit.depth, one after another", () => {
  const cases: Array<[string, string]> = [
    ["flow sequences", "[".repeat(1000) + "]".repeat(1000)],
    ["flow sequences, 20,000 deep", "[".repeat(20_000) + "]".repeat(20_000)],
    ["flow mappings", "a: " + "{a: ".repeat(1000) + "1" + "}".repeat(1000)],
    ["flow mappings again", "a: " + "{a: ".repeat(3000) + "1" + "}".repeat(3000)],
    ["block mappings", Array.from({ length: 1500 }, (_, i) => " ".repeat(i) + "a:").join("\n")],
    ["compact block sequences", "- ".repeat(5000) + "x"],
    ["a mapping 500 deep", "a: " + "{a: ".repeat(500) + "1" + "}".repeat(500)],
  ];
  it.each(cases)("%s", (_name, text) => {
    expect(codeOf(() => readYaml(text))).toBe("document.limit.depth");
  });

  it("a document under the limit is unaffected, even when brackets and dashes are plentiful", () => {
    expect(codeOf(() => readYaml("a: " + "{a: ".repeat(150) + "1" + "}".repeat(150)))).toBeUndefined();
    // Unbalanced brackets inside quoted text only look deep to the cheap scan.
    expect(codeOf(() => readYaml("k: '" + "[".repeat(1000) + "'\nj: \"" + "{".repeat(1000) + '"\n'))).toBeUndefined();
    expect(codeOf(() => readYaml(Array.from({ length: 300 }, (_, i) => "- - " + i).join("\n")))).toBeUndefined();
    const spaced = "a:\n" + " ".repeat(300) + "# a comment\n  b: 1\n";
    expect(codeOf(() => readYaml(spaced))).toBeUndefined();
  });
});

describe("a deeply nested TOML document is document.limit.depth", () => {
  it.each([10_000, 100_000])("%i dotted keys and table-header parts", (n) => {
    const parts = Array.from({ length: n }, (_, i) => "k" + String(i)).join(".");
    expect(codeOf(() => readToml(parts + " = 1"))).toBe("document.limit.depth");
    expect(codeOf(() => readToml("[" + parts + "]"))).toBe("document.limit.depth");
  });
});
