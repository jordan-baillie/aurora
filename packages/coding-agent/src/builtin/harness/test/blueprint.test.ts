// Offline unit tests for the blueprint engine (validateBlueprint / runBlueprint / loadBlueprints). Run:
//   node --experimental-strip-types --test test/blueprint.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	type Blueprint,
	type BlueprintExec,
	loadBlueprints,
	type NodeRun,
	runBlueprint,
	validateBlueprint,
} from "../src/blueprint.ts";
import type { AgentBundle } from "../src/core.ts";

// ── Fake registry ─────────────────────────────────────────────────────────────
function makeBundle(name: string, may_spawn = false): AgentBundle {
	return {
		name,
		role: `${name} role`,
		model_tier: "fast",
		tools: ["read"],
		output_contract: { required_sections: [`## ${name}`] },
		...(may_spawn ? { may_spawn: true } : {}),
	};
}
const reg = new Map<string, AgentBundle>([
	["scout", makeBundle("scout")],
	["builder", makeBundle("builder")],
	["reviewer", makeBundle("reviewer")],
	["orchestrator", makeBundle("orchestrator", true)],
]);

// An exec that always succeeds, echoing a per-node output; records dispatch order.
function recordingExec(order: string[], failIds: Set<string> = new Set()): BlueprintExec {
	const run = async (id: string, label: string): Promise<NodeRun> => {
		order.push(`start:${id}`);
		await new Promise<void>((r) => setTimeout(r, 25));
		order.push(`end:${id}`);
		return { ok: !failIds.has(id), output: `${label}-out` };
	};
	return {
		runAgent: (agent, prompt, node) => run(node.id, `${agent}:${prompt}`),
		runCode: (cmd, node) => run(node.id, `code:${cmd}`),
	};
}

// ── validateBlueprint ─────────────────────────────────────────────────────────

test("validateBlueprint rejects an unknown agent", () => {
	const bp: Blueprint = { name: "b", nodes: [{ id: "a", agent: "ghost", prompt: "x" }] };
	assert.throws(() => validateBlueprint(bp, reg), /unknown agent 'ghost'/);
});

test("validateBlueprint rejects a may_spawn agent as a node", () => {
	const bp: Blueprint = { name: "b", nodes: [{ id: "a", agent: "orchestrator", prompt: "x" }] };
	assert.throws(() => validateBlueprint(bp, reg), /delegation agent/);
});

test("validateBlueprint rejects a node that is both code and agent", () => {
	const bp: Blueprint = { name: "b", nodes: [{ id: "a", agent: "scout", prompt: "x", run: "ls" }] };
	assert.throws(() => validateBlueprint(bp, reg), /not both/);
});

test("validateBlueprint rejects a node that is neither code nor agent", () => {
	const bp: Blueprint = { name: "b", nodes: [{ id: "a" }] };
	assert.throws(() => validateBlueprint(bp, reg), /must be a code node/);
});

test("validateBlueprint rejects a destructive code node", () => {
	const bp: Blueprint = { name: "b", nodes: [{ id: "a", run: "rm -rf /" }] };
	assert.throws(() => validateBlueprint(bp, reg), /destructive/);
});

test("validateBlueprint rejects duplicate node ids", () => {
	const bp: Blueprint = {
		name: "b",
		nodes: [
			{ id: "a", run: "ls" },
			{ id: "a", run: "pwd" },
		],
	};
	assert.throws(() => validateBlueprint(bp, reg), /duplicate node id/);
});

test("validateBlueprint rejects a depends_on referencing an unknown node", () => {
	const bp: Blueprint = { name: "b", nodes: [{ id: "a", run: "ls", depends_on: ["ghost"] }] };
	assert.throws(() => validateBlueprint(bp, reg), /unknown node 'ghost'/);
});

test("validateBlueprint rejects a self-dependency", () => {
	const bp: Blueprint = { name: "b", nodes: [{ id: "a", run: "ls", depends_on: ["a"] }] };
	assert.throws(() => validateBlueprint(bp, reg), /depends on itself/);
});

test("validateBlueprint rejects a dependency cycle", () => {
	const bp: Blueprint = {
		name: "b",
		nodes: [
			{ id: "a", run: "ls", depends_on: ["b"] },
			{ id: "b", run: "pwd", depends_on: ["a"] },
		],
	};
	assert.throws(() => validateBlueprint(bp, reg), /cycle/);
});

test("validateBlueprint accepts a valid diamond DAG", () => {
	const bp: Blueprint = {
		name: "ok",
		nodes: [
			{ id: "a", agent: "scout", prompt: "x" },
			{ id: "b", agent: "builder", prompt: "y", depends_on: ["a"] },
			{ id: "c", run: "git diff --stat", depends_on: ["a"] },
			{ id: "d", agent: "reviewer", prompt: "z", depends_on: ["b", "c"] },
		],
	};
	assert.doesNotThrow(() => validateBlueprint(bp, reg));
});

// ── runBlueprint ──────────────────────────────────────────────────────────────

