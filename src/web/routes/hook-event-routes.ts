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
import { sessionWaits, hooksAvailableForMode, sessionHookOptions } from '../session-wait-registry.js';
import { getCli } from '../../config/cli-registry/registry.js';
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

/**
 * Hook events that close a session's pending item without an inbox answer.
 *
 * `agent_working` is here because it is the DeepSeek status bridge's report that
 * a turn STARTED, and a harness turn cannot be running while one of its own
 * modal approvals is on screen — so the agent moving means the dialog was
 * answered, in the terminal, by the user. That is the same conclusion the claude
 * path reaches through pane capture, which cannot help here because its frame
 * parser is Claude-dialog-shaped.
 */
const APPROVAL_RESOLVING_EVENTS = new Set(['stop', 'elicitation_complete', 'elicitation_response', 'agent_working']);

/**
 * Last DeepSeek status-bridge sequence number seen per session.
 *
 * The Herdr contract the dsh TUI speaks stamps every report with `--seq <n>`
 * and RETRIES failed deliveries with backoff — so a stale report can land
 * AFTER a newer one, and applying it in arrival order resolves an approval
 * with a retried `working` while the harness sits blocked, or releases a wait
 * with a retried `idle` mid-turn. A report whose seq is not newer than the
 * last accepted one is dropped, but only inside a short window: the TUI's
 * retry backoff is seconds, so a LOWER seq arriving after the window is a
 * restarted TUI's fresh numbering (same pane, new generation), not a stale
 * retry, and must be accepted. Insertion-order eviction bounds the map.
 */
