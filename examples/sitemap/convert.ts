#!/usr/bin/env node
/**
 * Validate real sitemap.xml files against sitemap.osd, and show the
 * resulting OML. Ported from the Python project's
 * examples/sitemap/convert.py. See examples/pyproject/convert.ts for the
 * fuller explanation of the pattern.
 *
 * Run: npx tsx examples/sitemap/convert.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Doc, parseSchema, readXml, writeOml, validationResultToString } from "../../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "fixtures");

function main(): void {
  const schema = parseSchema(readFileSync(join(here, "sitemap.osd"), "utf-8"));
  const fixtures = readdirSync(fixturesDir)
    .filter((f) => f.endsWith(".xml"))
    .sort();

  for (const name of fixtures) {
    console.log(`== ${name} ==`);
    const node = readXml(readFileSync(join(fixturesDir, name), "utf-8"), { schema });
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
