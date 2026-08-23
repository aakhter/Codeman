# COD-369 Predictive Browser Isolation Design

## Problem

`test/codex-predictive-echo.test.ts` currently shares one browser page, one xterm instance, one WebSocket, one Codex
process, and one tmux pane across every scenario. Tests mutate that shared lifecycle by switching sessions, toggling local
echo, removing the predictor, submitting commands, triggering retry behavior, and wrapping terminal writes. A failed
assertion can skip restoration, while later reset helpers try to reconstruct a clean composer inside a lifecycle that is
already stale or exited.

Three test-only synchronization attempts improved individual boundaries but independent repeated runs continued to fail
at different lifecycle points: initial composer startup, stale xterm state, WebSocket/session identity changes, and Codex
or tmux exit. The correct boundary is scenario isolation, not more reset logic.

## Selected Architecture

Share only a disposable Codeman server and Chromium process for the file. Each semantic scenario receives a fresh:

- browser context and page;
- `CODEX_HOME` and working directory;
- real Codex session;
- production WebSocket/xterm lifecycle;
- tmux-backed pane on the file's unique disposable socket.

The suite is sequential and permits at most one live scenario session. Each scenario is deleted and its resources are
verified absent before the next scenario begins.

## Lab Harness

The file-level harness owns a temporary root, dynamically allocated loopback port, explicit `CODEMAN_DATA_DIR`, unique
`CODEMAN_TMUX_SOCKET`, one child Codeman server, and one Chromium process. The child environment excludes Vitest marker
variables. Readiness fails immediately if the child exits.

The file-level teardown is a backstop: clean any ledgered sessions, close Chromium, terminate and reap the exact child,
verify the port is released, stop only the unique disposable tmux socket, and remove the temporary root.

## Scenario Fixture

`withCodexScenario(name, options, body)` allocates unique scenario paths, writes isolated Codex auth/config, creates a
fresh browser context/page, applies settings through an init script, creates one real Codex session, derives its exact
tmux target, selects it, crosses the readiness barrier, and calls the scenario body.

Its `finally` path independently attempts every cleanup step:

1. Close the browser context.
2. Delete the exact session through the API.
3. Verify the session returns 404.
4. Verify the exact tmux target is absent.
5. Remove the scenario directory.

Cleanup continues after individual failures and preserves both body and cleanup errors with `AggregateError`.

## Readiness Barrier

Readiness is observed continuously for 300 ms and resets whenever any predicate changes. It requires:

- exact active session identity;
- connected, open, session-bound production WebSocket;
- drained reliable-delivery, POST, input, and terminal-render queues;
- initialized terminal element, textarea, buffer, and renderer;
- live exact tmux pane;
- matching active tmux/xterm cursor coordinates and row text;
- an empty Codex composer row with no predictor anchor hold.

This is an observed-state condition, not a fixed settle delay.

## Scenario Mapping

- Bootstrap and basic typed convergence share one scenario.
- Slash picker, typed text plus paste, wrapped input, untrusted modal, kill switch, mid-word edit/submit, and simulated RTT
  each use their own scenario.
- Byte identity uses two sequential isolated scenarios inside one test, one with prediction active and one absent.
- No scenario switches back to another session or relies on `resetComposer()`/`cancelRetryLoop()` to recover shared state.

All existing semantic assertions remain: exact input bytes, predictive visibility and reconciliation, modal gating,
trusted/untrusted behavior, kill switch, paste and wrapped input, edits, submission, retry handling, and simulated RTT.

## Verification and Stop Conditions

- Contract tests first prove unique identities, partial-setup unwinding, failure-path cleanup, error aggregation, and
  readiness rejection for wrong session/socket/queues/pane/composer.
- Migrate one basic real scenario and pass it twice before migrating the rest.
- The complete real-Codex file must pass at least three consecutive runs, followed by the combined COD-368 browser gate.
- Every run must leave the dynamic port closed, no exact tmux socket/session, no child process, and no fixture paths.
- Do not weaken predictor assertions, permit TTL/mismatch losses as success, or replace real lifecycle checks with sleeps.
