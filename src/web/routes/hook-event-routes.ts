/**
 * @fileoverview Hook event route.
 * Receives Claude Code hook events and broadcasts to SSE clients.
 * This endpoint bypasses auth (Claude Code hooks curl from localhost).
 * Prompt events (permission_prompt / elicitation_dialog / idle_prompt) also
 * open Approvals Inbox items; stop and the elicitation-closed events clear
 * them (see web/approval-inbox.ts and docs/approvals-inbox-plan.md).
 */

import { FastifyInstance } from 'fastify';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { HookEventSchema, isValidWorkingDir } from '../schemas.js';
import { sanitizeHookData, parseBody } from '../route-helpers.js';
import { persistDockerCaseClaudeSessionId } from '../../docker-hosts.js';
import { getDataDir } from '../../config/instance.js';
import { sessionWaits, hooksAvailableForMode } from '../session-wait-registry.js';
import { approvalInbox, type ApprovalKind } from '../approval-inbox.js';
import { buildPaneCapture } from '../pane-capture.js';
import type { SessionPort, EventPort, RespawnPort, ConfigPort, InfraPort, AgentActivityPort } from '../ports/index.js';
import type { HookKind } from '../../session-agent-activity-coordinator.js';

/** Hook events that open an Approvals Inbox item. */
const APPROVAL_KIND_BY_EVENT: Record<string, ApprovalKind> = {
  permission_prompt: 'permission',
  elicitation_dialog: 'question',
  idle_prompt: 'idle',
};

/** Hook events that close a session's pending item without an inbox answer. */
const APPROVAL_RESOLVING_EVENTS = new Set(['stop', 'elicitation_complete', 'elicitation_response']);

const ACTIVITY_KIND_BY_EVENT: Partial<Record<string, Exclude<HookKind, 'raw_idle'>>> = {
  stop: 'stop',
  idle_prompt: 'idle_prompt',
  permission_prompt: 'permission',
  elicitation_dialog: 'elicitation',
};

