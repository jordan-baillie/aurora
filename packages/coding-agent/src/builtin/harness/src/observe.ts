// Harness v2 — observability (Phase 3). Pure reducer over the agent-event stream + renderers.
// No Pi deps -> unit-testable offline; the extension (extension/observe.ts) is a thin wrapper that
// pipes pi.events("agent-event") -> reduce() and paints via setWidget/setStatus.

export interface AgentView {
	id: string;
	agent: string;
	model: string;
	status: "running" | "done" | "failed" | "verify_failed" | "timeout" | "contract_violation";
	tool?: string;
	startedAt: number;
	endedAt?: number;
	verify?: boolean;
	timeline: { tool: string; startedAt: number; endedAt?: number }[];
}
export interface ViewModel {
	agents: Map<string, AgentView>;
	startedAt: number;
	expanded?: string;
}

export const emptyVM = (): ViewModel => ({ agents: new Map(), startedAt: Date.now() });

export function reduce(vm: ViewModel, e: any): void {
	if (!e || typeof e.id !== "string") return;
	switch (e.t) {
		case "spawned":
			vm.agents.set(e.id, {
				id: e.id,
				agent: e.agent,
				model: e.model,
				status: "running",
				startedAt: e.ts ?? Date.now(),
				timeline: [],
			});
			break;
		case "tool": {
			const a = vm.agents.get(e.id);
			if (a) {
				if (e.phase === "start") {
					a.tool = e.tool;
					a.timeline.push({ tool: e.tool, startedAt: e.ts ?? Date.now() });
					if (a.timeline.length > 12) a.timeline.shift();
				} else {
					a.tool = undefined;
					const open = [...a.timeline].reverse().find((x) => x.endedAt === undefined);
					if (open) open.endedAt = e.ts ?? Date.now();
				}
			}
			break;
		}
		case "done": {
			const a = vm.agents.get(e.id);
			if (a) {
				a.status = e.status ?? "done";
				a.endedAt = e.ts ?? Date.now();
				a.verify = e.verify;
				a.tool = undefined;
			}
			break;
		}
	}
}

/**
 * Whether the live widget has anything worth animating RIGHT NOW: at least one agent is actively
 * running. When this is false the widget is fully static, so the animation timer must STOP (not just
 * skip a frame) — an always-on idle shimmer repaints the bottom status rows ~2x/sec forever, which
 * reads as constant screen jutter in tmux and any terminal that doesn't honor synchronized output.
 * Single source of the animate/quiesce decision so the extension and its tests can never drift.
 * Pure + deterministic (depends only on agent state — no boot splash, no wall clock).
 */
export function isAnimating(vm: ViewModel): boolean {
	for (const a of vm.agents.values()) if (a.status === "running") return true;
	return false;
}

