# COD-389 Reboot Session Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retain a user-selectable, transport-aware path to conversation recovery after a Codeman host reboot, without automatically continuing agents.

**Architecture:** Persist recovery records independently of active sessions. Snapshot dead managed sessions before the existing boot cleanup destroys their state, then expose owner-filtered recovery actions. Reuse existing Claude history, native Codex/OpenCode resume IDs, remote tmux attach, and Docker launch machinery; custom Codex commands only resume through an explicit template.

**Tech Stack:** TypeScript ESM, Fastify, Zod, Vitest, tmux, SSH, Docker, plain browser JavaScript/CSS.

---

### Task 1: Add a durable recovery-record domain

**Files:** Create `src/types/session-recovery.ts`, `src/session-recovery.ts`, `test/session-recovery.test.ts`; modify `src/types/app-state.ts:108-134`, `src/state-store.ts:504-575`, `test/state-store.test.ts`.

- [ ] **Step 1: Write the failing domain and store tests.**

```ts
it('creates a resumable local Codex record without secrets', () => {
  const record = createRecoveryRecord(savedCodexState, { transport: 'local' });
  expect(record).toMatchObject({ sourceSessionId: 'old-codex', mode: 'codex', status: 'resumable' });
  expect(JSON.stringify(record)).not.toContain('OPENAI_API_KEY');
});
it('clones recovery records at the StateStore boundary', () => {
  store.setSessionRecoveries([record]);
  store.getSessionRecoveries()[0].status = 'recovered';
  expect(store.getSessionRecoveries()[0].status).toBe('resumable');
});
```

- [ ] **Step 2: Run `npm test -- test/session-recovery.test.ts test/state-store.test.ts`; expect RED because no recovery API exists.**

- [ ] **Step 3: Implement the typed model and cloned store API.**

```ts
export type SessionRecoveryStatus =
  | 'pending'
  | 'reattachable'
  | 'resumable'
  | 'manual_required'
  | 'unavailable'
  | 'recovered';
export interface SessionRecoveryRecord {
  id: string;
  sourceSessionId: string;
  owner?: string;
  mode: SessionMode;
  workingDir: string;
  transport: 'local' | 'remote' | 'docker';
  nativeResumeId?: string;
  status: SessionRecoveryStatus;
  launch: { kind: 'built-in' } | { kind: 'template'; templateId: string } | { kind: 'manual_required'; hint: string };
  createdAt: number;
  lastActivityAt?: number;
  recoveredSessionId?: string;
}
```

Add `sessionRecoveries?: SessionRecoveryRecord[]` to `AppState`; add cloning `get/set/upsert/remove` methods in `StateStore`; retain at most 200 terminal records per owner. Do not persist `__envOverrides`, provider identity, credentials, or raw SSH errors.

- [ ] **Step 4: Run `npm test -- test/session-recovery.test.ts test/state-store.test.ts`; expect GREEN.**
- [ ] **Step 5: Commit with `feat: COD-389 persist reboot recovery records`.**

### Task 2: Snapshot reboot casualties before stale cleanup

**Files:** Modify `src/web/server.ts:3656-4005`, `src/session-recovery.ts`; create `test/server-reboot-recovery.test.ts`.

- [ ] **Step 1: Write failing boot-order tests.**

```ts
it('preserves dead managed state before stale cleanup removes it', async () => {
  mux.reconcileSessions.mockResolvedValue({ alive: [], dead: ['lost-codex'], discovered: [] });
  store.setSession('lost-codex', savedCodexState);
  await server.restoreForTest();
  expect(store.getSessionRecoveries()).toEqual([expect.objectContaining({ sourceSessionId: 'lost-codex' })]);
  expect(store.getSession('lost-codex')).toBeNull();
});
it('does not record a normal process restart whose mux survives', async () => {
  mux.reconcileSessions.mockResolvedValue({ alive: ['still-live'], dead: [], discovered: [] });
  await server.restoreForTest();
  expect(store.getSessionRecoveries()).toEqual([]);
});
```

- [ ] **Step 2: Run `npm test -- test/server-reboot-recovery.test.ts`; expect RED.**
- [ ] **Step 3: Add `captureDeadSessionRecoveries(dead)` after `reconcileSessions()` and before `finalizeRestoredState()`. It reads saved session and mux metadata, upserts exactly one record, and performs no CLI, SSH, input, or pane launch.**
- [ ] **Step 4: Run `npm test -- test/server-reboot-recovery.test.ts test/server-restore-remote.test.ts test/state-store.test.ts`; expect GREEN with existing live-mux restoration unchanged.**
- [ ] **Step 5: Commit with `feat: COD-389 preserve reboot recovery candidates`.**

