// Harness v2 — within-run result cache + in-flight dedup (#5). Identical sub-tasks (same agent +
// model + tools + prompt + verify) collapse to ONE execution: concurrent duplicates share the same
// promise, and a completed result is reused for later identical calls within the session.
//
// SAFETY: only READ-ONLY agents are cacheable. Caching a write/edit/bash agent would return its
// cached artifact text WITHOUT re-applying the file changes — a correctness hazard — so a
// side-effecting agent always runs. This makes the unsafe case unrepresentable, not a footgun.

import { createHash } from "node:crypto";
import type { AgentBundle, SpawnResult } from "./core.ts";

const SIDE_EFFECT_TOOLS = new Set(["write", "edit", "bash"]);

export function isCacheable(bundle: AgentBundle): boolean {
	return !bundle.tools.some((t) => SIDE_EFFECT_TOOLS.has(t));
}

export function cacheKey(bundle: AgentBundle, prompt: string, verify?: string): string {
	return createHash("sha256")
		.update(
			`${bundle.name}\u0000${bundle.model_tier}\u0000${bundle.tools.join(",")}\u0000${verify ?? ""}\u0000${prompt}`,
		)
		.digest("hex")
		.slice(0, 32);
}

export type CacheSource = "miss" | "cache" | "inflight";

export interface CacheStats {
	stored: number;
	hits: number;
	dedups: number;
	misses: number;
}

export class ResultCache {
	private done = new Map<string, SpawnResult>();
	private inflight = new Map<string, Promise<SpawnResult>>();
	private _hits = 0;
	private _dedups = 0;
	private _misses = 0;

	stats(): CacheStats {
		return { stored: this.done.size, hits: this._hits, dedups: this._dedups, misses: this._misses };
	}

	// A stored hit without running anything (fast path — no governor slot needed). Counts the hit.
	peek(key: string): SpawnResult | undefined {
		const c = this.done.get(key);
		if (!c) return undefined;
		this._hits++;
		return { ...c, cached: "cache" };
	}

	// Run `exec` under `key`, sharing a concurrent identical run and caching a successful (done) result.
	async run(key: string, exec: () => Promise<SpawnResult>): Promise<{ result: SpawnResult; source: CacheSource }> {
		const stored = this.done.get(key);
		if (stored) {
			this._hits++;
			return { result: { ...stored, cached: "cache" }, source: "cache" };
		}
		const flying = this.inflight.get(key);
		if (flying) {
			this._dedups++;
			return { result: { ...(await flying), cached: "inflight" }, source: "inflight" };
		}
		this._misses++;
		const p = exec();
		this.inflight.set(key, p);
		try {
			const result = await p;
			if (result.status === "done") this.done.set(key, result); // never cache a failure
			return { result, source: "miss" };
		} finally {
			this.inflight.delete(key);
		}
	}
}
