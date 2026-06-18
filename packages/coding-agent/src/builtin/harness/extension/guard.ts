// Harness v2 — worker-side GUARD (Phase 4). Loaded into every write/exec-capable sub-agent via `-e`.
// Blocks, at the tool layer (not by prompt convention): destructive bash, and write/edit to protected
// paths or outside the project root. Reads its policy from env set by core.spawnAgent.
import type { ExtensionAPI } from "../../../index.ts";
import { escapesRoot, hitsProtected, isDestructiveCmd } from "../src/core.ts";

const ROOT = process.env.HARNESS_ROOT || process.cwd();
const PROTECTED = (process.env.HARNESS_PROTECTED || "").split(":").filter(Boolean);

export default function guard(pi: ExtensionAPI) {
	pi.on("tool_call", async (event: any) => {
		const name = event.toolName;
		const input = event.input ?? event.args ?? {};

		if (name === "bash") {
			const cmd = String(input.command ?? "");
			if (isDestructiveCmd(cmd))
				return { block: true, reason: `harness-guard: destructive bash blocked — ${cmd.slice(0, 70)}` };
			if (hitsProtected(cmd, PROTECTED))
				return { block: true, reason: `harness-guard: bash touches a protected path — ${cmd.slice(0, 70)}` };
		}

		if (name === "write" || name === "edit") {
			const path = String(input.path ?? input.file ?? "");
			if (path && hitsProtected(path, PROTECTED))
				return { block: true, reason: `harness-guard: write to protected path blocked — ${path}` };
			if (path && escapesRoot(path, ROOT))
				return { block: true, reason: `harness-guard: write outside project root blocked — ${path}` };
		}
	});
}
