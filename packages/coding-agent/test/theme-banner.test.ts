import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@summon/tui";
import { describe, expect, test } from "vitest";
import { loadThemeFromPath, type Theme } from "../src/modes/interactive/theme/theme.ts";

// ============================================================================
// Phase 3 — signature gradient + wordmark banner
//
// These guard the whole "premium banner/gradient" class of behaviour so a future
// renderer change can't silently break the summon wordmark or the breathing
// spinner. We build the fixture from the real builtin `dark.json` (so every one
// of the 40+ required colours is valid) and only *add* the optional gradient +
// banner keys — exactly how summon.json opts in.
// ============================================================================

const DARK_JSON = join(__dirname, "..", "src", "modes", "interactive", "theme", "dark.json");

/** Write a temp theme = builtin dark + optional gradient/banner, load it truecolor. */
function loadAugmented(extra: Record<string, unknown>): Theme {
	const base = JSON.parse(readFileSync(DARK_JSON, "utf-8"));
	const merged = { ...base, name: "test-summon", vars: { ...(base.vars ?? {}), myaccent: "#a78bfa" }, ...extra };
	const dir = mkdtempSync(join(tmpdir(), "theme-banner-"));
	const p = join(dir, "test-summon.json");
	writeFileSync(p, JSON.stringify(merged));
	return loadThemeFromPath(p, "truecolor");
}

const GRADIENT = ["myaccent", "#22d3ee", "#e879f9"]; // var-ref + two hex stops
const BANNER = {
	lines: [
		"##  ##", // cols 0,1,4,5 filled
		"##  ##",
		"######",
	],
	tagline: "orchestrated coding",
};

describe("Theme signature gradient", () => {
	test("gradientAt interpolates endpoints and midpoint deterministically", () => {
		const theme = loadAugmented({ gradient: ["#000000", "#ffffff"] });
		expect(theme.gradientAt(0)).toBe("#000000");
		expect(theme.gradientAt(1)).toBe("#ffffff");
		// 255 * 0.5 = 127.5 → round → 128 = 0x80
		expect(theme.gradientAt(0.5)).toBe("#808080");
		// clamps out-of-range t
		expect(theme.gradientAt(-3)).toBe("#000000");
		expect(theme.gradientAt(99)).toBe("#ffffff");
	});

	test("gradientAt cyclic wraps the last stop back to the first", () => {
		const theme = loadAugmented({ gradient: ["#ff0000", "#00ff00"] });
		// non-cyclic: t=1 → last stop
		expect(theme.gradientAt(1, undefined, false)).toBe("#00ff00");
		// cyclic: t=1 → wrapped back to first stop (seamless loop)
		expect(theme.gradientAt(1, undefined, true)).toBe("#ff0000");
	});

	test("signatureGradient resolves var refs to hex", () => {
		const theme = loadAugmented({ gradient: GRADIENT });
		expect(theme.signatureGradient()).toEqual(["#a78bfa", "#22d3ee", "#e879f9"]);
	});

	test("non-hex (256-index) stops are dropped, leaving only interpolatable hex", () => {
		const theme = loadAugmented({ gradient: ["#a78bfa", 123, "#22d3ee"] });
		expect(theme.signatureGradient()).toEqual(["#a78bfa", "#22d3ee"]);
	});
});

