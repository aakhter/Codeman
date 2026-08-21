# Saved Codex Command Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an authenticated owner create reusable saved Codex command profiles and select one, a custom command, or the normal default for each remote case.

**Architecture:** Persist owner-private `CodexCommandProfile` records in StateStore and a stable `codexCommandProfileId` on RemoteCase. A focused profile helper handles migration, names, usage, and launch resolution. Existing raw `commands.codex` remains only for custom or legacy state.

**Tech Stack:** TypeScript ESM, Fastify, Zod, StateStore JSON, remote SSH session launch, plain browser JS/HTML/CSS, Vitest, Playwright Chromium.

---

## File structure

| File | Responsibility |
| --- | --- |
| `src/types/app-state.ts`, `src/state-store.ts` | Owner-keyed profile persistence. |
| `src/types/session.ts`, `src/types/api.ts` | RemoteCase selection and browser-safe detail metadata. |
| `src/codex-command-profiles.ts` | Naming, usage, migration, and command resolution. |
| `src/web/schemas.ts`, `src/web/routes/codex-command-profile-routes.ts` | Strict profile and selection APIs. |
| `src/web/routes/case-routes.ts`, `src/web/routes/session-routes.ts` | Case mutation and launch-time resolution. |
| `src/web/public/index.html`, `session-ui.js`, `styles.css` | Approved selector and manager UI. |

### Task 1: Add profile persistence and pure profile helpers

**Files:**

- Modify: `src/types/app-state.ts`
- Modify: `src/types/session.ts`
- Modify: `src/state-store.ts`
- Create: `src/codex-command-profiles.ts`
- Modify: `test/state-store.test.ts`
- Create: `test/codex-command-profiles.test.ts`

- [ ] **Step 1: Write failing persistence tests**

Add owner-isolation, clone-on-read, and restart tests:

~~~ts
store.setCodexCommandProfiles('alice', [{ id: 'personal', name: 'Personal', command: 'exec codx personal' }]);
store.setCodexCommandProfiles('bob', [{ id: 'work', name: 'Work', command: 'exec codx work' }]);
expect(store.getCodexCommandProfiles('alice')).toEqual([
  { id: 'personal', name: 'Personal', command: 'exec codx personal' },
]);
expect(store.getCodexCommandProfiles('bob')).toEqual([
  { id: 'work', name: 'Work', command: 'exec codx work' },
]);
~~~

Flush and reconstruct StateStore. Assert serialized `codexCommandProfiles`; mutate a returned array and prove a fresh accessor result is unchanged.

- [ ] **Step 2: Write failing pure-helper tests**

Create tests for:

~~~ts
expect(deriveCodexProfileName('exec codx personal', [])).toBe('Personal');
expect(deriveCodexProfileName('exec codx personal', ['Personal'])).toBe('Personal 2');
expect(deriveCodexProfileName('***', [])).toBe('Imported 1');
expect(resolveCodexCommandSelection({ codexCommandProfileId: 'personal' }, profiles, undefined))
  .toEqual({ ok: true, command: 'exec codx personal' });
expect(resolveCodexCommandSelection({ commands: { codex: 'exec custom' } }, profiles, undefined))
  .toEqual({ ok: true, command: 'exec custom' });
expect(resolveCodexCommandSelection({ codexCommandProfileId: 'missing' }, profiles, undefined))
  .toEqual({ ok: false, error: 'Saved Codex command profile is unavailable' });
~~~

Also cover case-insensitive names, trimmed exact-command matching, deterministic usage case-name ordering, and fallback to host command only when no profile ID/custom command exists.

- [ ] **Step 3: Verify RED**

Run:

~~~bash
npm test -- test/state-store.test.ts test/codex-command-profiles.test.ts
~~~

Expected: missing profile fields, StateStore methods, and helper module.

- [ ] **Step 4: Add minimal types and StateStore accessors**

Add:

~~~ts
export interface CodexCommandProfile {
  id: string;
  name: string;
  command: string;
}

// In AppState:
codexCommandProfiles?: Record<string, CodexCommandProfile[]>;
~~~

