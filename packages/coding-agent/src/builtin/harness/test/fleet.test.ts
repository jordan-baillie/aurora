// Offline unit tests for fleet-level observability (#8). Run:
//   node --experimental-strip-types --test test/fleet.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	aggregateFleet,
	appendFleetEntry,
	auditPrompt,
	type FleetEntry,
	fleetDigest,
	readFleet,
} from "../src/fleet.ts";

function entry(over: Partial<FleetEntry> = {}): FleetEntry {
	return {
		ts: Date.now(),
		agent: "scout",
		model: "claude-haiku-4-5",
		status: "done",
		elapsed_s: 10,
		bytes: 400,
		est_tokens: 100,
		cached: null,
		verify: null,
		...over,
	};
}

test("appendFleetEntry + readFleet round-trip (skips corrupt lines)", () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-"));
	const path = join(dir, "nested", "fleet.jsonl");
	try {
		appendFleetEntry(path, entry());
		appendFleetEntry(path, entry({ agent: "builder", model: "claude-sonnet-4-6" }));
		const read = readFleet(path);
		assert.equal(read.length, 2);
		assert.equal(read[0].agent, "scout");
		assert.equal(read[1].agent, "builder");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("readFleet returns [] for a missing ledger", () => {
	assert.deepEqual(readFleet(join(tmpdir(), "does-not-exist-fleet.jsonl")), []);
});

test("aggregateFleet computes done-rate, agent-hours, tokens, cache-hit-rate, and groups", () => {
	const entries: FleetEntry[] = [
		entry({ agent: "scout", status: "done", elapsed_s: 3600, est_tokens: 100 }),
		entry({ agent: "scout", status: "done", elapsed_s: 1800, est_tokens: 0, cached: "cache" }),
		entry({ agent: "builder", model: "claude-sonnet-4-6", status: "failed", elapsed_s: 1800, est_tokens: 200 }),
	];
	const agg = aggregateFleet(entries);
	assert.equal(agg.total, 3);
	assert.equal(agg.done, 2);
	assert.equal(agg.done_rate, 0.67);
	assert.equal(agg.agent_hours, 2); // (3600+1800+1800)/3600 = 2.0
	assert.equal(agg.est_tokens, 300);
	assert.equal(agg.cache_hits, 1);
	assert.equal(agg.cache_hit_rate, 0.33);
	const scout = agg.by_agent.find((g) => g.key === "scout")!;
	assert.equal(scout.count, 2);
	assert.equal(scout.done, 2);
	assert.equal(scout.cache_hits, 1);
	assert.equal(agg.by_model.length, 2);
});

test("fleetDigest renders a markdown summary with per-agent rows", () => {
	const md = fleetDigest(aggregateFleet([entry({ agent: "scout" }), entry({ agent: "builder" })]));
	assert.match(md, /# Summon harness — fleet summary/);
	assert.match(md, /## by agent/);
	assert.ok(md.includes("scout") && md.includes("builder"));
});

test("auditPrompt flags prompts over the byte threshold (skill-bloat)", () => {
	const small = auditPrompt("scout", "short prompt");
	assert.equal(small.over, false);
	assert.ok(small.est_tokens > 0);
	const big = auditPrompt("bloated", "x".repeat(7000), 6000);
	assert.equal(big.over, true);
	assert.equal(big.bytes, 7000);
});
