// Offline unit tests for shift-left write validation (#6). Run:
//   node --experimental-strip-types --test test/validate.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { validateContent, validateJson, validatePython, validatorKind } from "../src/validate.ts";

test("validatorKind dispatches by extension", () => {
	assert.equal(validatorKind("a/b/config.json"), "json");
	assert.equal(validatorKind("script.py"), "python");
	assert.equal(validatorKind("mod.ts"), "skip");
	assert.equal(validatorKind("README.md"), "skip");
	assert.equal(validatorKind("Makefile"), "skip");
});

test("validateJson accepts valid JSON and rejects malformed with an error", () => {
	assert.equal(validateJson('{"a":1,"b":[2,3]}').ok, true);
	const bad = validateJson('{"a":1,}');
	assert.equal(bad.ok, false);
	assert.equal(bad.checker, "json");
	assert.ok(bad.error && bad.error.length > 0, "must carry the parser error");
});

test("validateContent never flags VALID content (zero false positives) and skips unknown types", () => {
	assert.equal(validateContent("x.json", '{"ok":true}').ok, true);
	assert.equal(validateContent("x.json", "not json").ok, false);
	// a type we don't validate must always pass (never block a good write)
	assert.equal(validateContent("x.ts", "const x = { a: '}' };").ok, true);
	assert.equal(validateContent("x.ts", "garbage ){{").ok, true, "unsupported types are skipped, not flagged");
});

test("validatePython is exact when available and skips gracefully when not", () => {
	const okRes = validatePython("x = 1\nprint(x)\n");
	// Either python validated it (ok:true, checker 'python') or python is unavailable (skipped, ok:true).
	assert.equal(okRes.ok, true);
	if (okRes.checker === "python") {
		// interpreter present → a real syntax error must be caught
		const bad = validatePython("def f(:\n  pass\n");
		assert.equal(bad.ok, false);
		assert.equal(bad.checker, "python");
	} else {
		assert.equal(okRes.checker, "python:unavailable");
	}
});
