// Phase 4 hardening — guard primitives.  node --experimental-strip-types --test test/guard.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { escapesRoot, hitsProtected, isDestructiveCmd } from "../src/core.ts";

test("destructive commands are flagged", () => {
	for (const c of [
		"rm -rf /tmp/x",
		"rm -r foo",
		"sudo rm -rf .",
		"dd if=/dev/zero of=x",
		"mkfs.ext4 /dev/sda",
		"git push origin main",
		"git reset --hard HEAD~3",
		"git clean -fd",
		"chmod -R 777 /",
		":(){ :|:& };:",
		"shutdown now",
		"echo x > /etc/hosts",
		// real /dev devices and system paths must stay flagged
		"echo x > /dev/sda",
		"echo x > /etc/passwd",
		"echo x > /usr/bin/foo",
		"rm -rf /",
	])
		assert.ok(isDestructiveCmd(c), `should flag: ${c}`);
});

test("safe / verification commands are NOT flagged", () => {
	for (const c of [
		"pytest tests/",
		"node --experimental-strip-types --test test/core.test.ts",
		"ruff check src/",
		"git diff",
		"git status",
		"git log -5",
		"ls -la",
		"cat README.md",
		"grep -r foo .",
		"npm test",
	])
		assert.equal(isDestructiveCmd(c), false, `should NOT flag: ${c}`);
});

// Regression: /dev/null and other safe pseudo-devices must NOT be flagged (#10 false-positive fix)
test("/dev pseudo-devices are NOT flagged as destructive (safe redirects)", () => {
	for (const c of [
		"npm test 2>/dev/null",
		"grep foo bar >/dev/null 2>&1",
		"cmd 2>/dev/stderr",
		"echo hi >/dev/stdout",
	])
		assert.equal(isDestructiveCmd(c), false, `should NOT flag: ${c}`);
});

// Regression: real block devices must still be flagged when redirected to (#10 guard integrity)
test("redirects to real /dev block devices are still flagged", () => {
	for (const c of ["echo x > /dev/sda", "echo x > /dev/sdb1"]) assert.ok(isDestructiveCmd(c), `should flag: ${c}`);
});

test("hitsProtected matches protected substrings", () => {
	assert.ok(hitsProtected("cat .env", [".env"]));
	assert.ok(hitsProtected("edit secrets/api.key", ["secrets"]));
	assert.equal(hitsProtected("read src/x.ts", [".env", "secrets"]), false);
	assert.equal(hitsProtected("anything", []), false);
});

test("escapesRoot blocks writes outside the project root (sibling-prefix safe)", () => {
	const root = "/work/repo";
	assert.ok(escapesRoot("/etc/passwd", root));
	assert.ok(escapesRoot("../other/x", root));
	assert.ok(escapesRoot("/work/repo-evil/x", root), "sibling with shared prefix must be OUTSIDE");
	assert.equal(escapesRoot("src/core.ts", root), false);
	assert.equal(escapesRoot("/work/repo/src/x", root), false);
});

// Cross-platform: relative paths must resolve in-root regardless of OS path separator (Windows
// regression — a forward-slash prefix check flagged every in-root path as an escape).
test("escapesRoot resolves relative in-root paths on any platform", () => {
	const root = process.cwd();
	assert.equal(escapesRoot("src/core.ts", root), false);
	assert.equal(escapesRoot("./a/b/c.ts", root), false);
	assert.equal(escapesRoot(".", root), false);
	assert.ok(escapesRoot("../escape.ts", root));
});
