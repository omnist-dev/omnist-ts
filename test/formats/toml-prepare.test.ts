import { describe, expect, it } from "vitest";
import { parse } from "smol-toml";
import { INJECT_MIN, prepareToml, readToml } from "../../src/formats/toml.js";
import { writeJson } from "../../src/formats/json.js";
import { ParseError } from "../../src/errors.js";

// omnist-ts#170 (f) and omnist-ts#169 (b): readToml hands smol-toml a prepared
// copy of the text. The preparation must never change what a document means.

function pathOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as ParseError).path;
  }
  return undefined;
}

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as ParseError).code;
  }
  return undefined;
}

// A tiny deterministic generator (mulberry32).
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VALUES: string[] = [
  "1",
  "-2",
  "1.5",
  "true",
  '"plain"',
  '"has # hash and . dot"',
  '"esc \\" quote # not a comment"',
  '"back\\\\" # real comment',
  "'lit # no comment'",
  "'lit \\'",
  '"""multi\nline # still string\nend"""',
  '"""quotes "" inside"""',
  '"""ends in quote\\""""',
  '"""trailing two quotes"""""',
  '"""line \\\n   continued"""',
  "'''lit\nmulti # x\n'''",
  "''''''",
  '""""""',
  "[1, 2,\n  3, # c\n  4]",
  '[ "a#b", \'c#d\' ]',
  "{ x = 1, y = \"# z\" }",
  "2024-01-01T12:00:00Z",
  "2024-01-01",
  "12:30:00",
  "2024-01-01T12:00:00.123456+01:00",
  "12:00:00.5555",
  "2024-01-01 12:00:00.1234",
];

function randomDoc(next: () => number, crlf: boolean): string {
  const lines: string[] = [];
  const n = 3 + Math.floor(next() * 12);
  let tbl = 0;
  for (let i = 0; i < n; i++) {
    const r = next();
    if (r < 0.15) lines.push(`[t${tbl++}]`);
    else if (r < 0.25) lines.push("[[arr]]");
    else if (r < 0.32) lines.push("# a comment, with a dot.");
    else if (r < 0.36) lines.push("");
    else {
      const v = VALUES[Math.floor(next() * VALUES.length)] as string;
      const tail = next() < 0.2 ? " # trailing" : "";
      lines.push(`k${i} = ${v}${tail}`);
    }
  }
  return lines.join(crlf ? "\r\n" : "\n") + (next() < 0.5 ? (crlf ? "\r\n" : "\n") : "");
}

const show = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? `${x}n` : x));

describe("the prepared TOML text means what the input means", () => {
  it("random documents parse identically when every line gets its dot", () => {
    const next = rng(20261013);
    let injected = 0;
    for (let i = 0; i < 4000; i++) {
      const text = randomDoc(next, i % 3 === 0);
      let want: string;
      try {
        want = show(parse(text, { integersAsBigInt: true }));
      } catch {
        want = "error";
      }
      let got: string;
      try {
        const prep = prepareToml(text, true);
        if (prep !== undefined) injected++;
        got = show(parse(prep === undefined ? text : prep.text, { integersAsBigInt: true }));
      } catch {
        got = "error";
      }
      // The long-fraction values differ by design (the placeholder is a string); compare the rest.
      if (!text.includes(".5555") && !text.includes(".1234") && !text.includes(".123456")) {
        expect(got, text).toBe(want);
      }
    }
    expect(injected).toBeGreaterThan(3000);
  });

  it("a document over the threshold is read as the same value", () => {
    const body = 'k = "a # b . c"\n[[t]]\nx = 1\n# note\n'.repeat(Math.ceil(INJECT_MIN / 30) + 10);
    expect(body.length).toBeGreaterThan(INJECT_MIN);
    const text = body.replace(/\[\[t\]\]/g, "[[t]]").replace(/^k = .*$/gm, "");
    const got = writeJson(readToml(text));
    const want = writeJson(readToml(text.slice(0, 200) + "\n"));
    expect(got.startsWith('{"t": [{"x": 1}')).toBe(true);
    expect(want.startsWith('{"t": [{"x": 1}')).toBe(true);
  });

  it("leaves a short ordinary document alone", () => {
    expect(prepareToml("a = 1\nb = 'x'\n")).toBeUndefined();
  });
});

