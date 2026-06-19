# Summon — full system specification

Summon is a single branded product — one `summon` command — made of two layers that ship together in
this one repo:

- **The engine** — the agent itself (built on the Pi coding agent, MIT; see NOTICE), white-labeled to
  `summon`: config home `~/.summon`, the summon theme as the default look, and the full neon TUI
  rendering (theme abstraction, gradient wordmark banner, rounded ascii-box tool cards, bordered
  messages, a jitter-free animator, a session card).
- **The harness** — a first-party delegation runtime bundled as a **built-in extension**: the
  `spawn_agent` tool family that runs specialised, tool-restricted, model-tiered sub-agents with
  output-contract validation, deterministic verification, a window-budget governor, safety guards, a
  live multi-agent dashboard, named teams, and an optional warm worker pool. Auto-loaded with zero
  setup; sub-agents are spawned as `summon`.

This document is the complete specification of both.

---

## Part A — The harness

### A.1 Registry (L0)
Each specialist is a config bundle in `agents/<name>/`:
- `agent.json` — `{ name, role, model_tier (fast|standard|frontier), tools[], skills?[],
  context_globs?[], output_contract{ required_sections[], forbidden?[], max_tokens? },
  max_attempts?, timeout_s?, may_spawn? }`
- `SKILL.md` — the agent's system skill (folded into its prompt).

Model tiers map to concrete models in `src/core.ts` (`MODEL`): fast→haiku, standard→sonnet,
frontier→opus (overridable — see A.9). The seed registry: **scout** (fast, read-only recon),
**builder** (standard, minimal-diff implement + self-verify), **reviewer** (fast, independent claim
verifier), **orchestrator** (frontier, delegate-only).

**Effective registry = global (`agents/`) + project-local (`<project>/.summon/agents/`)**, the latter
overriding by name. Resolved by walking up from `cwd` to the nearest `.harness.json`/`.git`.