const dshSeqBySession = new Map<string, { seq: number; at: number }>();
const DSH_SEQ_STALE_WINDOW_MS = 60_000;
const DSH_SEQ_MAX_SESSIONS = 500;

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
    // `prompt_submitted` is excluded here and recorded at the tail instead: it
    // fires on EVERY prompt of every Claude pane, and only the ones where the
    // conversation actually moved carry information (see the tail block).
    if (summaryTracker && event !== 'stop' && event !== 'prompt_submitted')
      summaryTracker.recordHookEvent(event, safeData);

    // DeepSeek status-bridge ordering: drop a stale retried report (see
    // dshSeqBySession above). Success rather than an error, so the shim exits 0
    // and the TUI does not keep retrying a report that will stay stale.
    if (data && data.source === 'dsh-status-shim' && typeof data.seq === 'number') {
      const last = dshSeqBySession.get(sessionId);
      const now = Date.now();
      if (last && data.seq <= last.seq && now - last.at < DSH_SEQ_STALE_WINDOW_MS) {
        return {};
      }
      if (!dshSeqBySession.has(sessionId) && dshSeqBySession.size >= DSH_SEQ_MAX_SESSIONS) {
        const oldest = dshSeqBySession.keys().next().value;
        if (oldest !== undefined) dshSeqBySession.delete(oldest);
      }
      dshSeqBySession.set(sessionId, { seq: data.seq, at: now });
    }

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
    const waitSession = ctx.sessions.get(sessionId);
    if (waitSession && hooksAvailableForMode(waitSession.mode, sessionHookOptions(waitSession))) {
      if (event === 'stop') {
        sessionWaits.notifySignal(sessionId, 'stop');
        summaryTracker?.recordHookEvent(event, safeData);
      } else if (event === 'permission_prompt' || event === 'elicitation_dialog') {
        sessionWaits.notifySignal(sessionId, 'blocked');
      }
    }
    // Even a mode-mismatched stop remains raw evidence in the run summary.
    if (event === 'stop' && waitSession && !hooksAvailableForMode(waitSession.mode, sessionHookOptions(waitSession)))
      summaryTracker?.recordHookEvent(event, safeData);

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

    // Sync Claude's current conversation id from any OTHER hook payload that
    // carries one. `session_start` already ran through the authoritative branch
    // at the top of this handler (which owns the coordinator generation reset),
    // so it is excluded here rather than adopted twice.
    // Interactive PTY mode never emits `session_id` on stdout, so hooks are the
    // only reliable way to learn that the user ran `/clear` (which spins up a new
    // conversation jsonl).
    // NOTE: transcript watching is NOT repeated here — this fork starts it
    // earlier in the handler ("Transcript discovery is identity evidence"), so
    // upstream's copy of that block at this point would be a second call.
    let conversationChanged = false;
    if (event !== 'session_start' && data && typeof data.session_id === 'string' && data.session_id) {
      const prevClaudeSessionId = session?.claudeSessionId;
      const prevChainLength = session?.claudeSessionChain.length ?? 0;
      // FIRST-HAND: this payload came from the CLI process itself and reached us
      // because the pane's own $CODEMAN_SESSION_ID addressed it. No cwd, no
      // timestamp, nothing a sibling pane on the same folder could win — so the
      // response viewer can stop guessing entirely (see
      // resolveActiveClaudeSessionIdFromHistory).
      session?.adoptClaudeSessionId(data.session_id, { firstHand: true });
      if (event === 'prompt_submitted') {
        // Repairs `lastSubmitAt` for a pane driven straight from tmux: it was
        // bumped only by input that flowed through Codeman's own write path, so
        // it read 0 forever for those panes and every consumer of "when did this
        // pane last submit" silently degraded.
        session?.markPromptSubmitted();
      }
      // Persist when the conversation actually moved: `/clear` emits no
      // completion event, so without this the successor id is lost on restart
      // and recovery falls back to the launch conversation.
      if (
        session &&
        (session.claudeSessionId !== prevClaudeSessionId || session.claudeSessionChain.length !== prevChainLength)
      ) {
        conversationChanged = true;
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

    // Sanitize forwarded data: only include known safe fields, limit size
    const sessionName = session?.name ?? sessionId.slice(0, 8);

    // Approvals Inbox: prompt events open an item, dialog-closed/stop events
    // clear it. Mode-gated like the wait signals above (hook events carry no
    // identity beyond the shared per-instance secret, so a prompt claimed for a
    // session that can never show one must not create an answerable item).
    let approvalId: string | undefined;
    // Set when the item opened ALREADY acknowledged, which today means the session is
    // watching work it started itself. It rides the broadcast so a live page declines to
    // arm the alert (a reloading page learns the same thing from `acknowledgedAt` when it
    // seeds from /api/approvals), and it suppresses the push: an alert nobody can answer
    // is worth even less on a phone than in a tab.
    let acknowledgedReason: string | undefined;
    const approvalKind = APPROVAL_KIND_BY_EVENT[event];
    if (session && hooksAvailableForMode(session.mode, sessionHookOptions(session))) {
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
          // Supervised-hook CLIs (DeepSeek Harness): dialog keystrokes are unverifiable,
          // so the item is an alert — answer in the terminal. Capability-gated, not by
          // mode id, so a future supervised CLI inherits the same shape.
          answerInTerminal: getCli(session.mode)?.capabilities.hooks === 'supervised',
          // What the pane says is still running in the background. An idle prompt from a
          // session that is watching its own work opens acknowledged, so it never arms an
          // alert nobody can answer; notePrompt() carries the whole reasoning.
          watching: session.watching,
          // Visible tmux frame first (it IS the dialog); raw byte-buffer tail as
          // the fallback for direct-PTY sessions and the no-op test mux.
          capture: buildPaneCapture(session, ctx.mux),
        });
        approvalId = item.id;
        acknowledgedReason = item.acknowledgedReason;
      } else if (APPROVAL_RESOLVING_EVENTS.has(event)) {
        approvalInbox.resolveForSession(sessionId, 'resolved_in_terminal', undefined, sourceSequence);
      }
    }

    ctx.broadcast(`hook:${event}`, {
      sessionId,
      timestamp: Date.now(),
      ...safeData,
      ...(approvalId && { approvalId }),
      ...(acknowledgedReason && { acknowledgedReason }),
    });
    // Full state ride-along, same shape as the working/idle handlers: the home
    // screens rank the blocked group on lastActivityAt, and without this a
    // permission prompt raised after page load kept ranking by whatever stamp
    // the browser loaded with. Debounced, so a hook burst costs one broadcast.
    ctx.broadcastSessionStateDebounced(sessionId);

    // Send push notifications for hook events. Push Approve/Deny actions ride
    // on approvalId, and the answer route refuses keystrokes for dsh dialogs
    // (third-party TUI, unmeasured contract) — so a dsh push stays a plain
    // notification instead of offering buttons whose answer would be refused.
    // Nothing to push for a prompt that opened acknowledged: the agent is waiting for its
    // own monitor or backgrounded shell, and a phone buzzing about it is the same false
    // alarm as the tab alert, delivered where it is hardest to ignore.
    if (!acknowledgedReason) {
      ctx.sendPushNotifications(`hook:${event}`, {
        sessionId,
        sessionName,
        ...safeData,
        // Supervised-hook CLIs answer in the terminal: omit approvalId so push
        // cannot offer Approve/Deny that the answer route would refuse.
        ...(approvalId && session && getCli(session.mode)?.capabilities.hooks !== 'supervised' && { approvalId }),
      });
    }

    // Track a `prompt_submitted` in the run summary ONLY when the conversation
    // actually moved (a /clear successor). It fires on EVERY prompt of every
    // Claude pane, and recording the rest would push a row into the Summary
    // timeline and /api/search per turn and evict useful rows from the
    // 1000-event FIFO (#367 merge-time fix). Every other event was already
    // recorded above, before the suppression/early-return paths.
    if (summaryTracker && event === 'prompt_submitted' && conversationChanged) {
      summaryTracker.recordHookEvent(event, safeData);
    }

    return {};
  });
}
