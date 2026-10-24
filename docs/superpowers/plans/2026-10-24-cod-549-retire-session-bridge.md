# COD-549 Native Session Tools Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for isolated implementation tasks and explicit reviews. User has approved the design and requested implementation; no additional design approval is needed.

**Goal:** Replace session-bridge's installed workflows with native Codeman history and local terminal tools while retaining guarded submission.

**Architecture:** Local-only Commander command modules share bounded transcript parsing and composer verification with existing managed agent commands where appropriate. File and arbitrary tmux target access never enter the HTTP API. Existing ownership, input revision and lifecycle guards remain authoritative for managed writes.

**Tech Stack:** TypeScript ESM, NodeNext, Commander, Vitest, existing tmux transport.

## Task 1: offline history

- [x] Create `test/local-history.test.ts` with real temporary JSONL files for explicit file, ambiguous native ID, transitive children, topic/date complete turns, malformed/partial records, no evidence, UTF8 and scan/output caps. Run `npm test -- test/local-history.test.ts` and confirm missing implementation fails.
- [x] Create `src/local-history.ts` and `src/cli-history.ts`; export `registerHistoryCommands(program)` for parent integration into `src/cli.ts`. Own these files only. Implement `history read --file|--session-id|--root-session-id`, JSON/text, independently bounded scan and output, and no server dependency.
- [x] Run `npm test -- test/local-history.test.ts` until green, then inspect ownership/path/race boundaries and report exact coverage.

## Task 2: local tmux operators

- [x] Create `test/local-terminal.test.ts` before implementation and confirm missing native local commands fail. Cover explicit target, self detection, UTF8 evidence caps, no Enter during stage, exact composer checks, private receipts, mismatch/expiry/replay, symlink refusal, shell/metacharacter-safe argv, failed paste and ambiguous Enter.
- [x] Create `src/local-terminal.ts` and `src/cli-local.ts`; export `registerLocalCommands(program)`. Use native child_process argument arrays and private local receipts; do not call session-bridge or add HTTP routes. Reuse exported guarded composer verification. Provide inspect/stage/submit with explicit socket/target and multiline authorization.
- [x] Run `npm test -- test/local-terminal.test.ts` until green; document nonserialized external-writer limits.

## Task 3: guarded composers

- [x] Extend `test/agent-staging.test.ts` and `test/agent-staging-session.test.ts` for exact multiline rows/caret, authorized newline paste, unsupported frame refusal, Claude fixtures where reliable, and all existing receipt/input-revision races. Confirm new tests fail before implementing.
- [x] Modify `src/agent-staging.ts`, registry profile data, `src/session.ts`, staging schema/routes and `src/cli-agent.ts` staging options as needed. Do not edit spawn handling (owned by parent) or `src/cli.ts` registration. Expose reusable exact snapshot verifier for local operators.
- [x] Run `npm test -- test/agent-staging.test.ts test/agent-staging-session.test.ts test/agent-staging-notes.test.ts test/cli-agent-inspection.test.ts` and preserve all prior guards.

## Task 4: parent integration and project continuity

- [x] Add failing spawn tests in `test/cli-agent.test.ts` for explicit/current working directory and unchanged explicit case behavior. Implement through existing session-create/interactive APIs, preserve lineage and validation. Coordinate shared cli-agent.ts edits after staging owner is finished.
- [x] Register history/local commands in `src/cli.ts`. Add CLI smoke tests for help and invalid options. Build then execute offline fixture reads with `node dist/index.js history read ...`.
- [x] Update `skills/codeman/SKILL.md`, references, `docs/wiki/Codeman-Skill.md` and `docs/api-reference.md` as relevant; run `node scripts/sync-plugin.mjs` then `node scripts/sync-plugin.mjs --check`.

## Task 5: verification, review and retirement

- [x] Run focused new tests and existing agent CLI/inspection/staging/notes/schema/plugin suites. Run `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run check:lockfile`, and `npm run build`. Never run bare npm test in this managed session.
- [x] Independent review against approved requirements, then code-quality review; fix findings and repeat affected tests. Verify offline/history and explicit local CLI behavior with throwaway fixtures/targets, never user sessions.
- [x] Commit explicit paths with COD-549, merge to local without disturbing other work, and push only Bitbucket origin. Update Jira with evidence. Do not publish to GitHub upstream.
- [ ] Activation after separate operator deployment approval: build installed CLI from merged local; refresh managed skill copies, archive the exact installed session-bridge link and update workspace guidance. Native build and smoke tests are already complete. Unsupported terminal profiles remain explicit refusals.

## Verification and review receipt (2026-10-24)

- Final focused run: 464 tests passed across 22 files (`/tmp/cod549-final-tests.log`). This is focused verification, not a claim about the repository's complete test suite.
- Typecheck, lint, source formatting, lockfile synchronization, plugin parity and build passed (`/tmp/cod549-*-final.log`). Built offline CLI returns complete matching turns and exposes local/working-directory commands.
- Real isolated local tmux smoke: exact single-line and multiline content, no premature Enter, replay refused. Real managed transport smoke: active bracketed-paste detection, literal multiline, no premature submit timestamp, one conditional Enter.
- Read-only check recognized the installed Claude composer, including its custom status line; no input was sent to existing user panes.
- Independent cross-reviews found and verified fixes for mixed-session metadata attribution, unproven root identities, readiness errors losing created IDs, paste-mode/lifecycle races, LF conversion, working-Claude frames and premature submit timestamps. No outstanding material findings.
- A minor changeset is included. Production deployment, release versioning and installed-skill retirement are separate activation actions; the running server and existing session-bridge installation remain intact pending authorization under AGENTS.md's deployment boundary.
