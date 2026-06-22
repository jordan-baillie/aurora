import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

function createSettingsManager(warnings: { anthropicExtraUsage?: boolean } = {}) {
	return {
		getWarnings: vi.fn().mockReturnValue(warnings),
	};
}

describe("InteractiveMode.maybeWarnAboutAnthropicSubscriptionAuth", () => {
	test("warns once when Anthropic subscription auth is detected", async () => {
		const fakeThis: any = {
			anthropicSubscriptionWarningShown: false,
			settingsManager: createSettingsManager({ anthropicExtraUsage: true }),
			session: {
				modelRegistry: {
					authStorage: {
						get: vi.fn().mockReturnValue(undefined),
					},
					getApiKeyForProvider: vi.fn().mockResolvedValue("sk-ant-oat01-test"),
				},
			},
			showWarning: vi.fn(),
		};

		await (InteractiveMode as any).prototype.maybeWarnAboutAnthropicSubscriptionAuth.call(fakeThis, {
			provider: "anthropic",
		});
		await (InteractiveMode as any).prototype.maybeWarnAboutAnthropicSubscriptionAuth.call(fakeThis, {
			provider: "anthropic",
		});

		expect(fakeThis.showWarning).toHaveBeenCalledTimes(1);
		expect(fakeThis.session.modelRegistry.getApiKeyForProvider).toHaveBeenCalledTimes(1);
	});

	test("warns when Anthropic OAuth is stored even if token refresh lookup would fail", async () => {
		const fakeThis: any = {
			anthropicSubscriptionWarningShown: false,
			settingsManager: createSettingsManager({ anthropicExtraUsage: true }),
			session: {
				modelRegistry: {
					authStorage: {
						get: vi.fn().mockReturnValue({ type: "oauth" }),
					},
					getApiKeyForProvider: vi.fn().mockResolvedValue(undefined),
				},
			},
			showWarning: vi.fn(),
		};

		await (InteractiveMode as any).prototype.maybeWarnAboutAnthropicSubscriptionAuth.call(fakeThis, {
			provider: "anthropic",
		});

		expect(fakeThis.showWarning).toHaveBeenCalledTimes(1);
		expect(fakeThis.session.modelRegistry.getApiKeyForProvider).not.toHaveBeenCalled();
	});

	test("does not warn for non-Anthropic models", async () => {
		const fakeThis: any = {
			anthropicSubscriptionWarningShown: false,
			settingsManager: createSettingsManager(),
			session: {
				modelRegistry: {
					authStorage: {
						get: vi.fn(),
					},
					getApiKeyForProvider: vi.fn(),
				},
			},
			showWarning: vi.fn(),
		};

		await (InteractiveMode as any).prototype.maybeWarnAboutAnthropicSubscriptionAuth.call(fakeThis, {
			provider: "openai",
		});

		expect(fakeThis.showWarning).not.toHaveBeenCalled();
		expect(fakeThis.session.modelRegistry.getApiKeyForProvider).not.toHaveBeenCalled();
	});

	test("warns by default when not configured (subscription auth may draw billed extra usage)", async () => {
		// summon defaults to bring-your-own-key and does not assume a $0 subscription, so the
		// upstream extra-usage warning is opt-out: it fires unless explicitly disabled.
		const fakeThis: any = {
			anthropicSubscriptionWarningShown: false,
			settingsManager: createSettingsManager(), // no warnings configured -> default on
			session: {
				modelRegistry: {
					authStorage: { get: vi.fn().mockReturnValue({ type: "oauth" }) },
					getApiKeyForProvider: vi.fn(),
				},
			},
			showWarning: vi.fn(),
		};

		await (InteractiveMode as any).prototype.maybeWarnAboutAnthropicSubscriptionAuth.call(fakeThis, {
			provider: "anthropic",
		});

		expect(fakeThis.showWarning).toHaveBeenCalledTimes(1);
	});

	test("does not warn when Anthropic extra usage warning is explicitly disabled", async () => {
		const fakeThis: any = {
			anthropicSubscriptionWarningShown: false,
			settingsManager: createSettingsManager({ anthropicExtraUsage: false }),
			session: {
				modelRegistry: {
					authStorage: {
						get: vi.fn(),
					},
					getApiKeyForProvider: vi.fn(),
				},
			},
			showWarning: vi.fn(),
		};

		await (InteractiveMode as any).prototype.maybeWarnAboutAnthropicSubscriptionAuth.call(fakeThis, {
			provider: "anthropic",
		});

		expect(fakeThis.showWarning).not.toHaveBeenCalled();
		expect(fakeThis.session.modelRegistry.authStorage.get).not.toHaveBeenCalled();
		expect(fakeThis.session.modelRegistry.getApiKeyForProvider).not.toHaveBeenCalled();
	});
});
