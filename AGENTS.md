# Repository Guidelines

## Project Structure & Module Organization

This is a TypeScript ESM Node app. Runtime code lives in `src/`; Fastify wiring is in `src/web/`, routes in `src/web/routes/`, config in `src/config/`, shared types in `src/types/`, and utilities in `src/utils/`. Browser assets are plain JS/CSS/HTML under `src/web/public/`. Tests live in `test/`, including `test/routes/`, `test/mobile/`, `test/mocks/`, and `test/utils/`. Workspace packages live in `packages/`: `xterm-zerolag-input/` (local-echo overlay) and `gesture-control/` (camera hand-tracking overlay, built to `src/web/public/gesture/`). Docs belong in `docs/`; automation scripts belong in `scripts/`. Two subsystems beyond the core session manager: **remote sessions** run the agent inside tmux on an SSH host (`src/remote-hosts.ts`; design in `docs/remote-sessions.md`), and **document preview/export** turns session files into previewable/diffable/exportable docs (`src/document-*.ts`, `src/attachment-*.ts`; design in `docs/document-preview.md`).

## Build, Test, and Development Commands

- `npm run dev`: run the web app with `tsx` (script is `tsx src/index.ts web` — the `web` subcommand is required to start the server).
- `npm run build`: bundle production output into `dist/` via esbuild (`scripts/build.mjs`), NOT `tsc`. `npm run typecheck` (`tsc --noEmit`) is type-check only and emits nothing.
- `npm run start`: run the built app (`node dist/index.js`). Pass the subcommand explicitly, e.g. `node dist/index.js web --host 127.0.0.1 --port 3000 --https`; bare `npm run start` does not launch the web server on its own.
- `npm run typecheck`: run strict TypeScript checks.
- `npm run lint` / `npm run lint:fix`: check or fix ESLint issues in `src/**/*.ts`.
- `npm run format:check` / `npm run format`: check or apply Prettier formatting.
- `npm run check:lockfile`: verify workspace lockfile consistency.
- `aicodeman doctor` (alias `check-deps`): report on the external tools Codeman uses — agent CLIs (Claude, OpenCode, Codex, Gemini), tmux, and LibreOffice/MS Office (DOCX→PDF preview & thumbnails). Environment-aware (detects WSL and resolves Windows-side apps via interop). Only Node and tmux are hard-required (non-zero exit if missing); agent CLIs and office tools are advisory. `--json` for machine output. Dev: `npx tsx src/index.ts doctor`.

## Coding Style & Naming Conventions

Use TypeScript with ESM imports and NodeNext module resolution. Prettier enforces 2-space indentation, single quotes, semicolons, LF endings, trailing commas, and a 120-column print width. ESLint permits `console`, rejects `debugger`, and warns on explicit `any`. Prefer kebab-case filenames such as `session-routes.ts` and domain-specific modules under `src/config/`, `src/types/`, and `src/utils/`.

## Testing Guidelines

Vitest is configured by `config/vitest.config.ts`; tests match `test/**/*.test.ts` and run in Node with `test/setup.ts`.

**CRITICAL — never run the full suite from a managed session.** You are likely running inside a Codeman-managed tmux session (`echo $CODEMAN_MUX` → `1`). Bare `npm test` (and raw `npx vitest run`) executes the whole suite, which spawns and kills tmux sessions and **can crash the session you're running in**. Always scope runs to a single file or name pattern:

```bash
npm test -- test/routes/session-routes.test.ts   # single file (safe)
npm test -- -t "auth"                             # by name (safe)
# npm test                                        # DANGEROUS — full suite, do NOT run
```

`test/setup.ts` snapshots pre-existing tmux sessions and only cleans up ones registered via `registerTestTmuxSession()`. Use `npm run test:coverage` when coverage matters. Route tests should prefer `app.inject()` over live ports.

## Commit & Pull Request Guidelines

The working and deploy repository for this box is Bitbucket:
`https://bitbucket.org/aamer_akhter/codeman/src`. Treat `Ark0N/Codeman` as off-limits:
do not create issues, branches, commits, PRs, comments, or any other resources there. The local remotes may vary, so check
`git remote -v`; on this checkout `origin` is Bitbucket (`aamer_akhter/codeman`) and `upstream` is the read-only GitHub
project (`Ark0N/Codeman`) for reference only. Recent history uses Conventional Commit-style subjects, often with Jira keys:
`fix(test): COD-25 stabilize mobile visual regression`, `feat: COD-18 add attachment history drawer`,
`docs: COD-18 design session attachment history`. The Jira project key is `COD`; use `COD-###` in branch names, commit
subjects, and PR titles for Jira-backed work. Never start implementation work on a bug or feature until a Jira issue exists
for that work. Create and update issues through the local Jira CLI using `JIRA_PROFILE=work`, site
`JIRA_SITE=https://aakhter.atlassian.net`, and project `COD` (for example, `JIRA_PROFILE=work JIRA_SITE=https://aakhter.atlassian.net jira create --project COD ...`);
do not use Jira MCP, GitHub Issues, or Bitbucket Issues. For multi-PR efforts, create one
parent `COD` issue and focused sub-issues per feature/fix PR. Update
Jira with branch, PR, commit, and verification before marking work Done. PRs should summarize the problem and approach,
link Jira/issues, and include screenshots for UI/mobile changes. Before review, run typecheck, lint, format check, lockfile
check, and targeted tests.

## Session Safety

You may be running inside a Codeman-managed tmux session. Before killing any tmux or Claude process:

1. Check `echo $CODEMAN_MUX` — `1` means you're in a managed session.
2. **Never** run `tmux kill-session`, `pkill tmux`, or `pkill claude` without confirming the target.
3. Use the web UI or `scripts/tmux-manager.sh` instead of direct kill commands.

For deployment (the "COM" changeset/version/restart flow), session-safety details, and the full architecture map, see `CLAUDE.md` and the `docs/` directory.

## Security & Configuration Tips

Do not commit secrets, `.env`, runtime state, logs, or files from the parent `~/.codeman/` data directory. Validate new configuration through existing config modules and schemas before wiring it into routes or CLI behavior.
