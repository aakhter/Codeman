# Session Attachment History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persistent, per-session attachment history so dismissed attachment cards can be recovered from an active-session Attachments drawer.

**Architecture:** Store attachment history on `SessionState` and expose it through a safe session-scoped API. Keep floating cards transient in the browser, but render a durable header paperclip drawer from the backend list endpoint. Reuse existing preview/download/open/thumbnail routes.

**Tech Stack:** TypeScript, Fastify, Vitest, existing browser JS/CSS, existing `StateStore`, existing attachment registry and thumbnailer.

---

## File Structure

- Create `src/session-attachment-history.ts`: pure helpers for history item creation, dedupe, cap, and safe view conversion.
- Modify `src/types/session.ts`: add `SessionAttachmentHistoryItem` and `attachmentHistory?: SessionAttachmentHistoryItem[]`.
- Modify `src/session.ts`: hold attachment history on live session instances and include it in `toState()`.
- Modify `src/web/routes/file-routes.ts`: append history on explicit attach, add `GET /api/sessions/:id/attachments`, and list from active session or persisted state.
- Modify `src/web/server.ts`: record workspace-detected attachments before broadcasting.
- Modify `src/web/ports/session-port.ts`: expose enough context for file routes to read persisted stopped sessions.
- Modify `src/web/public/index.html`: add header paperclip button with badge.
- Modify `src/web/public/panels-ui.js`: load/render/toggle history drawer and re-show cards.
- Modify `src/web/public/styles.css` and `src/web/public/mobile.css`: drawer/sheet layout.
- Modify tests: `test/session-attachment-history.test.ts`, `test/routes/file-routes.test.ts`, `test/document-attachments-ui.test.ts`.

---

### Task 1: Add History Types And Pure Helpers

**Files:**
- Create: `src/session-attachment-history.ts`
- Modify: `src/types/session.ts`
- Test: `test/session-attachment-history.test.ts`

- [ ] **Step 1: Write failing helper tests**

Create `test/session-attachment-history.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_HISTORY_LIMIT,
  buildDetectedAttachmentHistoryItem,
  buildExternalAttachmentHistoryItem,
  upsertAttachmentHistory,
} from '../src/session-attachment-history.js';

describe('session attachment history', () => {
  it('dedupes explicit external attachments by source path and moves latest to top', () => {
    const first = buildExternalAttachmentHistoryItem({
      sessionId: 's1',
      externalPath: '/mnt/c/docs/brief.docx',
      fileName: 'brief.docx',
      extension: 'docx',
      size: 100,
      mtimeMs: 1,
      timestamp: 10,
    });
    const second = { ...first, size: 200, mtimeMs: 2, timestamp: 20 };

    const result = upsertAttachmentHistory(upsertAttachmentHistory([], first), second);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ size: 200, mtimeMs: 2, timestamp: 20, externalPath: '/mnt/c/docs/brief.docx' });
  });

  it('dedupes detected workspace attachments by relative path', () => {
    const first = buildDetectedAttachmentHistoryItem({
      sessionId: 's1',
      relativePath: 'out/report.pdf',
      fileName: 'report.pdf',
      extension: 'pdf',
      attachmentType: 'pdf',
      size: 100,
      timestamp: 10,
    });
    const second = { ...first, size: 150, timestamp: 20 };

    const result = upsertAttachmentHistory(upsertAttachmentHistory([], first), second);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ relativePath: 'out/report.pdf', size: 150, timestamp: 20 });
  });

  it('caps history to newest 100 items', () => {
    let history = [];
    for (let i = 0; i < ATTACHMENT_HISTORY_LIMIT + 5; i++) {
      history = upsertAttachmentHistory(
        history,
        buildDetectedAttachmentHistoryItem({
          sessionId: 's1',
          relativePath: `out/${i}.png`,
          fileName: `${i}.png`,
          extension: 'png',
          attachmentType: 'image',
          size: i,
          timestamp: i,
        })
      );
    }

    expect(history).toHaveLength(ATTACHMENT_HISTORY_LIMIT);
    expect(history[0].fileName).toBe('104.png');
    expect(history.at(-1)?.fileName).toBe('5.png');
  });
});
```

