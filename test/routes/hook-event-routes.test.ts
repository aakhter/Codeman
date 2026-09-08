/**
 * @fileoverview Tests for hook-event-routes route handlers.
 *
 * Uses app.inject() — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 *
 * These tests assert the UNIFORM response envelope (stable HTTP contract):
 *   success -> 2xx, { success: true, data: <payload> }
 *   error   -> 4xx/5xx, { success: false, error, errorCode }
 * The production server applies this via a preSerialization hook (server.ts).
 * The shared route harness doesn't install it, so we build a local harness here
 * that mirrors production: the same preSerialization envelope hook + the shared
 * route error handler, so assertions match the real wire format.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { ApiErrorCode, httpStatusForErrorCode } from '../../src/types.js';
import { registerHookEventRoutes } from '../../src/web/routes/hook-event-routes.js';
import { sessionWaits } from '../../src/web/session-wait-registry.js';
import { approvalInbox } from '../../src/web/approval-inbox.js';

interface LocalHarness {
  app: FastifyInstance;
  ctx: MockRouteContext;
}

/**
 * Build a Fastify instance that mirrors production's uniform-envelope behavior
 * (server.ts preSerialization hook) so the test wire format matches the contract:
 * bare payloads become { success: true, data }, and { success:false } error
 * envelopes get the conventional HTTP status from their errorCode.
 */
async function createEnvelopeHarness(
  registerFn: (app: FastifyInstance, ctx: MockRouteContext) => void
): Promise<LocalHarness> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);

  const ctx = createMockRouteContext();
  registerFn(app, ctx);

  // Mirror production uniform response envelope (server.ts).
  app.addHook('preSerialization', (req, reply, payload: unknown, done) => {
    if (!req.url.startsWith('/api')) return done(null, payload);
    if (payload === null || typeof payload !== 'object') return done(null, payload);
    if (Buffer.isBuffer(payload) || typeof (payload as { pipe?: unknown }).pipe === 'function') {
      return done(null, payload);
    }
    const p = payload as { success?: unknown; errorCode?: unknown };
    if (p.success === false) {
      if (reply.statusCode === 200 && typeof p.errorCode === 'string') {
        reply.code(httpStatusForErrorCode(p.errorCode as ApiErrorCode));
      }
      return done(null, payload);
    }
    if (p.success === true) return done(null, payload);
    return done(null, { success: true, data: payload });
  });

  installRouteErrorHandler(app);
  await app.ready();

  return { app, ctx };
}

