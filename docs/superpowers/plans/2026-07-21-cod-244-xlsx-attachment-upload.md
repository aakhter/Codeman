# XLSX Attachment Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept `.xlsx` files in Codeman's existing attachment upload workflow with open, download, history, removal, and binary non-preview behavior.

**Architecture:** Extend the existing document-upload and attachment-registry allowlists rather than creating a spreadsheet subsystem. XLSX is validated as ZIP-based OOXML, classified as the existing binary preview branch, and served with its official MIME type; all existing local/remote upload and attachment security paths remain unchanged.

**Tech Stack:** TypeScript ESM, Fastify, browser JavaScript, Vitest, Node.js filesystem APIs.

---

## File map

- `src/web/document-upload.ts`: server upload extension and byte-signature validation.
- `src/attachment-registry.ts`: supported attachment extensions and attachment-type classification.
- `src/types/tools.ts`: attachment event/API type union.
- `src/web/routes/file-routes.ts`: raw XLSX MIME response; existing upload route consumes the shared validators and registry.
- `src/web/public/document-input.js`: browser picker and drag/drop allowlist.
- `src/web/public/panels-ui.js`: attachment drawer support copy; binary preview branch already exists.
- `test/document-upload.test.ts`: pure extension/signature regression tests.
- `test/attachment-magic.test.ts`: registry allowlist regression.
- `test/routes/attachment-upload-routes.test.ts`: end-to-end multipart XLSX upload regression.
- `test/routes/file-routes.test.ts`: attachment registration, metadata, raw MIME, and preview redirect regression.
- `test/document-upload-a11y.test.ts`: frontend picker/list parity guard.
- `test/document-attachments-ui.test.ts`: support-copy and binary-preview wiring guard.

### Task 1: XLSX upload validation

**Files:**
- Modify: `test/document-upload.test.ts`
- Modify: `src/web/document-upload.ts`

- [ ] **Step 1: Extend the pure validator tests first**

Update the exact allowlist and case-insensitive acceptance tests, keep `.xls` rejected, and cover all accepted ZIP signatures:

```ts
expect([...UPLOAD_ALLOWED_EXTENSIONS].sort()).toEqual(
  ['docx', 'markdown', 'md', 'pdf', 'pptx', 'txt', 'xlsx'].sort()
);

for (const ext of ['pdf', 'PDF', 'docx', 'Pptx', 'xlsx', 'XLSX', 'md', 'markdown', 'txt']) {
  expect(isAllowedUploadExtension(ext)).toBe(true);
}

expect(isAllowedUploadExtension('.XLSX')).toBe(true);
expect(isAllowedUploadExtension('xls')).toBe(false);

const localHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const emptyArchive = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const spannedArchive = Buffer.from([0x50, 0x4b, 0x07, 0x08]);
expect(documentMagicMatchesExt(localHeader, 'xlsx')).toBe(true);
expect(documentMagicMatchesExt(emptyArchive, 'xlsx')).toBe(true);
expect(documentMagicMatchesExt(spannedArchive, 'xlsx')).toBe(true);
expect(documentMagicMatchesExt(Buffer.from('not a zip'), 'xlsx')).toBe(false);
```

- [ ] **Step 2: Run the validator test and confirm the new assertions fail**

Run: `npm test -- test/document-upload.test.ts`

Expected: FAIL because `xlsx` is absent from `UPLOAD_ALLOWED_EXTENSIONS` and `documentMagicMatchesExt` returns false.

- [ ] **Step 3: Implement the minimal validator extension**

In `src/web/document-upload.ts`, add `xlsx` to the allowlist and ZIP branch:

```ts
export const UPLOAD_ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set([
  'pdf',
  'docx',
  'pptx',
  'xlsx',
  'md',
  'markdown',
  'txt',
]);
```

```ts
case 'docx':
case 'pptx':
case 'xlsx': {
  // existing PK signature validation remains unchanged
}
```

Update the function comment so XLSX is documented as an OOXML ZIP format.

- [ ] **Step 4: Run the validator test and confirm it passes**

Run: `npm test -- test/document-upload.test.ts`

Expected: one test file passes with no failures.

- [ ] **Step 5: Commit validator support**

```bash
git add -- src/web/document-upload.ts test/document-upload.test.ts
git commit -m "feat(upload): COD-244 validate XLSX attachments"
```

