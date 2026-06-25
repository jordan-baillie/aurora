<p align="center">
  <img src="docs/banner.svg" alt="Summon — the orchestrated coding agent" width="612"/>
</p>

<p align="center">
  <b>An agent harness you can scale.</b> A coding agent with a built-in specialised sub-agent delegation harness and a premium neon TUI — one command: <code>summon</code>.
</p>

<p align="center"><i>Summon agents. Give them goals. Watch the work fan out.</i></p>

---

Summon is a coding agent that can **decompose a goal, write metaprompts, and fan the work out to
specialised, tool-restricted, model-tiered sub-agents in parallel** — with output-contract validation,
deterministic verification, a window-budget governor, safety guards, a live multi-agent dashboard,
named team recipes, and an optional warm worker pool. It looks like Summon out of the box: a sub-zero
gradient `SUMMON` wordmark, rounded box tool-cards, bordered messages, breathing gradient spinner.

> **Cost model:** Summon is **bring-your-own-provider**. Sub-agents spawn `summon` subprocesses that
> resolve the same credentials as your interactive session — typically an Anthropic API key
> (`ANTHROPIC_API_KEY` or `/login`). Summon adds no separate key and ships no subscription login: you
> authenticate with your own provider account, exactly like any other CLI.
>
> Self-hosting operators who are entitled to use subscription/OAuth routing can opt in by registering
> it as a local extension and setting `SUMMON_FORCE_OAUTH_ROUTING=1` (which then ejects
> `ANTHROPIC_API_KEY` from worker env and fails closed). This is off by default — see
> [docs/providers.md](docs/providers.md).

---

## Install

Requires **Node ≥ 22** and **npm ≥ 10**.

```bash
git clone https://github.com/jordan-baillie/summon.git summon
cd summon
npm run setup            # install + build + put `summon` on your PATH
```

`npm run setup` is the one-command path on every OS. Prefer a script? Run `./install.sh`
(macOS/Linux/Git-Bash) or `powershell -ExecutionPolicy Bypass -File install.ps1` (Windows).

Then start it and connect your provider:

```bash
summon                   # start the TUI
# then, inside Summon, run once:
/login                   # store an API key for your provider (e.g. Anthropic)
```

