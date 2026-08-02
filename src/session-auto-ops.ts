/**
 * @fileoverview Auto-compact, auto-clear, and auto-resume automation for Session.
 *
 * Monitors token counts and triggers /compact or /clear commands when
 * configurable thresholds are reached. Waits for Claude to be idle
 * before sending commands, with retry logic and mutual exclusion
 * (compact and clear never run simultaneously).
 *
 * Also implements auto-resume on usage limit ("token pause" control):
 * when enabled and Claude stops on a usage-limit message ("5-hour limit
 * reached ∙ resets 8pm" and friends — see usage-limit-patterns.ts), a timer
 * is armed for the parsed reset time plus a safety buffer, then Escape
 * (dismisses the rate-limit options dialog if open) and a "continue" prompt
 * are sent so work resumes automatically. If the session is still limited,
 * the fresh limit message re-arms the scheduler — that retry loop is the
 * safety net for clock skew and parse imprecision.
 *
 * @module session-auto-ops
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { detectUsageLimitPause } from './usage-limit-patterns.js';
import type { CommandDeliveryResult, CommandDeliveryStage } from './mux-interface.js';

export type { CommandDeliveryResult, CommandDeliveryStage } from './mux-interface.js';

// ============================================================================
// Timing Constants
// ============================================================================

/** Delay for auto-compact/clear retry attempts (2 seconds) */
const AUTO_RETRY_DELAY_MS = 2000;

/** Delay for auto-compact/clear initial check (1 second) */
const AUTO_INITIAL_DELAY_MS = 1000;

/** Cooldown after compact completes before re-enabling (10 seconds) */
const COMPACT_COOLDOWN_MS = 10000;

/** Cooldown after clear completes before re-enabling (5 seconds) */
const CLEAR_COOLDOWN_MS = 5000;

/**
 * Executes an action when the session becomes idle, retrying if currently working.
 *
 * @param action - The async action to execute once idle
 * @param isActive - Returns whether this operation is still active (not cancelled)
 * @param isWorking - Returns whether the session is currently working
 * @param isStopped - Returns whether the session has been stopped
 * @param retryMs - Delay between retry attempts when working
 * @param cooldownMs - Delay after action completes before calling onCooldownDone
 * @param setTimer - Stores the timer reference for cleanup
 * @param onCooldownDone - Called after cooldown to reset state
 */
async function executeWhenIdle(
  action: () => Promise<void>,
  isActive: () => boolean,
  isWorking: () => boolean,
  isStopped: () => boolean,
  retryMs: number,
  cooldownMs: number,
  setTimer: (timer: NodeJS.Timeout | null) => void,
  onCooldownDone: () => void
): Promise<void> {
  if (isStopped()) return;
  if (!isActive()) return;

  if (!isWorking()) {
    if (isStopped()) return;

    await action();

    if (!isStopped()) {
      setTimer(
        setTimeout(() => {
          if (isStopped()) return;
          setTimer(null);
          onCooldownDone();
        }, cooldownMs)
      );
    }
  } else {
    if (!isStopped()) {
      setTimer(
        setTimeout(
          () => executeWhenIdle(action, isActive, isWorking, isStopped, retryMs, cooldownMs, setTimer, onCooldownDone),
          retryMs
        )
      );
    }
  }
}

// ============================================================================
// Auto-resume (usage-limit pause) constants
// ============================================================================

/** Safety buffer after the stated reset time before resuming (2 minutes) */
const RESUME_BUFFER_MS = 2 * 60_000;

/** Minimum delay before an overdue resume fires (lets output settle) */
const RESUME_MIN_DELAY_MS = 5_000;

/** Retry interval when the reset time is stale/past (5 minutes) */
const RESUME_RETRY_MS = 5 * 60_000;

/** Re-detections scheduling within this window of the current schedule are ignored */
const RESUME_DEDUP_TOLERANCE_MS = 90_000;

/** Delay between Escape (dialog dismiss) and the resume prompt */
const RESUME_ESC_DELAY_MS = 600;

/** Prompt sent to resume work after the limit resets */
const RESUME_PROMPT = 'continue';

// ============================================================================
// Checkpoint (agent-initiated compact, clear, or new, then continue) constants
// ============================================================================

/** Poll interval while driving a checkpoint sequence (prompt/working transitions) */
const CHECKPOINT_POLL_MS = 500;

/** Maximum wait for a positive rendered input prompt before a checkpoint step. */
const CHECKPOINT_READY_TIMEOUT_MS = 30_000;

/**
 * How long to wait for an op to START (working transition) after sending its
 * command. Remaining at the same prompt for this entire window is a failure.
 */
const CHECKPOINT_OP_START_TIMEOUT_MS = 8000;