**Registry awareness (the orchestrator's roster).** At load the harness builds a compact digest
(`registryDigest` — `name[tier; tools; ->contract]` per specialist) and injects it into the
`spawn_agent`/`spawn_agents` tool descriptions: this is the *authoritative*, always-present roster (no
file read, never stale). It also writes a content-hashed machine-readable index (`registryIndex` →
`~/.summon/harness/registry-index.json`, idempotent by hash, best-effort) for humans/tooling and for
an orchestrator that wants full `role` detail.

### A.2 Fail-closed validator
Runs at load (`validateBundle`). Rejects unsafe shapes structurally:
- an orchestrator (`may_spawn`) holding `write`/`edit`/`bash` (it delegates, never executes);
- a worker holding **any** delegation tool (`spawn_agent`/`spawn_agents`/`run_team`) — no recursive
  delegation;
- a write-capable bundle scoped into a **protected path** (`DEFAULT_PROTECTED` = `.env`, `/.git/`,
  `secrets`, `credentials`, `.pem`, `.key`, `id_rsa`, `id_ed25519`; plus a project's own
  `.harness.json` `protected[]`).

### A.3 Spawn + output-contract check
`spawnAgent` builds the worker system prompt (role + skill + expertise + the contract as explicit
required sections), spawns a `summon` subprocess with `ANTHROPIC_API_KEY` ejected (forces $0 OAuth
routing through the user's Claude subscription), captures the result, and checks the output contract
(`checkContract`): every `required_section` heading must be present and no `forbidden` string may
appear. A contract miss marks the result failed.

### A.4 Window-aware governor
`WindowGovernor` enforces a max concurrent **weight** (`max_weight`, default 8, per-project override in
`.harness.json`; frontier spawns weigh more than fast). Fan-out beyond the budget queues; independent
tasks run concurrently up to the cap. It also **tracks estimated token consumption inside the
Claude-Max rolling 5h window** (`record`/`consumed`/`windowPct`, surfaced to observability). Setting
`HARNESS_WINDOW_TOKENS > 0` turns on a hard window gate — `admit()` also queues once the rolling-window
budget is exhausted, draining as old usage ages out; the default (`0`) tracks + surfaces only and never
hangs a session. Token cost is an estimate (~4 chars/token over prompt + output bytes), labelled as
such — a proxy that beats count-only gating without claiming provider-exact accuracy.

### A.5 Bounded retry + expertise
- `max_attempts` (default 1): on a non-`done`/contract-fail result, re-run up to N times, folding the
  prior failure back into the next prompt (shift-feedback-left), then escalate.
- `context_globs`: files matched relative to the bundle dir are read and folded into the worker's
  prompt as a bounded `## Expertise context` block.
- **Persistent expertise (#7)** — a bundle with `expertise: true` gets a self-maintained
  `expertise.md`: the harness reads it into the worker's prompt at boot (newest notes kept) and, on a
  successful run, appends the worker's optional `## expertise` self-note (`parseExpertiseNote` →
  `appendExpertiseNote`, deduped + capped). The agent owns the file; lessons compound across runs.
  Enabled on read-only seeds (`scout`); generated files are git-ignored.

### A.5b Within-run result cache + dedup (#5)
Identical sub-tasks (same agent + model + tools + prompt + verify, `cacheKey`) collapse to ONE
execution: concurrent duplicates share one in-flight promise and a completed result is reused for
later identical calls in the session (`ResultCache`). **Only read-only agents are cacheable**
(`isCacheable`) — caching a write/edit/bash agent would return its artifact without re-applying its
side effects, so a side-effecting agent always runs. Cache hits/dedups cost no window tokens. Disable
with `HARNESS_NO_CACHE=1`.

### A.6 Transports
- `"oneshot"` (default) — a cold `summon -p` per task.
- `"pool"` — a reused warm `summon --mode rpc` worker, context reset via `new_session` between tasks
  (`src/pool.ts` + `src/rpc-worker.ts`; idle-reuse, grow-to-size, drop-unhealthy, drain).
Both apply the identical contract + deterministic-verify gating (single-sourced `finalizeResult`).
`spawn_agents` uses an **adaptive default**: same-agent batches of ≥8 tasks auto-use the pool
(benchmarked ~30–47% faster via reuse across waves; see `bench/`), else oneshot. Override per call.

**Pre-warm (kill the cold-start tax).** `HARNESS_PREWARM=scout,builder` stands up `HARNESS_POOL_SIZE`
idle `summon --mode rpc` workers per named bundle at session start (`prewarm()`, fire-and-forget, drained
on shutdown) — Stripe's "hot-and-ready" devbox model at the process level. A pre-warmed bundle is then
routed to its hot pool at **any** batch size (`pickTransport(..., isPrewarmed(agent))`), since the
adaptive ≥8 threshold only existed to amortise cold start; `run_team`/`run_blueprint` benefit
automatically.

### A.7 Safety (trustable headless)
- **Deterministic verify** — `verify: "<cmd>"`; the harness runs the acceptance command itself and a
  failure overrides the agent's own claim (`verify_failed`).
- **Tool-layer guard** (`extension/guard.ts`) — loaded into every write/exec-capable worker; blocks
  destructive bash and writes to protected paths or outside the project root (`escapesRoot` is
  sibling-prefix safe).
- **builder→reviewer auto-pairing** — `spawn_agent({ review: true })` runs the reviewer over the git
  diff and **fails closed** unless the reviewer APPROVEs.
- **Shift-left write validation (#6)** — the worker-side guard runs an EXACT syntax check on the
  content a `write` is about to commit (`validateContent`: JSON via `JSON.parse`, Python via
  `py_compile` when available) and **blocks a syntactically broken write** with the parser error fed
  back to the agent, so it fails fast and locally instead of in a later verify/CI step. Validators are
  exact-only (zero false positives — never block valid content); unsupported types are skipped.
- **$0-OAuth canary** (`assertOAuthRouting`) — every spawn path (oneshot + pooled rpc) builds its env
  through the single-sourced `spawnEnv` (ejects `ANTHROPIC_API_KEY`) and **must** pass the canary
  before exec: it throws if a key is present (would bill pay-per-token) or the `--system-prompt` is
  empty (routes to extra usage). This makes “a worker spawn that silently bills” *unrepresentable*,
  not merely conventional.

### A.8 Observability, teams, scale
- **Fleet-level observability (#8)** — two things the per-session widget can't give: (1) a **cross-run
  ledger** (`src/fleet.ts`) appending every finished spawn (`~/.summon/harness/fleet.jsonl`) +
  `aggregateFleet`/`fleetDigest` (cost-per-intelligent-agent-hour, done-rates, cache-hit-rate),
  rendered to `fleet-summary.md` on shutdown; and (2) a **boot prompt audit** (`auditPrompt`) that
  renders each worker's system prompt once at load and flags any over the byte threshold — the
  skill-bloat detector (context that costs tokens every spawn without earning it).
- **Live TUI dashboard** (`extension/observe.ts` + `src/observe.ts`) — a widget above the editor;
  `/harness-drill <agent|next|off>` expands a per-agent tool timeline; `/harness-web [port] [host]`
  serves an external HTTP+SSE dashboard (`src/web-surface.ts`; loopback by default, optional token
  auth).
- **Named teams** (`run_team`, `src/teams.ts`) — declarative recipes: sequential stages, parallel
  steps; fail-closed loader; `{{var}}` templating. Teams may invoke only worker agents.
- **Blueprints** (`run_blueprint`, `src/blueprint.ts`) — a **code-defined DAG** that interleaves
  deterministic **code nodes** (`run`: a shell command the harness runs itself, non-destructive,
  guarded) and scoped **agent nodes** (`agent`+`prompt`). Nodes launch the instant their `depends_on`
  are `done` (continuous wide parallelism, not just stage-locked); a failed/skipped upstream
  **fail-closes** its dependents. Upstream output flows downstream via `{{node.<id>}}` (you can only
  read what you depend on — `fillTemplate` fail-closes otherwise). Loader validates fail-closed (unique
  ids, exactly-one-kind per node, known non-spawn agents, acyclic via Kahn). This is the “put the LLM
  in contained boxes” primitive: the harness owns the graph + the code nodes; the model runs only
  inside agent nodes. Global + project-local `.summon/blueprints/`; ships `scout-build-verify`.
- **Containerised workers** (`src/container-worker.ts`) — a PooledWorker over a real docker container
  for isolation (lifecycle smoke-proven).

### A.9 Configuration (all optional, env-overridable)
`HARNESS_HOME` (install root; else derived from `src/paths.ts` via `import.meta.url`),
`HARNESS_AGENTS_DIR`, `HARNESS_TEAMS_DIR`, `HARNESS_BLUEPRINTS_DIR`, `HARNESS_THEMES_DIR`,
`SUMMON_CODING_AGENT_DIR` (config home for the registry index, default
`~/.summon`), `HARNESS_POOL_SIZE`, `HARNESS_PREWARM` (comma-sep bundle names to pre-warm),
`HARNESS_WINDOW_TOKENS` (>0 = hard rolling-window gate), `HARNESS_NO_CACHE` (disable the within-run
result cache), `HARNESS_WEB_TOKEN_FILE`. Model ids live in `MODEL` (`src/core.ts`).

---

## Part B — The summon engine (TUI)

A soft-fork of the Pi coding agent, branch `tui-refresh-editorial`, a linear stack of TUI commits on
top of upstream. Source delta ≈ 26 files; everything below renders only on this engine — a released
`summon` paints the theme's `colors`/`vars` and **ignores** the overhaul keys, so a theme that sets them
is safe everywhere.

### B.1 Theme abstraction
A theme is JSON with `colors` + `vars` (rendered everywhere) plus OPTIONAL overhaul keys the engine
understands:
- `glyphs` — box-drawing + spinner glyphs: `boxTL boxTR boxBL boxBR boxH boxV`,
  `toolBracketOpen/Close`, spinner frames. `asciiOnly` themes force portable `+ - |` (byte-identical
  on any terminal).
- `layout` — `toolBlockStyle` (`ascii-box`|`fill`), `inputAreaStyle` (`border-fill`|…),
  `roleLabelStyle` (`smallcaps`|…), spacing primitives.
- `gradient` — a list of hex/var colour stops: the signature ribbon.
- `banner` — `{ lines[], tagline? }`: an ASCII-art wordmark.
Pure helpers on `Theme` (`signatureGradient`, `gradientAt`, `gradientText`, `bannerLines`,
`bannerWidth`, `bannerTagline`, `gradientSpinnerFrames`) are unit-guarded. Ships themes:
`editorial`, `brutalist`, `summon`, `harness` (+ tweaked `dark`/`light`).

### B.2 Theme selection (`--theme` / `SUMMON_THEME`)
`--theme <NAME>` (or `SUMMON_THEME=<name>`) **activates** a theme; `--theme <PATH>` only **registers**
one. All startup `initTheme` sites honour `SUMMON_THEME ?? settings`, and `main.ts` unifies the `--theme`
flag into `SUMMON_THEME` so the selection survives the interactive re-init (this also fixes
`summon --theme editorial/brutalist` generally). A `summon themes` command lists resolvable themes.

### B.3 Gradient wordmark banner + breathing spinner
At startup the engine paints `banner.lines` with a **column-aligned** gradient (colours line up
vertically between rows) when it fits the terminal width, else falls back to the plain logo.
Spinner frames "breathe" — hue cycles through the same `gradient` each tick.

### B.4 Rounded ascii-box tool cards
The `ascii-box` tool block is drawn from the theme's box-drawing glyphs (not hard-coded chars), so
`summon`'s rounded set renders `╭── tool ──╮ / │ … │ / ╰── ✓ ── 2.4s ──╯`: the tool name accented,
the completion pill semantic (success/error). `brutalist` (asciiOnly) renders the portable set.

### B.5 Bordered messages (`messageStyle: "box"`)
Chat messages render inside rounded `box-frame` borders (violet for the user, indigo for the
assistant), every line truncated to the inner width so the frame can never break (guarded by
`message-box.test.ts` at widths 40/60/80/120).

### B.6 Jitter-free rendering (the freeze invariant)
An always-on animation near the top of scrollback is a tmux jitter footgun: once the wordmark scrolls
into scrollback, a frame/keystroke changing bytes *above* the viewport straddles the viewport
boundary → the renderer falls back to a full-screen clear+repaint → flicker. Fix = **animate only
what is on-screen**:
- `TUI.topVisible` (width-independent) gates the `BannerAnimator`: scrolled off-view → it HOLDS its
  frame and emits nothing (header bytes byte-identical → can never straddle); visible → it shimmers.
- Completed tool-card timers freeze; off-screen-only changes suppress the full redraw
  (`offscreen-change-no-fullredraw.test.ts`).
Guards: `banner-animator.test.ts` (visible-advances / hidden-frozen / toggle-resumes) +
render/viewport tests.

### B.7 Hermes-style session card
The wordmark stays unboxed + animated above; live session info (model · thinking / cwd(branch) /
tool+skill counts / hint) renders in a rounded `MessageBoxFrame` card below, labelled with the theme
name. Reusable `functional-lines.ts` re-renders the body each frame so model/branch stay live; every
line truncated to inner width (frame can never break).

---

## Part C — How they fit (the integration)

The harness is bundled as a **built-in, app-shipped extension** so it works the moment you build
Summon — no install step, no per-user wiring.

- **Built-in resources source** (engine): the package-manager scans an app-bundled dir,
  `<app>/{src|dist}/builtin/extensions` (`config.getBuiltinExtensionsDir()`), as a lowest-precedence
  resource source. A user/project extension of the same name still wins; users can disable via
  settings. This is a general capability (first-party features ship with the app), used here for the
  harness.
- **The bundled extensions** — `src/builtin/extensions/summon-spawn.ts` (spawn_agent / spawn_agents /
  run_team) and `summon-observe.ts` (live dashboard + `/harness-web`) re-export the harness under
  `src/builtin/harness/`. Compiled to `dist/builtin/**` on build; agent/team data files are copied by
  `copy-assets`.
- **Sub-agent binary** — the harness spawns workers as `AGENT_BIN` (`paths.ts`, default `summon`,
  env-overridable `SUMMON_BIN`), so delegated work runs the same product.
- **Worker tool safety** — workers are spawned with a strict `--tools <allowlist>`; the engine applies
  that allowlist to **extension** tools too (`isAllowedTool` in `agent-session`), so a sub-agent never
  sees `spawn_agent` even though the built-in registers it. The validator (load-time, fail-closed) is
  the second layer.
- **Theme** — `summon` and `harness` are **built-in themes** (`getBuiltinThemes`), and `summon` is the
  default (`getDefaultTheme`). Switch with `summon themes <name>`.

### Build & verify
```bash
npm install && npm run build               # builds tui · ai · agent · coding-agent (the `summon` CLI)
npm link                                   # `summon` on PATH
npm run check                              # full monorepo gate (biome · tsgo · smokes)
# harness unit tests (run from source):
node --experimental-strip-types --test packages/coding-agent/src/builtin/harness/test/*.test.ts
```

### Provenance & licence
Summon is a derivative work of [`badlogic/pi-mono`](https://github.com/badlogic/pi-mono) (the Pi
coding agent, MIT © Mario Zechner) — full engine source and history retained under MIT. The Pi credit
lives in `NOTICE` + `LICENSE`; everything else is branded Summon. Summon adds no API key: it drives
your own authenticated login over OAuth (the `/login` slash-command inside the running app).
