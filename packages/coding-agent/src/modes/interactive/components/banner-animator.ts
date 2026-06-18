/**
 * Continuous startup-banner animation driver.
 *
 * Holds a precomputed, seamless-looping set of fully-coloured banner frames and cycles through them
 * forever, so a premium themed banner stays alive for the life of the session (e.g. the aurora
 * "comet" effect). It is intentionally NOT a TUI Component — it owns only a timer and an index; the
 * header widget reads {@link current} and the owner pushes the new frame via the `onFrame` callback
 * (which refreshes the header + calls `ui.requestRender()`).
 *
 * The frame set is built to wrap seamlessly (see Theme.auroraBannerCometFrames), so looping
 * `index = (index + 1) % frames.length` never produces a visual seam. {@link start}/{@link stop}
 * are idempotent; {@link stop} (called on teardown) clears the timer so no animation outlives the UI.
 */
export class BannerAnimator {
	private index = 0;
	private timer: ReturnType<typeof setInterval> | null = null;
	private stopped = false;
	private readonly frames: string[];
	private readonly intervalMs: number;
	private readonly onFrame: () => void;
	private readonly shouldAnimate: () => boolean;

	/**
	 * @param shouldAnimate Visibility gate evaluated on every tick. When it returns false the frame is
	 * FROZEN (index held, no repaint) so off-screen banner churn can't force a flickering full redraw.
	 * Defaults to always-animate for callers that don't care about viewport position.
	 */
	constructor(frames: string[], intervalMs: number, onFrame: () => void, shouldAnimate: () => boolean = () => true) {
		this.frames = frames;
		this.intervalMs = intervalMs;
		this.onFrame = onFrame;
		this.shouldAnimate = shouldAnimate;
	}

	/** The banner to render right now: the current frame of the animation loop. */
	current(): string {
		if (this.frames.length === 0) return "";
		return this.frames[this.index % this.frames.length];
	}

	/** Begin the continuous animation. No-op when there is nothing meaningful to animate (≤1 frame). */
	start(): void {
		if (this.timer || this.stopped) return;
		if (this.frames.length <= 1) return;
		this.timer = setInterval(() => {
			// Freeze when not visible: do not advance the frame or repaint. Keeping the index fixed makes
			// current() byte-stable so an off-screen banner can never straddle the viewport on an unrelated
			// re-render and force a flickering full-screen repaint (tmux jitter).
			if (!this.shouldAnimate()) return;
			this.index = (this.index + 1) % this.frames.length;
			this.onFrame();
		}, this.intervalMs);
	}

	/** Stop animating (idempotent). Called on UI teardown so the timer never outlives the session. */
	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.stopped = true;
	}
}
