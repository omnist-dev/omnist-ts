#!/usr/bin/env node
/**
 * Manual performance benchmark (issue #42).
 *
 * Measures real wall-clock throughput for the operations Python's
 * `docs/why-omnist.md` publishes numbers for -- `Schema.validate()`,
 * building a Document from a plain JS value, and each codec's read/write --
 * plus the three other schema-algebra ops (`normalize`, `compatibleWith`,
 * `extract`) audited in issue #35. This is a *manual* tool, not a
 * correctness check: it has no bounded/seeded companion in the test suite
 * (unlike `tools/semantic_oracle.ts`) because there is no "correct"
 * performance number to assert against -- see `test/semantic-oracle.test.ts`'s
 * file-top comment for that pattern and why it doesn't apply here.
 *
 * Usage:
 *
 *     npx tsx tools/bench.ts
 *     npm run bench
 *
 * Prints a report to stdout; exits 0 always (this tool never asserts
 * pass/fail, only measures and reports).
 */

import { buildNode, doc, type Node } from "../src/document.js";
import {
  ANY,
  field,
  record,
  ref,
  schema,
  t,
  type Schema,
} from "../src/schema.js";
import { normalize } from "../src/ops/minimize.js";
import { compatibleWith } from "../src/ops/subschema.js";
import { extract } from "../src/ops/extract.js";
import { readJson, writeJson } from "../src/formats/json.js";
import { readYaml, writeYaml } from "../src/formats/yaml.js";
import { readToml, writeToml } from "../src/formats/toml.js";
import { readXml, writeXml } from "../src/formats/xml.js";
import { readOml, writeOml } from "../src/oml.js";

// ---------------------------------------------------------------------------
// Timing helpers
// ---------------------------------------------------------------------------

/** Median of `n` timed samples of `fn()`, after `warmup` untimed runs.
 * Median (not mean) so a single slow sample -- e.g. a concurrent agent
 * process stealing a core on this shared machine -- doesn't skew the
 * reported number the way an outlier would skew a mean. */
function timeMs(fn: () => void, { warmup = 3, samples = 7 } = {}): number {
  for (let i = 0; i < warmup; i++) fn();
  const times: number[] = [];
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  if (median === undefined) {
    throw new Error("timeMs: samples must be > 0");
  }
  return median;
}

function fmtMs(ms: number): string {
  return ms < 1 ? `${(ms * 1000).toFixed(0)}µs` : `${ms.toFixed(1)}ms`;
}

// ---------------------------------------------------------------------------
// Synthetic Document generation
// ---------------------------------------------------------------------------

/** An array of `n` three-field records (`id`, `name`, `active`), matching
 * the shape Python's `docs/why-omnist.md` uses ("33k records of three
 * fields each" for its 100k-edge document): `n` records, each contributing
 * an `items` edge plus 3 field edges, wrapped under one `root` edge -- see
 * `edgeCount()` below for the exact count actually measured (the target
 * passed in is only used to size `n`; the real total is reported). */
function makeDocValue(recordCount: number): unknown {
  const items = [];
  for (let i = 0; i < recordCount; i++) {
    items.push({
      id: i,
      name: `record-${i}`,
      active: i % 2 === 0,
    });
  }
  // Wrapped under a single root key so the Document has one top-level
  // edge -- writeXml() requires a single-rooted Document, and a bare
  // { items: [...] } would instead expand into recordCount top-level
  // items edges (arrays expand per-item; see buildNode doc comment in
  // src/document.ts).
  return { root: { items } };
}

function edgeCount(node: Node): number {
  if (!Array.isArray(node)) return 0;
  let count = 0;
  for (const edge of node) {
    count += 1 + edgeCount(edge.target);
  }
  return count;
}

// ---------------------------------------------------------------------------
// Synthetic Schema generation
// ---------------------------------------------------------------------------

/** A 30-record schema: `Item0..Item29`, each with the same 3 scalar
 * fields as the synthetic documents above, plus a `Root` record with one
 * `[0, null]` field per record type -- moderately complex, in line with
 * the issue #35 audit's own schema (20-50 records, "similar shape"). */
function makeSchema(recordCount = 30): Schema {
  const env: globalThis.Record<string, ReturnType<typeof record>> = {};
  const rootFields = [];
  for (let i = 0; i < recordCount; i++) {
    const name = `Item${i}`;
    env[name] = record(
      field("id", t.integer),
      field("name", t.string),
      field("active", t.boolean),
      field("note", ANY, 0, 1),
    );
    rootFields.push(field(`item${i}`, ref(name), 0, null));
  }
  env["Root"] = record(...rootFields);
  return schema(ref("Root"), env);
}