/** Safety cap on how long to wait for an op to FINISH before failing. */
const CHECKPOINT_OP_MAX_MS = 180000;

/** Minimum valid threshold for auto-clear/compact (1000 tokens) */
const MIN_AUTO_THRESHOLD = 1000;

/** Maximum valid threshold for auto-clear/compact (500k tokens) */
const MAX_AUTO_THRESHOLD = 500_000;

/** Default auto-clear threshold when invalid value provided */
const DEFAULT_AUTO_CLEAR_THRESHOLD = 140_000;

/** Default auto-compact threshold when invalid value provided */
const DEFAULT_AUTO_COMPACT_THRESHOLD = 110_000;

/**
 * Callbacks required by SessionAutoOps to interact with the parent Session.
 */
export interface CheckpointObservation {
  /** A positively identified, mode-specific rendered input prompt is visible. */
  ready: boolean;
  /** Existing mode-aware working evidence is visible/active. */
  working: boolean;
  /** Semantic prompt generation; advances only after leaving and returning to ready. */
  revision: number;
  /** Authoritative backend conversation identity, when one is safely known. */
  conversationId?: string;
}

export type CheckpointMode = 'compact' | 'clear' | 'new';
export type CheckpointStep = CheckpointMode | 'continue';
export type CheckpointPhase =
  | 'requested'
  | 'waiting-ready'
  | 'command-submitted'
  | 'operation-started'
  | 'operation-complete'
  | 'continue-submitted'
  | 'done'
  | 'failed'
  | 'aborted';

export interface CheckpointProgress {
  runId: string;
  mode: CheckpointMode;
  phase: CheckpointPhase;
  step?: CheckpointStep;
  attempt?: number;
  stage?: CommandDeliveryStage;
  reason?: string;
  updatedAt: number;
}

export interface CheckpointState extends CheckpointProgress {
  active: boolean;
  status: 'requested' | 'running' | 'completed' | 'cancelled' | 'failed';
  lastObservation?: CheckpointObservation;
}

interface AutoOpsCallbacks {
  /** Send a command via the terminal multiplexer */
  writeCommand: (command: string) => Promise<boolean>;
  /** Deliver a checkpoint command with stage-aware acknowledgement. */
  writeCheckpointCommand?: (command: string) => Promise<CommandDeliveryResult>;
  /** Return positive prompt/working evidence for checkpoint sequencing. */
  getCheckpointObservation?: () => CheckpointObservation | Promise<CheckpointObservation>;
  /** Immutable configured backend. Checkpoint capability is never inferred from terminal text. */
  getCheckpointBackendMode?: () => string;
  /** Optional fail-closed backend/mode capability reason. */
  getCheckpointCapabilityReason?: (mode: CheckpointMode) => string | undefined;
  /** Check if Claude is currently working */
  isWorking: () => boolean;
  /** Check if the session has been stopped */
  isStopped: () => boolean;
  /** Get current total token count (input + output) */
  getTotalTokens: () => number;
  /** Get session ID for logging */
  getSessionId: () => string;
}

/**
 * Events emitted by SessionAutoOps.
 */

/**
 * Manages auto-compact and auto-clear automation for a Session.
 *
 * When enabled, monitors token counts after each update and triggers
 * /compact or /clear commands when thresholds are exceeded. Ensures
 * mutual exclusion between compact and clear operations.
 */
export class SessionAutoOps extends EventEmitter {
  // Auto-compact state
  private _autoCompactThreshold: number;
  private _autoCompactEnabled: boolean = false;
  private _autoCompactPrompt: string = '';
  private _isCompacting: boolean = false;
  private _autoCompactTimer: NodeJS.Timeout | null = null;

  // Auto-clear state
  private _autoClearThreshold: number;
  private _autoClearEnabled: boolean = false;
  private _isClearing: boolean = false;
  private _autoClearTimer: NodeJS.Timeout | null = null;

  // Auto-resume (usage-limit pause) state
  private _autoResumeEnabled: boolean = false;
  private _autoResumeTimer: NodeJS.Timeout | null = null;
  /** Esc→continue gap timer; detections must NOT cancel a resume in flight */
  private _resumeFollowupTimer: NodeJS.Timeout | null = null;
  /** When the scheduled resume fires (epoch ms), null when not armed */
  private _autoResumeAt: number | null = null;
  private _limitPaused: boolean = false;
  private _resumeAttempts: number = 0;

  // Checkpoint (agent-initiated compact, clear, or new, then continue) state
  private _checkpointEnabled: boolean = false;
  /**
   * Modes the agent is allowed to invoke at signal time. All are allowed by
   * default; the operator may forbid any (e.g. allow compact, forbid the more
   * destructive clear/new). compact is the fallback when the agent passes no -m.
   */
  private _checkpointModes: Set<CheckpointMode> = new Set(['compact', 'clear', 'new']);
  private _checkpointActive: boolean = false;
  private _checkpointTimer: NodeJS.Timeout | null = null;
  private _checkpointRunId: string | undefined;
  private _checkpointState: CheckpointState | undefined;
  private readonly _checkpointStates = new Map<string, CheckpointState>();

