# Attachment Card Thumbnails and Explicit Attach Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-page thumbnails to attachment cards and let Codex explicitly trigger live external attachment cards.

**Architecture:** Add a per-session attachment registry for live external files, expose attachment-ID based raw/preview/thumbnail routes, add CLI and terminal magic-text triggers, and update browser cards to render thumbnails with fallback badges. Keep existing watcher/session-local path behavior intact.

**Tech Stack:** TypeScript ESM, Fastify routes, Vitest, plain browser JS/CSS, LibreOffice `soffice` for DOCX/PPTX conversion, existing file route validation.

---

### Task 1: Backend Attachment Registry and Routes

**Files:**
- Create: `src/attachment-registry.ts`
- Modify: `src/web/routes/file-routes.ts`
- Modify: `src/web/ports/session-port.ts`
- Test: `test/routes/file-routes.test.ts`

- [ ] **Step 1: Write failing route tests**

Add tests that register a live external PNG/PDF path, assert the response includes `attachmentId`, `thumbnailUrl`, and `previewUrl`, then assert raw/thumbnail routes work by `attachmentId` and reject unknown IDs.

- [ ] **Step 2: Run targeted RED test**

Run: `npm run test -- test/routes/file-routes.test.ts`

Expected: fails because the register/thumbnail routes do not exist.

- [ ] **Step 3: Implement registry and routes**

Add an in-memory registry keyed by `sessionId` and `attachmentId`. Add `POST /api/sessions/:id/attachments`, `GET /api/sessions/:id/attachments/:attachmentId/raw`, `GET /api/sessions/:id/attachments/:attachmentId/preview`, and `GET /api/sessions/:id/attachments/:attachmentId/thumbnail`.

- [ ] **Step 4: Run GREEN route test**

Run: `npm run test -- test/routes/file-routes.test.ts`

Expected: passes.

### Task 2: First-Page Thumbnail Generation

**Files:**
- Create: `src/document-thumbnailer.ts`
- Modify: `src/web/routes/file-routes.ts`
- Test: `test/routes/file-routes.test.ts`

- [ ] **Step 1: Write failing thumbnail tests**

Add tests for PNG direct thumbnails and PDF/DOCX/PPTX thumbnail route behavior with mocked conversion failures returning a fallback response instead of failing registration.

- [ ] **Step 2: Run targeted RED test**

Run: `npm run test -- test/routes/file-routes.test.ts`

Expected: fails because thumbnail generation is not wired.

- [ ] **Step 3: Implement thumbnail helper**

Implement best-effort thumbnail generation. PNG returns raw file bytes. PDF/DOCX/PPTX use a cached generated PNG when tooling succeeds; unsupported or failed generation returns 204 so the browser falls back to the badge.

- [ ] **Step 4: Run GREEN route test**

Run: `npm run test -- test/routes/file-routes.test.ts`

Expected: passes.

### Task 3: CLI Attach Command and Terminal Magic Detection

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/session.ts`
- Modify: `src/web/server.ts`
- Test: `test/cli-commands.test.ts`
- Test: `test/session.test.ts`

- [ ] **Step 1: Write failing CLI and parser tests**

Add tests that `codeman attach /absolute/file.pdf --session <id>` calls the attach API payload shape, and that terminal output containing `codeman://attach?path=...` emits a backend attachment registration request once.

- [ ] **Step 2: Run targeted RED tests**

Run: `npm run test -- test/cli-commands.test.ts test/session.test.ts`

Expected: fails because no attach command or magic parser exists.

- [ ] **Step 3: Implement attach triggers**

Add `codeman attach <path>` with optional `--session` and `--url`. Add session terminal parsing for `codeman://attach?path=...`; on detection, call a server dependency that registers and broadcasts the attachment.

- [ ] **Step 4: Run GREEN tests**

Run: `npm run test -- test/cli-commands.test.ts test/session.test.ts`

Expected: passes.

### Task 4: Browser Card Thumbnail UI

**Files:**
- Modify: `src/web/public/panels-ui.js`
- Modify: `src/web/public/styles.css`
- Test: `test/document-attachments-ui.test.ts`

- [ ] **Step 1: Write failing UI tests**

Add tests that an attachment event with `thumbnailUrl` renders an image thumbnail and an event without one renders the existing type badge fallback.

- [ ] **Step 2: Run targeted RED test**

Run: `npm run test -- test/document-attachments-ui.test.ts`

Expected: fails because the card always renders a type badge.

- [ ] **Step 3: Implement card UI**

Render thumbnail image when provided. Add `onerror` fallback to reveal the type badge. Preserve existing Preview, Download, Open, and Dismiss actions.

- [ ] **Step 4: Run GREEN UI test**

Run: `npm run test -- test/document-attachments-ui.test.ts`

Expected: passes.

### Task 5: Verification and Jira

**Files:**
- Update tests only if verification exposes behavior gaps.

- [ ] **Step 1: Run focused verification**

Run:

```bash
npm run test -- test/routes/file-routes.test.ts test/document-attachments-ui.test.ts test/cli-commands.test.ts test/session.test.ts
npm run typecheck
npm run lint
npm run format:check
npm run build
npm run check:public-assets
npm run check:lockfile
```

- [ ] **Step 2: Commit**

Commit with subject: `feat(web): COD-18 add attachment thumbnails and explicit attach`

- [ ] **Step 3: Update Jira**

Comment on COD-18 with commit hash, Bitbucket URL if available, summary, and verification results.
