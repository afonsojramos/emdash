# Flue triage experiment

**Status:** prototype, not deployed. See the EmDash Discussion for design context (TBD link).

This directory contains an experimental Flue-based triage system with two phases:

## Phase 1: Worker-deployed auto-labeller

A Cloudflare Worker that receives `issues.opened` webhooks from GitHub, classifies the issue with Workers AI (kimi-k2.6) routed through our AI Gateway, and posts a labeling comment.

- `agents/triage-label.ts` — HTTP webhook handler. Verifies HMAC against raw bytes, parses, classifies, applies labels. Prompt is inlined (the default Cloudflare sandbox has no filesystem for skills).
- `agents/triage-issue.ts` — CLI-only entrypoint. Same classification, no webhook. Used by the local prototype runner and by Phase 2.
- `app.ts` — boot-time wiring of the Workers AI binding through our AI Gateway.
- `lib/github.ts` — Octokit wrapper.
- `lib/verify-signature.ts` — HMAC-SHA256 verification using Web Crypto.

## Phase 2: GH-Actions-driven reproduction attempt

When a maintainer adds the `triage:reproduce` label to an issue, the `.github/workflows/auto-repro.yml` workflow fires, checks the repo out, and runs the `repro-issue` agent with `sandbox: local()` — real bash, real `pnpm`, real `gh`. The agent tries to write a failing test or repro script and posts the result.

It does NOT push branches, commit anything, or attempt fixes.

- `agents/repro-issue.ts` — CLI-only agent.
- `<repo-root>/.agents/skills/reproduce/SKILL.md` — the reproduce prompt. Lives alongside our existing skills so Flue's `local()` sandbox finds it via the standard `.agents/skills/<name>/SKILL.md` lookup.

## Local prototyping

All model traffic routes through our Cloudflare AI Gateway, same path `/bonk` and `/review` take. Required env (mirroring the workflow secrets `CF_AI_GATEWAY_*`):

```bash
export CLOUDFLARE_ACCOUNT_ID=<account uuid>
export CLOUDFLARE_GATEWAY_ID=<gateway slug>
export CLOUDFLARE_API_TOKEN=<gateway-scoped token>

cd .flue
pnpm install --ignore-workspace

# Test against a saved fixture (under .flue/fixtures/)
pnpm prototype 1021

# Or against a live issue
pnpm prototype --live 1083

# Or post the result to GitHub (only if you really mean it)
GITHUB_TOKEN=... pnpm prototype --apply --live 1083

# Try a different model
FLUE_TRIAGE_MODEL=cloudflare-ai-gateway/claude-opus-4-7 pnpm prototype 1021
```

The runner spawns `flue run triage-issue` with the issue payload and prints the structured triage, the labels that would be applied, and the rendered comment body. Defaults to `cloudflare-ai-gateway/workers-ai/@cf/moonshotai/kimi-k2.6` (the same kimi model the deployed Worker uses).

## Why two phases

Phase 1 is cheap (~$0 per issue on Workers AI), fast (~5s end-to-end), and conservative (label + comment only). It runs on every new issue.

Phase 2 is expensive (Opus on a 30-min runner), slow, and powerful (real shell, can write tests). It runs only on explicit maintainer opt-in. The split prevents bot rate-limit churn and bounds the blast radius of agent mistakes.
