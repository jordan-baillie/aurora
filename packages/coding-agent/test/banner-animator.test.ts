import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { BannerAnimator } from "../src/modes/interactive/components/banner-animator.ts";

// ============================================================================
// BannerAnimator visibility-freeze guard.
//
// The themed startup banner animates forever (e.g. the summon "comet"). If it
// keeps advancing while scrolled out of view, an off-screen frame change
// straddles the viewport top and forces a flickering full-screen repaint on
// tmux ("jitter"). The animator must FREEZE (hold its frame, emit nothing)
// whenever its `shouldAnimate` gate is false. These tests lock that in so the
// jitter fix can't silently regress.
// ============================================================================

const FRAMES = ["frame-0", "frame-1", "frame-2"];
const INTERVAL = 75;

describe("BannerAnimator visibility freeze", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	test("animates while visible: advances frame and repaints each tick", () => {
		let paints = 0;
		const anim = new BannerAnimator(
			FRAMES,
			INTERVAL,
			() => paints++,
			() => true,
		);
		anim.start();
		expect(anim.current()).toBe("frame-0");

		vi.advanceTimersByTime(INTERVAL);
		expect(anim.current()).toBe("frame-1");
		vi.advanceTimersByTime(INTERVAL);
		expect(anim.current()).toBe("frame-2");
		expect(paints).toBe(2);
		anim.stop();
	});

	test("frozen while not visible: never advances and never repaints", () => {
		let paints = 0;
		const anim = new BannerAnimator(
			FRAMES,
			INTERVAL,
			() => paints++,
			() => false,
		);
		anim.start();

		vi.advanceTimersByTime(INTERVAL * 10);
		// The whole point: an off-screen banner is byte-stable across every tick and
		// every unrelated re-render, so it can never straddle the viewport.
		expect(anim.current()).toBe("frame-0");
		expect(paints).toBe(0);
		anim.stop();
	});

	test("toggling visibility freezes then resumes from the held frame", () => {
		let visible = true;
		let paints = 0;
		const anim = new BannerAnimator(
			FRAMES,
			INTERVAL,
			() => paints++,
			() => visible,
		);
		anim.start();

		vi.advanceTimersByTime(INTERVAL); // visible -> advance to frame-1
		expect(anim.current()).toBe("frame-1");
		expect(paints).toBe(1);

		visible = false; // scroll out of view -> freeze
		vi.advanceTimersByTime(INTERVAL * 5);
		expect(anim.current()).toBe("frame-1"); // held, no drift
		expect(paints).toBe(1); // no off-screen repaints

		visible = true; // scroll back to top -> resume from where it froze
		vi.advanceTimersByTime(INTERVAL);
		expect(anim.current()).toBe("frame-2");
		expect(paints).toBe(2);
		anim.stop();
	});
});
