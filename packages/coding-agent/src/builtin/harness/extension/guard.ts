// Harness v2 — worker-side GUARD (Phase 4). Loaded into every write/exec-capable sub-agent via `-e`.
// Blocks, at the tool layer (not by prompt convention): destructive bash, and write/edit to protected
// paths or outside the project root. Reads its policy from env set by core.spawnAgent.
import type { ExtensionAPI } from "../../../index.ts";
import { escapesRoot, hitsProtected, isDestructiveCmd } from "../src/core.ts";
import { validateContent } from "../src/validate.ts";

const ROOT = process.env.HARNESS_ROOT || process.cwd();

// HARNESS_PROTECTED is JSON-encoded by core.spawnEnv (so colon-bearing Windows paths survive); fall back
// to the legacy ":"-joined form for forward-compat with an older spawner.
function parseProtected(raw: string | undefined): string[] {
	if (!raw) return [];
	try {
		const v = JSON.parse(raw);
		return Array.isArray(v) ? v.filter((x: unknown): x is string => typeof x === "string") : [];
	} catch {
		return raw.split(":").filter(Boolean);
	}
}
const PROTECTED = parseProtected(process.env.HARNESS_PROTECTED);

export default function guard(summon: ExtensionAPI) {
	summon.on("tool_call", async (event: any) => {
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
			// Shift-feedback-left (#6): reject a syntactically broken full-content write at the tool layer,
			// surfacing the exact parser error so the agent fixes it now (not in a later verify/CI step).
			const content = input.content;
			if (name === "write" && path && typeof content === "string") {
				const v = validateContent(path, content);
				if (!v.ok)
					return {
						block: true,
						reason: `harness-guard: ${v.checker} syntax error in ${path} — ${v.error ?? "invalid"}`,
					};
			}
		}
	});
}
