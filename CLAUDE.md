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
6. **Wait for CI**: after `git push`, find the run with `gh run list -L 1 --json databaseId,headBranch -q '.[0].databaseId'` and watch it with `gh run watch <id> --exit-status`. Confirm all checks pass before considering the release done.

CI runs `npm run check:lockfile` on every push/PR, so lockfile drift fails the build even if the `version-packages` script is bypassed.

**Version**: 0.9.14 (must match `package.json`)

## Project Overview

Codeman is a Claude Code session manager with web interface and autonomous Ralph Loop. Spawns Claude CLI via PTY, streams via SSE, supports respawn cycling for 24+ hour autonomous runs.

**Tech Stack**: TypeScript (ES2022/NodeNext, strict mode), Node.js, Fastify, node-pty, xterm.js. Supports Claude Code, OpenCode, Codex (OpenAI), and Gemini CLIs via pluggable CLI resolvers (`SessionMode = 'claude' | 'shell' | 'opencode' | 'codex' | 'gemini'`).

**TypeScript Strictness** (see `tsconfig.json`): `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `allowUnreachableCode: false`, `allowUnusedLabels: false`.

**Requirements**: Node.js 22+, Claude CLI, tmux

**Git**: Main branch is `master`. SSH session chooser: `sc` (interactive), `sc 2` (quick attach), `sc -l` (list).

**Import conventions**: Utils from `./utils`, types from `./types` (barrel), config from specific `./config/*` files.

## Architecture

### Core Files (by domain)

| Domain | Key files | Notes |
|--------|-----------|-------|
| **Entry** | `src/index.ts`, `src/cli.ts` | |
| **Session** | `src/session.ts` ★, `src/session-manager.ts`, `src/session-auto-ops.ts`, `src/session-cli-builder.ts`, `src/session-lifecycle-log.ts`, `src/session-task-cache.ts`, `src/usage-limit-patterns.ts` | |
| **Mux** | `src/mux-interface.ts`, `src/mux-factory.ts`, `src/tmux-manager.ts` ★ | |
| **Respawn** | `src/respawn-controller.ts` ★ + 4 helpers (`-adaptive-timing`, `-health`, `-metrics`, `-patterns`) | Read `docs/respawn-state-machine.md` first |
| **Ralph** | `src/ralph-tracker.ts` ★, `src/ralph-loop.ts` + 5 helpers (`-config`, `-fix-plan-watcher`, `-plan-tracker`, `-stall-detector`, `-status-parser`) | Read `docs/ralph-wiggum-guide.md` first |
| **Orchestrator** | `src/orchestrator-loop.ts`, `src/orchestrator-planner.ts`, `src/orchestrator-verifier.ts` | Read `docs/orchestrator-loop-architecture.md` first |
| **Agents** | `src/subagent-watcher.ts` ★, `src/team-watcher.ts`, `src/bash-tool-parser.ts`, `src/transcript-watcher.ts` | |
| **AI** | `src/ai-checker-base.ts`, `src/ai-idle-checker.ts`, `src/ai-plan-checker.ts` | |
| **Tasks** | `src/task.ts`, `src/task-queue.ts`, `src/task-tracker.ts` | |
| **State** | `src/state-store.ts`, `src/run-summary.ts`, `src/session-lifecycle-log.ts` | |
| **Documents** | `src/document-preview-cache.ts`, `src/document-pdf-export.ts`, `src/document-text-extract.ts`, `src/document-thumbnailer.ts`, `src/document-version-store.ts`, `src/attachment-registry.ts`, `src/attachment-magic.ts`, `src/session-attachment-history.ts` | Office/markdown preview, PDF export, version history + diff/rollback, attachment cards (COD-58/59/61/66). See `docs/document-preview.md` |
| **Remote** | `src/remote-hosts.ts` | SSH remote hosts/cases — `~/.codeman/remote-hosts.json` + `remote-cases.json`. See `docs/remote-sessions.md` |
| **Infra** | `src/hooks-config.ts`, `src/push-store.ts`, `src/tunnel-manager.ts`, `src/image-watcher.ts`, `src/file-stream-manager.ts` | |
| **Plan** | `src/plan-orchestrator.ts`, `src/prompts/*.ts`, `src/templates/` (`claude-md.ts` + `case-template.md`, the CLAUDE.md scaffold generated into new cases) | |
| **Web** | `src/web/server.ts` ★, `src/web/sse-events.ts`, `src/web/routes/*.ts` (15 route modules + barrel; `session-routes.ts` ★), `src/web/route-helpers.ts`, `src/web/ports/*.ts`, `src/web/middleware/auth.ts`, `src/web/schemas.ts`, `src/web/self-update.ts` | |
| **Frontend** | `src/web/public/app.js` (~4.2K lines, core) + 18 infra/domain/feature modules + `sw.js` | Full map, load order, gesture: `docs/frontend-architecture.md` |
| **Types** | `src/types/index.ts` (barrel) → 15 domain files; also `src/types.ts` root re-export | See `@fileoverview` in index.ts |

★ = Large, central file (>50KB) — read its `@fileoverview` first. All files have `@fileoverview` JSDoc — read that before diving in. Discovery aid: `grep -l '@fileoverview' src/web/routes/*.ts` lists all route modules; same grep works for `src/types/`, `src/web/public/*.js`.

**Local packages**: `packages/xterm-zerolag-input/` (local-echo overlay) and `packages/gesture-control/` (`codeman-gesture-control`, hand-tracking overlay). Both are single-source and bundled into `src/web/public/` — see Common Gotchas and `docs/frontend-architecture.md`.

**Config**: `src/config/` — 17 files, no barrel (`index.ts`) exists; import from the specific file.

**Utilities**: `src/utils/` — re-exported via index. Key: `CleanupManager`, `LRUMap`, `StaleExpirationMap`, `BufferAccumulator`, `stripAnsi`, `Debouncer`, `KeyedDebouncer`. Also: `claude-cli-resolver`/`opencode-cli-resolver`/`codex-cli-resolver`/`gemini-cli-resolver` (CLI path resolution), `string-similarity` (fuzzy matching), `regex-patterns` (ANSI/token/spinner patterns), `assertNever` (exhaustive checks), `token-validation` (auth tokens), `nice-wrapper` (process priority).

### Data Flow

1. Session spawns `claude --dangerously-skip-permissions` via node-pty
2. PTY output buffered, ANSI stripped, parsed for JSON messages
3. WebServer broadcasts to SSE clients at `/api/events`
4. State persists to `~/.codeman/state.json` via StateStore

### Key Patterns

**Input**: `session.writeViaMux()` for programmatic input — tmux `send-keys -l` (literal) + `send-keys Enter`. Single-line only.

**Idle detection**: Multi-layer (completion message → AI check → output silence → token stability). See `docs/respawn-state-machine.md`.

**Auto-resume on usage limit** ("token pause", opt-in per session, top of the Respawn tab): when Claude halts on a subscription limit ("5-hour limit reached ∙ resets 8pm" and 1.0.x–2.1.x variants), `usage-limit-patterns.ts` (pure, unit-tested) parses the reset time; `SessionAutoOps` arms a timer for reset+2min, then sends Esc + `continue`. Still-limited responses re-arm (5-min retry on stale times); a `working` transition cancels it. Claude-mode only. Persists via `SessionState.autoResumeEnabled`/`autoResumeAt`; respawn cycles are blocked while paused (`isLimitPaused` guard in `onIdleDetected` — prevents `/clear` wiping the paused conversation). Endpoint `POST /api/sessions/:id/auto-resume`; SSE `session:limitPauseScheduled`/`limitResume`/`limitResumeCancelled`. Tests: `test/usage-limit-patterns.test.ts`, `test/session-auto-resume.test.ts`.

**Orchestrator**: State machine turning a user goal into a phased plan and driving it to completion (`idle → planning → approval → executing → verifying → (replanning) → completed/failed`); persists under the `orchestrator` key in `state.json`. Distinct from Ralph (single-session loop) — the orchestrator coordinates multi-phase, multi-agent execution. Full design: `docs/orchestrator-loop-architecture.md`.

**External CLI modes (OpenCode, Codex, Gemini)**: `isExternalCliMode()` in `session.ts` gates Claude-specific behavior (Ralph tracker, BashToolParser, token parsing, ❯-prompt readiness all skipped — these CLIs render their own TUIs). They **require tmux — no PTY fallback** because secrets are injected via `tmux setenv`. Full design incl. Codex `buildCodexCommand()` specifics and `GET /api/codex/status`: `docs/external-cli-modes.md` (OpenCode resolver: `docs/opencode-integration.md`).

**Remote sessions (SSH)**: Sessions can run the agent inside `tmux -L codeman new-session -A` **on a remote host** so it survives the SSH drop (COD-104), and can also **discover + attach** to `codeman-*` sessions another Codeman launched there — attached (`owned:false`) sessions **detach, never kill** on tab close (COD-105). ⚠️ Command-injection surface (COD-107): all ssh command lines flow through the single shell-safe `buildSshConnectionArgs()` — every user field (`-J jumpHost`, `-i identity`, `-o`) is `shellescape`d; never hand-build an ssh line elsewhere. Full design: `docs/remote-sessions.md`.

**Document preview / attachments** (COD-58/59/61/66): file preview (Office→PDF via `soffice`), one-click PDF export, in-memory revision history + diff/rollback, and attachment cards. Endpoints live on **`file-routes.ts`**. Attachments are addressed by minted IDs so browser requests never carry absolute paths. Full design: `docs/document-preview.md`.

**Headroom (context-compression proxy)** (COD-98/COD-102): optional **health-gated** upstream proxy that compresses context to extend the window; settings-driven (`headroomProxyUrl`/`headroomRouteClaude`/`headroomRouteCodex` read at call time — `""` = kill-switch), injecting `ANTHROPIC_BASE_URL` (Claude) / a `config.toml` patch (Codex), falling back to the direct API when down. Full design: `docs/headroom-proxy.md`.

**Hook events**: Claude Code hooks trigger via `/api/hook-event`. Key events: `permission_prompt`, `elicitation_dialog`, `idle_prompt`, `stop`, `teammate_idle`, `task_completed`. See `src/hooks-config.ts`; upstream semantics in `docs/claude-code-hooks-reference.md`.

**Agent Teams**: `TeamWatcher` polls `~/.claude/teams/`, matches to sessions via `leadSessionId`. Teammates are in-process threads appearing as subagents. Enable: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. See `docs/agent-teams/`.

**Circuit breaker**: Prevents respawn thrashing. States: `CLOSED` → `HALF_OPEN` → `OPEN`. Reset: `/api/sessions/:id/ralph-circuit-breaker/reset`.

**Self-update** (App Settings → Updates): in-app updater for **git-clone installs** supervised by systemd/launchd (npm installs are non-updatable). Because it restarts the very process running it, a DETACHED `scripts/self-update.sh` does the `git checkout <tag> && npm install && npm run build && restart` and writes `dataPath('update-status.json')`, which the browser polls across the connection drop. `src/web/self-update.ts` splits PURE helpers (unit-tested) from IO wrappers. Routes under `/api/system/update`. Full design (supervisor detection, reconcile-on-boot): `docs/self-update.md`.

**Port interfaces**: Routes declare dependencies via port interfaces (`src/web/ports/`). Routes use intersection types (e.g. `SessionPort & EventPort`).

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
| **Hook bypass** | `/api/hook-event` exempt from auth (localhost-only, schema-validated). While the **managed tunnel** runs, the bypass additionally requires the per-instance `X-Codeman-Hook-Secret` header (COD-54, `config/hook-secret.ts`): hook curls cat the secret file at exec time via `$CODEMAN_HOOK_SECRET_FILE` (session env), failures rate-limit in a dedicated bucket (never lock out login). External loopback proxies (own cloudflared/`tailscale serve`) aren't detected — plain bypass still applies there. Tunnel enable also **refuses** without `CODEMAN_PASSWORD` unless `CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK=1` (COD-55) |
| **Env vars** | `CODEMAN_MUX` (managed session), `CODEMAN_API_URL` (auto-set for hooks), `CODEMAN_ALLOWED_HOSTS` (extra Host/Origin allowlist entries for reverse proxies, comma-separated; bare `.suffix` matches subdomains) |
| **Validation** | Zod schemas, path allowlist regex, env prefix allowlist (`CLAUDE_CODE_*`/`OPENCODE_*`/`CODEX_*`) |
| **Headers** | CORS localhost-only, CSP, X-Frame-Options, HSTS if HTTPS |

### SSE Event Registry

~120 event types in `src/web/sse-events.ts` (backend) and `SSE_EVENTS` in `constants.js` (frontend). Both must be kept in sync.

### API Routes

~155 handlers across 15 route files in `src/web/routes/`: system (~44, incl. self-update `check`/`status`/`POST /api/system/update`, `POST /api/system/span-displays` → spawns `scripts/span-codeman.sh`, and `GET /api/codex/status`), sessions (~30), files (~20, file browser + the document/attachment endpoints — see the Document preview Key Pattern), cases (~14, incl. `GET/POST/PUT/DELETE /api/remote-hosts(/:id)` + `POST /api/cases/remote-link`), orchestrator (10), ralph (9), plan (7), respawn (7), mux (5), push (4), scheduled (4), teams (2), hooks (1), clipboard (1), ws (1 WebSocket). Counts drift as endpoints are added — re-grep `\.(get|post|put|delete)\(` per file rather than trusting these. Each file has `@fileoverview` with endpoint details.

**HTTP contract** (stable since 0.9.x): responses use the `ApiResponse<T>` envelope — `{ success: true, data? }` or `{ success: false, error, errorCode }` (`src/types/api.ts`). `/api/v1/*` is a versioned alias of `/api/*` (URL rewrite in `server.ts`). Full envelope/status/error-code/SSE spec: `docs/api-reference.md`.

## Frontend

The browser frontend is plain JS/CSS/HTML under `src/web/public/` — no framework, no runtime bundler. The full module map, exact load order, z-index contract, opt-in header buttons (multi-monitor, response-viewer), the gesture-control overlay, and cache-busting are documented in **`docs/frontend-architecture.md`**. Read it before touching frontend wiring.

**Keyboard shortcuts**: Escape (close), Ctrl+? (help), Ctrl+W (kill), Ctrl+Tab (next), Alt+1-9 (switch tab), Ctrl+Shift+{/} (move tab left/right), Shift+Enter (newline), Ctrl+L (clear), Ctrl+Shift+R (restore size), Ctrl+Shift+V (voice input), Ctrl/Cmd +/- (font).

**Respawn presets**: `solo-work` (3s/60min), `subagent-workflow` (45s/240min), `team-lead` (90s/480min), `ralph-todo` (8s/480min), `overnight-autonomous` (10s/480min).

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

**Tmux safety**: under vitest (`VITEST` env var, set automatically), `TmuxManager` no-ops ALL shell commands and becomes a pure in-memory mock — tests physically cannot create/kill/attach real tmux sessions (`IS_TEST_MODE` in `src/tmux-manager.ts`). `test/setup.ts` additionally strips `CODEMAN_PASSWORD`/`CODEMAN_USERNAME` so auth state from the running instance can't leak into tests.

**Ports**: Pick unique ports manually. Search `const PORT =` before adding new tests.

**Respawn tests**: Use `MockSession` from `test/respawn-test-utils.ts`. **Route tests**: `app.inject({ method, url, payload })` in `test/routes/` — no live port needed. **Mobile tests**: Playwright suite in `test/mobile/` (135 device profiles). Browser-testing infra and practices: `docs/browser-testing-guide.md`.

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

Target: 20 sessions, 50 agent windows at 60fps. Limits in `src/config/`: terminal 2MB, text 1MB, messages 1000, max agents 500, max sessions 50, max SSE clients 100. Use `LRUMap` for bounded caches, `StaleExpirationMap` for TTL cleanup. Anti-flicker pipeline: `docs/terminal-anti-flicker.md`.

**Memory leaks (24+ hour sessions)**: use `CleanupManager`, clear Maps in `stop()`, guard async with `if (this.cleanup.isStopped) return`. Frontend: store handler refs, clean in `close*()`. Verify: `npm test -- test/memory-leak-prevention.test.ts`.

## State Files

All in `~/.codeman/`: `state.json` (sessions, settings, respawn), `mux-sessions.json` (tmux recovery), `settings.json` (user prefs), `push-keys.json` (VAPID), `push-subscriptions.json`, `session-lifecycle.jsonl` (audit log), `update-status.json` (self-updater progress, polled across the service restart).

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
- Remotes are Bitbucket `origin` and GitHub `upstream` (`https://github.com/Ark0N/Codeman.git`). Local upstream merges should not be pushed unless the user explicitly asks.
- `/mnt/c/Users/aakhter/codeman-fix` was a stale scratch directory and has been removed; do not treat it as a Codeman checkout.
