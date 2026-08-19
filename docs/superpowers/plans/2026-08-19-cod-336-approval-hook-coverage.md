# COD-336 Approval Hook Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add direct, test-only coverage for `_onApprovalPending()` forwarding an unacknowledged Codex idle approval to `setPendingHook()`.

**Architecture:** Evaluate the shipped `approvals-ui.js` mixin in a minimal Node VM context, instantiate its real prototype, and spy on the two app dependencies used by the handler. Keep production source unchanged and demonstrate test sensitivity with a temporary local mutation.

**Tech Stack:** TypeScript, Vitest, Node `vm`, Node filesystem APIs

---

### Task 1: Add the focused approvals UI regression

**Files:**

- Create: `test/approvals-ui-hook-propagation.test.ts`
- Verify unchanged: `src/web/public/approvals-ui.js`

- [ ] **Step 1: Create the direct-mixin test**

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const SOURCE = readFileSync(resolve(import.meta.dirname, '../src/web/public/approvals-ui.js'), 'utf8');

type ApprovalItem = {
  id: string;
  sessionId: string;
  kind: 'idle';
  mode?: 'codex';
  acknowledgedAt?: number;
};

type ApprovalsApp = {
  approvals: Map<string, ApprovalItem>;
  _onApprovalPending: (item: ApprovalItem) => void;
  setPendingHook: ReturnType<typeof vi.fn>;
  renderApprovals: ReturnType<typeof vi.fn>;
};

function loadPrototype(): object {
  const context = vm.createContext({ CodemanApp: class CodemanApp {} });
  vm.runInContext(`${SOURCE}\nglobalThis.__approvalsPrototype = CodemanApp.prototype;`, context, {
    filename: 'approvals-ui.js',
  });
  return (context as { __approvalsPrototype: object }).__approvalsPrototype;
}

function makeApp(): ApprovalsApp {
  const app = Object.create(loadPrototype()) as ApprovalsApp;
  app.approvals = new Map();
  app.setPendingHook = vi.fn();
  app.renderApprovals = vi.fn();
  return app;
}

describe('_onApprovalPending hook propagation', () => {
  it('arms the idle tab alert for an unacknowledged Codex approval', () => {
    const app = makeApp();
    const item: ApprovalItem = { id: 'approval-1', sessionId: 'session-1', kind: 'idle', mode: 'codex' };

    app._onApprovalPending(item);

    expect(app.setPendingHook).toHaveBeenCalledOnce();
    expect(app.setPendingHook).toHaveBeenCalledWith('session-1', 'idle_prompt');
  });

  it('does not re-arm an acknowledged approval', () => {
    const app = makeApp();
    const item: ApprovalItem = {
      id: 'approval-2',
      sessionId: 'session-2',
      kind: 'idle',
      mode: 'codex',
      acknowledgedAt: 1,
    };

    app._onApprovalPending(item);

    expect(app.setPendingHook).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the focused test against current production code**

Run: `npm test -- test/approvals-ui-hook-propagation.test.ts`

Expected: PASS because the covered behavior already exists.

- [ ] **Step 3: Prove regression sensitivity with a temporary mutation**

Temporarily replace this production line:

```js
if (!item.acknowledgedAt) this.setPendingHook(item.sessionId, approvalKindToHook(item.kind));
```

with:

```js
if (!item.acknowledgedAt) void approvalKindToHook(item.kind);
```

Run: `npm test -- test/approvals-ui-hook-propagation.test.ts`

Expected: FAIL only the unacknowledged case with zero `setPendingHook()` calls.

- [ ] **Step 4: Restore production source and verify GREEN**

Restore the original `setPendingHook()` line exactly.

Run: `npm test -- test/approvals-ui-hook-propagation.test.ts`

Expected: 1 file and 2 tests PASS; `git diff -- src/web/public/approvals-ui.js` is empty.

### Task 2: Verify and land the test-only change

**Files:**

- Test: `test/approvals-ui-hook-propagation.test.ts`
- Verify: `test/session-listener-wiring.test.ts`

- [ ] **Step 1: Run focused regressions**

Run: `npm test -- test/approvals-ui-hook-propagation.test.ts test/session-listener-wiring.test.ts`

Expected: both files PASS. Do not run `test/push-payload-host-title.test.ts` because its unchanged tmux probe is environment-blocked.

- [ ] **Step 2: Run repository gates**

Run:

```bash
npm run typecheck
npm run lint
npm run check:frontend-syntax
npm run check:lockfile
npx prettier --check test/approvals-ui-hook-propagation.test.ts docs/superpowers/specs/2026-08-19-cod-336-approval-hook-coverage-design.md docs/superpowers/plans/2026-08-19-cod-336-approval-hook-coverage.md
npm run build
```

Expected: all commands exit 0. Existing documented build warnings may remain unchanged.

- [ ] **Step 3: Review the final diff**

Run: `git diff --check && git status --short && git diff --stat && git diff --stat local...HEAD`

Expected: status shows only the new test and this plan correction; the branch diff contains only the committed design and plan; production source is clean. After the next commit, `git diff --stat local...HEAD` also includes the test.

- [ ] **Step 4: Commit**

```bash
git add -- docs/superpowers/specs/2026-08-19-cod-336-approval-hook-coverage-design.md docs/superpowers/plans/2026-08-19-cod-336-approval-hook-coverage.md test/approvals-ui-hook-propagation.test.ts
git commit -m "test(approvals): COD-336 cover pending hook propagation"
```

- [ ] **Step 5: Land and update Jira**

Fast-forward the verified commit into `local`, push `origin/local`, attach the structured Bitbucket commit link, post verification evidence, and transition COD-336 to Done. Production deployment is not required for a test-only change.
