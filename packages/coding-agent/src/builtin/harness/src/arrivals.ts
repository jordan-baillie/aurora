// Rolling-window arrival-rate tracker (Idea 3 / A6). The fleet autoscaler's predictive behaviours
// (computeTarget's +1 speculative slot, prewarm-on-rising-demand) need a real arrival signal; before
// this they were hardcoded to 0 and never fired. This is the single source of that signal.
//
// PURE + injectable clock → unit-testable offline (no wall-clock, no pools). record() stamps an
// arrival for a bundle; rates() returns arrivals-per-minute over the short (1m) and long (5m) windows
// plus the trend (short − long): positive ⇒ demand is accelerating. Timestamps beyond the long window
// are pruned on every access so memory stays bounded to the window, not the run length.

const MIN_MS = 60_000;

export interface ArrivalRates {
	rate1m: number; // arrivals per minute over the last shortMs
	rate5m: number; // arrivals per minute averaged over the last longMs
	trend: number; // rate1m − rate5m (>0 ⇒ rising demand)
}

export class ArrivalTracker {
	private readonly hits = new Map<string, number[]>(); // bundle → ascending arrival timestamps
	private readonly shortMs: number;
	private readonly longMs: number;

	constructor(opts: { shortMs?: number; longMs?: number } = {}) {
		this.shortMs = Math.max(1, opts.shortMs ?? MIN_MS);
		this.longMs = Math.max(this.shortMs, opts.longMs ?? 5 * MIN_MS);
	}

	// Stamp one arrival for `bundle`, pruning anything older than the long window.
	record(bundle: string, now: number = Date.now()): void {
		const arr = this.hits.get(bundle) ?? [];
		arr.push(now);
		this.hits.set(bundle, this.prune(arr, now));
	}

	// Per-minute short/long rates + their trend for one bundle. Unknown bundle ⇒ all zeros. Counting is
	// order-INDEPENDENT (a plain threshold count, not a sorted-tail scan) so an out-of-order timestamp can
	// never miscount — the rate is correct regardless of the order record() was called in.
	rates(bundle: string, now: number = Date.now()): ArrivalRates {
		const arr = this.hits.get(bundle);
		if (!arr || arr.length === 0) return { rate1m: 0, rate5m: 0, trend: 0 };
		const pruned = this.prune(arr, now);
		this.hits.set(bundle, pruned);
		const since1m = now - this.shortMs;
		let c1 = 0;
		for (const t of pruned) if (t >= since1m) c1++;
		const rate1m = c1 / (this.shortMs / MIN_MS);
		const rate5m = pruned.length / (this.longMs / MIN_MS); // pruned == everything within longMs
		return { rate1m, rate5m, trend: rate1m - rate5m };
	}

	// Bundles seen at least once (used to union the demand signal with in-flight/queued sources).
	bundles(): string[] {
		return [...this.hits.keys()];
	}

	// Drop timestamps older than the long window. Order-independent (filter, not head-slice) so a
	// non-monotonic clock can't strand stale entries. n is bounded to the window, so this stays cheap.
	private prune(arr: number[], now: number): number[] {
		const cutoff = now - this.longMs;
		let stale = false;
		for (const t of arr)
			if (t < cutoff) {
				stale = true;
				break;
			}
		return stale ? arr.filter((t) => t >= cutoff) : arr;
	}
}
