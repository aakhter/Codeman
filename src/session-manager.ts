/**
 * @fileoverview Session Manager for coordinating multiple Claude sessions.
 *
 * Lifecycle management for Claude CLI sessions:
 * - Session creation with working directory, concurrent session limits (mutex-guarded)
 * - Event forwarding from individual sessions to subscribers
 * - State persistence via StateStore
 * - Graceful shutdown of all sessions
 *
 * Key exports:
 * - `SessionManager` class — coordinator, extends EventEmitter
 * - `SessionManagerEvents` interface — typed event map
 * - `getSessionManager()` — singleton accessor
 *
 * Key methods: `createSession(workingDir)`, `getSession(id)`, `getAllSessions()`,
 * `removeSession(id)`, `stopAll()`
 *
 * @dependencies session (Session class), state-store (persistence), types (SessionState)
 * @consumedby web/server, ralph-loop, respawn-controller
 * @emits sessionStarted, sessionStopped, sessionError, sessionOutput, sessionCompletion
 *
 * @module session-manager
 */

import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { Session } from './session.js';
import { getStore } from './state-store.js';
import { SessionState } from './types.js';
import { dataPath } from './config/instance.js';
import { normalizeSettingsObject } from './config/settings.js';
import { verifyClaudeSessionStartHookCapability } from './hooks-config.js';

/**
 * Events emitted by SessionManager
 */

/**
 * Manages multiple Claude sessions with lifecycle coordination.
 *
 * @description
 * SessionManager acts as a coordinator for multiple Claude CLI sessions:
 * - Enforces concurrent session limits from config
 * - Forwards session events to subscribers
 * - Persists session state to disk
 * - Handles graceful shutdown
 *
 * @extends EventEmitter
 * @fires SessionManagerEvents.sessionStarted
 * @fires SessionManagerEvents.sessionStopped
 * @fires SessionManagerEvents.sessionError
 * @fires SessionManagerEvents.sessionOutput
 * @fires SessionManagerEvents.sessionCompletion
 */
/** Stored event handlers for a session, used for cleanup */
interface SessionHandlers {
  output: (data: string) => void;
  error: (data: string) => void;
  completion: (phrase: string) => void;
  exit: () => void;
  taskError: (taskId: string, error: string) => void;
}

export class SessionManager extends EventEmitter {
  private sessions: Map<string, Session> = new Map();
  private sessionHandlers: Map<string, SessionHandlers> = new Map();
  private store = getStore();

  // Mutex for session creation to prevent race conditions
  private _sessionCreationLock: Promise<void> | null = null;

  /**
   * Creates a new SessionManager and loads previous session state.
   */
  constructor() {
    super();
    this.loadFromStore();
  }

  /** COD-257: CLI-created sessions use the same settings.json authority as web sessions. */
  private async getCheckpointDefaultEnabled(): Promise<boolean> {
    try {
      const settings = normalizeSettingsObject(JSON.parse(await readFile(dataPath('settings.json'), 'utf-8')));
      return settings.checkpointDefaultEnabled !== false;
    } catch {
      return true;
    }
  }

  private loadFromStore(): void {
    const storedSessions = this.store.getSessions();
    // Note: We don't restore actual processes, just the state
    // Dead sessions are marked as stopped. COD-124: 'parked' sessions are
    // exempt — they intentionally have no live process (that's the point of
    // parking) but must survive a reboot as 'parked' so their preserved
    // resumeSessionId/workingDir can still be resumed later. Force-resetting
    // them to 'stopped' here would silently discard that resumability.
    for (const [id, state] of Object.entries(storedSessions)) {
      if (state.status !== 'stopped' && state.status !== 'parked') {
        state.status = 'stopped';
        state.pid = null;
        this.store.setSession(id, state);
      }
    }
  }

  /**
   * Creates and starts a new Claude session.
   * Uses mutex to prevent race conditions when multiple requests arrive simultaneously.
   *
   * @param workingDir - Working directory for the session
   * @returns The newly created session
   * @throws Error if max concurrent sessions limit reached
   */
  async createSession(workingDir: string): Promise<Session> {
    // Wait for any pending session creation to complete (mutex pattern)
    while (this._sessionCreationLock) {
      await this._sessionCreationLock;
    }

    // Create a new lock promise that others will wait on
    // Define unlock first to ensure it's always in scope before promise assignment
    let unlock!: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    this._sessionCreationLock = lockPromise;

    try {
      const config = this.store.getConfig();

      // Check limit INSIDE the lock to prevent race conditions
      if (this.sessions.size >= config.maxConcurrentSessions) {
        throw new Error(`Maximum concurrent sessions (${config.maxConcurrentSessions}) reached`);
      }

      const session = new Session({
        workingDir,
        checkpointEnabled: await this.getCheckpointDefaultEnabled(),
        claudeSessionStartHookReady: await verifyClaudeSessionStartHookCapability('claude', workingDir, false),
      });

      // Set up event forwarding with stored handlers for cleanup
      const handlers: SessionHandlers = {
        output: (data: string) => {
          this.emit('sessionOutput', session.id, data);
          this.updateSessionState(session);
        },
        error: (data: string) => {
          this.emit('sessionError', session.id, data);
          this.updateSessionState(session);
        },
        completion: (phrase: string) => {
          this.emit('sessionCompletion', session.id, phrase);
        },
        exit: () => {
          this.emit('sessionStopped', session.id);
          this.updateSessionState(session);
        },
        taskError: (taskId: string, error: string) => {
          this.emit('sessionTaskError', session.id, taskId, error);
        },
      };

      session.on('output', handlers.output);
      session.on('error', handlers.error);
      session.on('completion', handlers.completion);
      session.on('exit', handlers.exit);
      session.on('taskError', handlers.taskError);

      // Store handlers for later cleanup
      this.sessionHandlers.set(session.id, handlers);

      await session.start();

      this.sessions.set(session.id, session);
      this.updateSessionState(session);

      this.emit('sessionStarted', session);
      return session;
    } finally {
      // Release the lock so other createSession calls can proceed
      this._sessionCreationLock = null;
      unlock();
    }
  }

