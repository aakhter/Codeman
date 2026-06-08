# Repository Guidelines

## Project Structure & Module Organization

This is a TypeScript ESM Node app. Runtime code lives in `src/`; Fastify wiring is in `src/web/`, routes in `src/web/routes/`, config in `src/config/`, shared types in `src/types/`, and utilities in `src/utils/`. Browser assets are plain JS/CSS/HTML under `src/web/public/`. Tests live in `test/`, including `test/routes/`, `test/mobile/`, `test/mocks/`, and `test/utils/`. The zero-lag xterm package is in `packages/xterm-zerolag-input/`. Docs belong in `docs/`; automation scripts belong in `scripts/`.

## Build, Test, and Development Commands

- `npm run dev`: run the web app from `src/index.ts` with `tsx`.
- `npm run build`: compile production output into `dist/`.
- `npm run start`: run the built app from `dist/index.js`.
- `npm run typecheck`: run strict TypeScript checks.
- `npm run lint` / `npm run lint:fix`: check or fix ESLint issues in `src/**/*.ts`.
- `npm run format:check` / `npm run format`: check or apply Prettier formatting.
- `npm run check:lockfile`: verify workspace lockfile consistency.

## Coding Style & Naming Conventions

Use TypeScript with ESM imports and NodeNext module resolution. Prettier enforces 2-space indentation, single quotes, semicolons, LF endings, trailing commas, and a 120-column print width. ESLint permits `console`, rejects `debugger`, and warns on explicit `any`. Prefer kebab-case filenames such as `session-routes.ts` and domain-specific modules under `src/config/`, `src/types/`, and `src/utils/`.

## Testing Guidelines

Vitest is configured by `config/vitest.config.ts`; tests match `test/**/*.test.ts` and run in Node with `test/setup.ts`. Prefer targeted runs because some tests create tmux resources:

```bash
npm test -- test/routes/session-routes.test.ts
npm test -- -t "auth"
```

Use `npm run test:coverage` when coverage matters. Route tests should prefer `app.inject()` over live ports.

## Commit & Pull Request Guidelines

Recent history uses Conventional Commit-style subjects, often with Jira keys: `fix(test): COD-25 stabilize mobile visual regression`, `feat: COD-18 add attachment history drawer`, `docs: COD-18 design session attachment history`. The Jira project key is `COD`; use `COD-###` in branch names, commit subjects, and PR titles for Jira-backed work. For multi-PR efforts, create one parent `COD` issue and focused sub-issues per feature/fix PR. Update Jira with branch, PR, commit, and verification before marking work Done. PRs should summarize the problem and approach, link Jira/issues, and include screenshots for UI/mobile changes. Before review, run typecheck, lint, format check, lockfile check, and targeted tests.

For upstream GitHub PRs, do not push branches directly to `Ark0N/Codeman`: GitHub user `aakhter` has read-only permission there. Create upstream PR branches from `upstream/master`, push them to the fork `aakhter/Codeman`, then open PRs against `Ark0N/Codeman:master`. Preserve local work on `origin/local` or another Bitbucket branch when useful, but GitHub PR branches must come from the fork.

## Security & Configuration Tips

Do not commit secrets, `.env`, runtime state, logs, or files from the parent `~/.codeman/` data directory. Validate new configuration through existing config modules and schemas before wiring it into routes or CLI behavior.
