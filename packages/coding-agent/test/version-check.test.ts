import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	checkForNewPiVersion,
	comparePackageVersions,
	getLatestPiRelease,
	getLatestPiVersion,
	isNewerPackageVersion,
} from "../src/utils/version-check.ts";

const VERSION_URL = "https://updates.example/latest-version";

const originalSkipVersionCheck = process.env.SUMMON_SKIP_VERSION_CHECK;
const originalOffline = process.env.SUMMON_OFFLINE;
const originalVersionUrl = process.env.SUMMON_VERSION_CHECK_URL;

beforeEach(() => {
	// Version checks are opt-in; configure the endpoint so the fetch path is exercised.
	process.env.SUMMON_VERSION_CHECK_URL = VERSION_URL;
});

afterEach(() => {
	vi.unstubAllGlobals();
	for (const [key, original] of [
		["SUMMON_SKIP_VERSION_CHECK", originalSkipVersionCheck],
		["SUMMON_OFFLINE", originalOffline],
		["SUMMON_VERSION_CHECK_URL", originalVersionUrl],
	] as const) {
		if (original === undefined) delete process.env[key];
		else process.env[key] = original;
	}
});

describe("version checks", () => {
	it("compares package versions", () => {
		expect(comparePackageVersions("0.70.6", "0.70.5")).toBeGreaterThan(0);
		expect(comparePackageVersions("0.70.5", "0.70.5")).toBe(0);
		expect(comparePackageVersions("0.70.4", "0.70.5")).toBeLessThan(0);
		expect(isNewerPackageVersion("0.70.5", "0.70.5")).toBe(false);
		expect(isNewerPackageVersion("0.70.6", "0.70.5")).toBe(true);
	});

	it("returns only newer versions", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.3" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		await expect(checkForNewPiVersion("1.2.2")).resolves.toEqual({ version: "1.2.3" });
	});

	it("uses the configured version check api with a summon user agent", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledWith(
			VERSION_URL,
			expect.objectContaining({
				headers: expect.objectContaining({
					"User-Agent": expect.stringMatching(/^summon\/1\.2\.3 /),
					accept: "application/json",
				}),
			}),
		);
	});

	it("returns the active package metadata from the version check api", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({
				packageName: "@new-scope/summon",
				version: "1.2.4",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3")).resolves.toEqual({
			packageName: "@new-scope/summon",
			version: "1.2.4",
		});
	});

	it("returns update notes from the version check api", async () => {
		const fetchMock = vi.fn(async () => Response.json({ note: " **Read this** ", version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3")).resolves.toEqual({ note: "**Read this**", version: "1.2.4" });
	});

	it("skips api calls when version checks are disabled", async () => {
		process.env.SUMMON_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("skips api calls when no version check url is configured", async () => {
		delete process.env.SUMMON_VERSION_CHECK_URL;
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
