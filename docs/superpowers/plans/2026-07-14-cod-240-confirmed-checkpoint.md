# COD-240 Confirmed Agent Checkpoint Implementation Plan

> Design source: `docs/superpowers/specs/2026-07-14-cod-240-confirmed-checkpoint-design.md`
>
> Worktree: `/home/aakhter/.codeman/app/.worktrees/cod-240-confirmed-checkpoint`
>
> Branch: `cod-240-confirmed-checkpoint`

## Guardrails

- Apply strict RED → GREEN → refactor discipline. Run each new test against the unfixed code and record the expected failure before implementation.
- Never run bare `npm test` or bare `npx vitest`; every test command must name files or a test-name pattern.
- Preserve the primary checkout's user-owned response-viewer edits.
- Do not modify or commit ignored `dist/`; build it only for verification.
- Do not deploy production.
- Preserve the existing generic `sendInput(): Promise<boolean>` contract.
- Preserve existing checkpoint request refusal reasons and the `session:checkpoint` event name.

## Task 1: Add positive checkpoint observations

Files:

- Modify `src/session.ts`
- Modify `src/session-auto-ops.ts`
- Modify `test/codex-working-detection.test.ts`
- Modify `test/session-checkpoint.test.ts`

Steps:

1. Add RED tests proving `isWorking === false` without a rendered prompt is not ready, an active working frame overrides a visible prompt, delayed prompt readiness is accepted, and Claude/Codex prompt markers remain mode-specific.
2. Add a small exported observation type and a callback from `SessionAutoOps` to `Session` that returns positive `ready`, `working`, and semantic prompt generation/revision evidence.
3. Derive Claude readiness from `❯` and Codex readiness from `›`, after stripping ANSI and excluding working evidence. Preserve the existing behavior of other modes through an explicit fallback rather than inventing prompt syntax.
4. Ensure semantic prompt generation does not advance on unrelated rendered-frame redraws.
5. Run:

   ```sh
   npm test -- test/codex-working-detection.test.ts test/session-checkpoint.test.ts
   ```

## Task 2: Add duplicate-safe, stage-aware tmux delivery

Files:

- Modify `src/mux-interface.ts`
- Modify `src/tmux-manager.ts`
- Modify `src/session.ts`
- Modify `test/tmux-manager.test.ts`

Steps:

1. Add RED tests through the real `TmuxManager` adapter for text+Enter success, text-stage failure, Enter-only failure, Enter-only retry, repeated Enter failure, and command ordering that proves the text is not resent after Enter succeeds on retry.
2. Add a checkpoint-specific command API returning `{ ok: true }` or `{ ok: false, stage: 'text' | 'enter', error? }`. Keep generic `sendInput()` unchanged.
3. Bound retries. Retry a failed Enter without resending acknowledged text. Fail with the exact stage after the retry budget is exhausted.
4. Expose the result to `SessionAutoOps` through `Session`; retain a direct-PTY Claude fallback with an equivalent acknowledgement result.
5. Run:

   ```sh
   npm test -- test/tmux-manager.test.ts
   ```

## Task 3: Replace implicit checkpoint timing with the confirmed state machine

Files:

- Modify `src/session-auto-ops.ts`
- Modify `src/session.ts`
- Modify `src/types/session.ts`
- Modify `test/session-checkpoint.test.ts`

Steps:

1. Add RED tests for every terminal outcome before changing the driver:
   - busy waits for positive readiness
   - false idle cannot inject
   - failed command delivery blocks continuation
   - command never accepted fails
   - operation starts but never completes fails
   - continuation delivery failure blocks `done`
   - continuation without a new working turn blocks `done`
   - stop/destroy aborts each wait class
   - compact and clear preserve ordered step sequencing
