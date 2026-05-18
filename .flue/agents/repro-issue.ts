// Phase 2: reproduction attempt for an EmDash issue, run on GH Actions.
//
// Triggered from `.github/workflows/auto-repro.yml` when a maintainer
// applies the `triage:reproduce` label to an existing issue. The runner
// has already done: checkout, setup-node, setup-pnpm, `pnpm install`.
//
// The agent uses the local sandbox so its bash tool gets real access to
// the runner's filesystem and PATH. It:
//   1. Classifies the issue (same skill as the Worker labeller, just to
//      get a triage record we can lean on for steering reproduction).
//   2. Runs the `reproduce` skill — write a failing test or repro script,
//      run it, report observation.
//   3. Posts a single comment back to the issue with the result.
//
// Critical scope guardrails:
//   - Never push branches.
//   - Never call `git commit` on existing tracked files.
//   - Never attempt a fix.
//   - Notes posted in the comment are plain text inside a fenced block.
//
// Opus by default because reproduction is the bottleneck stage in
// Astro's setup too. Override with FLUE_REPRO_MODEL.

import type { FlueContext } from "@flue/runtime";
import { local } from "@flue/runtime/node";
import * as v from "valibot";

import { addLabels, fetchAreaLabels, postIssueComment } from "../lib/github.js";
import { classifyIssue, type TriageResult } from "./triage-label.js";

// CLI-only — invoked via `flue run repro-issue` from a workflow.
export const triggers = {};

interface ReproPayload {
	issueNumber?: number;
	issueTitle?: string;
	issueBody?: string;
	owner?: string;
	repo?: string;
}

const reproSchema = v.object({
	reproduced: v.pipe(
		v.boolean(),
		v.description("true if you actually observed the reported failure"),
	),
	skipped: v.pipe(
		v.boolean(),
		v.description(
			"true if reproduction was deliberately not attempted (host-specific, requires user's WXR, etc.)",
		),
	),
	approach: v.pipe(
		v.picklist(["failing-test", "repro-script", "pnpm-command", "none"]),
		v.description("How you tried to reproduce. Use 'none' only when skipped=true."),
	),
	notes: v.pipe(
		v.string(),
		v.minLength(20),
		v.maxLength(4000),
		v.description(
			"Plain text. Include exact commands run, observed output. Posted inside a fenced code block.",
		),
	),
	suggestedNextStep: v.pipe(
		v.string(),
		v.minLength(0),
		v.maxLength(500),
		v.description(
			"One line of plain text for a maintainer. Empty string if you have nothing useful to add.",
		),
	),
});

export type ReproResult = v.InferOutput<typeof reproSchema>;

export default async function ({ init, payload, log }: FlueContext<ReproPayload>) {
	const issueNumber = payload.issueNumber ?? 0;
	const issueTitle = payload.issueTitle ?? "";
	const issueBody = payload.issueBody ?? "";
	const owner = payload.owner ?? "emdash-cms";
	const repo = payload.repo ?? "emdash";
	const githubToken = process.env.GITHUB_TOKEN;

	if (!issueNumber || !issueTitle) {
		throw new Error("payload requires issueNumber and issueTitle");
	}
	if (!githubToken) {
		throw new Error("repro-issue requires GITHUB_TOKEN to post the result comment");
	}

	// Step 1: classify, using the lightweight model. We feed the triage
	// into the reproduce skill so it can focus on the right area. All
	// model traffic goes through our Cloudflare AI Gateway.
	const classifyHarness = await init({
		name: "classify",
		model: "cloudflare-ai-gateway/workers-ai/@cf/moonshotai/kimi-k2.6",
	});
	const classifySession = await classifyHarness.session();

	let availableAreaLabels: string[];
	try {
		availableAreaLabels = await fetchAreaLabels(githubToken, owner, repo);
	} catch {
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

	const triage: TriageResult = await classifyIssue(classifySession, {
		issueTitle,
		issueBody,
		issueNumber,
		availableAreaLabels,
	});
	log.info("classified", { issueNumber, triage });

	// Step 2: reproduce. Local sandbox: bash tool gets real PATH access.
	// Pass GH_TOKEN explicitly — by default local() doesn't inherit it.
	const reproHarness = await init({
		name: "repro",
		sandbox: local({
			env: {
				GH_TOKEN: githubToken,
				// Common pnpm/node env so the runner behaves as expected.
				CI: "true",
				NODE_ENV: "test",
			},
		}),
		// Opus through the gateway — same model /bonk uses, same billing
		// surface. Override with FLUE_REPRO_MODEL for experiments.
		model: process.env.FLUE_REPRO_MODEL ?? "cloudflare-ai-gateway/claude-opus-4-7",
	});
	const reproSession = await reproHarness.session();

	const { data: repro }: { data: ReproResult } = await reproSession.skill("reproduce", {
		args: {
			issueNumber,
			issueTitle,
			issueBody,
			triage,
		},
		result: reproSchema,
	});

	log.info("repro complete", {
		issueNumber,
		reproduced: repro.reproduced,
		skipped: repro.skipped,
		approach: repro.approach,
	});

	// Step 3: post a single comment to the issue with the result.
	const commentBody = renderReproComment(triage, repro);
	await postIssueComment(githubToken, owner, repo, issueNumber, commentBody);

	// Apply a follow-up label so the queue is searchable:
	//   - reproduced     → reproduction confirmed, ready for fix work
	//   - not-reproduced → could not reproduce, may be user error or stale
	//   - repro-skipped  → host-specific, requires user data, etc.
	// These labels don't exist yet; the workflow creates them lazily.
	const resultLabel = repro.skipped
		? "repro-skipped"
		: repro.reproduced
			? "reproduced"
			: "not-reproduced";
	try {
		await addLabels(githubToken, owner, repo, issueNumber, [resultLabel]);
	} catch (err) {
		log.warn("failed to apply result label", { resultLabel, error: String(err) });
	}

	return { triage, repro, resultLabel, applied: true };
}

function renderReproComment(triage: TriageResult, repro: ReproResult): string {
	const lines: string[] = [];
	lines.push(`**Reproduction attempt** _(experimental — please correct any wrong calls)_`);
	lines.push("");
	if (repro.skipped) {
		lines.push(`Skipped — \`${repro.approach}\``);
	} else if (repro.reproduced) {
		lines.push(`✅ Reproduced via \`${repro.approach}\``);
	} else {
		lines.push(`❌ Not reproduced — tried \`${repro.approach}\``);
	}
	lines.push("");
	lines.push("```");
	lines.push(repro.notes);
	lines.push("```");
	if (repro.suggestedNextStep.trim().length > 0) {
		lines.push("");
		lines.push(`> ${repro.suggestedNextStep}`);
	}
	lines.push("");
	lines.push(`_Classifier context: severity=\`${triage.severity}\`, kind=\`${triage.kind}\`._`);
	return lines.join("\n");
}
