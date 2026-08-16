/** @fileoverview Startup restoration must gate destructive tab-layout reconciliation. */
import { describe, expect, it, vi } from 'vitest';
import { WebServer } from '../src/web/server.js';

describe('tab layout restore gate', () => {
  it('does not unlock pruning, cleanup stale state, or reconcile after a failed restore', async () => {
    const markRestorationComplete = vi.fn();
    const reconcileAfterRestoration = vi.fn(async () => {});
    const cleanupStaleSessions = vi.fn(async () => 0);
    const server = Object.create(WebServer.prototype) as {
      tabLayouts: {
        markRestorationComplete: typeof markRestorationComplete;
        reconcileAfterRestoration: typeof reconcileAfterRestoration;
      };
      cleanupStaleSessions: typeof cleanupStaleSessions;
      mux: { reconcileSessions(): Promise<never> };
      restoreMuxSessions(): Promise<boolean>;
      finalizeRestoredState(restored: boolean): Promise<void>;
    };
    server.tabLayouts = { markRestorationComplete, reconcileAfterRestoration };
    server.cleanupStaleSessions = cleanupStaleSessions;
    server.mux = { reconcileSessions: vi.fn(async () => Promise.reject(new Error('mux unavailable'))) };
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    const restored = await server.restoreMuxSessions();
    await server.finalizeRestoredState(restored);

    expect(restored).toBe(false);
    expect(markRestorationComplete).not.toHaveBeenCalled();
    expect(cleanupStaleSessions).not.toHaveBeenCalled();
    expect(reconcileAfterRestoration).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith('[Server] Failed to restore mux sessions:', expect.any(Error));
  });
});
