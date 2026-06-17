import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadThemeFromPath, type Theme } from "../src/modes/interactive/theme/theme.ts";

// ============================================================================
// Phase 3 — signature gradient + wordmark banner
//
// These guard the whole "premium banner/gradient" class of behaviour so a future
// renderer change can't silently break the aurora wordmark or the breathing
// spinner. We build the fixture from the real builtin `dark.json` (so every one
// of the 40+ required colours is valid) and only *add* the optional gradient +
// banner keys — exactly how aurora.json opts in.
// ============================================================================

const DARK_JSON = join(__dirname, "..", "src", "modes", "interactive", "theme", "dark.json");

/** Write a temp theme = builtin dark + optional gradient/banner, load it truecolor. */
function loadAugmented(extra: Record<string, unknown>): Theme {
	const base = JSON.parse(readFileSync(DARK_JSON, "utf-8"));
	const merged = { ...base, name: "test-aurora", vars: { ...(base.vars ?? {}), myaccent: "#a78bfa" }, ...extra };
	const dir = mkdtempSync(join(tmpdir(), "theme-banner-"));
	const p = join(dir, "test-aurora.json");
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

describe("Backwards compatibility (no gradient/banner declared)", () => {
	test("builtin-style theme returns undefined for all premium features", () => {
		const theme = loadAugmented({}); // dark + nothing extra
		expect(theme.signatureGradient()).toBeUndefined();
		expect(theme.bannerLines()).toBeUndefined();
		expect(theme.bannerWidth()).toBe(0);
		expect(theme.bannerTagline()).toBeUndefined();
		expect(theme.gradientSpinnerFrames()).toBeUndefined();
	});

	test("gradientText passes text through unchanged when no gradient", () => {
		const theme = loadAugmented({});
		expect(theme.gradientText("AURORA")).toBe("AURORA");
	});
});
