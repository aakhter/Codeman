# COD-369 Predictive Browser Isolation Implementation Plan

**Goal:** Make the real-Codex predictive browser gate deterministic by isolating every semantic scenario while preserving
all existing production-path assertions.

**Design:** `docs/superpowers/specs/2026-08-23-cod-369-predictive-browser-isolation-design.md`

### Task 1: Add fixture contracts

- [ ] Add failing tests for unique scenario identities, partial-setup cleanup, cleanup-after-body-failure, aggregated
      cleanup errors, and readiness rejection for wrong session/socket/queue/pane/composer state.
- [ ] Implement the smallest pure fixture/readiness helpers required for those contracts.
- [ ] Verify the focused contracts are green.

### Task 2: Build the disposable lab and scenario lifecycle

- [ ] Replace the fixed port/socket with a dynamic loopback port and unique disposable tmux socket.
- [ ] Keep only server and Chromium at file scope.
- [ ] Implement `withCodexScenario()` with a fresh context, page, Codex home, working directory, real session, exact pane,
      observed readiness barrier, cleanup ledger, and `AggregateError` preservation.
- [ ] Migrate bootstrap/basic typing first and pass it twice.

### Task 3: Migrate all semantic scenarios

- [ ] Give slash picker, text/paste, wrapped input, modal, kill switch, edit/submit, and RTT independent fixtures.
- [ ] Run byte identity in two sequential isolated fixtures.
- [ ] Remove shared reset/retry recovery helpers and shared mutable scenario state.
- [ ] Preserve every existing semantic and exact-byte assertion.

### Task 4: Prove determinism and integration

- [ ] Run `npm run test:browser -- test/codex-predictive-echo.test.ts` at least three consecutive times.
- [ ] Run `npm run test:browser -- test/terminal-input-performance.browser.test.ts test/codex-predictive-echo.test.ts`.
- [ ] Run typecheck, Prettier, and `git diff --check`.
- [ ] Verify no listener, child process, port, tmux socket/session, browser context, or fixture path survives.
- [ ] Commit with `test(input): COD-369 isolate predictive browser scenarios`.

### Task 5: Review and resume COD-368

- [ ] Complete independent spec and quality reviews with no Critical or Important findings.
- [ ] Comment on COD-369 with commit and verification evidence; do not mark Done before branch delivery.
- [ ] Resume COD-368 Task 5 gates and disposable LAN/iPhone handoff.