Add `codexCommandProfileId?: string` to `RemoteCase`, leaving `commands?.codex` for custom/legacy state.

Add clone-on-write accessors:

~~~ts
getCodexCommandProfiles(owner: string): CodexCommandProfile[];
setCodexCommandProfiles(owner: string, profiles: CodexCommandProfile[]): void;
~~~

Include the optional state field in `assembleStateJson()` immediately after `caseDefaultGroups`. Copy arrays/objects at both input and output boundaries. Follow existing `Object.hasOwn()` prototype-key handling where owner records are examined.

- [ ] **Step 5: Implement pure helpers**

Export:

~~~ts
deriveCodexProfileName(command: string, existingNames: readonly string[]): string;
findMatchingCodexProfile(command: string, profiles: readonly CodexCommandProfile[]): CodexCommandProfile | undefined;
getCodexProfileUsage(cases: readonly RemoteCase[], profileId: string): string[];
resolveCodexCommandSelection(
  remoteCase: Pick<RemoteCase, 'codexCommandProfileId' | 'commands'>,
  profiles: readonly CodexCommandProfile[],
  hostCommand: string | undefined
): { ok: true; command: string | undefined } | { ok: false; error: string };
~~~

Derived names strip a leading `exec`, use the final meaningful token in title case, add ` 2`, ` 3` on case-insensitive collisions, and fall back to `Imported N`. Resolution is profile > custom > host/default and fails closed for an unavailable profile ID.

- [ ] **Step 6: Verify GREEN and commit**

~~~bash
npm test -- test/state-store.test.ts test/codex-command-profiles.test.ts
npm run typecheck
git diff --check
git add src/types/app-state.ts src/types/session.ts src/state-store.ts src/codex-command-profiles.ts test/state-store.test.ts test/codex-command-profiles.test.ts
git commit -m "feat(state): COD-351 persist Codex command profiles"
~~~

### Task 2: Add owner-scoped CRUD and idempotent migration

**Files:**

- Modify: `src/web/schemas.ts`
- Create: `src/web/routes/codex-command-profile-routes.ts`
- Modify: `src/web/server.ts`
- Modify: `src/codex-command-profiles.ts`
- Modify: `test/mocks/mock-route-context.ts`
- Create: `test/routes/codex-command-profile-routes.test.ts`
- Modify: `test/remote-hosts.test.ts`

- [ ] **Step 1: Write failing route and migration tests**

Build an authenticated Alice/Bob harness. Require:

~~~ts
const list = await app.inject({ method: 'GET', url: '/api/codex-command-profiles' });
expect(list.json().data.profiles).toEqual([
  expect.objectContaining({ id: 'personal', name: 'Personal', command: 'exec codx personal', usage: ['nzbdav'] }),
]);

const create = await app.inject({
  method: 'POST',
  url: '/api/codex-command-profiles',
  payload: { name: 'Work', command: 'exec codx work' },
});
expect(create.statusCode).toBe(200);
~~~

Cover duplicate names ignoring case, command/name limits, foreign list/update/delete non-disclosure, a referenced update requiring confirmation, confirmed update, referenced delete conflict with case names, and unused delete.

Migration fixture: two Alice remote cases with `exec codx personal` produce one `Personal` profile and identical IDs; rerun produces no duplicate; ownerless multi-user case stays custom; single-user ownerless case migrates to `@single`.

- [ ] **Step 2: Verify RED**

~~~bash
npm test -- test/routes/codex-command-profile-routes.test.ts test/remote-hosts.test.ts
~~~

Expected: 404 profile endpoints and no migration.

- [ ] **Step 3: Add strict schemas**

Add create/update schemas with `name: z.string().trim().min(1).max(60)` and `command: z.string().trim().min(1).max(300)`. Update schema adds `confirmReferencedUpdate: z.boolean().optional()` and rejects a body that changes neither field. Add profile-ID parameter parsing and never accept an owner in any request payload.

- [ ] **Step 4: Implement idempotent migration**

Implement:

