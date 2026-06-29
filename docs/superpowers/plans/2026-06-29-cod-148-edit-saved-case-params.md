# COD-148 Edit Saved Case Params Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add editing for saved local/linked/remote case parameters from the existing case Manage tab.

**Architecture:** Add one backend update route, `PUT /api/cases/:name`, that updates linked-case metadata, managed local case names, and remote-case metadata with collision checks. Reuse existing frontend modal fields in an edit mode, prefilling the selected case and saving through the same route plus the existing remote-host update route when remote host fields change.

**Tech Stack:** TypeScript ESM, Fastify routes with Zod schemas, plain browser JS/CSS/HTML, Vitest route and frontend VM tests.

---

### Task 1: Backend Update Contract

**Files:**
- Modify: `src/web/schemas.ts`
- Modify: `src/web/routes/case-routes.ts`
- Test: `test/routes/case-routes.test.ts`

- [ ] Write failing tests for `PUT /api/cases/:name` updating a linked case path/name and a remote case host/path/name.
- [ ] Run `npm test -- test/routes/case-routes.test.ts -t "updates"` and confirm the new tests fail with route-not-found or missing behavior.
- [ ] Add `UpdateCaseSchema` with `name`, `path`, `remotePath`, and `hostId` fields, matching existing create/link/remote validation.
- [ ] Implement `PUT /api/cases/:name` in `case-routes.ts` before the `GET /api/cases/:name` route so Fastify matches the update route first.
- [ ] Preserve collision rules: the new name cannot collide with an existing local, linked, or remote case other than the case being edited.
- [ ] Run `npm test -- test/routes/case-routes.test.ts -t "updates"` and confirm the tests pass.

### Task 2: Frontend Edit Mode

**Files:**
- Modify: `src/web/public/session-ui.js`
- Modify: `src/web/public/index.html`
- Modify: `src/web/public/styles.css`
- Test: `test/run-mode-ui.test.ts`

- [ ] Add a focused VM test that renders the Manage list, clicks edit for a remote case, confirms fields are prefilled, submits, and asserts `PUT /api/remote-hosts/:id` plus `PUT /api/cases/:name` are called.
- [ ] Run `npm test -- test/run-mode-ui.test.ts -t "case edit"` and confirm the test fails before implementation.
- [ ] Add an edit button to each Manage row and route it to `app.editCase(name)`.
- [ ] Add modal edit state (`caseEditOriginalName`, `caseEditOriginalLocation`) and helpers to reset, prefill, submit, and cancel edit mode.
- [ ] Update modal title, submit text, tab behavior, and discover section visibility while editing.
- [ ] Save local/linked edits with `PUT /api/cases/:name`; save remote edits by updating the host first, then updating the case.
- [ ] Run `npm test -- test/run-mode-ui.test.ts -t "case edit"` and confirm the test passes.

### Task 3: Verification and Deploy

**Files:**
- Modify only if verification reveals defects.

- [ ] Run `npm run typecheck`.
- [ ] Run `npm run lint`.
- [ ] Run `npm run format:check`.
- [ ] Run `npm run check:frontend-syntax`.
- [ ] Run targeted tests: `npm test -- test/routes/case-routes.test.ts` and `npm test -- test/run-mode-ui.test.ts`.
- [ ] Build with `npm run build`.
- [ ] Deploy for testing by restarting the user service with `systemctl --user restart codeman-web`.
- [ ] Verify `/api/status` responds after restart.
- [ ] Update Jira COD-148 with branch, commit, and verification notes.
