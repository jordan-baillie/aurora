// Integration smoke — prove the harness can actually LAUNCH a sub-agent subprocess on THIS platform.
// Regression guard for the Windows C1 bug: the harness used to `spawn("summon", …)`, which ENOENTs
// against the `summon.cmd` npm shim because Node cannot exec a `.cmd` without a shell.
// agentSpawnCommand() now self-spawns via the Node runtime + the resolved CLI entry, so a real launch
// works without any PATH shim. We invoke `--version` (no auth, no network) and assert it runs.
//   node --experimental-strip-types --test test/spawn-smoke.test.ts

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { agentSpawnCommand } from "../src/paths.ts";

test("agentSpawnCommand launches the CLI subprocess (--version) without ENOENT", async () => {
	const { cmd, prefix } = agentSpawnCommand();
	const output: string = await new Promise((resolve, reject) => {
		const child = spawn(cmd, [...prefix, "--version"], { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		const kill = setTimeout(() => child.kill("SIGKILL"), 60_000);
		child.stdout.on("data", (d) => {
			out += d.toString();
		});
		child.stderr.on("data", (d) => {
			out += d.toString(); // --version writes to stderr
		});
		child.on("error", reject); // an ENOENT (the C1 bug) surfaces here
		child.on("close", () => {
			clearTimeout(kill);
			resolve(out);
		});
	});
	assert.match(
		output,
		/\d+\.\d+\.\d+/,
		`expected a version string from the spawned CLI, got: ${output.slice(0, 200)}`,
	);
});
