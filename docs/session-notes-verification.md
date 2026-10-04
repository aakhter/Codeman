# COD-477 session notes verification

The feature is implemented on `feat/COD-477-session-notes`. These results describe the review branch, not a deployed release. Jira parent: [COD-477](https://aakhter.atlassian.net/browse/COD-477); implementation issues: COD-478 through COD-482.

## Acceptance evidence

| Design criterion                                               | Evidence                                                                                                                              | Scope and limits                                                                                           |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1. Same notebook in session, project and global views          | `test/session-notes.browser.test.ts`: desktop retained notebook, project filters and reassignment                                     | Actual shipping markup and controllers with isolated Fastify routes and temporary canonical files          |
| 2. Retention through reload, restart and source removal        | Store roundtrip without a live session; service reconstruction after source removal; browser failed-save reload and retained source   | Fresh store/service construction verifies persisted state. A production process restart was not performed. |
| 3. Project/cwd/location matching and manual reassignment       | 17 project resolver tests; service launch-case/alias/reassignment tests; browser reassignment                                         | Includes nested roots, trusted worktree metadata and separate local/SSH/container identities               |
| 4. Project removal/rename and session recovery                 | Project registry rename/removal tests; retained launch-case and known-alias service tests                                             | Unknown sessions are not merged by title                                                                   |
| 5. Search and canonical checklists                             | Index fenced-code/line-ending tests; service combined filters and revision-checked checklist edits; browser filters/tasks             | Checklist changes update source Markdown                                                                   |
| 6. External and simultaneous edits                             | Independent-store/process contention tests; service draft races; browser clean reload/dirty conflict; controller shared-storage races | Both canonical and draft versions retained; stale callbacks guarded                                        |
| 7. Failed saves and interrupted reassignment                   | Store failure injection and interrupted move recovery; browser first-save failure/retry; controller draft recovery                    | Tests verify truthful save status, stable identity and retained displaced bytes                            |
| 8. Rebuild, repair and isolation                               | Disk search rebuild; malformed/journal/provenance repair tests; exact-owner routes/SSE and instance-scoped drafts                     | Temporary storage only; no production data modified                                                        |
| 9. Desktop/mobile, keyboard, sanitization and explicit sharing | Nine Chromium scenarios; sharing route/controller/input tests; real harmless subprocess argument recording                            | Real shipping CSS cascade and focus handling. No live agent prompt or actual CLI processing was exercised. |

## Final integration checks

At `1c5849e9`, integrating destination `local` commit `a4d86798`:

- Root focused Vitest run: **137 tests passed across 17 files**.
- Root isolated Chromium run: **9 scenarios passed** in `test/session-notes.browser.test.ts`.
- Typecheck, lint, formatting, lockfile consistency and diff checks passed. Lint retains the existing `src/web/server.ts` explicit-any warning.
- Independent final sharing specification recheck: **31 tests passed across four files**, including overlap rejection, boundary release, destination replacement and revoked eligibility. The input regression also carries the maximum quote payload and exactly 65,535 UTF-8 bytes through a harmless Node child process. Earlier reviewer runs cover 115 notes tests and 44 existing recovery/SSE tests.
- Production build packages the notes editor, UI and stylesheet as hashed assets. Optional MediaPipe fetch failure is unrelated to notes and does not fail the build.
- Independent code-quality re-review approved `1c5849e9`: 31 focused tests and the original overlap reproduction passed. The reproduction now contains only the first paste and Enter; the second confirmation is rejected.

The input regression confirms direct argument delivery preserves quotes, Unicode, newlines, trailing spaces and shell substitution text. Preview and append enforce both JavaScript UTF-16 length and UTF-8 bytes; oversized content is rejected without truncation. Tokens are single-use, bound to the notebook, owner and chosen destination, and expire after five minutes. Overlapping notes confirmations to one live destination are rejected before the second paste; they are not queued. Both PTY and tmux guards release after completion or failure. An uncertain delivery is not retried automatically.

## Review images

Images contain fixture data from the isolated browser checks:

- [Desktop global notes](screenshots/session-notes-desktop.png)
- [Desktop explicit send preview](screenshots/session-notes-sharing.png)
- [Desktop external-edit conflict](screenshots/session-notes-conflict.png)
- [Mobile send dialog](screenshots/session-notes-mobile-sharing.png)

## Deliberate verification limits

The full test suite and unisolated WebServer/SSE tests were not run in this Codeman-managed environment. Existing generic `write`/`writeViaMux` agent activity tests have two baseline failures reproduced against the original implementation; the notes-specific input path has separate passing coverage. Live agent processing, production restart, deployment and repository landing are not claimed.

Detailed Jira progress writes are held after automatic approval review rejected posting implementation and verification details. The approval question remains pending; local documentation preserves the receipts.

## Reproduce the focused checks

Run from the feature checkout:

```sh
npm test -- test/session-notes-store.test.ts test/session-notes-projects.test.ts test/session-notes-service.test.ts test/session-notes-index.test.ts test/routes/session-notes-routes.test.ts test/session-notes-launch.test.ts test/session-notes-cases.test.ts test/session-notes-server.test.ts test/session-notes-sse.test.ts test/session-notes-ui.test.ts test/routes/session-notes-sharing.test.ts test/session-notes-input.test.ts test/session-notes-literal-input.test.ts test/session-notes-sharing-ui.test.ts test/sse-registry-parity.test.ts test/sse-dispatch-table.test.ts test/mobile-header-buttons-policy.test.ts
npm run test:browser -- test/session-notes.browser.test.ts
npm run typecheck
npm run lint
npm run format:check
npm run check:lockfile
npm run build
git diff --check
```

The browser fixtures create and remove their own temporary notes storage. Do not substitute an unisolated WebServer test or send prompts to an existing user session.