- [ ] **Step 2: Run the helper tests and verify failure**

Run: `npm run test -- test/session-attachment-history.test.ts`

Expected: FAIL because `src/session-attachment-history.ts` does not exist.

- [ ] **Step 3: Add the session history type**

Modify `src/types/session.ts`:

```ts
import type { AttachmentDetectedType } from './tools.js';

export interface SessionAttachmentHistoryItem {
  id: string;
  sessionId: string;
  fileName: string;
  extension: string;
  attachmentType: AttachmentDetectedType;
  size: number;
  mtimeMs: number;
  timestamp: number;
  source: 'detected' | 'external';
  relativePath?: string;
  externalPath?: string;
  missing?: boolean;
}
```

Add to `SessionState`:

```ts
  /** Persistent per-session attachment history */
  attachmentHistory?: SessionAttachmentHistoryItem[];
```

- [ ] **Step 4: Add pure helper implementation**

Create `src/session-attachment-history.ts`:

```ts
import { basename, extname } from 'node:path';
import type { AttachmentDetectedEvent, AttachmentDetectedType } from './types/tools.js';
import type { SessionAttachmentHistoryItem } from './types/session.js';
import { getAttachmentType } from './attachment-registry.js';

export const ATTACHMENT_HISTORY_LIMIT = 100;

function sourceKey(item: SessionAttachmentHistoryItem): string {
  return item.source === 'external'
    ? `external:${item.externalPath ?? item.fileName}`
    : `detected:${item.relativePath ?? item.fileName}`;
}

export function upsertAttachmentHistory(
  history: SessionAttachmentHistoryItem[] | undefined,
  item: SessionAttachmentHistoryItem
): SessionAttachmentHistoryItem[] {
  const existing = history ?? [];
  const key = sourceKey(item);
  return [item, ...existing.filter((entry) => sourceKey(entry) !== key)].slice(0, ATTACHMENT_HISTORY_LIMIT);
}

export function buildExternalAttachmentHistoryItem(input: {
  sessionId: string;
  externalPath: string;
  fileName?: string;
  extension?: string;
  size: number;
  mtimeMs: number;
  timestamp: number;
}): SessionAttachmentHistoryItem {
  const fileName = input.fileName ?? basename(input.externalPath);
  const extension = (input.extension ?? extname(fileName).replace(/^\./, '')).toLowerCase();
  return {
    id: `external:${input.externalPath}`,
    sessionId: input.sessionId,
    fileName,
    extension,
    attachmentType: getAttachmentType(extension),
    size: input.size,
    mtimeMs: input.mtimeMs,
    timestamp: input.timestamp,
    source: 'external',
    externalPath: input.externalPath,
  };
}

export function buildDetectedAttachmentHistoryItem(input: AttachmentDetectedEvent): SessionAttachmentHistoryItem {
  const extension = input.extension.toLowerCase();
  return {
    id: `detected:${input.relativePath || input.fileName}`,
    sessionId: input.sessionId,
    fileName: input.fileName,
    extension,
    attachmentType: input.attachmentType as AttachmentDetectedType,
    size: input.size,
    mtimeMs: 0,
    timestamp: input.timestamp,
    source: 'detected',
    relativePath: input.relativePath || input.fileName,
  };
}
```

- [ ] **Step 5: Run helper tests and verify pass**

Run: `npm run test -- test/session-attachment-history.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add -- src/types/session.ts src/session-attachment-history.ts test/session-attachment-history.test.ts
git commit -m "feat: COD-18 add attachment history helpers"
```

---

### Task 2: Persist History On Live Sessions

**Files:**
- Modify: `src/session.ts`
- Test: `test/session.test.ts` or `test/session-attachment-history.test.ts`

- [ ] **Step 1: Write failing session serialization test**

Add a focused test where existing session state tests live:

