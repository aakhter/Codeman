# Persistent Session Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task by task. Steps use checkbox syntax for tracking.

**Goal:** Deliver private session Markdown notebooks that remain available in session, project, and global views after the originating session ends.

**Architecture:** Canonical Markdown files live in the instance-aware data directory and have stable notebook and project IDs. A separate notes store handles revisions and recoverable writes; project resolution, search/API, and the editor consume its interface without depending on live session lifetime.

**Tech Stack:** TypeScript ESM, Node filesystem APIs, Fastify, existing plain JavaScript browser modules, Vitest, and Playwright. Reuse installed dependencies.

**Parent:** COD-477. Branch: feat/COD-477-session-notes. Checkout: app/.worktrees/COD-477-session-notes.

**Design:** docs/superpowers/specs/2026-10-03-session-notes-design.md.

## Delivery order and file boundaries

1. COD-478: src/types/session-notes.ts, src/session-notes-markdown.ts, src/session-notes-store.ts, test/session-notes-store.test.ts.
2. COD-479: src/session-notes-projects.ts, test/session-notes-projects.test.ts.
3. COD-480: src/session-notes-index.ts, src/web/routes/session-notes-routes.ts, test/session-notes-index.test.ts, test/routes/session-notes-routes.test.ts; route registration in src/web/server.ts and src/web/routes/index.ts.
4. COD-481: src/web/public/session-notes-ui.js, src/web/public/session-notes-editor.js, notes styles and entry points in src/web/public/styles.css and src/web/public/index.html; editor/browser coverage in test/session-notes-ui.test.ts and browser verification.
5. COD-482: explicit sharing actions in the notes UI, owner-checked source/destination lookup in routes, test coverage for sharing and conflict handling, and docs/wiki/Session-Notes.md.

Implementation uses one implementer at a time, followed by independent specification review and then code-quality review. Parent coordination, issue updates, and documentation can proceed while an implementer works. No deployment is part of this starting milestone.

## Task 1 — COD-478: durable Markdown storage

- [x] Verify clean feature checkout with existing persistence regression: npm test -- test/intent-store.test.ts. Baseline: 17 passed.
- [x] Write real temporary-directory tests for create/read after fresh-store construction, owner isolation, session-independent persistence, stale-revision conflict after an external edit, current-byte revision hashing, recoverable malformed Markdown, and project moves.
- [x] Run npm test -- test/session-notes-store.test.ts and record the expected missing-feature failure before implementation.
- [x] Implement the type and store contract below using this instance's dataPath('notes') as the default root. Use an injectable root only for callers that explicitly supply one, including tests.

```ts
interface SessionNoteMetadata {
  version: 1;
  id: string;
  ownerKey: string;
  projectId: string;
  sessionId: string;
  sessionAliases: string[];
  sessionTitle: string;
  title: string;
  workingDir: string;
  executionLocation: string;
  createdAt: number;
  updatedAt: number;
}
interface SessionNote {
  metadata: SessionNoteMetadata;
  markdown: string;
  revision: string;
}
```

- [x] Expose create, read, list, save, export, and reassign operations. Each takes the owner from trusted server context. Updates require the revision loaded by the caller. Throw a typed conflict with the current readable version; distinguish not-found and malformed metadata without losing the file.
- [x] Store Markdown under notes/<owner-key>/projects/<project-id>/<notebook-id>.md. Frontmatter is versioned; IDs are validated path components. File-byte hashing provides revisions even when an external editor leaves metadata timestamps unchanged. Use restrictive permissions and guard symlink/path escapes.
- [x] Serialize writes within the process and protect competing store instances with an on-disk mutation boundary. Preserve the actual displaced version during replacement and restore or surface conflicts if an external writer changes the target. Journal recoverable moves; startup/access recovery never chooses an old version over a newer externally written target without preserving both.
- [x] Add failure-injection or filesystem regression cases proving failed persistence is reported and interrupted moves retain content. Keep filesystem dependencies narrow and exercise real files wherever possible.
- [x] Run the new targeted tests; fix failures, then run typecheck, lint, format:check, and check:lockfile. Format only changed files when needed.
- [x] Have an independent specification reviewer compare COD-478 to the storage, durability, external-edit, and owner-isolation portions of the design; resolve gaps before requesting code-quality review.
- [x] Commit explicit files with a COD-478 subject. Update Jira with commit, branch, verification, and remaining scope; do not mark Done before repository landing requirements are met.

