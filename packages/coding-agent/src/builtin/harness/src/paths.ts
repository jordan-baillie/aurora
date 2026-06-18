// paths.ts — single source of truth for where the harness is installed.
//
// Defaults are derived from THIS module's own location (repo root = the parent of `src/`),
// so a fresh `git clone` works anywhere with ZERO configuration. Every path is still
// environment-overridable for advanced layouts (e.g. a split install).
//
//   HARNESS_HOME         -> repo root (overrides the import.meta.url derivation)
//   HARNESS_AGENTS_DIR     -> registry of specialist bundles   (default <root>/agents)
//   HARNESS_TEAMS_DIR      -> named team recipes               (default <root>/teams)
//   HARNESS_BLUEPRINTS_DIR -> code-defined DAG recipes          (default <root>/blueprints)
//   HARNESS_THEMES_DIR     -> canonical theme files            (default <root>/themes)
//
// Re-export shims (e.g. ~/.pi/agent/extensions/aurora-spawn.ts) resolve to the REAL module
// URL under ESM, so REPO_ROOT stays correct no matter where the shim lives.

import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = process.env.HARNESS_HOME
	? resolve(process.env.HARNESS_HOME)
	: resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const AGENTS_DIR = process.env.HARNESS_AGENTS_DIR ?? join(REPO_ROOT, "agents");
export const TEAMS_DIR = process.env.HARNESS_TEAMS_DIR ?? join(REPO_ROOT, "teams");
export const BLUEPRINTS_DIR = process.env.HARNESS_BLUEPRINTS_DIR ?? join(REPO_ROOT, "blueprints");
export const THEMES_DIR = process.env.HARNESS_THEMES_DIR ?? join(REPO_ROOT, "themes");

// The branded agent binary the harness spawns for sub-agents (env-overridable).
export const AGENT_BIN = process.env.AURORA_BIN ?? "aurora";

// Config/state home (matches the engine: AURORA_CODING_AGENT_DIR / PI_CODING_AGENT_DIR, default ~/.aurora).
export const CONFIG_HOME =
	process.env.AURORA_CODING_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".aurora");
// Where the harness writes the generated registry index (the orchestrator's machine-readable roster).
export const REGISTRY_INDEX = join(CONFIG_HOME, "harness", "registry-index.json");
// Fleet-level observability (#8): cross-run spawn ledger + the rendered digest.
export const FLEET_LEDGER = join(CONFIG_HOME, "harness", "fleet.jsonl");
export const FLEET_SUMMARY = join(CONFIG_HOME, "harness", "fleet-summary.md");