### Task 2: Attachment registration, metadata, and raw serving

**Files:**
- Modify: `test/attachment-magic.test.ts`
- Modify: `test/routes/attachment-upload-routes.test.ts`
- Modify: `test/routes/file-routes.test.ts`
- Modify: `src/types/tools.ts`
- Modify: `src/attachment-registry.ts`
- Modify: `src/web/routes/file-routes.ts`

- [ ] **Step 1: Add failing registry and route coverage**

Add a registry expectation:

```ts
expect(isSupportedAttachmentExtension('xlsx')).toBe(true);
expect(isSupportedAttachmentExtension('xls')).toBe(false);
```

Add a multipart upload test using the existing `ZIP_BYTES` fixture:

```ts
it('200: uploads an .xlsx with a ZIP prefix as a binary attachment', async () => {
  const res = await harness.app.inject({
    method: 'POST',
    url: `/api/sessions/${harness.ctx._sessionId}/attachments/upload`,
    headers: MULTIPART_HEADERS,
    payload: uploadBody(
      BOUNDARY,
      'forecast.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ZIP_BYTES
    ),
  });

  expect(res.statusCode).toBe(200);
  const body = JSON.parse(res.body);
  expect(body.data.extension).toBe('xlsx');
  expect(body.data.attachmentType).toBe('binary');
  expect(body.data.agentPath).toMatch(/^\.codeman-attachments\/forecast-.*\.xlsx$/);
  expect(attachmentRegistry.get(harness.ctx._sessionId, body.data.attachmentId)?.source).toBe('upload');
});
```

Extend the raw attachment MIME table in `test/routes/file-routes.test.ts` with:

```ts
[
  'xlsx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '/mnt/c/sheets/forecast.xlsx',
  'forecast.xlsx',
],
```

Add a focused metadata/preview assertion after registering `/mnt/c/sheets/forecast.xlsx`:

```ts
expect(registerBody.data.attachmentType).toBe('binary');

const metadata = await harness.app.inject({
  method: 'GET',
  url: `/api/sessions/${harness.ctx._sessionId}/attachments/${attachmentId}`,
});
expect(JSON.parse(metadata.body).data.type).toBe('binary');

const preview = await harness.app.inject({
  method: 'GET',
  url: `/api/sessions/${harness.ctx._sessionId}/attachments/${attachmentId}/preview`,
});
expect(preview.statusCode).toBe(302);
expect(preview.headers.location).toContain(`/attachments/${attachmentId}/raw`);
```

- [ ] **Step 2: Run the focused tests and confirm they fail**

Run:

```bash
npm test -- test/attachment-magic.test.ts test/routes/attachment-upload-routes.test.ts test/routes/file-routes.test.ts
```

Expected: FAIL because XLSX registration is unsupported and no `binary` event type or MIME mapping exists.

- [ ] **Step 3: Implement registry and API metadata support**

Extend `AttachmentDetectedType` in `src/types/tools.ts` with only the existing members plus `binary`:

```ts
export type AttachmentDetectedType =
  | 'image'
  | 'pdf'
  | 'document'
  | 'presentation'
  | 'markdown'
  | 'text'
  | 'binary';
```

In `src/attachment-registry.ts`, add `xlsx` to `SUPPORTED_ATTACHMENT_EXTENSIONS` and classify it before the default document return:

```ts
if (normalized === 'xlsx') return 'binary';
```

In `src/web/routes/file-routes.ts`, add the standard MIME mapping:

```ts
xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
```

Do not add XLSX to `serveConvertedPreview`; its attachment preview route must continue redirecting non-DOCX/PPTX formats to raw bytes.

- [ ] **Step 4: Run the registry and route tests and confirm they pass**

Run:

```bash
npm test -- test/attachment-magic.test.ts test/routes/attachment-upload-routes.test.ts test/routes/file-routes.test.ts
```

Expected: all three test files pass with no failures.

- [ ] **Step 5: Run typecheck after extending the event union**

Run: `npm run typecheck`

Expected: exit 0 with no TypeScript errors.

- [ ] **Step 6: Commit backend attachment support**

