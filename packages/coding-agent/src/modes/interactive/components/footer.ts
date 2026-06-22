import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Component, truncateToWidth, visibleWidth } from "@summon/tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { theme } from "../theme/theme.ts";

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Format token counts for compact footer display.
 */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

/**
 * Footer component that shows pwd, token stats, and context usage.
 * Branches on theme.footerStyle():
 *  - "two-line"   (dark/light): current pwd + stats layout (pixel-identical to pre-Phase-2).
 *  - "single-line" (editorial/brutalist): compact one-line model  ctx%  tokens  $cost  cwd.
 */
export class FooterComponent implements Component {
	private autoCompactEnabled = true;
	private session: AgentSession;
	private footerData: ReadonlyFooterDataProvider;

	constructor(session: AgentSession, footerData: ReadonlyFooterDataProvider) {
		this.session = session;
		this.footerData = footerData;
	}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	invalidate(): void {
		// No-op: git branch is cached/invalidated by provider
	}

	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	render(width: number): string[] {
		const state = this.session.state;

		// Calculate cumulative usage from ALL session entries
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;

		for (const entry of this.session.sessionManager.getEntries()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				totalInput += entry.message.usage.input;
				totalOutput += entry.message.usage.output;
				totalCacheRead += entry.message.usage.cacheRead;
				totalCacheWrite += entry.message.usage.cacheWrite;
				totalCost += entry.message.usage.cost.total;
			}
		}

		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

		let pwd = formatCwdForFooter(this.session.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);

		const branch = this.footerData.getGitBranch();
		if (branch) {
			pwd = `${pwd} (${branch})`;
		}

		const sessionName = this.session.sessionManager.getSessionName();
		if (sessionName) {
			pwd = `${pwd} • ${sessionName}`;
		}

		const extensionStatuses = this.footerData.getExtensionStatuses();
		const usingSubscription = state.model ? this.session.modelRegistry.isUsingOAuth(state.model) : false;

		// ── Branch on footerStyle ────────────────────────────────────────────
		if (theme.footerStyle() === "hud-strip") {
			return this.renderHudStrip(
				width,
				state.model?.id ?? "no-model",
				!!(state.model as any)?.reasoning,
				(state as any).thinkingLevel as string | undefined,
				totalInput,
				totalOutput,
				totalCost,
				contextWindow,
				contextPercentValue,
				contextPercent,
				usingSubscription,
				pwd,
				extensionStatuses,
			);
		}
		if (theme.footerStyle() === "single-line") {
			return this.renderSingleLine(
				width,
				state.model?.id ?? "no-model",
				!!(state.model as any)?.reasoning,
				(state as any).thinkingLevel as string | undefined,
				totalInput,
				totalOutput,
				totalCost,
				contextWindow,
				contextPercentValue,
				contextPercent,
				usingSubscription,
				pwd,
				extensionStatuses,
			);
		}

		// ── Two-line (legacy dark / light) ─────────────────────────────────

