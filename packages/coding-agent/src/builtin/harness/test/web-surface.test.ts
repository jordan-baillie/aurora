// Harness v2 — web-surface pure-part tests (frozen; no socket started) + host-option tests.
// node --experimental-strip-types --test test/web-surface.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyVM, reduce } from "../src/observe.ts";
import { createWebSurface, renderDashboardHtml, snapshot } from "../src/web-surface.ts";

// ── snapshot ──────────────────────────────────────────────────────────────

test("snapshot reflects pushed events", () => {
	const vm = emptyVM();
	reduce(vm, { t: "spawned", id: "x", agent: "scout", model: "haiku", ts: 1 });
	reduce(vm, { t: "done", id: "x", status: "done", verify: true, ts: 2 });
	const s = snapshot(vm);
	assert.equal(s.agents.length, 1);
	assert.equal(s.agents[0].status, "done");
	assert.equal(s.agents[0].agent, "scout");
	assert.equal(s.counts.ok, 1);
});

test("snapshot agents include tool count", () => {
	const vm = emptyVM();
	reduce(vm, { t: "spawned", id: "y", agent: "builder", model: "sonnet", ts: 1 });
	reduce(vm, { t: "tool", id: "y", tool: "read", phase: "start", ts: 2 });
	const s = snapshot(vm);
	assert.equal(s.agents.length, 1);
	assert.ok(s.agents[0].tools >= 1, `expected tools >= 1, got ${s.agents[0].tools}`);
});

test("snapshot counts reflect multiple agents with mixed statuses", () => {
	const vm = emptyVM();
	reduce(vm, { t: "spawned", id: "a", agent: "scout", model: "haiku", ts: 1 });
	reduce(vm, { t: "spawned", id: "b", agent: "builder", model: "sonnet", ts: 1 });
	reduce(vm, { t: "spawned", id: "c", agent: "reviewer", model: "haiku", ts: 1 });
	reduce(vm, { t: "done", id: "a", status: "done", verify: true, ts: 5 });
	reduce(vm, { t: "done", id: "b", status: "verify_failed", verify: false, ts: 5 });
	const s = snapshot(vm);
	assert.equal(s.counts.total, 3);
	assert.equal(s.counts.run, 1);
	assert.equal(s.counts.ok, 1);
	assert.equal(s.counts.bad, 1);
});

test("snapshot agent fields are present and typed", () => {
	const vm = emptyVM();
	reduce(vm, { t: "spawned", id: "z", agent: "reviewer", model: "haiku", ts: 100 });
	reduce(vm, { t: "done", id: "z", status: "done", verify: false, ts: 200 });
	const [a] = snapshot(vm).agents;
	assert.equal(typeof a.id, "string");
	assert.equal(typeof a.agent, "string");
	assert.equal(typeof a.model, "string");
	assert.equal(typeof a.status, "string");
	assert.equal(typeof a.startedAt, "number");
	assert.equal(typeof a.endedAt, "number");
	assert.equal(typeof a.tools, "number");
});

// ── renderDashboardHtml ───────────────────────────────────────────────────

test("renderDashboardHtml is a self-contained page wiring SSE", () => {
	const html = renderDashboardHtml();
	assert.ok(typeof html === "string" && html.length > 0, "must return non-empty string");
	assert.ok(html.includes("EventSource"), "must reference EventSource");
	assert.ok(html.includes("/events"), "must reference /events endpoint");
	assert.ok(html.includes("/state"), "must reference /state endpoint");
});

test("renderDashboardHtml contains valid HTML structure", () => {
	const html = renderDashboardHtml();
	assert.ok(html.includes("<!DOCTYPE html>"), "must start with DOCTYPE");
	assert.ok(html.includes("<table"), "must contain a table element");
	assert.ok(html.includes("fetch("), "must fetch /state for initial render");
});

test("renderDashboardHtml renders the new governor/fleet/shed signals (A5)", () => {
	const html = renderDashboardHtml();
	assert.ok(html.includes('id="signals"'), "has a signals panel for governor/shed/burst");
	assert.ok(html.includes('id="fleet"'), "has a fleet panel for autoscaler decisions");
	assert.ok(html.includes("renderSignals"), "wires the governor/shed/burst renderer");
	assert.ok(html.includes("renderFleet"), "wires the autoscaler-decisions renderer");
});

// ── snapshot: new signal fields (A5) ───────────────────────────────────────────

test("snapshot exposes governor/autoscale/shed/burst (null until surfaced)", () => {
	const vm = emptyVM();
	const s0 = snapshot(vm);
	assert.equal(s0.shed, null, "shed null before any shedding");
	assert.equal(s0.burst, null, "burst null before any spawn");
	assert.equal(s0.governor, null);
	assert.equal(s0.autoscale, null);
});

