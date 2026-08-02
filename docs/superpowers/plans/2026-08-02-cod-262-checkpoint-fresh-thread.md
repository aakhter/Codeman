# COD-262: Checkpoint fresh-thread handoff implementation plan

**Design:** `docs/superpowers/specs/2026-08-02-cod-262-checkpoint-fresh-thread-design.md`

**Objective:** Replace the prompt-shape `/clear` sequence with a backend-aware, generation-gated handoff; add `/new` for
Codex and Claude; fence manual takeover and late writes; expose run-keyed status without introducing self-wait deadlocks.

**Lane:** Substrate. Land verified work on Bitbucket `local`, close Jira as deploy-pending, and do not deploy production.

## Task 1: Establish generation and capability contracts with RED tests

**Primary files:**

- `src/session-auto-ops.ts`
- `src/session.ts`
- `test/session-checkpoint.test.ts`

1. Extend checkpoint types to include `new`, a stable string run ID, conversation generation, explicit terminal outcomes,
   and an asynchronous observation callback.
2. Add backend capability input selected from immutable `Session.mode`; only configured Codex and Claude accept fresh-thread
   modes.
3. Write failing tests for delayed fresh-thread acceptance, unchanged/wrong generation, `/new`, unsupported backends,
   exactly-once delivery, restart abort, and absence of `/init`.
4. Run `npm test -- test/session-checkpoint.test.ts` and capture the expected RED failures before implementation.

## Task 2: Implement the fenced generation-aware state machine

**Primary files:**

- `src/session-auto-ops.ts`
- `src/session.ts`
- shared conversation-identity utility under `src/`

1. Capture the baseline conversation generation before `/clear` or `/new`.
2. Submit one transition command, then poll under one bounded operation deadline until the generation changes and the new
   generation is ready. Keep compact's same-generation start/finish behavior.
3. Delete `/init` from checkpoint orchestration.
4. Check the active run fence after every await and before every automated terminal write. Return the run ID from accepted
   requests and retain terminal state for status queries.
5. Add a session method that cancels an active handoff as `manual-takeover`; call it at user-originated HTTP and WebSocket
   input boundaries before accepting the user's write. Checkpoint-internal writes bypass this cancellation path.
6. Restore active persisted state only as a safe `aborted: restarted` terminal record; never persist continuation text.
7. Run the checkpoint suite until GREEN, preserving explicit RED→GREEN evidence.

## Task 3: Supply authoritative Codex and Claude generation observers

**Primary files:**

- shared rollout/transcript discovery utility under `src/`
- `src/web/routes/session-routes.ts`
- `src/session.ts`
- focused utility/route tests as needed

1. Extract Codex active-rollout identity discovery from the response-viewer route into a shared read-only helper and use it
   from both the viewer and checkpoint observation.
2. Install an unrestricted managed Claude `SessionStart` hook and adopt its `session_id` as the authoritative generation
   signal for startup, resume, `/clear`, `/compact`, and `/new`; do not infer identity from transcript cwd/mtime.
3. Bind every lookup to the managed Codeman session (originator/resume/workspace rules) so another pane's newer transcript or
   rollout cannot satisfy the transition.
4. Fail closed when the adapter cannot establish a stable baseline or new generation.
5. Add focused tests proving pane ownership and fresh-generation selection for both backends.

## Task 4: Propagate `/new`, status, and safe wait behavior through API, persistence, CLI, and UI

**Primary files:**

- `src/types/session.ts`
- `src/web/schemas.ts`
- `src/web/routes/hook-event-routes.ts`
- `src/cli.ts`
- `src/web/public/index.html`
- `src/web/public/session-ui.js`
- checkpoint status/default/route/frontend tests

1. Accept, persist, serialize, and render `new` alongside `compact` and `clear`; retain legacy-state migration.
2. Return `{ triggered, runId }` from checkpoint requests and expose the run's latest state through the existing session GET
   representation.
3. Keep default CLI invocation asynchronous and print `requested` plus the run ID.
4. Add `--wait` polling by run ID for external observers. Refuse it when the target equals `CODEMAN_SESSION_ID`, explaining
   that the target agent must yield before its checkpoint can complete.
5. Update UI copy to describe `/clear` versus screen-preserving `/new` and remove `/init` claims.
6. Add RED→GREEN tests for schema, state migration, CLI validation/rendering, UI behavior, and run-ID matching.

## Task 5: Independent review, verification, and landing

1. Self-review the implementation against every design requirement and inspect `git diff --check` plus scope.
2. Run independent specification review, resolve every gap, and re-review until compliant.
3. Run independent code-quality review, resolve every critical/important finding, and re-review until approved.
4. Orchestrator independently runs the focused checkpoint, CLI, route, persistence, and frontend suites; `npm run
typecheck`; `npm run lint`; `npm run format:check`; `npm run check:lockfile`; frontend/public-asset checks; and `npm run
build`.
5. Exercise installed Codex and Claude only in disposable isolated sessions. Verify `/clear` and `/new` create a new
   conversation identity, `/new` preserves display, and the chosen observer sees the same identity. Never touch the current
   managed session or production.
6. Commit with COD-262 subjects, fast-forward onto the latest verified `local`, re-run the merged-result gate, push only
   Bitbucket `origin/local`, add Jira worklog/comments/structured commit link, and transition COD-262 to Done with
   deploy-pending evidence.

### Verification constraint

The disposable installed-Claude/Codex smoke in step 5 was not run in this implementation environment: policy does not
authorize launching live external model sessions. Deterministic Session, hook-route, rollout-fixture, and built-CLI
integration coverage is the in-repository substitute; the real-CLI smoke remains an explicit authorized-environment gate.
