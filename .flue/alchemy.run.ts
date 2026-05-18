/**
 * alchemy.run.ts — declarative deploy for the EmDash triage bot.
 *
 * Flue builds `.flue/.build/dist/_entry.ts` (its auto-generated entry).
 * We override that with our own `entry.ts` which wraps Flue's entry to
 * add HMAC verification on /webhook/github before forwarding to the agent.
 *
 * Secrets (set with `wrangler secret put` or via alchemy env):
 *   GITHUB_WEBHOOK_SECRET — required, HMAC secret matching the GH App
 *     webhook config. `openssl rand -hex 32` is a good default.
 *   GITHUB_TOKEN — installation token for the GitHub App. Used to label
 *     and comment. Leave unset to dry-run (no labels, no comments, just
 *     logs).
 *   CLOUDFLARE_GATEWAY_ID — AI Gateway slug. All Workers AI calls route
 *     through the gateway for cost tracking + cache + request logs.
 *
 * Bindings:
 *   AI — Workers AI binding for the kimi-k2.6 model.
 *   TriageLabel — Durable Object per agent instance, one per webhook
 *     delivery.
 */

import alchemy from "alchemy";
import { Ai, DurableObjectNamespace, Worker } from "alchemy/cloudflare";

const STAGE = process.env.STAGE ?? "local";

const app = await alchemy("emdash-flue-triage", { stage: STAGE });

const worker = await Worker(`emdash-triage-${STAGE}`, {
	entrypoint: ".build/dist/_entry.ts",
	compatibilityDate: "2026-04-01",
	compatibility: "node",
	bindings: {
		AI: Ai(),
		TriageLabel: DurableObjectNamespace("TriageLabel", {
			className: "TriageLabel",
			sqlite: true,
		}),
		GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET ?? "dev-secret-rotate-me",
		GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? "",
		CLOUDFLARE_GATEWAY_ID: process.env.CLOUDFLARE_GATEWAY_ID ?? "",
		DRY_RUN: process.env.DRY_RUN ?? "false",
	},
});

console.log(worker.url);

await app.finalize();
