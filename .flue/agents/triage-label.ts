// Phase 1: Worker-deployed labelling bot for emdash-cms/emdash.
//
// Receives a GitHub webhook delivery, verifies the HMAC-SHA256 signature
// against the raw request bytes, runs the `triage-label` skill with a
// valibot schema for structured output, then applies labels and posts a
// comment via Octokit.
//
// Cost: one Workers AI call per issue (~$0 on free tier with kimi-k2.6).
// Latency: ~5s end-to-end for a typical issue.
//
// Local prototype path: scripts/run-local.ts feeds fixtures through the
// triageIssue() helper directly without HMAC or webhook plumbing, so we
// can iterate on the skill prompt before deploying anything.

import type { FlueContext, FlueSession } from "@flue/runtime";
import * as v from "valibot";

import { addLabels, fetchAreaLabels, type IssuePayload, postIssueComment } from "../lib/github.js";
import { verifyGitHubSignature } from "../lib/verify-signature.js";

export const triggers = { webhook: true };

interface Env {
	AI: unknown;
	GITHUB_TOKEN?: string;
	GITHUB_WEBHOOK_SECRET?: string;
	// Set to "true" to skip GitHub writes and just log. Useful for first deploys.
	DRY_RUN?: string;
	// Set to "true" to skip HMAC verification. DEV ONLY — never enable in
	// production. Used for local `flue run` prototyping where we can't
	// easily sign the synthetic payload.
	SKIP_HMAC?: string;
}

interface IssueWebhookPayload {
	action?: string;
	issue?: IssuePayload & { pull_request?: unknown };
	repository?: {
		name?: string;
		owner?: { login?: string };
	};
}

const triageSchema = v.object({
	kind: v.picklist(["bug", "enhancement", "documentation", "question"]),
	severity: v.picklist(["low", "medium", "high", "critical"]),
	areaLabels: v.pipe(
		v.array(v.string()),
		v.maxLength(3),
		v.description(
			"Zero to three labels chosen from availableAreaLabels. Empty array is preferred over a wrong guess.",
		),
	),
	reproducible: v.pipe(
		v.boolean(),
		v.description(
			"true if the issue includes both reproduction steps and expected-vs-actual behaviour.",
		),
	),
	dataLossRisk: v.pipe(
		v.boolean(),
		v.description(
			"true if the issue describes data destruction, silent data loss, or an exploitable security issue.",
		),
	),
	summary: v.pipe(
		v.string(),
		v.minLength(10),
		v.maxLength(200),
		v.description("One-sentence summary for a maintainer skim. Max ~25 words."),
	),
});

export type TriageResult = v.InferOutput<typeof triageSchema>;

/**
 * Pure function: given an issue + session, run the prompt and return the
 * structured result. Pulled out so the local prototype runner and the
 * Phase 2 repro pipeline can both call into it.
 *
 * The prompt is inlined here rather than loaded as a Flue skill because
 * the default Cloudflare sandbox starts with an empty filesystem — there
 * is no `.agents/skills/` for the model to discover. Phase 2 has a real
 * filesystem (local sandbox) and can use markdown skills for its own
 * multi-step prompts.
 */
export async function classifyIssue(
	session: FlueSession,
	args: {
		issueTitle: string;
		issueBody: string;
		issueNumber: number;
		availableAreaLabels: string[];
	},
): Promise<TriageResult> {
	const prompt = buildTriagePrompt(args);
	const { data } = await session.prompt(prompt, { result: triageSchema });
	return data;
}