  private readonly callbacks: AutoOpsCallbacks;

  constructor(callbacks: AutoOpsCallbacks, config?: { compactThreshold?: number; clearThreshold?: number }) {
    super();
    this.callbacks = callbacks;
    this._autoCompactThreshold = config?.compactThreshold ?? DEFAULT_AUTO_COMPACT_THRESHOLD;
    this._autoClearThreshold = config?.clearThreshold ?? DEFAULT_AUTO_CLEAR_THRESHOLD;
  }

  // ============================================================================
  // Auto-compact getters/setters
  // ============================================================================

  get autoCompactThreshold(): number {
    return this._autoCompactThreshold;
  }

  get autoCompactEnabled(): boolean {
    return this._autoCompactEnabled;
  }

  get autoCompactPrompt(): string {
    return this._autoCompactPrompt;
  }

  get isCompacting(): boolean {
    return this._isCompacting;
  }

  setAutoCompact(enabled: boolean, threshold?: number, prompt?: string): void {
    this._autoCompactEnabled = enabled;
    if (threshold !== undefined) {
      if (threshold < MIN_AUTO_THRESHOLD || threshold > MAX_AUTO_THRESHOLD) {
        console.warn(
          `[SessionAutoOps ${this.callbacks.getSessionId()}] Invalid autoCompact threshold ${threshold}, must be between ${MIN_AUTO_THRESHOLD} and ${MAX_AUTO_THRESHOLD}. Using default ${DEFAULT_AUTO_COMPACT_THRESHOLD}.`
        );
        this._autoCompactThreshold = DEFAULT_AUTO_COMPACT_THRESHOLD;
      } else {
        this._autoCompactThreshold = threshold;
      }
    }
    if (prompt !== undefined) {
      this._autoCompactPrompt = prompt;
    }
  }

  // ============================================================================
  // Auto-clear getters/setters
  // ============================================================================

  get autoClearThreshold(): number {
    return this._autoClearThreshold;
  }

  get autoClearEnabled(): boolean {
    return this._autoClearEnabled;
  }

  get isClearing(): boolean {
    return this._isClearing;
  }

  setAutoClear(enabled: boolean, threshold?: number): void {
    this._autoClearEnabled = enabled;
    if (threshold !== undefined) {
      if (threshold < MIN_AUTO_THRESHOLD || threshold > MAX_AUTO_THRESHOLD) {
        console.warn(
          `[SessionAutoOps ${this.callbacks.getSessionId()}] Invalid autoClear threshold ${threshold}, must be between ${MIN_AUTO_THRESHOLD} and ${MAX_AUTO_THRESHOLD}. Using default ${DEFAULT_AUTO_CLEAR_THRESHOLD}.`
        );
        this._autoClearThreshold = DEFAULT_AUTO_CLEAR_THRESHOLD;
      } else {
        this._autoClearThreshold = threshold;
      }
    }
  }

  // ============================================================================
  // Auto-resume (usage-limit pause) — getters/setters
  // ============================================================================

  get autoResumeEnabled(): boolean {
    return this._autoResumeEnabled;
  }

  /** When the scheduled resume fires (epoch ms), or null when not armed. */
  get autoResumeAt(): number | null {
    return this._autoResumeAt;
  }

  /** True while the session is believed to be paused on a usage limit. */
  get isLimitPaused(): boolean {
    return this._limitPaused;
  }

  setAutoResume(enabled: boolean): void {
    this._autoResumeEnabled = enabled;
    if (!enabled) {
      this._cancelAutoResume('disabled');
    }
  }

  /**
   * Restore auto-resume state after a Codeman restart. A persisted pending
   * schedule is re-armed; an overdue one fires shortly after boot (the limit
   * footer won't reprint on its own, so without this the pause would stall).
   */
  restoreAutoResume(enabled: boolean, resumeAt?: number): void {
    this._autoResumeEnabled = enabled;
    if (!enabled || !resumeAt) return;
    const now = Date.now();
    this._scheduleResume(Math.max(resumeAt, now + RESUME_MIN_DELAY_MS), resumeAt, 'restored');
  }

  // ============================================================================
  // Auto-resume — detection and scheduling
  // ============================================================================

