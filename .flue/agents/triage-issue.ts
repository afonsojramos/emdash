// CLI-mode agent: take a parsed issue payload, return triage + labels.
//
// No HTTP, no webhook, no HMAC. Invoked by:
//   - The local prototype runner (scripts/run-local.ts) for skill iteration.
//   - GitHub Actions in Phase 2, when a maintainer applies a `triage:run`
//     label to an existing issue and we want a fresh classification.
//   - The webhook agent (agents/triage-label.ts), which calls into the
//     same `classifyIssue` core function after verifying the signature.
//
// Payload shape:
//   {
//     issueNumber: number,
//     issueTitle: string,
//     issueBody: string,
//     owner?: string,       // defaults to "emdash-cms"
//     repo?: string,        // defaults to "emdash"
//     apply?: boolean,      // post comment + labels to GitHub (default false)
//   }

import type { FlueContext } from "@flue/runtime";

import { addLabels, fetchAreaLabels, postIssueComment } from "../lib/github.js";
import { classifyIssue, pickLabels, renderComment, type TriageResult } from "./triage-label.js";

// CLI-only — no webhook.
export const triggers = {};

interface TriagePayload {
	issueNumber?: number;
	issueTitle?: string;
	issueBody?: string;
	owner?: string;
	repo?: string;
	apply?: boolean;
}

// `flue run` on Node populates env from process.env, which is already
// typed via @types/node. Reading process.env directly avoids hand-typing
// env bindings inside the agent.
export default async function ({ init, payload, log }: FlueContext<TriagePayload>) {
	const githubToken = process.env.GITHUB_TOKEN;
	const issueNumber = payload.issueNumber ?? 0;
	const issueTitle = payload.issueTitle ?? "";
	const issueBody = payload.issueBody ?? "";
	const owner = payload.owner ?? "emdash-cms";
	const repo = payload.repo ?? "emdash";
	const apply = payload.apply === true;

	if (!issueNumber || !issueTitle) {
		throw new Error("payload requires issueNumber and issueTitle");
	}

	let availableAreaLabels: string[];
	try {
		availableAreaLabels = await fetchAreaLabels(githubToken, owner, repo);
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

	const harness = await init({
		// All model traffic goes through our Cloudflare AI Gateway so it's
		// observable and cost-tracked alongside /bonk and /review. Requires
		// CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_GATEWAY_ID / CLOUDFLARE_API_TOKEN
		// in env. Use kimi for cheap classifications by default.
		model:
			process.env.FLUE_TRIAGE_MODEL ?? "cloudflare-ai-gateway/workers-ai/@cf/moonshotai/kimi-k2.6",
	});
	const session = await harness.session();

	const triage: TriageResult = await classifyIssue(session, {
		issueTitle,
		issueBody,
		issueNumber,
		availableAreaLabels,
	});

	const labels = pickLabels(triage, availableAreaLabels);
	const comment = renderComment(triage, availableAreaLabels);

	if (apply) {
		if (!githubToken) {
			throw new Error("apply=true but GITHUB_TOKEN is not set");
		}
		if (labels.length > 0) {
			await addLabels(githubToken, owner, repo, issueNumber, labels);
		}
		await postIssueComment(githubToken, owner, repo, issueNumber, comment);
		log.info("applied triage", { issueNumber, labels });
	}

	return { triage, labels, comment, applied: apply };
}