export function registerHookEventRoutes(
  app: FastifyInstance,
  ctx: SessionPort & EventPort & RespawnPort & ConfigPort & InfraPort & AgentActivityPort
): void {
  app.post('/api/hook-event', async (req) => {
    const { event, sessionId, data } = parseBody(HookEventSchema, req.body);
    if (!ctx.sessions.has(sessionId)) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
    }

    // Agent-initiated checkpoint: run compact, clear, or new, then continue once the
    // op completes. Per-session opt-in (default OFF). The CLI reads the returned
    // result to learn whether it actually triggered.
    if (event === 'checkpoint') {
      const session = ctx.sessions.get(sessionId);
      const result = session?.checkpointEnabled
        ? session.requestCheckpoint({
            mode: data?.mode as 'compact' | 'clear' | 'new' | undefined,
            continuePrompt: typeof data?.continuePrompt === 'string' ? data.continuePrompt : undefined,
          })
        : { triggered: false, reason: 'not-enabled' };
      return { success: true, data: { checkpoint: result } };
    }

    // SessionStart is the authoritative startup/resume/fresh-thread identity
    // signal. Replace the coordinator generation synchronously before transcript
    // watching, respawn, approval, or broadcast effects can observe the old one.
    if (event === 'session_start' && data && typeof data.session_id === 'string' && data.session_id) {
      const session = ctx.sessions.get(sessionId);
      const prevClaudeSessionId = session?.claudeSessionId;
      session?.adoptClaudeSessionStartId(data.session_id);
      if (session) {
        if (data.session_id !== prevClaudeSessionId) {
          approvalInbox.resolveForSession(sessionId, 'resolved_in_terminal', ['idle']);
          approvalInbox.resetSourceSequenceForSession(sessionId, ['permission', 'question']);
          ctx.agentActivity.identityChanged(session);
        }
        ctx.persistSessionState(session);
      }
      // Docker sessions: keep the case's resume seed following the LIVE
      // conversation (post-/clear id switches), so a container stop/reboot
      // relaunch resumes the right transcript.
      if (session?.docker && session.claudeSessionId && session.claudeSessionId !== prevClaudeSessionId) {
        void persistDockerCaseClaudeSessionId(
          getDataDir(),
          session.docker.containerName,
          session.claudeSessionId
        ).catch(() => {});
      }
    }

    const session = ctx.sessions.get(sessionId)!;
    const safeData = sanitizeHookData(data);
    const activityKind = ACTIVITY_KIND_BY_EVENT[event];
    const activityEvent = activityKind ? ctx.agentActivity.allocateEvent(session, activityKind) : undefined;
    const sourceSequence = activityEvent?.sequence || undefined;
    const summaryTracker = ctx.runSummaryTrackers.get(sessionId);
    if (summaryTracker && event !== 'stop') summaryTracker.recordHookEvent(event, safeData);

    // Wake anything blocked on `GET /api/sessions/:id/wait`. Hooks are the only
    // DEFINITIVE signals Codeman gets (`idle` is inferred from output stabilization
    // and can flap mid-turn), so these two are what an orchestrating agent should
    // wait on.
    //
    // Gated on the session's MODE, matching `resolveWaitSignals` on the read side.
    // Without it the guard is one-sided: a caller cannot ASK for `stop` on a shell or
    // codex session, but this endpoint would happily deliver one for it. Hook events
    // carry no identity beyond a per-instance secret shared by every case, so this is
    // also the cheap half of the forgery surface — a `stop` claimed for a session that
    // could never legitimately emit one is now dropped instead of steering another
    // agent's control flow.
    const waitSession = session;
    if (waitSession && hooksAvailableForMode(waitSession.mode)) {
      if (event === 'stop') {
        sessionWaits.notifySignal(sessionId, 'stop');
        summaryTracker?.recordHookEvent(event, safeData);
      } else if (event === 'permission_prompt' || event === 'elicitation_dialog') {
        sessionWaits.notifySignal(sessionId, 'blocked');
      }
    }
    // Even a mode-mismatched stop remains raw evidence in the run summary.
    if (event === 'stop' && !hooksAvailableForMode(waitSession.mode)) summaryTracker?.recordHookEvent(event, safeData);

    // Transcript discovery is identity evidence, not a human-facing legacy hook
    // effect, so preserve it even when the prompt itself is suppressed below.
    if (data && 'transcript_path' in data) {
      const transcriptPath = String(data.transcript_path);
      if (transcriptPath && isValidWorkingDir(transcriptPath)) {
        ctx.startTranscriptWatcher(sessionId, transcriptPath);
      }
    }

    const decision = activityEvent
      ? await ctx.agentActivity.decideEvent(session, activityEvent)
      : {
          presentToHuman: true,
          quarantined: false,
          autonomyBlocked: false,
          ambiguous: false,
          observation: undefined,
          liveEvidence: undefined,
          processReason: undefined,
        };
    if (activityEvent && !decision.presentToHuman) {
      ctx.broadcast('hook:suppressed', {
        sessionId,
        timestamp: Date.now(),
        hookEvent: event,
        sourceSequence,
        reason: decision.quarantined ? 'stale_completion' : 'background_agents_live',
        activityStatus: ctx.agentActivity.project(session).activityStatus,
        observation: decision.observation,
        liveEvidence: decision.liveEvidence,
        processReason: decision.processReason,
        ...safeData,
      });
      return {};
    }

    // Signal the respawn controller based on hook event type
    const controller = ctx.respawnControllers.get(sessionId);
    if (controller) {
      if (event === 'elicitation_dialog') {
        // Block auto-accept for question prompts
        controller.signalElicitation();
      } else if (event === 'stop') {
        // DEFINITIVE idle signal - Claude finished responding
        controller.signalStopHook();
      } else if (event === 'idle_prompt') {
        // DEFINITIVE idle signal - Claude has been idle for 60+ seconds
        controller.signalIdlePrompt();
      }
    }

    // Sanitize forwarded data: only include known safe fields, limit size
    const sessionName = session?.name ?? sessionId.slice(0, 8);

    // Approvals Inbox: prompt events open an item, dialog-closed/stop events
    // clear it. Mode-gated like the wait signals above (hook events carry no
    // identity beyond the shared per-instance secret, so a prompt claimed for a
    // session that can never show one must not create an answerable item).
    let approvalId: string | undefined;
    const approvalKind = APPROVAL_KIND_BY_EVENT[event];
    if (session && hooksAvailableForMode(session.mode)) {
      if (approvalKind) {
        const toolInput =
          safeData.tool_input && typeof safeData.tool_input === 'object'
            ? (safeData.tool_input as Record<string, unknown>)
            : undefined;
        const toolSummary = toolInput
          ? [toolInput.command, toolInput.file_path, toolInput.description].find((v) => typeof v === 'string')
          : undefined;
        const item = approvalInbox.notePrompt({
          sessionId,
          sessionName,
          kind: approvalKind,
          mode: session.mode,
          toolName: typeof safeData.tool_name === 'string' ? safeData.tool_name : undefined,
          toolSummary: typeof toolSummary === 'string' ? toolSummary : undefined,
          message: typeof safeData.message === 'string' ? safeData.message : undefined,
          cwd: typeof safeData.cwd === 'string' ? safeData.cwd : undefined,
          sourceSequence,
          // Visible tmux frame first (it IS the dialog); raw byte-buffer tail as
          // the fallback for direct-PTY sessions and the no-op test mux.
          capture: buildPaneCapture(session, ctx.mux),
        });
        approvalId = item.id;
      } else if (APPROVAL_RESOLVING_EVENTS.has(event)) {
        approvalInbox.resolveForSession(sessionId, 'resolved_in_terminal', undefined, sourceSequence);
      }
    }

    ctx.broadcast(`hook:${event}`, {
      sessionId,
      timestamp: Date.now(),
      ...safeData,
      ...(approvalId && { approvalId }),
      ...(decision.ambiguous && { agentActivityDiagnostic: 'evidence_unavailable' }),
    });
    // Full state ride-along, same shape as the working/idle handlers: the home
    // screens rank the blocked group on lastActivityAt, and without this a
    // permission prompt raised after page load kept ranking by whatever stamp
    // the browser loaded with. Debounced, so a hook burst costs one broadcast.
    ctx.broadcastSessionStateDebounced(sessionId);

    // Send push notifications for hook events
    ctx.sendPushNotifications(`hook:${event}`, {
      sessionId,
      sessionName,
      ...safeData,
      ...(approvalId && { approvalId }),
    });

    return {};
  });
}