test("snapshot carries shed + burst + governor once events surface them (A1/A5)", () => {
	const vm = emptyVM();
	reduce(vm, { t: "spawned", id: "a", agent: "b", model: "sonnet", window_pct: 92, load_pct: 99, ts: 1 });
	reduce(vm, { t: "shedding", id: "a", from: "frontier", to: "standard", window_pct: 92 });
	reduce(vm, { t: "autoscale", id: "fleet", ticks: [{ bundle: "b", current: 0, target: 2, action: "grow" }] });
	const s = snapshot(vm);
	assert.equal(s.burst?.count, 1);
	assert.equal(s.shed?.count, 1);
	assert.equal(s.shed?.from, "frontier");
	assert.equal(s.shed?.to, "standard");
	assert.equal(s.governor?.windowPct, 92);
	assert.equal(s.autoscale?.length, 1);
});

// ── createWebSurface — host option ────────────────────────────────────────

test("createWebSurface honours host", async () => {
	const s = await createWebSurface({ host: "127.0.0.1", port: 0 });
	assert.equal(s.host, "127.0.0.1");
	assert.ok(s.url.startsWith("http://127.0.0.1:"), `unexpected url: ${s.url}`);
	await s.close();
});

test("createWebSurface defaults host to loopback", async () => {
	const s = await createWebSurface({});
	assert.equal(s.host, "127.0.0.1");
	await s.close();
});

// ── auth ──────────────────────────────────────────────────────────────────

test("auth: 401 without token, 200 with Bearer and ?token=", async () => {
	const s = await createWebSurface({ token: "T", port: 0 });
	try {
		// No credentials → 401
		const noAuth = await fetch(`${s.url}/state`);
		assert.equal(noAuth.status, 401, "unauthenticated request must return 401");

		// Bearer header → 200 with valid shape
		const withBearer = await fetch(`${s.url}/state`, {
			headers: { authorization: "Bearer T" },
		});
		assert.equal(withBearer.status, 200, "Bearer auth must return 200");
		const json = (await withBearer.json()) as any;
		assert.ok(json.counts !== undefined, "response must include counts");

		// Query param → 200
		const withQuery = await fetch(`${s.url}/state?token=T`);
		assert.equal(withQuery.status, 200, "?token= auth must return 200");
	} finally {
		await s.close();
	}
});

// ── ingest ────────────────────────────────────────────────────────────────

test("ingest: posting an event updates /state", async () => {
	const s = await createWebSurface({ token: "T", port: 0 });
	try {
		const ingestRes = await fetch(`${s.url}/ingest`, {
			method: "POST",
			headers: { authorization: "Bearer T", "content-type": "application/json" },
			body: JSON.stringify({ t: "spawned", id: "z", agent: "scout", model: "haiku", ts: 1 }),
		});
		assert.equal(ingestRes.status, 204, "ingest must return 204");

		const stateRes = await fetch(`${s.url}/state`, {
			headers: { authorization: "Bearer T" },
		});
		assert.equal(stateRes.status, 200);
		const json = (await stateRes.json()) as any;
		assert.ok(
			json.agents.some((a: any) => a.id === "z"),
			`agents should contain id "z"; got ${JSON.stringify(json.agents.map((a: any) => a.id))}`,
		);
	} finally {
		await s.close();
	}
});

test("ingest: array of events ingested in one POST", async () => {
	const s = await createWebSurface({ token: "T", port: 0 });
	try {
		const ingestRes = await fetch(`${s.url}/ingest`, {
			method: "POST",
			headers: { authorization: "Bearer T", "content-type": "application/json" },
			body: JSON.stringify([
				{ t: "spawned", id: "p1", agent: "scout", model: "haiku", ts: 1 },
				{ t: "spawned", id: "p2", agent: "builder", model: "sonnet", ts: 2 },
			]),
		});
		assert.equal(ingestRes.status, 204);

		const json = (await (
			await fetch(`${s.url}/state`, {
				headers: { authorization: "Bearer T" },
			})
		).json()) as any;
		const ids = json.agents.map((a: any) => a.id).sort();
		assert.deepEqual(ids, ["p1", "p2"]);
	} finally {
		await s.close();
	}
});

test("ingest: bad JSON returns 400", async () => {
	const s = await createWebSurface({ token: "T", port: 0 });
	try {
		const res = await fetch(`${s.url}/ingest`, {
			method: "POST",
			headers: { authorization: "Bearer T", "content-type": "application/json" },
			body: "not-json{{{",
		});
		assert.equal(res.status, 400);
	} finally {
		await s.close();
	}
});

test("ingest: unauthenticated POST returns 401", async () => {
	const s = await createWebSurface({ token: "T", port: 0 });
	try {
		const res = await fetch(`${s.url}/ingest`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ t: "spawned", id: "x", agent: "scout", model: "haiku", ts: 1 }),
		});
		assert.equal(res.status, 401);
	} finally {
		await s.close();
	}
});

// ── back-compat: no token → open ─────────────────────────────────────────

test("no token → open (back-compat)", async () => {
	const s = await createWebSurface({ port: 0 });
	try {
		const res = await fetch(`${s.url}/state`);
		assert.equal(res.status, 200, "unauthenticated /state must return 200 when no token is configured");
	} finally {
		await s.close();
	}
});
