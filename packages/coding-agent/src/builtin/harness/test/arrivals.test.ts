// Offline unit tests for ArrivalTracker (arrivals.ts / A6) — the rolling-window arrival-rate signal.
// Driven with an injected clock so there's no wall-clock flake.
// Run: node --experimental-strip-types --test test/arrivals.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { ArrivalTracker } from "../src/arrivals.ts";

const MIN = 60_000;

test("unknown bundle ⇒ all zeros", () => {
	const a = new ArrivalTracker();
	assert.deepEqual(a.rates("nope", 0), { rate1m: 0, rate5m: 0, trend: 0 });
});

test("rate1m counts only arrivals within the short window", () => {
	const a = new ArrivalTracker();
	const now = 10 * MIN;
	a.record("b", now - 90_000); // 1.5m ago → outside 1m, inside 5m
	a.record("b", now - 30_000); // inside 1m
	a.record("b", now - 5_000); // inside 1m
	const r = a.rates("b", now);
	assert.equal(r.rate1m, 2, "two arrivals within the last minute");
});

test("rate5m averages the long window to per-minute", () => {
	const a = new ArrivalTracker();
	const now = 10 * MIN;
	for (let i = 0; i < 5; i++) a.record("b", now - i * MIN - 1); // 5 arrivals spread across 5m
	const r = a.rates("b", now);
	assert.equal(r.rate5m, 1, "5 arrivals over a 5m window = 1/min");
});

test("trend is positive when demand is accelerating", () => {
	const a = new ArrivalTracker();
	const now = 10 * MIN;
	a.record("b", now - 4 * MIN); // old, lowers the 5m average
	a.record("b", now - 10_000); // burst now
	a.record("b", now - 8_000);
	a.record("b", now - 5_000);
	const r = a.rates("b", now);
	assert.ok(r.rate1m > r.rate5m, "1m rate above the 5m average");
	assert.ok(r.trend > 0, "rising demand ⇒ positive trend (fires computeTarget's +1 slot)");
});

test("trend is non-positive at steady/decaying demand", () => {
	const a = new ArrivalTracker();
	const now = 10 * MIN;
	// only old arrivals → nothing in the last minute → rate1m 0, rate5m > 0 → trend < 0
	a.record("b", now - 4 * MIN);
	a.record("b", now - 3 * MIN);
	const r = a.rates("b", now);
	assert.equal(r.rate1m, 0);
	assert.ok(r.trend <= 0, "decaying demand never adds a speculative slot");
});

test("prunes timestamps older than the long window (bounded memory)", () => {
	const a = new ArrivalTracker();
	a.record("b", 0);
	a.record("b", 1000);
	// far in the future → both originals are now beyond the 5m window
	const r = a.rates("b", 100 * MIN);
	assert.deepEqual(r, { rate1m: 0, rate5m: 0, trend: 0 }, "stale arrivals are pruned, not counted");
});

test("bundles() lists every bundle seen at least once", () => {
	const a = new ArrivalTracker();
	a.record("x", 1);
	a.record("y", 2);
	assert.deepEqual(a.bundles().sort(), ["x", "y"]);
});

test("custom windows are honoured (injectable short/long)", () => {
	const a = new ArrivalTracker({ shortMs: 10_000, longMs: 60_000 });
	const now = 1_000_000;
	a.record("b", now - 5_000); // within the 10s short window
	a.record("b", now - 30_000); // within the 60s long window only
	const r = a.rates("b", now);
	assert.equal(r.rate1m, 1 / (10_000 / MIN), "short-window rate scaled to per-minute");
	assert.equal(r.rate5m, 2 / (60_000 / MIN), "long-window rate scaled to per-minute");
});
