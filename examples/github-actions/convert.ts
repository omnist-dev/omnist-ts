#!/usr/bin/env node
/**
 * Validate real GitHub Actions workflow files against workflow.osd, and
 * show the resulting OML. Ported from the Python project's
 * examples/github-actions/convert.py.
 *
 * For each fixture: read the YAML, validate it against the schema, and
 * either print the equivalent OML or the exact validation error. Unlike
 * the pyproject.toml and package.json examples, this one also
 * demonstrates a **read failure**, not just a validation failure: three
 * of the four fixtures are real GitHub Actions workflows using the
 * ordinary, unquoted "on:" key, and the YAML 1.1 boolean-coercion rule
 * turns that bare key into the boolean true -- which omnist's Document
 * model rejects, since labels must be strings. This is caught and
 * reported explicitly, never left as an uncaught exception.
 *
 * Run: npx tsx examples/github-actions/convert.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Doc,
  DocumentError,
  ParseError,
  parseSchema,
  readYaml,
  writeOml,
  validationResultToString,
} from "../../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "fixtures");

function main(): void {
  const schema = parseSchema(readFileSync(join(here, "workflow.osd"), "utf-8"));
  const fixtures = readdirSync(fixturesDir)
    .filter((f) => f.endsWith(".yml"))
    .sort();

  for (const name of fixtures) {
    console.log(`== ${name} ==`);
    let node;
    try {
      node = readYaml(readFileSync(join(fixturesDir, name), "utf-8"), { schema });
    } catch (exc) {
      if (exc instanceof DocumentError || exc instanceof ParseError) {
        console.log("read: False");
        console.log(`  ${exc.constructor.name}: ${exc.message}`);
        console.log();
        continue;
      }
      throw exc;
    }
    const result = schema.validate(new Doc(node));
    console.log("read: True");
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
