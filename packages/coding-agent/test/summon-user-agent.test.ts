import { describe, expect, it } from "vitest";
import { getSummonUserAgent } from "../src/utils/summon-user-agent.ts";

describe("getSummonUserAgent", () => {
	it("formats the user agent expected by summon", () => {
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		const userAgent = getSummonUserAgent("1.2.3");

		expect(userAgent).toBe(`summon/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(/^summon\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});
});
