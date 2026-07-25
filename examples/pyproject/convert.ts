#!/usr/bin/env node
/**
 * Validate real pyproject.toml files against pyproject.osd, and show the
 * resulting OML. Ported from the Python project's
 * examples/pyproject/convert.py.
 *
 * For each fixture: read the TOML, validate it against the schema, and
 * either print the equivalent OML or the exact validation error -- never
 * an uncaught exception. This is also a stress test of readToml and
 * writeOml against real-world TOML, independent of whether the schema
 * itself is a good fit.
 *
 * Run: npx tsx examples/pyproject/convert.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Doc, parseSchema, readToml, writeOml, validationResultToString } from "../../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "fixtures");

function main(): void {
  const schema = parseSchema(readFileSync(join(here, "pyproject.osd"), "utf-8"));
  const fixtures = readdirSync(fixturesDir)
    .filter((f) => f.endsWith(".toml"))
    .sort();

  for (const name of fixtures) {
    console.log(`== ${name} ==`);
    const node = readToml(readFileSync(join(fixturesDir, name), "utf-8"), { schema });
    const result = schema.validate(new Doc(node));
    if (result.ok) {
      console.log("valid: True");
      console.log(writeOml(node));
    } else {
      console.log("valid: False");
      console.log(validationResultToString(result));
    }
    console.log();
  }
}

main();
