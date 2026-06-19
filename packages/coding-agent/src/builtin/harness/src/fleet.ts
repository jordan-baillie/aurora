// Harness v2 — fleet-level observability (#8). Two things the per-session TUI dashboard can't give:
//   1. a CROSS-RUN ledger of every spawn (cost-per-intelligent-agent-hour, done-rates, cache hit-rate)
//   2. a boot-time system-prompt audit to catch SKILL BLOAT (which injected context costs tokens
//      without earning it).
// Pure aggregation + a thin append/read over a JSONL ledger → fully unit-testable offline.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { estimateTokens } from "./core.ts";

export interface FleetEntry {
	ts: number;
	agent: string;
	model: string;
	status: string;
	elapsed_s: number;
	bytes: number;
	est_tokens: number;
	cached?: string | null; // "cache" | "inflight" | null
	verify?: boolean | null;
}

export function appendFleetEntry(path: string, entry: FleetEntry): void {
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

// Read the ledger, keeping the last `maxLines` entries (bounds memory on a long-lived ledger).
export function readFleet(path: string, maxLines = 5000): FleetEntry[] {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	const lines = raw.split("\n").filter((l) => l.trim());
	const out: FleetEntry[] = [];
	for (const l of lines.slice(-maxLines)) {
		try {
			out.push(JSON.parse(l) as FleetEntry);
		} catch {
			/* skip a corrupt line */
		}
	}
	return out;
}

export interface GroupAgg {
	key: string;
	count: number;
	done: number;
	done_rate: number;
	elapsed_s: number;
	est_tokens: number;
	cache_hits: number;
}
export interface FleetAggregate {
	total: number;
	done: number;
	done_rate: number;
	agent_hours: number; // total wall-clock agent time (the "intelligent-agent-hour" denominator)
	est_tokens: number;
	cache_hits: number;
	cache_hit_rate: number;
	by_agent: GroupAgg[];
	by_model: GroupAgg[];
}

function groupBy(entries: FleetEntry[], key: (e: FleetEntry) => string): GroupAgg[] {
	const m = new Map<string, GroupAgg>();
	for (const e of entries) {
		const k = key(e);
		const g = m.get(k) ?? { key: k, count: 0, done: 0, done_rate: 0, elapsed_s: 0, est_tokens: 0, cache_hits: 0 };
		g.count++;
		if (e.status === "done") g.done++;
		g.elapsed_s += e.elapsed_s || 0;
		g.est_tokens += e.est_tokens || 0;
		if (e.cached) g.cache_hits++;
		m.set(k, g);
	}
	for (const g of m.values()) g.done_rate = g.count ? Math.round((g.done / g.count) * 100) / 100 : 0;
	return [...m.values()].sort((a, b) => b.count - a.count);
}

export function aggregateFleet(entries: FleetEntry[]): FleetAggregate {
	const total = entries.length;
	const done = entries.filter((e) => e.status === "done").length;
	const elapsed = entries.reduce((s, e) => s + (e.elapsed_s || 0), 0);
	const tokens = entries.reduce((s, e) => s + (e.est_tokens || 0), 0);
	const cacheHits = entries.filter((e) => e.cached).length;
	return {
		total,
		done,
		done_rate: total ? Math.round((done / total) * 100) / 100 : 0,
		agent_hours: Math.round((elapsed / 3600) * 1000) / 1000,
		est_tokens: tokens,
		cache_hits: cacheHits,
		cache_hit_rate: total ? Math.round((cacheHits / total) * 100) / 100 : 0,
		by_agent: groupBy(entries, (e) => e.agent),
		by_model: groupBy(entries, (e) => e.model),
	};
}

export function fleetDigest(agg: FleetAggregate): string {
	const L: string[] = [];
	L.push("# Summon harness — fleet summary");
	L.push("");
	L.push(
		`total spawns: ${agg.total} · done-rate: ${(agg.done_rate * 100).toFixed(0)}% · agent-hours: ${agg.agent_hours} · est-tokens: ${agg.est_tokens} · cache-hit-rate: ${(agg.cache_hit_rate * 100).toFixed(0)}%`,
	);
	L.push("");
	L.push("## by agent");
	L.push("| agent | spawns | done% | agent-hours | est-tokens | cache-hits |");
	L.push("|---|---|---|---|---|---|");
	for (const g of agg.by_agent)
		L.push(
			`| ${g.key} | ${g.count} | ${(g.done_rate * 100).toFixed(0)}% | ${(g.elapsed_s / 3600).toFixed(3)} | ${g.est_tokens} | ${g.cache_hits} |`,
		);
	L.push("");
	L.push("## by model");
	L.push("| model | spawns | done% | agent-hours | est-tokens |");
	L.push("|---|---|---|---|---|");
	for (const g of agg.by_model)
		L.push(
			`| ${g.key} | ${g.count} | ${(g.done_rate * 100).toFixed(0)}% | ${(g.elapsed_s / 3600).toFixed(3)} | ${g.est_tokens} |`,
		);
	return `${L.join("\n")}\n`;
}

// ── boot-time prompt audit (skill-bloat detector) ─────────────────────────────
export interface PromptAudit {
	name: string;
	bytes: number;
	est_tokens: number;
	over: boolean;
}
// Flags a worker whose rendered system prompt exceeds `threshold` bytes — context that costs tokens
// every spawn. The extension computes buildSystemPrompt(bundle) once at boot and audits each.
export function auditPrompt(name: string, prompt: string, threshold = 6000): PromptAudit {
	const bytes = Buffer.byteLength(prompt, "utf8");
	return { name, bytes, est_tokens: estimateTokens(bytes), over: bytes > threshold };
}