describe("TOML errors keep their position in the input", () => {
  it("is the same line and column with the dots in as with them out", () => {
    const text = 'a = 1\nb = "x"  # c\n[t]\nk = 2 3\nz = 1\n';
    const plain = (() => {
      try {
        readToml(text);
      } catch (e) {
        return (e as ParseError).path;
      }
      return undefined;
    })();
    expect(plain).toBe("4:5");
    const big = text + "# pad.\n".repeat(Math.ceil(INJECT_MIN / 7));
    expect(big.length).toBeGreaterThan(INJECT_MIN);
    expect(pathOf(() => readToml(big))).toBe(plain);
    // The same, with the dots in a text that also has a comment on the failing line.
    expect(pathOf(() => readToml(big.replace("k = 2 3", "k = 2 3 # here")))).toBe(plain);
  });

  it("maps an error after a long-fraction literal on the same line", () => {
    // One more digit in the literal moves the failing column by one, in the input.
    const short = pathOf(() => readToml("a = [12:00:00.123, 1 2]\n")) as string;
    const long = pathOf(() => readToml("a = [12:00:00.1234, 1 2]\n")) as string;
    expect(short).toMatch(/^1:\d+$/);
    expect(Number(long.slice(2))).toBe(Number(short.slice(2)) + 1);
  });

  it("clamps an error inside a replaced literal to the literal's start", () => {
    expect(code(() => readToml("a = 12:00:00.1234 = 1\n"))).toBe("parse.codec-syntax");
    try {
      readToml("12:00:00.1234 = 1\n");
    } catch (e) {
      expect((e as ParseError).path).toBe("1:1");
      return;
    }
    throw new Error("expected an error");
  });

  it("maps an error that smol-toml puts at a replaced literal back to the literal's start", () => {
    // The second literal has no comma before it: the error is at its start.
    expect(pathOf(() => readToml("a = [12:00:00.1234 12:00:00.5555]\n"))).toBe("1:20");
  });

  it("maps an error on the last line, with or without a line ending, CRLF included", () => {
    const body = "a = [12:00:00.1234 12:00:00.5555]";
    expect(pathOf(() => readToml(body))).toBe("1:20");
    expect(pathOf(() => readToml(body + "\r\n"))).toBe("1:20");
    expect(pathOf(() => readToml("x = 1\r\n" + body))).toBe("2:20");
    expect(pathOf(() => readToml("x = 1\n" + body + "\n"))).toBe("2:20");
  });

  it("maps an error on a later line past a CRLF and several literals", () => {
    try {
      readToml("a = 12:00:00.1234\r\nb = 12:00:00.5678, 2024-01-01T00:00:00.9999Z x\r\n");
    } catch (e) {
      expect((e as ParseError).path).toMatch(/^2:\d+$/);
      return;
    }
    throw new Error("expected an error");
  });
});

describe("DIV-12: a very large TOML array of tables is read in linear time", () => {
  const timeOf = (text: string): number => {
    const t0 = performance.now();
    readToml(text);
    return performance.now() - t0;
  };
  const best = (text: string): number => Math.min(timeOf(text), timeOf(text));

  it("200,000 tables take about four times as long as 50,000, not sixteen", () => {
    const small = best("[[t]]\na = 1\n".repeat(50_000));
    const big = best("[[t]]\na = 1\n".repeat(200_000));
    // Linear is 4; the library alone is quadratic here (60,000 tables took 3 s and
    // 200,000 took 25 s before the fix, a ratio of about 8 to 10 at these sizes
    // and rising). The ratio does not depend on the speed of the machine.
    expect(big / small).toBeLessThan(6);
    expect(big).toBeLessThan(30_000);
  }, 120_000);

  it("many plain keys and many distinct tables are linear too", () => {
    const keys = (n: number): string => "[t]\n" + Array.from({ length: n }, (_, i) => `k${i} = 1`).join("\n");
    const tables = (n: number): string => Array.from({ length: n }, (_, i) => `[a${i}]\nx = 1`).join("\n");
    for (const mk of [keys, tables]) {
      const small = timeOf(mk(20_000));
      const big = timeOf(mk(80_000));
      expect(big / small).toBeLessThan(8);
      expect(big).toBeLessThan(20_000);
    }
  }, 120_000);
});