```ts
it('includes attachment history in session state', () => {
  const session = new Session({ workingDir: '/tmp' });
  session.upsertAttachmentHistory({
    id: 'detected:file.png',
    sessionId: session.id,
    fileName: 'file.png',
    extension: 'png',
    attachmentType: 'image',
    size: 12,
    mtimeMs: 0,
    timestamp: 100,
    source: 'detected',
    relativePath: 'file.png',
  });

  expect(session.toState().attachmentHistory).toHaveLength(1);
  expect(session.toState().attachmentHistory?.[0].fileName).toBe('file.png');
});
```

- [ ] **Step 2: Run test and verify failure**

Run the file containing the new test.

Expected: FAIL because `upsertAttachmentHistory` is not on `Session`.

- [ ] **Step 3: Implement live session history methods**

Modify `src/session.ts`:

```ts
import type { SessionAttachmentHistoryItem } from './types/session.js';
import { upsertAttachmentHistory } from './session-attachment-history.js';
```

Add a private field:

```ts
private _attachmentHistory: SessionAttachmentHistoryItem[] = [];
```

Add methods:

```ts
get attachmentHistory(): SessionAttachmentHistoryItem[] {
  return [...this._attachmentHistory];
}

upsertAttachmentHistory(item: SessionAttachmentHistoryItem): void {
  this._attachmentHistory = upsertAttachmentHistory(this._attachmentHistory, item);
}
```

Include in `toState()`:

```ts
attachmentHistory: this._attachmentHistory.length > 0 ? this._attachmentHistory : undefined,
```

- [ ] **Step 4: Run session serialization test and verify pass**

Run the file containing the new test.

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add -- src/session.ts test/session.test.ts
git commit -m "feat: COD-18 persist session attachment history"
```

---

### Task 3: Add Backend List Endpoint And Explicit Attach History

**Files:**
- Modify: `src/web/ports/session-port.ts`
- Modify: `src/web/routes/file-routes.ts`
- Modify: `test/mocks/mock-route-context.ts`
- Test: `test/routes/file-routes.test.ts`

- [ ] **Step 1: Write failing route tests**

Add tests to `test/routes/file-routes.test.ts`:

```ts
it('adds explicit attachments to session history and lists them newest first', async () => {
  mockedStat.mockResolvedValue({ size: 1024, isFile: () => true, mtimeMs: 12345 } as never);

  const registerRes = await harness.app.inject({
    method: 'POST',
    url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
    payload: { path: '/mnt/c/docs/brief.docx' },
  });
  expect(registerRes.statusCode).toBe(200);

  const listRes = await harness.app.inject({
    method: 'GET',
    url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
  });

  const body = JSON.parse(listRes.body);
  expect(body.success).toBe(true);
  expect(body.data).toHaveLength(1);
  expect(body.data[0]).toMatchObject({
    fileName: 'brief.docx',
    extension: 'docx',
    source: 'external',
    size: 1024,
  });
  expect(body.data[0].externalPath).toBeUndefined();
  expect(body.data[0].previewUrl).toContain('/attachments/');
});

it('lists persisted attachment history for stopped sessions', async () => {
  harness.ctx.sessions.delete(harness.ctx._sessionId);
  harness.ctx.store.getSession.mockReturnValue({
    id: harness.ctx._sessionId,
    pid: null,
    status: 'stopped',
    workingDir: '/tmp/test-workdir',
    currentTaskId: null,
    createdAt: 1,
    lastActivityAt: 1,
    attachmentHistory: [{
      id: 'detected:out/report.pdf',
      sessionId: harness.ctx._sessionId,
      fileName: 'report.pdf',
      extension: 'pdf',
      attachmentType: 'pdf',
      size: 100,
      mtimeMs: 0,
      timestamp: 2,
      source: 'detected',
      relativePath: 'out/report.pdf',
    }],
  });

  const listRes = await harness.app.inject({
    method: 'GET',
    url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
  });

  expect(listRes.statusCode).toBe(200);
  expect(JSON.parse(listRes.body).data[0]).toMatchObject({ fileName: 'report.pdf', source: 'detected' });
});
```

- [ ] **Step 2: Run route tests and verify failure**

Run: `npm run test -- test/routes/file-routes.test.ts`

Expected: FAIL because the list route/history update does not exist.

- [ ] **Step 3: Update route context type**

Modify `src/web/routes/file-routes.ts` so the route receives `ConfigPort` in addition to the existing ports:

```ts
import type { ConfigPort } from '../ports/config-port.js';

