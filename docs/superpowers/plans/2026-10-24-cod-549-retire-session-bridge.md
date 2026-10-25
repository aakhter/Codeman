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
- [x] Activation approved and verified on 2026-10-24: installed native modules match the tested build; skill copies refreshed; the exact session-bridge discovery link archived; workspace guidance updated. Unsupported terminal profiles remain explicit refusals.

## Verification and review receipt (2026-10-24)

- Final focused run: 464 tests passed across 22 files (`/tmp/cod549-final-tests.log`). This is focused verification, not a claim about the repository's complete test suite.
- Typecheck, lint, source formatting, lockfile synchronization, plugin parity and build passed (`/tmp/cod549-*-final.log`). Built offline CLI returns complete matching turns and exposes local/working-directory commands.
- Real isolated local tmux smoke: exact single-line and multiline content, no premature Enter, replay refused. Real managed transport smoke: active bracketed-paste detection, literal multiline, no premature submit timestamp, one conditional Enter.
- Read-only check recognized the installed Claude composer, including its custom status line; no input was sent to existing user panes.
- Independent cross-reviews found and verified fixes for mixed-session metadata attribution, unproven root identities, readiness errors losing created IDs, paste-mode/lifecycle races, LF conversion, working-Claude frames and premature submit timestamps. No outstanding material findings.
- A minor changeset is included for a future release. On 2026-10-24 the user authorized deployment and installed-skill retirement. A concurrent deployment at source commit `415c04b0` already included COD-549, so it was preserved without another restart or rollback. The installed history, local-operator, composer, agent CLI, session and agent-route modules match the verified `824f2c50` build byte for byte. Live inspection and invalid-stage refusal, installed offline history and real isolated local multiline/replay smoke checks passed; the dashboard rendered all 14 tabs and all 14 baseline session IDs remained present. Automatic skill injection is enabled. The installed session-bridge discovery symlink was archived under `~/.codeman/deploy-backups/COD-549-retirement-20261025T002359Z/`; its canonical repository was retained for rollback. Codex global skill follows canonical source; managed Claude/workspace copies and references were refreshed. Workspace AGENTS.md now routes historical and local terminal work through Codeman. No release version bump was performed for this activation.
