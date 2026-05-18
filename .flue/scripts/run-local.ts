// Local prototype runner.
//
// Wraps `flue run triage-issue` for convenience. Reads an issue fixture
// (or pulls one live with `gh issue view`), constructs the payload, and
// shows the structured triage result, the labels that would be applied,
// and the comment that would be posted.
//
// All model traffic routes through our Cloudflare AI Gateway. Required env:
//   CLOUDFLARE_ACCOUNT_ID=<account uuid>
//   CLOUDFLARE_GATEWAY_ID=<gateway slug>
//   CLOUDFLARE_API_TOKEN=<gateway-scoped token>
//
// No GitHub writes unless --apply is passed AND GITHUB_TOKEN is in env.
//
// Usage:
//   pnpm prototype 1021
//   pnpm prototype 1021 1049 1080
//   pnpm prototype --live 1083
//   pnpm prototype --apply --live 1083                                # post to GH
//   FLUE_TRIAGE_MODEL=cloudflare-ai-gateway/claude-opus-4-7 pnpm prototype 1021

import { execSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface Fixture {
	number: number;
	title: string;
	body: string;
	labels?: Array<{ name: string }>;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(HERE, "..", "fixtures");
const FLUE_DIR = resolve(HERE, "..");

async function loadFixture(arg: string, live: boolean): Promise<Fixture> {
	if (live) {
		const raw = execSync(
			`gh issue view ${arg} --repo emdash-cms/emdash --json number,title,body,labels`,
			{ encoding: "utf8" },
		);
		const parsed: Fixture = JSON.parse(raw);
		return parsed;
	}
	const path = join(FIXTURES_DIR, `issue-${arg}.json`);
	const parsed: Fixture = JSON.parse(await readFile(path, "utf8"));
	return parsed;
}

async function runOne(fixture: Fixture, apply: boolean): Promise<void> {
	const id = `local-${fixture.number}-${Date.now()}`;
	const payload = JSON.stringify({
		issueNumber: fixture.number,
		issueTitle: fixture.title,
		issueBody: fixture.body,
		owner: "emdash-cms",
		repo: "emdash",
		apply,
	});

	console.error(`\n=== issue #${fixture.number}: ${fixture.title}`);
	const start = Date.now();

	const result = spawnSync(
		"npx",
		["flue", "run", "triage-issue", "--target", "node", "--id", id, "--payload", payload],
		{
			cwd: FLUE_DIR,
			env: process.env,
			encoding: "utf8",
		},
	);

	const elapsed = Date.now() - start;
	console.error(`[${elapsed}ms] exit=${result.status}`);
	if (result.stderr) console.error(result.stderr);
	if (result.stdout) console.log(result.stdout);
}

async function main() {
	const args = process.argv.slice(2);
	const live = args.includes("--live");
	const apply = args.includes("--apply");
	const issueArgs = args.filter((a) => !a.startsWith("--"));

	if (issueArgs.length === 0) {
		console.error(
			"usage: tsx scripts/run-local.ts [--live] [--apply] <issueNumber> [<issueNumber>...]",
		);
		process.exit(2);
	}
	if (apply && !process.env.GITHUB_TOKEN && !process.env.GH_TOKEN) {
		console.error("--apply requires GITHUB_TOKEN");
		process.exit(2);
	}
	const missingGateway = [
		"CLOUDFLARE_ACCOUNT_ID",
		"CLOUDFLARE_GATEWAY_ID",
		"CLOUDFLARE_API_TOKEN",
	].filter((k) => !process.env[k]);
	if (missingGateway.length > 0) {
		console.error(`missing required env for Cloudflare AI Gateway: ${missingGateway.join(", ")}`);
		console.error(
			"set these from the same source bonk.yml / review.yml use (CF_AI_GATEWAY_* secrets locally).",
		);
		process.exit(2);
	}

	for (const arg of issueArgs) {
		const fixture = await loadFixture(arg, live);
		await runOne(fixture, apply);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
