// End-to-end proof that the orchestration MODE actually reaches the model: the REAL harness extension
// is loaded into a real AgentSession (faux provider, zero tokens), a turn is run, and we assert the
// delegate-by-default doctrine is present in (or absent from) the system prompt the provider receives.
// This is the smoke test for "does the injected doctrine actually get to the model" — deterministic,
// no real spend, and a permanent regression guard for the before_agent_start wiring.

import { fauxAssistantMessage } from "@summon/ai";
import { afterEach, describe, expect, it } from "vitest";
import harnessExtension from "../../src/builtin/harness/extension/spawn-agent.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("orchestration doctrine injection (real harness extension, real session)", () => {
	const harnesses: Harness[] = [];
	// Read at extension-registration time, so set before createHarness and restore after each test.
	const ENV_KEYS = ["SUMMON_ORCHESTRATION", "HARNESS_AUTOSCALE", "HARNESS_DURABLE"] as const;
	const saved: Record<string, string | undefined> = {};

	function setMode(mode: string): void {
		for (const k of ENV_KEYS) saved[k] = process.env[k];
		process.env.SUMMON_ORCHESTRATION = mode;
		process.env.HARNESS_AUTOSCALE = "0"; // no FleetController timer under test
		process.env.HARNESS_DURABLE = "0"; // no run journaling / resumable-run fs scan under test
	}

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		for (const k of ENV_KEYS) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	});

	// Run one turn and return the system prompt the faux provider was actually given.
	async function systemPromptForMode(mode: string): Promise<string> {
		setMode(mode);
		const harness = await createHarness({ extensionFactories: [harnessExtension] });
		harnesses.push(harness);
		let captured = "";
		harness.setResponses([
			(context) => {
				captured = context.systemPrompt ?? "";
				return fauxAssistantMessage("ok");
			},
		]);
		await harness.session.prompt("hi");
		return captured;
	}

	it("auto (the default) injects the delegate-by-default doctrine into the model's system prompt", async () => {
		const sys = await systemPromptForMode("auto");
		expect(sys).toContain("# Orchestration mode: AUTO");
		expect(sys).toContain("spawn_agents"); // the wide fan-out tool is named
		expect(sys).toContain("never just one reviewer"); // adversarial-verify policy present
		expect(sys).toContain("Specialists ("); // the live roster is injected
	});

	it("ultra injects the standing-opt-in doctrine", async () => {
		const sys = await systemPromptForMode("ultra");
		expect(sys).toContain("# Orchestration mode: ULTRA");
		expect(sys).toMatch(/EVERY substantial task/i);
	});

	it("off leaves the system prompt free of orchestration doctrine but otherwise intact", async () => {
		const sys = await systemPromptForMode("off");
		expect(sys).not.toContain("# Orchestration mode");
		expect(sys.length).toBeGreaterThan(0); // the base prompt is still delivered
	});
});