export function registerFileRoutes(app: FastifyInstance, ctx: SessionPort & EventPort & ConfigPort): void {
```

- [ ] **Step 4: Implement explicit attach history**

In `src/web/routes/file-routes.ts`, after successful `registerExternalAttachment`, build and upsert the external history item into the active session and persist:

```ts
const event = await registerExternalAttachment(id, body.path);
const session = findSessionOrFail(ctx, id);
session.upsertAttachmentHistory(
  buildExternalAttachmentHistoryItem({
    sessionId: id,
    externalPath: record.filePath,
    fileName: record.fileName,
    extension: record.extension,
    size: record.size,
    mtimeMs: record.mtimeMs,
    timestamp: event.timestamp,
  })
);
ctx.persistSessionState(session);
ctx.broadcast(SseEvent.AttachmentDetected, event);
return { success: true, data: event };
```

If `record` is not directly returned today, add a helper in `attachment-registry.ts` or use `attachmentRegistry.get(id, event.attachmentId)`.

- [ ] **Step 5: Implement list route**

Add a route before `GET /api/sessions/:id/attachments/:attachmentId`:

```ts
app.get('/api/sessions/:id/attachments', async (req, reply) => {
  const { id } = req.params as { id: string };
  const liveSession = ctx.sessions.get(id);
  const storedSession = liveSession ? null : ctx.store.getSession(id);
  const history = liveSession?.attachmentHistory ?? storedSession?.attachmentHistory;

  if (!liveSession && !storedSession) {
    reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, `Session ${id} not found`));
    return;
  }

  return {
    success: true,
    data: await Promise.all((history ?? []).map((item) => toAttachmentHistoryViewItem(item, liveSession?.workingDir ?? storedSession!.workingDir))),
  };
});
```

Implement `toAttachmentHistoryViewItem()` in `src/session-attachment-history.ts` or locally. It must not include `externalPath`.

- [ ] **Step 6: Run route tests and verify pass**

Run: `npm run test -- test/routes/file-routes.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit Task 3**

```bash
git add -- src/web/ports/session-port.ts src/web/routes/file-routes.ts test/mocks/mock-route-context.ts test/routes/file-routes.test.ts src/session-attachment-history.ts
git commit -m "feat: COD-18 list session attachment history"
```

---

### Task 4: Record Workspace-Detected Attachments

**Files:**
- Modify: `src/web/server.ts`
- Test: `test/document-attachments-ui.test.ts` or a focused server/listener test if one exists.

- [ ] **Step 1: Add a wiring test**

Add a static wiring test that verifies the server records detected attachment history before broadcast:

```ts
it('server records detected attachment history before broadcasting', () => {
  const serverTs = readFileSync(join(process.cwd(), 'src/web/server.ts'), 'utf-8');
  expect(serverTs).toContain('buildDetectedAttachmentHistoryItem');
  expect(serverTs).toContain('upsertAttachmentHistory');
  expect(serverTs).toContain('persistSessionState');
});
```

- [ ] **Step 2: Run test and verify failure**

Run: `npm run test -- test/document-attachments-ui.test.ts`

Expected: FAIL because `server.ts` does not yet record detected history.

- [ ] **Step 3: Implement detected history recording**

Modify `src/web/server.ts` in `setupImageWatcherListeners()`:

```ts
attachmentDetected: (event: AttachmentDetectedEvent) => {
  const session = this.sessions.get(event.sessionId);
  if (session) {
    session.upsertAttachmentHistory(buildDetectedAttachmentHistoryItem(event));
    this.persistSessionState(session);
  }
  this.broadcast(SseEvent.AttachmentDetected, {
    ...event,
    source: event.source || 'detected',
    thumbnailUrl: event.thumbnailUrl || buildFileThumbnailRoute(event.sessionId, event.relativePath || event.fileName),
  });
},
```

- [ ] **Step 4: Run wiring test and route tests**