// ── aurora palette (24-bit truecolor — the pi-dev / aurora identity) ──
const PAL = {
	text: "232;235;247",
	muted: "92;100;133",
	border: "40;48;87",
	run: "56;189;248",
	done: "52;211;153",
	fail: "251;113;133",
	verify: "163;230;53",
	son: "96;165;250",
	hai: "45;212;191",
	opus: "192;132;252",
};
const GRAD: number[][] = [
	[182, 156, 255],
	[139, 149, 255],
	[52, 225, 244],
	[62, 240, 212],
	[240, 111, 251],
	[182, 156, 255],
]; // aurora ribbon: violet→indigo→cyan→teal→fuchsia→violet (loops for shimmer)
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]; // braille spinner for running agents
const fg = (rgb: string, s: string) => `\x1b[38;2;${rgb}m${s}\x1b[0m`;
const lerp = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
// gradient text with an optional moving `phase` (0..1) so the banner can shimmer across frames.
function gradText(s: string, phase = 0): string {
	const n = Math.max(1, s.length);
	let out = "";
	for (let i = 0; i < s.length; i++) {
		const t = ((i / n + phase) % 1) * (GRAD.length - 1);
		const k = Math.min(GRAD.length - 2, Math.floor(t));
		const [r, g, b] = lerp(GRAD[k], GRAD[k + 1], t - k);
		out += `\x1b[1;38;2;${r};${g};${b}m${s[i]}\x1b[0m`;
	}
	return out;
}
const glyph = (s: AgentView["status"]) => (s === "running" ? "▸" : s === "done" ? "✓" : "✗");
const statusCol = (s: AgentView["status"]) => (s === "running" ? PAL.run : s === "done" ? PAL.done : PAL.fail);
const modelCol = (m: string) => (m.includes("opus") ? PAL.opus : m.includes("sonnet") ? PAL.son : PAL.hai);
const dur = (ms: number) => {
	const s = Math.max(0, Math.round(ms / 1000));
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
};
const trunc = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`);

export function counts(vm: ViewModel) {
	const a = [...vm.agents.values()];
	return {
		total: a.length,
		run: a.filter((x) => x.status === "running").length,
		ok: a.filter((x) => x.status === "done").length,
		bad: a.filter((x) => x.status !== "running" && x.status !== "done").length,
	};
}

// select/cycle/clear the drilled-in agent. target: an agent id | "next" | "off" | undefined.
export function setExpanded(vm: ViewModel, target?: string): void {
	if (!target || target === "off") {
		vm.expanded = undefined;
		return;
	}
	if (target === "next") {
		const ids = [...vm.agents.keys()];
		if (ids.length === 0) {
			vm.expanded = undefined;
			return;
		}
		const pos = ids.indexOf(vm.expanded as string);
		if (pos < 0) {
			vm.expanded = ids[0]; // currently "off" (or stale) → go to first
		} else if (pos === ids.length - 1) {
			vm.expanded = undefined; // at last id → go to "off"
		} else {
			vm.expanded = ids[pos + 1]; // advance one
		}
		return;
	}
	vm.expanded = vm.agents.has(target) ? target : undefined;
}

// The boot-splash wordmark used to live here. It now lives in the THEME banner (aurora.json →
// painted permanently into the startup transcript by interactive-mode), so the live widget no
// longer paints a second, disappearing copy. The widget is the live agent panel ONLY.

// one framed panel row: "│ " + left(colored spans) + gap + right(colored) + " │", fitted to width.
function frameRow(W: number, left: [string, string][], right: string, rightCol: string): string {
	const inner = W - 4;
	const leftPlain = left.reduce((a, [t]) => a + t.length, 0);
	let leftStr: string;
	let used: number;
	if (leftPlain + right.length <= inner) {
		leftStr = left.map(([t, col]) => fg(col, t)).join("");
		used = leftPlain;
	} else {
		// truncate left to fit
		const keep = Math.max(0, inner - right.length - 1);
		leftStr = "";
		used = 0;
		for (const [t, col] of left) {
			if (used >= keep) break;
			const take = trunc(t, keep - used);
			leftStr += fg(col, take);
			used += take.length;
		}
	}
	const gap = Math.max(1, inner - used - right.length);
	return fg(PAL.border, "│ ") + leftStr + " ".repeat(gap) + fg(rightCol, right) + fg(PAL.border, " │");
}

// The live dashboard panel (above the editor). Renders the harness's own neon look in 24-bit colour.
// `frame` advances on a timer so running agents animate (spinner) and the wordmark shimmers.
export function renderWidget(vm: ViewModel, width: number = 72, frame = 0): string[] {
	const { total, run, ok, bad } = counts(vm);
	// Idle (nothing delegated): render NOTHING so the widget takes zero space and the prompt stays
	// clean. The live agent panel appears only when there's activity (or a drill-in is pinned).
	if (total === 0 && vm.expanded === undefined) return [];
	const W = Math.max(46, Math.min(typeof width === "number" && width > 0 ? width : 72, 100));
	const elapsed = dur(Date.now() - vm.startedAt);
	const L: string[] = [];
	// header rail: ⬢ AURORA (shimmering gradient) + coloured counts + elapsed
	const mark = fg(PAL.muted, "⬢ ") + gradText("AURORA", (frame % 60) / 60);
	const stat = `${fg(PAL.run, `▸${run}`)} ${fg(PAL.done, `✓${ok}`)} ${fg(PAL.fail, `✗${bad}`)}`;
	L.push(`${mark}  ${stat}  ${fg(PAL.border, "·")}  ${fg(PAL.muted, `⏱ ${elapsed}`)}`);
	if (total === 0) return L; // drill-in pinned but no agents yet: header only
	// agents panel
	const title = "agents";
	L.push(
		fg(PAL.border, "╭─ ") +
			fg(PAL.muted, title) +
			" " +
			fg(PAL.border, `${"─".repeat(Math.max(0, W - title.length - 5))}╮`),
	);
	for (const a of [...vm.agents.values()].slice(-8)) {
		const bad2 = a.status !== "running" && a.status !== "done";
		const act = a.status === "running" ? (a.tool ?? "working…") : a.status === "done" ? "done" : a.status;
		const actCol = bad2 ? PAL.fail : a.status === "running" ? PAL.text : PAL.muted;
		const gl = a.status === "running" ? SPIN[frame % SPIN.length] : glyph(a.status);
		const left: [string, string][] = [
			[`${gl} `, statusCol(a.status)],
			[a.agent.padEnd(9), PAL.text],
			[`‹${a.model}›`, modelCol(a.model)],
			[`  ${act}`, actCol],
		];
		const verified = a.status === "done" && a.verify === true;
		const right = (verified ? "✓ " : "") + dur((a.endedAt ?? Date.now()) - a.startedAt);
		L.push(frameRow(W, left, right, verified ? PAL.verify : PAL.muted));
	}
	L.push(fg(PAL.border, `╰${"─".repeat(W - 2)}╯`));
	// drill-in detail (the selected agent's tool timeline)
	if (vm.expanded !== undefined && vm.agents.has(vm.expanded)) {
		const a = vm.agents.get(vm.expanded)!;
		L.push(fg(PAL.border, "  ▾ ") + fg(PAL.son, a.agent) + fg(PAL.muted, ` ‹${a.model}› ${a.status}`));
		const tl = a.timeline.slice(-10);
		if (tl.length === 0) L.push(fg(PAL.muted, "    (no tool activity yet)"));
		else
			for (const e of tl) {
				const g = e.endedAt !== undefined ? fg(PAL.done, "✓") : fg(PAL.run, "▸");
				L.push(
					"    " +
						g +
						" " +
						fg(PAL.text, (e.tool ?? "?").padEnd(16)) +
						" " +
						fg(PAL.muted, dur((e.endedAt ?? Date.now()) - e.startedAt)),
				);
			}
	}
	return L;
}

// Compact footer/status chip — coloured.
export function renderFooter(vm: ViewModel): string {
	const { run, ok, bad } = counts(vm);
	return (
		fg(PAL.run, `▸${run}`) +
		" " +
		fg(PAL.done, `✓${ok}`) +
		" " +
		fg(PAL.fail, `✗${bad}`) +
		" " +
		fg(PAL.muted, `· ${dur(Date.now() - vm.startedAt)}`)
	);
}