  /**
   * Stops a session by ID.
   *
   * @param id - Session ID to stop
   */
  async stopSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) {
      // Update store to mark as stopped if it exists there
      const storedSession = this.store.getSession(id);
      if (storedSession) {
        storedSession.status = 'stopped';
        storedSession.pid = null;
        this.store.setSession(id, storedSession);
      }
      return;
    }

    // Remove event listeners to prevent memory leaks
    const handlers = this.sessionHandlers.get(id);
    if (handlers) {
      session.off('output', handlers.output);
      session.off('error', handlers.error);
      session.off('completion', handlers.completion);
      session.off('exit', handlers.exit);
      session.off('taskError', handlers.taskError);
      this.sessionHandlers.delete(id);
    }

    await session.stop();
    this.sessions.delete(id);
    this.updateSessionState(session);
  }

  /**
   * Parks a session by ID (COD-124).
   *
   * Unlike {@link stopSession}, this does NOT remove the session from the
   * manager's in-memory map — a parked session is still "known" to the
   * manager, just without a live process backing it. The preserved
   * `resumeSessionId`/`workingDir`/mux metadata (see `Session.park()`) is
   * persisted so the session can be resumed later. No-op if the session
   * doesn't exist in memory (nothing live to park).
   *
   * @param id - Session ID to park
   */
  async parkSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) {
      return;
    }

    await session.park();
    this.updateSessionState(session);
  }

  /**
   * Stops all active sessions.
   * Uses Promise.allSettled to ensure all sessions are stopped even if some fail.
   */
  async stopAllSessions(): Promise<void> {
    const stopPromises = Array.from(this.sessions.keys()).map((id) => this.stopSession(id));
    const results = await Promise.allSettled(stopPromises);
    // Log any failures but don't throw - best effort cleanup
    for (const result of results) {
      if (result.status === 'rejected') {
        console.error('[SessionManager] Failed to stop session:', result.reason);
      }
    }
  }

  /**
   * Gets a session by ID.
   * @param id - Session ID
   * @returns The session or undefined if not found
   */
  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /** Gets all active sessions. */
  getAllSessions(): Session[] {
    return Array.from(this.sessions.values());
  }

  /** Gets all sessions currently idle (not processing). */
  getIdleSessions(): Session[] {
    return this.getAllSessions().filter((s) => s.isIdle());
  }

  /** Gets all sessions currently busy (processing). */
  getBusySessions(): Session[] {
    return this.getAllSessions().filter((s) => s.isBusy());
  }

  /** Gets the count of active sessions. */
  getSessionCount(): number {
    return this.sessions.size;
  }

  /** Checks if a session exists by ID. */
  hasSession(id: string): boolean {
    return this.sessions.has(id);
  }

  private updateSessionState(session: Session): void {
    // envOverrides is intentionally NOT on SessionState (API safety). For disk
    // persistence we augment the stored object with __envOverrides so reboot
    // recovery can restore them without leaking through any API serializer.
    // The key uses the reserved `__` prefix so it is visibly "internal" to any
    // future reader of state.json.
    const state = session.toState();
    const envOverrides = session.getEnvOverridesForPersist();
    const attachmentHistory = session.getAttachmentHistoryForPersist();
    const toStore = {
      ...state,
      ...(envOverrides ? { __envOverrides: envOverrides } : {}),
      ...(attachmentHistory ? { __attachmentHistory: attachmentHistory } : {}),
    };
    this.store.setSession(session.id, toStore as SessionState);
  }

  /** Gets all sessions from persistent storage (including stopped). */
  getStoredSessions(): Record<string, SessionState> {
    return this.store.getSessions();
  }

  /**
   * Sends input to a session.
   *
   * @param sessionId - Session ID to send to
   * @param input - Input string to send
   * @throws Error if session not found
   */
  async sendToSession(sessionId: string, input: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    await session.sendInput(input);
  }

  /** Gets the output buffer for a session. */
  getSessionOutput(sessionId: string): string | null {
    const session = this.sessions.get(sessionId);
    return session?.getOutput() ?? null;
  }

  /** Gets the error buffer for a session. */
  getSessionError(sessionId: string): string | null {
    const session = this.sessions.get(sessionId);
    return session?.getError() ?? null;
  }
}

// Singleton instance
let managerInstance: SessionManager | null = null;

/**
 * Gets or creates the singleton SessionManager instance.
 * @returns The global SessionManager
 */
export function getSessionManager(): SessionManager {
  if (!managerInstance) {
    managerInstance = new SessionManager();
  }
  return managerInstance;
}