Run: `npm run test -- test/document-attachments-ui.test.ts test/routes/file-routes.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit Task 4**

```bash
git add -- src/web/server.ts test/document-attachments-ui.test.ts
git commit -m "feat: COD-18 record detected attachment history"
```

---

### Task 5: Add Header Paperclip Drawer UI

**Files:**
- Modify: `src/web/public/index.html`
- Modify: `src/web/public/panels-ui.js`
- Modify: `src/web/public/styles.css`
- Modify: `src/web/public/mobile.css`
- Test: `test/document-attachments-ui.test.ts`

- [ ] **Step 1: Write failing frontend wiring tests**

Add tests:

```ts
it('adds a top-header attachments button with count badge', () => {
  const html = readFileSync(join(publicDir, 'index.html'), 'utf-8');
  expect(html).toContain('btn-attachments-history');
  expect(html).toContain('attachmentHistoryBadge');
  expect(html).toContain('toggleAttachmentHistory');
});

it('renders a persistent attachment history drawer and re-show action', () => {
  expect(panelsJs).toContain('toggleAttachmentHistory');
  expect(panelsJs).toContain('loadAttachmentHistory');
  expect(panelsJs).toContain('renderAttachmentHistory');
  expect(panelsJs).toContain('reshowAttachmentCard');
  expect(stylesCss).toContain('.attachment-history-drawer');
});
```

- [ ] **Step 2: Run frontend wiring tests and verify failure**

Run: `npm run test -- test/document-attachments-ui.test.ts`

Expected: FAIL because the header button and drawer methods do not exist.

- [ ] **Step 3: Add header button**

Add near the existing active-session header buttons:

```html
<button class="btn-icon-header btn-attachments-history" onclick="app.toggleAttachmentHistory()" title="Attachments" aria-label="Open session attachments">
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
  <span class="attachment-history-badge" id="attachmentHistoryBadge" style="display:none;">0</span>
</button>
```

- [ ] **Step 4: Add drawer markup dynamically in `panels-ui.js`**

Implement methods:

```js
ensureAttachmentHistoryDrawer() {
  let drawer = document.getElementById('attachmentHistoryDrawer');
  if (drawer) return drawer;
  drawer = document.createElement('aside');
  drawer.id = 'attachmentHistoryDrawer';
  drawer.className = 'attachment-history-drawer hidden';
  drawer.innerHTML = `
    <div class="attachment-history-header">
      <span>Attachments</span>
      <button type="button" class="attachment-history-close" onclick="app.closeAttachmentHistory()">&times;</button>
    </div>
    <div class="attachment-history-body" id="attachmentHistoryBody"></div>
  `;
  document.body.appendChild(drawer);
  return drawer;
}

toggleAttachmentHistory() {
  const drawer = this.ensureAttachmentHistoryDrawer();
  const willOpen = drawer.classList.contains('hidden');
  drawer.classList.toggle('hidden', !willOpen);
  if (willOpen) this.loadAttachmentHistory();
}

closeAttachmentHistory() {
  document.getElementById('attachmentHistoryDrawer')?.classList.add('hidden');
}

async loadAttachmentHistory(options = {}) {
  if (!this.activeSessionId) return;
  const res = await fetch(`/api/sessions/${this.activeSessionId}/attachments`);
  const result = await res.json();
  const items = result.success ? result.data : [];
  this.updateAttachmentHistoryBadge(items.length);
  if (!options.badgeOnly) this.renderAttachmentHistory(items);
}

renderAttachmentHistory(items) {
  const body = document.getElementById('attachmentHistoryBody');
  if (!body) return;
  body.innerHTML = items.length
    ? items.map((item) => this.renderAttachmentHistoryRow(item)).join('')
    : '<div class="attachment-history-empty">No attachments</div>';
  body.querySelectorAll('[data-attachment-history-action]').forEach((button) => {
    button.addEventListener('click', () => this.handleAttachmentHistoryAction(button));
  });
}

updateAttachmentHistoryBadge(count) {
  const badge = document.getElementById('attachmentHistoryBadge');
  if (!badge) return;
  badge.textContent = String(count);
  badge.style.display = count > 0 ? '' : 'none';
}

