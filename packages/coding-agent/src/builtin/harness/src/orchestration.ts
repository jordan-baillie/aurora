// Orchestration mode: a tiny, pure, self-contained module that resolves an "orchestration intensity"
// (off/auto/ultra) and renders the delegate-by-default DOCTRINE injected into the MAIN interactive
// session's system prompt. No harness/pi imports so it runs standalone under node strip-types and is
// unit-testable offline. This is the motivation layer the harness was missing: the spawn_* tools are
// already wired and active on the main agent, but nothing told the resident model WHEN/WHY to fan out.

export type OrchestrationMode = "off" | "auto" | "ultra";

// Parse SUMMON_ORCHESTRATION-style input. undefined/""/garbage -> "auto" (the shipped default: the
// resident agent delegates substantial work but stays solo for trivial edits). Case-insensitive.
export function resolveOrchestrationMode(raw?: string): OrchestrationMode {
	if (raw === undefined) return "auto";
	const s = raw.trim().toLowerCase();
	if (s === "off" || s === "none" || s === "0") return "off";
	if (s === "ultra" || s === "max") return "ultra";
	if (s === "" || s === "auto" || s === "on") return "auto";
	return "auto";
}

export function orchestrationLabel(mode: OrchestrationMode): string {
	return mode;
}

// Model-facing governor back-pressure. The live dashboard shows load to the HUMAN only; the model never
// saw it, so it couldn't self-regulate fan-out width. This is gated on `windowPct`, which is 0 whenever no
// hard token budget is configured (HARNESS_WINDOW_TOKENS unset — the default) — so it returns "" and NEVER
// discourages the wide fan-out we want. It speaks up only when a real budget exists AND the rolling window
// is genuinely hot. Appended to spawn tool results so the resident agent can narrow the next wave.
export function formatGovernorHint(windowPct: number, queueDepth: number): string {
	const queued = queueDepth > 0 ? `, ${queueDepth} queued` : "";
	if (windowPct >= 90)
		return `[governor: token window ${windowPct}% full${queued} — at budget; pause or narrow fan-out and prefer cheaper-tier agents]`;
	if (windowPct >= 75)
		return `[governor: token window ${windowPct}% full${queued} — approaching budget; keep further fan-out tight]`;
	return "";
}

// Default number of independent reviewers for a multi-reviewer verification pass. ODD counts so the
// strict-majority verdict (aggregateReviews) is actually a majority and not unanimity: 3 covers the
// full diverse-lens set (correctness/regressions/tests) and tolerates one dissent; ultra fans widest
// (5, lenses cycle) since cost is not its constraint. Callers may always override per spawn.
export function reviewersForMode(mode: OrchestrationMode): number {
	return mode === "ultra" ? 5 : 3;
}

export interface DoctrineContext {
	/** Compact specialist roster: name[tier; tools; ->contract] · … (the live registry digest). */
	registryDigest: string;
	/** Saved team recipes digest, or "(none loaded)". */
	teams: string;
	/** Saved blueprint recipes digest, or "(none loaded)". */
	blueprints: string;
	/** Default reviewer count to advertise for the adversarial-verify step. */
	reviewers: number;
}

// The doctrine appended to the main session's system prompt every turn while mode != off. It teaches
// the resident agent (which, unlike the pure orchestrator, ALSO holds write/bash) when to delegate,
// to prefer wide fan-out over sequential self-work, and to verify with MULTIPLE independent reviewers
// instead of one. Returns "" for off so the base prompt is left untouched.
export function buildOrchestrationDoctrine(mode: OrchestrationMode, ctx: DoctrineContext): string {
	if (mode === "off") return "";

	const header =
		mode === "ultra"
			? [
					"# Orchestration mode: ULTRA (standing opt-in)",
					"",
					"For EVERY substantial task this session, default to decomposing the goal and fanning the work",
					"out to specialised sub-agents, then adversarially verifying the result with multiple independent",
					"reviewers BEFORE you present it. Optimise for the most correct, exhaustive result — token cost is",
					"NOT the constraint. Work solo only on trivial or conversational turns.",
				].join("\n")
			: [
					"# Orchestration mode: AUTO",
					"",
					"When a task is substantial, multi-part, parallelisable, or open-ended, DELEGATE and fan the work",
					"out to sub-agents rather than doing it all yourself in one long sequential thread. Keep trivial,",
					"single-step, or conversational work inline.",
					"Calibrate on the break-even: delegate when the work splits into independent units OR clearly",
					"exceeds a single focused pass. If you'd finish it faster than writing the metaprompts, do it inline.",
				].join("\n");

	return [
		header,
		"",
		"You are not just a single coding agent — you are the conductor of a fleet of specialised,",
		"tool-restricted, model-tiered sub-agents. These delegation tools are LIVE and ready right now:",
		"spawn_agents, spawn_agent, spawn_quorum, run_team, run_blueprint, plan_and_run.",
		"",
		`Specialists (name[tier; tools; ->contract]): ${ctx.registryDigest}`,
		`Saved teams: ${ctx.teams}`,
		`Saved blueprints: ${ctx.blueprints}`,
		"",
		"## When to delegate",
		"- Multi-part or independent work -> fan out WIDE with spawn_agents (N specialists in ONE call),",
		"  not one agent doing N steps in sequence. Independent units are your parallelism — exploit it.",
		"- A scoped, single objective a specialist fits -> spawn_agent with a tight metaprompt",
		"  (ROLE/TASK/SCOPE/INPUTS/TOOLS/ACCEPTANCE/TERMINAL/DO-NOT) and a deterministic `verify` command.",
		"- An open-ended goal you cannot pre-decompose -> orchestrate({ goal }): it plans a DAG, runs the",
		"  agent work in parallel, and verifies — deterministic shell steps pause for your approval.",
		"  (orchestrate({ goal, dry_run: true }) previews the plan without running it.)",
		"- A known recurring shape -> run_team / run_blueprint (see saved recipes above).",
		"- Trivial, conversational, or work smaller than the prompt to delegate it -> just do it yourself.",
		"",
		"## Verify adversarially — never just one reviewer",
		"For any substantial change, do NOT trust a single pass. Verify with MULTIPLE independent reviewers",
		"from DIFFERENT lenses (correctness, regressions/safety, tests & edge-cases): pass `review: true`",
		`with \`reviewers: ${ctx.reviewers}\` on spawn_agent (majority verdict, fail-closed), or spawn_quorum`,
		"for high-stakes best-of-N. Always prefer a deterministic `verify` shell check — the harness runs it",
		'itself and never trusts an agent\'s claim that "tests pass".',
		"",
		"## Discipline",
		"- Prefer WIDE (many small parallel tasks) over DEEP (one agent, many steps).",
		"- Give each sub-agent only its SCOPE + INPUTS, never your whole context.",
		"- Bound retries; escalate to the human rather than looping forever.",
		"- Synthesise the sub-agents' artifacts into your own answer; don't just relay them.",
	].join("\n");
}