function buildTriagePrompt(args: {
	issueTitle: string;
	issueBody: string;
	issueNumber: number;
	availableAreaLabels: string[];
}): string {
	const labelLines = args.availableAreaLabels.map((l) => `- \`${l}\``).join("\n");
	return `You are triaging a newly-opened GitHub issue on \`emdash-cms/emdash\`. EmDash is a CMS that runs on Astro and Cloudflare. The monorepo has packages for core, admin UI, auth, cloudflare integrations, plugins, marketplace, and a CLI.

## Issue #${args.issueNumber}: ${args.issueTitle}

${args.issueBody || "(no body)"}

## Available area labels

${labelLines}

## Your task

Decide each of the following. Return the result strictly matching the schema.

### kind

- **bug** — broken, regressed, or behaves incorrectly. Default for unexpected-behaviour reports.
- **enhancement** — proposes a new feature, new API, or substantial new capability.
- **documentation** — issue is purely about docs being wrong, missing, or unclear.
- **question** — user is asking how to do something, not reporting a break.

### severity

- **critical** — data loss, security incident, production outage, or anyone upgrading hits it and is broken.
- **high** — blocks a major user flow with no obvious workaround. Reproducible. Affects most users on a common configuration.
- **medium** — bug with a workaround, or affects only some users / configurations. Default for most well-formed bug reports.
- **low** — cosmetic, typo, edge case affecting one user, "nice to have".

If kind is \`enhancement\`/\`question\`/\`documentation\`, set severity to \`low\` unless it's actively blocking real users.

### areaLabels

Pick **zero to three** from the list above. Be conservative — don't pick a label unless the evidence is in the issue body. Mapping hints:

- \`area/core\` — anything in \`packages/core\`: API routes, database/migrations, schema/registry, runtime, middleware, importers, CLI inside core.
- \`area/admin\` — admin React UI, login screens, dashboards, editors.
- \`area/auth\` — passkey, magic link, session, RBAC, ATProto auth.
- \`area/cloudflare\` — D1, R2, Workers-specific behaviour, miniflare, edge runtime issues.
- \`area/plugins\` — plugin loading, sandboxing, plugin APIs, plugin authoring.
- \`area/templates\` — starter templates in \`templates/\` or \`demos/\`.
- \`area/docs\` — the docs site at \`docs/\`.
- \`area/cli\` — the \`emdash\` CLI (separate from CLI code inside core).
- \`area/ci\` — GitHub Actions workflows, release pipeline, changesets infra.

If you genuinely cannot decide, return an empty array. **Empty is better than wrong.**

### reproducible

Set to \`true\` only if the issue includes **both** ordered or clear reproduction steps AND expected-vs-actual behaviour. A clear bug description ("do X, then Y happens") is acceptable.

### dataLossRisk

Flip to \`true\` if the issue describes data destruction, lost/overwritten data, silent data drops, broken migrations that leave users stuck, or exploitable security issues.

### summary

**One sentence**, max ~25 words. State what's broken (or proposed) in the user's own framing. No emojis, no marketing voice, no "this issue describes". Just the fact.

Good: "Migration 036 drops content_taxonomies data on D1 because PRAGMA foreign_keys=OFF is silently ignored."
Bad: "This issue describes a bug related to a database migration on Cloudflare."`;
}

/**
 * Decide which GitHub labels to apply from a triage result.
 * Pulled out so the runner can preview them without applying.
 */
export function pickLabels(triage: TriageResult, validAreaLabels: string[]): string[] {
	const filteredAreas = triage.areaLabels.filter((l) => validAreaLabels.includes(l));
	const labels: string[] = [];
	if (triage.kind === "bug") labels.push("bug");
	if (triage.kind === "documentation") labels.push("documentation");
	if (triage.kind === "question") labels.push("question");
	// Intentionally do NOT auto-apply `enhancement` — CONTRIBUTING.md
	// requires a prior Discussion for features.
	labels.push(...filteredAreas);
	return labels;
}

/**
 * Render the triage comment body. Boring, factual, no emojis except the
 * one ⚠️ for data-loss flagging (signal value > noise).
 */
export function renderComment(triage: TriageResult, validAreaLabels: string[]): string {
	const filteredAreas = triage.areaLabels.filter((l) => validAreaLabels.includes(l));
	const lines: string[] = [];
	lines.push(`**Auto-triage** _(experimental — please correct any wrong calls)_`);
	lines.push("");
	lines.push(`- Kind: \`${triage.kind}\``);
	lines.push(`- Severity: \`${triage.severity}\``);
	if (filteredAreas.length > 0) {
		lines.push(`- Area: ${filteredAreas.map((l) => `\`${l}\``).join(", ")}`);
	}
	lines.push(`- Reproducible from description: \`${triage.reproducible}\``);
	if (triage.dataLossRisk) {
		lines.push(`- ⚠️ Flagged as data-loss / security risk`);
	}
	lines.push("");
	lines.push(`> ${triage.summary}`);
	return lines.join("\n");
}