  /**
   * Scan cleaned terminal output for a usage-limit pause message and (re)arm
   * the resume schedule. Called from the session's throttled parser path.
   */
  processCleanData(cleanData: string): void {
    if (!this._autoResumeEnabled || this.callbacks.isStopped()) return;
    // A resume is in flight (Esc sent, continue pending): output from our own
    // Escape can redraw the stale limit footer — don't let it re-arm and
    // cancel the continue. Fresh evidence arrives after the prompt is sent.
    if (this._resumeFollowupTimer) return;

    const detection = detectUsageLimitPause(cleanData);
    if (!detection) return;

    const now = Date.now();
    const overdue = detection.resetAt <= now;
    const fireAt = overdue
      ? now + RESUME_RETRY_MS // stale reset time → gentle retry loop
      : Math.max(detection.resetAt + RESUME_BUFFER_MS, now + RESUME_MIN_DELAY_MS);

    if (this._autoResumeTimer && this._autoResumeAt !== null) {
      // Already armed: the footer redraws constantly, so ignore re-detections
      // that land on (or later than) the current schedule. Only an EARLIER
      // parsed time replaces it — an overdue retry never preempts a real one.
      if (overdue || fireAt >= this._autoResumeAt - RESUME_DEDUP_TOLERANCE_MS) return;
    }

    this._scheduleResume(fireAt, detection.resetAt, detection.matched);
  }

  /**
   * Claude started working — the limit is lifted (or the user resumed
   * manually), so any pending auto-resume is obsolete.
   */
  notifyWorking(): void {
    this._resumeAttempts = 0;
    if (!this._limitPaused && !this._autoResumeTimer && !this._resumeFollowupTimer) return;
    this._cancelAutoResume('working');
  }

  private _scheduleResume(fireAt: number, resetAt: number, matched: string): void {
    if (this._autoResumeTimer) {
      clearTimeout(this._autoResumeTimer);
      this._autoResumeTimer = null;
    }
    this._limitPaused = true;
    this._autoResumeAt = fireAt;
    const delay = Math.max(fireAt - Date.now(), 0);
    console.log(
      `[SessionAutoOps ${this.callbacks.getSessionId()}] Usage-limit pause detected ("${matched.slice(0, 60)}"), auto-resume in ${Math.round(delay / 60000)}min`
    );
    this._autoResumeTimer = setTimeout(() => void this._fireResume(), delay);
    this.emit('limitPauseScheduled', { resetAt, resumeAt: fireAt, matched });
  }

  private async _fireResume(): Promise<void> {
    this._autoResumeTimer = null;
    if (!this._autoResumeEnabled || this.callbacks.isStopped()) return;

    if (this.callbacks.isWorking()) {
      // Session resumed on its own (or via the user) — nothing to do.
      this._cancelAutoResume('working');
      return;
    }

    this._resumeAttempts++;
    const attempt = this._resumeAttempts;
    this._limitPaused = false; // optimistic: a fresh limit message re-arms us
    this._autoResumeAt = null;

    // Escape first: dismisses the rate-limit options dialog if Claude opened
    // one (harmless at an idle prompt), then the resume prompt after a beat.
    await this.callbacks.writeCommand('\x1b');
    this._resumeFollowupTimer = setTimeout(() => {
      this._resumeFollowupTimer = null;
      if (this.callbacks.isStopped()) return;
      void this.callbacks.writeCommand(`${RESUME_PROMPT}\r`);
      this.emit('limitResume', { attempt });
    }, RESUME_ESC_DELAY_MS);
  }

  private _cancelAutoResume(reason: 'disabled' | 'working' | 'stopped'): void {
    const wasArmed = this._autoResumeTimer !== null || this._resumeFollowupTimer !== null || this._limitPaused;
    if (this._autoResumeTimer) {
      clearTimeout(this._autoResumeTimer);
      this._autoResumeTimer = null;
    }
    if (this._resumeFollowupTimer) {
      clearTimeout(this._resumeFollowupTimer);
      this._resumeFollowupTimer = null;
    }
    this._limitPaused = false;
    this._autoResumeAt = null;
    if (wasArmed && reason !== 'stopped') {
      this.emit('limitResumeCancelled', { reason });
    }
  }

  // ============================================================================
  // Checkpoint (agent-initiated compact, clear, or new, then continue)
  // ============================================================================

  get checkpointEnabled(): boolean {
    return this._checkpointEnabled;
  }

  /** Allowed checkpoint modes, in stable order. */
  get checkpointModes(): CheckpointMode[] {
    return (['compact', 'clear', 'new'] as const).filter((m) => this._checkpointModes.has(m));
  }

  /**
   * The mode a bare checkpoint (no -m) runs: compact when allowed, else clear.
   * Retained for backward-compatible persisted state (legacy `checkpointMode`).
   */
  get checkpointMode(): CheckpointMode {
    return this._checkpointModes.has('compact')
      ? 'compact'
      : this._checkpointModes.has('clear')
        ? 'clear'
        : this._checkpointModes.has('new')
          ? 'new'
          : 'compact';
  }