test("runBlueprint runs independent nodes in PARALLEL and respects dependencies", async () => {
	const order: string[] = [];
	// a -> {b, c} -> d  (b and c independent of each other)
	const bp: Blueprint = {
		name: "diamond",
		nodes: [
			{ id: "a", agent: "scout", prompt: "recon {{task}}" },
			{ id: "b", agent: "builder", prompt: "build", depends_on: ["a"] },
			{ id: "c", run: "git diff --stat", depends_on: ["a"] },
			{ id: "d", agent: "reviewer", prompt: "review", depends_on: ["b", "c"] },
		],
	};
	const outcome = await runBlueprint(bp, { task: "T" }, recordingExec(order));

	// dependency ordering
	const endA = order.indexOf("end:a");
	const startB = order.indexOf("start:b");
	const startC = order.indexOf("start:c");
	const endB = order.indexOf("end:b");
	const endC = order.indexOf("end:c");
	const startD = order.indexOf("start:d");
	assert.ok(endA < startB && endA < startC, `a must finish before b/c (order=${order.join()})`);
	assert.ok(Math.max(endB, endC) < startD, `b and c must finish before d (order=${order.join()})`);
	// b and c run in parallel: both start before either ends
	assert.ok(Math.max(startB, startC) < Math.min(endB, endC), `b and c must overlap (order=${order.join()})`);

	// all done
	assert.deepEqual(
		outcome.nodes.map((n) => n.status),
		["done", "done", "done", "done"],
	);
});

test("runBlueprint passes upstream output downstream via {{node.<id>}}", async () => {
	const seen: Record<string, string> = {};
	const exec: BlueprintExec = {
		runAgent: async (_agent, prompt, node) => {
			seen[node.id] = prompt;
			return { ok: true, output: `${node.id}-OUTPUT` };
		},
		runCode: async (cmd, node) => {
			seen[node.id] = cmd;
			return { ok: true, output: `${node.id}-OUTPUT` };
		},
	};
	const bp: Blueprint = {
		name: "chain",
		nodes: [
			{ id: "a", agent: "scout", prompt: "recon" },
			{ id: "b", agent: "builder", prompt: "use [{{node.a}}] for {{task}}", depends_on: ["a"] },
		],
	};
	await runBlueprint(bp, { task: "T" }, exec);
	assert.equal(seen.b, "use [a-OUTPUT] for T");
});

test("runBlueprint fail-closes dependents when an upstream node fails", async () => {
	const order: string[] = [];
	// a -> b -> c ; and an independent d. b fails => c skipped, d still runs.
	const bp: Blueprint = {
		name: "failclosed",
		nodes: [
			{ id: "a", agent: "scout", prompt: "x" },
			{ id: "b", agent: "builder", prompt: "y", depends_on: ["a"] },
			{ id: "c", agent: "reviewer", prompt: "z", depends_on: ["b"] },
			{ id: "d", run: "echo hi" },
		],
	};
	const outcome = await runBlueprint(bp, {}, recordingExec(order, new Set(["b"])));
	const byId = new Map(outcome.nodes.map((n) => [n.id, n]));
	assert.equal(byId.get("a")!.status, "done");
	assert.equal(byId.get("b")!.status, "failed");
	assert.equal(byId.get("c")!.status, "skipped");
	assert.deepEqual(byId.get("c")!.skipped_by, ["b"]);
	assert.equal(byId.get("d")!.status, "done");
	// c must never have started
	assert.ok(!order.includes("start:c"), `c must not run (order=${order.join()})`);
});

// ── loadBlueprints ────────────────────────────────────────────────────────────

test("loadBlueprints loads + validates from a temp dir fixture", () => {
	const tmp = mkdtempSync(join(tmpdir(), "harness-bp-"));
	const saved = process.env.HARNESS_BLUEPRINTS_DIR;
	try {
		process.env.HARNESS_BLUEPRINTS_DIR = tmp;
		writeFileSync(
			join(tmp, "ok.json"),
			JSON.stringify({
				name: "ok",
				nodes: [
					{ id: "a", agent: "scout", prompt: "recon {{task}}" },
					{ id: "g", run: "git diff --stat", depends_on: ["a"] },
				],
			}),
		);
		const bps = loadBlueprints(reg);
		assert.ok(bps.has("ok"));
		assert.equal(bps.get("ok")!.nodes.length, 2);

		// malformed (cycle) fixture must fail-closed
		const tmp2 = mkdtempSync(join(tmpdir(), "harness-bp-bad-"));
		try {
			process.env.HARNESS_BLUEPRINTS_DIR = tmp2;
			writeFileSync(
				join(tmp2, "bad.json"),
				JSON.stringify({
					name: "bad",
					nodes: [
						{ id: "a", run: "ls", depends_on: ["b"] },
						{ id: "b", run: "pwd", depends_on: ["a"] },
					],
				}),
			);
			assert.throws(() => loadBlueprints(reg), /cycle/);
		} finally {
			rmSync(tmp2, { recursive: true, force: true });
		}
	} finally {
		if (saved === undefined) delete process.env.HARNESS_BLUEPRINTS_DIR;
		else process.env.HARNESS_BLUEPRINTS_DIR = saved;
		rmSync(tmp, { recursive: true, force: true });
	}
});

// The shipped default blueprint must be valid against the real seed registry shape.
test("shipped scout-build-verify blueprint validates", () => {
	const saved = process.env.HARNESS_BLUEPRINTS_DIR;
	try {
		delete process.env.HARNESS_BLUEPRINTS_DIR; // use the install default (BLUEPRINTS_DIR)
		const bps = loadBlueprints(reg);
		assert.ok(bps.has("scout-build-verify"), "the shipped blueprint should load");
	} finally {
		if (saved !== undefined) process.env.HARNESS_BLUEPRINTS_DIR = saved;
	}
});
