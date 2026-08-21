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
import { ApprovalInbox, type ApprovalResolvedInfo } from '../src/web/approval-inbox.js';

const SOURCE = readFileSync(resolve(import.meta.dirname, '../src/web/public/approvals-ui.js'), 'utf8');
const SETTINGS_SOURCE = readFileSync(resolve(import.meta.dirname, '../src/web/public/settings-ui.js'), 'utf8');

type ApprovalItem = {
  id: string;
  sessionId: string;
  kind: 'idle' | 'permission' | 'question';
  mode?: 'codex';
  acknowledgedAt?: number;
  sourceSequence?: number;
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

function approvalHook(kind: ApprovalItem['kind']) {
  return kind === 'permission' ? 'permission_prompt' : kind === 'question' ? 'elicitation_dialog' : 'idle_prompt';
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

  it.each(['idle', 'permission', 'question'] as const)(
    'does not let an older %s resolution clear a newer same-kind approval',
    (kind) => {
      const app = makeApp() as ApprovalsApp & { clearPendingHooks: ReturnType<typeof vi.fn> };
      app.clearPendingHooks = vi.fn();
      app.approvals.set('current', {
        id: 'current',
        sessionId: 'session-1',
        kind,
        sourceSequence: 20,
      });

      app._onApprovalResolved({ id: 'different-id', sessionId: 'session-1', kind, sourceSequence: 10 });

      expect(app.clearPendingHooks).not.toHaveBeenCalled();
      expect(app.approvals.has('current')).toBe(true);
    }
  );

  it.each(['idle', 'permission', 'question'] as const)(
    'lets a newer %s resolution clear an older same-kind local approval',
    (kind) => {
      const app = makeApp() as ApprovalsApp & { clearPendingHooks: ReturnType<typeof vi.fn> };
      app.clearPendingHooks = vi.fn();
      app.approvals.set('current', {
        id: 'current',
        sessionId: 'session-1',
        kind,
        sourceSequence: 10,
      });

      app._onApprovalResolved({ id: 'different-id', sessionId: 'session-1', kind, sourceSequence: 20 });

      expect(app.clearPendingHooks).toHaveBeenCalledWith('session-1', approvalHook(kind));
      expect(app.approvals.has('current')).toBe(false);
    }
  );

  it.each(['idle', 'permission', 'question'] as const)(
    'does not let an older %s acknowledgement clear a newer same-kind approval',
    (kind) => {
      const app = makeApp() as ApprovalsApp & { clearPendingHooks: ReturnType<typeof vi.fn> };
      app.clearPendingHooks = vi.fn();
      app.approvals.set('current', {
        id: 'current',
        sessionId: 'session-1',
        kind,
        sourceSequence: 20,
      });

      app._onApprovalUpdated({
        id: 'different-id',
        sessionId: 'session-1',
        kind,
        sourceSequence: 10,
        acknowledgedAt: 30,
      });

      expect(app.clearPendingHooks).not.toHaveBeenCalled();
      expect(app.approvals.has('current')).toBe(true);
    }
  );

  it.each(['idle', 'permission', 'question'] as const)(
    'lets a newer %s acknowledgement clear and replace an older same-kind local approval',
    (kind) => {
      const app = makeApp() as ApprovalsApp & { clearPendingHooks: ReturnType<typeof vi.fn> };
      app.clearPendingHooks = vi.fn();
      app.approvals.set('current', {
        id: 'current',
        sessionId: 'session-1',
        kind,
        sourceSequence: 10,
      });

      app._onApprovalUpdated({
        id: 'different-id',
        sessionId: 'session-1',
        kind,
        sourceSequence: 20,
        acknowledgedAt: 30,
      });

      expect(app.clearPendingHooks).toHaveBeenCalledWith('session-1', approvalHook(kind));
      expect(app.approvals.has('current')).toBe(false);
      expect(app.approvals.get('different-id')).toMatchObject({ sourceSequence: 20, acknowledgedAt: 30 });
    }
  );

  it('uses exact item identity as the safe fallback when legacy events have no source sequence', () => {
    const app = makeApp() as ApprovalsApp & { clearPendingHooks: ReturnType<typeof vi.fn> };
    app.clearPendingHooks = vi.fn();
    app.approvals.set('current', { id: 'current', sessionId: 'session-1', kind: 'idle' });

    app._onApprovalResolved({ id: 'different-id', sessionId: 'session-1', kind: 'idle' });
    expect(app.clearPendingHooks).not.toHaveBeenCalled();
    expect(app.approvals.has('current')).toBe(true);

    app._onApprovalResolved({ id: 'current', sessionId: 'session-1', kind: 'idle' });
    expect(app.clearPendingHooks).toHaveBeenCalledWith('session-1', 'idle_prompt');
    expect(app.approvals.has('current')).toBe(false);
  });

  it('orders browser clears from the actual inbox resolution and acknowledgement payloads', () => {
    const emitResolution = (sourceSequence: number) => {
      const inbox = new ApprovalInbox();
      let emitted: ApprovalResolvedInfo | undefined;
      inbox.onResolved = (info) => {
        emitted = info;
      };
      inbox.notePrompt({ sessionId: 'session-1', sessionName: 'One', kind: 'idle', sourceSequence });
      inbox.resolveForSession('session-1', 'resolved_in_terminal');
      return emitted!;
    };
    const app = makeApp() as ApprovalsApp & { clearPendingHooks: ReturnType<typeof vi.fn> };
    app.clearPendingHooks = vi.fn();
    app.approvals.set('current', {
      id: 'current',
      sessionId: 'session-1',
      kind: 'idle',
      sourceSequence: 20,
    });

    const olderResolution = emitResolution(10);
    expect(olderResolution).toMatchObject({ sourceSequence: 10 });
    app._onApprovalResolved(olderResolution);
    expect(app.clearPendingHooks).not.toHaveBeenCalled();

    const newerResolution = emitResolution(30);
    expect(newerResolution).toMatchObject({ sourceSequence: 30 });
    app._onApprovalResolved(newerResolution);
    expect(app.clearPendingHooks).toHaveBeenCalledWith('session-1', 'idle_prompt');

    const ackInbox = new ApprovalInbox();
    let acknowledged: ApprovalItem | undefined;
    ackInbox.onUpdated = (item) => {
      acknowledged = item;
    };
    ackInbox.notePrompt({ sessionId: 'session-2', sessionName: 'Two', kind: 'idle', sourceSequence: 40 });
    ackInbox.acknowledge('session-2');
    expect(acknowledged).toMatchObject({ sourceSequence: 40, acknowledgedAt: expect.any(Number) });
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
