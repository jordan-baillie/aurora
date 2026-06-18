// Harness v2 — shift-feedback-left write validation (#6). Runs cheap, EXACT syntax checks on content
// a write-capable worker is about to write, so a syntactically broken file is rejected at the tool
// layer with the parser error fed straight back to the agent (fail fast, locally) instead of surfacing
// much later in an expensive verify/CI step.
//
// Hard rule: a validator must NEVER flag VALID content (zero false positives), or it would block good
// writes. So we only use exact parsers: JSON via JSON.parse (in-process), and Python via
// `py_compile` when an interpreter is available (skipped gracefully otherwise). Languages without a
// safe dependency-free exact check here are intentionally skipped (a naive brace counter would
// false-positive on delimiters inside strings/comments).

import { spawnSync } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

export interface ValidationResult {
	ok: boolean;
	checker: string;
	error?: string;
}

export type ValidatorKind = "json" | "python" | "skip";
export function validatorKind(path: string): ValidatorKind {
	const ext = extname(path).toLowerCase();
	if (ext === ".json") return "json";
	if (ext === ".py") return "python";
	return "skip";
}

export function validateJson(content: string): ValidationResult {
	try {
		JSON.parse(content);
		return { ok: true, checker: "json" };
	} catch (e) {
		return { ok: false, checker: "json", error: e instanceof Error ? e.message : String(e) };
	}
}

function pythonBin(): string | null {
	for (const bin of ["python3", "python"]) {
		try {
			if (spawnSync(bin, ["--version"], { timeout: 4000 }).status === 0) return bin;
		} catch {
			/* not present */
		}
	}
	return null;
}

export function validatePython(content: string): ValidationResult {
	const bin = pythonBin();
	if (!bin) return { ok: true, checker: "python:unavailable" }; // skip gracefully — never block
	const tmp = join(tmpdir(), `harness-validate-${process.pid}-${Date.now()}.py`);
	try {
		writeFileSync(tmp, content);
		const r = spawnSync(bin, ["-m", "py_compile", tmp], { encoding: "utf8", timeout: 15000 });
		if (r.status === 0) return { ok: true, checker: "python" };
		return { ok: false, checker: "python", error: (r.stderr || r.stdout || "py_compile failed").slice(-500) };
	} finally {
		try {
			unlinkSync(tmp);
		} catch {
			/* ignore */
		}
	}
}

// Validate the content a worker is about to write. Unknown types return ok (skip).
export function validateContent(path: string, content: string): ValidationResult {
	switch (validatorKind(path)) {
		case "json":
			return validateJson(content);
		case "python":
			return validatePython(content);
		default:
			return { ok: true, checker: "skip" };
	}
}
