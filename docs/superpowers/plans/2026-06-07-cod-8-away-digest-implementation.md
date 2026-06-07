# COD-8 Away Digest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Away Digest that summarizes action-required and informational activity across Codeman sessions without reading terminal buffers.

**Architecture:** Add a pure backend digest builder in `src/web/away-digest.ts`, expose it through `GET /api/away-digest` in `system-routes`, and render it in a modal using existing public UI patterns. Backend owns classification; frontend owns range selection, rendering, and the since-last-visit marker.

**Tech Stack:** TypeScript, Fastify route handlers, Vitest route/unit tests, static public HTML/CSS/JS.

---

## File Structure

- Create `src/web/away-digest.ts`: request/response types, range resolution, event classification, token day aggregation.
- Modify `src/web/routes/system-routes.ts`: add `/api/away-digest` route as a thin adapter.
- Create `test/away-digest.test.ts`: pure builder coverage.
- Modify `test/routes/system-routes.test.ts`: route response and query validation coverage.
- Modify `src/web/public/index.html`: header entry point and modal shell.
- Modify `src/web/public/panels-ui.js`: fetch, render, close, and last-viewed behavior.
- Modify `src/web/public/styles.css` and `src/web/public/mobile.css`: digest layout.
- Create `test/away-digest-ui.test.ts`: static frontend checks.

## Task 1: Backend Builder

**Files:**

- Create: `src/web/away-digest.ts`
- Test: `test/away-digest.test.ts`

- [ ] **Step 1: Write failing builder tests**

Cover:

- non-zero lifecycle exits become `needsAttention`
- run-summary `ralph_completion` becomes `completed`
- zero-exit lifecycle events stay `informational`
- active sessions produce `stillRunning` or `idle`
- token day totals are included without terminal-buffer input

Run: `npm test -- test/away-digest.test.ts`
Expected: FAIL because `src/web/away-digest.ts` does not exist.

- [ ] **Step 2: Implement minimal builder**

Create `AwayDigestInput`, `AwayDigestResponse`, `resolveAwayDigestRange()`, and `buildAwayDigest()`.

Use this classification:

- `needsAttention`: lifecycle `exit` with non-zero `exitCode`, `mux_died`, run-summary `error`, `warning`, `state_stuck`
- `completed`: run-summary `ralph_completion`
- `stillRunning`: active session not idle
- `idle`: active session idle
- `informational`: zero-exit lifecycle, created/started/recovered/deleted, token milestones, recent subagents

- [ ] **Step 3: Verify builder tests pass**

Run: `npm test -- test/away-digest.test.ts`
Expected: PASS.

## Task 2: Route Adapter

**Files:**

- Modify: `src/web/routes/system-routes.ts`
- Modify: `test/routes/system-routes.test.ts`

- [ ] **Step 1: Write failing route tests**

Add tests for:

- `GET /api/away-digest?range=1h` returns `success`, `digest.sections`, and `digest.totals`
- invalid range returns 400
- route passes lifecycle entries and daily stats into the builder-backed response

Run: `npm test -- test/routes/system-routes.test.ts`
Expected: FAIL because route does not exist.

- [ ] **Step 2: Add route**

Route behavior:

- parse `range`, `since`, `until`, `lastViewed`
- resolve range with `resolveAwayDigestRange()`
- query lifecycle log with `since`, `limit: 1000`
- collect active sessions from `ctx.sessions`
- collect run summaries from `ctx.runSummaryTrackers`
- collect token daily stats from `ctx.store.getDailyStats(30)`
- collect recent subagents from `subagentWatcher.getRecentSubagents(60)`
- return `{ success: true, digest }`

- [ ] **Step 3: Verify route tests pass**

Run: `npm test -- test/routes/system-routes.test.ts test/away-digest.test.ts`
Expected: PASS.

## Task 3: Frontend Shell And Renderer

**Files:**

- Modify: `src/web/public/index.html`
- Modify: `src/web/public/panels-ui.js`
- Modify: `src/web/public/styles.css`
- Modify: `src/web/public/mobile.css`
- Create: `test/away-digest-ui.test.ts`

- [ ] **Step 1: Write failing static UI test**

Cover:

- header has an Away Digest button
- modal has range buttons
- modal has summary and section containers
- public JS references `/api/away-digest`
- public JS uses `codeman-away-digest-last-viewed`

Run: `npm test -- test/away-digest-ui.test.ts`
Expected: FAIL because the modal does not exist.

- [ ] **Step 2: Add HTML/CSS shell**

Add a header icon button near notifications/lifecycle log:

- `onclick="app.openAwayDigest()"`
- title and aria-label: `Away Digest`

Add `#awayDigestModal` using the existing `.modal` pattern with:

- range buttons for since last visit, last hour, today, 24h
- custom datetime inputs
- summary container
- five section containers
- retry/refresh and close buttons

- [ ] **Step 3: Add JS renderer**

Add methods to `panels-ui.js`:

- `openAwayDigest(range = 'since-last-visit')`
- `loadAwayDigest()`
- `renderAwayDigest(digest)`
- `renderAwayDigestSection(title, items)`
- `closeAwayDigest()`
- `setAwayDigestRange(range)`

Last-viewed behavior:

- read localStorage key `codeman-away-digest-last-viewed`
- update the key only after successful load and close

- [ ] **Step 4: Verify UI tests pass**

Run: `npm test -- test/away-digest-ui.test.ts`
Expected: PASS.

## Task 4: Final Verification And Commit

- [ ] **Step 1: Run focused verification**

Run:

- `npm test -- test/away-digest.test.ts test/routes/system-routes.test.ts test/away-digest-ui.test.ts`
- `npm run check:public-assets`
- `npm run lint`
- `npm run typecheck`
- `npm run format:check`

Expected: all pass.

- [ ] **Step 2: Commit**

Commit all COD-8 implementation files:

```bash
git add -- docs/superpowers/specs/2026-06-07-cod-8-away-digest-design.md docs/superpowers/plans/2026-06-07-cod-8-away-digest-implementation.md src/web/away-digest.ts src/web/routes/system-routes.ts src/web/public/index.html src/web/public/panels-ui.js src/web/public/styles.css src/web/public/mobile.css test/away-digest.test.ts test/routes/system-routes.test.ts test/away-digest-ui.test.ts
git commit -m "COD-8 add away digest"
```

Expected: commit succeeds and the worktree is clean.
