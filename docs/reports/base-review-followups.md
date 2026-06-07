# Codeman Base Review Follow-ups

Date: 2026-06-07

## Scope

Overall review of the current Codeman source tree at `/home/aakhter/.codeman/app`.

## Findings To Revisit

### 1. Dependency Audit

Initial review: `npm audit` reported 22 vulnerabilities: 14 moderate, 6 high, and 2 critical.

Status on 2026-06-07: critical and high findings were remediated by updating direct dependency ranges, adding targeted transitive overrides, and refreshing both root and standalone xterm lockfiles. `npm audit --audit-level=high` now passes for the root app, and `npm audit --workspaces=false --audit-level=high` passes for `packages/xterm-zerolag-input`.

Remaining moderate advisories:

- `@fastify/static`
- `brace-expansion`
- `ip-address`
- `uuid`
- `ws` through direct and Remotion paths

Priority packages:

- Runtime/direct: `fastify`, `@fastify/static`, `uuid`
- Test/dev direct: `vitest`, `@vitest/coverage-v8`
- Dev tooling/transitive: `vite`, `ws`, `@remotion/cli`, `basic-ftp`, `fast-uri`, `flatted`, `picomatch`

Avoid blind `npm audit fix --force`; the remaining moderate fixes still include breaking or out-of-range upgrades.

### 2. Network Auth Fail-closed

Codeman currently starts on non-loopback hosts without `CODEMAN_PASSWORD` and only logs a warning. For a terminal-control app, this should fail closed unless an explicit allow-unauthenticated-network flag is supplied.

### 3. Arbitrary File Download

`GET /api/download` accepts any absolute readable path and relies on a sensitive-path blocklist. Replace with session-scoped downloads, an allowlist, or a per-link capability model.

### 4. Inline Workspace SVG

`file-raw` serves workspace `.svg` as `image/svg+xml`, while CSP still allows inline script. Treat workspace SVG as untrusted: serve as attachment/octet-stream or sanitize.

### 5. Frontend Tooling Gap

Project lint/format scripts only cover TypeScript, while `src/web/public` is a large plain JS/CSS/HTML surface. Add frontend syntax/lint/format checks. Also remove literal NUL bytes from `src/web/public/app.js`; they make common text tools treat the source as binary.

### 6. Current Lint Failure

`npm run lint` fails on intentional ANSI-control regexes in `src/tmux-manager.ts`. Add targeted `eslint-disable no-control-regex` comments or move the regex to a named constant with a local disable.

### 7. Large Core Modules

Further split central files:

- `src/respawn-controller.ts`
- `src/session.ts`
- `src/ralph-tracker.ts`
- `src/tmux-manager.ts`
- `src/web/server.ts`

Focus on extracting timers, state-machine transitions, and command-construction logic.

## Verification From Review

Passing:

- `npm run typecheck`
- `npm run format:check`
- `npm run check:lockfile`
- `node --check` for top-level `src/web/public/*.js`
- Targeted tests: `test/routes/file-routes.test.ts`, `test/auth-security.test.ts`, `test/routes/ws-routes.test.ts`

Failing:

- `npm run lint` due to two `no-control-regex` findings in `src/tmux-manager.ts`
- `npm audit --audit-level=moderate` due to dependency vulnerabilities

Not run:

- Full `npm test`, because repo guidance warns against bare full-suite runs in managed Codeman/tmux sessions.
