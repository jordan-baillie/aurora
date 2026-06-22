#!/usr/bin/env node
// Guard: the shipped product must NOT ship a built-in Claude (Anthropic) subscription OAuth login.
//
// Logging a redistributed tool into a personal Claude subscription is outside Anthropic's terms, so
// summon is bring-your-own-API-key by default. The Claude OAuth *login flow* (PKCE against
// claude.ai/oauth, plus registration of an "anthropic" OAuth provider) must live only in a
// user-installed local extension, never in the distributed source tree.
//
// This check scans shipped source (packages/<pkg>/src, excluding tests/dist/node_modules and the
// examples/ trees) for the Claude OAuth authorize endpoint and for re-registration of a built-in
// Anthropic OAuth provider. The latent ability of providers/anthropic.ts to *consume* an
// `sk-ant-oat` token is allowed (it is unreachable without a login provider); creating/registering
// one is not.
//
// If this fails, do not relax the check — move the offending login code back out into a local
// extension (see packages/coding-agent/docs/providers.md).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["packages/ai/src", "packages/coding-agent/src"];
const IGNORED_DIRS = new Set(["node_modules", "dist", "test", "tests", "__tests__"]);

// Forbidden patterns in shipped source.
const FORBIDDEN = [
	{ re: /claude\.ai\/oauth\/authorize/i, why: "Claude subscription OAuth authorize endpoint" },
	{
		re: /anthropicOAuthProvider/,
		why: "built-in Anthropic OAuth provider symbol (login flow must be a local extension)",
	},
];

function collect(dir, out) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (!IGNORED_DIRS.has(entry.name)) collect(full, out);
			continue;
		}
		if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".mjs"))) {
			if (entry.name.endsWith(".test.ts")) continue;
			out.push(full);
		}
	}
	return out;
}

const failures = [];
for (const root of ROOTS) {
	for (const file of collect(root, []).sort()) {
		const text = readFileSync(file, "utf8");
		for (const { re, why } of FORBIDDEN) {
			if (re.test(text)) failures.push(`${file}: ${why} (matched /${re.source}/)`);
		}
	}
}

if (failures.length > 0) {
	console.error("check-no-builtin-claude-oauth: shipped source must not contain Claude subscription OAuth login:");
	for (const f of failures) console.error(`  - ${f}`);
	console.error(
		"\nMove the Claude OAuth login flow into a user-installed local extension; see packages/coding-agent/docs/providers.md.",
	);
	process.exit(1);
}

console.log("check-no-builtin-claude-oauth: ok (no built-in Claude subscription OAuth login in shipped source)");