~~~ts
migrateLegacyRemoteCaseCodexCommands(
  configDir: string,
  owner: string,
  store: Pick<StateStore, 'getCodexCommandProfiles' | 'setCodexCommandProfiles'>,
  options: { allowOwnerlessSingleUser: boolean }
): Promise<{ profiles: CodexCommandProfile[]; cases: RemoteCase[] }>;
~~~

Consider only `case.owner === owner`, plus ownerless cases only in single-user mode. Deduplicate trimmed legacy `commands.codex`, reuse an existing matching profile, persist the profile library first, then persist remote-case IDs and remove migrated raw Codex values. This order makes a retry safe after interruption. Never migrate non-Codex overrides.

- [ ] **Step 5: Implement routes**

Every route derives `ownerFor(req)`, runs eligible migration, then reads/writes only that owner’s StateStore profiles. List responses include computed usage arrays. Update returns an operation error plus `{ requiresConfirmation: true, usage }` when the command changes for referenced profiles without confirmation. Delete returns a conflict and case names when usage is nonempty. Sort returned profiles case-insensitively by name.

- [ ] **Step 6: Verify GREEN and commit**

~~~bash
npm test -- test/routes/codex-command-profile-routes.test.ts test/remote-hosts.test.ts test/ownership-scoping.test.ts
npm run typecheck
git diff --check
git add src/web/schemas.ts src/web/routes/codex-command-profile-routes.ts src/web/server.ts src/codex-command-profiles.ts test/mocks/mock-route-context.ts test/routes/codex-command-profile-routes.test.ts test/remote-hosts.test.ts
git commit -m "feat(api): COD-351 manage Codex command profiles"
~~~

### Task 3: Persist remote-case selection and resolve it before launch

**Files:**

- Modify: `src/types/api.ts`
- Modify: `src/web/schemas.ts`
- Modify: `src/web/routes/case-routes.ts`
- Modify: `src/web/routes/session-routes.ts`
- Modify: `test/routes/case-routes.test.ts`
- Modify: `test/routes/session-routes.test.ts`
- Modify: `test/remote-tmux-launch.test.ts`

- [ ] **Step 1: Write failing selection/launch tests**

Require profile/default/custom transitions:

~~~ts
await app.inject({
  method: 'PUT',
  url: '/api/cases/nzbdav',
  payload: { codexCommandSelection: { kind: 'profile', profileId: 'personal' } },
});
expect(updated.codexCommandProfileId).toBe('personal');
expect(updated.commands?.codex).toBeUndefined();

await app.inject({
  method: 'PUT',
  url: '/api/cases/nzbdav',
  payload: { codexCommandSelection: { kind: 'custom', command: 'exec codx work' } },
});
expect(updated.codexCommandProfileId).toBeUndefined();
expect(updated.commands?.codex).toBe('exec codx work');
~~~

Test `default` clears both Codex values while preserving other mode overrides. Reject a foreign/missing profile before remote-case file write. Session-route tests must prove selected profile command, custom command, normal host/default fallback, and missing profile error before SSH/tmux probe or Session construction.

- [ ] **Step 2: Verify RED**

~~~bash
npm test -- test/routes/case-routes.test.ts test/routes/session-routes.test.ts test/remote-tmux-launch.test.ts
~~~

Expected: selection schema rejection and missing profile silently falls through.

- [ ] **Step 3: Add the selection schema and safe detail metadata**

Add:

~~~ts
export const CodexCommandSelectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('default') }),
  z.object({ kind: z.literal('profile'), profileId: z.string().min(1).max(100) }),
  z.object({ kind: z.literal('custom'), command: z.string().trim().min(1).max(300) }),
]);
~~~

Use it optionally in remote link/update schemas. Extend `CaseInfo.remote` with selection metadata needed by the owner’s browser: profile ID/name/command preview or a custom/default marker. Do not expose foreign profile data.

- [ ] **Step 4: Apply selection in remote-case routes**

Add a small helper in `case-routes.ts` that validates profile ownership and rebuilds the RemoteCase. For profile: set ID and delete only `commands.codex`; for custom: clear ID and set `commands.codex`; for default: clear ID and delete `commands.codex`. Omit empty `commands` and undefined fields when writing JSON. Preserve remote case rename/delete and COD-343 lifecycle hooks.

