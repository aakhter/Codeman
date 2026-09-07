# Per-session terminal font size Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve terminal font size independently for each Codeman session in the current host/browser profile.

**Architecture:** Keep the shared xterm instance and existing device/mode defaults. Add a validated session-specific `localStorage` key as the primary preference, retain the existing global key as a compatibility fallback, and make size writes target only the active session.

**Tech Stack:** Plain browser JavaScript, xterm.js, browser `localStorage`, Vitest VM harness.

---

### Task 1: Add the failing per-session regression coverage

**Files:**
- Modify: `test/opencode-mobile-font.test.ts:20-24, 287-420`

- [ ] **Step 1: Add a session-key helper assertion and a failing isolation test**

Extend the existing `fontStorageWrites()` helper to return all font writes unchanged, then add this test to the existing font-policy describe block:

```ts
it('keeps font sizes independent when switching between sessions', () => {
  const store = createStore();
  const loaded = loadTerminalPolicy({ deviceType: 'desktop', store });
  const app = Object.assign(Object.create(loaded.mixin), {
    activeSessionId: 'session-a',
    sessions: new Map([
      ['session-a', { mode: 'codex' }],
      ['session-b', { mode: 'codex' }],
    ]),
    terminal: { options: { fontSize: 14 } },
    fitAddon: { fit: vi.fn() },
  });

  app.applyTerminalFontPolicyForActiveSession();
  app.setFontSize(18);
  expect(app.terminal.options.fontSize).toBe(18);

  app.activeSessionId = 'session-b';
  app.applyTerminalFontPolicyForActiveSession();
  expect(app.terminal.options.fontSize).toBe(14);

  app.setFontSize(12);
  app.activeSessionId = 'session-a';
  app.applyTerminalFontPolicyForActiveSession();

  expect(app.terminal.options.fontSize).toBe(18);
  expect(store.values.get('codeman-font-size-session:session-a')).toBe('18');
  expect(store.values.get('codeman-font-size-session:session-b')).toBe('12');
});
```

- [ ] **Step 2: Run the focused test and verify the expected failure**

Run:

```bash
npm test -- test/opencode-mobile-font.test.ts -t "keeps font sizes independent"
```

Expected: FAIL because the current implementation writes and reads the shared `codeman-font-size` key, so session B and session A cannot retain different values.

### Task 2: Implement session-scoped font storage

**Files:**
- Modify: `src/web/public/terminal-ui.js:286-320, 6963-7007`

- [ ] **Step 1: Add a safe session-specific key resolver**

Add a constant and pure helper beside `resolveTerminalFontSize()`:

```js
const TERMINAL_FONT_SIZE_SESSION_KEY_PREFIX = 'codeman-font-size-session:';

function resolveTerminalFontSizeSessionKey(sessionId, fallbackKey) {
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  return normalizedSessionId ? `${TERMINAL_FONT_SIZE_SESSION_KEY_PREFIX}${normalizedSessionId}` : fallbackKey;
}
```

Keep `resolveTerminalFontSize()` unchanged so its existing device/mode key and validation tests remain valid.

- [ ] **Step 2: Make policy reads prefer the active session key**

Replace `getTerminalFontPolicy()` with the following behavior:

```js
getTerminalFontPolicy(mode, { performanceFallback = false } = {}) {
  const activeMode = mode ?? this.sessions?.get?.(this.activeSessionId)?.mode;
  const deviceType =
    typeof MobileDetection !== 'undefined' && MobileDetection.getDeviceType
      ? MobileDetection.getDeviceType()
      : 'desktop';
  const unresolved = window.CodemanTerminalFont.resolveSize({
    deviceType,
    mode: activeMode,
    stored: null,
    performanceFallback,
  });
  const key = resolveTerminalFontSizeSessionKey(this.activeSessionId, unresolved.key);
  let stored = null;
  try {
    stored = localStorage.getItem(key);
    if (stored === null && key !== unresolved.key) stored = localStorage.getItem(unresolved.key);
  } catch {}
  return {
    ...window.CodemanTerminalFont.resolveSize({
      deviceType,
      mode: activeMode,
      stored,
      performanceFallback,
    }),
    key,
  };
},
```