  get isCheckpointActive(): boolean {
    return this._checkpointActive;
  }

  /** Exact active run identity used to fence async delivery preparation. */
  get activeCheckpointRunId(): string | undefined {
    return this._checkpointActive ? this._checkpointRunId : undefined;
  }

  /** Durable last-known checkpoint state. Terminal records remain queryable. */
  get checkpointState(): CheckpointState | undefined {
    return this._checkpointState ? { ...this._checkpointState } : undefined;
  }

  /** Bounded run-keyed history so external waiters cannot follow a newer run by mistake. */
  get checkpointStates(): Record<string, CheckpointState> {
    return Object.fromEntries([...this._checkpointStates].map(([runId, state]) => [runId, { ...state }]));
  }

  /**
   * Enable/disable agent-initiated checkpoints; optionally set which modes the
   * agent may invoke. Pass `[]` to allow nothing (checkpoint becomes a no-op
   * until a mode is re-enabled). Omit `modes` to leave the allowed set unchanged.
   */
  setCheckpoint(enabled: boolean, modes?: CheckpointMode[]): void {
    this._checkpointEnabled = enabled;
    if (modes !== undefined) {
      this._checkpointModes = new Set(modes);
    }
  }

  /**
   * Restore persisted checkpoint enable/allowed-modes after a Codeman restart.
   * Unlike auto-resume there is no pending action to re-arm — checkpoints are
   * agent-triggered, not time-scheduled — so this only restores the flags. A
   * legacy session with no saved `checkpointModes` keeps the default (both
   * allowed), matching pre-COD-112 behavior where any requested mode ran.
   */
  restoreCheckpoint(enabled: boolean, modes?: CheckpointMode[]): void {
    this._checkpointEnabled = enabled;
    if (modes !== undefined) {
      this._checkpointModes = new Set(modes);
    }
  }

  /** Restore only the last-known status; never resume an in-flight sequence. */
  restoreCheckpointState(
    state?: Omit<CheckpointState, 'runId' | 'status'> & Partial<Pick<CheckpointState, 'runId' | 'status'>>
  ): void {
    if (!state) return;
    this._checkpointState = this._normalizeRestoredCheckpointState(state);
    this._checkpointActive = false;
    this._rememberCheckpointState(this._checkpointState);
  }

  /** Restore bounded history without resuming or replaying any run. */
  restoreCheckpointStates(states?: Record<string, CheckpointState>): void {
    if (!states) return;
    for (const state of Object.values(states).slice(-20)) {
      this._rememberCheckpointState(this._normalizeRestoredCheckpointState(state));
    }
  }

  private _normalizeRestoredCheckpointState(
    state: Omit<CheckpointState, 'runId' | 'status'> & Partial<Pick<CheckpointState, 'runId' | 'status'>>
  ): CheckpointState {
    const runId = state.runId || `legacy-${state.updatedAt}`;
    const status = state.active
      ? 'cancelled'
      : state.phase === 'done'
        ? 'completed'
        : state.phase === 'failed'
          ? 'failed'
          : 'cancelled';
    return state.active
      ? {
          ...state,
          runId,
          status,
          active: false,
          phase: 'aborted',
          reason: 'restarted',
          updatedAt: Date.now(),
        }
      : { ...state, runId, status: state.status ?? status, active: false };
  }

  /**
   * Agent signal at a clean boundary: run the selected checkpoint op and,
   * ONLY after it completes, send a continue prompt. Returns
   * whether the sequence was triggered (and if not, why).
   */
  requestCheckpoint(opts?: { mode?: CheckpointMode; continuePrompt?: string }): {
    triggered: boolean;
    runId?: string;
    reason?: string;
  } {
    if (!this._checkpointEnabled) return { triggered: false, reason: 'not-enabled' };
    if (this.callbacks.isStopped()) return { triggered: false, reason: 'stopped' };
    if (this._isCompacting || this._isClearing || this._checkpointActive) {
      return { triggered: false, reason: 'busy' };
    }

    // Resolve the mode, gated by the operator's allowed set. An explicit -m that
    // the operator forbade is refused; with no -m, compact is the default (then
    // clear) — so a bare checkpoint always runs an allowed mode if one exists.
    let mode: CheckpointMode;
    if (opts?.mode !== undefined) {
      if (!this._checkpointModes.has(opts.mode)) {
        return { triggered: false, reason: 'mode-not-allowed' };
      }
      mode = opts.mode;
    } else if (this._checkpointModes.has('compact')) {
      mode = 'compact';
    } else if (this._checkpointModes.has('clear')) {
      mode = 'clear';
    } else if (this._checkpointModes.has('new')) {
      mode = 'new';
    } else {
      return { triggered: false, reason: 'no-mode-allowed' };
    }

    const backend = this.callbacks.getCheckpointBackendMode?.();
    if (backend !== undefined && backend !== 'codex' && backend !== 'claude') {
      return { triggered: false, reason: 'unsupported-backend' };
    }
    const capabilityReason = this.callbacks.getCheckpointCapabilityReason?.(mode);
    if (capabilityReason) return { triggered: false, reason: capabilityReason };

    this._checkpointActive = true;
    const runId = randomUUID();
    this._checkpointRunId = runId;
    const continueText = opts?.continuePrompt?.trim() || RESUME_PROMPT;

    this.emit('checkpointStart', { mode, runId });
    this._transition(runId, mode, 'requested');
    void this._runCheckpoint(runId, continueText, mode);
    return { triggered: true, runId };
  }

