# Security

## Known accepted risk: npm audit findings in docs dev-tooling

As of 2026-08-22, `npm audit` reports 3 vulnerabilities (2 moderate, 1
high) rooted in `esbuild <=0.24.2`, propagating through `vite <=6.4.2`
into `vitepress <=1.6.4`:

- GHSA-67mh-4wv8-2f99 (esbuild) — a running esbuild dev server accepts
  cross-origin requests and returns their responses, letting a malicious
  website read source served by the dev server.
- GHSA-4w7w-66w2-5vf9, GHSA-v6wh-96g9-6wx3, GHSA-fx2h-pf6j-xcff (vite,
  via esbuild) — the same class of issue, surfaced through Vite's dev
  server.

**Decision: accepted risk, not fixed, tracked here.** Rationale:

- All three packages are `vitepress`'s transitive dev dependencies, used
  only by `npm run docs:dev` / `docs:build` / `docs:preview`. They are
  not part of the published `@omnist-dev/omnist` package (see
  `package.json`'s `files` field) and never ship to consumers.
- The vulnerability requires the dev server to be *running* and the
  operator to *simultaneously browse an untrusted site* that targets
  `localhost`. It doesn't affect CI, the build output, or anyone who
  isn't actively running `docs:dev` while browsing something malicious.
- No patch-level fix exists: `npm audit fix` and `npm audit fix --force`
  both report "No fix available." The only version of `vitepress` (and
  its `vite`/`esbuild` transitive deps) that resolves this is the 2.x
  line, which as of this writing is **still in alpha** (latest:
  `2.0.0-alpha.19`, no stable 2.0.0 release exists yet). Pinning a
  dev-tooling dependency of a released, tested package to a pre-1.0
  alpha — with no semver stability guarantee and active month-to-month
  breaking changes — is a worse trade than the vulnerability itself.

**Revisit when:** `vitepress` publishes a stable 2.0.0 (or backports the
esbuild/vite fix to the 1.x line). Track via `npm info vitepress version`
or watch https://github.com/vuejs/vitepress/releases. See
[#109](https://github.com/omnist-dev/omnist-ts/issues/109) for the full
audit trail.
