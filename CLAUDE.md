# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

A parallel `AGENTS.md` ("Repository Guidelines") covers the same project for Codex/other agents — keep the two consistent when editing shared facts.

## Table of Contents

- [Critical Rules](#critical-rules) — session safety, test-before-deploy, Jira/git
- [Commands](#commands) — quick reference, additional commands, CI, code style
- [Deployment (COM)](#deployment-com)
- [Project Overview](#project-overview)
- [Architecture](#architecture) — core files, data flow, key patterns, security, SSE, routes
- [Frontend](#frontend)
- [Working in the Codebase](#working-in-the-codebase) — adding features, gotchas, testing, debugging, performance
- [State Files](#state-files)
- [Environment & Scripts](#environment--scripts) — tunnel, Local IT15 runtime

**Deep-dive docs** — read the relevant one *before* touching that subsystem:

| Subsystem | Doc |
|-----------|-----|
| Respawn state machine | `docs/respawn-state-machine.md` |
| Ralph autonomous loop | `docs/ralph-wiggum-guide.md` |
| Orchestrator | `docs/orchestrator-loop-architecture.md` |
| Agent teams | `docs/agent-teams/` |
| External CLI modes (OpenCode/Codex/Gemini) | `docs/external-cli-modes.md` (+ `docs/opencode-integration.md`) |
| Remote sessions (SSH) | `docs/remote-sessions.md` |
| Document preview / export | `docs/document-preview.md` |
| Headroom context-compression proxy | `docs/headroom-proxy.md` |
| Self-update | `docs/self-update.md` |
| Common gotchas (full detail) | `docs/gotchas.md` |
| Frontend (modules, gesture, header buttons, cache-busting) | `docs/frontend-architecture.md` |
| Security model | `docs/security-architecture.md` |
| Hooks reference | `docs/claude-code-hooks-reference.md` |
| QR auth | `docs/qr-auth-plan.md` |
| Terminal anti-flicker | `docs/terminal-anti-flicker.md` |
| Browser testing | `docs/browser-testing-guide.md` |
| Versioning policy | `docs/versioning-policy.md` |
| API reference (HTTP envelope/status/SSE) | `docs/api-reference.md` |

## Critical Rules

### Session Safety

**You may be running inside a Codeman-managed tmux session.** Before killing ANY tmux or Claude process:

1. Check: `echo $CODEMAN_MUX` — if `1`, you're in a managed session
2. **NEVER** run `tmux kill-session`, `pkill tmux`, or `pkill claude` without confirming
3. Use the web UI or `./scripts/tmux-manager.sh` instead of direct kill commands

### Always Test Before Deploying

**NEVER COM without verifying your changes actually work.** For every fix:

1. **Backend changes**: Hit the API endpoint with `curl` and verify the response
2. **Frontend changes**: Use Playwright to load the page and assert the UI renders correctly. Use `waitUntil: 'domcontentloaded'` (not `networkidle` — SSE keeps the connection open). Wait 3-4s for polling/async data to populate, then check element visibility, text content, and CSS values
3. **Only after verification passes**, proceed with COM

Static assets are cache-busted automatically, so a **normal browser reload picks up frontend edits — no hard refresh needed** (details: `docs/frontend-architecture.md` → Cache-busting).

### Jira/Git Traceability

For Jira-backed work, always keep Jira and git linked:

1. Include the Jira key in the commit subject, e.g. `COD-8 add away digest`.
2. After committing, update the Jira issue with a concise implementation note describing what changed, which files or behavior were affected, and what verification passed.
3. Include the git commit hash in the Jira note. When the remote URL is known, include the Bitbucket commit URL as well.
4. Do this before marking the Jira issue Done or before reporting the work complete. If Jira update fails, say so explicitly in the final response.

## Commands

### Quick Reference

| Task | Command |
|------|---------|
| Dev server | `npm run dev` (or `npx tsx src/index.ts web`) |
| Type check | `tsc --noEmit` |
| Lint | `npm run lint` (fix: `npm run lint:fix`) |
| Format | `npm run format` (check: `npm run format:check`) |
| Single test | `npm test -- test/<file>.test.ts` (or `npx vitest run --config config/vitest.config.ts test/<file>.test.ts`) — ⚠ **never** run bare `npm test`, see [Testing](#testing) |
| Build | `npm run build` (esbuild via `scripts/build.mjs`, NOT tsc — `tsc --noEmit` is type-check only) |
| Production | `npm run build && systemctl --user restart codeman-web` |

### Additional Commands

`npm run dev` = dev server. Default port: `3000` (override with `--port` or the `CODEMAN_PORT` env var). To run this beta isolated alongside a prod Codeman, use `scripts/run-beta.sh` (sets `CODEMAN_INSTANCE=beta` + `CODEMAN_PORT=5000`). Commands not in Quick Reference:

| Task | Command |
|------|---------|
| Dev with TLS | `npx tsx src/index.ts web --https` |
| Override window title hostname | `npx tsx src/index.ts web --title-hostname <name>` (default: `os.hostname()` — `codeman:<name>` is used for tab title, title-flash, and OS desktop notification prefix) |
| Bind a non-loopback host | `npx tsx src/index.ts web --host 0.0.0.0` (or `-H`; env `CODEMAN_HOST`; default `127.0.0.1`). Without `CODEMAN_PASSWORD` it **starts but warns loudly** — see Common Gotchas + `docs/security-architecture.md` |
| Continuous typecheck | `tsc --noEmit --watch` |
| Test coverage | `npm run test:coverage` |
| Dead-code sweep | `npm run knip` (config in `knip.json`) |
| Check tool deps | `npx tsx src/index.ts doctor` (`--json` machine output; `--category <name>` filter; non-zero exit if a required dep missing) |
| Rebuild gesture overlay | `npm run build:gesture` (esbuild `packages/gesture-control/src/codeman/entry.ts` → `src/web/public/gesture/gesture-codeman.js`; commit the result) |
| Gesture playground | `npm run dev` **in** `packages/gesture-control/` (standalone vite demo, fake tabs) |
| Check public-asset formatting | `npm run check:public-assets` (prettier-checks `src/web/public/**` text assets; `scripts/check-public-assets.mjs`) |
| Frontend JS syntax check | `npm run check:frontend-syntax` (`scripts/check-frontend-syntax.mjs`; runs in CI) |
| CI-equivalent test sweep | `npm run test:ci` (full suite minus browser/perf — see [Testing](#testing)) |
| Production start | `npm run start` |
| Production logs | `journalctl --user -u codeman-web -f` |

### CI

`.github/workflows/ci.yml` (push to master/main + PRs, Node 22) runs two jobs: **(1)** `check:lockfile`, `typecheck`, `lint`, `check:frontend-syntax`, `format:check`, then a **server boot smoke test** (`tsx src/index.ts web --port 3151` must answer `/api/status` within 30s); **(2)** the **unit/integration test suite** via `npm run test:ci` (`config/vitest.ci.config.ts` — excludes the browser-driven `test/mobile/**` suite, `perf-*` benchmarks, and 3 Playwright tests). Tests are tmux-safe in CI: `TmuxManager` no-ops all shell commands under `VITEST` (see [Testing](#testing)).

### Code Style

Prettier (`singleQuote: true`, `printWidth: 120`, `trailingComma: "es5"`). ESLint flat config (`config/eslint.config.js`) allows `no-console`, warns on `@typescript-eslint/no-explicit-any`. Ignores: `app.js`, `scripts/**/*.mjs`, `src/web/public/vendor/**`, `scripts/remotion/**`.

## Deployment (COM)

Uses [Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`) via `@changesets/cli`. What SemVer actually covers (the CLI + documented env vars are public; the HTTP/SSE API, on-disk state, and experimental features are internal/unstable) is defined in `docs/versioning-policy.md`. Security reporting + known limitations live in `SECURITY.md`.

When user says "COM":
1. **Determine bump type**: `COM` = patch (default), `COM minor` = minor, `COM major` = major
2. **Create a changeset file** (no interactive prompts). Write a `.md` file in `.changeset/` with a random filename:
   ```bash
   cat > .changeset/$(openssl rand -hex 4).md << 'CHANGESET'
   ---
   "aicodeman": patch
   ---

   Detailed description of ALL changes since last release (not just the most recent commit — review full git log since last version tag)
   CHANGESET
   ```
   Replace `patch` with `minor` or `major` as needed. Include `"xterm-zerolag-input": patch` on a separate line if that package changed too.
3. **Consume the changeset**: `npm run version-packages` (auto-bumps `package.json` files, updates `CHANGELOG.md`, runs `npm install --package-lock-only`, and verifies lockfile sync via `scripts/check-lockfile-sync.mjs` — all in one command; never hand-edit `CHANGELOG.md` or `package-lock.json` versions)
4. **Sync CLAUDE.md version**: Update the `**Version**` line below to match the new version from `package.json`
5. **Commit and deploy**: `git add -A && git commit -m "chore: version packages" && git push && npm run build && systemctl --user restart codeman-web`
6. **Wait for CI**: after `git push`, TWO workflows fire per master push — `CI` and `Release` (the npm publish + GitHub release). List both runs for the pushed commit with `gh run list --commit $(git rev-parse HEAD) --json databaseId,workflowName` and watch EACH with `gh run watch <id> --exit-status`. Confirm both pass before considering the release done (`gh run list -L 1` returns only one of the two).

CI runs `npm run check:lockfile` on every push/PR, so lockfile drift fails the build even if the `version-packages` script is bypassed.

**Version**: 1.9.3 (must match `package.json`)

## Project Overview

Codeman is a Claude Code session manager with web interface and autonomous Ralph Loop. Spawns Claude CLI via PTY, streams via SSE, supports respawn cycling for 24+ hour autonomous runs.

**Tech Stack**: TypeScript (ES2022/NodeNext, strict mode), Node.js, Fastify, node-pty, xterm.js. Supports Claude Code, OpenCode, Codex (OpenAI), and Gemini CLIs via pluggable CLI resolvers (`SessionMode = 'claude' | 'shell' | 'opencode' | 'codex' | 'gemini'`).

**TypeScript Strictness** (see `tsconfig.json`): `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `allowUnreachableCode: false`, `allowUnusedLabels: false`.

**Requirements**: Node.js 22+, Claude CLI, tmux

**Git**: This box works on and deploys from `local` (tracks `bitbucket/local`). `master` is **not** the working branch here — it only tracks `origin/master` (the canonical `Ark0N/Codeman` upstream main) as a base for upstream PRs and new worktrees, and is never deployed. SSH session chooser: `sc` (interactive), `sc 2` (quick attach), `sc -l` (list).

**Import conventions**: Utils from `./utils`, types from `./types` (barrel), config from specific `./config/*` files.

## Architecture

### Core Files (by domain)

| Domain           | Key files                                                                                              | Notes                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **Entry**        | `src/index.ts`, `src/cli.ts`                                                                           |                                                                                                  |
| **Session**      | `src/session.ts` ★, `session-manager`, `session-auto-ops`, `session-cli-builder`, `session-task-cache`, `session-order` (pure), `session-pty-exit-breaker`, `usage-limit-patterns`, `usage-telemetry`; `src/services/unified-session-service.ts` | Pure/unit-tested helpers are split out of `session.ts` on purpose                                 |
| **Mux**          | `src/mux-interface.ts`, `src/mux-factory.ts`, `src/tmux-manager.ts` ★                                  |                                                                                                  |
| **Respawn**      | `src/respawn-controller.ts` ★ + 4 helpers (`-adaptive-timing`, `-health`, `-metrics`, `-patterns`)      | Read `docs/respawn-state-machine.md` first                                                       |
| **Ralph**        | `src/ralph-tracker.ts` ★, `src/ralph-loop.ts` + 5 helpers (`-config`, `-fix-plan-watcher`, `-plan-tracker`, `-stall-detector`, `-status-parser`) | Read `docs/ralph-wiggum-guide.md` first                                                          |
| **Orchestrator** | `src/orchestrator-loop.ts`, `-planner`, `-verifier`                                                    | Read `docs/orchestrator-loop-architecture.md` first                                              |
| **Cron**         | `src/cron/cron-service.ts`, `cron-time.ts` (pure next-run math), `cron-input.ts`                        | Read `docs/cron-discovery.md` first. Distinct from legacy `ScheduledRun` (`/api/scheduled`)      |
| **Agents**       | `src/subagent-watcher.ts` ★, `team-watcher`, `bash-tool-parser`, `transcript-watcher`, `workflow-run-watcher` | `workflow-run-watcher` is STANDALONE and never touches `subagent-watcher`                        |
| **AI**           | `src/ai-checker-base.ts`, `ai-idle-checker.ts`, `ai-plan-checker.ts`                                   |                                                                                                  |
| **Tasks**        | `src/task.ts`, `task-queue.ts`, `task-tracker.ts`                                                      |                                                                                                  |
| **State**        | `src/state-store.ts`, `run-summary.ts`, `session-lifecycle-log.ts`                                     |                                                                                                  |
| **Infra**        | `src/hooks-config.ts`, `push-store`, `tunnel-manager`, `image-watcher`, `file-stream-manager`, `remote-hosts` + `remote-reconnect` (pure), `docker-hosts` + `docker-export` | Remote/docker case overlays; see Key Patterns                                                    |
| **Web tabs**     | `src/webview-store.ts`, `webview-capabilities.ts`, `src/web/webview-proxy.ts` (pure), `src/web/routes/webview-routes.ts` | Dashboard URLs as tabs; NOT a SessionMode                                                        |
| **Search**       | `src/search-service.ts`                                                                                | Pure in-memory core for `GET /api/search`                                                        |
| **Attachments**  | `src/attachment-registry.ts`, `attachment-magic`, `generated-artifact-attachments`, `session-attachment-history`, `document-preview-cache`, `document-thumbnailer`, `document-conversion-limiter`, `config/attachment-guard` | See Key Patterns                                                                                 |
| **Plan**         | `src/plan-orchestrator.ts`, `src/prompts/*.ts`, `src/templates/` (`claude-md.ts` + `case-template.md`) | `templates/` holds the CLAUDE.md scaffold generated into new cases                                |
| **Web**          | `src/web/server.ts` ★, `sse-events.ts`, `routes/*.ts` (20 modules + barrel; `session-routes.ts` ★), `route-helpers.ts`, `ports/*.ts`, `middleware/auth.ts`, `schemas.ts`, `self-update.ts`, `plan-usage-latest.ts`, `ws-connection-registry.ts`, `heic-jpeg-converter.ts` + `heic-jpeg-worker.ts` |                                                                                                  |
| **Frontend**     | `src/web/public/app.js` (~5K lines, core) + 23 modules + `sw.js`                                       | See Frontend section for the load order, which is authoritative                                  |
| **Types**        | `src/types/index.ts` (barrel) → 20 domain files; also `src/types.ts` root re-export                    | See `@fileoverview` in index.ts                                                                  |

★ = Large, central file (>50KB) — read its `@fileoverview` first. All files have `@fileoverview` JSDoc — read that before diving in. Discovery aid: `grep -l '@fileoverview' src/web/routes/*.ts` lists all route modules; same grep works for `src/types/`, `src/web/public/*.js`.

**Local packages**: `packages/xterm-zerolag-input/` (local-echo overlay) and `packages/gesture-control/` (`codeman-gesture-control`, hand-tracking overlay). Both are single-source and bundled into `src/web/public/` — see Common Gotchas and `docs/frontend-architecture.md`.

**Config**: `src/config/` — 20 files, no barrel (`index.ts`) exists; import from the specific file.

**Utilities**: `src/utils/` — re-exported via index. Key: `CleanupManager`, `LRUMap`, `StaleExpirationMap`, `BufferAccumulator`, `stripAnsi`, `Debouncer`, `KeyedDebouncer`. Also: `claude-cli-resolver`/`opencode-cli-resolver`/`codex-cli-resolver`/`gemini-cli-resolver` (CLI path resolution), `string-similarity` (fuzzy matching), `regex-patterns` (ANSI/token/spinner patterns), `assertNever` (exhaustive checks), `token-validation` (auth tokens), `nice-wrapper` (process priority).

### Data Flow

1. Session spawns `claude --dangerously-skip-permissions` via node-pty
2. PTY output buffered, ANSI stripped, parsed for JSON messages
3. WebServer broadcasts to SSE clients at `/api/events`
4. State persists to `~/.codeman/state.json` via StateStore

### Key Patterns

**Input**: `session.writeViaMux()` for programmatic/curl input — tmux `send-keys -l` (literal) + `send-keys Enter`. Single-line only (fire-and-once). Interactive **browser** input goes through a durable **exactly-once** layer: each frame carries a stable `clientId` + monotonic per-session `seq`, persisted to localStorage until the server ACKs (`{t:'ia',seq}` over WS, or HTTP 2xx), so a dropped link/reconnect can't lose or double-deliver a prompt. **WS resilience** (#149): the upgrade URL carries `cid = clientId + ':' + perTabNonce`, and `ws-connection-registry.ts` supersedes only same-TAB reconnects (two tabs on one session coexist; input frames keep the bare `clientId` for seq dedup); reconnects back off exponentially (attempts preserved across `_connectWs`), and the header connection chip renders from a real `_wsState` lifecycle (`connecting`/`connected`/`fallback`/`reconnecting`/`disconnected`).

**Idle detection**: Multi-layer (completion message → AI check → output silence → token stability). See `docs/respawn-state-machine.md`.

**Auto-resume on usage limit** ("token pause", opt-in per session, top of the Respawn tab): when Claude halts on a subscription limit ("5-hour limit reached ∙ resets 8pm" and 1.0.x–2.1.x variants), `usage-limit-patterns.ts` (pure, unit-tested) parses the reset time; `SessionAutoOps` arms a timer for reset+2min, then sends Esc + `continue`. Still-limited responses re-arm (5-min retry on stale times); a `working` transition cancels it. Claude-mode only. Persists via `SessionState.autoResumeEnabled`/`autoResumeAt`; respawn cycles are blocked while paused (`isLimitPaused` guard in `onIdleDetected` — prevents `/clear` wiping the paused conversation). Endpoint `POST /api/sessions/:id/auto-resume`; SSE `session:limitPauseScheduled`/`limitResume`/`limitResumeCancelled`. Tests: `test/usage-limit-patterns.test.ts`, `test/session-auto-resume.test.ts`.

**Plan-usage chip** (statusLine telemetry, `showPlanUsageLimits`, per-device: desktop default **ON**, handhelds OFF via the mobile block in `getDefaultSettings()`): resolve it ONLY through `planUsageChipEnabled()` in settings-ui.js, which backs all three call sites (the App Settings checkbox, the chip's visibility, and the `statusLineTelemetry` flag on session create). A chip shown without telemetry renders `—` forever. Codeman injects its own `statusLine.command` exporter (`generateStatusLineCommand()` in `hooks-config.ts`) which POSTs Claude's `rate_limits` blob to `POST /api/status-telemetry` (auth-exempt like `/api/hook-event` — localhost-only, hook-secret-gated under a tunnel). The exporter is identified by a marker, so it only ever adds/updates/removes a statusLine that is **ours**, never a user's hand-authored one, and it prints the footer through so the in-terminal statusline is not blanked. The route parses via `usage-telemetry.ts` (pure, unit-tested); `web/plan-usage-latest.ts` holds the process-wide last value, replayed in the SSE init snapshot so the chip renders immediately on load/reconnect. Claude-mode only; distinct from auto-resume, which reacts to the limit *message* rather than showing live %. Route module `web/routes/status-telemetry-routes.ts`. → [architecture-invariants#plan-usage-chip-statusline-telemetry](docs/architecture-invariants.md#plan-usage-chip-statusline-telemetry), `docs/usage-limits-display-plan.md`. Tests: `test/usage-telemetry.test.ts`.

**Orchestrator**: State machine turning a user goal into a phased plan and driving it to completion (`idle → planning → approval → executing → verifying → (replanning) → completed/failed`); persists under the `orchestrator` key in `state.json`. Distinct from Ralph (single-session loop) — the orchestrator coordinates multi-phase, multi-agent execution. Full design: `docs/orchestrator-loop-architecture.md`.

**External CLI modes (OpenCode, Codex, Gemini)**: `isExternalCliMode()` in `session.ts` gates Claude-specific behavior (Ralph tracker, BashToolParser, token parsing, ❯-prompt readiness all skipped — these CLIs render their own TUIs). They **require tmux — no PTY fallback** because secrets are injected via `tmux setenv`. Full design incl. Codex `buildCodexCommand()` specifics and `GET /api/codex/status`: `docs/external-cli-modes.md` (OpenCode resolver: `docs/opencode-integration.md`).

**Remote sessions (SSH)**: Sessions can run the agent inside `tmux -L codeman new-session -A` **on a remote host** so it survives the SSH drop (COD-104), and can also **discover + attach** to `codeman-*` sessions another Codeman launched there — attached (`owned:false`) sessions **detach, never kill** on tab close (COD-105). ⚠️ Command-injection surface (COD-107): all ssh command lines flow through the single shell-safe `buildSshConnectionArgs()` — every user field (`-J jumpHost`, `-i identity`, `-o`) is `shellescape`d; never hand-build an ssh line elsewhere. Full design: `docs/remote-sessions.md`.

**Document preview / attachments** (COD-58/59/61/66): file preview (Office→PDF via `soffice`), one-click PDF export, in-memory revision history + diff/rollback, and attachment cards. Endpoints live on **`file-routes.ts`**. Attachments are addressed by minted IDs so browser requests never carry absolute paths. Full design: `docs/document-preview.md`.

**Headroom (context-compression proxy)** (COD-98/COD-102): optional **health-gated** upstream proxy that compresses context to extend the window; settings-driven (`headroomProxyUrl`/`headroomRouteClaude`/`headroomRouteCodex` read at call time — `""` = kill-switch), injecting `ANTHROPIC_BASE_URL` (Claude) / a `config.toml` patch (Codex), falling back to the direct API when down. Full design: `docs/headroom-proxy.md`.

**Hook events**: Claude Code hooks trigger via `/api/hook-event`. Key events: `permission_prompt`, `elicitation_dialog`, `idle_prompt`, `stop`, `teammate_idle`, `task_completed`. See `src/hooks-config.ts`; upstream semantics in `docs/claude-code-hooks-reference.md`.

**Agent Teams**: `TeamWatcher` polls `~/.claude/teams/`, matches to sessions via `leadSessionId`. Teammates are in-process threads appearing as subagents. Enable: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. See `docs/agent-teams/`.

**Circuit breaker**: Prevents respawn thrashing. States: `CLOSED` → `HALF_OPEN` → `OPEN`. Reset: `/api/sessions/:id/ralph-circuit-breaker/reset`. **Distinct: PTY-exit breaker** (COD-115/118/#147, `session-pty-exit-breaker.ts`) trips after repeated rapid PTY exits (crash loops on attach), blocks further auto-restarts, broadcasts SSE `session:respawnBreakerTripped` + push (in `PUSH_EVENT_MAP`). Reset ONLY via an explicit `{clearBreaker:true}` body on `POST /api/sessions/:id/interactive` (sent by the user-facing restart control) — the frontend's auto-reattach in `selectSession()` sends no body and must never clear it. Sessions also scrub inherited `TMUX`/`TMUX_PANE` env so Codeman-in-tmux doesn't nest. Tests: `test/respawn-pty-breaker.test.ts`.

**Full-scrollback replay** (COD-164/#148): `GET /api/sessions/:id/terminal?full=1` returns the ENTIRE tmux scrollback (capture-pane `-e -S -<lines>` bounded by the configured history limit, explicit `maxBuffer` from the terminal-history config, early byte-cap before normalization, CRLF-normalized for shell panes). On success the capture is returned ALONE (`source='mux-full-history'` — it supersedes the byte buffer; no duplication). Only the FIRST buffer load after a page load requests `full=1` (one-shot `_initialFullBufferLoad` flag in app.js); tab switches keep the cheap `?tail=` visible-frame path. Tests: `test/tmux-capture-full-history.test.ts`, `test/tmux-scrollback-eol.test.ts`.

**Self-update** (App Settings → Updates): in-app updater for **git-clone installs** supervised by systemd/launchd (npm installs are non-updatable). Because it restarts the very process running it, a DETACHED `scripts/self-update.sh` does the `git checkout <tag> && npm install && npm run build && restart` and writes `dataPath('update-status.json')`, which the browser polls across the connection drop. `src/web/self-update.ts` splits PURE helpers (unit-tested) from IO wrappers. Routes under `/api/system/update`. Full design (supervisor detection, reconcile-on-boot): `docs/self-update.md`.

**Attachments** (live external document references; all wiring in `file-routes.ts`): a **registry** maps a stable `attachmentId` to a realpath-resolved, extension-allowlisted absolute path, so browser requests never carry arbitrary absolute paths. ⚠️ The **magic-link scanner** (`codeman://attach?...` in terminal output) is **prompt-injectable**, so its scan path is force-confined to the session workspace; a hostile prompt could otherwise exfiltrate arbitrary host files over SSE. The security gate is an extension **allowlist**, not a blocklist. `document-conversion-limiter.ts` caps converter spawns globally: without it, N large docs detected at once fork N multi-minute processes, which is a resource-exhaustion vector. → [architecture-invariants#attachments](docs/architecture-invariants.md#attachments)

**Filesystem path picker** (Link Existing "Browse" + the mobile keyboard's `📁 Path` key): lazy one-directory browsing via `GET /api/filesystem/browse`, with `GET /api/filesystem/preview` for the tapped file. Inserts the path **without** Enter, so the prompt is never submitted; the sibling `⌫ All` key clears only the unsent prompt and must never send the agent's `/clear`. ⚠️ This is a **second file-serving surface and inherits neither the attachment confinement nor its ownership scoping** — it allowlists Home, `CASES_DIR`, `/mnt/d` and `CODEMAN_FILE_PICKER_ROOTS`, blocks sensitive trees, and rejects symlink escapes **after** `realpath`. ⚠️ The optional `sessionId` is an ownership boundary that must be `canAccessOwned`-checked by hand (it does not go through `findSessionOrFail`), and in multi-user mode a non-admin gets only their own `userSpacePath` as a root: per-user spaces live INSIDE `homedir()`, so a `Home` root exposes every other user's workspace. Previews go through the same global conversion limiter, and Markdown/TXT/JSON are served as inert `text/plain`. → [architecture-invariants#filesystem-path-picker](docs/architecture-invariants.md#filesystem-path-picker)

**Ultracode / workflow-run visualization** (opt-in, default OFF): the Workflow tool writes a completion artifact only at run *end*, so live in-flight runs exist solely as transcript dirs. `workflow-run-watcher.ts` therefore synthesizes ACTIVE runs from transcripts until the completion artifact appears and supersedes them. It is **STANDALONE** and deliberately never imports or touches `subagent-watcher.ts`, despite reading the same tree. Two independent toggles: `showUltracodeAgents` (docked panel) and `ultracodeFloatingWindows` (floating windows); the watcher starts if **either** is on. → [architecture-invariants#ultracode--workflow-run-visualization](docs/architecture-invariants.md#ultracode-and-workflow-run-visualization)

**Cross-session search**: `GET /api/search` federates an in-memory search over session metadata, run-summary events, and attachment-history entries. The pure core `searchSources()` does substring matching with hard per-type caps: **no regex (so no ReDoS) and no filesystem reads (so no traversal)**. The server-private `externalPath` is never read. → [architecture-invariants#cross-session-search](docs/architecture-invariants.md#cross-session-search)

**Web tabs** (dashboard URLs as tabs): a saved URL renders as a tab beside agent sessions. **NOT a sixth `SessionMode`** (no PTY, no tmux, no respawn), same reasoning that keeps Docker/remote-SSH as case overlays. Dashboards are **proxied through Codeman's own origin** by default, because a direct iframe fails three ways at once: prod is HTTPS so `http://` targets are blocked as mixed content, many dashboards send `X-Frame-Options: DENY`, and our own `default-src 'self'` CSP blocks cross-origin frames. Proxying leaves the prod CSP unchanged (`/webview/...` is `'self'`). ⚠️ The proxy is **NOT an API surface**: it authenticates on an in-memory capability in the path and is correspondingly exempt from the cookie + Origin checks; that exemption is fenced to safe methods and non-`/api` paths and is pinned by `test/webview-auth-exemption.test.ts`. ⚠️ Iframes omit `allow-same-origin` unless a dashboard is explicitly marked `trusted`, and `Authorization`/`codeman_session` are stripped upstream in **both** modes so `CODEMAN_PASSWORD` cannot leak. ⚠️ A sandboxed frame is **opaque-origin**, which breaks two things `curl` can never reproduce: its runtime-built root-absolute URLs escape `<base>` (fixed by an injected `runtimeUrlShim()`), and its same-host `fetch`/XHR are CORS-checked with `Origin: null` (fixed by `buildProxyCorsHeaders()` plus exempting the proxy from the global `OPTIONS`-204 short-circuit in `registerSecurityHeaders`). Both present as the dashboard's own "Failed to fetch" while the page renders fine. → [architecture-invariants#web-tabs](docs/architecture-invariants.md#web-tabs), `docs/web-tabs.md`

**Multi-user mode** (opt-in `--multiuser` / `CODEMAN_MULTIUSER=1`, OFF by default): named users with scrypt-hashed passwords in `~/.codeman/users.json`. Gated everywhere by `isMultiUserMode()`; when OFF, behavior is byte-identical to single-user because every scoping helper short-circuits. ⚠️ **Not a security boundary at the agent layer**: every session still runs as the SAME OS account. This separates WORKSPACES; it does not sandbox users (Docker cases are the isolation story). Ownership threads through `Session.owner` and is enforced in `findSessionOrFail`, list endpoints, SSE routing (fail-closed), WS, search, and file-preview. → [architecture-invariants#multi-user-mode](docs/architecture-invariants.md#multi-user-mode), `docs/multi-user-plan.md`

**Away digest**: `GET /api/away-digest` aggregates what happened while you were away from the lifecycle log, run-summary events, live sessions, token stats, and recent subagents. Pure aggregator in `web/away-digest.ts`. ⚠️ Returns `{success:true,digest}`, a legacy raw-ish shape consistent with the other raw GET handlers in `system-routes.ts`; frontend and tests read `.digest`. → [architecture-invariants#away-digest](docs/architecture-invariants.md#away-digest)

**Ralph todo-config**: per-session `maxTodos` (FIFO-eviction cap, default 500 = `MAX_TODOS_PER_SESSION`) + `todoExpirationMinutes` (auto-expiry, default 60) set via `POST /api/sessions/:id/ralph-config` (`RalphConfigSchema`, both `.int().positive()`). Stored on the tracker (`setMaxTodos`/`setTodoExpirationMinutes`) and **persisted/read-back via `RalphTrackerState`** (surfaced in the `loopState` getter → `toState()` + SSE broadcast → modal `populateRalphForm`), mirroring how `maxIterations` round-trips. Claude-only (skipped by `isExternalCliMode`).

**Port interfaces**: Routes declare dependencies via port interfaces (`src/web/ports/`). Routes use intersection types (e.g., `SessionPort & EventPort`).

### Frontend

Frontend JS modules have `@fileoverview` with `@dependency`/`@loadorder` tags. Load order: `constants.js`(1) → `i18n.js`(1.5) → `mobile-handlers.js`(2) → `voice-input.js`(3) → `notification-manager.js`(4) → `keyboard-accessory.js`(5) → `input-cjk.js`(5.5) → `sanitize-html.js`(5.6) → `app.js`(6) → `terminal-ui.js`(7) → `respawn-ui.js`(8) → `ralph-panel.js`(9) → `orchestrator-panel.js`(9.5) → `cron-ui.js`(9.7) → `settings-ui.js`(10) → `panels-ui.js`(11) → `ultracode-panel.js`(11.5) → `admin-ui.js`(11.7) → `session-ui.js`(12) → `webview-tabs.js`(12.5) → `ralph-wizard.js`(13) → `api-client.js`(14) → `subagent-windows.js`(15) → `ultracode-windows.js`(15.5) → `image-input.js`(16). `i18n.js` translates static + newly inserted application DOM while skipping terminal/response/file/user-name surfaces; `input-cjk.js` handles CJK IME composition via an always-visible textarea below the terminal (`window.cjkActive` blocks xterm's onData).

**Command palette + shortcut registry**: `Ctrl/Cmd/Alt+K` opens the session palette; shortcuts live in a rebindable registry (`DEFAULT_SHORTCUTS`/`getShortcutRegistry()`/`matchesShortcutEvent()` in app.js, overrides in `settings.shortcutOverrides`). ⚠️ Palette-chord keys must ALSO be swallowed in `attachCustomKeyEventHandler` (terminal-ui.js) or xterm writes the control byte (0x0B) into the PTY. ⚠️ `saveAppSettings()` rebuilds settings from the DOM, so keys edited elsewhere (`shortcutOverrides`, `showTokenCount`, `showCost`) need explicit `_prev` carry-over. → [architecture-invariants#command-palette-and-shortcut-registry](docs/architecture-invariants.md#command-palette-and-shortcut-registry)

**Per-device vs synced settings**: the `displayKeys` set in settings-ui.js is a **client-side merge policy**, not a wire filter. A display key seeds from the server only when localStorage has no value for it, which is what prevents one device overwriting another; `showPlanUsageLimits` is additionally `delete`d from the incoming payload outright. Separately, `SettingsUpdateSchema` is `.strict()` and simply **does not declare** `skin`, `showFileViewerButton`, `showCronButton`, `webglRendererEnabled`, `localEchoEnabled`, `cjkInputEnabled`, or `extendedKeyboardBar`, so sending one of those is a validation error. The rest (`showResponseViewer`, `showPlanUsageLimits`, `language`, and most `show*` keys) ARE in the schema and do persist server-side; they are per-device by client policy only. ⚠️ Adding a new per-device setting means deciding **both** questions: membership in `displayKeys`, and presence in the schema.

**Header button visibility**: most header controls are opt-in and hidden by a marker class (`btn-multimonitor--hidden`, `btn-response-viewer-header--hidden`, `btn-file-viewer--hidden`, `btn-cron--hidden`) that `applyHeaderVisibilitySettings()` (settings-ui.js) toggles after settings load; the multi-monitor button is instead stripped at render by `renderIndexHtml`. ⚠️ Hiding must go through the marker class: the base rules are `display:inline-flex !important`, so an inline style cannot override them. Current desktop default is WS/CPU/MEM + File Viewer + gear, with the token chip and lifecycle-log button OFF. ⚠️ New header controls must not leak onto phones; `test/mobile-header-buttons-policy.test.ts` is the static guard. → [architecture-invariants#header-button-visibility-multi-monitor-response-viewer-file-viewer-cron](docs/architecture-invariants.md#header-button-visibility-multi-monitor-response-viewer-file-viewer-cron)

**Gesture control** (camera hand-tracking overlay, opt-in, default OFF): `CODEMAN_GESTURE=1` makes the feature *available*; `gestureControlEnabled` turns it on. The bundle is injected by `renderIndexHtml` only when enabled, which is why that method is `async` and reads settings with `readSettings(true)` (a fresh read: a post-save reload lands inside the 2s cache TTL and would otherwise render the pre-toggle state). **Source lives in `packages/gesture-control/`; edit there, run `npm run build:gesture`, and commit the regenerated bundle** because dev serves the committed bundle with no runtime bundler. The MediaPipe wasm + model are fetched separately and gitignored. ⚠️ Keep `MP_VERSION` in `fetch-gesture-assets.mjs` in sync with `@mediapipe/tasks-vision`. → [architecture-invariants#gesture-control-the-source-package](docs/architecture-invariants.md#gesture-control-the-source-package)

**Theme skins / branding / i18n**: `skin` selects a palette via `data-skin` on `<html>`, applied by an **inline pre-paint script** in `index.html` reading `localStorage['codeman:skin']` to avoid a flash of wrong theme. ⚠️ A skin is **four things that must stay in sync**, and missing any one degrades silently: the `html[data-skin="…"]` token block in `styles.css`, the xterm ANSI palette in `terminal-ui.js`, the pre-paint allowlist, and the Settings picker (both in `index.html`). `test/skin-themes.test.ts` is the static guard. Light skins additionally need `color-scheme: light` and xterm `minimumContrastRatio: 4.5`, and `applyTerminalSkin()` must call the local-echo overlay's `refreshFont()` because it caches the terminal fg/bg. `displayName` changes user-facing browser branding only and must NEVER rename npm package, CLI, API, storage, CSS, or protocol identifiers. `language` (`en`/`zh-CN`) keeps English as the canonical source so live switching stays reversible. User display names flow through `textContent`/attribute APIs and the server title's HTML escaper, never `innerHTML`. → [architecture-invariants#theme-skins](docs/architecture-invariants.md#theme-skins)

**Foldable settings identity**: responsive layout is width-driven via `MobileDetection.getDeviceType()`, but the localStorage namespace uses `MobileDetection.isHandheldDevice()` so an unfolded Android foldable keeps `codeman-app-settings-mobile`. ⚠️ Do not switch per-device settings namespaces from instantaneous viewport width: a posture-triggered WebView reload would lose opt-in UI. Regression profile: `OPPO Find N5 (unfolded)` in `test/mobile/devices.ts`. → [architecture-invariants#foldable-settings-identity](docs/architecture-invariants.md#foldable-settings-identity)

**WebGL renderer toggle** (`webglRendererEnabled`, per-device): the GPU-stall watchdog's sticky `codeman-webgl-disabled` marker survives page loads and is cleared only by an explicit OFF→ON save or `?webgl=force`. `?nowebgl` forces the DOM renderer per-load. → [architecture-invariants#webgl-renderer-toggle](docs/architecture-invariants.md#webgl-renderer-toggle)

**Phone toolbar: Enter replaces Shell** (post-1.8.0): inside `@media (max-width: 430px)` `btn-shell` is `display:none` and `btn-enter` takes its slot (`order: 4`); starting a shell moved into the Run dropdown (`Terminal / Shell` → `setRunMode('shell')` → `run()` → `runShell()`, button label "Run SH"). `runMode` is `z.string().max(20)` server-side, so new modes need no schema change. Desktop and tablet keep the green Run Shell button unchanged.

⚠️ **`sendEnterKey()` MUST go through `terminal._core.coreService.triggerDataEvent('\r', true)`** — not `sendInput()`, and never a raw POST to `/api/sessions/:id/input`. `localEchoEnabled` defaults to `MobileDetection.isTouchDevice()`, so on every phone the characters you type are buffered in the `LocalEchoOverlay` and have **never reached the PTY**; the `onData` Enter branch in terminal-ui.js is what flushes `pendingText` first and only then sends `\r` (after an 80ms delay so text lands first). Sending a bare `\r` submits an empty line and strands the typed text on screen, so the button looks dead. Replaying the keypress reuses the overlay flush, the flushed-offset cleanup and the ordering instead of reimplementing them. `KeyboardAccessory.sendKey()` is for escape sequences (arrows/Esc) and is the WRONG template to copy for input.

⚠️ **Skin overrides outrank plain class rules.** `styles.css` nests its skin block inside `html:not([data-skin="og"]) { … }`, so a bare `.btn-toolbar` rule in there resolves to specificity **(0,2,1)** and beats a `.btn-toolbar.btn-x` rule **(0,2,0)** in `mobile.css` regardless of load order. Toolbar-button colors set from mobile.css therefore need `!important` — that is why mobile.css leans on it so heavily. Symptom: only your `!important` properties land and everything else silently renders in generic toolbar grey.

**Z-index layers**: subagent windows (1000), plan agents (1100), mobile/tablet fixed header (1200, `mobile.css`), modals on ≤768px (1300 — must beat the fixed header or the modal close button is buried), log viewers (2000), image popups (3000), local echo overlay (7).

**Respawn presets**: `solo-work` (3s/60min), `subagent-workflow` (45s/240min), `team-lead` (90s/480min), `ralph-todo` (8s/480min), `overnight-autonomous` (10s/480min).

**Keyboard shortcuts**: Escape (close), Ctrl+? (shortcut overlay), Ctrl/Cmd/Alt+K (session palette), Ctrl+W (kill), Ctrl+Tab (next), Alt+[/] (prev/next tab), Alt+1-9 (switch tab), Ctrl+Shift+{/} (move tab left/right), Shift+Enter or Ctrl+Enter (newline), Ctrl+L (clear), Ctrl+Shift+R (restore size), Ctrl+Shift+V (voice input), Ctrl/Cmd +/- (font), Shift+Wheel (local scrollback when mouse passthrough is active). Rebindable via the registry.

### Security

**Full model: [`docs/security-architecture.md`](docs/security-architecture.md)** — network binding, auth pipeline, the tunnel caveat, file-serving hardening, supply-chain, instance isolation, and recommended secure setups.

| Layer | Details |
|-------|---------|
| **Auth** | Optional HTTP Basic via `CODEMAN_USERNAME` (defaults to `admin`) / `CODEMAN_PASSWORD` env vars. Active only when `CODEMAN_PASSWORD` is set (`middleware/auth.ts`) |
| **Network bind** | Defaults to `127.0.0.1` (loopback). A non-loopback bind (`--host`/`CODEMAN_HOST`) without `CODEMAN_PASSWORD` **starts but warns loudly** (0.9.0; was fail-closed in COD-29/#107). `--allow-unauthenticated-network` / `CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK=1` acknowledges the warning. Classifier: `network-auth-policy.ts` |
| **Host guard** | Always-on Host-header allowlist blocks DNS rebinding (RCE on the default no-auth loopback install). Allows loopback, any IP literal, the bind host, `*.ts.net`/`*.trycloudflare.com`/`*.cfargotunnel.com`, the active managed tunnel, and `CODEMAN_ALLOWED_HOSTS`. ⚠️ **Custom reverse-proxy domains are rejected** unless added via `CODEMAN_ALLOWED_HOSTS=host,.suffix`. `registerHostGuard` in `server.ts`; policy in `network-auth-policy.ts` (`buildHostPolicy`/`isAllowedRequestHost`/`isAllowedRequestOrigin`) |
| **CSRF / Origin** | Always-on cross-site Origin guard rejects state-changing requests from foreign origins (covers self-update, session create/input, settings/tunnel toggles). **A missing Origin is allowed** so curl/CLI and Claude Code hooks keep working. The global body parser keeps `text/plain` RAW (no auto-JSON-parse, which had enabled simple-request CSRF); `/api/crash-diag` self-parses. WebSocket upgrade validates Origin+Host (anti-CSWSH) in `ws-routes.ts`. Added in `c669518` (closes 2026-06-09 review CRITICALs) |
| **QR Auth** | Single-use 6-char tokens (60s TTL) for tunnel login. See `docs/qr-auth-plan.md` |
| **Sessions** | 24h cookie (`codeman_session`), auto-extend, device context audit |
| **Rate limit** | 10 failed auth/IP → 429 (15min decay). QR has separate limiter |
| **Hook bypass** | `/api/hook-event` (and `/api/status-telemetry`, the statusLine exporter) skip Basic auth (localhost-only, schema-validated). When auth is active (`CODEMAN_PASSWORD` set), the loopback bypass requires the per-instance `X-Codeman-Hook-Secret` header **unconditionally** — COD-54 introduced it tunnel-gated; COD-91 (PR #127) made it always-on because Codeman can't detect a user's own loopback reverse proxy (own cloudflared/`tailscale serve`/nginx → 127.0.0.1), closing that residual plain-bypass gap. Hook curls cat the secret file at exec time via `$CODEMAN_HOOK_SECRET_FILE` (session env, `config/hook-secret.ts`); a missing/wrong secret gets 401 and rate-limits in a dedicated bucket (never locks out login). Tunnel enable **refuses** without `CODEMAN_PASSWORD` unless exposure is acknowledged — via `CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK=1` (env, COD-55) **or** the per-request `acknowledgeUnauthTunnel:true` action field (1.1.9): the welcome/settings tunnel toggle pops a security confirm dialog and, on confirm, resends with that flag (server logs a loud warning on every passwordless tunnel start; curl/API stay refused without password/env/flag). The flag is an action field, never persisted |
| **Env vars** | `CODEMAN_MUX` (managed session), `CODEMAN_API_URL` (auto-set for hooks), `CODEMAN_ALLOWED_HOSTS` (extra Host/Origin allowlist entries for reverse proxies, comma-separated; bare `.suffix` matches subdomains) |
| **Validation** | Zod schemas, path allowlist regex, env prefix allowlist (`CLAUDE_CODE_*`/`OPENCODE_*`/`CODEX_*`/`GEMINI_*`/`GOOGLE_*`) |
| **Headers** | CORS localhost-only, CSP, X-Frame-Options, HSTS if HTTPS |

### SSE Event Registry

149 event constants in `src/web/sse-events.ts` (backend) and `SSE_EVENTS` in `constants.js` (frontend). **Both must be kept in sync** — they are currently exactly in sync, and the backend file's `@fileoverview` carries the per-category breakdown.

### API Routes

~199 handlers across 21 route files in `src/web/routes/`: system (45), sessions (32), cases (27), files (16), orchestrator (10), ralph (9), cron (9), admin (8), plan (8), respawn (7), webviews (6 + the `/webview/:cap/*` proxy), mux (5), push (4), scheduled (4, legacy `ScheduledRun`), me (2), teams (2), search (1), hooks (1), clipboard (1), status-telemetry (1), ws (1 WebSocket). Counts drift as endpoints are added — re-grep `\.(get|post|put|delete)\(` per file rather than trusting these. Each file has `@fileoverview` with endpoint details.

**HTTP contract** (stable since 0.9.x): responses use the `ApiResponse<T>` envelope — `{ success: true, data? }` or `{ success: false, error, errorCode }` (`src/types/api.ts`). `/api/v1/*` is a versioned alias of `/api/*` (URL rewrite in `server.ts`). Full envelope/status/error-code/SSE spec: `docs/api-reference.md`.

## Frontend

The browser frontend is plain JS/CSS/HTML under `src/web/public/` — no framework, no runtime bundler. The full module map, exact load order, z-index contract, opt-in header buttons (multi-monitor, response-viewer), the gesture-control overlay, and cache-busting are documented in **`docs/frontend-architecture.md`**. See the `### Frontend` subsection under [Architecture](#architecture) above for module load order, theme skins (including the light-skin palettes), keyboard shortcuts, and respawn presets. Read `docs/frontend-architecture.md` before touching frontend wiring.

## Working in the Codebase

### Adding Features

- **API endpoint**: Types in `src/types/` domain file, route in `src/web/routes/*-routes.ts`. Return the `ApiResponse` envelope (`{ success: true, data }`; errors via `createErrorResponse()` with proper status code). Validate with Zod schemas in `schemas.ts`.
- **SSE event**: Add to `src/web/sse-events.ts` + `SSE_EVENTS` in `constants.js`, emit via `broadcast()`, handle in `app.js` (`addListener(`)
- **Session setting**: Add to `SessionState`, include in `session.toState()`, call `persistSessionState()`
- **Hook event**: Add to `HookEventType`, add hook in `hooks-config.ts:generateHooksConfig()`, update `HookEventSchema`
- **Mobile feature**: Add to relevant singleton, guard with `MobileDetection.isMobile()`
- **New test**: Pick unique port (search `const PORT =`). Route tests use `app.inject()` (no port needed) — see `test/routes/_route-test-utils.ts`.

**Validation**: Zod v4 (different API from v3). Define schemas in `schemas.ts`, use `.parse()`/`.safeParse()`.

### Common Gotchas

Headline index — **full rationale, file pointers, and history: [`docs/gotchas.md`](docs/gotchas.md)**. Read it before changing session spawning, env/effort/model flow, the local-echo overlay, network binding, or instance layout.

- **Single-line prompts only** — `writeViaMux()` sends text+Enter separately; multi-line breaks Ink
- **ESM only** — never `require()`, use `await import()`; `tsx` masks CJS/ESM issues that break prod
- **Package ≠ product name** — npm `aicodeman`, product **Codeman**; both `aicodeman`/`codeman` bins installed
- **Global regex `lastIndex`** — reset `lastIndex = 0` before reusing shared `g`-flag patterns, or use `execPattern()`
- **`envOverrides` carry `CLAUDE_CODE_*`/`OPENCODE_*`/`CODEX_*`** — via the `envOverrides` payload → `buildEnvExports()`; do NOT write them to `<case>/.claude/settings.local.json`
- **Effort is NOT an env var** — flows as the `effort` payload field, never `CLAUDE_CODE_EFFORT_LEVEL` (which hard-locks effort + blocks `/effort`); `max` via `--effort`, ultracode via `--settings`
- **Model flows via `settings.local.json`, NOT `--model`/env** — `claudeModel` setting → `modelOverride` payload → `updateCaseModel()` writes the `model` key (the intended exception to the envOverrides rule)
- **Multi-CLI prefix discipline** — env-var prefix is CLI-specific (`CLAUDE_CODE_*`/`OPENCODE_*`/`CODEX_*`), allowlisted in `schemas.ts`; gate new settings per-CLI, don't forward all prefixes
- **Zod `.optional()` rejects `null`** (accepts `undefined` only) — convert `null → undefined` before `JSON.stringify`, or use `.nullish()`
- **`xterm-zerolag-input` is single-source** — edit `packages/xterm-zerolag-input/src/`, rebuild the bundle; never hand-edit `app.js` overlay behavior or commit the gitignored vendor bundle
- **Default bind is loopback-only; non-loopback without `CODEMAN_PASSWORD` starts but warns loudly** (0.9.0) — prod systemd binds localhost-only; reach it via tunnel/`tailscale serve`
- **Instance isolation / multi-instance attach danger** — `~/.codeman` + `tmux -L codeman` are process-wide; a 2nd instance on the same socket attaches to live sessions. Scope with `CODEMAN_INSTANCE`; route new paths through `dataPath()`

### Testing

**Never run the bare full suite** (`npm test` with no file argument): the default config includes the browser-driven suites (`test/mobile/**` and 3 other Playwright tests), which need a live server + chromium + environment-specific PNG baselines and will fail/hang locally. Run individual files, or `test:ci` for a broad sweep:

```bash
npm test -- test/<specific-file>.test.ts         # Single file (SAFE, uses config/vitest.config.ts)
npm test -- -t "pattern"                          # By name (SAFE)
npm run test:ci                                   # Everything except browser/perf suites — what CI runs
# npm test                                        # DON'T — includes browser/visual suites
```

Raw `npx vitest` skips `config/vitest.config.ts`; always use `npm test --` or pass `--config config/vitest.config.ts`.

**Config**: Vitest with `globals: true`, `fileParallelism: false`. Timeout 30s, teardown 60s. `config/vitest.ci.config.ts` = same minus the browser/perf excludes — keep the two configs in sync when changing shared options.

**Tmux safety**: under vitest (`VITEST` env var, set automatically), `TmuxManager` no-ops ALL shell commands and becomes a pure in-memory mock — tests physically cannot create/kill/attach real tmux sessions (`IS_TEST_MODE` in `src/tmux-manager.ts`). `test/setup.ts` additionally strips `CODEMAN_PASSWORD`/`CODEMAN_USERNAME` (so auth state from the running instance can't leak into tests) and `CODEMAN_GESTURE` (a shell-exported gesture flag would flip render-injection assertions).

**Ports**: Pick unique ports manually. Search `const PORT =` before adding new tests.

**Respawn tests**: Use `MockSession` from `test/mocks/index.ts` (defined in `test/mocks/mock-session.ts`). **Route tests**: `app.inject({ method, url, payload })` in `test/routes/` — no live port needed. **Mobile tests**: Playwright suite in `test/mobile/` (135 device profiles). Browser-testing infra and practices: `docs/browser-testing-guide.md`.

### Debugging

```bash
tmux list-sessions                                 # List tmux sessions
curl localhost:3000/api/sessions | jq              # Check sessions
curl localhost:3000/api/status | jq                # Full app state
curl localhost:3000/api/subagents | jq             # Background agents
cat ~/.codeman/state.json | jq                     # Persisted state
```

Mobile screenshots: `~/.codeman/screenshots/`, accessed via `GET/POST /api/screenshots`.

### Performance & Limits

Target: 20 sessions, 50 agent windows at 60fps. Limits in `src/config/`: terminal 32MB (see below), text 1MB, messages 1000, max agents 500, max sessions 50, max SSE clients 100. **Terminal history** (`src/config/terminal-history.ts`, COD-80): tmux history-limit 100k lines, PTY buffer 32MB max / 24MB trim (env `CODEMAN_MAX_TERMINAL_BUFFER`/`CODEMAN_TRIM_TERMINAL_TO`; the env-derived trim is clamped ≤75% of max — trim ≥ max would disable `BufferAccumulator` trimming entirely = unbounded memory); browser xterm scrollback stays a separate hardcoded 50k (`DEFAULT_SCROLLBACK` in constants.js — 100k/tab is a mobile-memory hazard). Settings keys `terminalScrollbackLines`/`terminalBufferMaxBytes`/`terminalBufferTrimBytes` are schema-validated but inert (only `tmuxHistoryLimit` is wired live); `buffer-limits.ts` re-exports the defaults. Text/message limits are env-overridable too (`CODEMAN_MAX_TEXT_OUTPUT`/`CODEMAN_TRIM_TEXT_TO`/`CODEMAN_MAX_MESSAGES`). **Image upload** (`image-input.js` / `config/buffer-limits.ts`): up to `_maxBatchImages` 20 images/batch (bounded concurrency 3), per-file `MAX_PASTE_IMAGE_BYTES` 50MB (env `CODEMAN_MAX_PASTE_IMAGE_BYTES`); the mobile camera-roll picker auto-downscales to fit before upload. **HEIC paste uploads** (#151): converted server-side to JPEG in a `worker_threads` worker (`web/heic-jpeg-worker.ts`, resourceLimits + 30s timeout) gated by `runWithConversionLimit()`; detection is magic-byte based (covers Android/MIUI HEIFs mislabeled as JPEG); headers declaring > 64MP are rejected 415 BEFORE decode (decompression-bomb guard). Deps: `heic-decode` + `jpeg-js`. Use `LRUMap` for bounded caches, `StaleExpirationMap` for TTL cleanup. Anti-flicker pipeline: `docs/terminal-anti-flicker.md`.

**Memory leaks (24+ hour sessions)**: use `CleanupManager`, clear Maps in `stop()`, guard async with `if (this.cleanup.isStopped) return`. Frontend: store handler refs, clean in `close*()`. Verify: `npm test -- test/memory-leak-prevention.test.ts`.

## State Files

All in `~/.codeman/`: `state.json` (sessions, settings, respawn, orchestrator, cron jobs/runs), `mux-sessions.json` (tmux recovery), `settings.json` (user prefs), `push-keys.json` (VAPID) + `push-subscriptions.json`, `session-lifecycle.jsonl` (audit log), `update-status.json` (self-updater progress, polled across the service restart), `linked-cases.json`, `webviews.json` (saved web-tab dashboard URLs), `remote-hosts.json` + `remote-cases.json`, `docker-hosts.json` + `docker-cases.json` + `docker-exports/`, `subagent-window-states.json` + `subagent-parents.json` (subagent window layout, GET/PUT `/api/subagent-window-states`/`-parents`), `hook-secret` (per-instance), `users.json` (multi-user, mode 0600) + `admin-audit.jsonl`, `certs/` (self-signed TLS for `--https`), `.env` (CODEMAN_USERNAME/PASSWORD fallback for the `codeman attach` CLI). Transient: `self-update-runner.sh`. Multi-user case spaces live OUTSIDE the data dir at `~/codeman-users/<username>/cases` (shared across instances like `~/codeman-cases`, override `CODEMAN_USER_SPACES_DIR`).

**Generated top-level dirs** (all gitignored — don't edit or commit): `dist/` (esbuild output), `out/`, `coverage/`, `test-results/`, `tmp/`, `screenshots-echo-diag/`. The committed gesture bundle (`src/web/public/gesture/gesture-codeman.js`) IS tracked, but its runtime wasm/model assets (`src/web/public/gesture/wasm/`, `*.task`) are fetched and gitignored.

## Environment & Scripts

### Scripts & Tunnel

Key scripts: `scripts/tmux-manager.sh` (safe tmux mgmt), `scripts/tunnel.sh start|stop|url` (tunnel). Production services: `scripts/codeman-web.service`, `scripts/codeman-tunnel.service`. **Always set `CODEMAN_PASSWORD`** before exposing via tunnel.

### Local IT15 Runtime

- Treat `/home/aakhter/.codeman/app` as the managed checkout. `codeman-ctl` resolves to `/home/aakhter/repos/claude-config/bin/codeman-ctl`, and the IT15 launcher is `/home/aakhter/.local/bin/codeman-it15`.
- The managed app is HTTPS on `127.0.0.1:3000`; the recognized command is `node dist/index.js web --host 127.0.0.1 --port 3000 --https`, with logs under `/home/aakhter/.codeman/logs/` and the pid file at `/home/aakhter/.codeman/codeman-it15.pid`.
- Avoid bare `node dist/index.js web` or `npx codeman web` on port 3000 in this checkout. That starts HTTP, blocks the managed HTTPS app, and makes `codeman-ctl` report the app as stopped while `start` fails with `port 3000 is already in use`.
- When refreshing dependencies, use `CODEMAN_NO_AUTOSTART=1 npm ci` so `scripts/postinstall.js` does not auto-start the bare HTTP server.
- From Codex tool sessions, `setsid /home/aakhter/.local/bin/codeman-it15` is the persistent managed start path; direct `codeman-ctl start` may have its background child reaped by the tool runner.
- If manually launching the rebuilt server from a Codex tool session, use an isolated tmux socket such as `tmux -L codeman-launcher new-session -d -s web -c /home/aakhter/.codeman/app 'NODE_COMPILE_CACHE=/home/aakhter/.codeman/compile-cache node dist/index.js web --host 127.0.0.1 --port 3000 --https >> /home/aakhter/.codeman/logs/codeman-it15.log 2>&1'`. Do **not** launch the web process in the default/Codeman tmux socket with a name like `codeman-web`; the app will discover it as a managed mux session and may show/clean it as a bogus Codeman session.
- Remotes: `origin` is GitHub upstream (`https://github.com/Ark0N/Codeman.git`, the canonical project — merge `origin/master` for upstream updates), `bitbucket` is the personal Bitbucket repo (`git@bitbucket.org:aamer_akhter/codeman.git`, which `local` tracks), and `fork` is the personal GitHub fork (`https://github.com/aakhter/Codeman.git`, for upstream PRs). Local upstream merges should not be pushed unless the user explicitly asks.
- `/mnt/c/Users/aakhter/codeman-fix` was a stale scratch directory and has been removed; do not treat it as a Codeman checkout.
