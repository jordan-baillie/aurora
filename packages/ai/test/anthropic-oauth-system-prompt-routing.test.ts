import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";
import { streamSimple } from "../src/stream.ts";
import type { Context, Model } from "../src/types.ts";

/**
 * Regression guard for Anthropic Pro/Max subscription routing.
 *
 * Anthropic's subscription classifier inspects the *content* of the `system` field.
 * If the system prompt reveals a non-Claude-Code harness, the request is reclassified
 * as third-party API usage and billed to "extra usage" (pay-per-token) instead of the
 * subscription — surfacing as a 400 "out of extra usage" once that pool is empty.
 *
 * Fix: when OAuth is active, `system` must contain ONLY the Claude Code identity, and the
 * real system prompt must be delivered as a leading user turn (with an assistant ack).
 * These tests lock that wire shape in so it cannot silently regress back into `system`.
 */

const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const AGENT_SYSTEM_PROMPT =
	"You are an expert coding assistant operating inside pi, a coding agent. Follow the project rules.";

interface CapturedPayload {
	system?: Array<{ type: string; text: string }>;
	messages: MessageParam[];
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

async function capturePayload(apiKey: string): Promise<CapturedPayload> {
	const base = getModel("anthropic", "claude-opus-4-7");
	const model: Model<"anthropic-messages"> = { ...base, baseUrl: "http://127.0.0.1:9" };
	const context: Context = {
		systemPrompt: AGENT_SYSTEM_PROMPT,
		messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
	};

	let captured: CapturedPayload | undefined;
	const s = streamSimple(model, context, {
		apiKey,
		onPayload: (payload) => {
			captured = payload as unknown as CapturedPayload;
			throw new PayloadCaptured();
		},
	});
	try {
		for await (const _ of s) {
			// drain
		}
	} catch (err) {
		if (!(err instanceof PayloadCaptured)) {
			// Network/other errors are fine — onPayload fires before the request goes out.
		}
	}
	if (!captured) throw new Error("payload was not captured");
	return captured;
}

describe.sequential("Anthropic OAuth system-prompt routing", () => {
	it("keeps system = Claude Code identity ONLY and moves the agent prompt to a leading user turn (OAuth)", async () => {
		const payload = await capturePayload("sk-ant-oat01-fake-oauth-token");

		// system field must be the identity only — nothing that reveals the harness.
		expect(payload.system).toHaveLength(1);
		expect(payload.system?.[0]?.text).toBe(CLAUDE_CODE_IDENTITY);
		const systemText = (payload.system ?? []).map((b) => b.text).join("\n");
		// The harness-revealing prompt (the part the classifier penalises) must not be in `system`.
		expect(systemText).not.toContain("operating inside pi");
		expect(systemText).not.toContain(AGENT_SYSTEM_PROMPT);

		// The agent system prompt is delivered as the first user turn instead.
		const first = payload.messages[0];
		expect(first.role).toBe("user");
		const firstText =
			typeof first.content === "string"
				? first.content
				: first.content.map((c) => ("text" in c ? c.text : "")).join("");
		expect(firstText).toContain(AGENT_SYSTEM_PROMPT);

		// Followed by an assistant ack to preserve role alternation, then the real user msg.
		expect(payload.messages[1]?.role).toBe("assistant");
		expect(payload.messages[2]?.role).toBe("user");
		const lastText =
			typeof payload.messages[2]?.content === "string"
				? (payload.messages[2]?.content as string)
				: (payload.messages[2]?.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("");
		expect(lastText).toContain("ping");
	});

	it("leaves the agent prompt in the system field for non-OAuth (api-key) auth", async () => {
		const payload = await capturePayload("sk-ant-api03-regular-key");

		// No Claude Code identity spoof; system carries the real prompt; no injected turns.
		expect(payload.system?.[0]?.text).toBe(AGENT_SYSTEM_PROMPT);
		expect(payload.messages[0]?.role).toBe("user");
		const firstText =
			typeof payload.messages[0]?.content === "string"
				? (payload.messages[0]?.content as string)
				: (payload.messages[0]?.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("");
		expect(firstText).toContain("ping");
		expect(firstText).not.toContain(AGENT_SYSTEM_PROMPT);
	});
});
