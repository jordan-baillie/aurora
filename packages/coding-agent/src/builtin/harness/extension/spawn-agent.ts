// Harness v2 — Pi extension: registers `spawn_agent` (one task) and `spawn_agents` (parallel fan-out)
// so an orchestrator pi session can delegate to specialised sub-agents. Project-aware (GLOBAL +
// <project>/.pi/agents, .harness.json protected paths). Wraps src/core.ts (single-sourced).

import { execSync } from "node:child_process";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../../index.ts";
import { Governor, loadRegistries, runWithReview, spawnAgent } from "../src/core.ts";
import { drainAllPools, pickTransport, spawnViaPool } from "../src/pool-transport.ts";
import { loadTeams, runTeam } from "../src/teams.ts";

export default function harness(pi: ExtensionAPI) {
	const { reg: registry, maxWeight, protectedList, root } = loadRegistries(process.cwd()); // fail-closed validation at load
	const gov = new Governor(maxWeight);
	const names = [...registry.keys()].filter((n) => n !== "orchestrator").join(", ");
	const runDir = (ctx: any) => `/tmp/harness-runs/${ctx?.sessionId ?? "session"}`;

	async function runOne(
		agent: string,
		prompt: string,
		task_id: string,
		ctx: any,
		verify?: string,
		transport: string = "oneshot",
	): Promise<any> {
		const b = registry.get(agent);
		if (!b) return { agent, status: "failed", error: `no such agent '${agent}'. have: ${names}` };
		const emit = (e: any) => pi.events?.emit?.("agent-event", { id: task_id, agent, ts: Date.now(), ...e });
		const release = await gov.admit(b);
		emit({ t: "spawned", model: b.model_tier }); // -> the observability dashboard
		try {
			const r =
				transport === "pool"
					? await spawnViaPool(b, prompt, {
							runDir: runDir(ctx),
							taskId: task_id,
							verify,
							protected: protectedList,
							root,
						})
					: await spawnAgent(b, prompt, {
							runDir: runDir(ctx),
							taskId: task_id,
							verify,
							protected: protectedList,
							root,
							onEvent: (ev) => {
								if (ev?.type === "tool_execution_start") emit({ t: "tool", tool: ev.toolName, phase: "start" });
								else if (ev?.type === "tool_execution_end") emit({ t: "tool", phase: "end" });
							},
						});
			emit({ t: "done", status: r.status, verify: r.verify?.passed });
			return r;
		} catch (err) {
			emit({ t: "done", status: "failed" });
			throw err;
		} finally {
			release();
		}
	}
	const fmt = (r: any) =>
		r.error
			? `[${r.agent} → failed] ${r.error}`
			: `[${r.agent} → ${r.status} · contract ${r.contract.passed ? "PASS" : `FAIL:${r.contract.missing.join(",")}`}` +
				`${r.verify ? ` · verify ${r.verify.passed ? "PASS" : "FAIL"}` : ""} · ${r.meta.model} ${r.meta.elapsed_s.toFixed(0)}s]` +
				`${r.verify && !r.verify.passed ? `\nverify output: ${r.verify.output.slice(-300)}` : ""}\n\n${r.artifact_excerpt}`;

	// Build a structured reviewer metaprompt embedding the original task, builder summary, and diff.
	function reviewerPrompt(task: string, summary: string, diff: string): string {
		return [
			'ROLE: You are a code reviewer (the "reviewer" specialist) verifying a builder\'s work.',
			"",
			"TASK: Verify that the git diff below correctly implements the task, introduces no regressions, and meets all acceptance criteria.",
			"",
			"## Original task",
			task,
			"",
			"## Builder change-summary",
			summary,
			"",
			"## Git diff",
			"```diff",
			diff.slice(0, 12000),
			"```",
			"",
			"ACCEPTANCE: End your reply with exactly:",
			"## verdict",
			"APPROVE or REJECT with a one-line reason.",
			"## claims",
			"List each claim you verified.",
			"## could-not-verify",
			"List anything you could not check from the diff alone.",
		].join("\n");
	}

	pi.registerTool({
		name: "spawn_agent",
		label: "Spawn specialised sub-agent",
		description: `Delegate ONE task to a specialised sub-agent; returns its result + output-contract verdict. Agents: ${names}. You write the metaprompt (ROLE/TASK/SCOPE/INPUTS/TOOLS/ACCEPTANCE/TERMINAL/DO-NOT).`,
		parameters: Type.Object({
			agent: Type.String({ description: `one of: ${names}` }),
			prompt: Type.String({ description: "the metaprompt for the sub-agent" }),
			task_id: Type.Optional(Type.String()),
			verify: Type.Optional(
				Type.String({
					description:
						"a shell ACCEPTANCE command the HARNESS runs itself (deterministic; overrides the agent's claim). e.g. 'pytest tests/test_x.py'",
				}),
			),
			review: Type.Optional(
				Type.Boolean({
					description:
						"after a write-capable build completes 'done', auto-run the reviewer over the git diff; result fails unless the reviewer APPROVEs",
				}),
			),
			transport: Type.Optional(
				Type.Union([Type.Literal("oneshot"), Type.Literal("pool")], {
					description:
						"execution transport: 'oneshot' (default, cold pi -p) or 'pool' (warm pi --mode rpc worker, reused across tasks)",
				}),
			),
		}),
		async execute(_id: string, p: any, _s: any, _u: any, ctx: any) {
			const task_id = p.task_id ?? p.agent;
			const transport: string = p.transport ?? "oneshot";
			const bundle = registry.get(p.agent);
			const isWriteCapable = bundle
				? bundle.tools.some((t: string) => ["write", "edit", "bash"].includes(t))
				: false;
			const reviewerBundle = registry.get("reviewer");

			if (p.review && isWriteCapable && reviewerBundle) {
				const outcome = await runWithReview(
					() => runOne(p.agent, p.prompt, task_id, ctx, p.verify, transport),
					async (b) => {
						let diff = "";
						try {
							diff = execSync(`git -C ${JSON.stringify(root)} diff`, {
								encoding: "utf8",
								maxBuffer: 10 * 1024 * 1024,
							});
						} catch {
							diff = "";
						}
						const rp = reviewerPrompt(p.prompt, b.artifact_excerpt, diff);
						return runOne("reviewer", rp, `${task_id}-review`, ctx);
					},
				);
				const verdict = outcome.approved ? "APPROVED" : `REJECTED — ${outcome.reason}`;
				const text =
					fmt(outcome.build) +
					"\n\n=== REVIEW: " +
					verdict +
					" ===\n\n" +
					(outcome.review ? fmt(outcome.review) : "");
				return { content: [{ type: "text", text }], details: outcome, isError: !outcome.approved };
			}

			// Default path — transport threaded; oneshot behaviour byte-for-byte unchanged
			const r = await runOne(p.agent, p.prompt, task_id, ctx, p.verify, transport);
			return { content: [{ type: "text", text: fmt(r) }], details: r, isError: r.status === "failed" };
		},
	});

	pi.registerTool({
		name: "run_team",
		label: "Run a named team (sequential stages, parallel steps)",
		description: `Run a named team recipe — stages run sequentially, steps within a stage run in parallel. Available teams are loaded from global + project-local .pi/teams/ directories.`,
		parameters: Type.Object({
			team: Type.String({ description: 'name of the team to run (e.g. "build-review")' }),
			vars: Type.Optional(
				Type.Record(Type.String(), Type.String(), {
					description: "template variables to fill {{placeholders}} in step prompts",
				}),
			),
		}),
		async execute(_id: string, p: any, _s: any, _u: any, ctx: any) {
			const teams = loadTeams(registry, process.cwd());
			const team = teams.get(p.team);
			if (!team) {
				const available = [...teams.keys()].join(", ") || "(none loaded)";
				return {
					content: [{ type: "text", text: `team '${p.team}' not found. available: ${available}` }],
					isError: true,
					details: undefined,
				};
			}
			try {
				const outcome = await runTeam(team, p.vars ?? {}, (agent, prompt) =>
					runOne(agent, prompt, `${p.team}:${agent}`, ctx),
				);
				const text = outcome.stages
					.map((stage, i) => {
						const stepTexts = stage.map((step) => fmt(step.result)).join("\n\n---\n\n");
						return `=== Stage ${i + 1} ===\n\n${stepTexts}`;
					})
					.join("\n\n");
				return { content: [{ type: "text", text }], details: outcome };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text", text: `run_team failed: ${msg}` }], isError: true, details: undefined };
			}
		},
	});

	pi.registerTool({
		name: "spawn_agents",
		label: "Spawn sub-agents in parallel",
		description: `Run MULTIPLE specialised sub-agents CONCURRENTLY (wide fan-out) — use for independent tasks. Agents: ${names}. Independent tasks run concurrently; same-agent batches of ≥8 auto-use the warm worker pool (≈30-47% faster), else cold one-shot. Override with transport.`,
		parameters: Type.Object({
			tasks: Type.Array(
				Type.Object({
					agent: Type.String(),
					prompt: Type.String(),
					task_id: Type.Optional(Type.String()),
					verify: Type.Optional(Type.String({ description: "shell ACCEPTANCE command the harness runs itself" })),
				}),
				{ description: "independent tasks to run at once" },
			),
			transport: Type.Optional(
				Type.Union([Type.Literal("oneshot"), Type.Literal("pool")], {
					description:
						"force a transport for the whole batch; default is adaptive (pool only for ≥8 same-agent tasks)",
				}),
			),
		}),
		async execute(_id: string, p: any, _s: any, _u: any, ctx: any) {
			const counts = new Map<string, number>();
			for (const t of p.tasks) counts.set(t.agent, (counts.get(t.agent) ?? 0) + 1);
			const results = await Promise.all(
				p.tasks.map((t: any, i: number) =>
					runOne(
						t.agent,
						t.prompt,
						t.task_id ?? `${t.agent}-${i}`,
						ctx,
						t.verify,
						pickTransport(counts.get(t.agent) ?? 0, p.transport),
					),
				),
			);
			return { content: [{ type: "text", text: results.map(fmt).join("\n\n---\n\n") }], details: { results } };
		},
	});

	// Drain warm pools on shutdown so no orphaned pi --mode rpc processes survive the session.
	pi.on?.("session_shutdown", async () => {
		await drainAllPools();
	});
}
