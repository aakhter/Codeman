/** Durable acceptance with conservative reconciliation across the non-atomic PTY-write boundary. */
import { CodexInputBridge, codexQuestionKey, type CodexAnswers } from './assistant-codex-input.js';
import { createHash, randomUUID } from 'node:crypto';
import { open, stat, realpath } from 'node:fs/promises';
import { AssistantConflict, resolveAssistantBinding, type AssistantSession } from './assistant-registry.js';
import { AssistantRequestStore, type AssistantRequest } from './assistant-request-store.js';
import { AssistantStore } from './assistant-store.js';
import {
  assistantBindingMode,
  assistantSessionHome,
  findAssistantConversation,
  otherNativeReady,
  snapshotOpenCode,
  observeOpenCode,
  type NativeCursor,
} from './assistant-native.js';
import { observeClaudeAssistantTurn, observeAssistantTurn } from './assistant-turn-observer.js';
import type { AssistantDefinition, AssistantBinding } from './types/assistant.js';
import type { AssistantRecovery } from './assistant-recovery.js';

export interface AssistantExecutionSession extends AssistantSession {
  assistantPendingWrites: number;
  assistantLastInputAt: number;
  isCheckpointActive: boolean;
  setAssistantInputGuard(guard: (permit?: string) => boolean): void;
  cancelAssistantSubmitVerification(): void;
  writeViaMux(data: string, options: { assistantPermit: string }): Promise<boolean>;
}
const active = (r: AssistantRequest) => ['dispatching', 'running', 'awaiting_approval'].includes(r.status);
const unresolved = (r: AssistantRequest) =>
  active(r) || (['outcome_unknown', 'interrupted'].includes(r.status) && !r.reconciled);
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export class AssistantRequestManager {
  private inputBridges = new Map<string, CodexInputBridge>();
  private answering = new Set<string>();
  private handoffs = new Map<
    string,
    { sessionId: string; generation: number; permit: string; session: AssistantExecutionSession; pid: number }
  >();
  private dispatches = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private pumping: Promise<void> | undefined;
  private stopped = false;
  private recovery: AssistantRecovery | undefined;
  private recoverySessions = new Set<string>();
  setRecovery(recovery: AssistantRecovery): void {
    this.recovery = recovery;
  }
  captureRecoveryPlacement(sessionId: string): void {
    this.recovery?.capturePlacement(sessionId);
  }
  holdRecoverySession(id: string): void {
    this.recoverySessions.add(id);
  }
  releaseRecoverySession(id: string): void {
    this.recoverySessions.delete(id);
  }
  clearRecoveryHandoff(id: string): void {
    this.handoffs.delete(id);
  }
  hasUnresolved(id: string): boolean {
    return this.store.list().some((r) => r.assistantId === id && unresolved(r));
  }
  rebindQueuedRecovery(id: string, previous: AssistantBinding, binding: AssistantBinding): void {
    for (const r of this.store.list())
      if (r.assistantId === id && r.status === 'queued' && JSON.stringify(r.binding) === JSON.stringify(previous))
        this.change(r, { binding: structuredClone(binding) });
  }
  conversationReady(path: string, binding?: AssistantBinding): Promise<boolean> {
    return binding && assistantBindingMode(binding) !== 'codex'
      ? otherNativeReady(binding, path)
      : this.nativeReady(path);
  }
  private handoffPending = new Set<string>();
  private takingControl = new Set<string>();
  private lockedSessions = new Set<string>();
  constructor(
    readonly assistants: AssistantStore,
    readonly store: AssistantRequestStore,
    private readonly session: (id: string) => AssistantExecutionSession | undefined,
    private readonly automationBusy: (id: string) => boolean = () => false,
    private readonly grantValid: (r: AssistantRequest) => Promise<boolean> = async () => true,
    private readonly updated: (r: AssistantRequest) => void = () => {}
  ) {
    this.refreshLocks();
  }
  private refreshLocks(): void {
    this.lockedSessions = new Set(
      this.store
        .list()
        .filter((r) => active(r) || (r.status === 'outcome_unknown' && !r.reconciled))
        .map((r) => r.binding.sessionId)
    );
  }
  private async nativeReady(path: string): Promise<boolean> {
    const file = await open(path, 'r');
    try {
      const info = await file.stat();
      const length = Math.min(info.size, 1024 * 1024);
      const bytes = Buffer.alloc(length);
      await file.read(bytes, 0, length, info.size - length);
      if (!length || bytes[length - 1] !== 10) return false;
      let malformed = false;
      const lines = bytes.toString('utf8').split('\n');
      lines.pop();
      if (info.size > length) lines.shift();
      const events = lines
        .map((line) => {
          try {
            return JSON.parse(line) as { type?: string; payload?: { type?: string } };
          } catch {
            malformed = true;
            return undefined;
          }
        })
        .filter(
          (r) =>
            r?.type === 'event_msg' &&
            ['task_started', 'item_completed', 'task_complete', 'task_aborted', 'turn_aborted'].includes(
              r.payload?.type ?? ''
            )
        );
      return !malformed && (!events.length || events.at(-1)?.payload?.type === 'task_complete');
    } finally {
      await file.close();
    }
  }
  outstanding(id: string): boolean {
    return (
      this.handoffs.has(id) ||
      this.store.list().some((r) => r.assistantId === id && (r.status === 'queued' || unresolved(r)))
    );
  }
  inputAllowed(sessionId: string, permit?: string): boolean {
    if (this.recoverySessions.has(sessionId)) return false;
    const held = [...this.handoffs.values()].find((h) => h.sessionId === sessionId);
    if (held) return permit !== undefined && permit === held.permit;
    if ([...this.handoffPending].some((id) => this.assistants.get(id)?.binding?.sessionId === sessionId)) return false;
    return !this.lockedSessions.has(sessionId);
  }
  attach(session: AssistantExecutionSession): void {
    session.setAssistantInputGuard((permit) => this.inputAllowed(session.id, permit));
  }
  availability(a: AssistantDefinition): {
    requestExecution: boolean;
    handedOff: boolean;
    needsAttention: boolean;
    inputLocked: boolean;
    recovery?: { state: string; reason?: string; attempts: number };
  } {
    const live = a.binding && this.session(a.binding.sessionId);
    const h = this.handoffs.get(a.id);
    const needsAttention = this.store
      .list()
      .some((r) => r.assistantId === a.id && ['outcome_unknown', 'interrupted'].includes(r.status) && !r.reconciled);
    return {
      requestExecution: Boolean(
        !this.stopped &&
        a.enabled &&
        live?.pid &&
        !live.paneExit &&
        h &&
        h.generation === a.binding?.generation &&
        h.session === live &&
        h.pid === live.pid &&
        !needsAttention &&
        !this.automationBusy(live.id) &&
        !this.takingControl.has(a.id)
      ),
      recovery: this.recovery?.status(a.id),
      handedOff: Boolean(h),
      needsAttention,
      inputLocked: Boolean(a.binding && !this.inputAllowed(a.binding.sessionId)),
    };
  }
  private change(r: AssistantRequest, patch: Partial<AssistantRequest>): AssistantRequest {
    const next = { ...r, ...patch, revision: r.revision + 1, updatedAt: Date.now() };
    this.store.put(next);
    this.refreshLocks();
    if (next.status === 'outcome_unknown') this.handoffs.delete(next.assistantId);
    this.updated(next);
    return next;
  }
  submit(a: AssistantDefinition, text: string, key: string, tokenId?: string): AssistantRequest {
    const existing = this.store.list().find((r) => r.assistantId === a.id && r.idempotencyKey === key);
    if (existing) {
      if (existing.payloadHash !== digest(text)) throw new AssistantConflict('Idempotency key has a different payload');
      return existing;
    }
    if (
      !text.trim() ||
      text.length > 20000 ||
      Array.from(text).some((c) => {
        const code = c.charCodeAt(0);
        return code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029;
      }) ||
      text.trimStart().startsWith('/')
    )
      throw new AssistantConflict('Use a single-line prompt without terminal controls or CLI slash commands');
    if (!a.binding || !this.availability(a).requestExecution)
      throw new AssistantConflict('Assistant requires a healthy binding and explicit desktop handoff');
    const records = this.store.list();
    if (
      records.length >= 1000 ||
      records.filter((r) => r.assistantId === a.id && (r.status === 'queued' || active(r))).length >= 20
    )
      throw new AssistantConflict('Assistant request capacity reached; preserve and archive reconciled records');
    const now = Date.now();
    const r: AssistantRequest = {
      id: randomUUID(),
      assistantId: a.id,
      owner: a.owner,
      tokenId,
      text,
      idempotencyKey: key,
      payloadHash: digest(text),
      status: 'queued',
      binding: structuredClone(a.binding),
      createdAt: now,
      updatedAt: now,
      deadline: now + 30 * 60 * 1000,
      revision: 1,
    };
    this.store.put(r);
    this.updated(r);
    return r;
  }
  cancel(r: AssistantRequest): AssistantRequest {
    const current = this.store.get(r.id)!;
    if (current.status === 'cancelled') return current;
    if (current.status !== 'queued')
      throw new AssistantConflict('Only queued requests can be cancelled; use desktop Take control for active work');
    return this.change(current, { status: 'cancelled', reason: 'Cancelled before dispatch', reconciled: true });
  }
  async handoff(a: AssistantDefinition, expectedRevision: number, composerEmpty: boolean): Promise<void> {
    if (
      !composerEmpty ||
      !a.enabled ||
      !a.binding ||
      a.revision !== expectedRevision ||
      this.store.list().some((r) => r.assistantId === a.id && unresolved(r)) ||
      this.handoffPending.has(a.id) ||
      this.takingControl.has(a.id)
    )
      throw new AssistantConflict(
        'Enable and bind an idle assistant, clear the composer, and reconcile requests before handoff'
      );
    const oldHandoff = this.handoffs.get(a.id);
    if (
      oldHandoff &&
      (oldHandoff.session !== this.session(oldHandoff.sessionId) ||
        oldHandoff.pid !== this.session(oldHandoff.sessionId)?.pid)
    )
      throw new AssistantConflict('Session recovered or changed; take control and explicitly rebind first');
    this.handoffPending.add(a.id);
    try {
      const live = this.session(a.binding.sessionId);
      if (
        !live ||
        live.assistantPendingWrites ||
        Date.now() - live.assistantLastInputAt < 1000 ||
        this.automationBusy(live.id) ||
        live.isCheckpointActive
      )
        throw new AssistantConflict('Session has active input or automation');
      this.attach(live);
      live.cancelAssistantSubmitVerification();
      const binding = await resolveAssistantBinding(live, a.binding.generation);
      const native = await findAssistantConversation(binding, live);
      if (!native || !(await this.conversationReady(native.path, binding)))
        throw new AssistantConflict('Native conversation still has an unfinished turn');
      const latest = this.assistants.get(a.id);
      if (
        !latest?.enabled ||
        latest.revision !== expectedRevision ||
        assistantBindingMode(binding) !== a.mode ||
        binding.conversationId !== a.binding.conversationId ||
        binding.codexHome !== a.binding.codexHome ||
        binding.workingDir !== a.binding.workingDir ||
        this.session(live.id) !== live ||
        live.assistantPendingWrites ||
        live.status !== 'idle'
      )
        throw new AssistantConflict('Binding or live session changed during handoff');
      this.recovery?.arm(a, live);
      this.handoffs.set(a.id, {
        sessionId: live.id,
        generation: binding.generation,
        permit: randomUUID(),
        session: live,
        pid: live.pid!,
      });
    } finally {
      this.handoffPending.delete(a.id);
    }
  }
  async takeControl(a: AssistantDefinition): Promise<void> {
    this.recovery?.disarm(a.id);
    this.takingControl.add(a.id);
    try {
      for (const r of this.store.list().filter((r) => r.assistantId === a.id))
        while (this.answering.has(r.id)) await new Promise((resolve) => setTimeout(resolve, 50));
      await this.dispatches.get(a.id); // The mux submission must settle before input ownership changes.
      for (const r of this.store.list().filter((r) => r.assistantId === a.id)) {
        if (r.status === 'queued') this.cancel(r);
        else if (active(r))
          this.change(r, {
            status: 'interrupted',
            reason: 'Desktop took control; task side effects may already exist',
            reconciled: false,
          });
      }
      const latest = this.assistants.get(a.id);
      if (latest)
        this.assistants.save({ ...latest, enabled: false, revision: latest.revision + 1, updatedAt: Date.now() });
      this.handoffs.delete(a.id);
      // Unknown work remains visible but desktop input is explicitly authorized by this operation.
      for (const r of this.store
        .list()
        .filter((r) => r.assistantId === a.id && r.status === 'outcome_unknown' && !r.reconciled))
        this.change(r, {
          status: 'interrupted',
          reason: 'Desktop took control of an uncertain request',
          reconciled: false,
        });
    } finally {
      this.takingControl.delete(a.id);
    }
  }
  reconcile(r: AssistantRequest, acknowledgeSideEffects: boolean): AssistantRequest {
    r = this.store.get(r.id)!;
    const a = this.assistants.get(r.assistantId);
    if (
      !acknowledgeSideEffects ||
      a?.enabled ||
      this.handoffs.has(r.assistantId) ||
      !['outcome_unknown', 'interrupted'].includes(r.status)
    )
      throw new AssistantConflict(
        'Take control, confirm the CLI task has stopped, and acknowledge possible side effects first'
      );
    return this.change(this.store.get(r.id)!, {
      reconciled: true,
      reason: 'Desktop reviewed the uncertain outcome; no automatic replay',
    });
  }
  private async transcriptIdentity(r: AssistantRequest): Promise<string | undefined> {
    const live = this.session(r.binding.sessionId);
    if (
      !live ||
      live.mode !== assistantBindingMode(r.binding) ||
      live.owner !== r.owner ||
      live.remote ||
      live.docker ||
      live.hasLostCodexProviderCredentials()
    )
      return undefined;
    if (
      (await realpath(live.workingDir)) !== r.binding.workingDir ||
      assistantSessionHome(live) !== r.binding.codexHome
    )
      return undefined;
    const conversation = await findAssistantConversation(r.binding, live);
    return conversation?.id === r.binding.conversationId ? conversation.path : undefined;
  }
  private inputBridge(r: AssistantRequest): CodexInputBridge {
    let bridge = this.inputBridges.get(r.id);
    if (!bridge) {
      bridge = new CodexInputBridge(r.binding.codexHome, r.binding.conversationId, r.binding.workingDir);
      this.inputBridges.set(r.id, bridge);
    }
    return bridge;
  }
  async answer(
    r: AssistantRequest,
    questionKey: string,
    answers: CodexAnswers,
    idempotencyKey: string
  ): Promise<AssistantRequest> {
    r = this.store.get(r.id)!;
    const payloadHash = digest(JSON.stringify(Object.entries(answers).sort(([a], [b]) => a.localeCompare(b))));
    const previous = r.inputAnswers?.find((a) => a.idempotencyKey === idempotencyKey || a.questionKey === questionKey);
    if (previous) {
      if (previous.payloadHash !== payloadHash || previous.questionKey !== questionKey)
        throw new AssistantConflict('This question already has a different answer');
      if (previous.state !== 'answered')
        throw new AssistantConflict('Answer outcome needs review in Codeman; no automatic replay');
      return r;
    }
    const q = r.pendingInput;
    const assistant = this.assistants.get(r.assistantId);
    if (
      this.stopped ||
      this.answering.has(r.id) ||
      !active(r) ||
      !q ||
      codexQuestionKey(q) !== questionKey ||
      q.turnId !== r.turnId ||
      q.threadId !== r.binding.conversationId ||
      !assistant?.enabled ||
      this.takingControl.has(r.assistantId) ||
      !(await this.grantValid(r)) ||
      (await this.transcriptIdentity(r)) !== r.transcript?.path
    )
      throw new AssistantConflict('The original question is no longer available');
    if (
      Object.keys(answers).length !== q.questions.length ||
      q.questions.some(
        (question) =>
          question.isSecret ||
          !answers[question.id] ||
          answers[question.id].answers.length !== 1 ||
          (!question.isOther &&
            question.options?.length &&
            !question.options.some((o) => o.label === answers[question.id].answers[0]))
      )
    )
      throw new AssistantConflict('Answer each question using a listed option, or answer secret questions in Codeman');
    if ((r.inputAnswers?.length ?? 0) >= 100) throw new AssistantConflict('Question history is full');
    this.answering.add(r.id);
    try {
      const bridge = this.inputBridge(r);
      const current =
        q.kind === 'async' && (await bridge.asyncPending(q))
          ? q
          : (await bridge.inputs(q.turnId)).find((input) => codexQuestionKey(input) === questionKey);
      if (!current || JSON.stringify(current) !== JSON.stringify(q))
        throw new AssistantConflict('Question was already resolved');
      // Persist before the native response: an uncertain write is never replayed after a crash.
      const clientId = q.kind === 'async' ? randomUUID() : undefined;
      const text =
        q.kind === 'async'
          ? q.questions
              .map((question) => `${question.question}\nAnswer: ${answers[question.id].answers[0]}`)
              .join('\n\n')
          : undefined;
      if (
        this.takingControl.has(r.assistantId) ||
        !active(this.store.get(r.id)!) ||
        !this.assistants.get(r.assistantId)?.enabled ||
        !(await this.grantValid(r))
      )
        throw new AssistantConflict('Question ownership changed');
      const attempt = { questionKey, idempotencyKey, payloadHash, clientId, text, state: 'sending' as const };
      this.change(this.store.get(r.id)!, { inputAnswers: [...(r.inputAnswers ?? []), attempt] });
      try {
        await bridge.answer(q, answers, clientId, text);
        const latest = this.store.get(r.id)!;
        return this.change(latest, {
          pendingInput: undefined,
          deadline: Date.now() + 30 * 60 * 1000,
          inputAnswers: latest.inputAnswers!.map((a) =>
            a.idempotencyKey === idempotencyKey ? { ...a, state: 'answered' } : a
          ),
        });
      } catch {
        const latest = this.store.get(r.id)!;
        this.change(latest, {
          inputAnswers: latest.inputAnswers!.map((a) =>
            a.idempotencyKey === idempotencyKey ? { ...a, state: 'outcome_unknown' } : a
          ),
        });
        throw new AssistantConflict('Native answer outcome is unknown; check Codeman before retrying');
      }
    } finally {
      this.answering.delete(r.id);
    }
  }
  private async observe(r: AssistantRequest): Promise<void> {
    if (!r.transcript) {
      this.change(r, { status: 'outcome_unknown', reason: 'Dispatch evidence missing' });
      return;
    }
    try {
      const path = await this.transcriptIdentity(r);
      if (path !== r.transcript.path) throw new Error('Exact conversation binding changed or session is unavailable');
      let result;
      if (assistantBindingMode(r.binding) === 'opencode')
        result = await observeOpenCode(r.binding, r.transcript, r.text);
      else {
        const file = await open(path, 'r');
        let delta: string;
        try {
          const info = await file.stat();
          if (
            String(info.ino) !== r.transcript.inode ||
            String(info.dev) !== r.transcript.device ||
            info.size < r.transcript.offset ||
            info.size - r.transcript.offset > 16 * 1024 * 1024
          )
            throw new Error('Transcript rotated, truncated, or exceeded observation capacity');
          const bytes = Buffer.alloc(info.size - r.transcript.offset);
          const { bytesRead } = await file.read(bytes, 0, bytes.length, r.transcript.offset);
          delta = bytes.subarray(0, bytesRead).toString('utf8');
        } finally {
          await file.close();
        }
        result =
          assistantBindingMode(r.binding) === 'claude'
            ? observeClaudeAssistantTurn(delta, r.binding.conversationId, r.text)
            : observeAssistantTurn(delta, r.binding.conversationId, r.text, r.inputAnswers);
      }
      if (result.state === 'running' && assistantBindingMode(r.binding) === 'codex') {
        try {
          const inputs = await this.inputBridge(r).inputs(result.turnId);
          const candidate =
            inputs.find((q) => !q.questions.some((question) => question.isSecret)) ??
            (result.pendingInput && (await this.inputBridge(r).asyncPending(result.pendingInput))
              ? result.pendingInput
              : undefined);
          const pendingInput =
            candidate && !this.store.get(r.id)?.inputAnswers?.some((a) => a.questionKey === codexQuestionKey(candidate))
              ? candidate
              : undefined;
          const current = this.store.get(r.id)!;
          if (JSON.stringify(current.pendingInput) !== JSON.stringify(pendingInput))
            this.change(current, { pendingInput });
        } catch {
          /* Daemon absence must not discard transcript completion evidence. */
        }
      }
      const latest = this.store.get(r.id)!;
      if (!active(latest) && latest.status !== 'outcome_unknown') return;
      if (result.state === 'completed')
        this.change(latest, {
          status: 'completed',
          turnId: result.turnId,
          result: { text: result.text },
          reconciled: true,
          reason: undefined,
          pendingInput: undefined,
        });
      else if (result.state === 'unknown') this.change(latest, { status: 'outcome_unknown', reason: result.reason });
      else if (Date.now() >= r.deadline && !latest.pendingInput)
        this.change(latest, {
          status: 'outcome_unknown',
          reason: 'Observation deadline exceeded; task may still be running',
        });
      else if (result.state === 'running' && (latest.status === 'dispatching' || latest.turnId !== result.turnId))
        this.change(latest, { status: 'running', turnId: result.turnId });
    } catch (err) {
      const latest = this.store.get(r.id)!;
      if (active(latest))
        this.change(latest, {
          status: 'outcome_unknown',
          reason: err instanceof Error ? err.message.slice(0, 300) : 'Transcript unavailable',
        });
    }
  }
  private async dispatch(r: AssistantRequest): Promise<void> {
    const a = this.assistants.get(r.assistantId);
    const live = this.session(r.binding.sessionId);
    if (
      !a ||
      !live ||
      !this.availability(a).requestExecution ||
      live.status !== 'idle' ||
      live.assistantPendingWrites ||
      live.isCheckpointActive
    )
      return;
    if (!(await this.grantValid(r))) {
      this.change(r, { status: 'cancelled', reason: 'Submitting credential or owner was revoked', reconciled: true });
      return;
    }
    const path = await this.transcriptIdentity(r);
    if (!path) {
      this.change(r, {
        status: 'failed',
        reason: 'Exact conversation identity unavailable before dispatch',
        reconciled: true,
      });
      this.handoffs.delete(a.id);
      return;
    }
    if (!(await this.conversationReady(path, r.binding))) return;
    let transcript: NativeCursor;
    if (assistantBindingMode(r.binding) === 'opencode') transcript = await snapshotOpenCode(r.binding, path);
    else {
      const info = await stat(path);
      const file = await open(path, 'r');
      try {
        if (info.size) {
          const last = Buffer.alloc(1);
          await file.read(last, 0, 1, info.size - 1);
          if (last[0] !== 10) return;
        }
      } finally {
        await file.close();
      }
      transcript = { path, offset: info.size, inode: String(info.ino), device: String(info.dev) };
    }
    if (!(await this.grantValid(r))) {
      this.change(this.store.get(r.id)!, {
        status: 'cancelled',
        reason: 'Submitting credential or owner was revoked',
        reconciled: true,
      });
      return;
    }
    // Recheck all mutable state after filesystem awaits, immediately before the durable intent.
    const current = this.store.get(r.id)!;
    const latest = this.assistants.get(a.id);
    if (
      current.status !== 'queued' ||
      this.takingControl.has(a.id) ||
      !latest ||
      latest.binding?.generation !== r.binding.generation ||
      !this.availability(latest).requestExecution ||
      this.session(live.id) !== live ||
      live.status !== 'idle'
    )
      return;
    const intent = this.change(current, {
      status: 'dispatching',
      transcript,
    });
    try {
      // Never fall back or resend if this write fails: it may already have typed part of the prompt.
      const sent = await live.writeViaMux(`${r.text}\r`, { assistantPermit: this.handoffs.get(a.id)!.permit });
      if (!sent && active(this.store.get(r.id)!))
        this.change(intent, {
          status: 'outcome_unknown',
          reason: 'Delivery failed after durable intent; reconcile before retrying',
        });
    } catch {
      if (active(this.store.get(r.id)!))
        this.change(intent, { status: 'outcome_unknown', reason: 'Delivery outcome is unknown' });
    }
  }
  async tick(): Promise<void> {
    if (this.stopped) return;
    for (const r of this.store.list())
      if (active(r) || (r.status === 'outcome_unknown' && !r.reconciled)) await this.observe(r);
    for (const [id, bridge] of this.inputBridges) {
      const r = this.store.get(id);
      if (!r || !active(r)) {
        bridge.close();
        this.inputBridges.delete(id);
      }
    }
    await this.recovery?.tick();
    for (const r of this.store.list().filter((r) => r.status === 'queued')) {
      if (this.stopped) return;
      if (Date.now() >= r.deadline) {
        this.change(r, { status: 'cancelled', reason: 'Queued request expired before dispatch', reconciled: true });
        continue;
      }
      if (
        this.store.list().some((other) => other.assistantId === r.assistantId && unresolved(other)) ||
        this.dispatches.has(r.assistantId)
      )
        continue;
      const task = this.dispatch(r);
      this.dispatches.set(r.assistantId, task);
      try {
        await task;
      } catch {
        // Preflight failures cannot justify a write or disable unrelated assistants.
        const latest = this.store.get(r.id)!;
        if (latest.status === 'queued') {
          this.change(latest, {
            status: 'failed',
            reason: 'Dispatch preflight unavailable; verify binding before handoff',
            reconciled: true,
          });
          this.handoffs.delete(r.assistantId);
        } else throw new Error('Assistant dispatch persistence requires operator attention');
      } finally {
        this.dispatches.delete(r.assistantId);
      }
    }
  }
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (!this.pumping)
        this.pumping = this.tick()
          .catch(() => {
            this.stopped = true;
          })
          .finally(() => {
            this.pumping = undefined;
          });
    }, 1000);
    this.timer.unref();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.pumping;
    while (this.answering.size) await new Promise((resolve) => setTimeout(resolve, 50));
    for (const bridge of this.inputBridges.values()) bridge.close();
    this.inputBridges.clear();
    this.handoffs.clear();
  }
}