  /** Cancel pending automated checkpoint writes at a user-input boundary. */
  cancelCheckpoint(reason = 'manual-takeover'): void {
    if (!this._checkpointActive || !this._checkpointState || !this._checkpointRunId) return;
    this._finishCheckpoint(this._checkpointRunId, this._checkpointState.mode, 'aborted', {
      step: this._checkpointState.step,
      reason,
    });
  }

  /**
   * Drive the checkpoint step sequence: for each step, wait for idle, send the
   * command, wait for the op to start (working) then finish (idle), and only
   * then move on. After the last step, send the continue prompt.
   */
  private async _runCheckpoint(runId: string, continueText: string, mode: CheckpointMode): Promise<void> {
    try {
      const step = mode;
      this._transition(runId, mode, 'waiting-ready', { step });
      const baselineResult = await this._waitForObservation(
        runId,
        (observation) => observation.ready && (mode === 'compact' || Boolean(observation.conversationId)),
        CHECKPOINT_READY_TIMEOUT_MS
      );
      if (
        !this._handleWaitResult(
          baselineResult,
          runId,
          mode,
          step,
          mode === 'compact' ? 'readiness-timeout' : 'baseline-identity-unavailable'
        )
      )
        return;
      const baseline = baselineResult.observation;

      if (!this._ensureActive(runId, mode, step)) return;
      const delivery = await this._deliverCheckpointCommand(`/${mode}\r`);
      if (!this._ensureActive(runId, mode, step)) return;
      if (!delivery.ok) {
        this._finishCheckpoint(runId, mode, 'failed', {
          step,
          reason: 'delivery-failed',
          stage: delivery.stage,
          attempt: delivery.attempt ?? 1,
        });
        return;
      }
      this._transition(runId, mode, 'command-submitted', { step, attempt: delivery.attempt ?? 1 });

      if (mode === 'compact') {
        const accepted = await this._waitForObservation(
          runId,
          (observation) => observation.working || !observation.ready,
          CHECKPOINT_OP_START_TIMEOUT_MS
        );
        if (!this._handleWaitResult(accepted, runId, mode, step, 'operation-not-accepted')) return;
        this._transition(runId, mode, 'operation-started', { step });
        const completed = await this._waitForObservation(
          runId,
          (observation) => observation.ready && observation.revision > baseline.revision,
          CHECKPOINT_OP_MAX_MS
        );
        if (!this._handleWaitResult(completed, runId, mode, step, 'operation-timeout')) return;
      } else {
        // Fresh-thread commands are asynchronous. A terminal repaint or prompt
        // revision in the old conversation is never acceptance evidence.
        const completed = await this._waitForObservation(
          runId,
          (observation) =>
            Boolean(observation.conversationId) &&
            observation.conversationId !== baseline.conversationId &&
            observation.ready,
          CHECKPOINT_OP_MAX_MS
        );
        if (!this._handleWaitResult(completed, runId, mode, step, 'fresh-thread-timeout')) return;
        this._transition(runId, mode, 'operation-started', { step });
      }
      this._transition(runId, mode, 'operation-complete', { step });

      if (!this._ensureActive(runId, mode, 'continue')) return;
      const continuation = await this._deliverCheckpointCommand(`${continueText}\r`);
      if (!this._ensureActive(runId, mode, 'continue')) return;
      if (!continuation.ok) {
        this._finishCheckpoint(runId, mode, 'failed', {
          step: 'continue',
          reason: 'continuation-delivery-failed',
          stage: continuation.stage,
          attempt: continuation.attempt ?? 1,
        });
        return;
      }
      this._transition(runId, mode, 'continue-submitted', {
        step: 'continue',
        attempt: continuation.attempt ?? 1,
      });

      const started = await this._waitForObservation(
        runId,
        (observation) => observation.working,
        CHECKPOINT_OP_START_TIMEOUT_MS
      );
      if (!this._handleWaitResult(started, runId, mode, 'continue', 'continuation-not-started')) return;
      if (!this._ensureActive(runId, mode, 'continue')) return;

      this._finishCheckpoint(runId, mode, 'done');
      this.emit('checkpointDone', { mode, runId });
    } catch (err) {
      if (this._checkpointActive && runId === this._checkpointRunId) {
        this._finishCheckpoint(runId, mode, 'failed', {
          reason: `unexpected-error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  private async _checkpointObservation(): Promise<CheckpointObservation> {
    if (this.callbacks.getCheckpointObservation) return await this.callbacks.getCheckpointObservation();
    // Explicit compatibility fallback for callers not yet supplying the probe.
    const working = this.callbacks.isWorking();
    return { ready: !working, working, revision: 0 };
  }

  private async _deliverCheckpointCommand(command: string): Promise<CommandDeliveryResult> {
    if (this.callbacks.writeCheckpointCommand) return this.callbacks.writeCheckpointCommand(command);
    const ok = await this.callbacks.writeCommand(command);
    return ok ? { ok: true, attempt: 1 } : { ok: false, stage: 'text', attempt: 1 };
  }

  private _waitForObservation(
    runId: string,
    predicate: (observation: CheckpointObservation) => boolean,
    timeoutMs: number
  ): Promise<
    | { kind: 'matched'; observation: CheckpointObservation }
    | { kind: 'timeout' }
    | { kind: 'aborted'; reason: 'stopped' | 'cancelled' }
  > {
    const startedAt = Date.now();
    return new Promise((resolve) => {
      const poll = async (): Promise<void> => {
        this._checkpointTimer = null;
        if (runId !== this._checkpointRunId || !this._checkpointActive) {
          resolve({ kind: 'aborted', reason: 'cancelled' });
          return;
        }
        if (this.callbacks.isStopped()) {
          resolve({ kind: 'aborted', reason: 'stopped' });
          return;
        }
        const observation = await this._checkpointObservation();
        if (runId !== this._checkpointRunId || !this._checkpointActive) {
          resolve({ kind: 'aborted', reason: 'cancelled' });
          return;
        }
        if (this._checkpointState) {
          this._checkpointState.lastObservation = observation;
          this._rememberCheckpointState(this._checkpointState);
        }
        if (predicate(observation)) {
          resolve({ kind: 'matched', observation });
          return;
        }
        if (Date.now() - startedAt >= timeoutMs) {
          resolve({ kind: 'timeout' });
          return;
        }
        this._checkpointTimer = setTimeout(() => void poll(), CHECKPOINT_POLL_MS);
      };
      void poll();
    });
  }

  private _handleWaitResult(
    result:
      | { kind: 'matched'; observation: CheckpointObservation }
      | { kind: 'timeout' }
      | { kind: 'aborted'; reason: 'stopped' | 'cancelled' },
    runId: string,
    mode: CheckpointMode,
    step: CheckpointStep,
    timeoutReason: string
  ): result is { kind: 'matched'; observation: CheckpointObservation } {
    if (result.kind === 'matched') return this._ensureActive(runId, mode, step);
    if (result.kind === 'timeout') {
      this._finishCheckpoint(runId, mode, 'failed', { step, reason: timeoutReason });
    } else if (result.reason === 'stopped' && runId === this._checkpointRunId && this._checkpointActive) {
      this._finishCheckpoint(runId, mode, 'aborted', { step, reason: 'stopped' });
    }
    return false;
  }

  private _ensureActive(runId: string, mode: CheckpointMode, step: CheckpointStep): boolean {
    if (runId !== this._checkpointRunId || !this._checkpointActive) return false;
    if (this.callbacks.isStopped()) {
      this._finishCheckpoint(runId, mode, 'aborted', { step, reason: 'stopped' });
      return false;
    }
    return true;
  }

  private _transition(
    runId: string,
    mode: CheckpointMode,
    phase: CheckpointPhase,
    details: Omit<Partial<CheckpointProgress>, 'mode' | 'phase' | 'updatedAt'> = {}
  ): void {
    const updatedAt = Date.now();
    const progress: CheckpointProgress = { runId, mode, phase, ...details, updatedAt };
    const status =
      phase === 'requested'
        ? 'requested'
        : phase === 'done'
          ? 'completed'
          : phase === 'failed'
            ? 'failed'
            : phase === 'aborted'
              ? 'cancelled'
              : 'running';
    this._checkpointState = {
      active: phase !== 'done' && phase !== 'failed' && phase !== 'aborted',
      status,
      lastObservation: this._checkpointState?.lastObservation,
      ...progress,
    };
    this._rememberCheckpointState(this._checkpointState);
    this.emit('checkpointProgress', progress);
    console.log(
      `[SessionAutoOps ${this.callbacks.getSessionId()}] checkpoint ${phase}${details.step ? ` step=${details.step}` : ''}${details.reason ? ` reason=${details.reason}` : ''}`
    );
  }

  private _rememberCheckpointState(state: CheckpointState): void {
    this._checkpointStates.set(state.runId, { ...state });
    while (this._checkpointStates.size > 20) {
      const oldest = this._checkpointStates.keys().next().value;
      if (oldest === undefined) break;
      this._checkpointStates.delete(oldest);
    }
  }

  private _finishCheckpoint(
    runId: string,
    mode: CheckpointMode,
    phase: Extract<CheckpointPhase, 'done' | 'failed' | 'aborted'>,
    details: Omit<Partial<CheckpointProgress>, 'mode' | 'phase' | 'updatedAt'> = {}
  ): void {
    if (this._checkpointTimer) {
      clearTimeout(this._checkpointTimer);
      this._checkpointTimer = null;
    }
    this._checkpointActive = false;
    this._transition(runId, mode, phase, details);
  }

  // ============================================================================
  // Threshold checks
  // ============================================================================

  /**
   * Check if auto-compact should be triggered based on current token count.
   * Called after token count updates.
   */
  checkAutoCompact(): void {
    if (this.callbacks.isStopped()) return;
    if (!this._autoCompactEnabled || this._isCompacting || this._isClearing || this._checkpointActive) return;

    const totalTokens = this.callbacks.getTotalTokens();
    if (totalTokens >= this._autoCompactThreshold) {
      this._isCompacting = true;
      console.log(
        `[SessionAutoOps] Auto-compact triggered: ${totalTokens} tokens >= ${this._autoCompactThreshold} threshold`
      );

      const action = async () => {
        const compactCmd = this._autoCompactPrompt ? `/compact ${this._autoCompactPrompt}\r` : '/compact\r';
        await this.callbacks.writeCommand(compactCmd);
        this.emit('autoCompact', {
          tokens: totalTokens,
          threshold: this._autoCompactThreshold,
          prompt: this._autoCompactPrompt || undefined,
        });
      };

      if (!this.callbacks.isStopped()) {
        this._autoCompactTimer = setTimeout(
          () =>
            executeWhenIdle(
              action,
              () => this._isCompacting,
              () => this.callbacks.isWorking(),
              () => this.callbacks.isStopped(),
              AUTO_RETRY_DELAY_MS,
              COMPACT_COOLDOWN_MS,
              (timer) => {
                this._autoCompactTimer = timer;
              },
              () => {
                this._isCompacting = false;
              }
            ),
          AUTO_INITIAL_DELAY_MS
        );
      }
    }
  }

  /**
   * Check if auto-clear should be triggered based on current token count.
   * Called after token count updates.
   */
  checkAutoClear(): void {
    if (this.callbacks.isStopped()) return;
    if (!this._autoClearEnabled || this._isClearing || this._isCompacting || this._checkpointActive) return;

    const totalTokens = this.callbacks.getTotalTokens();
    if (totalTokens >= this._autoClearThreshold) {
      this._isClearing = true;
      console.log(
        `[SessionAutoOps] Auto-clear triggered: ${totalTokens} tokens >= ${this._autoClearThreshold} threshold`
      );

      const action = async () => {
        await this.callbacks.writeCommand('/clear\r');
        this.emit('autoClear', { tokens: totalTokens, threshold: this._autoClearThreshold });
      };

      if (!this.callbacks.isStopped()) {
        this._autoClearTimer = setTimeout(
          () =>
            executeWhenIdle(
              action,
              () => this._isClearing,
              () => this.callbacks.isWorking(),
              () => this.callbacks.isStopped(),
              AUTO_RETRY_DELAY_MS,
              CLEAR_COOLDOWN_MS,
              (timer) => {
                this._autoClearTimer = timer;
              },
              () => {
                this._isClearing = false;
              }
            ),
          AUTO_INITIAL_DELAY_MS
        );
      }
    }
  }

  // ============================================================================
  // Cleanup
  // ============================================================================

  /**
   * Clear all timers and reset state. Called when the session stops.
   */
  destroy(): void {
    if (this._autoCompactTimer) {
      clearTimeout(this._autoCompactTimer);
      this._autoCompactTimer = null;
    }
    this._isCompacting = false;

    if (this._autoClearTimer) {
      clearTimeout(this._autoClearTimer);
      this._autoClearTimer = null;
    }
    this._isClearing = false;

    if (this._checkpointActive && this._checkpointState) {
      this._finishCheckpoint(this._checkpointState.runId, this._checkpointState.mode, 'aborted', {
        step: this._checkpointState.step,
        reason: 'destroyed',
      });
    } else if (this._checkpointTimer) {
      clearTimeout(this._checkpointTimer);
      this._checkpointTimer = null;
    }
    this._checkpointRunId = undefined;

    this._cancelAutoResume('stopped');
  }
}
