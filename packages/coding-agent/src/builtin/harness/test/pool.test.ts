// Offline unit tests for WarmPool (pool.ts). Run:
//   node --experimental-strip-types --test test/pool.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { type PooledWorker, WarmPool, type WorkerFactory } from "../src/pool.ts";

// ── Fakes ────────────────────────────────────────────────────────────────────

class FakeWorker implements PooledWorker {
	readonly id: string;
	_healthy = true;
	failReset = false;
	resets = 0;
	destroyed = false;

	constructor(id: string) {
		this.id = id;
	}
	healthy(): boolean {
		return this._healthy;
	}
	async reset(): Promise<void> {
		if (this.failReset) throw new Error("reset failed");
		this.resets++;
	}
	destroy(): void {
		this.destroyed = true;
	}
}

class FakeFactory implements WorkerFactory<FakeWorker> {
	creations = 0;
	workers: FakeWorker[] = [];

	async create(): Promise<FakeWorker> {
		this.creations++;
		const w = new FakeWorker(`w${this.creations}`);
		this.workers.push(w);
		return w;
	}
}

/** Let microtasks AND a macro-task tick drain — ensures async .then() chains settle. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

// ── Tests ────────────────────────────────────────────────────────────────────

test("acquire creates up to size, then reuses idle on release", async () => {
	const factory = new FakeFactory();
	const pool = new WarmPool(factory, { size: 2 });

	const a = await pool.acquire();
	const b = await pool.acquire();
	assert.equal(factory.creations, 2, "two workers created");

	await pool.release(a); // a → idle; reset called once
	const creationsBefore = factory.creations;

	const c = await pool.acquire(); // should pop a from idle
	assert.equal(c, a, "should reuse idle worker a");
	assert.equal(factory.creations, creationsBefore, "no new creation on reuse");
	assert.equal(a.resets, 1, "reset called exactly once on a");

	const s = pool.stats();
	assert.equal(s.idle, 0, "no idle after reacquiring a");
	assert.equal(s.busy, 2, "a(=c) and b are busy");
	assert.equal(s.total, 2, "total = idle + busy");

	// quiet linter — b is intentionally held
	void b;
});

test("acquire blocks when full and resolves on release", async () => {
	const factory = new FakeFactory();
	const pool = new WarmPool(factory, { size: 1 });

	const w1 = await pool.acquire();
	assert.equal(factory.creations, 1);

	// 2nd acquire: pool is full → queued
	let resolved = false;
	const p2 = pool.acquire();
	p2.then(() => {
		resolved = true;
	});

	await Promise.resolve(); // flush any pending microtasks
	assert.equal(resolved, false, "2nd acquire must be pending while pool is full");

	// release w1 → waiter picks it up (reused after reset)
	await pool.release(w1);
	await tick(); // let the .then() callback run

	assert.equal(resolved, true, "2nd acquire should have resolved after release");
	const w2 = await p2;
	assert.equal(w2, w1, "released worker is reused by the waiter");
	assert.equal(w1.resets, 1, "reset called once on w1");
});

test("unhealthy idle worker is dropped on acquire", async () => {
	const factory = new FakeFactory();
	const pool = new WarmPool(factory, { size: 2 });

	const a = await pool.acquire();
	await pool.release(a); // a parks as idle
	a._healthy = false; // flip unhealthy while idle

	assert.equal(factory.creations, 1);
	const c = await pool.acquire(); // must not return a
	assert.notEqual(c, a, "unhealthy idle worker must not be returned");
	assert.ok(a.destroyed, "unhealthy idle worker must be destroyed");
	assert.equal(factory.creations, 2, "a fresh worker is created instead");
});

test("release of an unhealthy worker destroys it and still serves a queued waiter", async () => {
	const factory = new FakeFactory();
	const pool = new WarmPool(factory, { size: 1 });

	const w1 = await pool.acquire();
	const p2 = pool.acquire(); // queued — pool is full
	await Promise.resolve(); // ensure the waiter is registered

	w1._healthy = false;
	await pool.release(w1); // w1 destroyed → fulfilOrIdle → creates replacement
	await tick(); // let factory.create() + resolution propagate

	const w2 = await p2;
	assert.notEqual(w2, w1, "waiter receives a replacement, not the destroyed worker");
	assert.ok(w1.destroyed, "w1 must be destroyed on unhealthy release");
	assert.equal(factory.creations, 2, "one original + one replacement");
});

test("release whose reset rejects drops the worker", async () => {
	const factory = new FakeFactory();
	const pool = new WarmPool(factory, { size: 1 });

	const w1 = await pool.acquire();
	w1.failReset = true;

	await pool.release(w1); // reset throws → w1 destroyed, not parked
	assert.ok(w1.destroyed, "w1 must be destroyed when reset fails");
	assert.equal(pool.stats().idle, 0, "no idle worker after failed reset");

	// pool is now empty; next acquire must create a fresh worker
	const w2 = await pool.acquire();
	assert.notEqual(w2, w1, "fresh worker returned after failed-reset drop");
	assert.equal(factory.creations, 2, "original + replacement");
});

test("warm pre-creates up to size", async () => {
	const factory = new FakeFactory();
	const pool = new WarmPool(factory, { size: 3 });

	await pool.warm(); // default n = size = 3
	assert.equal(factory.creations, 3, "3 workers created by warm");
	const s = pool.stats();
	assert.equal(s.idle, 3, "all pre-created workers are idle");
	assert.equal(s.busy, 0, "none busy yet");
	assert.equal(s.total, 3, "total = idle");
});

test("drain destroys all workers and zeroes stats", async () => {
	const factory = new FakeFactory();
	const pool = new WarmPool(factory, { size: 3 });

	await pool.warm(2); // 2 idle workers
	await pool.acquire(); // move one to busy: idle=1, busy=1, total=2

	assert.equal(factory.creations, 2);
	await pool.drain();

	const s = pool.stats();
	assert.equal(s.idle, 0, "no idle after drain");
	assert.equal(s.busy, 0, "no busy after drain");
	assert.equal(s.total, 0, "total is zero after drain");

	const destroyed = factory.workers.filter((w) => w.destroyed).length;
	assert.equal(destroyed, factory.creations, "every created worker is destroyed by drain");
});