- [ ] **Step 5: Resolve at session creation**

For remote case creation paths in `session-routes.ts`, obtain the request owner’s profiles and call `resolveCodexCommandSelection` before remote tmux availability checks. If unavailable, return `OPERATION_FAILED` with the helper error. Otherwise clone the remote case with resolved `commands.codex` before passing it to existing `toSessionRemote`, retaining host fallback and all SSH options.

- [ ] **Step 6: Verify GREEN and commit**

~~~bash
npm test -- test/routes/case-routes.test.ts test/routes/session-routes.test.ts test/remote-tmux-launch.test.ts test/ownership-scoping.test.ts
npm run typecheck
git diff --check
git add src/types/api.ts src/web/schemas.ts src/web/routes/case-routes.ts src/web/routes/session-routes.ts test/routes/case-routes.test.ts test/routes/session-routes.test.ts test/remote-tmux-launch.test.ts
git commit -m "feat(remote): COD-351 select Codex command profiles"
~~~

### Task 4: Build the approved selector and profile manager

**Files:**

- Modify: `src/web/public/index.html`
- Modify: `src/web/public/session-ui.js`
- Modify: `src/web/public/styles.css`
- Modify: `test/app-settings-structure.test.ts`
- Create: `test/codex-command-profiles.browser.test.ts`
- Modify: `config/test-suites.ts`

- [ ] **Step 1: Write failing structure and Chromium tests**

Require IDs `remoteCaseCodexProfile`, `remoteCaseCodexCommandCustom`, `manageCodexCommandProfiles`, and `codexCommandProfileManager`. Browser fixture must verify selector order (Default, alphabetic profiles, Custom), read-only preview, custom input, exactly one selection save, manager create, referenced update confirmation, usage display, referenced delete rejection, unused delete, rename-by-ID preservation, request-failure rollback, disabled controls while loading/saving, and a usable 390px layout.

- [ ] **Step 2: Verify RED**

~~~bash
npm test -- test/app-settings-structure.test.ts
npx vitest run --config config/vitest.browser.config.ts test/codex-command-profiles.browser.test.ts
~~~

Expected: missing controls and controller methods.

- [ ] **Step 3: Add accessible markup**

Replace the raw override field with:

~~~html
<label for="remoteCaseCodexProfile">Codex command profile</label>
<div class="codex-profile-row">
  <select id="remoteCaseCodexProfile" onchange="app.onRemoteCaseCodexProfileChanged()" disabled></select>
  <button type="button" id="manageCodexCommandProfiles" onclick="app.openCodexCommandProfileManager()">Manage</button>
</div>
<code id="remoteCaseCodexProfilePreview" class="command-profile-preview"></code>
<div id="remoteCaseCodexCommandCustomWrap" hidden>
  <label for="remoteCaseCodexCommandCustom">Custom Codex command</label>
  <input id="remoteCaseCodexCommandCustom" type="text" maxlength="300" autocomplete="off" autocapitalize="off" spellcheck="false">
</div>
~~~

Add a keyboard-accessible manager dialog with list, New, profile editor, usage case names, Save, Delete, close, and confirmation controls. Render server strings through `textContent` and `new Option()`.

- [ ] **Step 4: Implement one UI controller model**

Maintain `_codexCommandProfiles`, `_codexCommandProfileRequest`, and `_confirmedRemoteCodexSelection`. `loadCodexCommandProfiles()` GETs profiles, ignores stale responses, and leaves controls disabled/cleared on load failure. `readRemoteCaseCodexSelection()` emits exactly default, profile+ID, or custom+command. Link/update case calls use that payload instead of raw Codex commands for profile/default.

The manager POSTs/PUTs/DELETEs profile APIs. An update response requiring confirmation renders its usage count, then resubmits only after explicit confirmation. A deletion conflict displays returned case names. On every failure restore last confirmed case selection, re-enable safe controls, and show an error toast.

- [ ] **Step 5: Add scoped responsive styles**

