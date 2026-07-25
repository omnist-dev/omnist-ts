import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts", "tools/**/*.ts"],
      // tools/bench.ts is a manual/optional perf tool (issue #42), not
      // exercised by the test suite -- unlike tools/semantic_oracle.ts, which
      // has a bounded/seeded companion in test/semantic-oracle.test.ts, there
      // is no "correct" performance number to assert against, so it has no
      // such companion and is excluded from the coverage gate.
      exclude: ["tools/bench.ts"],
      thresholds: {
        lines: 100,
        statements: 100,
        branches: 100,
        functions: 100,
      },
    },
  },
});
