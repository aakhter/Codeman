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
const SETTINGS_SOURCE = readFileSync(resolve(import.meta.dirname, '../src/web/public/settings-ui.js'), 'utf8');

type ApprovalItem = {
  id: string;
  sessionId: string;
  kind: 'idle' | 'permission' | 'question';
  mode?: 'codex';
  acknowledgedAt?: number;
};

type ApprovalsApp = {
  approvals: Map<string, ApprovalItem>;
  _onApprovalPending: (item: ApprovalItem) => void;
  _onApprovalUpdated: (item: ApprovalItem) => void;
  _onApprovalResolved: (item: ApprovalItem & { sourceSequence?: number }) => void;
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

function loadSettingsPrototype(): object {
  const context = vm.createContext({ CodemanApp: class CodemanApp {} });
  vm.runInContext(`${SETTINGS_SOURCE}\nglobalThis.__settingsPrototype = CodemanApp.prototype;`, context, {
    filename: 'settings-ui.js',
  });
  return (context as { __settingsPrototype: object }).__settingsPrototype;
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

describe('sequence-safe hook and approval resolution', () => {
  it('does not let an older stop hook blanket-clear a newer permission or question', () => {
    const app = Object.create(loadSettingsPrototype()) as Record<string, any>;
    app.clearPendingHooks = vi.fn();
    app._notifySession = vi.fn();

    app._onHookStop({ sessionId: 'session-1', sourceSequence: 10 });

    expect(app.clearPendingHooks).not.toHaveBeenCalled();
    expect(app._notifySession).toHaveBeenCalledOnce();
  });

  it('lets the authoritative stale-idle resolution clear only idle_prompt state', () => {
    const app = makeApp() as ApprovalsApp & { clearPendingHooks: ReturnType<typeof vi.fn> };
    app.clearPendingHooks = vi.fn();
    app.approvals.set('permission-new', {
      id: 'permission-new',
      sessionId: 'session-1',
      kind: 'permission',
    });

    app._onApprovalResolved({ id: 'idle-old', sessionId: 'session-1', kind: 'idle', sourceSequence: 10 });

    expect(app.clearPendingHooks).toHaveBeenCalledOnce();
    expect(app.clearPendingHooks).toHaveBeenCalledWith('session-1', 'idle_prompt');
    expect(app.clearPendingHooks).not.toHaveBeenCalledWith('session-1', 'permission_prompt');
    expect(app.clearPendingHooks).not.toHaveBeenCalledWith('session-1', 'elicitation_dialog');
  });

  it('does not let a stale resolution clear a newer approval of the same kind', () => {
    const app = makeApp() as ApprovalsApp & { clearPendingHooks: ReturnType<typeof vi.fn> };
    app.clearPendingHooks = vi.fn();
    app.approvals.set('idle-new', {
      id: 'idle-new',
      sessionId: 'session-1',
      kind: 'idle',
    });

    app._onApprovalResolved({ id: 'idle-old', sessionId: 'session-1', kind: 'idle', sourceSequence: 10 });

    expect(app.clearPendingHooks).not.toHaveBeenCalled();
    expect(app.approvals.has('idle-new')).toBe(true);
  });

  it('does not let a stale acknowledgement clear a newer approval of the same kind', () => {
    const app = makeApp() as ApprovalsApp & { clearPendingHooks: ReturnType<typeof vi.fn> };
    app.clearPendingHooks = vi.fn();
    app.approvals.set('idle-new', {
      id: 'idle-new',
      sessionId: 'session-1',
      kind: 'idle',
    });

    app._onApprovalUpdated({
      id: 'idle-old',
      sessionId: 'session-1',
      kind: 'idle',
      acknowledgedAt: 20,
    });

    expect(app.clearPendingHooks).not.toHaveBeenCalled();
    expect(app.approvals.has('idle-new')).toBe(true);
  });

  it('has no legacy handler for hook:suppressed diagnostics', () => {
    const app = Object.create(loadSettingsPrototype()) as Record<string, any>;
    app.setPendingHook = vi.fn();
    app.clearPendingHooks = vi.fn();
    app._notifySession = vi.fn();

    app._onHookSuppressed?.({ sessionId: 'session-1', hookEvent: 'idle_prompt' });

    expect(app.setPendingHook).not.toHaveBeenCalled();
    expect(app.clearPendingHooks).not.toHaveBeenCalled();
    expect(app._notifySession).not.toHaveBeenCalled();
  });
});