You can also just export `ANTHROPIC_API_KEY` (or your provider's key) before launching. `/login` is a
slash-command **inside** the running app, not a shell command. Config lives in `~/.summon/`. Your
normal tooling is untouched.

> **`summon` not found after setup?** Your npm global bin directory isn't on your PATH. Run
> `npm prefix -g`, add that directory to your PATH, and reopen your terminal. (`npm run setup` prints a
> warning if this happens.)

> **Windows:** Summon's deterministic `verify` step and the `bash` tool use Git Bash. Install
> [Git for Windows](https://git-scm.com/download/win) so `bash` is on your PATH.

The build is **hermetic and reproducible** — the model catalog (`packages/ai/src/*.generated.ts`) is
committed, so `npm run build` needs no network. Maintainers refresh it with `npm run refresh-models`.

## What you get

- **The agent** — `summon`: read / bash / edit / write tools, sessions, a polished interactive TUI.
- **The harness, built in** (zero setup): the `spawn_agent` tool family is auto-loaded —
  - `spawn_agent({ agent, prompt })` — delegate one task to a specialist.
  - `spawn_agents({ tasks: [...] })` — parallel fan-out (adaptive warm-pool for big batches).
  - `run_team({ team, vars })` — named recipes: sequential stages, parallel steps.
  - `run_blueprint({ blueprint, vars })` — a **code-defined DAG**: deterministic shell *code nodes*
    interleaved with scoped *agent nodes*, run with continuous wide parallelism and fail-closed
    dependent skipping (the LLM only runs inside the contained agent nodes).
  - `orchestrate({ goal })` — the one-call **plan + run + verify** primitive: synthesises a DAG from a
    goal and runs the agent work in parallel; deterministic shell steps pause for your approval.
  - a live multi-agent **TUI dashboard** (`/harness-drill`, `/harness-web`).
- **The Summon look** — the `summon` theme is the default; switch anytime with `summon themes <name>`.

## Orchestration mode

The harness tools are always loaded, but a coding agent only fans out if something tells it *when* to.
Summon injects a **delegate-by-default doctrine** — plus the live specialist roster and saved-recipe
catalog — into the main session every turn, so substantial work is decomposed and fanned out instead of
done alone. Three intensities, set with `SUMMON_ORCHESTRATION` or switched live with `/orchestrate`:

- **`off`** — no doctrine; the plain agent (the pre-mode behaviour).
- **`auto`** (default) — delegate substantial / parallelisable / open-ended work; stay solo for trivial edits.
- **`ultra`** — standing opt-in: decompose + fan out + adversarially verify *every* substantial task; cost
  is not the constraint.

`/orchestrate` with no argument shows the current mode; `/orchestrate off|auto|ultra` switches it live.

## Specialists (built-in registry)

| agent | tier | tools | output contract |
|---|---|---|---|
| `scout` | fast | read · grep · find · ls | `## findings` + `## confidence` |
| `builder` | standard | read · edit · write · bash · grep · find · ls | `## change-summary` + `## verification` |
| `reviewer` | fast | read · grep · find · ls · bash | `## verdict` + `## claims` + `## could-not-verify` |
| `orchestrator` | frontier | read · grep · find · ls + spawn tools | `## delegated` + `## synthesis` |

A **load-time, fail-closed validator** rejects unsafe shapes (an orchestrator with write/bash; a
worker with any delegation tool; a write-capable bundle scoped into a protected path). Workers are
spawned with a strict `--tools` allowlist, so sub-agents never get delegation tools.

**Add a specialist** = drop an `agent.json` + `SKILL.md` in
`packages/coding-agent/src/builtin/harness/agents/<name>/`, or per-project in `<project>/.summon/agents/`.
Teams live alongside in `…/harness/teams/` or `<project>/.summon/teams/`.

## Safety (trustable headless)
- **Deterministic verify** — `spawn_agent({ verify: "<cmd>" })`; the harness runs the acceptance
  command itself and a failure overrides the agent's own claim.
- **Fail-closed spawn auth** — every spawn requires a non-empty system prompt and verifies auth before
  exec. Optional `SUMMON_FORCE_OAUTH_ROUTING=1` (self-hosting opt-in) additionally ejects
  `ANTHROPIC_API_KEY` and fails closed so a forced-subscription deployment can never silently bill
  pay-per-token. Off by default — the shipped product is bring-your-own-key.
- **Cross-platform spawn** — sub-agents launch via the running Node runtime (PATH-independent), so the
  harness works identically on Windows and POSIX.
- **Window-aware governor** — caps concurrent weight and tracks consumption against a configurable
  rolling usage window; `HARNESS_WINDOW_TOKENS` opts into a hard window gate.
- **Tool-layer guard** — every write/exec-capable worker blocks destructive bash and writes outside
  the project root / into protected paths (separator-agnostic, correct on Windows and POSIX).
- **Within-run result cache + dedup** — identical read-only sub-tasks collapse to one execution.
  Disable with `HARNESS_NO_CACHE=1`.
- **Multi-reviewer adversarial verification** — `spawn_agent({ review: true })` fans out to N independent
  reviewers (odd default 3, 5 in `ultra`; override with `reviewers`, capped by `HARNESS_REVIEWERS_MAX`),
  each on a distinct lens (correctness / regressions / tests); the build fails closed unless a strict
  majority APPROVEs.
- **Fleet observability** — a cross-run spawn ledger (cost-per-agent-hour, done/cache-hit rates,
  rendered to `~/.summon/harness/fleet-summary.md`) plus a boot prompt audit that flags skill-bloat.

## Configuration (all optional)
`SUMMON_CODING_AGENT_DIR` (config home, default `~/.summon`), `SUMMON_MODEL` / `SUMMON_BIN`,
`SUMMON_ORCHESTRATION` (`off`|`auto`|`ultra`, default `auto` — the delegate-by-default intensity),
`HARNESS_AGENTS_DIR` / `HARNESS_TEAMS_DIR` / `HARNESS_BLUEPRINTS_DIR`, `HARNESS_POOL_SIZE`,
`HARNESS_PREWARM` (comma-sep bundles to stand up hot at startup), `HARNESS_WINDOW_TOKENS` (>0 turns on
a hard rolling-window gate), `HARNESS_REVIEWERS_MAX` (cap on multi-reviewer fan-out, default 7). The
harness model tiers default to Claude Opus / Sonnet / Haiku.

## Layout
```
packages/                         the agent engine (tui · ai · agent · coding-agent)
packages/coding-agent/            the `summon` CLI
  src/builtin/extensions/         built-in, auto-loaded extensions (the harness tools + dashboard)
  src/builtin/harness/            the harness: registry · validator · spawn · governor · pool · teams
  src/modes/interactive/theme/    themes incl. summon (default) + harness
SPEC.md                           full system specification
NOTICE / LICENSE                  built on Pi (MIT); see below
```

## Built on Pi
Summon is built on the [Pi coding agent](https://github.com/badlogic/pi-mono) (MIT © Mario Zechner).
See [`NOTICE`](NOTICE) and [`LICENSE`](LICENSE).

## License
MIT — see [LICENSE](LICENSE).