describe("Theme wordmark banner", () => {
	test("bannerLines returns one rendered line per source line", () => {
		const theme = loadAugmented({ gradient: GRADIENT, banner: BANNER });
		const lines = theme.bannerLines();
		expect(lines).toBeDefined();
		expect(lines).toHaveLength(BANNER.lines.length);
	});

	test("each painted glyph carries a truecolor escape; spaces stay bare", () => {
		const theme = loadAugmented({ gradient: GRADIENT, banner: BANNER });
		const lines = theme.bannerLines()!;
		// row "##  ##": two spaces in the middle must remain literal spaces
		expect(lines[0]).toContain("38;2;"); // truecolor painted
		expect(lines[0]).toContain("  "); // the gap survives uncoloured
	});

	test("gradient is column-aligned: same column → same colour across rows", () => {
		const theme = loadAugmented({ gradient: GRADIENT, banner: BANNER });
		const lines = theme.bannerLines()!;
		// column 0 is '#' in every row; extract the leading SGR sequence of each
		const lead = (s: string) => s.match(/^\x1b\[[0-9;]*m/)?.[0];
		expect(lead(lines[0])).toBeDefined();
		expect(lead(lines[0])).toBe(lead(lines[1]));
		expect(lead(lines[0])).toBe(lead(lines[2]));
	});

	test("bannerWidth + tagline accessors", () => {
		const theme = loadAugmented({ gradient: GRADIENT, banner: BANNER });
		expect(theme.bannerWidth()).toBe(6);
		expect(theme.bannerTagline()).toBe("orchestrated coding");
	});
});

describe("Theme gradient spinner", () => {
	test("gradientSpinnerFrames colourizes one frame per base frame", () => {
		const theme = loadAugmented({ gradient: GRADIENT });
		const frames = theme.gradientSpinnerFrames()!;
		expect(frames).toBeDefined();
		expect(frames).toHaveLength(theme.spinnerFrames().length);
		for (const f of frames) expect(f).toContain("38;2;");
	});
});

describe("Theme summon wave-ribbon spinner", () => {
	test("opt-in (layout.spinnerStyle:wave) + gradient → painted frames, every frame equal width", () => {
		const theme = loadAugmented({ gradient: GRADIENT, layout: { spinnerStyle: "wave" } });
		const frames = theme.summonSpinnerFrames()!;
		expect(frames).toBeDefined();
		expect(frames.length).toBeGreaterThan(1);
		// CRITICAL invariant: identical visible width across ALL frames (no loader jitter).
		const widths = new Set(frames.map((f) => visibleWidth(f)));
		expect(widths.size).toBe(1);
		expect([...widths][0]).toBe(7); // 7 block-glyph cells
		for (const f of frames) expect(f).toContain("38;2;"); // truecolor-painted
	});

	test("deterministic: same theme builds byte-identical frames", () => {
		const a = loadAugmented({ gradient: GRADIENT, layout: { spinnerStyle: "wave" } }).summonSpinnerFrames();
		const b = loadAugmented({ gradient: GRADIENT, layout: { spinnerStyle: "wave" } }).summonSpinnerFrames();
		expect(a).toEqual(b);
	});

	test("off by default: gradient but no wave opt-in → undefined (falls back to breathing spinner)", () => {
		const theme = loadAugmented({ gradient: GRADIENT });
		expect(theme.summonSpinnerFrames()).toBeUndefined();
	});

	test("wave opt-in but no gradient → undefined (needs a signature gradient)", () => {
		const theme = loadAugmented({ layout: { spinnerStyle: "wave" } });
		expect(theme.summonSpinnerFrames()).toBeUndefined();
	});

	// Map each painted cell back to its block-glyph height level (0..7). Strips the truecolor
	// ANSI so we can reason about the SHAPE of the wave, not its colour.
	const LEVELS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
	const heights = (frame: string): number[] => [...frame.replace(/\x1b\[[0-9;]*m/g, "")].map((g) => LEVELS.indexOf(g));

	test("clean shape: every frame is a single unimodal crest (no busy multi-bump equalizer)", () => {
		const frames = loadAugmented({ gradient: GRADIENT, layout: { spinnerStyle: "wave" } }).summonSpinnerFrames()!;
		for (const f of frames) {
			const lv = heights(f);
			expect(lv.every((n) => n >= 0)).toBe(true); // only known glyphs
			// Collapse plateaus, then count direction changes around the ring. One crest + one
			// trough ⇒ exactly two sign changes. More ⇒ a multi-bump wave (the look we rejected).
			const signs = lv.map((n, i) => Math.sign(lv[(i + 1) % lv.length] - n)).filter((s) => s !== 0);
			const changes = signs.filter((s, i) => s !== signs[(i + 1) % signs.length]).length;
			expect(changes).toBeLessThanOrEqual(2);
		}
	});

	test("full dynamic range: the swell crests at a full block and troughs at the lowest block", () => {
		const frames = loadAugmented({ gradient: GRADIENT, layout: { spinnerStyle: "wave" } }).summonSpinnerFrames()!;
		const all = frames.flatMap(heights);
		expect(Math.max(...all)).toBe(LEVELS.length - 1); // reaches █ (bright, punchy crest)
		expect(Math.min(...all)).toBe(0); // reaches ▁ (full contrast, not a faint ripple)
	});
});

describe("Theme summon comet banner", () => {
	const COMET = { gradient: GRADIENT, banner: BANNER, layout: { bannerAnimation: "comet" } };
	// Glyph-grid diff: strip colour, compare the GR×GC character grids cell-by-cell. Robust to the
	// comet's particles appearing/vanishing (unlike a per-colour-code diff, which would misalign).
	const glyphDiff = (a: string, b: string): number => {
		const A = a.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
		const B = b.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
		let s = 0;
		const R = Math.max(A.length, B.length);
		for (let r = 0; r < R; r++) {
			const la = A[r] ?? "",
				lb = B[r] ?? "",
				C = Math.max(la.length, lb.length);
			for (let c = 0; c < C; c++) if ((la[c] ?? " ") !== (lb[c] ?? " ")) s++;
		}
		return s;
	};
	const bannerW = (t: ReturnType<typeof loadAugmented>) => Math.max(...t.bannerLines()!.map((l) => visibleWidth(l)));

	test("opt-in + gradient + banner → painted frames; fixed grid (wordmark + 2 spray rows), constant width", () => {
		const theme = loadAugmented(COMET);
		const frames = theme.summonBannerCometFrames()!;
		expect(frames).toBeDefined();
		expect(frames.length).toBeGreaterThan(1);
		const banner = theme.bannerLines()!;
		const W = bannerW(theme);
		for (const fr of frames) {
			const lines = fr.split("\n");
			expect(lines).toHaveLength(banner.length + 2); // wordmark band + one spray row above & below
			// CRITICAL invariant: identical visible width on EVERY row across ALL frames (no header jitter).
			for (const l of lines) expect(visibleWidth(l)).toBe(W);
			expect(fr).toContain("38;2;"); // truecolor-painted
		}
	});

	test("seamless loop: the wrap step (last→first) is the smoothest step (comet off-screen at the seam)", () => {
		const frames = loadAugmented(COMET).summonBannerCometFrames()!;
		const interior: number[] = [];
		for (let i = 0; i < frames.length - 1; i++) interior.push(glyphDiff(frames[i], frames[i + 1]));
		const wrap = glyphDiff(frames[frames.length - 1], frames[0]);
		const maxInterior = Math.max(...interior);
		expect(maxInterior).toBeGreaterThan(0); // the comet IS moving somewhere in the loop
		// The comet is fully off-screen at both ends, so the last→first glyph grids match → no seam.
		expect(wrap).toBeLessThanOrEqual(maxInterior);
	});

	test("the comet actually sweeps: a bright head ● appears mid-loop and is gone at the seam", () => {
		const frames = loadAugmented(COMET).summonBannerCometFrames()!;
		const hasHead = (f: string) => f.replace(/\x1b\[[0-9;]*m/g, "").includes("●");
		expect(frames.some(hasHead)).toBe(true); // it sweeps through
		expect(frames.some((f) => !hasHead(f))).toBe(true); // and clears (off-screen part of the loop)
		expect(hasHead(frames[0])).toBe(false); // absent at the seam → clean loop
		expect(new Set(frames).size).toBeGreaterThanOrEqual(frames.length - 2); // continuous motion
	});

	test("deterministic: same theme builds byte-identical comet frames (fixed-seed trail)", () => {
		expect(loadAugmented(COMET).summonBannerCometFrames()).toEqual(loadAugmented(COMET).summonBannerCometFrames());
	});

	test("multi-letter wordmark separates on blank columns without crashing, constant width", () => {
		const twoLetter = { lines: ["## ##", "## ##", "## ##"], tagline: "x" }; // col 2 blank in every row
		const opts = { gradient: GRADIENT, banner: twoLetter, layout: { bannerAnimation: "comet" } };
		const frames = loadAugmented(opts).summonBannerCometFrames()!;
		expect(frames.length).toBeGreaterThan(1);
		const widths = new Set(frames.flatMap((f) => f.split("\n").map((l) => visibleWidth(l))));
		expect(widths.size).toBe(1); // every row of every frame same width → no jitter
	});

	test("off by default: banner + gradient but no comet opt-in → undefined", () => {
		expect(loadAugmented({ gradient: GRADIENT, banner: BANNER }).summonBannerCometFrames()).toBeUndefined();
	});

	test("comet opt-in but no gradient → undefined", () => {
		expect(
			loadAugmented({ banner: BANNER, layout: { bannerAnimation: "comet" } }).summonBannerCometFrames(),
		).toBeUndefined();
	});

	test("comet opt-in but no banner → undefined", () => {
		expect(
			loadAugmented({ gradient: GRADIENT, layout: { bannerAnimation: "comet" } }).summonBannerCometFrames(),
		).toBeUndefined();
	});
});

describe("Backwards compatibility (no gradient/banner declared)", () => {
	test("builtin-style theme returns undefined for all premium features", () => {
		const theme = loadAugmented({}); // dark + nothing extra
		expect(theme.signatureGradient()).toBeUndefined();
		expect(theme.bannerLines()).toBeUndefined();
		expect(theme.bannerWidth()).toBe(0);
		expect(theme.bannerTagline()).toBeUndefined();
		expect(theme.gradientSpinnerFrames()).toBeUndefined();
		expect(theme.summonSpinnerFrames()).toBeUndefined();
		expect(theme.summonBannerCometFrames()).toBeUndefined();
	});

	test("gradientText passes text through unchanged when no gradient", () => {
		const theme = loadAugmented({});
		expect(theme.gradientText("SUMMON")).toBe("SUMMON");
	});
});