### Task 3: Reuse native IDs and make custom Codex recovery fail closed

**Files:** Modify `src/session.ts:1566-1620`, `src/web/routes/session-routes.ts:2569-2698`, `src/types/session.ts:133-163`, `src/types/app-state.ts:79-83`, `src/web/schemas.ts:702-758`, `src/tmux-manager.ts:914-990,1457-1541`; modify `test/session-native-resume.test.ts`, `test/routes/session-park-native-resume.test.ts`, `test/codex-command-profiles.test.ts`.

- [ ] **Step 1: Write failing strategy tests.**

```ts
it('uses the existing parked OpenCode ID in a boot record', () => {
  expect(createRecoveryRecord({ ...savedOpenCodeState, nativeResumeId: 'ses_resume_me' }, local)).toMatchObject({
    nativeResumeId: 'ses_resume_me',
    status: 'resumable',
  });
});
it('does not auto-resume an opaque custom Codex command', () => {
  expect(resolveCodexRecoveryStrategy({ command: 'codex-router start' }, 'rollout-id')).toEqual({
    kind: 'manual_required',
  });
});
```

- [ ] **Step 2: Run `npm test -- test/session-native-resume.test.ts test/routes/session-park-native-resume.test.ts test/codex-command-profiles.test.ts`; expect RED.**
- [ ] **Step 3: Reuse existing `nativeResumeId` and `_applyNativeResumeIdForResume()` for Codex/OpenCode. Do not add another OpenCode adapter; improve the existing capture only where it can distinguish concurrent panes rather than choosing a shared directory's newest row.**
- [ ] **Step 4: Add optional `resumeCommandTemplate` to Codex command profiles and remote Codex selection. It must contain exactly one `{{resumeId}}`, no other token, and stay within the current 300-character command limit.**

```ts
const CodexResumeCommandTemplateSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine((v) => (v.match(/\{\{resumeId\}\}/g) ?? []).length === 1, 'Use {{resumeId}} exactly once')
  .refine((v) => !/\{\{(?!resumeId\}\})/.test(v), 'Unsupported template token');
```

- [ ] **Step 5: Implement pure command strategy selection: built-in Codex uses `buildCodexCommand({ ...config, resumeSessionId })`; a declared template receives only a validated ID and retains its local/remote wrapper; legacy/custom commands without a template return `manual_required`. Never append to or rewrite opaque shell strings.**
- [ ] **Step 6: Run `npm test -- test/session-native-resume.test.ts test/routes/session-park-native-resume.test.ts test/codex-command-profiles.test.ts test/remote-tmux-launch.test.ts`; expect GREEN.**
- [ ] **Step 7: Commit with `feat: COD-389 add safe custom Codex recovery`.**

### Task 4: Add owner-filtered recovery actions and transport checks

**Files:** Create `src/web/routes/session-recovery-routes.ts`, `test/routes/session-recovery-routes.test.ts`, `test/remote-session-recovery.test.ts`; modify `src/web/server.ts:1760-1790`, `src/remote-hosts.ts:497-550`, `src/web/schemas.ts`.

- [ ] **Step 1: Write failing route tests.**

```ts
it('lists only the caller owner records and starts nothing on GET', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/session-recoveries', cookies: aliceCookie });
  expect(res.json().data.records.map((r: { owner?: string }) => r.owner)).toEqual(['alice']);
  expect(ctx.addSession).not.toHaveBeenCalled();
});
it('permits owned reconnect but rejects discovered remote resume', async () => {
  expect((await app.inject({ method: 'POST', url: '/api/session-recoveries/owned/reconnect' })).statusCode).toBe(200);
  expect((await app.inject({ method: 'POST', url: '/api/session-recoveries/discovered/resume' })).statusCode).toBe(409);
});
```

