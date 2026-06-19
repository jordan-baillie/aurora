import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcOAuth = fileURLToPath(new URL("../ai/src/oauth.ts", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("../agent/src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		// The harness suite is authored against `node:test` (it must run standalone under
		// --experimental-strip-types); it runs via the `test:harness` script, not vitest.
		exclude: [...configDefaults.exclude, "src/builtin/harness/test/**"],
		server: {
			deps: {
				external: [/@silvia-odwyer\/photon-node/],
			},
		},
	},
	resolve: {
		alias: [
			{ find: /^@summon\/ai$/, replacement: aiSrcIndex },
			{ find: /^@summon\/ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@summon\/agent-core$/, replacement: agentSrcIndex },
		],
	},
});