describe('hook-event-routes', () => {
  let harness: LocalHarness;

  beforeEach(async () => {
    harness = await createEnvelopeHarness(registerHookEventRoutes);
  });

  afterEach(async () => {
    await harness.app.close();
    sessionWaits.cancelAll(harness.ctx._sessionId);
    approvalInbox.resolveForSession(harness.ctx._sessionId, 'dismissed');
    vi.restoreAllMocks();
  });

  // ========== POST /api/hook-event ==========

  describe('POST /api/hook-event', () => {
    it('adopts authoritative Claude identity from managed SessionStart without restricting source', async () => {
      const session = harness.ctx.sessions.get(harness.ctx._sessionId) as unknown as {
        claudeSessionId: string;
        activityProjection?: { activityStatus: string; activityStatusSince: number | null };
        adoptClaudeSessionStartId: ReturnType<typeof vi.fn>;
      };
      session.claudeSessionId = 'claude-old-262';
      const order: string[] = [];
      session.adoptClaudeSessionStartId = vi.fn((id: string) => {
        session.claudeSessionId = id;
        order.push('adopt');
      });
      harness.ctx.agentActivity.identityChanged.mockImplementation(() => {
        session.activityProjection = { activityStatus: 'checking_agents', activityStatusSince: 262 };
        order.push('identity');
      });
      harness.ctx.persistSessionState.mockImplementation(() => order.push('persist'));
      harness.ctx.startTranscriptWatcher.mockImplementation(() => order.push('transcript'));
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: {
          event: 'session_start',
          sessionId: harness.ctx._sessionId,
          data: {
            source: 'new',
            session_id: 'claude-new-262',
            transcript_path: '/tmp/claude-new-262.jsonl',
            cwd: '/tmp/test-workdir',
          },
        },
      });
      expect(res.statusCode).toBe(200);
      expect(session.adoptClaudeSessionStartId).toHaveBeenCalledWith('claude-new-262');
      expect(harness.ctx.agentActivity.identityChanged).toHaveBeenCalledWith(session);
      expect(harness.ctx.persistSessionState).toHaveBeenCalledWith(session);
      expect(order.slice(0, 4)).toEqual(['adopt', 'identity', 'persist', 'transcript']);
      expect(session.activityProjection?.activityStatus).toBe('checking_agents');
    });

    it('clears only an old-generation idle approval on authoritative identity replacement', async () => {
      const session = harness.ctx.sessions.get(harness.ctx._sessionId) as unknown as {
        claudeSessionId: string;
        adoptClaudeSessionStartId(id: string): void;
      };
      session.claudeSessionId = 'old-generation';
      session.adoptClaudeSessionStartId = (id) => {
        session.claudeSessionId = id;
      };
      approvalInbox.notePrompt({
        sessionId: harness.ctx._sessionId,
        sessionName: 'old',
        kind: 'idle',
        sourceSequence: 8,
      });
      await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: {
          event: 'session_start',
          sessionId: harness.ctx._sessionId,
          data: { session_id: 'new-generation', source: 'new' },
        },
      });
      expect(approvalInbox.getForSession(harness.ctx._sessionId)).toBeUndefined();

      harness.ctx.agentActivity.allocateEvent.mockReturnValue({ sequence: 1, kind: 'stop' });
      await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: { event: 'stop', sessionId: harness.ctx._sessionId, data: null },
      });
      expect(approvalInbox.getForSession(harness.ctx._sessionId)).toBeUndefined();
    });

    it.each(['permission', 'question'] as const)(
      'preserves a pending %s approval across identity replacement',
      async (kind) => {
        const session = harness.ctx.sessions.get(harness.ctx._sessionId) as unknown as {
          claudeSessionId: string;
          adoptClaudeSessionStartId(id: string): void;
        };
        session.claudeSessionId = 'old-generation';
        session.adoptClaudeSessionStartId = (id) => {
          session.claudeSessionId = id;
        };
        approvalInbox.notePrompt({ sessionId: harness.ctx._sessionId, sessionName: 'old', kind, sourceSequence: 8 });
        await harness.app.inject({
          method: 'POST',
          url: '/api/hook-event',
          payload: {
            event: 'session_start',
            sessionId: harness.ctx._sessionId,
            data: { session_id: `new-${kind}`, source: 'new' },
          },
        });
        expect(approvalInbox.getForSession(harness.ctx._sessionId)).toMatchObject({ kind });
        expect(approvalInbox.getForSession(harness.ctx._sessionId)).not.toHaveProperty('sourceSequence');

        harness.ctx.agentActivity.allocateEvent.mockReturnValue({ sequence: 1, kind: 'stop' });
        await harness.app.inject({
          method: 'POST',
          url: '/api/hook-event',
          payload: { event: 'stop', sessionId: harness.ctx._sessionId, data: null },
        });
        expect(approvalInbox.getForSession(harness.ctx._sessionId)).toBeUndefined();
      }
    );

    it('returns the checkpoint run id for a new-mode request', async () => {
      const session = harness.ctx.sessions.get(harness.ctx._sessionId) as unknown as {
        checkpointEnabled: boolean;
        requestCheckpoint: ReturnType<typeof vi.fn>;
      };
      session.checkpointEnabled = true;
      session.requestCheckpoint = vi.fn(() => ({ triggered: true, runId: 'route-run-262' }));
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: {
          event: 'checkpoint',
          sessionId: harness.ctx._sessionId,
          data: { mode: 'new', continuePrompt: 'continue safely' },
        },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).data.checkpoint).toEqual({ triggered: true, runId: 'route-run-262' });
      expect(session.requestCheckpoint).toHaveBeenCalledWith({ mode: 'new', continuePrompt: 'continue safely' });
    });

    it('accepts a valid hook event and broadcasts it', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: {
          event: 'stop',
          sessionId: harness.ctx._sessionId,
          data: null,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(harness.ctx.broadcast).toHaveBeenCalledWith(
        'hook:stop',
        expect.objectContaining({ sessionId: harness.ctx._sessionId })
      );
    });

    it('records and wakes raw stop waiters before awaiting activity evidence', async () => {
      const order: string[] = [];
      let finish!: (decision: Record<string, unknown>) => void;
      const pending = new Promise<Record<string, unknown>>((resolve) => (finish = resolve));
      harness.ctx.agentActivity.allocateEvent.mockImplementation(() => ({ sequence: 12, kind: 'stop' }));
      harness.ctx.agentActivity.decideEvent.mockImplementation(async () => pending);
      harness.ctx.runSummaryTrackers.set(harness.ctx._sessionId, {
        recordHookEvent: vi.fn(() => order.push('summary')),
      } as never);
      const notify = vi.spyOn(sessionWaits, 'notifySignal').mockImplementation(() => {
        order.push('waiter');
        return 0;
      });

      const response = harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: { event: 'stop', sessionId: harness.ctx._sessionId, data: null },
      });
      await vi.waitFor(() => expect(order).toEqual(['waiter', 'summary']));
      expect(harness.ctx.broadcast).not.toHaveBeenCalled();
      finish({ presentToHuman: true, quarantined: false, autonomyBlocked: false });
      await response;
      notify.mockRestore();
    });

    it('emits only hook:suppressed when exact live-agent evidence suppresses an idle prompt', async () => {
      harness.ctx.agentActivity.allocateEvent.mockReturnValue({ sequence: 22, kind: 'idle_prompt' });
      harness.ctx.agentActivity.decideEvent.mockResolvedValue({
        presentToHuman: false,
        quarantined: false,
        autonomyBlocked: true,
        observation: 'live',
        liveEvidence: 'watcher_or_frame',
      });
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: { event: 'idle_prompt', sessionId: harness.ctx._sessionId, data: { message: 'waiting' } },
      });

      expect(res.statusCode).toBe(200);
      expect(harness.ctx.broadcast).toHaveBeenCalledTimes(1);
      expect(harness.ctx.broadcast).toHaveBeenCalledWith(
        'hook:suppressed',
        expect.objectContaining({ sessionId: harness.ctx._sessionId, hookEvent: 'idle_prompt', sourceSequence: 22 })
      );
      expect(harness.ctx.sendPushNotifications).not.toHaveBeenCalled();
      expect(approvalInbox.getForSession(harness.ctx._sessionId)).toBeUndefined();
    });

    it('keeps raw stop waiters and summaries while suppressing every legacy stop effect', async () => {
      const receipt = { sequence: 41, kind: 'stop' };
      const controller = { signalStopHook: vi.fn() };
      const tracker = { recordHookEvent: vi.fn() };
      harness.ctx.respawnControllers.set(harness.ctx._sessionId, controller as never);
      harness.ctx.runSummaryTrackers.set(harness.ctx._sessionId, tracker as never);
      harness.ctx.agentActivity.allocateEvent.mockReturnValue(receipt);
      harness.ctx.agentActivity.decideEvent.mockResolvedValue({
        presentToHuman: false,
        quarantined: false,
        autonomyBlocked: true,
        observation: 'live',
        liveEvidence: 'exact_process',
        processReason: 'matching_process',
      });
      const notify = vi.spyOn(sessionWaits, 'notifySignal');

      await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: { event: 'stop', sessionId: harness.ctx._sessionId, data: { message: 'raw stop' } },
      });

      expect(notify).toHaveBeenCalledWith(harness.ctx._sessionId, 'stop');
      expect(tracker.recordHookEvent).toHaveBeenCalledWith('stop', expect.objectContaining({ message: 'raw stop' }));
      expect(harness.ctx.broadcast).toHaveBeenCalledTimes(1);
      expect(harness.ctx.broadcast).toHaveBeenCalledWith(
        'hook:suppressed',
        expect.objectContaining({ hookEvent: 'stop', sourceSequence: 41, liveEvidence: 'exact_process' })
      );
      expect(controller.signalStopHook).not.toHaveBeenCalled();
      expect(harness.ctx.sendPushNotifications).not.toHaveBeenCalled();
      expect(harness.ctx.broadcastSessionStateDebounced).not.toHaveBeenCalled();
      expect(approvalInbox.getForSession(harness.ctx._sessionId)).toBeUndefined();
    });

    it('sends push notifications for hook events', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: {
          event: 'idle_prompt',
          sessionId: harness.ctx._sessionId,
          data: null,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(harness.ctx.sendPushNotifications).toHaveBeenCalledWith(
        'hook:idle_prompt',
        expect.objectContaining({ sessionId: harness.ctx._sessionId })
      );
    });

    /**
     * The pane's live conversation id, reported by the CLI process itself. This
     * is what lets the response viewer stop guessing from ~/.claude/history.jsonl
     * — a guess that could never run at all for a pane the user drives by
     * attaching to tmux, because `lastSubmitAt` only ever saw Codeman's own
     * write path.
     */
    it('adopts the conversation id first-hand from a prompt_submitted hook', async () => {
      const session = harness.ctx._session;
      const before = session.lastSubmitAt;

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: {
          event: 'prompt_submitted',
          sessionId: harness.ctx._sessionId,
          data: { hook_event_name: 'UserPromptSubmit', session_id: 'conv-1', source: 'user' },
        },
      });

      expect(res.statusCode).toBe(200);
      expect(session.claudeSessionId).toBe('conv-1');
      expect(session.claudeSessionIdIsFirstHand).toBe(true);
      expect(session.claudeSessionChain).toEqual(['conv-1']);
      expect(session.lastSubmitAt).toBeGreaterThan(before);
      expect(harness.ctx.persistSessionState).toHaveBeenCalledWith(session);
    });

    it('records a /clear successor in the chain and persists it, without duplicating a repeat', async () => {
      const session = harness.ctx._session;
      const submit = async (conversationId: string) =>
        harness.app.inject({
          method: 'POST',
          url: '/api/hook-event',
          payload: {
            event: 'prompt_submitted',
            sessionId: harness.ctx._sessionId,
            data: { hook_event_name: 'UserPromptSubmit', session_id: conversationId },
          },
        });

      await submit('conv-1');
      await submit('conv-1'); // every prompt in a conversation reports the same id
      await submit('conv-2'); // the user ran /clear

      expect(session.claudeSessionChain).toEqual(['conv-1', 'conv-2']);
      expect(session.claudeSessionId).toBe('conv-2');
      // `/clear` emits no completion event, so the successor is lost on restart
      // unless the hook itself persists it.
      expect(harness.ctx.persistSessionState).toHaveBeenCalledTimes(2);
    });

    it('does not leak the prompt text into the broadcast', async () => {
      await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: {
          event: 'prompt_submitted',
          sessionId: harness.ctx._sessionId,
          data: { hook_event_name: 'UserPromptSubmit', session_id: 'conv-1', prompt: 'my secret prompt' },
        },
      });

      const broadcast = JSON.stringify(harness.ctx.broadcast.mock.calls);
      expect(broadcast).not.toContain('my secret prompt');
      expect(broadcast).toContain('conv-1');
    });

    it('returns 404 for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: {
          event: 'stop',
          sessionId: 'nonexistent-session',
          data: null,
        },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toBeDefined();
    });

    it('rejects invalid event type', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: {
          event: 'invalid_event_type',
          sessionId: harness.ctx._sessionId,
          data: null,
        },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects missing sessionId', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: {
          event: 'stop',
        },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('signals respawn controller on stop event', async () => {
      const mockController = {
        signalStopHook: vi.fn(),
        signalElicitation: vi.fn(),
        signalIdlePrompt: vi.fn(),
      };
      harness.ctx.respawnControllers.set(harness.ctx._sessionId, mockController as never);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: {
          event: 'stop',
          sessionId: harness.ctx._sessionId,
          data: null,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(mockController.signalStopHook).toHaveBeenCalled();
    });

    it('signals respawn controller on elicitation_dialog event', async () => {
      const mockController = {
        signalStopHook: vi.fn(),
        signalElicitation: vi.fn(),
        signalIdlePrompt: vi.fn(),
      };
      harness.ctx.respawnControllers.set(harness.ctx._sessionId, mockController as never);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: {
          event: 'elicitation_dialog',
          sessionId: harness.ctx._sessionId,
          data: null,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(mockController.signalElicitation).toHaveBeenCalled();
    });

    it('signals respawn controller on idle_prompt event', async () => {
      const mockController = {
        signalStopHook: vi.fn(),
        signalElicitation: vi.fn(),
        signalIdlePrompt: vi.fn(),
      };
      harness.ctx.respawnControllers.set(harness.ctx._sessionId, mockController as never);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: {
          event: 'idle_prompt',
          sessionId: harness.ctx._sessionId,
          data: null,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(mockController.signalIdlePrompt).toHaveBeenCalled();
    });

    it('records hook event in run summary tracker', async () => {
      const mockTracker = { recordHookEvent: vi.fn() };
      harness.ctx.runSummaryTrackers.set(harness.ctx._sessionId, mockTracker as never);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: {
          event: 'stop',
          sessionId: harness.ctx._sessionId,
          data: { tool_name: 'bash' },
        },
      });
      expect(res.statusCode).toBe(200);
      expect(mockTracker.recordHookEvent).toHaveBeenCalledWith('stop', expect.any(Object));
    });

    it('starts transcript watcher when transcript_path is provided', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: {
          event: 'stop',
          sessionId: harness.ctx._sessionId,
          data: { transcript_path: '/home/user/.claude/transcript.jsonl' },
        },
      });
      expect(res.statusCode).toBe(200);
      expect(harness.ctx.startTranscriptWatcher).toHaveBeenCalledWith(
        harness.ctx._sessionId,
        '/home/user/.claude/transcript.jsonl'
      );
    });

    it('accepts valid data payload with extra fields', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: {
          event: 'permission_prompt',
          sessionId: harness.ctx._sessionId,
          data: { tool_name: 'bash', command: 'ls -la' },
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
    });
  });
});