- [ ] **Step 2: Run `npm test -- test/routes/session-recovery-routes.test.ts test/remote-session-recovery.test.ts`; expect RED because routes are absent.**
- [ ] **Step 3: Add `GET /api/session-recoveries`, `POST /:id/refresh`, `POST /:id/reconnect`, `POST /:id/resume`, and `POST /:id/dismiss`, with strict Zod ID parsing and existing owner guards.**
- [ ] **Step 4: Add `probeRemoteRecoveryTarget()` using existing SSH args, `tmux has-session`, correct owned/discovered socket selection, a 15-second timeout, and sanitized output. Call it only on Refresh/Reconnect/Resume, never boot.**
- [ ] **Step 5: Reconnect only to a live remote tmux; resume an owned dead remote by rebuilding through existing `buildRemoteSessionCommand`; unowned discovered records remain attach-only; Docker delegates to current attach-or-resume builders. Set `recoveredSessionId` only after add/listener/persist success.**
- [ ] **Step 6: Run `npm test -- test/routes/session-recovery-routes.test.ts test/remote-session-recovery.test.ts test/remote-discover-attach.test.ts test/remote-tmux-launch.test.ts`; expect GREEN and exactly one pane per action.**
- [ ] **Step 7: Commit with `feat: COD-389 add explicit session recovery actions`.**

### Task 5: Render the Session Manager Recovery Queue

**Files:** Modify `src/web/public/index.html`, `src/web/public/panels-ui.js:1054-1180`, `src/web/public/styles.css`; create `test/session-manager-recovery-ui.test.ts`; modify `test/command-palette-ui.test.ts`.

- [ ] **Step 1: Write failing DOM tests.**

```ts
it('renders recovery records separately from live and history rows', async () => {
  fetch.mockResolvedValueOnce(ok({ records: [resumableCodex, reattachableRemote] }));
  await app._loadSessionManagerList('');
  expect(document.querySelector('[data-recovery-id="lost-codex"]')).not.toBeNull();
});
it('does not recover merely by opening the manager', async () => {
  await app.openSessionManager();
  expect(fetch).not.toHaveBeenCalledWith(expect.stringMatching(/\/resume$/), expect.anything());
});
```

- [ ] **Step 2: Run `npm test -- test/session-manager-recovery-ui.test.ts test/command-palette-ui.test.ts`; expect RED.**
- [ ] **Step 3: Add `#sessionRecoveryList` above ordinary history. Fetch recovery records alongside the unified list. Map `reattachable` to Reconnect, `resumable` to Resume, `manual_required` to a copyable sanitized hint, and `unavailable` to Start new. Confirm original local or remote location before any mutation.**
- [ ] **Step 4: On action success refresh the recovery list and select only the returned new session. Keep recovery rows out of `this.sessions`, live-tab selection, and command-palette live switching. Add a wrapping button row and focus-safe styling for 390px widths.**
- [ ] **Step 5: Run `npm test -- test/session-manager-recovery-ui.test.ts test/command-palette-ui.test.ts test/history-list-controls.test.ts test/monitor-tab-sync.test.ts`; expect GREEN.**
- [ ] **Step 6: Commit with `feat: COD-389 show reboot recovery queue`.**

### Task 6: Document and verify without disturbing managed tmux

**Files:** Modify `docs/wiki/Core-Concepts.md:98-122`, `README.md:379-388`.

- [ ] **Step 1: Document the boundary: host reboot ends local tmux but leaves a selective Recovery Queue when a safe reattach/resume identity exists; distinguish service restart, remote liveness, Docker, and manual custom-command recovery.**
- [ ] **Step 2: Run `npm run typecheck && npm run lint && npm run format:check && npm run check:lockfile && git diff --check`; expect every command to exit 0.**
- [ ] **Step 3: Run `npm test -- test/session-recovery.test.ts test/server-reboot-recovery.test.ts test/session-native-resume.test.ts test/routes/session-park-native-resume.test.ts test/routes/session-recovery-routes.test.ts test/remote-session-recovery.test.ts test/remote-tmux-launch.test.ts test/remote-discover-attach.test.ts test/session-manager-recovery-ui.test.ts test/state-store.test.ts`; expect PASS. Never run bare `npm test` in a Codeman-managed session.**
- [ ] **Step 4: With separate approval only, smoke-test disposable local and owned-remote sessions; simulate their wrapper loss, prove boot starts no agents, recover one pane per action, then clean up the disposable sessions.**
- [ ] **Step 5: Commit docs with `docs: COD-389 explain reboot session recovery`, add the measured branch/commit/test evidence to COD-389, and do not merge, push, deploy, restart `codeman-web`, or mark Done without separate approval.**
