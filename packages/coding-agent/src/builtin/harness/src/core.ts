// Harness v2 — core (registry · validator · contract · spawn). No pi/typebox deps so it runs
// standalone under `node --experimental-strip-types`. The Pi extension wraps this; single-sourced.

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { AGENT_BIN, AGENTS_DIR as GLOBAL_AGENTS } from "./paths.ts"; // derived from install location, env-overridable

export interface OutputContract {
	required_sections: string[];
	forbidden?: string[];
	max_tokens?: number;
}
export interface AgentBundle {
	name: string;
	role: string;
	model_tier: "fast" | "standard" | "frontier";
	tools: string[];
	skills?: string[];
	context_globs?: string[];
	output_contract: OutputContract;
	max_attempts?: number;
	timeout_s?: number;
	may_spawn?: boolean;
	_dir?: string;
}

export const MODEL: Record<AgentBundle["model_tier"], string> = {
	fast: "claude-haiku-4-5",
	standard: "claude-sonnet-4-6",
	frontier: "claude-opus-4-8",
};
export const SYS_HEADER = "You are Claude Code, Anthropic's official CLI for Claude."; // $0-OAuth routing
const WRITE_TOOLS = new Set(["edit", "write", "bash"]);
export const DELEGATION_TOOLS = new Set(["spawn_agent", "spawn_agents", "run_team"]);
// Generic, project-AGNOSTIC defaults. Per-project additions come from `.harness.json` { protected: [...] }.
export const DEFAULT_PROTECTED = [".env", "/.git/", "secrets", "credentials", ".pem", ".key", "id_rsa", "id_ed25519"];

export interface HarnessConfig {
	protected?: string[];
	agents_dir?: string;
	max_weight?: number;
}

// Find the project root (nearest ancestor with .harness.json or .git) + its config.
export function resolveProject(cwd: string): { root: string; cfg: HarnessConfig } {
	let dir = resolve(cwd);
	for (;;) {
		const cfgPath = join(dir, ".harness.json");
		if (existsSync(cfgPath)) {
			try {
				return { root: dir, cfg: JSON.parse(readFileSync(cfgPath, "utf8")) };
			} catch {
				/* ignore */
			}
		}
		if (existsSync(join(dir, ".git"))) return { root: dir, cfg: {} };
		const parent = dirname(dir);
		if (parent === dir) return { root: resolve(cwd), cfg: {} };
		dir = parent;
	}
}

// Effective registry for a project = GLOBAL specialists + project-local overrides, validated against
// DEFAULT_PROTECTED + the project's own protected paths.
export function loadRegistries(cwd = process.cwd()): {
	reg: Map<string, AgentBundle>;
	protectedList: string[];
	root: string;
	maxWeight: number;
} {
	const { root, cfg } = resolveProject(cwd);
	const protectedList = [...DEFAULT_PROTECTED, ...(cfg.protected ?? [])];
	const reg = new Map<string, AgentBundle>();
	const localDir = join(root, cfg.agents_dir ?? ".pi/agents");
	for (const d of [GLOBAL_AGENTS, localDir]) {
		// local overrides global by name
		if (!existsSync(d)) continue;
		for (const [name, b] of loadRegistry(d, protectedList)) reg.set(name, b);
	}
	return { reg, protectedList, root, maxWeight: cfg.max_weight ?? 8 };
}

// ── registry ────────────────────────────────────────────────────────────────
export function loadRegistry(dir: string, protectedList: string[] = DEFAULT_PROTECTED): Map<string, AgentBundle> {
	const reg = new Map<string, AgentBundle>();
	for (const name of readdirSync(dir)) {
		const f = join(dir, name, "agent.json");
		if (!existsSync(f)) continue;
		const b = JSON.parse(readFileSync(f, "utf8")) as AgentBundle;
		b._dir = join(dir, name);
		validateBundle(b, protectedList); // fail-closed: throws => bundle does not load
		reg.set(b.name, b);
	}
	return reg;
}

