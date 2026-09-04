# COD-395 Recovery Smoke and Deployment Reliability Design

## Goal

Make the recovery feature verifiable through a temporary Codeman instance, prevent the smoke harness from failing on the current Codex directory-trust prompt, make deployment health checking wait for normal startup, and stop reporting an already-exited child as a cleanup error.

## Boundaries

- The temporary smoke must use its own server, HOME, tmux socket, sessions, and cleanup. It must never reboot the host, alter the normal Codeman service, or reuse normal session state.
- The Recovery Queue scenario creates durable recovery evidence through test-only app APIs/state seams. It confirms queue display and explicit user action; it never auto-resumes a candidate.
- It covers local resumable and manual-required custom Codex records. Owned-remote reattach is covered only when the existing remote-smoke environment variables are configured; otherwise the scenario reports an explicit skip, not a pass.
- The globally installed smoke and deployment scripts are operational tooling, not Bitbucket application source. Their changes are tested in place and documented in their COD issues.

## Components

### COD-396: Trust prompt compatibility

Extend the smoke prompt helper to recognize both legacy trust controls and the current numbered "Trust the contents of this directory" prompt. It sends the explicit safe selection only while that exact prompt is visible, waits for redraw, and fails the smoke if the prompt remains. Add a small helper-level regression that supplies terminal text and records the selected input.

### COD-397: Recovery Queue browser smoke

Add an opt-in `--include-recovery-smoke` path to the temporary smoke script. It seeds only smoke-prefixed recovery records after the isolated app starts, opens the Session Manager, proves no resume request happened merely by opening it, verifies the resumable and manual-required rows, confirms a local resume through the existing API, and dismisses all remaining records during cleanup. The default smoke remains fast and does not execute this path unless requested. A remote reattach assertion runs only with the existing remote environment configuration.

### COD-398: Startup-aware deployment health check

Replace the deployment script's one-shot curl with a bounded retry loop. It probes each configured URL once per attempt, reports attempt counts, waits a short fixed interval, and exits nonzero only after the configured deadline. It never retries merge, build, or restart failures. Extract the pure loop inputs into shell environment defaults so a shell regression can use a local delayed HTTP server.

### COD-399: Expected child-exit cleanup

Session shutdown treats `ESRCH` from direct-process and process-group SIGKILL as an already-finished cleanup operation. Other errors retain warning logging. Tests stub process kill to raise `ESRCH` and assert shutdown succeeds without warning, while a different error remains visible.

## Verification

- Unit/route tests for session stop, recovery routes, and Recovery Queue UI remain scoped; never run bare `npm test` from a Codeman-managed session.
- The temporary smoke runs with the new recovery flag after prompt handling is fixed. Its final summary and artifact directory are retained as evidence.
- The deployment script is tested against a disposable delayed local HTTP listener and then used only after all project tests/reviews approve.
- Before integration: typecheck, lint, format check, lockfile check, targeted tests, and `git diff --check` must pass. Global-script changes are checked with `node --check`/`bash -n` and their focused harness tests.
