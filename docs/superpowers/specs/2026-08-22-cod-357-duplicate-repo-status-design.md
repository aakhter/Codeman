# COD-357 Duplicate Repository-Status Route Design

## Problem

The merged production source registers `GET /api/system/repo-status` twice in `registerSystemRoutes`. Fastify rejects duplicate method/path registrations during startup, so the rebuilt server exits before listening. The previous server process remained alive while `dist/` was replaced, leaving the browser and in-memory backend on different builds.

## Design

Keep the established repository-status route and its `getRepositoryStatus()` handler unchanged. Remove only the redundant registration introduced by the merge. Add route-level coverage that registers the complete system route module and calls the endpoint, proving both that registration completes without a duplicate-route exception and that repository-status functionality remains available.

## Verification

Run the focused system-routes test first and observe the duplicate-route failure. After the minimal source edit, rerun that test, then run typecheck, lint, formatting, lockfile validation, and the production build. Deploy the resulting commit to the shared `local` checkout, restart through `codeman-ctl`, and verify readiness plus restoration of every live session on `tmux -L codeman`.

## Non-goals

- No repository-status behavior, response schema, or UI changes.
- No tmux session changes.
- No unrelated merge cleanup.
