import type { AssistantMessage } from "@summon/ai";
import { Container, Markdown, type MarkdownTheme, Spacer, Text } from "@summon/tui";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { MessageBoxFrame } from "./box-frame.ts";
import { RoleHeaderComponent } from "./role-divider.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a complete assistant message.
 *
 * Branches on `theme.messageStyle()`:
 *  - "fill"    (dark/light): current behavior — paddingX=1 Markdown, no header.
 *  - "rule"    (editorial):  role-label + hr rule header, then the body.
 *  - "bracket" (brutalist):  --[ pi ]-- header, then the body.
 *  - "box"     (summon):     full rounded box around the body, accent role label.
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	updateContent(message: AssistantMessage): void {
		this.lastMessage = message;

		// Clear content container
		this.contentContainer.clear();

		const hasVisibleContent = message.content.some(
			(c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);

		// In "box" mode the whole body is collected into a sub-container, then sealed inside a
		// MessageBoxFrame; the role label lives in the box's top border (no separate header line).
		// `target` is where body children go: the box body for "box", else contentContainer directly.
		const style = theme.messageStyle();
		const useBox = style === "box" && hasVisibleContent;
		const target: Container = useBox ? new Container() : this.contentContainer;
		// Box bodies sit flush inside the "│ " edge (matches tool cards); other styles keep paddingX=1.
		const padX = useBox ? 0 : 1;

		if (hasVisibleContent) {
			if (style !== "fill" && style !== "box") {
				// ── Rule / Bracket: editorial + brutalist ────────────────────
				// Role-label header line (CLAUDE ───── or --[ pi ]──)
				this.contentContainer.addChild(new RoleHeaderComponent("assistant"));
			}
			if (!useBox) {
				// Leading blank line — spacing above body for fill / rule / bracket.
				this.contentContainer.addChild(new Spacer(1));
			}
		}

		// Render content in order
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				target.addChild(new Markdown(content.text.trim(), padX, 0, this.markdownTheme));
			} else if (content.type === "thinking" && content.thinking.trim()) {
				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

				if (this.hideThinkingBlock) {
					// Show static thinking label when hidden
					target.addChild(new Text(theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)), padX, 0));
					if (hasVisibleContentAfter) {
						target.addChild(new Spacer(1));
					}
				} else {
					// Thinking traces in thinkingText color, italic
					target.addChild(
						new Markdown(content.thinking.trim(), padX, 0, this.markdownTheme, {
							color: (text: string) => theme.fg("thinkingText", text),
							italic: true,
						}),
					);
					if (hasVisibleContentAfter) {
						target.addChild(new Spacer(1));
					}
				}
			}
		}

		// Check if aborted - show after partial content
		// But only if there are no tool calls (tool execution components will show the error)
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				target.addChild(new Spacer(1));
				target.addChild(new Text(theme.fg("error", abortMessage), padX, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				target.addChild(new Spacer(1));
				target.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), padX, 0));
			}
		}

		// Seal the box around the collected body (summon). The role label lives in the top border.
		if (useBox) {
			this.contentContainer.addChild(
				new MessageBoxFrame(target, {
					label: theme.roleLabel("assistant").toUpperCase(),
					borderColor: "borderAccent",
					labelColor: "toolTitle",
				}),
			);
			this.contentContainer.addChild(new Spacer(1));
		}
	}
}