		const statsParts: string[] = [];
		if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
		if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
		if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
		if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);

		if (totalCost || usingSubscription) {
			const costStr = `$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`;
			statsParts.push(costStr);
		}

		let contextPercentStr: string;
		const autoIndicator = this.autoCompactEnabled ? " (auto)" : "";
		const contextPercentDisplay =
			contextPercent === "?"
				? `?/${formatTokens(contextWindow)}${autoIndicator}`
				: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
		if (contextPercentValue > 90) {
			contextPercentStr = theme.fg("error", contextPercentDisplay);
		} else if (contextPercentValue > 70) {
			contextPercentStr = theme.fg("warning", contextPercentDisplay);
		} else {
			contextPercentStr = contextPercentDisplay;
		}
		statsParts.push(contextPercentStr);

		let statsLeft = statsParts.join(" ");

		const modelName = state.model?.id || "no-model";
		let statsLeftWidth = visibleWidth(statsLeft);

		if (statsLeftWidth > width) {
			statsLeft = truncateToWidth(statsLeft, width, "...");
			statsLeftWidth = visibleWidth(statsLeft);
		}

		const minPadding = 2;

		let rightSideWithoutProvider = modelName;
		if (state.model?.reasoning) {
			const thinkingLevel = (state as any).thinkingLevel || "off";
			rightSideWithoutProvider =
				thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
		}

		let rightSide = rightSideWithoutProvider;
		if (this.footerData.getAvailableProviderCount() > 1 && state.model) {
			rightSide = `(${state.model.provider}) ${rightSideWithoutProvider}`;
			if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) {
				rightSide = rightSideWithoutProvider;
			}
		}

		const rightSideWidth = visibleWidth(rightSide);
		const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;

		let statsLine: string;
		if (totalNeeded <= width) {
			const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
			statsLine = statsLeft + padding + rightSide;
		} else {
			const availableForRight = width - statsLeftWidth - minPadding;
			if (availableForRight > 0) {
				const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
				const truncatedRightWidth = visibleWidth(truncatedRight);
				const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
				statsLine = statsLeft + padding + truncatedRight;
			} else {
				statsLine = statsLeft;
			}
		}

		const dimStatsLeft = theme.fg("dim", statsLeft);
		const remainder = statsLine.slice(statsLeft.length);
		const dimRemainder = theme.fg("dim", remainder);

		const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
		const lines = [pwdLine, dimStatsLeft + dimRemainder];

		if (extensionStatuses.size > 0) {
			const sortedStatuses = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			const statusLine = sortedStatuses.join(" ");
			lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
		}

		return lines;
	}

	// ──────────────────────────────────────────────────────────────────────────
	// Single-line footer (editorial / brutalist)
	// ──────────────────────────────────────────────────────────────────────────

	private renderSingleLine(
		width: number,
		modelId: string,
		hasReasoning: boolean,
		thinkingLevel: string | undefined,
		totalInput: number,
		totalOutput: number,
		totalCost: number,
		contextWindow: number,
		contextPercentValue: number,
		contextPercent: string,
		usingSubscription: boolean,
		pwd: string,
		extensionStatuses: ReadonlyMap<string, string>,
	): string[] {
		const sep = theme.footerSeparator();
		const ascii = theme.isAsciiOnly();
		const autoIndicator = this.autoCompactEnabled ? " (auto)" : "";

		// ── Group: model (NEVER dropped) ──────────────────────────────────
		let modelPart = modelId;
		if (hasReasoning) {
			const level = thinkingLevel || "off";
			modelPart = level === "off" ? `${modelId} thinking:off` : `${modelId} thinking:${level}`;
		}

		// ── Group: context% (NEVER dropped) ──────────────────────────────
		const ctxDisplay =
			contextPercent === "?"
				? `?/${formatTokens(contextWindow)}${autoIndicator}`
				: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
		let contextPart: string;
		if (contextPercentValue > 90) {
			contextPart = theme.fg("error", ctxDisplay);
		} else if (contextPercentValue > 70) {
			contextPart = theme.fg("warning", ctxDisplay);
		} else {
			contextPart = ctxDisplay;
		}

		// ── Group: tokens (optional — drop 2nd) ──────────────────────────
		let tokensPart: string | null = null;
		if (totalInput || totalOutput) {
			tokensPart = ascii
				? `in:${formatTokens(totalInput)} out:${formatTokens(totalOutput)}`
				: `↑${formatTokens(totalInput)} ↓${formatTokens(totalOutput)}`;
		}

		// ── Group: cost (optional — drop 1st) ────────────────────────────
		let costPart: string | null = null;
		if (totalCost || usingSubscription) {
			costPart = `$${totalCost.toFixed(3)}${usingSubscription ? "(sub)" : ""}`;
		}

		// ── Group: cwd (optional — drop 3rd/last) ────────────────────────
		const cwdPart: string | null = pwd || null;

		// ── Fit groups into width — drop order: cost, tokens, cwd ─────────
		// Build a line from non-null parts joined by separator
		const tryJoin = (parts: Array<string | null>): string => parts.filter((p): p is string => p !== null).join(sep);

		const candidates: Array<Array<string | null>> = [
			[modelPart, contextPart, tokensPart, costPart, cwdPart], // all
			[modelPart, contextPart, tokensPart, null, cwdPart], // drop cost
			[modelPart, contextPart, null, null, cwdPart], // drop cost + tokens
			[modelPart, contextPart, null, null, null], // drop cost + tokens + cwd
		];

		let result = tryJoin(candidates[0]);
		for (const candidate of candidates) {
			const joined = tryJoin(candidate);
			if (visibleWidth(joined) <= width) {
				result = joined;
				break;
			}
		}

		// Last-resort truncation
		if (visibleWidth(result) > width) {
			result = truncateToWidth(result, width, theme.fg("dim", "..."));
		}

		const lines: string[] = [theme.fg("dim", result)];

		// Extension statuses on a second line (if present)
		if (extensionStatuses.size > 0) {
			const sortedStatuses = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			const statusLine = sortedStatuses.join(" ");
			lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
		}

		return lines;
	}

	// ──────────────────────────────────────────────────────────────────────────
	// HUD-strip footer (command-bridge): bracketed [ … ] telemetry cells.
	// ──────────────────────────────────────────────────────────────────────────
	private renderHudStrip(
		width: number,
		modelId: string,
		hasReasoning: boolean,
		thinkingLevel: string | undefined,
		totalInput: number,
		totalOutput: number,
		totalCost: number,
		contextWindow: number,
		contextPercentValue: number,
		contextPercent: string,
		usingSubscription: boolean,
		pwd: string,
		extensionStatuses: ReadonlyMap<string, string>,
	): string[] {
		const autoIndicator = this.autoCompactEnabled ? " auto" : "";
		const cell = (s: string): string => `${theme.fg("accent", "[")} ${s} ${theme.fg("accent", "]")}`;

		let model = modelId;
		if (hasReasoning) {
			const level = thinkingLevel || "off";
			model = level === "off" ? `${modelId} think:off` : `${modelId} think:${level}`;
		}
		const ctxStr =
			contextPercent === "?"
				? `CTX ?/${formatTokens(contextWindow)}`
				: `CTX ${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
		const ctxCol = contextPercentValue > 90 ? "error" : contextPercentValue > 70 ? "warning" : "muted";

		const modelCell = cell(theme.fg("text", model));
		const ctxCell = cell(theme.fg(ctxCol, ctxStr));
		const tokCell =
			totalInput || totalOutput
				? cell(theme.fg("muted", `↑${formatTokens(totalInput)} ↓${formatTokens(totalOutput)}`))
				: null;
		const costCell =
			totalCost || usingSubscription
				? cell(theme.fg("muted", `$${totalCost.toFixed(3)}${usingSubscription ? " sub" : ""}`))
				: null;
		const cwdCell = pwd ? cell(theme.fg("muted", pwd)) : null;

		const join = (cells: Array<string | null>): string => cells.filter((c): c is string => c !== null).join(" ");
		// Fit into width — drop order: cost, tokens, cwd (mirrors single-line).
		const candidates: Array<Array<string | null>> = [
			[modelCell, ctxCell, tokCell, costCell, cwdCell],
			[modelCell, ctxCell, tokCell, null, cwdCell],
			[modelCell, ctxCell, null, null, cwdCell],
			[modelCell, ctxCell, null, null, null],
		];
		let result = join(candidates[0]);
		for (const candidate of candidates) {
			const joined = join(candidate);
			if (visibleWidth(joined) <= width) {
				result = joined;
				break;
			}
		}
		if (visibleWidth(result) > width) {
			result = truncateToWidth(result, width, theme.fg("dim", "…"));
		}

		const lines: string[] = [result];
		if (extensionStatuses.size > 0) {
			const sortedStatuses = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			lines.push(truncateToWidth(sortedStatuses.join(" "), width, theme.fg("dim", "...")));
		}
		return lines;
	}
}
