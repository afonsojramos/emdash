// Minimal Octokit wrapper plus a label fetcher.
//
// Keep imports small — this runs on Workers, and @octokit/core is much
// lighter than @octokit/rest.

import { Octokit } from "@octokit/core";

export interface IssuePayload {
	number?: number;
	title?: string;
	body?: string | null;
	labels?: Array<{ name: string }>;
	user?: { login?: string };
}

function octokit(token: string | undefined): Octokit {
	if (!token) throw new Error("GITHUB_TOKEN is required");
	return new Octokit({ auth: token });
}

export async function postIssueComment(
	token: string,
	owner: string,
	repo: string,
	issueNumber: number,
	body: string,
): Promise<void> {
	await octokit(token).request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
		owner,
		repo,
		issue_number: issueNumber,
		body,
	});
}

export async function addLabels(
	token: string,
	owner: string,
	repo: string,
	issueNumber: number,
	labels: string[],
): Promise<void> {
	if (labels.length === 0) return;
	await octokit(token).request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
		owner,
		repo,
		issue_number: issueNumber,
		labels,
	});
}

/**
 * Fetch all labels with the `area/` prefix. Paginates if needed; the repo
 * currently has fewer than 100 labels total so a single page is plenty.
 *
 * Works without a token (public repo) but rate-limited harder. Tokens are
 * preferred.
 */
export async function fetchAreaLabels(
	token: string | undefined,
	owner: string,
	repo: string,
): Promise<string[]> {
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"User-Agent": "emdash-flue-triage",
	};
	if (token) headers.Authorization = `token ${token}`;

	const all: { name: string }[] = [];
	let page = 1;
	while (true) {
		const res = await fetch(
			`https://api.github.com/repos/${owner}/${repo}/labels?per_page=100&page=${page}`,
			{ headers },
		);
		if (!res.ok) {
			throw new Error(`fetchAreaLabels HTTP ${res.status}: ${await res.text()}`);
		}
		const batch: { name: string }[] = await res.json();
		all.push(...batch);
		if (batch.length < 100) break;
		page++;
		if (page > 10) break; // hard safety
	}

	return all.map((l) => l.name).filter((n) => n.startsWith("area/"));
}
