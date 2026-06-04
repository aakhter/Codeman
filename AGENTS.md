# Repository Guidelines

## Project Structure & Module Organization

Codeman is a TypeScript ESM Node project. Core backend code lives in `src/`, with web routes in `src/web/routes/`, web server wiring in `src/web/`, config in `src/config/`, shared types in `src/types/`, and utilities in `src/utils/`. Browser assets are plain JavaScript/CSS under `src/web/public/`. Tests live in `test/`, with route tests in `test/routes/`, mobile Playwright/Vitest tests in `test/mobile/`, and mocks in `test/mocks/`. The standalone xterm local-echo package lives in `packages/xterm-zerolag-input/`; behavior copied into the web UI must stay in sync. Documentation and plans are in `docs/`, scripts in `scripts/`, and build/lint/test config in `config/`.

## Build, Test, and Development Commands

- `npm run dev`: start the local web app via `tsx src/index.ts web`.
- `npm run build`: build production output into `dist/` using `scripts/build.mjs`.
- `npm run start`: run the built CLI/web app from `dist/index.js`.
- `npm run typecheck`: run `tsc --noEmit`.
- `npm run lint` / `npm run lint:fix`: check or fix TypeScript lint issues.
- `npm run format:check` / `npm run format`: check or apply Prettier formatting.
- `npm run check:lockfile`: verify workspace lockfile sync.

## Coding Style & Naming Conventions

Use TypeScript with strict compiler settings and ESM imports only; avoid `require()`. Prettier uses single quotes, trailing commas where valid, and a 120-column print width. ESLint allows `console`, errors on `debugger`, and warns on explicit `any`. Prefer domain-specific files such as `src/web/routes/*-routes.ts`, `src/types/*.ts`, and `src/config/*.ts`; import config from specific files rather than barrels. Keep route handlers schema-validated with Zod where request input is accepted.

## Testing Guidelines

Vitest is the primary test framework. Do not run bare `npm test` in managed Codeman/tmux sessions because the full suite can spawn and clean up tmux sessions. Prefer targeted runs:

```bash
npm test -- test/routes/session-routes.test.ts
npm test -- -t "auth"
```

Route tests should use `app.inject()` instead of live ports. When adding tests that need ports, search for existing `const PORT =` values and choose a unique one. Coverage is available with `npm run test:coverage`.

## Commit & Pull Request Guidelines

Recent history uses Conventional Commit-style messages such as `feat(web): ...`, `fix: ...`, `docs: ...`, and `chore: version packages`. Keep commits scoped and descriptive. Pull requests should include the problem, the approach, linked issues when available, and screenshots or screen recordings for UI/mobile changes. Before opening a PR, run `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run check:lockfile`, and relevant targeted tests.

## Branch Workflow

Do not develop new features or bug fixes directly on `master`. Start from an up-to-date `master`, create a focused branch such as `fix/mobile-toolbar-overlap` or `feat/session-search`, commit there, then merge or open a pull request after verification. Keep uncommitted work on the branch until it is ready to integrate.

## Security & Configuration Tips

Do not commit secrets or local state from `~/.codeman/`. Auth and CLI behavior are controlled through environment variables such as `CODEMAN_USERNAME`, `CODEMAN_PASSWORD`, `CLAUDE_CODE_*`, and `OPENCODE_*`; validate new settings through the existing schemas and prefix allowlists.