/** A document matching `makeSchema()`, for `validate()` timing. */
function makeSchemaDocValue(recordCount: number, itemsPerRecord: number): unknown {
  const value: globalThis.Record<string, unknown[]> = {};
  for (let i = 0; i < recordCount; i++) {
    value[`item${i}`] = Array.from({ length: itemsPerRecord }, (_, j) => ({
      id: j,
      name: `item${i}-${j}`,
      active: j % 2 === 0,
    }));
  }
  return value;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

interface Row {
  readonly label: string;
  readonly ms: number;
  readonly note?: string;
}

function printSection(title: string, rows: Row[]): void {
  console.log(`\n## ${title}\n`);
  const labelWidth = Math.max(...rows.map((r) => r.label.length), "operation".length);
  const header = `${"operation".padEnd(labelWidth)}  ${"median".padStart(10)}  note`;
  console.log(header);
  console.log("-".repeat(header.length));
  for (const r of rows) {
    console.log(`${r.label.padEnd(labelWidth)}  ${fmtMs(r.ms).padStart(10)}  ${r.note ?? ""}`);
  }
}

function main(): void {
  console.log("# omnist-ts benchmark (tools/bench.ts, issue #42)\n");
  console.log(`node ${process.version}, ${new Date().toISOString()}`);

  const scales = [1_000, 10_000, 100_000];

  // -- Document-level ops: buildNode/doc(), validate(), and codec I/O ------
  const docRows: Row[] = [];
  const documentsByScale = new Map<number, { node: Node; json: string; edges: number }>();

  for (const targetEdges of scales) {
    // n such that 4n + 1 ~= targetEdges
    const recordCount = Math.round((targetEdges - 1) / 4);
    const value = makeDocValue(recordCount);

    const buildMs = timeMs(() => buildNode(value));
    const node = buildNode(value);
    const edges = edgeCount(node);
    docRows.push({ label: `buildNode (${targetEdges.toLocaleString()} edges target)`, ms: buildMs, note: `${edges.toLocaleString()} edges actual, ${recordCount.toLocaleString()} records` });

    const json = writeJson(node);
    documentsByScale.set(targetEdges, { node, json, edges });
  }
  printSection("Document construction", docRows);

  // -- validate() against the 30-record schema, at increasing item counts -
  const s = makeSchema(30);
  const validateRows: Row[] = [];
  for (const itemsPerRecord of [10, 100, 1_000]) {
    const value = makeSchemaDocValue(30, itemsPerRecord);
    const d = doc(value);
    const totalItems = 30 * itemsPerRecord;
    const ms = timeMs(() => s.validate(d));
    validateRows.push({
      label: `validate (${totalItems.toLocaleString()} total items across 30 records)`,
      ms,
    });
  }
  printSection("Schema.validate()", validateRows);

  // -- Schema-only ops on the 30-record schema -----------------------------
  const s2 = makeSchema(30);
  const schemaOpRows: Row[] = [
    { label: "normalize (30-record schema)", ms: timeMs(() => normalize(s)) },
    { label: "compatibleWith (30-record schema, self)", ms: timeMs(() => compatibleWith(s, s2)) },
    {
      label: "extract (half the labels, 30-record schema)",
      ms: timeMs(() =>
        extract(s, Array.from({ length: 15 }, (_, i) => `item${i}`)),
      ),
    },
  ];
  printSection("Schema-only operations", schemaOpRows);

  // -- Codec read/write on the largest document ----------------------------
  const largestScale = scales[scales.length - 1];
  if (largestScale === undefined) {
    throw new Error("scales must be non-empty");
  }
  const largest = documentsByScale.get(largestScale);
  if (largest === undefined) {
    throw new Error("largest-scale document was not built");
  }
  console.log(
    `\nCodec benchmarks use the largest document: ${largest.edges.toLocaleString()} edges (~${(largest.json.length / 1024 / 1024).toFixed(2)}MB as JSON).`,
  );

  const codecRows: Row[] = [];
  const codecs: {
    name: string;
    write: (n: Node) => string;
    read: (text: string) => Node;
  }[] = [
    { name: "json", write: writeJson, read: readJson },
    { name: "yaml", write: writeYaml, read: readYaml },
    { name: "toml", write: writeToml, read: readToml },
    { name: "xml", write: writeXml, read: readXml },
    { name: "oml", write: writeOml, read: readOml },
  ];

  for (const codec of codecs) {
    let text = "";
    const writeMs = timeMs(() => {
      text = codec.write(largest.node);
    }, { warmup: 2, samples: 5 });
    text = codec.write(largest.node);
    codecRows.push({
      label: `${codec.name} write`,
      ms: writeMs,
      note: `${(text.length / 1024 / 1024).toFixed(2)}MB output`,
    });

    const readMs = timeMs(() => codec.read(text), { warmup: 2, samples: 5 });
    codecRows.push({ label: `${codec.name} read`, ms: readMs });
  }
  printSection(`Codec I/O (${largest.edges.toLocaleString()}-edge document)`, codecRows);

  console.log("\nDone. See docs/performance.md for a written-up snapshot of a past run.");
}

main();
