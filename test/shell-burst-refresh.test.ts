/**
 * @fileoverview COD-189 — shell burst-settle healing.
 *
 * During fast output bursts tmux's attach client jump-scrolls (repaints in
 * place), so live-streamed scrollback is sparse or missing. When a shell
 * session streams > SHELL_BURST_BYTES within the window, the session must
 * emit 'needsRefresh' after output settles so clients reload from the
 * canonical capture. Fake timers; no tmux. Port: N/A.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Session } from '../src/session.js';

// A jump-scroll-shaped chunk: home repaint + payload (the detector requires
// BOTH byte volume and repeated full-screen repaints).
function track(session: Session, bytes: number, repaint = true): void {
  const chunk = (repaint ? '\x1b[H\x1b[2J' : '') + 'x'.repeat(bytes);
  (session as unknown as { _trackShellBurst(d: string): void })._trackShellBurst(chunk);
}

describe('COD-189 shell burst refresh', () => {
  let session: Session;
  let refreshes: number;

  beforeEach(() => {
    vi.useFakeTimers();
    session = new Session({ workingDir: '/tmp', mode: 'shell' });
    refreshes = 0;
    session.on('needsRefresh', () => refreshes++);
  });

  afterEach(async () => {
    await session.stop();
    vi.useRealTimers();
  });

  it('emits needsRefresh once after a large burst settles', () => {
    for (let i = 0; i < 10; i++) track(session, 16 * 1024); // 160KB burst
    expect(refreshes).toBe(0); // not during the burst
    vi.advanceTimersByTime(2_000); // settle window elapses
    expect(refreshes).toBe(1);
    vi.advanceTimersByTime(10_000);
    expect(refreshes).toBe(1); // once per burst
  });

  it('keeps re-arming while the burst continues, fires only after quiet', () => {
    for (let i = 0; i < 5; i++) track(session, 16 * 1024);
    vi.advanceTimersByTime(1_000); // still within settle
    track(session, 16 * 1024); // burst continues — re-arms
    vi.advanceTimersByTime(1_000);
    expect(refreshes).toBe(0);
    vi.advanceTimersByTime(1_000); // 1.5s quiet reached
    expect(refreshes).toBe(1);
  });

  it('small output never triggers a refresh', () => {
    for (let i = 0; i < 20; i++) {
      track(session, 1024);
      vi.advanceTimersByTime(1_000); // spread across windows
    }
    vi.advanceTimersByTime(5_000);
    expect(refreshes).toBe(0);
  });

  it('large LINEAR output without repaints never triggers (build logs are not bursts)', () => {
    for (let i = 0; i < 20; i++) track(session, 16 * 1024, false);
    vi.advanceTimersByTime(5_000);
    expect(refreshes).toBe(0);
  });
});
