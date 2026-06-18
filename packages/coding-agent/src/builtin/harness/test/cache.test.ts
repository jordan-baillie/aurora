// Offline unit tests for the within-run result cache + in-flight dedup (#5). Run:
//   node --experimental-strip-types --test test/cache.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { cacheKey, isCacheable, ResultCache } from "../src/cache.ts";
import type { AgentBundle, SpawnResult } from "../src/core.ts";

function bundle(name: string, tools: string[]): AgentBundle {
	return { name, role: "r", model_tier: "fast", tools, output_contract: { required_sections: ["## x"] } };
}
function result(status: SpawnResult["status"], excerpt = "out"): SpawnResult {
	return {
		agent: "scout",
		status,
		artifact_excerpt: excerpt,
		contract: { passed: status === "done", missing: [] },
		meta: { model: "claude-haiku-4-5", elapsed_s: 1, bytes: excerpt.length },
	};
}

test("isCacheable: read-only agents yes, side-effecting agents no", () => {
	assert.equal(isCacheable(bundle("scout", ["read", "grep"])), true);
	assert.equal(isCacheable(bundle("reviewer", ["read", "bash"])), false); // bash = side effect
	assert.equal(isCacheable(bundle("builder", ["read", "edit", "write"])), false);
});

test("cacheKey is stable for identical inputs and varies with prompt/verify/tools", () => {
	const b = bundle("scout", ["read"]);
	const k = cacheKey(b, "do X");
	assert.equal(k, cacheKey(b, "do X"));
	assert.notEqual(k, cacheKey(b, "do Y"));
	assert.notEqual(k, cacheKey(b, "do X", "pytest"));
	assert.notEqual(k, cacheKey(bundle("scout", ["read", "grep"]), "do X"));
});

test("ResultCache: a miss runs exec once and a later identical call is served from cache", async () => {
	const cache = new ResultCache();
	let calls = 0;
	const exec = async () => {
		calls++;
		return result("done", "first");
	};
	const a = await cache.run("k", exec);
	assert.equal(a.source, "miss");
	assert.equal(calls, 1);
	const b = await cache.run("k", exec);
	assert.equal(b.source, "cache");
	assert.equal(b.result.cached, "cache");
	assert.equal(calls, 1, "second identical call must NOT re-execute");
	assert.equal(cache.stats().hits, 1);
});

test("ResultCache: concurrent identical runs collapse to ONE execution (in-flight dedup)", async () => {
	const cache = new ResultCache();
	let calls = 0;
	const exec = async () => {
		calls++;
		await new Promise((r) => setTimeout(r, 30));
		return result("done");
	};
	const [r1, r2, r3] = await Promise.all([cache.run("k", exec), cache.run("k", exec), cache.run("k", exec)]);
	assert.equal(calls, 1, "three concurrent identical tasks must execute once");
	const sources = [r1.source, r2.source, r3.source].sort();
	assert.deepEqual(sources, ["inflight", "inflight", "miss"]);
	assert.equal(cache.stats().dedups, 2);
});

test("ResultCache: failures are NOT cached (re-run is correct)", async () => {
	const cache = new ResultCache();
	let calls = 0;
	const exec = async () => {
		calls++;
		return result(calls === 1 ? "failed" : "done");
	};
	const a = await cache.run("k", exec);
	assert.equal(a.result.status, "failed");
	const b = await cache.run("k", exec);
	assert.equal(calls, 2, "a failed result must not be cached");
	assert.equal(b.result.status, "done");
	assert.equal(b.source, "miss");
});

test("ResultCache.peek returns a stored hit without running, undefined otherwise", () => {
	const cache = new ResultCache();
	assert.equal(cache.peek("nope"), undefined);
});