Scope all new styles to the remote-case form and profile manager. At 390px selector/manage button wrap, preview wraps without overflow, list/editor stack, and disabled/delete states remain legible. Do not change rail, terminal, or general settings geometry.

- [ ] **Step 6: Verify GREEN and commit**

~~~bash
npm test -- test/app-settings-structure.test.ts test/run-mode-ui.test.ts
npx vitest run --config config/vitest.browser.config.ts test/codex-command-profiles.browser.test.ts
npm run check:frontend-syntax
git diff --check
git add src/web/public/index.html src/web/public/session-ui.js src/web/public/styles.css test/app-settings-structure.test.ts test/codex-command-profiles.browser.test.ts config/test-suites.ts
git commit -m "feat(ui): COD-351 manage Codex command profiles"
~~~

### Task 5: Release metadata and verification

**Files:**

- Create: `.changeset/cod-351-saved-codex-profiles.md`
- Modify: `docs/superpowers/plans/2026-08-21-cod-351-saved-codex-command-profiles.md` only to check completed boxes.

- [x] **Step 1: Add the changeset**

~~~md
---
'aicodeman': patch
---

Add reusable private Codex command profiles for remote cases.
~~~

- [x] **Step 2: Run focused suites**

~~~bash
npm test -- test/state-store.test.ts test/codex-command-profiles.test.ts test/remote-hosts.test.ts test/routes/codex-command-profile-routes.test.ts test/routes/case-routes.test.ts test/routes/session-routes.test.ts test/remote-tmux-launch.test.ts test/ownership-scoping.test.ts test/app-settings-structure.test.ts test/run-mode-ui.test.ts
npx vitest run --config config/vitest.browser.config.ts test/codex-command-profiles.browser.test.ts
~~~

- [x] **Step 3: Run static/build gates**

~~~bash
npm run typecheck
npm run lint
npm run format:check
npm run check:lockfile
npm run check:frontend-syntax
npm run check:browser-excludes
npm run build
git diff --check
~~~

- [x] **Step 4: Run isolated smoke**

~~~bash
node /home/ubuntu/.codex/skills/codeman-prod-realistic-smoke/scripts/run-codeman-prod-smoke.mjs --skip-claude
~~~

Record summary, artifacts, console/page errors, long-scrollback result, and cleanup. Do not use `--base`.

- [x] **Step 5: Commit metadata**

~~~bash
git add .changeset/cod-351-saved-codex-profiles.md docs/superpowers/plans/2026-08-21-cod-351-saved-codex-command-profiles.md
git commit -m "chore: COD-351 document command profile release"
~~~

### Task 6: Review, merge, deploy, and accept on LAN

- [ ] **Step 1: Final reviews and integration**

Request independent specification and quality review of `origin/local..HEAD`. Fetch `origin local`; if it moved, merge it into the feature worktree, preserve both behaviors, rerun affected gates, and repeat review. Preserve the root checkout’s unrelated dirty state.

- [ ] **Step 2: Merge and push**

~~~bash
git merge --no-ff COD-351-saved-codex-profiles -m "merge: COD-351 add saved Codex command profiles"
git push origin local
~~~

Confirm local and Bitbucket `origin/local` resolve to the merge. Never push `upstream`.

- [ ] **Step 3: Guarded deploy and live acceptance**

~~~bash
CODEMAN_SYNC_REMOTE_REF=origin/local \
CODEMAN_SYNC_SERVICE=codeman-web \
CODEMAN_SYNC_HEALTH_URL=http://127.0.0.1:3002/ \
/home/ubuntu/.codex/skills/sync-origin-local-deploy/scripts/sync_origin_local_deploy.sh
~~~

If the immediate probe races startup, retain it and independently verify active service, listener, logs, and five local plus five LAN HTTP 200 probes.

At `http://192.168.20.66:3002`, create a private profile; select it for a disposable remote case; verify the selection in a second browser context; verify remote launch uses the profile command; edit it with confirmation; verify changed command; verify referenced delete is blocked; reassign the disposable case; delete the unused profile; and clean up only disposable acceptance resources. Verify zero serious browser errors, active service, and live asset hashes. Comment on COD-351 with evidence, then move it to Done.