export default async function ({ init, req, env, log }: FlueContext<unknown, Env>) {
	if (!req) {
		return new Response("agent requires HTTP context", { status: 400 });
	}

	// Read raw bytes once. We need them for HMAC verification before
	// parsing JSON — see lib/verify-signature.ts for why.
	const rawBody = await req.arrayBuffer();
	const signature = req.headers.get("x-hub-signature-256");
	const event = req.headers.get("x-github-event") ?? "";
	const deliveryId = req.headers.get("x-github-delivery") ?? "unknown";

	const secret = env.GITHUB_WEBHOOK_SECRET;
	const skipVerify = env.SKIP_HMAC === "true";
	if (skipVerify) {
		log.warn("SKIP_HMAC=true — webhook signature verification disabled (dev only)");
	} else {
		if (!secret) {
			log.error("missing GITHUB_WEBHOOK_SECRET");
			return new Response("server misconfigured", { status: 500 });
		}
		if (!(await verifyGitHubSignature(secret, rawBody, signature))) {
			log.warn("invalid webhook signature", { event, deliveryId });
			return new Response("invalid signature", { status: 401 });
		}
	}

	if (event === "ping") {
		return Response.json({ handled: "ping" });
	}
	if (event !== "issues") {
		return Response.json({ handled: "ignored", reason: `event=${event}` });
	}

	let payload: IssueWebhookPayload;
	try {
		const parsed: IssueWebhookPayload = JSON.parse(new TextDecoder().decode(rawBody));
		payload = parsed;
	} catch {
		return new Response("invalid JSON", { status: 400 });
	}

	if (payload.action !== "opened") {
		return Response.json({
			handled: "ignored",
			reason: `action=${payload.action}`,
		});
	}
	if (!payload.issue) {
		return Response.json({ handled: "ignored", reason: "no issue in payload" });
	}
	if (payload.issue.pull_request) {
		return Response.json({ handled: "ignored", reason: "issue is a pull request" });
	}

	const issue = payload.issue;
	const owner = payload.repository?.owner?.login ?? "emdash-cms";
	const repo = payload.repository?.name ?? "emdash";
	const issueNumber = issue.number ?? 0;
	if (!issueNumber) {
		return Response.json({ handled: "error", reason: "missing issue.number" });
	}

	// Fetch available area labels at runtime so the labelling adapts to
	// new/renamed labels without redeploying.
	let availableAreaLabels: string[];
	try {
		availableAreaLabels = await fetchAreaLabels(env.GITHUB_TOKEN, owner, repo);
	} catch (err) {
		log.warn("fetchAreaLabels failed, using fallback", { error: String(err) });
		availableAreaLabels = [
			"area/core",
			"area/admin",
			"area/auth",
			"area/cloudflare",
			"area/plugins",
			"area/templates",
			"area/docs",
			"area/cli",
			"area/ci",
		];
	}

	const agent = await init({
		// The deployed Worker uses the Workers AI binding directly (no
		// gateway hop) since we're already running on Cloudflare. The
		// AI Gateway is for off-CF callers like the GH Actions runner.
		model: "cloudflare-workers-ai/@cf/moonshotai/kimi-k2.6",
	});
	const session = await agent.session();

	const triage = await classifyIssue(session, {
		issueTitle: issue.title ?? "(no title)",
		issueBody: issue.body ?? "",
		issueNumber,
		availableAreaLabels,
	});

	const labelsToApply = pickLabels(triage, availableAreaLabels);
	const commentBody = renderComment(triage, availableAreaLabels);
	const dryRun = env.DRY_RUN === "true";

	if (dryRun) {
		log.info("DRY_RUN — not posting to GitHub", {
			issueNumber,
			labelsToApply,
		});
		return Response.json({
			handled: "issues.opened",
			dryRun: true,
			triage,
			labelsToApply,
			commentBody,
		});
	}

	if (env.GITHUB_TOKEN) {
		if (labelsToApply.length > 0) {
			await addLabels(env.GITHUB_TOKEN, owner, repo, issueNumber, labelsToApply);
		}
		await postIssueComment(env.GITHUB_TOKEN, owner, repo, issueNumber, commentBody);
	} else {
		log.warn("no GITHUB_TOKEN — triage produced but not posted");
	}

	return Response.json({
		handled: "issues.opened",
		triage,
		labelsApplied: labelsToApply,
	});
}