reshowAttachmentCard(item) {
  this.addAttachmentCard(item);
}
```

Rows must call existing `openFilePreview`, use safe `rawUrl` for Download/Open, and disable actions when `item.missing`.

- [ ] **Step 5: Refresh history count when attachments arrive and when sessions switch**

In `_onAttachmentDetected(data)`, increment or reload count for matching active session after `addAttachmentCard(data)`.

When active session changes, call `loadAttachmentHistory({ badgeOnly: true })` or a small count endpoint if added. For this pass, loading the list and using its length is acceptable.

- [ ] **Step 6: Add desktop/mobile styles**

Add desktop drawer styles to `src/web/public/styles.css`:

```css
.attachment-history-drawer { position: fixed; top: var(--header-height); right: 0; width: min(420px, 100vw); bottom: var(--toolbar-height); z-index: 1400; }
.attachment-history-row { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 12px; }
.attachment-history-badge { position: absolute; top: -4px; right: -4px; min-width: 16px; height: 16px; border-radius: 999px; }
```

Add mobile override to `src/web/public/mobile.css`:

```css
.attachment-history-drawer { inset: 0; width: 100vw; height: 100dvh; bottom: 0; }
```

- [ ] **Step 7: Run frontend wiring tests**

Run: `npm run test -- test/document-attachments-ui.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit Task 5**

```bash
git add -- src/web/public/index.html src/web/public/panels-ui.js src/web/public/styles.css src/web/public/mobile.css test/document-attachments-ui.test.ts
git commit -m "feat: COD-18 add attachment history drawer"
```

---

### Task 6: Verification, Build, Live Restart

**Files:**
- No source edits expected unless verification fails.

- [ ] **Step 1: Run focused tests**

```bash
npm run test -- test/session-attachment-history.test.ts test/routes/file-routes.test.ts test/document-attachments-ui.test.ts test/attachment-magic.test.ts
```

Expected: all tests pass.

- [ ] **Step 2: Run static checks**

```bash
npm run typecheck
npm run lint
npm run format:check
```

Expected: all pass.

- [ ] **Step 3: Build and packaging checks**

```bash
npm run build
npm run check:public-assets
npm run check:lockfile
```

Expected: all pass.

- [ ] **Step 4: Restart live Codeman**

Use the existing restart pattern:

```bash
PID=$(cat /home/aakhter/.codeman/codeman-it15.pid)
kill -TERM "$PID"
rm -f /home/aakhter/.codeman/codeman-it15.pid
setsid /home/aakhter/.local/bin/codeman-it15
codeman-ctl status
```

Expected: app running at `https://127.0.0.1:3000`; tunnel still up.

- [ ] **Step 5: Live validation**

Publish DOCX, PPTX, PNG, and PDF cards into the current live session. Verify:

- Paperclip count increases for the active session.
- Dismissing a floating card leaves it in the drawer.
- Preview works from drawer.
- Download/Open work from drawer.
- Re-show Card recreates floating card.
- Browser reload keeps the drawer history.

- [ ] **Step 6: Commit any verification fixes**

If live validation requires small fixes, commit them:

```bash
git status --short
git add -- src/web/public/index.html src/web/public/panels-ui.js src/web/public/styles.css src/web/public/mobile.css src/web/routes/file-routes.ts src/web/server.ts src/session.ts src/session-attachment-history.ts src/types/session.ts test/session-attachment-history.test.ts test/routes/file-routes.test.ts test/document-attachments-ui.test.ts
git commit -m "fix: COD-18 polish attachment history drawer"
```

---

## Self-Review

- Spec coverage: persistent session history, top-header paperclip, desktop drawer, mobile sheet, dismiss-only floating cards, Preview/Download/Open/Re-show Card, safe routes, missing file state, dedupe, cap, reload/restart coverage.
- Placeholder scan: no TBD/TODO placeholders.
- Type consistency: plan uses `SessionAttachmentHistoryItem`, `attachmentHistory`, `upsertAttachmentHistory`, `buildExternalAttachmentHistoryItem`, and `buildDetectedAttachmentHistoryItem` consistently across tasks.