2. Replace `_runCheckpointStep()` with a single explicit transition path. Centralize polling, timeouts, cleanup, and terminal outcomes.
3. Treat every timeout as `failed`; remove no-op and max-runtime success fallthroughs.
4. Before each checkpoint command, require positive readiness. After delivery, require a transition away from the baseline ready prompt and then a fresh ready prompt.
5. After continuation delivery, require a positive new working transition before emitting `done`.
6. Persist a last-known checkpoint record with `active`, `phase`, `mode`, optional `step`/`reason`/`stage`, and `updatedAt`. Terminal records remain queryable with `active: false`.
7. Preserve legacy `checkpointStart`/`checkpointDone` compatibility only where needed; no error path may emit done.
8. Run:

   ```sh
   npm test -- test/session-checkpoint.test.ts test/codex-working-detection.test.ts
   ```

## Task 4: Wire lifecycle phases through SSE and status

Files:

- Modify `src/web/session-listener-wiring.ts`
- Modify `src/web/sse-events.ts` only if payload typing/documentation requires it; do not rename the event
- Modify `src/web/public/constants.js` only if required; the event string remains unchanged
- Modify relevant route/listener tests, preferring a focused new checkpoint wiring test if none exists

Steps:

1. Add RED coverage that captures `requested`, `waiting-ready`, `command-submitted`, `operation-started`, `operation-complete`, `continue-submitted`, and `done`, plus `failed` and `aborted` with reasons.
2. Forward one `checkpointProgress` payload from `Session` through existing listener wiring to `session:checkpoint`.
3. Include mode, step, attempt, stage, reason, and timestamp only when meaningful.
4. Verify session serialization exposes the durable checkpoint record.
5. Run the smallest named listener/route test files plus `test/session-checkpoint.test.ts`.

## Task 5: Make built CLI failures explicit and testable

Files:

- Modify `src/cli.ts`
- Add or modify a focused checkpoint CLI test

Steps:

1. Add RED tests for null, non-JSON, HTTP failure, malformed success payload, refusal reason, and valid request acceptance.
2. Extract a pure checkpoint-response interpreter if needed, but retain the live command's non-zero exit and human-readable error behavior.
3. Ensure accepted output says `requested`, never `done`.
4. Run the focused CLI test and `test/checkpoint-status.test.ts`.
5. Build, then execute `node dist/index.js checkpoint` against a controlled local HTTP server to prove the ignored built artifact no longer throws an unhandled rejection.

## Task 6: Independent review and orchestrator verification

1. Fresh spec reviewer compares the diff and tests to COD-240's Jira acceptance criteria and the committed design. The implementer fixes any gaps; the same reviewer re-reviews.
2. Fresh quality reviewer checks race safety, timer cleanup, retry duplication, API compatibility, and test fidelity. The implementer fixes any findings; the same reviewer re-reviews.
3. Orchestrator independently runs:

   ```sh
   npm test -- test/session-checkpoint.test.ts test/codex-working-detection.test.ts test/tmux-manager.test.ts test/checkpoint-status.test.ts <new-focused-tests>
   npm run typecheck
   npm run lint
   npm run format:check
   npm run check:lockfile
   npm run build
   ```

4. Start an isolated beta with distinct instance/data/socket settings. Create a disposable Codex session; never target the current managed session.
5. Run the exact command against the disposable session:

   ```sh
   aicodeman checkpoint --continue '$jira-autoloop'
   ```

6. Confirm status/events/logs reach `done` only after the new turn starts. Also exercise compact and clear paths at the safest available integration level.
7. Record evidence in Jira and `jira-autoloop-state.md`.

## Task 7: Land without production deployment

1. Commit with a `COD-240` Conventional Commit subject.
2. Rebase or merge the latest `origin/local` into the issue branch, rerun proportionate verification, and push the issue branch to Bitbucket `origin`.
3. Land onto `local` according to the Jira loop configuration, push `origin/local`, and create a structured Bitbucket remote link in Jira.
4. Add the final implementation/verification comment and worklog; transition COD-240 to Done only after the landed commit is verified.
5. Mark the issue deploy-pending. Do not deploy production without the user's literal authorization `deploy`.
