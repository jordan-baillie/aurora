// Frozen offline tests for pool-transport registry logic (poolFor, drainAllPools, _poolCount).
// NO workers are spawned — WarmPool is lazy; factory.create() is never called by these tests.
// Run: node --experimental-strip-types --test test/pool-transport.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentBundle } from "../src/core.ts";
import { _poolCount, drainAllPools, POOL_MIN_BATCH, pickTransport, poolFor } from "../src/pool-transport.ts";

// Minimal valid bundles — only fields required by AgentBundle.
const b1: AgentBundle = {
	name: "pool-test-a",
	role: "test role A",
	model_tier: "fast",
	tools: ["read"],
	output_contract: { required_sections: ["## x"] },
};
const b2: AgentBundle = {
	name: "pool-test-b",
	role: "test role B",
	model_tier: "fast",
	tools: ["read"],
	output_contract: { required_sections: ["## x"] },
};

test("poolFor caches one pool per bundle name", async () => {
	try {
		const p1 = poolFor(b1);
		const p2 = poolFor(b1);
		assert.strictEqual(p1, p2, "same bundle name → same WarmPool instance");
		assert.equal(_poolCount(), 1, "exactly one pool in the registry");
	} finally {
		await drainAllPools();
	}
});

test("poolFor returns distinct pools for distinct bundles", async () => {
	try {
		const pa = poolFor(b1);
		const pb = poolFor(b2);
		assert.notStrictEqual(pa, pb, "different bundle names → different WarmPool instances");
		assert.equal(_poolCount(), 2, "two pools in the registry");
	} finally {
		await drainAllPools();
	}
});

// --- pickTransport (pure, frozen) ---

test("pickTransport: sameBundleCount below threshold → oneshot", () => {
	assert.strictEqual(pickTransport(4), "oneshot");
	assert.strictEqual(pickTransport(7), "oneshot");
});

test("pickTransport: sameBundleCount at/above threshold → pool", () => {
	assert.strictEqual(pickTransport(8), "pool");
	assert.strictEqual(pickTransport(20), "pool");
});

test("pickTransport: override wins regardless of count", () => {
	assert.strictEqual(pickTransport(1, "pool"), "pool");
	assert.strictEqual(pickTransport(50, "oneshot"), "oneshot");
});

test("POOL_MIN_BATCH calibration constant is 8", () => {
	assert.strictEqual(POOL_MIN_BATCH, 8);
});

// --- pool registry ---

test("drainAllPools clears the registry; poolFor returns a fresh pool afterwards", async () => {
	const pre = poolFor(b1);
	assert.equal(_poolCount(), 1, "one pool before drain");

	// drain is a no-op on a lazy (never-acquired) pool — no workers to destroy
	await drainAllPools();
	assert.equal(_poolCount(), 0, "registry is empty after drain");

	const post = poolFor(b1);
	assert.notStrictEqual(post, pre, "a new WarmPool is returned after drain (not the old stale one)");

	await drainAllPools(); // cleanup so tests don't leak state
});
