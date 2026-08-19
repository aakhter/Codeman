/**
 * @fileoverview Direct coverage for the browser-delivered Approvals Inbox
 * mixin forwarding live Codex idle approvals into the shared tab-alert state.
 *
 * Loaded through `node:vm` with a stub `CodemanApp`, so this exercises the
 * shipped `_onApprovalPending()` implementation without launching a browser,
 * opening a port, or probing tmux.
 */
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
