import { describe, expect, it } from "vitest";
import { getOAuthProvider, getOAuthProviders, resetOAuthProviders } from "../src/utils/oauth/index.ts";

// Regression guard: summon must NOT ship a built-in Anthropic (Claude Pro/Max) subscription OAuth
// provider. Logging a redistributed tool into a personal Claude subscription is outside Anthropic's
// terms, so the default product is BYO-API-key. Operators who are entitled to subscription auth can
// register it themselves via a local extension: pi.registerProvider("anthropic", { oauth: {...} }).
//
// If this test fails because someone re-added `anthropicOAuthProvider` to BUILT_IN_OAUTH_PROVIDERS,
// that is the bug — move the login flow back out into a local extension instead of relaxing the test.
describe("built-in OAuth provider registry", () => {
	it("does not include an Anthropic subscription OAuth provider", () => {
		resetOAuthProviders();
		const ids = getOAuthProviders().map((p) => p.id);
		expect(ids).not.toContain("anthropic");
		expect(getOAuthProvider("anthropic")).toBeUndefined();
	});

	it("still ships the non-Anthropic built-ins", () => {
		resetOAuthProviders();
		const ids = getOAuthProviders().map((p) => p.id);
		expect(ids).toContain("github-copilot");
		expect(ids).toContain("openai-codex");
	});
});