// ── validator (the sentinel-style guard) ─────────────────────────────────────
export function validateBundle(b: AgentBundle, protectedList: string[] = DEFAULT_PROTECTED): void {
	const err = (m: string) => {
		throw new Error(`agent '${b.name ?? "?"}': ${m}`);
	};
	if (!b.name || !b.role || !b.model_tier || !Array.isArray(b.tools)) err("missing required fields");
	if (!(b.model_tier in MODEL)) err(`bad model_tier '${b.model_tier}'`);
	if (b.may_spawn && b.tools.some((t) => WRITE_TOOLS.has(t)))
		err("orchestrator (may_spawn) must NOT have write/edit/bash — it delegates, never executes");
	if (!b.may_spawn && b.tools.some((t) => DELEGATION_TOOLS.has(t)))
		err("only the orchestrator (may_spawn) bundle may have delegation tools (spawn_agent/spawn_agents/run_team)");
	if (
		b.tools.some((t) => WRITE_TOOLS.has(t)) &&
		(b.context_globs ?? []).some((g) => protectedList.some((p) => g.includes(p)))
	)
		err("write-capable bundle may not scope into a protected path");
	if (!b.output_contract?.required_sections?.length) err("output_contract.required_sections required");
}

// ── registry view (single-sourced projection for CLI display + JSON output) ────
export interface RegistryRow {
	name: string;
	model_tier: string;
	tools: string[];
	contract_sections: string[];
	may_spawn: boolean;
}
export function registryView(reg: Map<string, AgentBundle>): RegistryRow[] {
	return [...reg.values()]
		.map((b) => ({
			name: b.name,
			model_tier: b.model_tier,
			tools: b.tools,
			contract_sections: b.output_contract.required_sections,
			may_spawn: b.may_spawn ?? false,
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
}

// ── output contract (L3 / agent-native verification) ─────────────────────────
export function checkContract(text: string, c: OutputContract): { passed: boolean; missing: string[] } {
	const missing = c.required_sections.filter((s) => !text.includes(s));
	const forbidden = (c.forbidden ?? []).filter((f) => text.includes(f)).map((f) => `forbidden:${f}`);
	return { passed: missing.length === 0 && forbidden.length === 0, missing: [...missing, ...forbidden] };
}

// ── Phase 4 hardening primitives (pure + testable) ────────────────────────
const DESTRUCTIVE: RegExp[] = [
	/\brm\s+-[a-z]*[rf]/i,
	/\brm\s+(?:-\S+\s+)*['"]?\//,
	/\brmdir\b/i,
	/\bmkfs\b/i,
	/\bdd\s+if=/i,
	/:\(\)\s*\{.*\|/,
	/\bshutdown\b/i,
	/\breboot\b/i,
	/\bchmod\s+-R\b/i,
	/\bchown\s+-R\b/i,
	/>\s*\/(?:etc|sys|bin|usr|boot)\b/, // clobbering system dirs — dangerous
	/>\s*\/dev\/(?!null\b|zero\b|stdout\b|stderr\b|tty\b|random\b|urandom\b|fd\/)\S/, // /dev/<real device> — dangerous; safe pseudo-devices excluded
	/\btruncate\s+-/i,
	/\bgit\s+(?:push\b|reset\s+--hard|clean\s+-\S*f)/i,
];
export function isDestructiveCmd(cmd: string): boolean {
	return DESTRUCTIVE.some((re) => re.test(cmd));
}
export function hitsProtected(s: string, protectedList: string[]): boolean {
	return protectedList.some((p) => p && s.includes(p));
}
export function escapesRoot(target: string, root: string): boolean {
	const r = resolve(root);
	const abs = resolve(r, target);
	return abs !== r && !abs.startsWith(`${r}/`); // sibling-prefix safe (/work/repo vs /work/repo-x)
}
// Resolve to the built .js in a dist install, else the .ts source in dev (node --experimental-strip-types).
const _guardBase = join(import.meta.dirname, "..", "extension", "guard");
export const GUARD_EXT = existsSync(`${_guardBase}.js`) ? `${_guardBase}.js` : `${_guardBase}.ts`;

// ── window governor (weighted; queues on the Claude-Max window) ───────────────
const WEIGHT = { fast: 1, standard: 2, frontier: 4 } as const;
export class Governor {
	private inUse = 0;
	private maxWeight: number;
	constructor(maxWeight = 8) {
		this.maxWeight = maxWeight;
	}
	async admit(b: AgentBundle): Promise<() => void> {
		const w = WEIGHT[b.model_tier];
		while (this.inUse + w > this.maxWeight) await new Promise((r) => setTimeout(r, 200));
		this.inUse += w;
		return () => {
			this.inUse -= w;
		};
	}
	loadPct(): number {
		return Math.round((this.inUse / this.maxWeight) * 100);
	}
}

export interface SpawnResult {
	agent: string;
	status: "done" | "failed" | "timeout" | "contract_violation" | "verify_failed";
	artifact_path?: string;
	artifact_excerpt: string;
	contract: { passed: boolean; missing: string[] };
	verify?: { cmd: string; passed: boolean; output: string };
	meta: { model: string; elapsed_s: number; bytes: number };
}

// ── retry combinator (pure + injectable — no subprocess knowledge) ─────────────
export async function withRetry(
	maxAttempts: number,
	run: (attempt: number, prev?: SpawnResult) => Promise<SpawnResult>,
): Promise<SpawnResult> {
	let last: SpawnResult | undefined;
	const n = Math.max(1, Math.floor(maxAttempts || 1));
	for (let a = 1; a <= n; a++) {
		last = await run(a, last);
		if (last.status === "done") return last; // success → stop early
	}
	return last!; // attempts exhausted → escalate last result
}

// ── feedback helper: shift retry context into the next attempt's prompt ───────
export function retryPrompt(prompt: string, prev?: SpawnResult): string {
	if (!prev) return prompt;
	const why =
		prev.status === "verify_failed"
			? `verify failed:\n${prev.verify?.output ?? ""}`
			: prev.status === "contract_violation"
				? `missing required sections: ${prev.contract.missing.join(", ")}`
				: `previous attempt ${prev.status}`;
	return `${prompt}\n\n## RETRY — your previous attempt did not pass\n${why}\nFix this and try again.`;
}

// ── expertise loader (reads context_globs into a bounded system-prompt appendix) ──
// Resolve a bundle's context_globs (relative to _dir), read the matched files, and return a
// bounded "## Expertise context" block to append to the system prompt. "" if nothing to add.
export function loadExpertise(bundle: AgentBundle, maxBytes = 8000): string {
	if (!bundle.context_globs?.length || !bundle._dir) return "";
	const files: string[] = [];
	for (const g of bundle.context_globs) {
		const star = g.indexOf("*");
		if (star === -1) {
			const p = join(bundle._dir, g);
			if (existsSync(p)) files.push(p);
		} else {
			// single-level "dir/*.md" style glob — expand via readdir on the glob's directory
			const slash = g.lastIndexOf("/");
			const dir = slash === -1 ? bundle._dir : join(bundle._dir, g.slice(0, slash));
			const pat = slash === -1 ? g : g.slice(slash + 1);
			if (!existsSync(dir)) continue;
			const re = new RegExp(`^${pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
			for (const name of readdirSync(dir)) if (re.test(name)) files.push(join(dir, name));
		}
	}
	if (!files.length) return "";
	const seen = new Set<string>();
	let out = "## Expertise context\n";
	for (const f of files.sort()) {
		if (seen.has(f)) continue;
		seen.add(f);
		let body: string;
		try {
			body = readFileSync(f, "utf8");
		} catch {
			continue;
		}
		out += `\n### ${f}\n${body}\n`;
		if (out.length >= maxBytes) {
			out = `${out.slice(0, maxBytes)}\n\u2026[expertise truncated]`;
			break;
		}
	}
	return out;
}

// Single source for a worker's system prompt: routing header + role + output-contract instruction + expertise.
export function buildSystemPrompt(bundle: AgentBundle): string {
	const sys = [
		SYS_HEADER,
		bundle.role,
		`End your reply with exactly these markdown sections: ${bundle.output_contract.required_sections.join(", ")}.`,
	].join("\n\n");
	const expertise = loadExpertise(bundle);
	return expertise ? `${sys}\n\n${expertise}` : sys;
}

// Build the SpawnResult from a worker's final text + exit code: contract check · deterministic verify
// (the harness re-runs the acceptance command itself; a failing check overrides 'done') · artifact write.
export function finalizeResult(
	bundle: AgentBundle,
	text: string,
	code: number | null,
	opts: { runDir?: string; taskId?: string; verify?: string; root?: string },
	t0: number,
	model: string,
): SpawnResult {
	const contract = checkContract(text, bundle.output_contract);
	let status: SpawnResult["status"] =
		code === 0 ? (contract.passed ? "done" : "contract_violation") : code === null ? "timeout" : "failed";
	// DETERMINISTIC verification: the harness RUNS the acceptance check itself — it never trusts the
	// agent's claim that "tests pass". A failing verify overrides a "done".
	let verify: SpawnResult["verify"];
	if (opts.verify && status === "done") {
		if (isDestructiveCmd(opts.verify)) {
			verify = { cmd: opts.verify, passed: false, output: "blocked: destructive verify command" };
			status = "verify_failed";
		} else {
			const v = spawnSync("bash", ["-c", opts.verify], {
				cwd: opts.root ?? process.cwd(),
				encoding: "utf8",
				timeout: 180000,
			});
			const passed = v.status === 0;
			verify = { cmd: opts.verify, passed, output: ((v.stdout ?? "") + (v.stderr ?? "")).slice(-1200) };
			if (!passed) status = "verify_failed";
		}
	}
	let artifact_path: string | undefined;
	if (opts.runDir) {
		mkdirSync(opts.runDir, { recursive: true });
		artifact_path = join(opts.runDir, `${opts.taskId ?? bundle.name}.md`);
		writeFileSync(artifact_path, text);
		appendFileSync(
			join(opts.runDir, "ledger.jsonl"),
			JSON.stringify({ ts: Date.now(), task: opts.taskId, agent: bundle.name, status, verify: verify?.passed }) +
				"\n",
		);
	}
	return {
		agent: bundle.name,
		status,
		artifact_path,
		artifact_excerpt: text.slice(0, 1500),
		contract,
		verify,
		meta: { model, elapsed_s: (Date.now() - t0) / 1000, bytes: text.length },
	};
}

// ── spawn one worker via `pi -p --mode json` (the proven transport) ───────────
export function spawnOnce(
	bundle: AgentBundle,
	prompt: string,
	opts: {
		runDir?: string;
		taskId?: string;
		onEvent?: (ev: any) => void;
		verify?: string;
		protected?: string[];
		root?: string;
	} = {},
): Promise<SpawnResult> {
	const model = MODEL[bundle.model_tier];
	const sys = buildSystemPrompt(bundle);
	const args = [
		"-p",
		"--no-session",
		"--mode",
		"json",
		"--model",
		model,
		"--system-prompt",
		sys,
		"--tools",
		bundle.tools.join(","),
	];
	if (bundle.skills?.length && bundle._dir) {
		const sk = join(bundle._dir, "SKILL.md");
		if (existsSync(sk)) args.push("--skill", sk);
	}
	// Hardening: load the guard into any worker that can write/exec (blocks destructive bash +
	// out-of-root / protected-path writes at the tool layer — enforcement, not prompt convention).
	if (bundle.tools.some((t) => t === "bash" || t === "write" || t === "edit")) args.push("-e", GUARD_EXT);
	const env = { ...process.env };
	delete (env as any).ANTHROPIC_API_KEY; // force $0 OAuth
	env.HARNESS_ROOT = opts.root ?? process.cwd();
	env.HARNESS_PROTECTED = (opts.protected ?? DEFAULT_PROTECTED).join(":");
	const t0 = Date.now();
	return new Promise((resolve) => {
		const child = spawn(AGENT_BIN, args, { env });
		let text = "",
			buf = "";
		const killer = setTimeout(() => child.kill("SIGKILL"), (bundle.timeout_s ?? 600) * 1000);
		child.stdin.write(prompt);
		child.stdin.end();
		child.stdout.on("data", (d) => {
			buf += d.toString();
			let nl: number = buf.indexOf("\n");
			while (nl >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				nl = buf.indexOf("\n");
				if (!line.trim()) continue;
				let ev: any;
				try {
					ev = JSON.parse(line);
				} catch {
					continue;
				}
				opts.onEvent?.(ev);
				// the final answer = the LAST assistant message's text content (thinking excluded)
				if (ev.type === "message_end" && ev.message?.role === "assistant" && Array.isArray(ev.message.content)) {
					const t = ev.message.content
						.filter((c: any) => c?.type === "text")
						.map((c: any) => c.text)
						.join("");
					if (t) text = t;
				}
			}
		});
		child.on("close", (code) => {
			clearTimeout(killer);
			resolve(finalizeResult(bundle, text, code, opts, t0, model));
		});
	});
}

// ── builder→reviewer auto-pairing (pure + testable) ─────────────────────────────────
export function parseVerdict(text: string): "APPROVE" | "REJECT" | "UNKNOWN" {
	const m = text.match(/##\s*verdict\b([\s\S]*?)(?:\n##\s|$)/i);
	const section = m ? m[1] : text;
	if (/\bREJECT\b/.test(section)) return "REJECT"; // fail-closed: REJECT wins if both present
	if (/\bAPPROVE\b/.test(section)) return "APPROVE";
	return "UNKNOWN";
}

export function reviewDecision(
	buildStatus: SpawnResult["status"],
	reviewText?: string,
): { approved: boolean; reason: string } {
	if (buildStatus !== "done") return { approved: false, reason: `build ${buildStatus} — not reviewed` };
	if (reviewText == null) return { approved: false, reason: "no reviewer output" };
	const v = parseVerdict(reviewText);
	if (v === "APPROVE") return { approved: true, reason: "reviewer APPROVE" };
	if (v === "REJECT") return { approved: false, reason: "reviewer REJECT" };
	return { approved: false, reason: "reviewer verdict unparseable (fail-closed)" };
}

export interface ReviewOutcome {
	build: SpawnResult;
	review?: SpawnResult;
	approved: boolean;
	reason: string;
}

// Generic, injectable build→review orchestration (no Pi/subprocess knowledge → unit-testable).
export async function runWithReview(
	build: () => Promise<SpawnResult>,
	review: (b: SpawnResult) => Promise<SpawnResult>,
	opts: { enabled?: boolean } = {},
): Promise<ReviewOutcome> {
	const b = await build();
	if (opts.enabled === false) return { build: b, approved: b.status === "done", reason: "review disabled" };
	if (b.status !== "done") return { build: b, approved: false, reason: `build ${b.status} — not reviewed` };
	const r = await review(b);
	const d = reviewDecision(b.status, r.artifact_excerpt);
	return { build: b, review: r, approved: d.approved, reason: d.reason };
}

// ── public entry point: thin wrapper that applies bundle.max_attempts via withRetry ──
export function spawnAgent(
	bundle: AgentBundle,
	prompt: string,
	opts: {
		runDir?: string;
		taskId?: string;
		onEvent?: (ev: any) => void;
		verify?: string;
		protected?: string[];
		root?: string;
	} = {},
): Promise<SpawnResult> {
	return withRetry(bundle.max_attempts ?? 1, (attempt, prev) =>
		spawnOnce(bundle, attempt === 1 ? prompt : retryPrompt(prompt, prev), opts),
	);
}
