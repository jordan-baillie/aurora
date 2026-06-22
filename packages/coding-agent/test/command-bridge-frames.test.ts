import type { AssistantMessage } from "@summon/ai";
import { describe, expect, test } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { buildRoleHeader } from "../src/modes/interactive/components/role-divider.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

function createAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("command-bridge transcript frames", () => {
	test("hud role rail: accent [ LABEL ] cell + heavy console rule, fills the width", () => {
		initTheme("command-bridge");
		const a = strip(buildRoleHeader("assistant", 50));
		expect(a.startsWith("[ SUMMON ] ")).toBe(true);
		expect(a).toContain("═"); // boxH heavy rule
		expect([...a].length).toBe(50); // rail fills the full width
		const u = strip(buildRoleHeader("user", 50));
		expect(u.startsWith("[ CMD ] ")).toBe(true);
	});

	test("assistant message under command-bridge renders the hud header rail (not a box)", () => {
		initTheme("command-bridge");
		const lines = new AssistantMessageComponent(createAssistantMessage([{ type: "text", text: "hello" }])).render(50);
		const joined = lines.map(strip).join("\n");
		expect(joined).toContain("[ SUMMON ]");
		expect(joined).not.toContain("╭"); // bracket-rule, not the rounded box frame
		expect(joined).toContain("hello");
	});

	test("input prompt cell: getEditorTheme.promptLabel is the [ CMD » ] cell only under command-bridge", () => {
		initTheme("command-bridge");
		const label = getEditorTheme().promptLabel?.();
		expect(label && strip(label)).toBe("[ CMD » ]");
		initTheme("dark");
		expect(getEditorTheme().promptLabel?.()).toBeUndefined();
	});
});