```bash
git add -- src/types/tools.ts src/attachment-registry.ts src/web/routes/file-routes.ts test/attachment-magic.test.ts test/routes/attachment-upload-routes.test.ts test/routes/file-routes.test.ts
git commit -m "feat(attachments): COD-244 register and serve XLSX files"
```

### Task 3: Browser intake and non-preview experience

**Files:**
- Modify: `test/document-upload-a11y.test.ts`
- Modify: `test/document-attachments-ui.test.ts`
- Modify: `src/web/public/document-input.js`
- Modify: `src/web/public/panels-ui.js`

- [ ] **Step 1: Add failing frontend source-contract tests**

Extend both frontend allowlist loops in `test/document-upload-a11y.test.ts` with XLSX:

```ts
for (const ext of ['.pdf', '.docx', '.pptx', '.xlsx', '.md', '.markdown', '.txt']) {
  expect(accept).toContain(ext);
}

for (const ext of ['pdf', 'docx', 'pptx', 'xlsx', 'md', 'markdown', 'txt']) {
  expect(extsMatch![1]).toContain(`'${ext}'`);
}
```

Update the drawer-copy assertion and pin the existing binary branch in `test/document-attachments-ui.test.ts`:

```ts
expect(panelsJs).toContain('Supports .pptx, .docx, .xlsx, .pdf, .png, .md, and .txt.');
expect(panelsJs).toContain("data.type === 'binary'");
expect(panelsJs).toContain('Cannot preview');
```

- [ ] **Step 2: Run the frontend tests and confirm they fail**

Run:

```bash
npm test -- test/document-upload-a11y.test.ts test/document-attachments-ui.test.ts
```

Expected: FAIL because `.xlsx` is absent from the browser lists and drawer copy.

- [ ] **Step 3: Extend browser selection and UI copy**

In `src/web/public/document-input.js`, update both synchronized lists:

```js
_documentUploadExtensions: ['pdf', 'docx', 'pptx', 'xlsx', 'md', 'markdown', 'txt'],
```

```js
input.accept = '.pdf,.docx,.pptx,.xlsx,.md,.markdown,.txt';
```

In every attachment-drawer empty-state copy occurrence in `src/web/public/panels-ui.js`, use:

```html
<div>Supports .pptx, .docx, .xlsx, .pdf, .png, .md, and .txt.</div>
```

Leave `_renderFilePreviewBody` unchanged: `attachmentType: binary` already reaches its `Cannot preview` branch and does not invoke Office conversion.

- [ ] **Step 4: Run the frontend tests and syntax check**

Run:

```bash
npm test -- test/document-upload-a11y.test.ts test/document-attachments-ui.test.ts
npm run check:frontend-syntax
```

Expected: both test files pass and all frontend JavaScript parses cleanly.

- [ ] **Step 5: Commit frontend support**

```bash
git add -- src/web/public/document-input.js src/web/public/panels-ui.js test/document-upload-a11y.test.ts test/document-attachments-ui.test.ts
git commit -m "feat(ui): COD-244 allow XLSX attachment selection"
```

### Task 4: Final verification and traceability

**Files:**
- Modify only if formatting tools require it: files changed in Tasks 1-3.

- [ ] **Step 1: Run the complete focused regression set**

Run:

```bash
npm test -- test/document-upload.test.ts test/attachment-magic.test.ts test/routes/attachment-upload-routes.test.ts test/routes/file-routes.test.ts test/document-upload-a11y.test.ts test/document-attachments-ui.test.ts
```

Expected: all six test files pass with no failures.

- [ ] **Step 2: Run repository quality gates**

Run each command separately:

```bash
npm run typecheck
npm run lint
npm run format:check
npm run check:lockfile
npm run check:frontend-syntax
npm run build
git diff --check
```

Expected: every command exits 0. The build may print known duplicate-member warnings from the committed frontend baseline, but must complete successfully.

- [ ] **Step 3: Inspect final scope**

Run:

```bash
git status --short --branch
git diff --stat origin/local...HEAD
git log -6 --oneline
```

Expected: only COD-244 files are changed/committed; the branch contains the design, plan, validator, backend, and frontend commits.

- [ ] **Step 4: Update Jira COD-244**

Add a Jira comment containing the branch name, final commit IDs, exact test counts, quality-gate results, and any remaining limitation (`.xls` and inline preview are out of scope). Do not transition the issue to Done until the branch is pushed and landed according to the repository workflow.
