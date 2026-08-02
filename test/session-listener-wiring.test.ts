import { describe, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { createSessionListeners } from '../src/web/session-listener-wiring.js';
import { SseEvent } from '../src/web/sse-events.js';

describe('session listener wiring', () => {
  it('forwards the attachment request source through registerAttachment', async () => {
    const session = new Session({ id: 'wiring-attach-source-test', workingDir: '/tmp', mode: 'codex' });
    const registerAttachment = vi.fn(async () => undefined);
    const deps = { registerAttachment } as unknown as Parameters<typeof createSessionListeners>[1];

    const refs = createSessionListeners(session, deps);
    refs.attachmentRequested({ path: '/tmp/mockup.png', source: 'codex-generated' });
    refs.attachmentRequested({ path: '/tmp/report.pdf', source: 'external' });

    expect(registerAttachment).toHaveBeenNthCalledWith(
      1,
      'wiring-attach-source-test',
      '/tmp/mockup.png',
      'codex-generated'
    );
    expect(registerAttachment).toHaveBeenNthCalledWith(2, 'wiring-attach-source-test', '/tmp/report.pdf', 'external');
  });

  it('forwards one checkpoint progress payload to session:checkpoint', () => {
    const session = new Session({ id: 'wiring-checkpoint-test', workingDir: '/tmp', mode: 'codex' });
    const broadcast = vi.fn();
    const broadcastSessionStateDebounced = vi.fn();
    const persistSessionState = vi.fn();
    const deps = {
      broadcast,
      broadcastSessionStateDebounced,
      persistSessionState,
      registerAttachment: vi.fn(),
    } as unknown as Parameters<typeof createSessionListeners>[1];
    const refs = createSessionListeners(session, deps);

    refs.checkpointProgress({
      mode: 'compact',
      phase: 'failed',
      step: 'continue',
      attempt: 2,
      stage: 'enter',
      reason: 'continuation-delivery-failed',
      updatedAt: 123,
    });

    expect(broadcast).toHaveBeenCalledWith(SseEvent.SessionCheckpoint, {
      sessionId: 'wiring-checkpoint-test',
      mode: 'compact',
      phase: 'failed',
      step: 'continue',
      attempt: 2,
      stage: 'enter',
      reason: 'continuation-delivery-failed',
      updatedAt: 123,
    });
    expect(broadcastSessionStateDebounced).toHaveBeenCalledWith('wiring-checkpoint-test');
    expect(persistSessionState).toHaveBeenCalledWith(session);
  });

  it("preserves the legacy session:checkpoint phase:'start' payload without persisting twice", () => {
    const session = new Session({ id: 'wiring-checkpoint-start-test', workingDir: '/tmp', mode: 'codex' });
    const broadcast = vi.fn();
    const persistSessionState = vi.fn();
    const deps = {
      broadcast,
      broadcastSessionStateDebounced: vi.fn(),
      persistSessionState,
      registerAttachment: vi.fn(),
    } as unknown as Parameters<typeof createSessionListeners>[1];
    const refs = createSessionListeners(session, deps);

    refs.checkpointStart({ mode: 'new', runId: 'new-run' });

    expect(broadcast).toHaveBeenCalledWith(SseEvent.SessionCheckpoint, {
      sessionId: 'wiring-checkpoint-start-test',
      phase: 'start',
      mode: 'new',
      runId: 'new-run',
    });
    expect(persistSessionState).not.toHaveBeenCalled();
  });
});
