# COD-364 Keyboard-only Checkpoint Takeover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent mouse and focus terminal reports from cancelling active checkpoints while preserving fail-closed cancellation for every keyboard-bearing input.

**Architecture:** A pure server-side tokenizer classifies an input payload as keyboard-bearing unless every byte is consumed as an allowlisted mouse or focus report. Both terminal input routes use the predicate immediately before their existing cancellation boundary; `Session` exposes checkpoint activity only for safe, truthful cancellation diagnostics.

**Tech Stack:** TypeScript ESM, Fastify, WebSocket, Vitest.

---

## File map

- Create `src/terminal-input-classifier.ts`: pure report tokenizer and keyboard predicate.
- Create `test/terminal-input-classifier.test.ts`: table-driven parser coverage.
- Modify `src/session.ts`: expose read-only checkpoint activity.
- Modify `test/codex-working-detection.test.ts`: pin the new `Session` projection.
- Modify `src/web/routes/ws-routes.ts`: conditionally cancel applied WebSocket input.
- Modify `test/routes/ws-routes.test.ts`: prove keyboard, report-only, mixed, and duplicate behavior.
- Modify `src/web/routes/session-routes.ts`: conditionally cancel non-duplicate HTTP input.
- Modify `test/routes/session-routes.test.ts`: prove parity with WebSocket input.

### Task 1: Add the pure terminal-input classifier

**Files:**
- Create: `test/terminal-input-classifier.test.ts`
- Create: `src/terminal-input-classifier.ts`

- [ ] **Step 1: Write the failing classifier tests**