## Task 2 — COD-479: projects and reassignment

- [x] Write resolver tests for exact/nested roots, path boundaries, supplied configured project, established worktree root, local/SSH/container identity, unmatched fallback, rename, and manual assignment.
- [x] Run npm test -- test/session-notes-projects.test.ts and confirm expected missing-feature failures.
- [x] Implement a persistent owner-scoped registry with stable IDs and editable labels. Consume existing case/session metadata. Prefer the chosen configured case, then most-specific matching root in the same execution location, then a directory fallback.
- [x] Reuse known originating session/conversation aliases when looking up notebooks; do not merge unknown sessions based on titles. Invoke the store's recoverable reassign operation for explicit user reassignment; retain original session/cwd.
- [x] Run focused tests and required checks, obtain specification and quality reviews, and commit with COD-479.

## Task 3 — COD-480: API, index and checklist projections

- [x] Add tests using Fastify inject for owner-scoped list/read/save/reassign/export, historical notebooks with no live session, stale-revision conflicts, and forbidden cross-owner operations.
- [x] Add Markdown checklist tests excluding fenced code and proving completion changes the source marker under revision checks. Search uses notebook titles and bodies with composable project/session/unfinished filters.
- [x] Confirm expected missing-route/feature failures in the two targeted files before implementation.
- [x] Register domain routes through the existing route wiring. Supply trusted owner/session/case metadata; browser inputs cannot choose another owner or arbitrary filesystem paths. Match existing API response conventions.
- [x] Make the index rebuildable from canonical files and refresh against external changes. Publish owner-scoped change events and preserve repairable files in list responses. Export standalone Markdown.
- [x] Run focused tests and required checks, obtain specification and quality reviews, and commit with COD-480.

## Task 4 — COD-481: session and global UI

- [x] Write editor/controller regressions for debounce, truthful save status, first-save failure/retry, scoped draft restore, revision conflicts, external reload when clean, and retaining both versions when dirty.
- [x] Confirm expected missing-feature failures before adding the browser modules.
- [x] Add a session Notes action and header Notes action. Desktop editor opens beside the terminal; mobile editor fills the available screen. Global browser uses one project-filtered notebook collection with source metadata and unfinished items.
- [x] Implement optional starter headings, edit/sanitized preview, 750 ms autosave, title edits, project reassignment, download/export, conflict comparison, and explicit user resolution. Opening history notes never resumes the agent.
- [x] Verify in Playwright with desktop and mobile viewports, keyboard navigation, reload, failed saves, removed sessions, and external changes. Use a separate instance/socket if a server is started; never attach a second server to production sessions.
- [x] Run targeted tests and required checks, obtain specification and quality reviews, and commit with COD-481.

## Task 5 — COD-482: explicit sharing and final integration

- [x] Write tests proving default notes do not reach agent input, explicit send uses the selected content/destination, inactive sources are not resumed, and selected response append respects revisions.
- [x] Confirm expected missing-feature failures before wiring the sharing actions.
- [x] Add preview and explicit confirmation within Send to session. Append only the selected response with timestamp and source reference in Save response to notes. Reuse existing session-input and response-selection mechanisms where applicable.
- [x] Document file layout, retention, assignment, privacy defaults, backup/export, and conflict resolution in docs/wiki/Session-Notes.md.
- [x] Exercise design acceptance scenarios across session, project, and global views, including fresh store/service reconstruction, removed project, concurrent edits, owner/instance isolation and index rebuild. Record screenshots for UI review. Production restart and live agent processing are not claimed.
- [x] Run required checks and focused regressions; obtain final specification and code-quality reviews.
- [ ] Push only the Bitbucket origin working branch and prepare a reviewable PR.
- [ ] Update Jira with branch/PR/commit/verification. Held pending user approval after automatic approval review rejected the detailed payload. Completion follows landing, not merely local implementation.

