# COD-549 Native Session Tools Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for isolated implementation tasks and explicit reviews. User has approved the design and requested implementation; no additional design approval is needed.

**Goal:** Replace session-bridge's installed workflows with native Codeman history and local terminal tools while retaining guarded submission.

**Architecture:** Local-only Commander command modules share bounded transcript parsing and composer verification with existing managed agent commands where appropriate. File and arbitrary tmux target access never enter the HTTP API. Existing ownership, input revision and lifecycle guards remain authoritative for managed writes.

**Tech Stack:** TypeScript ESM, NodeNext, Commander, Vitest, existing tmux transport.

## Task 1: offline history

- [ ] Create `test/local-history.test.ts` with real temporary JSONL files for explicit file, ambiguous native ID, transitive children, topic/date complete turns, malformed/partial records, no evidence, UTF8 and scan/output caps. Run `npm test -- test/local-history.test.ts` and confirm missing implementation fails.
- [ ] Create `src/local-history.ts` and `src/cli-history.ts`; export `registerHistoryCommands(program)` for parent integration into `src/cli.ts`. Own these files only. Implement `history read --file|--session-id|--root-session-id`, JSON/text, independently bounded scan and output, and no server dependency.
- [ ] Run `npm test -- test/local-history.test.ts` until green, then inspect ownership/path/race boundaries and report exact coverage.

## Task 2: local tmux operators

- [ ] Create `test/local-terminal.test.ts` before implementation and confirm missing native local commands fail. Cover explicit target, self detection, UTF8 evidence caps, no Enter during stage, exact composer checks, private receipts, mismatch/expiry/replay, symlink refusal, shell/metacharacter-safe argv, failed paste and ambiguous Enter.
- [ ] Create `src/local-terminal.ts` and `src/cli-local.ts`; export `registerLocalCommands(program)`. Use native child_process argument arrays and private local receipts; do not call session-bridge or add HTTP routes. Reuse exported guarded composer verification. Provide inspect/stage/submit with explicit socket/target and multiline authorization.
- [ ] Run `npm test -- test/local-terminal.test.ts` until green; document nonserialized external-writer limits.

## Task 3: guarded composers

- [ ] Extend `test/agent-staging.test.ts` and `test/agent-staging-session.test.ts` for exact multiline rows/caret, authorized newline paste, unsupported frame refusal, Claude fixtures where reliable, and all existing receipt/input-revision races. Confirm new tests fail before implementing.
- [ ] Modify `src/agent-staging.ts`, registry profile data, `src/session.ts`, staging schema/routes and `src/cli-agent.ts` staging options as needed. Do not edit spawn handling (owned by parent) or `src/cli.ts` registration. Expose reusable exact snapshot verifier for local operators.
- [ ] Run `npm test -- test/agent-staging.test.ts test/agent-staging-session.test.ts test/agent-staging-notes.test.ts test/cli-agent-inspection.test.ts` and preserve all prior guards.

## Task 4: parent integration and project continuity

- [ ] Add failing spawn tests in `test/cli-agent.test.ts` for explicit/current working directory and unchanged explicit case behavior. Implement through existing session-create/interactive APIs, preserve lineage and validation. Coordinate shared cli-agent.ts edits after staging owner is finished.
- [ ] Register history/local commands in `src/cli.ts`. Add CLI smoke tests for help and invalid options. Build then execute offline fixture reads with `node dist/index.js history read ...`.
- [ ] Update `skills/codeman/SKILL.md`, references, `docs/wiki/Codeman-Skill.md` and `docs/api-reference.md` as relevant; run `node scripts/sync-plugin.mjs` then `node scripts/sync-plugin.mjs --check`.

## Task 5: verification, review and retirement

- [ ] Run focused new tests and existing agent CLI/inspection/staging/notes/schema/plugin suites. Run `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run check:lockfile`, and `npm run build`. Never run bare npm test in this managed session.
- [ ] Independent review against approved requirements, then code-quality review; fix findings and repeat affected tests. Verify offline/history and explicit local CLI behavior with throwaway fixtures/targets, never user sessions.
- [ ] Commit explicit paths with COD-549, merge to local without disturbing other work, and push only Bitbucket origin. Update Jira with evidence. Do not publish to GitHub upstream.
- [ ] Build installed CLI from merged local; refresh managed skill copies. Archive the exact installed session-bridge link and adjust workspace guidance only after native smoke tests pass. Record any unsupported terminal profiles accurately rather than weaken guards.