```ts
import { describe, expect, it } from 'vitest';
import { isKeyboardTerminalInput } from '../src/terminal-input-classifier.js';

describe('isKeyboardTerminalInput', () => {
  it.each([
    ['focus in', '\x1b[I'],
    ['focus out', '\x1b[O'],
    ['SGR press', '\x1b[<0;10;5M'],
    ['SGR release', '\x1b[<0;10;5m'],
    ['SGR wheel', '\x1b[<64;999;1000M'],
    ['X10 mouse', '\x1b[M !!'],
    ['coalesced reports', '\x1b[<0;10;5M\x1b[O\x1b[M !!'],
  ])('classifies %s as report-only', (_name, data) => {
    expect(isKeyboardTerminalInput(data)).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['text', 'continue'],
    ['paste', 'git status'],
    ['Enter', '\r'],
    ['Escape', '\x1b'],
    ['arrow', '\x1b[A'],
    ['control key', '\x03'],
    ['truncated SGR', '\x1b[<0;10;5'],
    ['truncated X10', '\x1b[M !'],
    ['report then text', '\x1b[<0;10;5Mx'],
    ['text then report', 'x\x1b[<0;10;5M'],
    ['report then Enter', '\x1b[O\r'],
  ])('classifies %s as keyboard-bearing', (_name, data) => {
    expect(isKeyboardTerminalInput(data)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the classifier test and verify RED**

Run:

```bash
npm test -- test/terminal-input-classifier.test.ts
```

Expected: FAIL because `src/terminal-input-classifier.ts` does not exist.

- [ ] **Step 3: Implement the minimal all-bytes-consumed parser**

```ts
const FOCUS_REPORT_LENGTH = 3;
const X10_REPORT_LENGTH = 6;
const SGR_MOUSE_REPORT = /^\x1b\[<\d+;\d+;\d+[Mm]/;

function terminalReportLengthAt(data: string, offset: number): number {
  const rest = data.slice(offset);
  if (rest.startsWith('\x1b[I') || rest.startsWith('\x1b[O')) return FOCUS_REPORT_LENGTH;
  const sgr = SGR_MOUSE_REPORT.exec(rest);
  if (sgr) return sgr[0].length;
  if (rest.startsWith('\x1b[M') && rest.length >= X10_REPORT_LENGTH) return X10_REPORT_LENGTH;
  return 0;
}

export function isKeyboardTerminalInput(data: string): boolean {
  if (data.length === 0) return true;
  let offset = 0;
  while (offset < data.length) {
    const reportLength = terminalReportLengthAt(data, offset);
    if (reportLength === 0) return true;
    offset += reportLength;
  }
  return false;
}
```

- [ ] **Step 4: Run the classifier test and verify GREEN**

Run:

```bash
npm test -- test/terminal-input-classifier.test.ts
```

Expected: 1 file passes with all classifier cases green.

- [ ] **Step 5: Commit the classifier**

```bash
git add -- src/terminal-input-classifier.ts test/terminal-input-classifier.test.ts
git commit -m "fix(input): COD-364 classify keyboard takeover bytes"
```

### Task 2: Expose active checkpoint state for truthful diagnostics

**Files:**
- Modify: `test/codex-working-detection.test.ts`
- Modify: `src/session.ts`

- [ ] **Step 1: Write a failing projection test**

Add a focused test beside the existing `Session.requestCheckpoint()` tests:

```ts
it('projects whether checkpoint automation is active', async () => {
  const session = new Session({ workingDir: '/tmp', mode: 'codex' });
  session.setCheckpoint(true, ['new']);
  expect(session.isCheckpointActive).toBe(false);

  session.requestCheckpoint({ mode: 'new' });
  expect(session.isCheckpointActive).toBe(true);

  session.cancelCheckpoint('manual-takeover');
  expect(session.isCheckpointActive).toBe(false);
  await session.stop();
});
```

Use the file's existing real `Session` import rather than introducing a mock-only assertion.

- [ ] **Step 2: Run the named test and verify RED**

Run:

```bash
npm test -- test/codex-working-detection.test.ts -t "projects whether checkpoint automation is active"
```

Expected: FAIL because `Session.isCheckpointActive` is undefined.

- [ ] **Step 3: Add the read-only projection**

Add beside `checkpointState` in `src/session.ts`:

```ts
/** Whether an agent-initiated checkpoint handoff is currently active. */
get isCheckpointActive(): boolean {
  return this._autoOps.isCheckpointActive;
}
```

- [ ] **Step 4: Run the named test and full checkpoint file**

Run:

```bash
npm test -- test/codex-working-detection.test.ts
```

Expected: all checkpoint tests pass.

- [ ] **Step 5: Commit the projection**

```bash
git add -- src/session.ts test/codex-working-detection.test.ts
git commit -m "fix(checkpoint): COD-364 expose active takeover state"
```

### Task 3: Apply keyboard-only cancellation to WebSocket input

**Files:**
- Modify: `test/mocks/mock-session.ts`
- Modify: `test/routes/ws-routes.test.ts`
- Modify: `src/web/routes/ws-routes.ts`

- [ ] **Step 1: Extend the mock with checkpoint activity**

Add a mutable property that mirrors the production getter for route tests:

```ts
isCheckpointActive = false;
```

- [ ] **Step 2: Write failing WebSocket route regressions**

Add under `describe('client input')`:

```ts
it.each(['\x1b[I', '\x1b[<0;10;5M', '\x1b[M !!'])('forwards report-only input without takeover', async (input) => {
  const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
  try {
    const session = ctx._session;
    session.isCheckpointActive = true;
    ws.send(JSON.stringify({ t: 'i', d: input }));
    await vi.waitFor(() => expect(session.writeBuffer).toContain(input));
    expect(session.cancelCheckpoint).not.toHaveBeenCalled();
  } finally {
    ws.close();
  }
});

it('cancels for mixed report and keyboard input', async () => {
  const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
  try {
    const session = ctx._session;
    session.isCheckpointActive = true;
    const input = '\x1b[<0;10;5Mx';
    ws.send(JSON.stringify({ t: 'i', d: input }));
    await vi.waitFor(() => expect(session.writeBuffer).toContain(input));
    expect(session.cancelCheckpoint).toHaveBeenCalledWith('manual-takeover');
  } finally {
    ws.close();
  }
});
```

Also strengthen the existing duplicate test with:

```ts
expect(session.cancelCheckpoint).not.toHaveBeenCalled();
```

Strengthen the existing keyboard-forwarding test by setting `session.isCheckpointActive = true`, spying on
`console.info`, and asserting the safe diagnostic exactly:

```ts
expect(info).toHaveBeenCalledWith('[Checkpoint] manual takeover', {
  sessionId: 'ws-test-session',
  route: 'ws',
  inputClass: 'keyboard',
});
expect(JSON.stringify(info.mock.calls)).not.toContain('ls -la');
```

- [ ] **Step 3: Run WebSocket tests and verify RED**

Run outside the restricted sandbox because the suite binds `127.0.0.1:3170`:

```bash
npm test -- test/routes/ws-routes.test.ts
```

Expected: report-only cases FAIL because they still cancel the checkpoint.

- [ ] **Step 4: Implement conditional cancellation and safe logging**

Import `isKeyboardTerminalInput`, then replace the unconditional cancellation inside `if (apply)`:

```ts
if (isKeyboardTerminalInput(msg.d)) {
  if (session.isCheckpointActive) {
    console.info('[Checkpoint] manual takeover', { sessionId: id, route: 'ws', inputClass: 'keyboard' });
  }
  session.cancelCheckpoint('manual-takeover');
}
```

Do not move deduplication, acknowledgement, or write ordering.

- [ ] **Step 5: Run WebSocket tests and verify GREEN**

Run:

```bash
npm test -- test/routes/ws-routes.test.ts
```

Expected: all WebSocket route tests pass.

- [ ] **Step 6: Commit WebSocket integration**

```bash
git add -- src/web/routes/ws-routes.ts test/routes/ws-routes.test.ts test/mocks/mock-session.ts
git commit -m "fix(ws): COD-364 preserve checkpoint on terminal reports"
```

### Task 4: Apply the same policy to HTTP fallback input

**Files:**
- Modify: `test/routes/session-routes.test.ts`
- Modify: `src/web/routes/session-routes.ts`

- [ ] **Step 1: Write failing HTTP route regressions**

Add under `describe('POST /api/sessions/:id/input')`:

```ts
it.each(['\x1b[O', '\x1b[<64;10;5M', '\x1b[M !!'])('forwards report-only input without takeover', async (input) => {
  const session = harness.ctx._session;
  session.isCheckpointActive = true;
  const res = await harness.app.inject({
    method: 'POST',
    url: `/api/sessions/${harness.ctx._sessionId}/input`,
    payload: { input },
  });
  expect(res.statusCode).toBe(200);
  expect(session.writeBuffer).toContain(input);
  expect(session.cancelCheckpoint).not.toHaveBeenCalled();
});

it('cancels for mixed report and keyboard input', async () => {
  const session = harness.ctx._session;
  session.isCheckpointActive = true;
  const input = '\x1b[Ox';
  const res = await harness.app.inject({
    method: 'POST',
    url: `/api/sessions/${harness.ctx._sessionId}/input`,
    payload: { input },
  });
  expect(res.statusCode).toBe(200);
  expect(session.cancelCheckpoint).toHaveBeenCalledWith('manual-takeover');
});
```

Strengthen the existing tagged redelivery test by clearing the cancellation mock before the duplicate and asserting that the
duplicate does not add a cancellation call.

Strengthen the existing keyboard-input test with an active checkpoint and the HTTP diagnostic assertion:

```ts
expect(info).toHaveBeenCalledWith('[Checkpoint] manual takeover', {
  sessionId: harness.ctx._sessionId,
  route: 'http',
  inputClass: 'keyboard',
});
expect(JSON.stringify(info.mock.calls)).not.toContain('hello');
```

- [ ] **Step 2: Run the named HTTP tests and verify RED**

Run:

```bash
npm test -- test/routes/session-routes.test.ts -t "report-only input|mixed report and keyboard input"
```

Expected: report-only cases FAIL because the route still cancels unconditionally.

- [ ] **Step 3: Implement HTTP parity without changing duplicate behavior**

Import `isKeyboardTerminalInput`, then replace the unconditional cancellation after duplicate detection:

```ts
if (!duplicate && isKeyboardTerminalInput(inputStr)) {
  if (session.isCheckpointActive) {
    console.info('[Checkpoint] manual takeover', { sessionId: id, route: 'http', inputClass: 'keyboard' });
  }
  session.cancelCheckpoint('manual-takeover');
}
```

This must remain before waiter registration and the write so genuine keyboard takeover stays atomic.

- [ ] **Step 4: Run the HTTP route file and verify GREEN**

Run:

```bash
npm test -- test/routes/session-routes.test.ts
```

Expected: all session route tests pass.

- [ ] **Step 5: Commit HTTP integration**

```bash
git add -- src/web/routes/session-routes.ts test/routes/session-routes.test.ts
git commit -m "fix(input): COD-364 align HTTP checkpoint takeover"
```

### Task 5: Verify the complete change

**Files:**
- Verify all changed source, tests, spec, and plan.

- [ ] **Step 1: Run focused behavioral coverage**

```bash
npm test -- test/terminal-input-classifier.test.ts test/routes/ws-routes.test.ts test/routes/session-routes.test.ts test/session-checkpoint.test.ts test/codex-working-detection.test.ts test/mobile-shell-keyboard.test.ts
```

Expected: all files and tests pass with zero failures.

- [ ] **Step 2: Run repository quality checks**

```bash
npm run typecheck
npm run lint
npm run format:check
npm run check:lockfile
npm run build
```

Expected: every command exits zero.

- [ ] **Step 3: Inspect final scope**

```bash
git status --short
git diff local...HEAD --check
git diff local...HEAD --stat
```

Expected: only COD-364 design, plan, classifier, route, session projection, and focused test files differ; no whitespace errors.

- [ ] **Step 4: Record verification on COD-364**

Use the local Jira CLI with the work profile to add the branch, commit list, exact commands, and pass counts. Do not mark the
issue Done until integration/PR policy is satisfied.