## Progress reporting

The initial implementation milestone is COD-478. Report precisely which subtasks are implemented, reviewed, or still queued; no UI or deployed-feature claims are justified by storage tests. The user has authorized implementation, so continue without repeating design approval questions.

## COD-478 verification receipt

Implemented and independently approved for specification and code quality at `3ea99c89`. The focused storage suite passes 20 tests, including separate-process contention, interrupted writes and moves, external-edit conflicts, malformed journal preservation, and stale lock recovery. Typecheck, format check, and lockfile check pass. Lint passes with an existing `src/web/server.ts` warning. Project resolution, API, UI, and explicit sharing remain pending; the feature is not deployed.

## COD-479 verification receipt

Implemented at `98d4b130`, independently approved for specification and code quality. Both scoped suites pass 37 tests (17 projects and 20 storage). Root independently reran typecheck, format check and lockfile check successfully. Project registry preserves stable identity across renames/removal and keeps interrupted staged bytes recoverable. API, launch metadata capture, editor and sharing remain pending. COD-480 is now in progress.

## COD-480 verification receipt

Implemented at `06770ec4`, corrected draft concurrency at `eaf923bc` and external provenance adoption at `3e11756e`. Independent specification review passed 147 tests across 10 focused files and direct conflict/provenance reproductions. Independent quality re-review approved the final backend; its focused 41 tests also passed. Root independently reran typecheck, lint, format check, lockfile and diff checks successfully (lint retains one existing warning). Earlier isolated existing remote SSE regression passed 4 tests with installed tmux detection enabled. API contract: `docs/session-notes-api.md`. Backend changes preserve Markdown canonical content, draft versions, retained origin, external edits and exact-owner notifications. COD-481 editor/browser is now starting; sharing and final browser/integration acceptance remain pending. Nothing is deployed or landed.

## COD-481 verification receipt

Implemented at `be7bfbea`, corrected repair navigation at `ff04c6ba`, and shared-draft/asynchronous callback races at `4dd4fa6b`. Independent specification and quality re-reviews approved the final editor. Final UI regressions pass 28 tests; independent quality checks pass 32 tests including SSE parity. Implementer focused integration checks pass 59 tests. Root verified all six isolated desktop/mobile browser scenarios using actual shipping markup/mixins and temporary Fastify notes storage, and reviewed screenshots in `/tmp/cod477-ui-review`. Root typecheck, lint, formatting, lockfile and diff checks pass; lint retains one existing warning. Production build packages hashed notes assets and matches final source. Existing `sse-events.test.ts` starts an unisolated WebServer and was not escalated after sandbox tmux detection failed; focused notes owner-routing and registry checks passed. COD-482 explicit sharing and final integration remain pending. Nothing is deployed or landed. Jira detail updates are pending user approval after automatic approval review rejected posting implementation and verification details.

## COD-482 and final integration receipt

Implemented at `60ad66c9`, integrated destination recovery/SSE changes at `5bae553b`, fixed shell argument expansion/UTF-8 limits at `9c8ff8df`, and overlapping notes sends at `1c5849e9`. Final specification and code-quality reviews approve `1c5849e9`; each independently passes 31 sharing/input/UI tests. Implementer passes 80 focused tests and build/static checks. Root independently passes 137 tests across 17 focused files, all nine isolated desktop/mobile Chromium scenarios, typecheck, lint, formatting, lockfile and diff checks. The existing lint warning remains. Review screenshots and the nine-criterion acceptance map are committed with [the verification report](../../session-notes-verification.md). Live CLI processing, production restart, deployment and landing are not claimed. Detailed Jira writes remain held pending approval; branch/PR delivery follows this receipt.
