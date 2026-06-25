// Offline unit tests for the orchestration mode/doctrine module. Run:
//   node --experimental-strip-types --test test/orchestration.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildOrchestrationDoctrine,
	type DoctrineContext,
	formatGovernorHint,
	orchestrationLabel,
	resolveOrchestrationMode,
	reviewersForMode,
} from "../src/orchestration.ts";

const ctx: DoctrineContext = {
	registryDigest: "scout[fast; tools:read; ->## findings] · builder[standard; tools:edit; ->## change-summary]",
	teams: "build-review — build then review",
	blueprints: "scout-build-verify — recon, build, verify",
	reviewers: 3,
};

// ── resolveOrchestrationMode ────────────────────────────────────────────────
test("resolveOrchestrationMode: undefined defaults to auto (the shipped default)", () => {
	assert.equal(resolveOrchestrationMode(undefined), "auto");
});

test("resolveOrchestrationMode: explicit values", () => {
	assert.equal(resolveOrchestrationMode("off"), "off");
	assert.equal(resolveOrchestrationMode("auto"), "auto");
	assert.equal(resolveOrchestrationMode("ultra"), "ultra");
});

test("resolveOrchestrationMode: aliases + case-insensitive + whitespace", () => {
	assert.equal(resolveOrchestrationMode(" OFF "), "off");
	assert.equal(resolveOrchestrationMode("None"), "off");
	assert.equal(resolveOrchestrationMode("0"), "off");
	assert.equal(resolveOrchestrationMode("MAX"), "ultra");
	assert.equal(resolveOrchestrationMode("on"), "auto");
});

test("resolveOrchestrationMode: empty + garbage fall back to auto (fail-safe, never off)", () => {
	assert.equal(resolveOrchestrationMode(""), "auto");
	assert.equal(resolveOrchestrationMode("banana"), "auto");
});

// ── reviewersForMode ─────────────────────────────────────────────────────────
test("reviewersForMode: odd defaults so 'majority' is meaningful; ultra fans widest", () => {
	assert.equal(reviewersForMode("ultra"), 5);
	assert.equal(reviewersForMode("auto"), 3);
	assert.equal(reviewersForMode("off"), 3);
	for (const m of ["off", "auto", "ultra"] as const)
		assert.equal(reviewersForMode(m) % 2, 1, `${m} default must be odd for a real majority`);
});

test("orchestrationLabel: returns the mode string", () => {
	assert.equal(orchestrationLabel("ultra"), "ultra");
});

// ── buildOrchestrationDoctrine ────────────────────────────────────────────────
test("buildOrchestrationDoctrine: off → empty (base prompt untouched)", () => {
	assert.equal(buildOrchestrationDoctrine("off", ctx), "");
});

test("buildOrchestrationDoctrine: auto embeds roster, recipes, and the delegate-by-default policy", () => {
	const d = buildOrchestrationDoctrine("auto", ctx);
	assert.ok(d.includes("Orchestration mode: AUTO"));
	assert.ok(d.includes(ctx.registryDigest), "must inject the live specialist roster");
	assert.ok(d.includes(ctx.teams), "must inject the team catalog");
	assert.ok(d.includes(ctx.blueprints), "must inject the blueprint catalog");
	assert.ok(d.includes("spawn_agents"), "must name the wide fan-out tool");
	assert.ok(d.includes("reviewers: 3"), "must advertise the multi-reviewer default");
});

test("buildOrchestrationDoctrine: points open-ended goals at the orchestrate run-primitive (not a dry-run tool)", () => {
	for (const mode of ["auto", "ultra"] as const) {
		const d = buildOrchestrationDoctrine(mode, ctx);
		assert.ok(d.includes("orchestrate({ goal })"), `${mode}: must steer open-ended goals to orchestrate`);
		assert.ok(!d.includes("HARNESS_PLAN_RUN"), `${mode}: must not reference the dry-run gate`);
	}
});

test("buildOrchestrationDoctrine: ultra is a strictly stronger standing opt-in than auto", () => {
	const ultra = buildOrchestrationDoctrine("ultra", ctx);
	assert.ok(ultra.includes("ULTRA"));
	assert.ok(/EVERY substantial task/i.test(ultra), "ultra is the standing opt-in");
	assert.ok(ultra.includes("token cost"), "ultra de-emphasises token cost");
});

test("buildOrchestrationDoctrine: always pushes multi-reviewer adversarial verification", () => {
	for (const mode of ["auto", "ultra"] as const) {
		const d = buildOrchestrationDoctrine(mode, ctx);
		assert.ok(/never just one reviewer/i.test(d), `${mode}: must warn against a single reviewer`);
		assert.ok(d.includes("verify"), `${mode}: must mention deterministic verify`);
	}
});

// ── formatGovernorHint (model-facing back-pressure, gated on a configured window budget) ──
test("formatGovernorHint: silent with headroom — never deters fan-out in the default (no-budget) config", () => {
	// windowPct is 0 whenever no hard token budget is configured (the default), so the hint must be empty.
	assert.equal(formatGovernorHint(0, 0), "");
	assert.equal(formatGovernorHint(0, 5), "", "even with a queue, no budget configured ⇒ no hint");
	assert.equal(formatGovernorHint(74, 0), "");
});

test("formatGovernorHint: warns as the configured window fills, escalating at budget", () => {
	const warn = formatGovernorHint(80, 0);
	assert.ok(warn.includes("80%") && /approaching budget/i.test(warn));
	const atBudget = formatGovernorHint(95, 2);
	assert.ok(atBudget.includes("95%") && /at budget/i.test(atBudget));
	assert.ok(atBudget.includes("2 queued"), "surfaces queue depth when present");
});
