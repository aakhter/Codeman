/**
 * @fileoverview COD-179 — Session emits 'resized' when PTY dims actually change,
 * and the listener wiring broadcasts it as SSE `session:resized`.
 *
 * A foreign client resizing a shared session mid-turn makes codex repaint at the
 * new geometry; other browsers' xterms (different dims) render those frames
 * misaligned (orphan "Working" rows). The broadcast lets viewers reconcile.
 *
 * Port: N/A (no server).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Session } from '../src/session.js';
import { createSessionListeners } from '../src/web/session-listener-wiring.js';
import { SseEvent } from '../src/web/sse-events.js';

describe('COD-179 session resized event', () => {
  let session: Session;

  beforeEach(() => {
    session = new Session({ workingDir: '/tmp', mode: 'codex' });
    // resize() only applies when a PTY exists — stub one.
    (session as unknown as { ptyProcess: { resize: (c: number, r: number) => void } }).ptyProcess = {
      resize: vi.fn(),
    };
  });

  afterEach(async () => {
    await session.stop();
  });

  it("emits 'resized' with the new dims when they change", () => {
    const seen: Array<{ cols: number; rows: number }> = [];
    session.on('resized', (d: { cols: number; rows: number }) => seen.push(d));

    session.resize(178, 31, { viewportType: 'desktop' });

    expect(seen).toEqual([{ cols: 178, rows: 31 }]);
  });

  it('does not emit for a no-op resize (same dims), even when forced', () => {
    session.resize(178, 31, { viewportType: 'desktop' });
    const seen: unknown[] = [];
    session.on('resized', (d) => seen.push(d));

    session.resize(178, 31, { viewportType: 'desktop' });
    session.resize(178, 31, { viewportType: 'desktop', force: true }); // force = SIGWINCH nudge, no geometry change

    expect(seen).toEqual([]);
  });

  it('does not emit when a passive viewer resize is ignored by ownership', () => {
    const owner = Symbol('owner');
    const passive = Symbol('passive');
    session.activateTerminalViewer(owner, { cols: 178, rows: 31, viewportType: 'desktop' });
    const seen: unknown[] = [];
    session.on('resized', (d) => seen.push(d));

    expect(session.resizeFromTerminalViewer(passive, 60, 20, 'mobile')).toBe(false);

    expect(seen).toEqual([]);
  });

  it('wiring broadcasts SSE session:resized with session id and dims', () => {
    const broadcast = vi.fn();
    const deps = {
      broadcast,
      batchTerminalData: vi.fn(),
      batchTaskUpdate: vi.fn(),
      broadcastSessionStateDebounced: vi.fn(),
      sendPushNotifications: vi.fn(),
      persistSessionState: vi.fn(),
      getSessionStateWithRespawn: vi.fn(),
      getRunSummaryTracker: vi.fn(),
      stopTranscriptWatcher: vi.fn(),
      cleanupSessionBatches: vi.fn(),
      cancelPersistDebounce: vi.fn(),
      removeRunSummaryTracker: vi.fn(),
      removeSessionListenerRefs: vi.fn(),
      cleanupRespawnOnExit: vi.fn(),
      getStore: vi.fn(),
      registerAttachment: vi.fn(),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const refs = createSessionListeners(session, deps as any);

    refs.resized({ cols: 200, rows: 45 });

    expect(broadcast).toHaveBeenCalledWith(SseEvent.SessionResized, { id: session.id, cols: 200, rows: 45 });
  });
});