This preserves the legacy global key as a read-only fallback while making the returned `key` the active session key whenever a valid session ID exists.

- [ ] **Step 3: Run the regression test and the existing font tests**

Run:

```bash
npm test -- test/opencode-mobile-font.test.ts -t "keeps font sizes independent|stores direct and decrement changes|restores independent values"
```

Expected: PASS for the new isolation test and the existing storage tests, with no failure caused by the new session key.

### Task 3: Cover compatibility, storage failure, and session switching

**Files:**
- Modify: `test/opencode-mobile-font.test.ts:287-930`

- [ ] **Step 1: Add tests for legacy fallback and no-session writes**

Add focused assertions that:

```ts
it('uses the legacy global font value for an uncustomized session', () => {
  const harness = createApp('desktop', { 'codeman-font-size': '16' }, 'codex');
  harness.app.applyTerminalFontPolicyForActiveSession();
  expect(harness.app.terminal.options.fontSize).toBe(16);
  expect(harness.store.setItem).not.toHaveBeenCalled();
});
```

Also retain the existing resolver tests for device/mode defaults and update only expectations that assert a write key: active sessions should now expect `codeman-font-size-session:<id>`.

- [ ] **Step 2: Add the actual `selectSession()` switch assertion**

Use the existing `loadIntegratedApp()` and `makeSelectionApp()` harness to set distinct session-specific values before switching, then assert the selection path applies the target value before the first fit/resize. The test must exercise `app.selectSession()` rather than only mutating `activeSessionId`:

```ts
it('restores the selected session font before the first fit', async () => {
  const integrated = loadIntegratedApp(
    createStore({
      'codeman-font-size-session:s0': '18',
      'codeman-font-size-session:s1': '12',
    })
  );
  const order: string[] = [];
  const app = makeSelectionApp(integrated.CodemanApp, order, 's0');
  app.fitAddon.fit = vi.fn(() => order.push(`fit:${app.terminal.options.fontSize}`));

  await app.selectSession('s1');

  expect(app.terminal.options.fontSize).toBe(12);
  expect(order).toContain('fit:12');
});
```

- [ ] **Step 3: Add storage-read failure coverage for session keys**

Extend the existing storage failure harness so `getItem()` throws and assert policy resolution returns the validated fallback without throwing. The existing write-failure test should also assert the live size changes while the failing write is attempted.

- [ ] **Step 4: Run the focused suite**

Run:

```bash
npm test -- test/opencode-mobile-font.test.ts
```

Expected: all tests in the file pass.

- [ ] **Step 5: Commit the implementation and focused tests**

Run:

```bash
git add src/web/public/terminal-ui.js test/opencode-mobile-font.test.ts
git commit -m "fix(terminal): COD-428 keep font size per session"
```

### Task 4: Run repository verification

**Files:**
- No additional files; verify the implementation and tests from Tasks 1–3.

- [ ] **Step 1: Run static checks**

Run each command from the COD-428 worktree:

```bash
npm run typecheck
npm run lint
npm run format:check
npm run check:lockfile
npm run check:frontend-syntax
npm run check:public-assets
```

Expected: each command exits 0 with no errors.

- [ ] **Step 2: Run the targeted test again after static checks**

Run:

```bash
npm test -- test/opencode-mobile-font.test.ts
```

Expected: all tests in the file pass.

- [ ] **Step 3: Inspect the final diff and worktree**

Run:

```bash
git diff --check
git status --short --branch
git show --stat --oneline HEAD
```

Confirm only the intended terminal implementation and font regression test are part of the implementation commit, with no generated runtime files or credentials.

