// Harness v2 — named-team loader/validator/runner. Zero Pi/subprocess deps → fully unit-testable.
// A "team" is a declarative recipe: sequential stages, steps within each stage run in parallel.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentBundle, fillTemplate, resolveProject } from "./core.ts";

// Re-exported so existing callers/tests that import it from teams keep working; single-sourced in core.
export { fillTemplate } from "./core.ts";

import { TEAMS_DIR } from "./paths.ts";

export interface TeamStep {
	agent: string;
	prompt: string;
}
export interface Team {
	name: string;
	description?: string;
	stages: TeamStep[][];
	_dir?: string;
}

const DEFAULT_TEAMS_DIR = TEAMS_DIR; // derived from install location, env-overridable (HARNESS_TEAMS_DIR)

// fail-closed: throws if the team is malformed or references an unknown agent.
export function validateTeam(t: Team, registry: Map<string, AgentBundle>): void {
	const err = (m: string) => {
		throw new Error(`team '${t?.name ?? "?"}': ${m}`);
	};
	if (!t.name || !Array.isArray(t.stages) || t.stages.length === 0) err("missing name/stages");
	t.stages.forEach((stage, i) => {
		if (!Array.isArray(stage) || stage.length === 0) err(`stage ${i} must be a non-empty array`);
		for (const s of stage) {
			if (!s || typeof s.agent !== "string" || typeof s.prompt !== "string") err(`stage ${i}: bad step`);
			if (!registry.has(s.agent)) err(`stage ${i}: unknown agent '${s.agent}'`);
			const b = registry.get(s.agent);
			if (b?.may_spawn)
				err(
					`stage ${i}: step agent '${s.agent}' is a delegation agent (may_spawn) — teams orchestrate workers, not other orchestrators`,
				);
		}
	});
}

// Load global + project-local teams (<root>/.summon/teams), validated against the agent registry.
// Reads HARNESS_TEAMS_DIR on each call (not at module load) so tests can override via process.env.
export function loadTeams(registry: Map<string, AgentBundle>, cwd = process.cwd()): Map<string, Team> {
	const { root } = resolveProject(cwd);
	const globalTeams = process.env.HARNESS_TEAMS_DIR ?? DEFAULT_TEAMS_DIR;
	const teams = new Map<string, Team>();
	for (const dir of [globalTeams, join(root, ".summon/teams")]) {
		if (!existsSync(dir)) continue;
		for (const f of readdirSync(dir)) {
			if (!f.endsWith(".json")) continue;
			const t = JSON.parse(readFileSync(join(dir, f), "utf8")) as Team;
			t._dir = dir;
			validateTeam(t, registry); // fail-closed
			teams.set(t.name, t);
		}
	}
	return teams;
}

export interface TeamStepResult {
	agent: string;
	prompt: string;
	result: any;
}

// Generic, injectable team executor (no Pi knowledge → unit-testable).
// Stages run SEQUENTIALLY in order; steps WITHIN a stage run in PARALLEL.
export async function runTeam(
	team: Team,
	vars: Record<string, string>,
	runStep: (agent: string, prompt: string) => Promise<any>,
): Promise<{ team: string; stages: TeamStepResult[][] }> {
	const stages: TeamStepResult[][] = [];
	for (const stage of team.stages) {
		const results = await Promise.all(
			stage.map(async (s) => {
				const prompt = fillTemplate(s.prompt, vars);
				return { agent: s.agent, prompt, result: await runStep(s.agent, prompt) };
			}),
		);
		stages.push(results);
	}
	return { team: team.name, stages };
}
