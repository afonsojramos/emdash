---
name: reproduce
description: Attempt to reproduce a reported bug against the EmDash monorepo. Run on a GitHub Actions runner with the repo cloned and dependencies installed. Use the bash tool to set up a minimal test case, run it, and report whether the reported behaviour was observed.
---

# reproduce

You are attempting to reproduce a bug reported against `emdash-cms/emdash`. You're running on a GitHub Actions Ubuntu runner. The repo is cloned in the current working directory and dependencies are already installed (`pnpm install --frozen-lockfile` was already run). All Node and pnpm commands work out of the box.

## Args

- `issueNumber: number` — the issue being investigated
- `issueTitle: string` — the issue title
- `issueBody: string` — the issue body in markdown
- `triage: object` — the structured triage from a previous classify pass (severity, kind, areaLabels, reproducible, dataLossRisk, summary). Use this to focus your work.

## Allowed tools

The bash tool is available. Allowed binaries on this runner: `pnpm`, `node`, `git`, `gh`, `bash`, standard Unix utilities. Do NOT use `curl` or `wget` against external URLs other than github.com.

## Process

### 1. Decide whether reproduction is possible

Some issues genuinely cannot be reproduced in a CI runner. Skip and explain if:

- The bug requires a specific user's WordPress export (WXR import bugs are often like this — we don't have their data)
- The bug requires a deployed Cloudflare Worker environment (not local)
- The bug requires specific browser behaviour that's not testable headlessly
- The bug requires a paid third-party service or auth credential
- The bug requires a specific version of EmDash that's older than `main`

If you skip, set `reproduced: false` and `skipped: true`, and explain in `notes` _exactly_ what would be needed to attempt reproduction.

### 2. Find the relevant code

Use grep and reading to find the code paths the bug touches. Use the `triage.areaLabels` as a starting point — if the issue is `area/core`, the code is in `packages/core/`. If `area/cloudflare`, look in `packages/cloudflare/`.

Read enough to understand what the issue is claiming. Don't just guess.

### 3. Construct a minimal reproduction

Prefer in the order:

1. **A failing test** in the relevant package's `tests/` directory. This is the most valuable output — it stays useful even if reproduction fails. Write it as a vitest test, mirror the existing test style for that package.
2. **A small script** under `/tmp/repro-{issueNumber}/` that exercises the code path. Use this when a test is awkward (e.g. the bug only manifests at the CLI layer).
3. **A direct `pnpm` command** that demonstrates the bug.

For any approach, capture the exact command(s) that demonstrate the bug. Include them in `notes`.

### 4. Run it

Execute the reproduction. Be precise:

- For tests: `pnpm --filter <package> test <test-file>` and capture the failure output.
- For scripts: `node /tmp/repro-{issueNumber}/script.mjs` (or `tsx ...` if TS) and capture stdout/stderr.

Don't fabricate output. If the test passes when the issue says it should fail, that's a real signal — set `reproduced: false` and explain.

### 5. Decide

- `reproduced: true` — you actually observed the reported failure. The notes field must contain the command(s) used and the relevant error output.
- `reproduced: false` — you tried, the failure did not occur. The notes field must explain what you tried and what you observed instead.
- `skipped: true` — you didn't attempt reproduction (see step 1). Notes explains why.

## Output

Return only the structured object matching the schema. Notes should be plain text, not markdown — it gets injected into a GitHub comment as a fenced code block by the comment skill.
