/**
 * @fileoverview Core PTY session wrapper for Claude CLI interactions.
 *
 * Manages a PTY (pseudo-terminal) process running Claude CLI, OpenCode CLI, or Codex CLI.
 * Three operation modes:
 * 1. **One-shot** (`runPrompt`): Single prompt → JSON response
 * 2. **Interactive** (`startInteractive`): Persistent interactive session
 * 3. **Shell** (`startShell`): Plain bash shell for debugging
 *
 * Optionally wraps in a tmux session for persistence across disconnects.
 * Tracks tokens, costs, background tasks, and auto-compact/clear.
 *
 * Key exports:
 * - `Session` class — main entity, extends EventEmitter
 * - `ClaudeMessage` interface — parsed JSON messages from Claude output
 * - `SessionEvents` interface — typed event map
 *
 * Key methods: `runPrompt()`, `startInteractive()`, `startShell()`,
 * `writeViaMux()`, `toState()`, `stop()`, `resize()`, `isIdle()`,
 * `setAutoCompact()`, `findTaskDescriptionNear()`, `getTerminalBuffer()`
 *
 * @dependencies session-cli-builder (args/env), session-auto-ops (auto-compact/clear),
 *   ralph-tracker (todo/completion parsing), bash-tool-parser (tool invocation tracking),
 *   task-tracker (background tasks), mux-interface (tmux abstraction)
 * @consumedby session-manager, web/server, respawn-controller
 * @emits session:terminal, session:idle, session:working, session:completion, session:exit
 *
 * @module session
 */

import { EventEmitter } from 'node:events';
import { execSync, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import * as pty from 'node-pty';
import {
  SessionState,
  SessionStatus,
  SessionConfig,
  RalphTrackerState,
  RalphTodoItem,
  ActiveBashTool,
  NiceConfig,
  DEFAULT_NICE_CONFIG,
  getErrorMessage,
  isEffortLevel,
  type ClaudeMode,
  type SessionMode,
  type SessionCheckpointMode,
  type OpenCodeConfig,
  type CodexConfig,
  type GeminiConfig,
  type EffortLevel,
  type SessionAttachmentHistoryItem,
  type AntigravityConfig,
  type PiConfig,
  type SessionRemote,
  type SessionSource,
  type SessionDocker,
} from './types.js';
import { probeDockerCliVersion } from './docker-hosts.js';
import { probeRemoteCliVersion } from './remote-hosts.js';
import type { TerminalMultiplexer, MuxSession, CommandDeliveryResult } from './mux-interface.js';
import { TaskTracker, type BackgroundTask } from './task-tracker.js';
import { RalphTracker } from './ralph-tracker.js';
import { BashToolParser } from './bash-tool-parser.js';
import {
  isTrustDialogScreen,
  TRUST_DIALOG_WINDOW_MS,
  TRUST_DIALOG_RETRY_MS,
  TRUST_DIALOG_MAX_ATTEMPTS,
  TRUST_DIALOG_SCAN_BYTES,
} from './session-trust-dialog.js';
import {
  trackActivityStreak,
  isSustainedActivity,
  isPaneQuiet,
  IDLE_RECHECK_MS,
  PANE_PROBE_MIN_INTERVAL_MS,
  PANE_PROBE_RECHECK_MS,
  type ActivityStreak,
} from './session-activity.js';
import {
  BufferAccumulator,
  ANSI_ESCAPE_PATTERN_FULL,
  TOKEN_PATTERN,
  SPINNER_PATTERN,
  CLAUDE_WORKING_LINE_PATTERN,
  MAX_SESSION_TOKENS,
  execPattern,
  getClaudeCliVersion,
  getClaudeBinaryPath,
  spawnPtyWithHelperRepair,
  resolveLocalShell,
} from './utils/index.js';
import {
  MAX_TERMINAL_BUFFER_SIZE,
  TRIM_TERMINAL_TO as TERMINAL_BUFFER_TRIM_SIZE,
  MAX_TEXT_OUTPUT_SIZE,
  TRIM_TEXT_TO as TEXT_OUTPUT_TRIM_SIZE,
  MAX_MESSAGES,
  MAX_LINE_BUFFER_SIZE,
} from './config/buffer-limits.js';
import { EXEC_TIMEOUT_MS } from './config/exec-timeout.js';
import { DEFAULT_TMUX_HISTORY_LIMIT } from './config/terminal-history.js';
import {
  buildInteractiveArgs,
  buildPromptArgs,
  buildClaudeEnv,
  buildMuxAttachEnv,
  buildShellEnv,
} from './session-cli-builder.js';
import {
  SessionAutoOps,
  type CheckpointObservation,
  type CheckpointProgress,
  type CheckpointState,
  type CheckpointMode,
} from './session-auto-ops.js';
import {
  findActiveCodexConversation,
  findAuthoritativeCodexConversation,
  findRecentOwnedCodexConversationIds,
  invalidateCodexConversationInventory,
  canonicalizeCodexHome,
} from './checkpoint-conversation-identity.js';
import { detectUsageLimitPause } from './usage-limit-patterns.js';
import { SessionTaskCache } from './session-task-cache.js';
import { InteractivePtyExitBreaker } from './session-pty-exit-breaker.js';
import { parseTerminalAttachmentRequests } from './attachment-magic.js';
import {
  sanitizeAttachmentHistory,
  upsertAttachmentHistory as upsertAttachmentHistoryList,
} from './session-attachment-history.js';
import type { CodexProviderEnvironment } from './readmymind-predictor.js';
import type { CodexProviderIdentity } from './codex-provider-identity.js';

export type { BackgroundTask } from './task-tracker.js';
export type { RalphTrackerState, RalphTodoItem, ActiveBashTool } from './types.js';

export type ResizeViewportType = 'mobile' | 'tablet' | 'desktop';

/** Line buffer flush interval (100ms) - forces processing of partial lines */
const LINE_BUFFER_FLUSH_INTERVAL = 100;

// ============================================================================
// Timing Constants
// ============================================================================

/** Delay after mux session creation before sending commands (300ms) */
const MUX_STARTUP_DELAY_MS = 300;

/** Delay before declaring session idle after last output (2 seconds) */
const IDLE_DETECTION_DELAY_MS = 2000;

/** Quiet window after the last external-CLI working frame before declaring
 *  idle. Codex ticks its "Working (Ns • esc to interrupt)" counter about once
 *  per second while a turn runs, so a few missed frames are tolerated but a
 *  finished turn flips to idle promptly (COD-175). */
const EXTERNAL_CLI_IDLE_DELAY_MS = 5000;

/** COD-189 — shell burst healing: during fast output bursts tmux's attach
 *  client jump-scrolls (repaints rows in place instead of scrolling), so the
 *  browser's live scrollback ends up sparse or missing entirely — the
 *  contiguous truth lives only in the pane history. When a shell session
 *  streams more than SHELL_BURST_BYTES within SHELL_BURST_WINDOW_MS, emit
 *  'needsRefresh' once output settles: the client full-reloads from the
 *  (capture-canonical since COD-189) /terminal response. */
const SHELL_BURST_BYTES = 24 * 1024;
const SHELL_BURST_REPAINTS = 4;
const SHELL_BURST_WINDOW_MS = 5000;
const SHELL_BURST_SETTLE_MS = 1500;

/** COD-181/182 — external-CLI sessions poll the RENDERED local frame for the
 *  working pattern. Every Codeman session runs inside tmux, so the stream is
 *  tmux-client repaint traffic (doubly nested for remote sessions): the
 *  Working line arrives as partial cell updates split across chunks, and the
 *  per-chunk literal match in _detectInteractiveActivity never fires — sessions
 *  stayed "idle" through 30-minute turns. The local tmux window's visible
 *  frame always has the line fully assembled. Must be shorter than
 *  EXTERNAL_CLI_IDLE_DELAY_MS so positive polls keep re-arming the
 *  quiet-window timer. */
const WORKING_FRAME_POLL_MS = 2000;

// Note: Auto-compact/clear timing constants moved to session-auto-ops.ts

/** Graceful shutdown delay when stopping session (100ms) */
const GRACEFUL_SHUTDOWN_DELAY_MS = 100;

// Filter out terminal focus escape sequences (focus in/out reports)
// ^[[I (focus in), ^[[O (focus out), and the enable/disable sequences
// eslint-disable-next-line no-control-regex
const FOCUS_ESCAPE_FILTER = /\x1b\[\?1004[hl]|\x1b\[[IO]/g;

// Pattern to match Task tool invocations in terminal output
// Matches: "Explore(Description)", "Task(Description)", "Bash(Description)", etc.
// The prefix characters vary (●, ·, ✶, etc.) so we don't require them
// We look for the tool name followed by (description)
const TASK_TOOL_PATTERN = /\b(Explore|Task|Bash|Plan|general-purpose)\(([^)]+)\)/g;

// Pre-compiled patterns for hot paths (avoid regex compilation per call)
/** Pattern to strip leading ANSI escapes and whitespace from terminal buffer */
// eslint-disable-next-line no-control-regex
const LEADING_ANSI_WHITESPACE_PATTERN = /^(\x1b\[\??[\d;]*[A-Za-z]|[\s\r\n])+/;
/** Pattern to match Ctrl+L (form feed) characters */
// eslint-disable-next-line no-control-regex
const CTRL_L_PATTERN = /\x0c/g;
/** Pattern to split by newlines (CR or LF) */
const NEWLINE_SPLIT_PATTERN = /\r?\n/;
/** Row starts emitted by TmuxManager.formatPaneSnapshot (which intentionally omits newlines). */
// eslint-disable-next-line no-control-regex
const TMUX_ABSOLUTE_ROW_START_PATTERN = /\x1b\[\d+;1H/g;

export function isExternalCliMode(mode: SessionMode): boolean {
  return mode === 'opencode' || mode === 'codex' || mode === 'gemini' || mode === 'antigravity' || mode === 'pi';
}

export function detectExternalCliWorkingFrame(data: string, mode: SessionMode): boolean {
  if (mode === 'codex') {
    // Codex renders "Working (2s • esc to interrupt)", "Working (4m 03s • …)"
    // and sometimes unit-less "Working (31 • …)" (COD-175 prod screenshot), so
    // only anchor on "Working (<digits>" plus the interrupt hint in-parens.
    return /\bWorking \(\d+[^)\n]*esc to interrupt\)/.test(data);
  }
  return false;
}

/**
 * Broader rendered-frame evidence used only by checkpoint readiness. Codex's
 * stable TUI can retain the submitted `›` row while exposing work through a
 * short `• Working (2s)` row or a `· Working ·` status footer, neither of which
 * always carries the interrupt hint used by global quiet-window detection.
 */
export function detectCodexCheckpointWorkingFrame(data: string): boolean {
  return (
    detectExternalCliWorkingFrame(data, 'codex') ||
    /^\s*[•·]\s+Working(?:\s*\([^\n)]*\))?(?:\s*[•·]|\s*$)/m.test(data) ||
    /(?:^|\s)·\s*Working\s*·(?:\s|$)/m.test(data)
  );
}

/**
 * Rendered-frame working evidence used only by checkpoint sequencing, the
 * Claude counterpart of detectCodexCheckpointWorkingFrame.
 *
 * Claude keeps its `❯` input row visible for the WHOLE of a `/compact`, so
 * prompt visibility cannot distinguish idle from busy and the operation is
 * only observable through its progress row. That row is marked with a
 * `✻`/`✽`-class glyph, not the braille SPINNER_PATTERN, which is why the
 * spinner check alone never fired and every compact reported
 * `operation-not-accepted` while plainly succeeding.
 *
 * The discriminator is an animation glyph followed by a label ending in an
 * ellipsis, e.g. `✢ Compacting conversation… `. The elapsed timer and percent
 * (`✽ Compacting conversation… (55s) ▰▰▱ 46%`) must NOT be required: they only
 * appear once there is progress to report, roughly 15s in, which is well past
 * the 8s acceptance window — that delay is exactly what made an earlier
 * timer-based pattern still report `operation-not-accepted`.
 *
 * Completed rows read `✻ Cogitated for 5s` — same glyph family, no ellipsis —
 * and persist on screen while Claude sits idle, so they must not match:
 * reading one as working would hold `ready` false forever and stall every
 * checkpoint in `waiting-ready`. The glyph anchor also keeps the `❯` input row
 * out of it, whose ghost-suggestion text can legitimately contain an ellipsis.
 */
export function detectClaudeCheckpointWorkingFrame(data: string): boolean {
  return SPINNER_PATTERN.test(data) || /\besc to interrupt\b/.test(data) || /^\s*[·✢✳∗✻✽]\s+\S[^\n]*…/m.test(data);
}

function getModeLabel(mode: SessionMode): string {
  switch (mode) {
    case 'opencode':
      return 'OpenCode';
    case 'codex':
      return 'Codex';
    case 'gemini':
      return 'Gemini';
    case 'antigravity':
      return 'Antigravity';
    case 'pi':
      return 'Pi';
    case 'shell':
      return 'Shell';
    case 'claude':
      return 'Claude';
  }
}

/**
 * Modes whose TUI emits alt-screen / scrollback-erase / mouse-tracking sequences
 * that we strip so the browser keeps everything in the main buffer with scrollback
 * reachable (the strip runs on both the live stream and the buffer replay).
 *
 * Codex, Claude Code, and Gemini are known, controlled (Ink/React) TUIs that
 * repaint via cursor positioning, so dropping the alt-screen switch is safe —
 * content stays in the normal buffer. Excluded: `shell` (arbitrary programs like
 * vim/less/htop legitimately need the alt screen), `opencode` (renders its own
 * TUI that may rely on it) and `pi` (below). Keep parity with the replay-side
 * strip in session-routes.ts.
 *
 * ⚠️ Being excluded here does NOT preserve the alt screen. Every excluded mode
 * falls through to isMuxAltScreenOnlyStripMode(), which strips the alt-screen
 * toggles too whenever the session is tmux-backed, and pi/opencode ALWAYS are
 * (both refuse the direct-PTY fallback). What exclusion actually buys is the rest
 * of the full strip: `\x1b[3J` and the mouse-tracking DECSETs survive. That is the
 * real reason pi is out: its default TUI renders into the MAIN screen with
 * terminal-owned scrollback and is mouse-aware, so it is a `3J`/mouse consumer in
 * a way an Ink TUI repainting in place is not. Consequence to know before
 * debugging it: pi's runtime-switchable fullscreen TUI (`/settings`, 0.84.0+)
 * still gets its `?1049h` stripped and paints into the main buffer, exactly like
 * vim inside a tmux `shell` session.
 */
export function isAltScreenStripMode(mode: SessionMode): boolean {
  // Antigravity is deliberately excluded (upstream #201): its Go TUI is
  // unverified against the alt-screen strip, like opencode's.
  return mode === 'codex' || mode === 'claude' || mode === 'gemini';
}

/**
 * Modes that need the NARROW strip: alt-screen toggles only, leaving `\x1b[3J`
 * and the mouse-tracking DECSETs alone. Applies to every mode `isAltScreenStripMode`
 * excludes, but ONLY when the session is tmux-backed (`useMux`).
 *
 * The bug (issue #205): the tmux CLIENT emits `smcup` (`\x1b[?1049h`) as its first
 * bytes on attach, before any program has run. Unstripped, xterm.js parks in the
 * alternate buffer for the whole session, where `baseY` is pinned at 0 (no
 * scrollback to reach, so touch scrolling is a no-op) and xterm's own wheel handler
 * translates the wheel into `\x1bOA`/`\x1bOB` cursor keys — which readline receives
 * as shell history navigation. Both reported symptoms, one sequence.
 *
 * Why this is safe under tmux, despite the old "shell must keep the alt screen for
 * vim/less/htop" reasoning: tmux is a full terminal emulator and NEVER forwards a
 * pane's alt-screen toggles to its client, it repaints instead. Captured from a real
 * attach, `\x1b[?1049h` appears exactly once (at attach) and vim/less/htop sessions
 * inside the pane emit zero. So the only thing stripped here is tmux's own smcup.
 *
 * Why it is gated on `useMux`: `startShell()`/`startInteractive()` fall back to a
 * DIRECT PTY when mux creation fails. There the inner program's `\x1b[?1049h` really
 * does reach xterm, and stripping it would break vim/less/htop for real.
 *
 * Why it is narrower than the full strip: with tmux `mouse off`, a mouse-aware
 * program in the pane (htop, vim with `set mouse=a`) still gets its DECSETs passed
 * through to the client, so stripping those would break its mouse support. And
 * `\x1b[3J` from a user's own `clear` is a deliberate "wipe my scrollback".
 */
export function isMuxAltScreenOnlyStripMode(mode: SessionMode, useMux: boolean): boolean {
  return useMux && !isAltScreenStripMode(mode);
}

// Note: Claude CLI PATH resolution moved to session-cli-builder.ts (buildClaudeEnv)

/** PTY fallback geometry when tmux can't be queried (matches pre-#80 hardcoded values). */
const DEFAULT_PTY_COLS = 120;
const DEFAULT_PTY_ROWS = 40;
const TMUX_DISPLAY_TIMEOUT_MS = 2000;
const IS_TEST_MODE = !!process.env.VITEST;
/**
 * Echo transport for the test-mode PTY attach. Raw mode disables the tty line
 * discipline, so each input byte flows back exactly once and immediately; without
 * it, tty echo doubles every line and canonical buffering holds bytes until Enter.
 */
const TEST_PTY_SCRIPT = 'if (process.stdin.isTTY) process.stdin.setRawMode(true); process.stdin.pipe(process.stdout);';
/** Delay before the in-container Claude CLI version probe (lets the container start). */
const DOCKER_CLI_VERSION_PROBE_DELAY_MS = 3000;
/** Delay before the over-ssh Claude CLI version probe (keeps session start off the ssh round-trip). */
const REMOTE_CLI_VERSION_PROBE_DELAY_MS = 3000;

/**
 * Ask tmux for the current window geometry of `muxName` so a re-attaching PTY
 * client can spawn at the same size and avoid the resize-flicker / scrollback
 * loss documented in #80. Returns `{ cols: 120, rows: 40 }` on any failure
 * (tmux dead, muxName unknown, malformed output) — caller never has to
 * differentiate "tmux unreachable" from "size 120x40".
 *
 * `socket` MUST be the same dedicated socket the session lives on (`mux.muxSocket`);
 * querying the default server would never find the session and silently fall back.
 *
 * Argv form (execFileSync, not execSync) keeps `muxName` out of any shell so
 * a hostile session name can't inject options.
 */
export function queryTmuxWindowSize(muxName: string, socket: string): { cols: number; rows: number } {
  try {
    const sizeStr = execFileSync(
      'tmux',
      ['-L', socket, 'display', '-t', muxName, '-p', '#{window_width} #{window_height}'],
      {
        timeout: TMUX_DISPLAY_TIMEOUT_MS,
        encoding: 'utf8',
      }
    ).trim();
    const [w, h] = sizeStr.split(' ').map(Number);
    if (w > 0 && h > 0) {
      return { cols: w, rows: h };
    }
  } catch {
    /* fall back below */
  }
  return { cols: DEFAULT_PTY_COLS, rows: DEFAULT_PTY_ROWS };
}

export function resolveMuxAttachCwd(workingDir: string, remote?: SessionRemote, docker?: SessionDocker): string {
  // Remote and docker sessions run the CLI elsewhere (ssh / docker exec); the LOCAL
  // wrapper pane never needs the workspace as its cwd, so launch it in /tmp.
  return remote || docker ? '/tmp' : workingDir;
}

/**
 * Represents a JSON message from Claude CLI's stream-json output format.
 * Messages are newline-delimited JSON objects parsed from PTY output.
 */
export interface ClaudeMessage {
  /** Message type indicating the role or purpose */
  type: 'system' | 'assistant' | 'user' | 'result';
  /** Optional subtype for further classification */
  subtype?: string;
  /** Claude's internal session identifier */
  session_id?: string;
  /** Message content with optional token usage */
  message?: {
    content: Array<{ type: string; text?: string }>;
    usage?: {
      input_tokens: number;
      output_tokens: number;
    };
  };
  /** Final result text (on result messages) */
  result?: string;
  /** Whether this message represents an error */
  is_error?: boolean;
  /** Total cost in USD (on result messages) */
  total_cost_usd?: number;
  /** Total duration in milliseconds (on result messages) */
  duration_ms?: number;
}

/**
 * Event signatures emitted by the Session class.
 * Subscribe using `session.on('eventName', handler)`.
 */

/**
 * Core session class that wraps a PTY process running Claude CLI or a shell.
 *
 * @example
 * ```typescript
 * // Create and start an interactive Claude session
 * const session = new Session({
 *   workingDir: '/path/to/project',
 *   mux: muxManager,
 *   useMux: true
 * });
 * await session.startInteractive();
 *
 * // Listen for events
 * session.on('terminal', (data) => console.log(data));
 * session.on('message', (msg) => console.log('Claude:', msg));
 *
 * // Send input
 * session.write('Hello Claude!\r');
 *
 * // Stop when done
 * await session.stop();
 * ```
 *
 * @fires Session#terminal - Raw terminal output
 * @fires Session#message - Parsed Claude JSON message
 * @fires Session#completion - One-shot prompt completed
 * @fires Session#exit - Process exited
 * @fires Session#autoClear - Token threshold reached, clearing context
 * @fires Session#autoCompact - Token threshold reached, compacting context
 */
export class Session extends EventEmitter {
  private static readonly codexSubmitTimes = new Map<string, number>();
  readonly id: string;
  readonly workingDir: string;
  readonly createdAt: number;
  readonly mode: SessionMode;

  // Task description cache (extracted to SessionTaskCache)
  private _taskCache = new SessionTaskCache();

  private _name: string;
  private ptyProcess: pty.IPty | null = null;
  private _pid: number | null = null;
  private _status: SessionStatus = 'idle';
  private _currentTaskId: string | null = null;

  // COD-118: bound repeated non-zero interactive-PTY exits. Recorded in the
  // interactive PTY onExit handler; when it trips, the session flips to 'error'
  // and startInteractive() refuses to respawn until an explicit user restart
  // calls resetRespawnBreaker(). Defense-in-depth over the COD-115 crash-loop.
  private readonly _ptyExitBreaker = new InteractivePtyExitBreaker();
  private _respawnBlocked = false;
  private readonly _terminalBufferMaxSize: number;
  private readonly _terminalBufferTrimSize: number;
  private readonly _tmuxHistoryLimit: number;
  private readonly _remote?: SessionRemote;
  /** Creating browser's terminal dims — new tmux windows spawn at this size instead of 120x40 (COD-179) */
  private readonly _initialDims?: { cols: number; rows: number };
  // Use BufferAccumulator for hot-path buffers to reduce GC pressure
  private _terminalBuffer: BufferAccumulator;
  private _textOutput = new BufferAccumulator(MAX_TEXT_OUTPUT_SIZE, TEXT_OUTPUT_TRIM_SIZE);
  private _errorBuffer: string = '';
  private _lastActivityAt: number;
  private _claudeSessionId: string | null = null;
  private _claudeAuthoritativeSessionId: string | null = null;
  private _claudeSessionIdentityAdopted = false;
  private _claudeSessionStartHookReady: boolean;
  private _totalCost: number = 0;
  private _messages: ClaudeMessage[] = [];
  private _lineBuffer: string = '';
  private _lineBufferFlushTimer: NodeJS.Timeout | null = null;
  // Alt-screen-strip modes (Codex/Claude): trailing partial CSI held back so
  // sequences split across PTY chunks can't slip past the alt-screen/scrollback
  // strip (see _handleTerminalOutput / isAltScreenStripMode)
  private _altScreenSeqCarry: string = '';
  private resolvePromise: ((value: { result: string; cost: number }) => void) | null = null;
  private rejectPromise: ((reason: Error) => void) | null = null;
  private _promptResolved: boolean = false; // Guard against race conditions in runPrompt
  private _isWorking: boolean = false;
  private _lastPromptTime: number = 0;
  /** Semantic checkpoint prompt generation (not a raw repaint counter). */
  private _checkpointPromptRevision = 0;
  private _checkpointWasReady = false;
  private _checkpointLastObservation: CheckpointObservation = { ready: false, working: false, revision: 0 };
  private _checkpointReadyFingerprint: string | null = null;
  private _checkpointCodexConversationId: string | undefined;
  private _checkpointCodexFreshBaselineId: string | undefined;
  private _checkpointCodexFreshBaselineIds: string[] = [];
  private _checkpointCodexFreshTransitionArmed = false;
  private _findRecentOwnedCodexConversationIds = findRecentOwnedCodexConversationIds;
  /** Armed only while a delivered `/clear` may reset+return between polls. */
  private _checkpointAwaitingInstantClear = false;
  private _checkpointInstantClearBaseline: string | null = null;
  private _checkpointDirectPtySawClear = false;
  private activityTimeout: NodeJS.Timeout | null = null;
  private _externalCliIdleTimer: NodeJS.Timeout | null = null;
  /** COD-181/182 — rendered-frame working poller for external-CLI sessions (local AND remote) */
  private _workingFramePollTimer: NodeJS.Timeout | null = null;
  /** COD-189 — shell burst tracking (heal live scrollback from capture after big bursts) */
  private _shellBurstBytes = 0;
  private _shellBurstRepaints = 0;
  private _shellBurstWindowStart = 0;
  private _shellBurstActive = false;
  private _shellBurstSettleTimer: NodeJS.Timeout | null = null;
  private _awaitingIdleConfirmation: boolean = false; // Prevents timeout reset during idle detection
  private _activityStreak: ActivityStreak | null = null; // Unbroken run of PTY repaints (working detection)
  private _lastPaneProbeAt = 0; // Throttle for the tmux screen probe
  private _lastPaneProbeWorking: boolean | null = null; // Its last verdict (null = could not read)
  private _trustDialogAccepted: boolean = false; // Stops the trust-dialog scan (answered, or given up)
  private _trustDialogAttempts = 0; // Enter presses sent at the trust dialog
  private _lastTrustDialogScanAt = 0; // Throttle for the trust-dialog screen read
  private _interactiveStartedAt = 0; // When the interactive pane launched (bounds that scan)
  private _taskTracker: TaskTracker;

  // Token tracking for auto-clear
  private _totalInputTokens: number = 0;
  private _totalOutputTokens: number = 0;

  // Auto-compact/auto-clear automation (extracted to SessionAutoOps)
  private _autoOps!: SessionAutoOps;

  // Image watcher setting (per-session toggle)
  private _imageWatcherEnabled: boolean = false;

  // Pin state (COD-139) — pinned sessions float to the top of the session
  // manager list, ordered by pinnedAt descending (most-recently-pinned first).
  private _pinned: boolean = false;
  private _pinnedAt: number | null = null;

  // Explicit attachment magic links already emitted from terminal output.
  private _attachmentMagicSeen = new Set<string>();
  private _attachmentHistory: SessionAttachmentHistoryItem[] = [];
  private _sources: SessionSource[] = [];

  // Flicker filter setting (per-session toggle, applied on frontend)
  private _flickerFilterEnabled: boolean = false;

  // Claude Code CLI info (parsed from terminal startup)
  private _cliVersion: string = '';
  private _cliModel: string = '';
  private _cliAccountType: string = '';
  private _cliLatestVersion: string = '';
  private _cliInfoParsed: boolean = false; // Only parse once per session

  // Timer tracking for cleanup (prevents memory leaks)
  private _promptCheckInterval: NodeJS.Timeout | null = null;
  private _promptCheckTimeout: NodeJS.Timeout | null = null;
  private _shellIdleTimer: NodeJS.Timeout | null = null;

  // Multiplexer session support (tmux)
  private _mux: TerminalMultiplexer | null = null;
  private _muxSession: MuxSession | null = null;
  private _useMux: boolean = false;
  // Flag to prevent new timers after session is stopped
  private _isStopped: boolean = false;

  // Ralph tracking (Ralph Wiggum loops and todo lists inside Claude Code)
  private _ralphTracker: RalphTracker;

  // Agent tree tracking
  private _parentAgentId: string | null = null;
  private _childAgentIds: string[] = [];

  // Nice prioritying configuration
  private _niceConfig: NiceConfig = { ...DEFAULT_NICE_CONFIG };

  // Claude model override (e.g., 'opus', 'sonnet', 'haiku')
  private _model: string | undefined;

  // Claude CLI startup permission mode
  private _claudeMode: ClaudeMode = 'dangerously-skip-permissions';
  private _allowedTools: string | undefined;

  // OpenCode configuration (only for mode === 'opencode')
  private _openCodeConfig: OpenCodeConfig | undefined;
  // Codex configuration (only for mode === 'codex')
  private _codexConfig: CodexConfig | undefined;
  // Gemini configuration (only for mode === 'gemini')
  private _geminiConfig: GeminiConfig | undefined;
  // Debug capture (CODEMAN_CODEX_RAW_LOG=1): set to true after the first
  // write failure so we don't spam the server log.
  private _codexRawLogErrored = false;
  // Antigravity configuration (only for mode === 'antigravity')
  private _antigravityConfig: AntigravityConfig | undefined;
  // Pi configuration (only for mode === 'pi')
  private _piConfig: PiConfig | undefined;
  private _resumeSessionId: string | undefined;

  // Native external-CLI session/rollout id captured at PARK time (COD-124 unit 2,
  // Gap B; widened to opencode/gemini/agy by COD-251). The CLI-native session/
  // conversation id discovered from that CLI's own on-disk store at park time
  // (codex: rollout UUID under ~/.codex/sessions/; opencode: session row in its
  // sqlite db; gemini: session id from its projects/chats JSONL trees; agy:
  // conversation id from its history.jsonl), threaded back into the matching
  // mode-specific config field on resume (see _applyNativeResumeIdForResume())
  // so relaunching resumes the same conversation. null for claude/shell — no
  // on-disk resume-by-id mechanism is wired for those.
  private _nativeResumeId: string | null = null;

  // Ephemeral env overrides (e.g., CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS). Exported by tmux
  // at spawn, preserved across respawns via persisted state. Not written to .claude/settings.local.json.
  private _envOverrides: Record<string, string> | undefined;
  /** Recovery fence: session-scoped provider credentials existed but were never written to disk. */
  private _codexProviderCredentialsLost = false;

  // Claude CLI effort level — injected as a `--settings` soft default at spawn so the
  // user can still switch in-session via /effort (incl. ultracode). Never carried as
  // the CLAUDE_CODE_EFFORT_LEVEL env var, which would hard-lock the session.
  private _effort: EffortLevel | undefined;

  // COLORTERM=truecolor opt-in (COD-75). App-level setting resolved from settings.json
  // at session creation; threaded into the tmux env exports and the direct-PTY env.
  // Default off → COLORTERM is unset (avoids tmux→PTY→xterm.js color glitches).
  private _truecolorEnabled: boolean = false;

  // Docker execution metadata, present when this session runs inside a container via
  // local tmux + `docker exec`. The container is per-CASE (shared by sibling sessions).
  private readonly _docker?: SessionDocker;

  // Owning username in multi-user mode (undefined in single-user). Stamped at create
  // from req.authUser and round-tripped through recovery like _remote/_docker.
  private _owner?: string;

  // The session that spawned this one (tab lineage lines). Resolved by the create
  // route before it reaches here, so this is always either an id that existed at
  // create time or undefined. Decoration only — see SessionState.parentSessionId.
  private readonly _parentSessionId?: string;

  // Session color for visual differentiation
  private _color: import('./types.js').SessionColor = 'default';

  // Store handler references for cleanup (prevents memory leaks)
  private _taskTrackerHandlers: {
    taskCreated: (task: BackgroundTask) => void;
    taskUpdated: (task: BackgroundTask) => void;
    taskCompleted: (task: BackgroundTask) => void;
    taskFailed: (task: BackgroundTask, error: string) => void;
  } | null = null;

  private _ralphHandlers: {
    loopUpdate: (state: RalphTrackerState) => void;
    todoUpdate: (todos: RalphTodoItem[]) => void;
    completionDetected: (phrase: string) => void;
    statusBlockDetected: (block: import('./types.js').RalphStatusBlock) => void;
    circuitBreakerUpdate: (status: import('./types.js').CircuitBreakerStatus) => void;
    exitGateMet: (data: { completionIndicators: number; exitSignal: boolean }) => void;
  } | null = null;

  // Bash tool tracking (file paths for live log viewing)
  private _bashToolParser: BashToolParser;
  private _bashToolHandlers: {
    toolStart: (tool: ActiveBashTool) => void;
    toolEnd: (tool: ActiveBashTool) => void;
    toolsUpdate: (tools: ActiveBashTool[]) => void;
  } | null = null;

  // Task descriptions parsed from terminal output — delegated to SessionTaskCache

  // Throttle expensive PTY processing (Ralph, bash parser, task descriptions)
  // Accumulates clean data between processing windows to avoid running regex on every chunk
  private _lastExpensiveProcessTime: number = 0;
  private _pendingCleanData: string = '';
  private _expensiveProcessTimer: NodeJS.Timeout | null = null;
  private static readonly EXPENSIVE_PROCESS_INTERVAL_MS = 150; // Process at most every 150ms

  constructor(
    config: Partial<SessionConfig> & {
      workingDir: string;
      mode?: SessionMode;
      name?: string;
      /** Terminal multiplexer instance (tmux) */
      mux?: TerminalMultiplexer;
      /** Whether to use multiplexer wrapping */
      useMux?: boolean;
      /** Existing mux session for restored sessions */
      muxSession?: MuxSession;
      niceConfig?: NiceConfig; // Nice prioritying configuration
      /** Claude model override (e.g., 'opus', 'sonnet', 'haiku') */
      model?: string;
      /** Claude CLI startup permission mode */
      claudeMode?: ClaudeMode;
      /** Comma-separated allowed tools (for 'allowedTools' mode) */
      allowedTools?: string;
      /** OpenCode configuration (only for mode === 'opencode') */
      openCodeConfig?: OpenCodeConfig;
      /** Codex configuration (only for mode === 'codex') */
      codexConfig?: CodexConfig;
      /** Gemini configuration (only for mode === 'gemini') */
      geminiConfig?: GeminiConfig;
      /** Antigravity configuration (only for mode === 'antigravity') */
      antigravityConfig?: AntigravityConfig;
      /** Pi configuration (only for mode === 'pi') */
      piConfig?: PiConfig;
      /** Resume a previous Claude conversation (used after server reboot) */
      resumeSessionId?: string;
      /** Native external-CLI session/rollout id captured at park time (COD-124 unit 2, Gap B) */
      nativeResumeId?: string | null;
      /** Extra env vars exported to the CLI at spawn time (no disk persistence) */
      envOverrides?: Record<string, string>;
      /** Private, secret-free Codex provider provenance restored from state.json. */
      codexProviderIdentity?: CodexProviderIdentity | null;
      /** Claude CLI effort level (soft default via --settings, switchable in-session via /effort) */
      effort?: EffortLevel;
      /** Opt Claude/non-codex sessions into COLORTERM=truecolor (COD-75 app setting; default off). */
      truecolorEnabled?: boolean;
      /** Enable Agent Checkpoint for this newly created session (COD-257 app default). */
      checkpointEnabled?: boolean;
      /** Restored Claude session can receive authoritative SessionStart identity changes. */
      claudeSessionStartHookReady?: boolean;
      /** Last authoritative Claude conversation identity persisted across recovery. */
      claudeSessionId?: string;
      /** Whether the persisted Claude identity was authoritatively adopted. */
      claudeSessionIdentityAdopted?: boolean;
      /** Restored per-session attachment history. May include server-private external paths. */
      attachmentHistory?: SessionAttachmentHistoryItem[];
      /** Restored per-session reference sources (COD-65). */
      sources?: SessionSource[];
      /** Per-session terminal buffer limits; applies to this server-side session buffer. */
      terminalBufferConfig?: { maxBytes: number; trimBytes: number };
      /** tmux history limit for newly created mux sessions. */
      tmuxHistoryLimit?: number;
      /** Restored wall-clock ms of the pane's last Enter (see `lastSubmitAt`). */
      lastSubmitAt?: number;
      /** Remote execution metadata for sessions launched through SSH inside local tmux. */
      remote?: SessionRemote;
      /** Creating browser's terminal dims — new tmux windows spawn at this size instead of 120x40 (COD-179). */
      initialDims?: { cols: number; rows: number };
      /** Docker execution metadata for sessions launched inside a container via local tmux. */
      docker?: SessionDocker;
      /** Owning username (multi-user mode); undefined in single-user. */
      owner?: string;
      /** Session that spawned this one — tab lineage decoration, resolved by the caller. */
      parentSessionId?: string;
    }
  ) {
    super();
    this.setMaxListeners(25);

    // Default error handler prevents unhandled 'error' events from crashing the process.
    // Server attaches its own handler after construction — this is a safety net for the gap.
    this.on('error', (err) => {
      console.error(`[Session] Unhandled error event:`, err);
    });

    this.id = config.id || uuidv4();
    this.workingDir = config.workingDir;
    this.createdAt = config.createdAt || Date.now();
    this.mode = config.mode || 'claude';
    this._name = config.name || '';
    this._resumeSessionId = config.resumeSessionId;
    this._nativeResumeId = config.nativeResumeId ?? null;
    // NOW, not `createdAt`: recovery passes the ORIGINAL creation time of a
    // days-old tmux session, and seeding last-activity from it would report a
    // freshly re-attached pane as having been silent for days, which the idle
    // confirmation reads as "already quiet" and the home screens print as its
    // idle duration. For a genuinely new session the two are the same instant.
    this._lastActivityAt = Date.now();
    this._terminalBufferMaxSize = config.terminalBufferConfig?.maxBytes ?? MAX_TERMINAL_BUFFER_SIZE;
    this._terminalBufferTrimSize = config.terminalBufferConfig?.trimBytes ?? TERMINAL_BUFFER_TRIM_SIZE;
    this._tmuxHistoryLimit = config.tmuxHistoryLimit ?? DEFAULT_TMUX_HISTORY_LIMIT;
    this._remote = config.remote;
    this._initialDims = config.initialDims;
    this._terminalBuffer = new BufferAccumulator(this._terminalBufferMaxSize, this._terminalBufferTrimSize);
    // Set claudeSessionId — when resuming, the Claude conversation ID is the resumed one.
    this._claudeSessionId = config.claudeSessionId ?? config.resumeSessionId ?? this.id;
    this._claudeAuthoritativeSessionId = config.claudeSessionId ?? config.resumeSessionId ?? null;
    this._claudeSessionIdentityAdopted = config.claudeSessionIdentityAdopted ?? Boolean(config.resumeSessionId);
    this._claudeSessionStartHookReady = config.claudeSessionStartHookReady ?? this.mode !== 'claude';
    // Restored from state.json on boot recovery. start() resets _claudeSessionId
    // to the launch id even when re-attaching to a mux session whose CLI has
    // moved on (a `/clear` before the restart), so this anchor is what lets the
    // response viewer re-derive the live conversation without waiting for the
    // user to type again.
    this._lastSubmitAt = config.lastSubmitAt ?? 0;
    this._mux = config.mux || null;
    this._useMux = config.useMux ?? (this._mux !== null && this._mux.isAvailable());
    this._muxSession = config.muxSession || null;

    // Apply Nice priority configuration if provided
    if (config.niceConfig) {
      this._niceConfig = { ...config.niceConfig };
    }

    // Apply model override if provided
    if (config.model) {
      this._model = config.model;
    }

    // Apply Claude CLI permission mode
    if (config.claudeMode) {
      this._claudeMode = config.claudeMode;
    }
    if (config.allowedTools) {
      this._allowedTools = config.allowedTools;
    }

    // Apply OpenCode configuration
    if (config.openCodeConfig) {
      this._openCodeConfig = config.openCodeConfig;
    }

    // Apply Codex configuration
    if (config.codexConfig) {
      this._codexConfig = config.codexConfig;
    }

    // Apply Agy configuration
    if (config.antigravityConfig) {
      this._antigravityConfig = config.antigravityConfig;
    }
    // Apply Gemini configuration
    if (config.geminiConfig) {
      this._geminiConfig = config.geminiConfig;
    }

    // Apply Antigravity configuration
    if (config.antigravityConfig) {
      this._antigravityConfig = config.antigravityConfig;
    }

    // Apply Pi configuration
    if (config.piConfig) {
      this._piConfig = config.piConfig;
    }

    // Apply env overrides (exported at spawn, not persisted to disk).
    // Legacy migration: pre-0.7.2 carried effort as the CLAUDE_CODE_EFFORT_LEVEL env var,
    // which hard-locks /effort switching. Extract it into _effort (--settings soft default)
    // and never export it as an env var again. Explicit config.effort wins over legacy.
    const recoveredCodexHome = config.codexProviderIdentity?.codexHome
      ? canonicalizeCodexHome(config.codexProviderIdentity.codexHome, config.workingDir)
      : undefined;
    const combinedEnvOverrides: Record<string, string> = {
      ...(recoveredCodexHome ? { CODEX_HOME: recoveredCodexHome } : {}),
      ...(config.envOverrides ?? {}),
    };
    if (Object.keys(combinedEnvOverrides).length > 0) {
      const { CLAUDE_CODE_EFFORT_LEVEL: legacyEffort, ...restOverrides } = combinedEnvOverrides;
      this._envOverrides = Object.keys(restOverrides).length > 0 ? restOverrides : undefined;
      if (legacyEffort && isEffortLevel(legacyEffort)) {
        this._effort = legacyEffort;
      }
    }
    this._codexProviderCredentialsLost =
      this.mode === 'codex' &&
      (config.codexProviderIdentity === null || config.codexProviderIdentity?.credentialSource === 'session-key') &&
      !combinedEnvOverrides.OPENAI_API_KEY &&
      !combinedEnvOverrides.CODEX_API_KEY;
    if (config.effort && isEffortLevel(config.effort)) {
      this._effort = config.effort;
    }
    if (config.truecolorEnabled !== undefined) {
      this._truecolorEnabled = config.truecolorEnabled;
    }
    this._docker = config.docker;
    this._owner = config.owner;
    // Never self-parent: a session pointing at itself would draw a zero-length
    // lineage arc under its own tab. Only reachable via the recovery path, where
    // both the id and the saved parent come from disk.
    this._parentSessionId = config.parentSessionId === this.id ? undefined : config.parentSessionId;
    if (config.attachmentHistory && config.attachmentHistory.length > 0) {
      this.restoreAttachmentHistory(config.attachmentHistory);
    }
    if (config.sources && config.sources.length > 0) {
      this.restoreSources(config.sources);
    }

    // Initialize task tracker and forward events (store handlers for cleanup)
    this._taskTracker = new TaskTracker();
    this._taskTrackerHandlers = {
      taskCreated: (task) => this.emit('taskCreated', task),
      taskUpdated: (task) => this.emit('taskUpdated', task),
      taskCompleted: (task) => this.emit('taskCompleted', task),
      taskFailed: (task, error) => this.emit('taskFailed', task, error),
    };
    this._taskTracker.on('taskCreated', this._taskTrackerHandlers.taskCreated);
    this._taskTracker.on('taskUpdated', this._taskTrackerHandlers.taskUpdated);
    this._taskTracker.on('taskCompleted', this._taskTrackerHandlers.taskCompleted);
    this._taskTracker.on('taskFailed', this._taskTrackerHandlers.taskFailed);

    // Initialize Ralph tracker and forward events (store handlers for cleanup)
    this._ralphTracker = new RalphTracker();
    this._ralphHandlers = {
      loopUpdate: (state) => this.emit('ralphLoopUpdate', state),
      todoUpdate: (todos) => this.emit('ralphTodoUpdate', todos),
      completionDetected: (phrase) => this.emit('ralphCompletionDetected', phrase),
      statusBlockDetected: (block) => this.emit('ralphStatusBlockDetected', block),
      circuitBreakerUpdate: (status) => this.emit('ralphCircuitBreakerUpdate', status),
      exitGateMet: (data) => this.emit('ralphExitGateMet', data),
    };
    this._ralphTracker.on('loopUpdate', this._ralphHandlers.loopUpdate);
    this._ralphTracker.on('todoUpdate', this._ralphHandlers.todoUpdate);
    this._ralphTracker.on('completionDetected', this._ralphHandlers.completionDetected);
    this._ralphTracker.on('statusBlockDetected', this._ralphHandlers.statusBlockDetected);
    this._ralphTracker.on('circuitBreakerUpdate', this._ralphHandlers.circuitBreakerUpdate);
    this._ralphTracker.on('exitGateMet', this._ralphHandlers.exitGateMet);

    // Initialize Bash tool parser and forward events (store handlers for cleanup)
    this._bashToolParser = new BashToolParser({ sessionId: this.id, workingDir: this.workingDir });
    this._bashToolHandlers = {
      toolStart: (tool) => this.emit('bashToolStart', tool),
      toolEnd: (tool) => this.emit('bashToolEnd', tool),
      toolsUpdate: (tools) => this.emit('bashToolsUpdate', tools),
    };
    this._bashToolParser.on('toolStart', this._bashToolHandlers.toolStart);
    this._bashToolParser.on('toolEnd', this._bashToolHandlers.toolEnd);
    this._bashToolParser.on('toolsUpdate', this._bashToolHandlers.toolsUpdate);

    // Initialize auto-compact/auto-clear automation and forward events
    this._autoOps = new SessionAutoOps({
      writeCommand: (cmd) => this.writeViaMux(cmd),
      writeCheckpointCommand: (cmd) => this.writeCheckpointViaMux(cmd),
      getCheckpointObservation: () => this.getCheckpointAutomationObservation(),
      getCheckpointBackendMode: () => this.mode,
      getCheckpointCapabilityReason: (mode) => {
        if (mode === 'compact') return undefined;
        if (this.mode === 'codex' && this._remote) return 'remote-identity-unavailable';
        if (this.mode === 'claude' && !this._claudeSessionStartHookReady) {
          return 'session-start-hook-unavailable';
        }
        if (this.mode === 'claude' && !this._claudeSessionIdentityAdopted) {
          return 'baseline-identity-unavailable';
        }
        return undefined;
      },
      isWorking: () => this._isWorking,
      isStopped: () => this._isStopped,
      getTotalTokens: () => this._totalInputTokens + this._totalOutputTokens,
      getSessionId: () => this.id,
    });
    this._autoOps.on('autoCompact', (data) => this.emit('autoCompact', data));
    this._autoOps.on('autoClear', (data) => {
      // Reset token counts on clear
      this._totalInputTokens = 0;
      this._totalOutputTokens = 0;
      this.emit('autoClear', data);
    });
    this._autoOps.on('checkpointStart', (data) => this.emit('checkpointStart', data));
    this._autoOps.on('checkpointDone', (data) => this.emit('checkpointDone', data));
    this._autoOps.on('checkpointProgress', (data: CheckpointProgress) => {
      if (data.phase === 'failed' || data.phase === 'aborted' || data.phase === 'done') {
        this._checkpointAwaitingInstantClear = false;
        this._checkpointInstantClearBaseline = null;
        this._checkpointDirectPtySawClear = false;
        this._checkpointCodexFreshBaselineId = undefined;
        this._checkpointCodexFreshBaselineIds = [];
        this._checkpointCodexFreshTransitionArmed = false;
      }
      this.emit('checkpointProgress', data);
    });
    this._autoOps.on('limitPauseScheduled', (data) => this.emit('limitPauseScheduled', data));
    this._autoOps.on('limitResume', (data) => this.emit('limitResume', data));
    this._autoOps.on('limitResumeCancelled', (data) => this.emit('limitResumeCancelled', data));
    if (typeof config.checkpointEnabled === 'boolean') {
      this._autoOps.setCheckpoint(config.checkpointEnabled);
    }
    this._autoOps.restoreCheckpointStates(config.checkpointRuns as Record<string, CheckpointState> | undefined);
    this._autoOps.restoreCheckpointState(config.checkpointState);
  }

  get status(): SessionStatus {
    return this._status;
  }

  get currentTaskId(): string | null {
    return this._currentTaskId;
  }

  get pid(): number | null {
    return this._pid;
  }

  get terminalBuffer(): string {
    return this._terminalBuffer.value;
  }

  get terminalBufferLength(): number {
    return this._terminalBuffer.length;
  }

  get textOutput(): string {
    return this._textOutput.value;
  }

  get errorBuffer(): string {
    return this._errorBuffer;
  }

  get lastActivityAt(): number {
    return this._lastActivityAt;
  }

  get claudeSessionId(): string | null {
    return this._claudeSessionId;
  }

  /** Docker execution metadata when this session runs inside a container, else undefined. */
  get docker(): SessionDocker | undefined {
    return this._docker;
  }

  /** Remote-SSH metadata when this session runs on a remote host, else undefined. */
  get remote(): SessionRemote | undefined {
    return this._remote;
  }

  /** Owning username in multi-user mode, else undefined. */
  get owner(): string | undefined {
    return this._owner;
  }

  /** The session that spawned this one (tab lineage decoration), else undefined. */
  get parentSessionId(): string | undefined {
    return this._parentSessionId;
  }

  /** Set the owning username (used by recovery to restore ownership). */
  set owner(username: string | undefined) {
    this._owner = username;
  }

  // Update Claude's best-effort viewer identity. This does not establish the
  // authoritative checkpoint baseline; only SessionStart may do that.
  adoptClaudeSessionId(newId: string): void {
    if (!newId) return;
    if (newId === this._claudeSessionId) return;
    this._claudeSessionId = newId;
  }

  /** Adopt the authoritative identity delivered by Claude's SessionStart hook. */
  adoptClaudeSessionStartId(newId: string): void {
    if (!newId) return;
    this._claudeSessionStartHookReady = true;
    this._claudeSessionIdentityAdopted = true;
    this._claudeAuthoritativeSessionId = newId;
    this.adoptClaudeSessionId(newId);
  }

  private _seedClaudeViewerIdentityAfterMuxAttach(isRestored: boolean): void {
    if (!isRestored) this._claudeSessionId = this._resumeSessionId || this.id;
  }

  /** The tmux session name, if the session is running inside a mux */
  get muxName(): string | null {
    return this._muxSession?.muxName ?? null;
  }

  /**
   * True when this session's PTY is a tmux client rather than the program itself.
   * Read by the replay-side alt-screen strip, which must apply the same
   * `useMux` gate as the live strip (isMuxAltScreenOnlyStripMode).
   */
  get usesMux(): boolean {
    return this._useMux;
  }

  get totalCost(): number {
    return this._totalCost;
  }

  get messages(): ClaudeMessage[] {
    return this._messages;
  }

  get isWorking(): boolean {
    return this._isWorking;
  }

  /**
   * Check if the session's process tree has active child processes beyond Claude itself.
   * Detects running bash tools, test suites, builds, servers, etc. that Claude spawned.
   *
   * The tmux pane PID is typically "claude" directly (bash exec'd into it). When Claude
   * runs a bash tool, it spawns child processes: claude → bash → npm/node/python/etc.
   * We check direct children of the pane PID, filtering out "claude" itself (for the rare
   * case where bash wraps claude and didn't exec).
   *
   * Returns an array of {pid, command} for each child process, or empty array if none.
   * Returns empty array if no mux session or on error (fail-open to avoid blocking respawn).
   */
  getActiveChildProcesses(): { pid: number; command: string }[] {
    if (!this._muxSession) return [];

    try {
      const panePid = this._muxSession.pid;

      // Single call: get direct children with their command names
      const output = execSync(`ps -o pid=,comm= --ppid ${panePid} 2>/dev/null`, {
        encoding: 'utf-8',
        timeout: EXEC_TIMEOUT_MS,
      }).trim();
      if (!output) return [];

      const activeProcesses: { pid: number; command: string }[] = [];
      for (const line of output.split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(.+)/);
        if (!match) continue;
        const pid = parseInt(match[1], 10);
        const command = match[2].trim();
        // Skip the claude process itself (pane_pid may be bash wrapping claude)
        if (command === 'claude') continue;
        activeProcesses.push({ pid, command });
      }

      return activeProcesses;
    } catch {
      // ps returns exit code 1 when no matches — normal (no children)
      return [];
    }
  }

  get lastPromptTime(): number {
    return this._lastPromptTime;
  }

  get taskTracker(): TaskTracker {
    return this._taskTracker;
  }

  get runningTaskCount(): number {
    return this._taskTracker.getRunningCount();
  }

  get taskTree(): BackgroundTask[] {
    return this._taskTracker.getTaskTree();
  }

  get taskStats(): { total: number; running: number; completed: number; failed: number } {
    return this._taskTracker.getStats();
  }

  // Ralph tracking getters
  get ralphTracker(): RalphTracker {
    return this._ralphTracker;
  }

  get ralphLoopState(): RalphTrackerState {
    return this._ralphTracker.loopState;
  }

  get ralphTodos(): RalphTodoItem[] {
    return this._ralphTracker.todos;
  }

  get ralphTodoStats(): { total: number; pending: number; inProgress: number; completed: number } {
    return this._ralphTracker.getTodoStats();
  }

  // Bash tool tracking getters
  get bashToolParser(): BashToolParser {
    return this._bashToolParser;
  }

  get activeTools(): ActiveBashTool[] {
    return this._bashToolParser.activeTools;
  }

  get parentAgentId(): string | null {
    return this._parentAgentId;
  }

  set parentAgentId(value: string | null) {
    this._parentAgentId = value;
  }

  get childAgentIds(): string[] {
    return [...this._childAgentIds];
  }

  addChildAgentId(agentId: string): void {
    if (!this._childAgentIds.includes(agentId)) {
      this._childAgentIds.push(agentId);
    }
  }

  removeChildAgentId(agentId: string): void {
    const idx = this._childAgentIds.indexOf(agentId);
    if (idx >= 0) this._childAgentIds.splice(idx, 1);
  }

  // Nice priority config getters and setters
  get niceConfig(): NiceConfig {
    return { ...this._niceConfig };
  }

  /** Claude CLI startup permission mode */
  get claudeMode(): ClaudeMode {
    return this._claudeMode;
  }

  /** Allowed tools list (for 'allowedTools' mode) */
  get allowedTools(): string | undefined {
    return this._allowedTools;
  }

  /** Codex CLI configuration for this session. */
  get codexConfig(): CodexConfig | undefined {
    return this._codexConfig;
  }

  /** OpenCode CLI configuration for this session. */
  get openCodeConfig(): OpenCodeConfig | undefined {
    return this._openCodeConfig;
  }

  /** Gemini CLI configuration for this session. */
  get geminiConfig(): GeminiConfig | undefined {
    return this._geminiConfig;
  }

  /**
   * Native external-CLI session/conversation id captured at park time
   * (COD-124 unit 2, Gap B; widened to opencode/gemini/agy by COD-251) — see
   * {@link setNativeResumeId} and {@link _applyNativeResumeIdForResume}.
   */
  get nativeResumeId(): string | null {
    return this._nativeResumeId;
  }

  /**
   * Record the native CLI session/conversation id discovered at park time.
   * Called by the park route after locating the on-disk session record for
   * codex/opencode/gemini/agy sessions; left null for CLIs with no analogous
   * on-disk resume mechanism (claude/shell).
   */
  setNativeResumeId(id: string | null): void {
    this._nativeResumeId = id;
  }

  /**
   * If a native resume id was captured at a previous park and the CLI mode
   * supports resuming by id (codex via `codex resume <id>`, opencode via
   * `--session <id>`, gemini via `--resume <id>`, agy via `--conversation
   * <id>` — see the matching builders in tmux-manager.ts), merge it into the
   * mode-specific launch config so the upcoming relaunch resumes the original
   * conversation instead of starting fresh. A no-op for modes without a wired
   * resume mechanism (claude/shell).
   *
   * Only fills in the id when the config doesn't already carry an explicit
   * resume target, so an explicit caller-supplied resume id always wins.
   */
  private _applyNativeResumeIdForResume(): void {
    if (!this._nativeResumeId) return;
    if (this.mode === 'codex') {
      this._codexConfig = {
        ...this._codexConfig,
        resumeSessionId: this._codexConfig?.resumeSessionId ?? this._nativeResumeId,
      };
    } else if (this.mode === 'opencode') {
      this._openCodeConfig = {
        ...this._openCodeConfig,
        continueSession: this._openCodeConfig?.continueSession ?? this._nativeResumeId,
      };
    } else if (this.mode === 'gemini') {
      this._geminiConfig = {
        ...this._geminiConfig,
        resumeSession: this._geminiConfig?.resumeSession ?? this._nativeResumeId,
      };
    } else if (this.mode === 'antigravity') {
      this._antigravityConfig = {
        ...this._antigravityConfig,
        resumeConversationId: this._antigravityConfig?.resumeConversationId ?? this._nativeResumeId ?? undefined,
      };
    }
    // claude/shell: no on-disk resume mechanism — nativeResumeId stays inert.
  }

  /** Agy CLI configuration for this session. */
  get antigravityConfig(): AntigravityConfig | undefined {
    return this._antigravityConfig;
  }

  // Note: _buildPermissionArgs removed — now using buildInteractiveArgs from session-cli-builder.ts

  /**
   * Set CPU priority configuration.
   * Note: This only affects new sessions; existing running processes won't be changed.
   */
  setNice(config: Partial<NiceConfig>): void {
    if (config.enabled !== undefined) {
      this._niceConfig.enabled = config.enabled;
    }
    if (config.niceValue !== undefined) {
      // Clamp to valid range
      this._niceConfig.niceValue = Math.max(-20, Math.min(19, config.niceValue));
    }
  }

  // Session color for visual differentiation
  get color(): import('./types.js').SessionColor {
    return this._color;
  }

  setColor(color: import('./types.js').SessionColor): void {
    const validColors = ['default', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'];
    if (validColors.includes(color)) {
      this._color = color;
    }
  }

  // Token tracking getters and setters
  get totalTokens(): number {
    return this._totalInputTokens + this._totalOutputTokens;
  }

  get inputTokens(): number {
    return this._totalInputTokens;
  }

  get outputTokens(): number {
    return this._totalOutputTokens;
  }

  /**
   * Restore token and cost values from saved state.
   * Called when recovering sessions after server restart.
   */
  restoreTokens(inputTokens: number, outputTokens: number, totalCost: number): void {
    // Sanity check: reject absurdly large individual values
    if (inputTokens > MAX_SESSION_TOKENS || outputTokens > MAX_SESSION_TOKENS) {
      console.warn(
        `[Session ${this.id}] Rejected absurd restored tokens: input=${inputTokens}, output=${outputTokens}`
      );
      return;
    }
    // Check token sum doesn't overflow MAX_SESSION_TOKENS
    if (inputTokens + outputTokens > MAX_SESSION_TOKENS) {
      console.warn(
        `[Session ${this.id}] Rejected token sum overflow: input=${inputTokens} + output=${outputTokens} = ${inputTokens + outputTokens} > ${MAX_SESSION_TOKENS}`
      );
      return;
    }
    // Reject negative values
    if (inputTokens < 0 || outputTokens < 0 || totalCost < 0) {
      console.warn(
        `[Session ${this.id}] Rejected negative restored tokens: input=${inputTokens}, output=${outputTokens}, cost=${totalCost}`
      );
      return;
    }

    this._totalInputTokens = inputTokens;
    this._totalOutputTokens = outputTokens;
    this._totalCost = totalCost;
  }

  get autoClearThreshold(): number {
    return this._autoOps.autoClearThreshold;
  }

  get autoClearEnabled(): boolean {
    return this._autoOps.autoClearEnabled;
  }

  get name(): string {
    return this._name;
  }

  /** COD-102: whether this session was routed through Headroom at spawn. */
  get headroomRouted(): boolean | undefined {
    return this._muxSession?.headroomRouted;
  }

  /** COD-254: when the Headroom launch/respawn routing snapshot was recorded. */
  get headroomRoutedAt(): number | undefined {
    return this._muxSession?.headroomRoutedAt;
  }

  set name(value: string) {
    this._name = value;
  }

  setAutoClear(enabled: boolean, threshold?: number): void {
    this._autoOps.setAutoClear(enabled, threshold);
  }

  get autoCompactThreshold(): number {
    return this._autoOps.autoCompactThreshold;
  }

  get autoCompactEnabled(): boolean {
    return this._autoOps.autoCompactEnabled;
  }

  get autoCompactPrompt(): string {
    return this._autoOps.autoCompactPrompt;
  }

  setAutoCompact(enabled: boolean, threshold?: number, prompt?: string): void {
    this._autoOps.setAutoCompact(enabled, threshold, prompt);
  }

  get checkpointEnabled(): boolean {
    return this._autoOps.checkpointEnabled;
  }

  /** The mode a bare checkpoint runs (compact-preferred); legacy compat field. */
  get checkpointMode(): SessionCheckpointMode {
    return this._autoOps.checkpointMode;
  }

  /** Modes the agent is allowed to invoke at checkpoint signal time. */
  get checkpointModes(): SessionCheckpointMode[] {
    return this._autoOps.checkpointModes;
  }

  /** Durable last-known checkpoint lifecycle record. */
  get checkpointState(): CheckpointState | undefined {
    return this._autoOps.checkpointState;
  }

  get checkpointStates(): Record<string, CheckpointState> {
    return this._autoOps.checkpointStates;
  }

  /** Enable/disable agent-initiated checkpoints; optionally set allowed modes. */
  setCheckpoint(enabled: boolean, modes?: SessionCheckpointMode[]): void {
    this._autoOps.setCheckpoint(enabled, modes);
  }

  /** Restore persisted checkpoint enable/allowed-modes after a Codeman restart. */
  restoreCheckpoint(enabled: boolean, modes?: SessionCheckpointMode[]): void {
    this._autoOps.restoreCheckpoint(enabled, modes);
  }

  /** Agent signal: run the checkpoint op, then continue once it completes. */
  requestCheckpoint(opts?: { mode?: CheckpointMode; continuePrompt?: string }): {
    triggered: boolean;
    runId?: string;
    reason?: string;
  } {
    return this._autoOps.requestCheckpoint(opts);
  }

  /** Cancel checkpoint automation before accepting user-originated terminal input. */
  cancelCheckpoint(reason = 'manual-takeover'): void {
    this._autoOps.cancelCheckpoint(reason);
  }

  private async getCheckpointAutomationObservation(): Promise<CheckpointObservation> {
    const terminal = this.getCheckpointObservation();
    if (this.mode === 'claude') {
      return {
        ...terminal,
        conversationId: this._claudeSessionIdentityAdopted
          ? (this._claudeAuthoritativeSessionId ?? undefined)
          : undefined,
      };
    }
    if (this.mode === 'codex') {
      const codexHome = process.env.CODEX_HOME || path.join(process.env.HOME || '/tmp', '.codex');
      const conversationId = this._checkpointCodexFreshTransitionArmed
        ? (
            await findAuthoritativeCodexConversation({
              codexHome,
              sessionId: this.id,
              baselineId: this._checkpointCodexFreshBaselineId,
              baselineIds: this._checkpointCodexFreshBaselineIds,
            })
          )?.id
        : (
            await findActiveCodexConversation({
              codexHome,
              sessionId: this.id,
              workingDir: this.workingDir,
              resumeSessionId: this._codexConfig?.resumeSessionId,
              lastSubmitAt: this._lastSubmitAt,
              competingSubmitAts: [...Session.codexSubmitTimes.entries()]
                .filter(([sessionId]) => sessionId !== this.id)
                .map(([, submittedAt]) => submittedAt),
            })
          )?.id;
      if (conversationId) {
        this._checkpointCodexConversationId = conversationId;
        if (this._checkpointCodexFreshTransitionArmed) invalidateCodexConversationInventory(codexHome);
      }
      return { ...terminal, conversationId };
    }
    return terminal;
  }

  /**
   * Return positive, mode-aware terminal evidence for checkpoint sequencing.
   * A semantic revision advances only after an observed ready prompt is left
   * and a ready prompt later returns; repainting the same prompt is stable.
   */
  getCheckpointObservation(): CheckpointObservation {
    const muxName = this._muxSession?.muxName;
    const rendered = muxName ? this._mux?.captureActivePaneBuffer?.(muxName) : null;
    if (muxName && !rendered) {
      // A failed/empty capture is absence of evidence, not evidence that the
      // prompt disappeared. Preserve the last semantic state so a capture
      // blip cannot fabricate an accepted/completed operation cycle.
      if (!this._isWorking) return { ...this._checkpointLastObservation };
      this._checkpointWasReady = false;
      this._checkpointLastObservation = {
        ready: false,
        working: true,
        revision: this._checkpointPromptRevision,
      };
      return { ...this._checkpointLastObservation };
    }
    let working = this._isWorking;
    let ready = false;

    if (rendered) {
      // formatPaneSnapshot paints rows with absolute cursor moves and no EOLs.
      // Restore row boundaries before the generic ANSI strip so `›`/`❯` and
      // working evidence retain their line semantics. This is not Codex-only:
      // the prompt checks below are `^`-anchored, so an unrestored frame is a
      // single line and the prompt is never visible — which stalls every
      // checkpoint mode in `waiting-ready` until `readiness-timeout`.
      const checkpointFrame = rendered.replace(TMUX_ABSOLUTE_ROW_START_PATTERN, '\n');
      const plain = checkpointFrame.replace(ANSI_ESCAPE_PATTERN_FULL, '');
      const renderedWorking =
        this.mode === 'codex'
          ? detectCodexCheckpointWorkingFrame(plain)
          : this.mode === 'claude'
            ? detectClaudeCheckpointWorkingFrame(plain)
            : false;
      working = working || renderedWorking;
      const promptVisible =
        this.mode === 'codex'
          ? /^\s*›(?:\s|$)/m.test(plain)
          : this.mode === 'claude'
            ? /^\s*❯(?:\s|$)/m.test(plain)
            : false;
      ready = promptVisible && !working;
      if (ready) {
        const fingerprint = this._checkpointSemanticFrameFingerprint(plain);
        if (this._checkpointAwaitingInstantClear && this._checkpointWasReady) {
          if (this._isCheckpointClearRejection(plain)) {
            this._checkpointAwaitingInstantClear = false;
            this._checkpointInstantClearBaseline = null;
          } else if (this._isConfirmedInstantClearReplacement(fingerprint)) {
            this._checkpointPromptRevision++;
            this._checkpointAwaitingInstantClear = false;
            this._checkpointInstantClearBaseline = null;
          }
        }
        this._checkpointReadyFingerprint = fingerprint;
      }
    } else if (this.mode === 'claude') {
      // Direct-PTY Claude fallback uses the existing positively recorded prompt
      // transition; initial `idle` alone is not sufficient evidence.
      ready = this._lastPromptTime > 0 && this._status === 'idle' && !working;
    } else if (this.mode !== 'codex') {
      // Preserve legacy behavior for modes without verified prompt syntax.
      ready = !working;
    }

    if (ready && !this._checkpointWasReady) {
      this._checkpointPromptRevision++;
      this._checkpointAwaitingInstantClear = false;
      this._checkpointInstantClearBaseline = null;
    }
    this._checkpointWasReady = ready;
    this._checkpointLastObservation = { ready, working, revision: this._checkpointPromptRevision };
    return { ...this._checkpointLastObservation };
  }

  /**
   * Normalize a ready frame to its semantic body. Prompt/status-only redraws
   * remain stable, while `/clear` replacing the visible conversation/banner
   * produces a new generation even if leave+return happened between polls.
   */
  private _checkpointSemanticFrameFingerprint(plain: string): string {
    return plain
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !/^[›❯](?:\s|$)/.test(line))
      .filter((line) => !/^(?:gpt-|codex\b|o\d\b).*\s·\s/i.test(line))
      .filter((line) => !/\b(?:context left|bypass permissions)\b/i.test(line))
      .join('\n');
  }

  private _isCheckpointClearRejection(text: string): boolean {
    return /(?:\b(?:error|unknown command|unrecognized command|invalid command|not found|unsupported)\b[^\n]*\/clear|\/clear[^\n]*\b(?:error|unknown|unrecognized|invalid|not found|unsupported)\b)/i.test(
      text
    );
  }

  private _isConfirmedInstantClearReplacement(current: string): boolean {
    const baseline = this._checkpointInstantClearBaseline;
    if (!baseline || !current || current === baseline) return false;
    const previousLines = baseline.split('\n').filter(Boolean);
    const currentLines = new Set(current.split('\n').filter(Boolean));
    // Appended errors, notices, or unrelated rows retain the entire prior
    // semantic frame. A successful clear must remove/replace prior content.
    return previousLines.some((line) => !currentLines.has(line));
  }

  private _noteDirectPtyCheckpointGeneration(data: string): void {
    if (!this._checkpointAwaitingInstantClear || this.mode !== 'claude' || this._muxSession) return;
    if (this._isCheckpointClearRejection(data)) {
      this._checkpointAwaitingInstantClear = false;
      this._checkpointInstantClearBaseline = null;
      this._checkpointDirectPtySawClear = false;
      return;
    }
    const sawClearScreen =
      data.includes('\u001b[J') || data.includes('\u001b[2J') || data.includes('\u001b[3J') || data.includes('\u000c');
    if (sawClearScreen) {
      this._checkpointDirectPtySawClear = true;
    }
    if (this._checkpointDirectPtySawClear && data.includes('❯')) {
      this._checkpointPromptRevision++;
      this._checkpointAwaitingInstantClear = false;
      this._checkpointInstantClearBaseline = null;
      this._checkpointDirectPtySawClear = false;
    }
  }

  get autoResumeEnabled(): boolean {
    return this._autoOps.autoResumeEnabled;
  }

  /** When the scheduled usage-limit auto-resume fires (epoch ms), or null. */
  get autoResumeAt(): number | null {
    return this._autoOps.autoResumeAt;
  }

  /** True while the session is paused on a Claude usage limit (auto-resume armed). */
  get isLimitPaused(): boolean {
    return this._autoOps.isLimitPaused;
  }

  setAutoResume(enabled: boolean): void {
    this._autoOps.setAutoResume(enabled);
    // Users typically enable this WHILE a session already sits paused — the
    // limit footer won't reprint on its own, so scan the recent buffer once.
    // Only a future reset time counts: stale scrollback must not arm a resume.
    if (enabled && !isExternalCliMode(this.mode)) {
      const tail = this._terminalBuffer.value.slice(-8192).replace(ANSI_ESCAPE_PATTERN_FULL, '');
      const detection = detectUsageLimitPause(tail);
      if (detection && detection.resetAt > Date.now()) {
        this._autoOps.processCleanData(tail);
      }
    }
  }

  /** Restore auto-resume state (and a pending schedule) after Codeman restart. */
  restoreAutoResume(enabled: boolean, resumeAt?: number): void {
    this._autoOps.restoreAutoResume(enabled, resumeAt);
  }

  get imageWatcherEnabled(): boolean {
    return this._imageWatcherEnabled;
  }

  set imageWatcherEnabled(enabled: boolean) {
    this._imageWatcherEnabled = enabled;
  }

  /** Whether this session is pinned to the top of the session manager (COD-139). */
  get pinned(): boolean {
    return this._pinned;
  }

  /** When the session was pinned (epoch ms), or null when unpinned. */
  get pinnedAt(): number | null {
    return this._pinnedAt;
  }

  /**
   * Set pin state (COD-139). Pinning stamps pinnedAt with now so the pinned
   * group orders most-recently-pinned first; unpinning clears it. Idempotent:
   * re-pinning an already-pinned session refreshes its pinnedAt.
   */
  setPinned(pinned: boolean): void {
    this._pinned = pinned;
    this._pinnedAt = pinned ? Date.now() : null;
  }

  get flickerFilterEnabled(): boolean {
    return this._flickerFilterEnabled;
  }

  set flickerFilterEnabled(enabled: boolean) {
    this._flickerFilterEnabled = enabled;
  }

  isIdle(): boolean {
    return this._status === 'idle';
  }

  isBusy(): boolean {
    return this._status === 'busy';
  }

  isRunning(): boolean {
    return this._status === 'idle' || this._status === 'busy';
  }

  get attachmentHistory(): SessionAttachmentHistoryItem[] {
    return sanitizeAttachmentHistory(this._attachmentHistory);
  }

  upsertAttachmentHistory(item: SessionAttachmentHistoryItem): void {
    this._attachmentHistory = upsertAttachmentHistoryList(this._attachmentHistory, item);
  }

  /**
   * Drop attachment-history entries matching `predicate` (COD-241 unit 3).
   * Used by DELETE …/attachments/uploaded so a removed Codeman-uploaded copy
   * stops appearing in the paperclip drawer. Returns the number of entries
   * removed. Operates on the raw (externalPath-bearing) list so callers can
   * match by absolute path.
   */
  removeAttachmentHistory(predicate: (item: SessionAttachmentHistoryItem) => boolean): number {
    const before = this._attachmentHistory.length;
    this._attachmentHistory = this._attachmentHistory.filter((item) => !predicate(item));
    return before - this._attachmentHistory.length;
  }

  restoreAttachmentHistory(history: SessionAttachmentHistoryItem[] | undefined): void {
    this._attachmentHistory = [];
    for (const item of [...(history ?? [])].reverse()) {
      // Guard against malformed/legacy on-disk entries (null, non-object, or
      // missing required fields). historyKey() dereferences source/fileName, so
      // a bad item would otherwise throw inside the constructor and abort the
      // entire mux-recovery loop.
      if (!item || typeof item !== 'object' || !item.source || !item.fileName) continue;
      this.upsertAttachmentHistory(item);
    }
  }

  getAttachmentHistoryForPersist(): SessionAttachmentHistoryItem[] | undefined {
    return this._attachmentHistory.length > 0 ? this._attachmentHistory.map((item) => ({ ...item })) : undefined;
  }

  // ── Sources (COD-65) ──────────────────────────────────────────────────────

  get sources(): SessionSource[] {
    return [...this._sources];
  }

  addSource(item: SessionSource): void {
    const idx = this._sources.findIndex((s) => s.id === item.id);
    if (idx >= 0) {
      this._sources[idx] = { ...item };
    } else {
      this._sources.push({ ...item });
    }
  }

  removeSource(id: string): void {
    this._sources = this._sources.filter((s) => s.id !== id);
  }

  restoreSources(data: SessionSource[] | undefined): void {
    this._sources = data ? data.map((s) => ({ ...s })) : [];
  }

  getSourcesForPersist(): SessionSource[] | undefined {
    return this._sources.length > 0 ? this._sources.map((s) => ({ ...s })) : undefined;
  }

  // ─────────────────────────────────────────────────────────────────────────

  toState(): SessionState {
    return {
      id: this.id,
      pid: this.pid,
      status: this._status,
      workingDir: this.workingDir,
      remote: this._remote,
      docker: this._docker,
      owner: this._owner,
      parentSessionId: this._parentSessionId,
      currentTaskId: this._currentTaskId,
      createdAt: this.createdAt,
      lastActivityAt: this._lastActivityAt,
      name: this._name,
      mode: this.mode,
      autoClearEnabled: this._autoOps.autoClearEnabled,
      autoClearThreshold: this._autoOps.autoClearThreshold,
      autoCompactEnabled: this._autoOps.autoCompactEnabled,
      autoCompactThreshold: this._autoOps.autoCompactThreshold,
      autoCompactPrompt: this._autoOps.autoCompactPrompt,
      checkpointEnabled: this._autoOps.checkpointEnabled,
      checkpointMode: this._autoOps.checkpointMode,
      checkpointModes: this._autoOps.checkpointModes,
      checkpoint: this._autoOps.checkpointState,
      checkpointRuns: this._autoOps.checkpointStates,
      claudeSessionId: this._claudeSessionIdentityAdopted
        ? (this._claudeAuthoritativeSessionId ?? undefined)
        : undefined,
      claudeSessionIdentityAdopted: this._claudeSessionIdentityAdopted,
      autoResumeEnabled: this._autoOps.autoResumeEnabled,
      autoResumeAt: this._autoOps.autoResumeAt ?? undefined,
      imageWatcherEnabled: this._imageWatcherEnabled,
      pinned: this._pinned || undefined,
      pinnedAt: this._pinned ? (this._pinnedAt ?? undefined) : undefined,
      totalCost: this._totalCost,
      inputTokens: this._totalInputTokens,
      outputTokens: this._totalOutputTokens,
      ralphEnabled: this._ralphTracker.enabled,
      ralphAutoEnableDisabled: this._ralphTracker.autoEnableDisabled || undefined,
      ralphCompletionPhrase: this._ralphTracker.loopState.completionPhrase || undefined,
      parentAgentId: this._parentAgentId || undefined,
      childAgentIds: this._childAgentIds.length > 0 ? this._childAgentIds : undefined,
      niceEnabled: this._niceConfig.enabled,
      niceValue: this._niceConfig.niceValue,
      color: this._color,
      flickerFilterEnabled: this._flickerFilterEnabled,
      cliVersion: this._cliVersion || undefined,
      cliModel: this._cliModel || undefined,
      cliAccountType: this._cliAccountType || undefined,
      cliLatestVersion: this._cliLatestVersion || undefined,
      openCodeConfig: this._openCodeConfig,
      codexConfig: this._codexConfig,
      geminiConfig: this._geminiConfig,
      antigravityConfig: this._antigravityConfig,
      piConfig: this._piConfig,
      resumeSessionId: this._resumeSessionId,
      nativeResumeId: this._nativeResumeId,
      effort: this._effort,
      // COD-118: runtime-only — surfaced so the frontend can require explicit user
      // intent before restarting a crash-looped session. Deliberately NOT restored
      // by the constructor: a Codeman restart starts with a fresh breaker so boot
      // recovery can re-attach.
      respawnBlocked: this._respawnBlocked || undefined,
      attachmentHistory: this.attachmentHistory.length > 0 ? this.attachmentHistory : undefined,
      sources: this.getSourcesForPersist(),
      lastSubmitAt: this._lastSubmitAt || undefined,
      // envOverrides intentionally NOT on the public SessionState type — they must not
      // leak into SSE / GET /api/sessions broadcasts (schema allows OPENCODE_*, which
      // can carry secrets). For disk persistence, session-manager calls
      // getEnvOverridesForPersist() and writes alongside state.
    };
  }

  /**
   * Returns a subset of env overrides safe for disk persistence (state.json).
   * Only non-sensitive `CLAUDE_CODE_*` keys plus CLAUDE_CONFIG_DIR (a path, not
   * a secret — and losing it across a restart would silently move a session back
   * to the default Claude account, #255) are included. `OPENCODE_*` keys are
   * filtered out because the schema permits them and they can carry secrets
   * (e.g., OPENCODE_API_KEY); secrets must not land in `~/.codeman/state.json`.
   * Must NOT be included in any API-bound serializer — see toState() comment.
   */
  getEnvOverridesForPersist(): Record<string, string> | undefined {
    if (!this._envOverrides) return undefined;
    const safe: Record<string, string> = {};
    for (const [key, value] of Object.entries(this._envOverrides)) {
      if (key.startsWith('CLAUDE_CODE_') || key === 'CLAUDE_CONFIG_DIR') safe[key] = value;
    }
    return Object.keys(safe).length > 0 ? safe : undefined;
  }

  /**
   * Closed, runtime-only provider identity for an isolated Codex subprocess.
   * Exact keys only: arbitrary session overrides must never cross this seam.
   */
  getCodexProviderEnvironment(): CodexProviderEnvironment {
    const environment: CodexProviderEnvironment = {};
    if (!this._envOverrides) return environment;
    for (const key of ['CODEX_HOME', 'OPENAI_API_KEY', 'CODEX_API_KEY'] as const) {
      const value = this._envOverrides[key];
      if (value) environment[key] = value;
    }
    return environment;
  }

  /** CODEX_HOME only; safe for comparing another session's rollout namespace. */
  getCodexHomeOverride(): string | undefined {
    return this._envOverrides?.CODEX_HOME || undefined;
  }

  /** Whether recovery lost a session-scoped API credential that cannot safely fall back. */
  hasLostCodexProviderCredentials(): boolean {
    return this._codexProviderCredentialsLost;
  }

  /** Secret-free, disk-only identity record. Never include this in SessionState serializers. */
  getCodexProviderIdentityForPersist(): CodexProviderIdentity | undefined {
    if (this.mode !== 'codex') return undefined;
    const rawCodexHome = this.getCodexHomeOverride();
    const codexHome = rawCodexHome ? canonicalizeCodexHome(rawCodexHome, this.workingDir) : undefined;
    const hasSessionKey =
      this._codexProviderCredentialsLost ||
      Boolean(this._envOverrides?.OPENAI_API_KEY) ||
      Boolean(this._envOverrides?.CODEX_API_KEY);
    return {
      version: 1,
      credentialSource: hasSessionKey ? 'session-key' : 'restorable',
      ...(codexHome ? { codexHome } : {}),
    };
  }

  toDetailedState() {
    return {
      ...this.toLightDetailedState(),
      textOutput: this._textOutput.value,
      terminalBuffer: this._terminalBuffer.value,
    };
  }

  /**
   * Lightweight detailed state that excludes heavy buffers (textOutput, terminalBuffer).
   * Use for SSE session:updated broadcasts where buffers aren't needed.
   * Full buffers are fetched on-demand via /api/sessions/:id/terminal.
   */
  toLightDetailedState() {
    return {
      ...this.toState(),
      name: this._name,
      mode: this.mode,
      claudeSessionId: this._claudeSessionId,
      totalCost: this._totalCost,
      messageCount: this._messages.length,
      isWorking: this._isWorking,
      lastPromptTime: this._lastPromptTime,
      // Buffer statistics for monitoring long-running sessions
      bufferStats: {
        terminalBufferSize: this._terminalBuffer.length,
        textOutputSize: this._textOutput.length,
        messageCount: this._messages.length,
        maxTerminalBuffer: this._terminalBufferMaxSize,
        maxTextOutput: MAX_TEXT_OUTPUT_SIZE,
        maxMessages: MAX_MESSAGES,
      },
      // Background task tracking (light tree strips large output strings)
      taskStats: this._taskTracker.getStats(),
      taskTree: this._taskTracker.getTaskTreeLight(),
      // Token tracking
      tokens: {
        input: this._totalInputTokens,
        output: this._totalOutputTokens,
        total: this._totalInputTokens + this._totalOutputTokens,
      },
      autoClear: {
        enabled: this._autoOps.autoClearEnabled,
        threshold: this._autoOps.autoClearThreshold,
      },
      // CPU priority configuration
      nice: {
        enabled: this._niceConfig.enabled,
        niceValue: this._niceConfig.niceValue,
      },
      // Ralph tracking state
      ralphLoop: this._ralphTracker.loopState,
      ralphTodos: this._ralphTracker.todos,
      ralphTodoStats: this._ralphTracker.getTodoStats(),
    };
  }

  /**
   * Starts an interactive Claude CLI session with full terminal support.
   *
   * This spawns Claude CLI in interactive mode with the configured permission
   * mode (default: `--dangerously-skip-permissions`). If mux wrapping is enabled,
   * the session runs inside a tmux session for persistence across disconnects.
   *
   * @throws {Error} If a process is already running in this session
   *
   * @example
   * ```typescript
   * const session = new Session({ workingDir: '/project', useMux: true });
   * await session.startInteractive();
   * session.on('terminal', (data) => process.stdout.write(data));
   * session.write('help me with this code\r');
   * ```
   */
  private async _setupOrAttachMuxSession(options: {
    respawnPaneOptions: import('./mux-interface.js').RespawnPaneOptions;
    createSessionOptions: import('./mux-interface.js').CreateSessionOptions;
    spawnErrLabel: string;
  }): Promise<{ isRestored: boolean }> {
    const mux = this._mux!;

    // Verify stale mux session — tmux may have been destroyed (e.g., killed externally)
    if (this._muxSession && !(await mux.muxSessionExists(this._muxSession.muxName))) {
      console.log('[Session] Stale mux session detected (tmux gone):', this._muxSession.muxName);
      this._muxSession = null;
    }

    // Check if session exists but pane is dead (remain-on-exit keeps it alive)
    // Respawn the pane instead of creating a whole new session — preserves tmux scrollback
    let needsNewSession = false;
    if (this._muxSession && (await mux.isPaneDead(this._muxSession.muxName))) {
      console.log('[Session] Dead pane detected, respawning:', this._muxSession.muxName);
      const newPid = await mux.respawnPane(options.respawnPaneOptions);
      if (!newPid) {
        console.error('[Session] Failed to respawn pane, will create new session');
        needsNewSession = true;
      } else {
        // Wait a moment for the respawned process to fully start
        await new Promise((resolve) => setTimeout(resolve, MUX_STARTUP_DELAY_MS));
      }
    }

    // Check if we already have a mux session (restored session)
    const isRestored = this._muxSession !== null && !needsNewSession;
    if (isRestored) {
      console.log('[Session] Attaching to existing mux session:', this._muxSession!.muxName);
    } else {
      // Create a new mux session
      this._muxSession = await mux.createSession(options.createSessionOptions);
      console.log('[Session] Created mux session:', this._muxSession.muxName);
      // No extra sleep — createSession() already waits for tmux readiness
    }

    // Integration tests need a live input/output transport without attaching to
    // the host's tmux server or agent CLI. Production still uses the real mux.
    if (!IS_TEST_MODE) {
      // Prevent tmux from letting the newest browser attach dictate global window
      // size; accepted Codeman resize events update it explicitly below.
      mux.setManualWindowSize?.(this._muxSession!.muxName);
    }
    // Query existing tmux window size so re-attach matches (avoids flicker from 120x40 default).
    // MUST go through the dedicated socket (mux.muxSocket); a bare `tmux display` hits the
    // default server, always fails for our socketed sessions, and silently falls back to 120x40.
    const { cols: ptyCols, rows: ptyRows } = IS_TEST_MODE
      ? { cols: DEFAULT_PTY_COLS, rows: DEFAULT_PTY_ROWS }
      : queryTmuxWindowSize(this._muxSession!.muxName, mux.muxSocket);
    const attachCommand = IS_TEST_MODE ? process.execPath : mux.getAttachCommand();
    const attachArgs = IS_TEST_MODE ? ['-e', TEST_PTY_SCRIPT] : mux.getAttachArgs(this._muxSession!.muxName);
    try {
      this.ptyProcess = spawnPtyWithHelperRepair(() =>
        pty.spawn(attachCommand, attachArgs, {
          name: 'xterm-256color',
          cols: ptyCols,
          rows: ptyRows,
          cwd: resolveMuxAttachCwd(this.workingDir, this._remote, this._docker),
          // Truecolor is settings-driven here (COD-75 upstream hardcodes it per-mode
          // for codex/gemini/antigravity/pi); buildEnvExports() in tmux-manager.ts
          // reads the same flag so the attach client and the tmux session agree.
          env: buildMuxAttachEnv(this._truecolorEnabled),
        })
      );
    } catch (spawnErr) {
      console.error(`[Session] Failed to spawn PTY for ${options.spawnErrLabel}:`, spawnErr);
      this.emit('error', `Failed to attach to mux session: ${spawnErr}`);
      throw spawnErr;
    }

    return { isRestored };
  }

  /**
   * COD-108 — re-establish a dropped REMOTE session. Triggered by the
   * `TmuxManager` remote-reconnect watcher (via `remoteSessionDropped`): the
   * watcher detects a dead remote pane, the session owner reassembles the SAME
   * `RespawnPaneOptions` used for Claude-idle respawns and calls
   * `respawnPane()` directly. For a remote session that re-runs
   * `buildRemoteSessionCommand` (owned → `new-session -A`, non-owned →
   * `attach`), which idempotently REATTACHES the still-running durable remote
   * tmux session — scrollback + agent intact (proven COD-104/105).
   *
   * Deliberately does NOT route through the Claude-idle respawn-controller —
   * this is a transport re-establish, not a `/clear`/`/compact` cycle.
   *
   * @returns true if the pane was respawned (reattach issued), false otherwise.
   */
  async reattachRemote(): Promise<boolean> {
    if (!this._remote) return false; // not a remote session
    if (!this._useMux || !this._mux || !this._muxSession) return false;
    const mux = this._mux;

    // If tmux lost the whole session (not just a dead pane), there is nothing to
    // respawn into — a genuine death, leave it for normal recovery/reconcile.
    if (!(await mux.muxSessionExists(this._muxSession.muxName))) {
      console.log('[Session] reattachRemote: mux session gone, skipping:', this._muxSession.muxName);
      return false;
    }

    const newPid = await mux.respawnPane(this._buildRespawnPaneOptions());
    if (!newPid) {
      console.error('[Session] reattachRemote: respawnPane failed for', this._muxSession.muxName);
      return false;
    }
    console.log('[Session] reattachRemote: reattached remote session', this._muxSession.muxName, 'pid', newPid);
    return true;
  }

  /**
   * Assemble the {@link RespawnPaneOptions} for this session. Single source of
   * truth shared by interactive start, shell start (via their inline copies),
   * and {@link reattachRemote} so the remote reattach path can never drift from
   * the spawn path.
   */
  private _buildRespawnPaneOptions(): import('./mux-interface.js').RespawnPaneOptions {
    return {
      sessionId: this.id,
      workingDir: this.workingDir,
      mode: this.mode,
      name: this._name,
      niceConfig: this._niceConfig,
      model: this._model,
      claudeMode: this._claudeMode,
      allowedTools: this._allowedTools,
      openCodeConfig: this._openCodeConfig,
      codexConfig: this._codexConfig,
      geminiConfig: this._geminiConfig,
      antigravityConfig: this._antigravityConfig,
      piConfig: this._piConfig,
      resumeSessionId: this._resumeSessionId,
      envOverrides: this._envOverrides,
      effort: this._effort,
      truecolorEnabled: this._truecolorEnabled,
      historyLimit: this._tmuxHistoryLimit,
      remote: this._remote,
      docker: this._docker,
      owner: this._owner,
    };
  }

  private _handleTerminalOutput(data: string): void {
    // COD-189: shell burst tracking runs on the SHARED output path — shell
    // sessions have their own onData handlers and never pass through the
    // interactive-session hooks.
    if (this.mode === 'shell') this._trackShellBurst(data);
    // Codex AND Claude Code emit sequences that wipe xterm.js scrollback, plus
    // mouse-tracking enables that hijack the scroll wheel so the user can't reach
    // scrollback. Claude Code does this intermittently (e.g. full-screen pickers /
    // dialogs), which is why terminal scroll-up "randomly" breaks for Claude
    // sessions on mobile and desktop until the dialog closes:
    //   - \x1b[?1049h / \x1b[?47h / \x1b[?1047h: switch to the alt buffer (no
    //     scrollback) — \x1b[?...l switches back.
    //   - \x1b[3J: erase saved lines (scrollback). (\x1b[2J / \x1b[J — erase
    //     the visible viewport — are left intact; the TUI repaints those rows.)
    //   - \x1b[?1000h / 1002h / 1003h / 1005h / 1006h / 1007h: mouse-tracking
    //     modes (X10, button-event, any-event, UTF-8, SGR, alt-scroll). Once on,
    //     xterm.js forwards wheel events to the CLI instead of scrolling the
    //     viewport, so the conversation is in scrollback but unreachable.
    //     (Focus events at ?1004 are left alone — codeman uses them for
    //     active-tab detection.)
    // Strip them at the source so neither the persisted buffer nor the live
    // SSE/WS stream carries them, keeping everything in the main buffer with
    // scrollback intact. These are controlled TUIs whose cursor-positioned
    // redraws overwrite only the cells they target, so non-erased rows keep
    // their content. Gated to Codex/Claude/Gemini (isAltScreenStripMode).
    //
    // Every OTHER mode (shell/opencode/antigravity) gets the NARROW strip when it
    // is tmux-backed: alt-screen toggles only, because the sequence that breaks
    // scrollback there is tmux's own client-side smcup at attach, not anything the
    // program in the pane emitted (issue #205, see isMuxAltScreenOnlyStripMode).
    // 3J and the mouse DECSETs stay, so `clear` and mouse-aware TUIs keep working.
    const fullStrip = isAltScreenStripMode(this.mode);
    const altOnlyStrip = !fullStrip && isMuxAltScreenOnlyStripMode(this.mode, this._useMux);
    if (fullStrip || altOnlyStrip) {
      // Debug capture (codex only): when CODEMAN_CODEX_RAW_LOG=1, write the raw
      // codex PTY output (pre-strip) to a per-session log file. Used to diagnose
      // the stacked-status-bar / ghost-row rendering issues by inspecting the
      // actual CUP / erase sequences codex emits. Disabled by default — set
      // CODEMAN_CODEX_RAW_LOG=1 in the codeman server env to turn it on.
      if (this.mode === 'codex' && process.env.CODEMAN_CODEX_RAW_LOG === '1') {
        try {
          const logDir = process.env.CODEMAN_CODEX_RAW_LOG_DIR || '/tmp';
          const logPath = path.join(logDir, `codex-raw-${this.id}.log`);
          // Prefix each chunk with a timestamp + byte count so we can correlate
          // chunks with state changes the user observes. Use a control-character
          // sentinel that codex itself won't emit so the file is still
          // round-trip-replayable into a terminal if needed.
          const ts = new Date().toISOString();
          fs.appendFileSync(logPath, `\x00[${ts} ${data.length}B]\x00${data}`);
        } catch (logErr) {
          // Never let logging break the session — log once and continue.
          if (!this._codexRawLogErrored) {
            console.error('[Session] CODEMAN_CODEX_RAW_LOG write failed:', logErr);
            this._codexRawLogErrored = true;
          }
        }
      }

      // Reassemble sequences split across PTY chunk boundaries first: a chunk
      // ending mid-sequence ('\x1b[?104' now, '9h' next) would slip past the
      // strip below and leave xterm stuck in the scrollback-less alt buffer
      // until the next buffer replay. Hold back an incomplete digit-only CSI
      // tail (≤7 chars — the longest strippable intro is '\x1b[?1049') and
      // prepend it to the next chunk; complete sequences are never held.
      data = this._altScreenSeqCarry + data;
      this._altScreenSeqCarry = '';
      // eslint-disable-next-line no-control-regex
      const splitTail = data.match(/\x1b(?:\[\??[0-9]{0,4})?$/);
      if (splitTail) {
        this._altScreenSeqCarry = splitTail[0];
        data = data.slice(0, -splitTail[0].length);
        if (!data) return;
      }
      // eslint-disable-next-line no-control-regex
      data = data.replace(/\x1b\[\?(?:47|1047|1049)[hl]/g, '');
      if (fullStrip) {
        data = data
          // eslint-disable-next-line no-control-regex
          .replace(/\x1b\[3J/g, '')
          // eslint-disable-next-line no-control-regex
          .replace(/\x1b\[\?(?:1000|1001|1002|1003|1005|1006|1007)[hl]/g, '');
      }
    }

    // Scan terminal output for attachment requests. `codeman://attach?...` is an
    // explicit magic link; Codex generated images report `Saved to: file://...`.
    // The web server applies the trust boundary for each request source.
    const attachmentRequests = parseTerminalAttachmentRequests(data);
    for (const request of attachmentRequests) {
      const seenKey = `${request.source}:${request.path}`;
      if (this._attachmentMagicSeen.has(seenKey)) continue;
      this._attachmentMagicSeen.add(seenKey);
      if (this._attachmentMagicSeen.size > 200) {
        const oldest = this._attachmentMagicSeen.values().next().value;
        if (oldest) this._attachmentMagicSeen.delete(oldest);
      }
      this.emit('attachmentRequested', {
        sessionId: this.id,
        path: request.path,
        source: request.source,
        timestamp: Date.now(),
      });
    }

    // BufferAccumulator handles auto-trimming when max size exceeded
    this._terminalBuffer.append(data);
    this._lastActivityAt = Date.now();
    this.emit('terminal', data);
    this.emit('output', data);
  }

  async startInteractive(): Promise<void> {
    if (this.ptyProcess) {
      throw new Error('Session already has a running process');
    }

    // Bounds the workspace-trust scan (see _maybeAcceptTrustDialog). Stamped here
    // rather than at PTY spawn so a slow mux attach still counts as startup.
    this._interactiveStartedAt = Date.now();
    this._trustDialogAttempts = 0;
    this._lastTrustDialogScanAt = 0;

    // COD-118: if the PTY exit breaker has tripped (repeated non-zero exits in a
    // short window), refuse to respawn. This is the uniform choke point that stops
    // automatic recovery/reconnect callers from re-creating a crash-looping PTY.
    // An explicit user restart clears it via resetRespawnBreaker().
    if (this._respawnBlocked) {
      throw new Error(
        'Respawn blocked: interactive PTY exited non-zero too many times in a short window (circuit breaker tripped). Restart the session to clear it.'
      );
    }

    // COD-124 unit 2, Gap B: if a native resume id was captured at a previous
    // park, fold it into the mode-specific launch config (currently codex
    // only) before building spawn options below, so the relaunch resumes the
    // original conversation instead of starting fresh.
    this._applyNativeResumeIdForResume();

    this._resetBuffers();

    const modeLabel = getModeLabel(this.mode);
    console.log(
      `[Session] Starting interactive ${modeLabel} session` + (this._useMux ? ` (with ${this._mux!.backend})` : '')
    );

    // Seed the CLI version deterministically for LOCAL Claude sessions. The
    // banner scrape in parseClaudeCodeInfo() is unreliable — newer Claude Code
    // builds don't print "Claude Code vX.Y.Z" at startup and resumed sessions
    // never show it — which left cliVersion undefined and silently disabled
    // wheel-forwarding to Claude's own transcript (the only route to history in
    // repaint/alt-screen mode; issue #154). Remote sessions run claude on
    // another host, so a local probe wouldn't reflect their version; they get
    // their own over-ssh probe below. Cached process-wide, best-effort.
    if (this.mode === 'claude' && !this._remote && !this._docker && !this._cliVersion) {
      const probedVersion = getClaudeCliVersion();
      if (probedVersion) {
        this._cliVersion = probedVersion;
        this.emit('cliInfoUpdated', {
          version: this._cliVersion,
          model: this._cliModel,
          accountType: this._cliAccountType,
          latestVersion: this._cliLatestVersion,
        });
      }
    }

    // Docker sessions run claude INSIDE the container, so the local probe above
    // reports the HOST claude (wrong version, and leaving cliVersion undefined
    // silently disables wheel-forwarding, #154). Probe the IN-CONTAINER version
    // instead — deferred so the container is up after the mux attach below.
    if (this.mode === 'claude' && this._docker && !this._cliVersion) {
      const dockerMeta = this._docker;
      setTimeout(() => {
        if (this._isStopped || this._cliVersion) return;
        void probeDockerCliVersion(dockerMeta, this.mode)
          .then((version) => {
            if (!version || this._isStopped || this._cliVersion) return;
            this._cliVersion = version;
            this.emit('cliInfoUpdated', {
              version: this._cliVersion,
              model: this._cliModel,
              accountType: this._cliAccountType,
              latestVersion: this._cliLatestVersion,
            });
          })
          .catch(() => {
            /* best-effort */
          });
      }, DOCKER_CLI_VERSION_PROBE_DELAY_MS);
    }

    // Remote sessions run claude on ANOTHER HOST, so neither the local nor the
    // docker probe applies, and the banner-scrape fallback they were left with
    // is the unreliable path #154 was filed for, so remote Claude cases silently
    // never got wheel-forwarding (noted in the #205 analysis). Probe over ssh,
    // deferred so session start never waits on the ssh round-trip.
    if (this.mode === 'claude' && this._remote && !this._cliVersion) {
      const remoteMeta = this._remote;
      setTimeout(() => {
        if (this._isStopped || this._cliVersion) return;
        void probeRemoteCliVersion(remoteMeta, this.mode)
          .then((version) => {
            if (!version || this._isStopped || this._cliVersion) return;
            this._cliVersion = version;
            this.emit('cliInfoUpdated', {
              version: this._cliVersion,
              model: this._cliModel,
              accountType: this._cliAccountType,
              latestVersion: this._cliLatestVersion,
            });
          })
          .catch(() => {
            /* best-effort */
          });
      }, REMOTE_CLI_VERSION_PROBE_DELAY_MS);
    }

    // If mux wrapping is enabled, create or attach to a mux session
    if (this._useMux && this._mux) {
      try {
        const { isRestored } = await this._setupOrAttachMuxSession({
          // Single source of truth shared with reattachRemote() (COD-108).
          respawnPaneOptions: this._buildRespawnPaneOptions(),
          createSessionOptions: {
            sessionId: this.id,
            workingDir: this.workingDir,
            mode: this.mode,
            name: this._name,
            niceConfig: this._niceConfig,
            model: this._model,
            claudeMode: this._claudeMode,
            allowedTools: this._allowedTools,
            openCodeConfig: this._openCodeConfig,
            codexConfig: this._codexConfig,
            geminiConfig: this._geminiConfig,
            antigravityConfig: this._antigravityConfig,
            piConfig: this._piConfig,
            resumeSessionId: this._resumeSessionId,
            envOverrides: this._envOverrides,
            effort: this._effort,
            truecolorEnabled: this._truecolorEnabled,
            historyLimit: this._tmuxHistoryLimit,
            remote: this._remote,
            initialCols: this._initialDims?.cols,
            initialRows: this._initialDims?.rows,
            docker: this._docker,
            owner: this._owner,
          },
          spawnErrLabel: 'mux attachment',
        });

        // A restored mux retains the persisted viewer + authoritative identity.
        // Only a newly spawned pane needs its viewer seed initialized here.
        this._seedClaudeViewerIdentityAfterMuxAttach(isRestored);

        // For NEW mux sessions: wait for readiness then clean buffer
        // For RESTORED mux sessions: don't do anything - client will fetch buffer on tab switch
        if (!isRestored) {
          if (isExternalCliMode(this.mode)) {
            // External CLIs use custom TUIs — no Claude ❯ prompt to detect.
            // Wait for TUI to stabilize, then mark ready. Don't clear the buffer — the TUI's
            // initial render IS the useful content. Emit needsRefresh so the client fetches
            // the full buffer once the TUI has rendered.
            this._promptCheckTimeout = setTimeout(() => {
              this._promptCheckTimeout = null;
              if (this._isStopped) return;
              this._status = 'idle';
              this.emit('needsRefresh');
            }, 3000);
          } else {
            // Claude mode: wait for ❯ prompt
            this._promptCheckInterval = setInterval(() => {
              // Wait for the prompt character (❯) which means Claude is fully initialized
              const bufferValue = this._terminalBuffer.value;
              if (bufferValue.includes('❯') || bufferValue.includes('\u276f')) {
                if (this._promptCheckInterval) {
                  clearInterval(this._promptCheckInterval);
                  this._promptCheckInterval = null;
                }
                if (this._promptCheckTimeout) {
                  clearTimeout(this._promptCheckTimeout);
                  this._promptCheckTimeout = null;
                }
                // Clean the buffer - remove mux init junk before actual content
                // Strip: cursor movement (\x1b[nA/B/C/D), positioning (\x1b[n;nH),
                // clear screen (\x1b[2J), scroll region (\x1b[n;nr), and whitespace
                this._terminalBuffer.set(bufferValue.replace(LEADING_ANSI_WHITESPACE_PATTERN, ''));
                // Signal client to refresh
                this.emit('clearTerminal');
              }
            }, 50);
            // Timeout after 5 seconds if prompt not found
            this._promptCheckTimeout = setTimeout(() => {
              if (this._promptCheckInterval) {
                clearInterval(this._promptCheckInterval);
                this._promptCheckInterval = null;
              }
              this._promptCheckTimeout = null;
            }, 5000);
          }
        }
      } catch (err) {
        console.error('[Session] Failed to create mux session, falling back to direct PTY:', err);
        this._useMux = false;
        this._muxSession = null;
      }
    }

    // Fallback to direct PTY if mux is not used
    if (!this.ptyProcess) {
      // OpenCode sessions require tmux for env var injection (API keys via setenv)
      if (this.mode === 'opencode') {
        throw new Error('OpenCode sessions require tmux. Direct PTY fallback is not supported.');
      }
      // Codex sessions require tmux for OPENAI_API_KEY injection via setenv
      if (this.mode === 'codex') {
        throw new Error('Codex sessions require tmux. Direct PTY fallback is not supported.');
      }
      // Gemini sessions require tmux for Gemini/Google auth env injection via setenv
      if (this.mode === 'gemini') {
        throw new Error('Gemini sessions require tmux. Direct PTY fallback is not supported.');
      }
      // Antigravity sessions require tmux for env override injection via setenv
      if (this.mode === 'antigravity') {
        throw new Error('Antigravity sessions require tmux. Direct PTY fallback is not supported.');
      }
      // Pi sessions require tmux for env override injection via setenv
      if (this.mode === 'pi') {
        throw new Error('Pi sessions require tmux. Direct PTY fallback is not supported.');
      }
      try {
        // Pass --session-id to use the SAME ID as the Codeman session
        // This ensures subagents can be directly matched to the correct tab
        const args = buildInteractiveArgs(
          this.id,
          this._claudeMode,
          this._model,
          this._allowedTools,
          this._effort,
          this._name,
          getClaudeCliVersion()
        );
        this.ptyProcess = spawnPtyWithHelperRepair(() =>
          pty.spawn(getClaudeBinaryPath(), args, {
            name: 'xterm-256color',
            cols: 120,
            rows: 40,
            cwd: this.workingDir,
            // Merge envOverrides after buildClaudeEnv so user settings shadow defaults.
            env: { ...buildClaudeEnv(this.id, this._truecolorEnabled), ...(this._envOverrides ?? {}) },
          })
        );
      } catch (spawnErr) {
        console.error('[Session] Failed to spawn Claude PTY:', spawnErr);
        this._status = 'stopped';
        this.emit('error', `Failed to start Claude: ${spawnErr}`);
        throw new Error(`Failed to spawn Claude process: ${spawnErr}`);
      }
    }

    // Set claudeSessionId — when resuming, the Claude conversation ID is the resumed one.
    this._claudeSessionId = this._resumeSessionId || this.id;

    this._pid = this.ptyProcess.pid;
    console.log('[Session] Interactive PTY spawned with PID:', this._pid);

    this.ptyProcess.onData((rawData: string) => {
      // Filter out focus escape sequences and Ctrl+L (form feed)
      const data = rawData.replace(FOCUS_ESCAPE_FILTER, '').replace(CTRL_L_PATTERN, ''); // Remove Ctrl+L
      if (!data) return; // Skip if only filtered sequences

      this._handleTerminalOutput(data);

      // === Auto-accept workspace trust dialog ===
      this._maybeAcceptTrustDialog();

      // === Idle/working detection runs on every chunk (latency-sensitive) ===
      this._detectInteractiveActivity(data);

      // === Expensive processing (ANSI strip, Ralph, bash parser) is throttled ===
      // Instead of running regex-heavy parsers on every PTY chunk, we accumulate
      // raw data and process at most every EXPENSIVE_PROCESS_INTERVAL_MS.
      // This dramatically reduces CPU load with multiple busy sessions.
      const now = Date.now();
      const elapsed = now - this._lastExpensiveProcessTime;
      if (elapsed >= Session.EXPENSIVE_PROCESS_INTERVAL_MS) {
        // Process immediately — include any previously accumulated data
        this._lastExpensiveProcessTime = now;
        const accumulated = this._pendingCleanData ? this._pendingCleanData + data : data;
        this._pendingCleanData = '';
        if (this._expensiveProcessTimer) {
          clearTimeout(this._expensiveProcessTimer);
          this._expensiveProcessTimer = null;
        }
        this._processExpensiveParsers(accumulated);
      } else {
        // Accumulate for deferred processing
        this._pendingCleanData += data;
        // Cap accumulated size to prevent unbounded growth
        if (this._pendingCleanData.length > 64 * 1024) {
          this._pendingCleanData = this._pendingCleanData.slice(-32 * 1024);
        }
        // Schedule deferred processing if not already scheduled
        if (!this._expensiveProcessTimer) {
          this._expensiveProcessTimer = setTimeout(() => {
            this._expensiveProcessTimer = null;
            this._lastExpensiveProcessTime = Date.now();
            const pending = this._pendingCleanData;
            this._pendingCleanData = '';
            if (pending) {
              this._processExpensiveParsers(pending);
            }
          }, Session.EXPENSIVE_PROCESS_INTERVAL_MS - elapsed);
        }
      }
    });

    // External CLIs never print the Claude '❯' prompt, so the initial-ready →
    // idle transition must come from the quiet-window timer instead. Arm it
    // once at spawn/attach; working frames re-arm it as they tick (COD-175).
    if (isExternalCliMode(this.mode)) {
      this._armExternalCliIdleTimer();
      // COD-181/182: external-CLI sessions can't rely on stream-chunk matching
      // — LOCAL sessions run inside tmux too, so the attach client delivers
      // the Working line as partial cell updates just like the remote nested
      // case (a local codex sleep-20 turn never flipped busy in COD-182 e2e).
      // Poll the rendered frame for the working pattern instead.
      this._startWorkingFramePoller();
    }

    this.ptyProcess.onExit(({ exitCode }) => {
      console.log('[Session] Interactive PTY exited with code:', exitCode);
      // COD-118: record the exit in the circuit breaker BEFORE status bookkeeping.
      // A clean (0) exit resets the counter; rapid non-zero repeats trip it.
      const breakerResult = this._ptyExitBreaker.recordExit(exitCode, Date.now());
      this.ptyProcess = null;
      this._pid = null;
      this._status = 'idle';
      this._awaitingIdleConfirmation = false;
      this._activityStreak = null;
      // Clear all timers to prevent memory leaks
      if (this.activityTimeout) {
        clearTimeout(this.activityTimeout);
        this.activityTimeout = null;
      }
      if (this._externalCliIdleTimer) {
        clearTimeout(this._externalCliIdleTimer);
        this._externalCliIdleTimer = null;
      }
      if (this._promptCheckInterval) {
        clearInterval(this._promptCheckInterval);
        this._promptCheckInterval = null;
      }
      if (this._promptCheckTimeout) {
        clearTimeout(this._promptCheckTimeout);
        this._promptCheckTimeout = null;
      }
      // Clear expensive processing timer and flush any pending data
      if (this._expensiveProcessTimer) {
        clearTimeout(this._expensiveProcessTimer);
        this._expensiveProcessTimer = null;
      }
      this._pendingCleanData = '';
      // If using mux, mark the session as detached but don't kill it
      if (this._muxSession && this._mux) {
        this._mux.setAttached(this.id, false);
      }
      // COD-118: if the breaker tripped, surface an error state and block the NEXT
      // respawn so recovery/reconnect callers stop looping. Still emit 'exit' below
      // for normal cleanup. Cleared by an explicit user restart (resetRespawnBreaker()).
      if (breakerResult.tripped && !this._respawnBlocked) {
        this._respawnBlocked = true;
        this._status = 'error';
        console.error(
          `[Session] PTY exit circuit breaker tripped for ${this.id} (${breakerResult.count} non-zero exits within window); blocking respawn.`
        );
        this.emit('respawnBreakerTripped', { count: breakerResult.count });
      }
      this.emit('exit', exitCode);
    });
  }

  /**
   * Clear the interactive-PTY exit circuit breaker (COD-118).
   *
   * Called on an EXPLICIT, user-initiated (re)start so an intentional restart is
   * never blocked by a prior crash-loop trip. Automatic recovery/reconnect paths
   * must NOT call this — that's the whole point of the breaker.
   */
  resetRespawnBreaker(): void {
    this._ptyExitBreaker.reset();
    this._respawnBlocked = false;
  }

  /** Whether the interactive-PTY exit circuit breaker is currently tripped (COD-118). */
  get respawnBlocked(): boolean {
    return this._respawnBlocked;
  }

  /**
   * Answer Claude's workspace-trust dialog, which blocks a fresh case until
   * someone presses Enter. Codeman sessions run permission-skipping or
   * classifier-guarded modes, so the answer is always "yes, I trust this folder".
   *
   * Reads the RENDERED SCREEN rather than the chunk that just arrived. tmux
   * repaints a row with cursor-forward escapes in place of spaces, so the wire
   * carries `I\x1b[Ctrust\x1b[Cthis\x1b[Cfolder` and the old
   * `data.includes('trust this folder')` could never match: the auto-accept had
   * been dead for every session that hit the dialog. The screen is also what
   * makes a retry safe, since the terminal buffer is append-only and keeps the
   * dialog in its tail long after it has been answered.
   *
   * Three guards keep an Enter press off a live session: a startup-only window,
   * a two-marker match (isTrustDialogScreen), and an attempt cap.
   */
  private _maybeAcceptTrustDialog(): void {
    if (this._trustDialogAccepted) return;
    const now = Date.now();
    if (now - this._interactiveStartedAt > TRUST_DIALOG_WINDOW_MS) {
      this._trustDialogAccepted = true; // window closed; anything matching now is not the dialog
      return;
    }
    if (now - this._lastTrustDialogScanAt < TRUST_DIALOG_RETRY_MS) return;
    this._lastTrustDialogScanAt = now;

    // Prefer the pane; fall back to the buffer tail on a direct-PTY session,
    // where there is no screen to read.
    const screen =
      (this._mux && this._muxSession ? this._mux.capturePaneText?.(this._muxSession.muxName) : null) ??
      this._terminalBuffer.value.slice(-TRUST_DIALOG_SCAN_BYTES);
    if (!isTrustDialogScreen(screen)) return;

    this._trustDialogAttempts++;
    if (this._trustDialogAttempts > TRUST_DIALOG_MAX_ATTEMPTS) {
      this._trustDialogAccepted = true; // leave it to the user rather than keep typing
      console.warn(`[Session] Workspace trust dialog did not clear after retries: ${this.id}`);
      return;
    }
    console.log(
      `[Session] Auto-accepting workspace trust dialog for: ${this.id} (attempt ${this._trustDialogAttempts})`
    );
    // Enter confirms the highlighted default, "1. Yes, I trust this folder".
    this.writeViaMux('\r');
  }

  /**
   * Per-chunk working/idle detection for an interactive pane. Split out of the
   * PTY `onData` handler so it can be unit tested without spawning one.
   *
   * @param data raw PTY chunk, ANSI included
   */
  private _detectInteractiveActivity(data: string): void {
    this._noteDirectPtyCheckpointGeneration(data);
    // The prompt line contains "❯" when Claude is waiting for input. It only ARMS
    // the check and is NOT evidence the turn ended: Claude redraws the composer
    // about once a second all the way through a turn, which is exactly how a
    // working session used to flip to idle two seconds in. _confirmIdle() waits
    // for the pane to actually go quiet before believing it.
    if (data.includes('❯')) {
      // Only start a new timeout if we're not already awaiting idle confirmation.
      // This prevents status bar redraws (which include the prompt) from resetting it.
      if (!this._awaitingIdleConfirmation) {
        if (this.activityTimeout) clearTimeout(this.activityTimeout);
        this._awaitingIdleConfirmation = true;
        this.activityTimeout = setTimeout(() => this._confirmIdle(), IDLE_DETECTION_DELAY_MS);
      }
    }

    // Detect when Claude starts working (thinking, writing, etc).
    // Fast path: spinner characters on raw data (Unicode, never inside ANSI sequences).
    //
    // COD-181 (downstream): an external CLI renders its own TUI with no braille
    // spinner, so a positive working FRAME is its fast path. It also re-arms the
    // quiet-window timer, which is what ends the turn when frames stop — hence
    // the branch rather than two independent ifs.
    if (detectExternalCliWorkingFrame(data, this.mode)) this._noteExternalWorkingFrame();
    else if (SPINNER_PATTERN.test(data)) this._markWorking();

    // Activity fallback: current Claude Code animates `✻ Actualizing…` instead of a
    // braille spinner, so the fast path above misses entire turns, and matching the
    // new status line does not rescue it either (tmux repaints partially, so the
    // complete line reaches the PTY only every few tens of seconds). An unbroken run
    // of repaints is the signal that survives. See session-activity.ts for the
    // measurement. Claude only: an external CLI's TUI has no ❯, so nothing would
    // ever arm the idle confirmation and such a session would latch busy forever.
    if (!isExternalCliMode(this.mode)) {
      this._activityStreak = trackActivityStreak(this._activityStreak, Date.now());
      // A streak is the TRIGGER to look, not the verdict: typing into the composer
      // also produces a steady stream of repaints. The screen settles it, and only
      // an explicit "no working line" vetoes; a probe that cannot read the pane
      // (null) leaves the streak in charge.
      if (!this._isWorking && isSustainedActivity(this._activityStreak) && this._probePaneWorking() !== false) {
        this._markWorking();
      }
    }
  }

  /**
   * Ask the pane what it is rendering right now.
   *
   * The PTY stream cannot answer this on its own: measured on a live worker,
   * Claude repaints roughly once a second for most of a turn but can then sit
   * completely silent for tens of seconds inside a single tool call, while the
   * `✻ Elucidating… (39s · ↓ 2.0k tokens)` line stays on screen the whole time.
   * Silence therefore proves nothing, and the rendered frame is the only cheap
   * source that is right in both directions.
   *
   * Costs one `capture-pane`, floored at PANE_PROBE_MIN_INTERVAL_MS per session
   * and only ever called at a transition, never on the output hot path.
   *
   * @returns true/false when the screen could be read, null when it could not
   *   (no mux, capture failed, tests). Callers must treat null as "no evidence"
   *   and fall back to their stream heuristics.
   */
  private _probePaneWorking(): boolean | null {
    if (!this._mux || !this._muxSession) return null;
    const now = Date.now();
    if (now - this._lastPaneProbeAt < PANE_PROBE_MIN_INTERVAL_MS) return this._lastPaneProbeWorking;
    this._lastPaneProbeAt = now;
    const text = this._mux.capturePaneText?.(this._muxSession.muxName) ?? null;
    this._lastPaneProbeWorking = text === null ? null : CLAUDE_WORKING_LINE_PATTERN.test(text);
    return this._lastPaneProbeWorking;
  }

  /**
   * Mark the pane as working. Idempotent: `working` is emitted on the transition
   * only, so the per-chunk detectors can all call it freely.
   *
   * Deliberately does NOT cancel a pending idle confirmation. That confirmation
   * is what eventually notices the turn ended, and it already refuses to fire
   * while the pane is noisy, and cancelling it here would leave a session that
   * finished during a lull with nothing armed to ever call it idle.
   */
  private _markWorking(): void {
    if (this._isWorking) return;
    this._isWorking = true;
    this._status = 'busy';
    this.emit('working');
    this._autoOps.notifyWorking();
  }

  /**
   * Decide whether the armed idle confirmation is real.
   *
   * A ❯ sighting alone means nothing (Claude redraws the composer through the
   * whole turn), so the pane must ALSO have gone quiet. While output is still
   * flowing the check re-arms instead of concluding. That loop is a timestamp
   * compare every IDLE_RECHECK_MS and ends the moment the pane falls silent.
   */
  private _confirmIdle(): void {
    if (this._isStopped) {
      this._awaitingIdleConfirmation = false;
      return;
    }
    if (!isPaneQuiet(this._lastActivityAt, Date.now())) {
      this.activityTimeout = setTimeout(() => this._confirmIdle(), IDLE_RECHECK_MS);
      return; // stays _awaitingIdleConfirmation, so ❯ redraws do not pile up timers
    }
    // Quiet is necessary but NOT sufficient: a turn can go silent mid-tool-call.
    // Ask the screen before concluding, and keep asking on a slow cadence.
    if (this._probePaneWorking() === true) {
      this._markWorking();
      this.activityTimeout = setTimeout(() => this._confirmIdle(), PANE_PROBE_RECHECK_MS);
      return;
    }
    this._awaitingIdleConfirmation = false;
    this.activityTimeout = null;
    // Emit idle if either:
    // 1. Claude was working and is now at prompt (normal case)
    // 2. Session just started and is ready (status is 'busy' but _isWorking is false)
    const wasWorking = this._isWorking;
    const isInitialReady = this._status === 'busy' && !this._isWorking;
    if (wasWorking || isInitialReady) {
      this._isWorking = false;
      this._status = 'idle';
      this._lastPromptTime = Date.now();
      this.emit('idle');
    }
  }

  /**
   * Process expensive parsers (ANSI strip, Ralph, bash tool, token, CLI info, task descriptions).
   * Called on a throttled schedule (every EXPENSIVE_PROCESS_INTERVAL_MS) instead of on every
   * PTY data chunk. Receives accumulated raw data to process in one batch.
   */
  private _processExpensiveParsers(rawData: string): void {
    // Skip Claude-specific parsers for external CLI sessions — Ralph tracker,
    // BashToolParser, token parsing, and CLI info parsing all depend on Claude's output format.
    if (isExternalCliMode(this.mode)) return;

    // Lazy ANSI strip: only compute cleanData when a consumer actually needs it.
    let _cleanData: string | null = null;
    const getCleanData = (): string => {
      if (_cleanData === null) {
        _cleanData = rawData.replace(ANSI_ESCAPE_PATTERN_FULL, '');
      }
      return _cleanData;
    };

    // Forward to Ralph tracker to detect Ralph loops and todos
    // (opencode sessions already returned early at line 1209)
    if (this._ralphTracker.enabled || !this._ralphTracker.autoEnableDisabled) {
      this._ralphTracker.processCleanData(getCleanData());
    }

    // Forward to Bash tool parser to detect file-viewing commands
    if (this._bashToolParser.enabled) {
      this._bashToolParser.processCleanData(getCleanData());
    }

    // Usage-limit pause detection (auto-resume on usage limit)
    if (this._autoOps.autoResumeEnabled) {
      this._autoOps.processCleanData(getCleanData());
    }

    // Parse token count from status line (e.g., "123.4k tokens" or "5234 tokens")
    if (rawData.includes('token')) {
      this.parseTokensFromStatusLine(getCleanData());
    }

    // Parse Claude Code CLI info (version, model, account type) from startup
    if (!this._cliInfoParsed) {
      this.parseClaudeCodeInfo(getCleanData());
    }

    // Parse task descriptions from terminal output (e.g., "Explore(Check files)")
    if (rawData.includes('(') && rawData.includes(')')) {
      this.parseTaskDescriptionsFromTerminalData(getCleanData());
    }

    // Work detection (text-based, needs clean data: the status line is coloured,
    // so raw data has escape sequences between the `…` and the elapsed timer).
    // Only check if a faster path didn't already trigger working state.
    if (!this._isWorking) {
      const cleanData = getCleanData();
      if (
        CLAUDE_WORKING_LINE_PATTERN.test(cleanData) ||
        // Legacy gerunds. Current Claude randomizes the word ("Actualizing…",
        // "Finagling…"), so these catch only a fraction of turns; the pattern
        // above and the activity streak carry the rest.
        cleanData.includes('Thinking') ||
        cleanData.includes('Writing') ||
        cleanData.includes('Reading') ||
        cleanData.includes('Running')
      ) {
        this._markWorking();
      }
    }
  }

  /**
   * Starts a plain shell session (bash/zsh) without Claude CLI.
   *
   * Useful for debugging, testing, or when you just need a terminal.
   * Uses the user's default shell from $SHELL or falls back to /bin/bash.
   *
   * @throws {Error} If a process is already running in this session
   *
   * @example
   * ```typescript
   * const session = new Session({ workingDir: '/project', mode: 'shell' });
   * await session.startShell();
   * session.write('ls -la\r');
   * ```
   */
  async startShell(): Promise<void> {
    if (this.ptyProcess) {
      throw new Error('Session already has a running process');
    }

    this._resetBuffers();

    // Use user's default shell, falling back to a shell that actually exists.
    // Shared with the tmux pane command so both paths launch the same binary.
    const shell = resolveLocalShell();
    console.log(
      '[Session] Starting shell session with:',
      shell + (this._useMux ? ` (with ${this._mux!.backend})` : '')
    );

    // If mux wrapping is enabled, create or attach to a mux session
    if (this._useMux && this._mux) {
      try {
        const { isRestored } = await this._setupOrAttachMuxSession({
          respawnPaneOptions: {
            sessionId: this.id,
            workingDir: this.workingDir,
            mode: 'shell',
            niceConfig: this._niceConfig,
            envOverrides: this._envOverrides,
            truecolorEnabled: this._truecolorEnabled,
            historyLimit: this._tmuxHistoryLimit,
            remote: this._remote,
            docker: this._docker,
            owner: this._owner,
          },
          createSessionOptions: {
            sessionId: this.id,
            workingDir: this.workingDir,
            mode: 'shell',
            name: this._name,
            niceConfig: this._niceConfig,
            envOverrides: this._envOverrides,
            truecolorEnabled: this._truecolorEnabled,
            historyLimit: this._tmuxHistoryLimit,
            remote: this._remote,
            initialCols: this._initialDims?.cols,
            initialRows: this._initialDims?.rows,
            docker: this._docker,
            owner: this._owner,
          },
          spawnErrLabel: 'shell mux attachment',
        });

        // For NEW sessions: clear by sending 'clear' command to the shell
        // For RESTORED sessions: don't clear - we want to see the existing output
        if (!isRestored) {
          setTimeout(() => {
            if (this.ptyProcess) {
              this._terminalBuffer.clear();
              this.ptyProcess.write('clear\n');
            }
          }, 100);
        }
      } catch (err) {
        console.error('[Session] Failed to create mux session, falling back to direct PTY:', err);
        this._useMux = false;
        this._muxSession = null;
      }
    }

    // Fallback to direct PTY if mux is not used
    if (!this.ptyProcess) {
      try {
        this.ptyProcess = spawnPtyWithHelperRepair(() =>
          pty.spawn(shell, [], {
            name: 'xterm-256color',
            cols: 120,
            rows: 40,
            cwd: this.workingDir,
            env: buildShellEnv(this.id),
          })
        );
      } catch (spawnErr) {
        console.error('[Session] Failed to spawn shell PTY:', spawnErr);
        this._status = 'stopped';
        this.emit('error', `Failed to start shell: ${spawnErr}`);
        throw new Error(`Failed to spawn shell process: ${spawnErr}`);
      }
    }

    this._pid = this.ptyProcess.pid;
    console.log('[Session] Shell PTY spawned with PID:', this._pid);

    this.ptyProcess.onData((rawData: string) => {
      // Filter out focus escape sequences
      const data = rawData.replace(FOCUS_ESCAPE_FILTER, '');
      if (!data) return; // Skip if only focus sequences

      this._handleTerminalOutput(data);
    });

    this.ptyProcess.onExit(({ exitCode }) => {
      console.log('[Session] Shell PTY exited with code:', exitCode);
      this.ptyProcess = null;
      this._pid = null;
      this._status = 'idle';
      // Clear timers to prevent memory leaks
      if (this._shellIdleTimer) {
        clearTimeout(this._shellIdleTimer);
        this._shellIdleTimer = null;
      }
      if (this.activityTimeout) {
        clearTimeout(this.activityTimeout);
        this.activityTimeout = null;
      }
      // If using mux, mark the session as detached but don't kill it
      if (this._muxSession && this._mux) {
        this._mux.setAttached(this.id, false);
      }
      this.emit('exit', exitCode);
    });

    // Mark as idle after a short delay (shell is ready)
    this._shellIdleTimer = setTimeout(() => {
      this._shellIdleTimer = null;
      this._status = 'idle';
      this._isWorking = false;
      this.emit('idle');
    }, 500);
  }

  /**
   * Runs a one-shot prompt and returns the result.
   *
   * This spawns Claude CLI with `--output-format stream-json` to get
   * structured JSON output. The promise resolves when Claude completes
   * the response.
   *
   * @param prompt - The prompt text to send to Claude
   * @param options - Optional configuration
   * @param options.model - Model to use ('opus', 'sonnet', or full model name). Defaults to default model.
   * @param options.onProgress - Callback for progress updates (token count, status)
   * @returns Promise resolving to the result text and total cost in USD
   * @throws {Error} If a process is already running in this session
   *
   * @example
   * ```typescript
   * const session = new Session({ workingDir: '/project' });
   * const { result, cost } = await session.runPrompt('Explain this code', { model: 'opus' });
   * console.log(`Response: ${result}`);
   * console.log(`Cost: $${cost.toFixed(4)}`);
   * ```
   */
  async runPrompt(
    prompt: string,
    options?: { model?: string; onProgress?: (info: { tokens?: number; status?: string }) => void }
  ): Promise<{ result: string; cost: number }> {
    return new Promise((resolve, reject) => {
      if (this.ptyProcess) {
        reject(new Error('Session already has a running process'));
        return;
      }

      this._resetBuffers();
      this._promptResolved = false; // Reset race condition guard

      this.resolvePromise = resolve;
      this.rejectPromise = reject;

      try {
        // Spawn claude in a real PTY
        const model = options?.model;
        console.log(
          '[Session] Spawning PTY for claude with prompt:',
          prompt.substring(0, 50),
          model ? `(model: ${model})` : ''
        );

        const args = buildPromptArgs(prompt, model, this._claudeMode, this._allowedTools);

        try {
          this.ptyProcess = spawnPtyWithHelperRepair(() =>
            pty.spawn(getClaudeBinaryPath(), args, {
              name: 'xterm-256color',
              cols: 120,
              rows: 40,
              cwd: this.workingDir,
              // Merge envOverrides after buildClaudeEnv so user settings shadow defaults.
              env: { ...buildClaudeEnv(this.id, this._truecolorEnabled), ...(this._envOverrides ?? {}) },
            })
          );
        } catch (spawnErr) {
          console.error('[Session] Failed to spawn Claude PTY for runPrompt:', spawnErr);
          this.emit(
            'error',
            `Failed to spawn Claude: ${spawnErr instanceof Error ? spawnErr.message : String(spawnErr)}`
          );
          throw spawnErr;
        }

        this._pid = this.ptyProcess.pid;
        console.log('[Session] PTY spawned with PID:', this._pid);

        // Handle terminal data
        this.ptyProcess.onData((rawData: string) => {
          // Filter out focus escape sequences
          const data = rawData.replace(FOCUS_ESCAPE_FILTER, '');
          if (!data) return; // Skip if only focus sequences

          this._handleTerminalOutput(data);

          // Also try to parse JSON lines for structured data
          this.processOutput(data);
        });

        // Handle exit
        this.ptyProcess.onExit(({ exitCode }) => {
          console.log('[Session] PTY exited with code:', exitCode);
          this.ptyProcess = null;
          this._pid = null;

          // Guard against race conditions: only process once per runPrompt call
          if (this._promptResolved) {
            this.emit('exit', exitCode);
            return;
          }
          this._promptResolved = true;

          // Capture callbacks atomically before processing
          const resolve = this.resolvePromise;
          const reject = this.rejectPromise;
          this.resolvePromise = null;
          this.rejectPromise = null;

          // Find result from parsed messages or use text output
          const resultMsg = this._messages.find((m) => m.type === 'result');

          if (resultMsg && !resultMsg.is_error) {
            this._status = 'idle';
            const cost = resultMsg.total_cost_usd || 0;
            this._totalCost += cost;
            // Claude CLI stream-json may return empty result field — fall back to accumulated text output
            const result = resultMsg.result || this._textOutput.value || '';
            this.emit('completion', result, cost);
            if (resolve) {
              resolve({ result, cost });
            }
          } else if (exitCode !== 0 || (resultMsg && resultMsg.is_error)) {
            this._status = 'error';
            if (reject) {
              reject(new Error(this._errorBuffer || this._textOutput.value || 'Process exited with error'));
            }
          } else {
            this._status = 'idle';
            if (resolve) {
              resolve({
                result: this._textOutput.value || this._terminalBuffer.value,
                cost: this._totalCost,
              });
            }
          }

          this.emit('exit', exitCode);
        });
      } catch (err) {
        this._status = 'error';
        reject(err);
        // Null callbacks to prevent memory leak (onExit won't run if spawn failed)
        this.resolvePromise = null;
        this.rejectPromise = null;
      }
    });
  }

  private _resetBuffers(): void {
    this._status = 'busy';
    this._terminalBuffer.clear();
    this._textOutput.clear();
    this._errorBuffer = '';
    this._messages = [];
    this._lineBuffer = '';
    this._altScreenSeqCarry = '';
    this._lastActivityAt = Date.now();
  }

  /**
   * Positive external-CLI working signal — from a stream chunk match OR from
   * the COD-181 rendered-frame poller. Marks the session busy and re-arms the
   * quiet-window timer; idle comes from that timer expiring.
   */
  private _noteExternalWorkingFrame(): void {
    if (!this._isWorking) {
      this._isWorking = true;
      this._status = 'busy';
      this.emit('working');
      this._autoOps.notifyWorking();
    }
    this._awaitingIdleConfirmation = false;
    if (this.activityTimeout) clearTimeout(this.activityTimeout);
    this._armExternalCliIdleTimer();
  }

  /**
   * COD-181/182 — external-CLI sessions never reliably match the working
   * pattern on stream chunks: every Codeman session runs inside tmux, and the
   * attach client delivers the Working line as partial cell updates (doubly
   * so for remote nested-tmux sessions). Poll the local tmux window's
   * RENDERED visible frame instead — it always has the line fully assembled.
   * Local capture-pane only — no ssh, a few ms every 2s. Only positive
   * signals feed in; idle still comes from the existing quiet-window timer.
   */
  /**
   * COD-189 — detect a large shell output burst and, once it settles, tell
   * clients to reload from the canonical capture. During bursts tmux repaints
   * in place (jump-scroll), so live-streamed scrollback is sparse or absent;
   * only the pane history is contiguous.
   */
  private _trackShellBurst(data: string): void {
    const now = Date.now();
    if (now - this._shellBurstWindowStart > SHELL_BURST_WINDOW_MS) {
      this._shellBurstWindowStart = now;
      this._shellBurstBytes = 0;
      this._shellBurstRepaints = 0;
      if (!this._shellBurstSettleTimer) this._shellBurstActive = false;
    }
    this._shellBurstBytes += data.length;
    // Jump-scroll's fingerprint is repeated home/clear repaints, and tmux
    // compresses the byte volume hard (a 10k-line seq burst reached the
    // server as ~37KB) — so require BOTH a modest byte volume AND several
    // full-screen repaints before treating output as a burst.
    let idx = -1;
    while ((idx = data.indexOf('\x1b[H', idx + 1)) !== -1) this._shellBurstRepaints++;
    let jdx = -1;
    while ((jdx = data.indexOf('\x1b[2J', jdx + 1)) !== -1) this._shellBurstRepaints++;
    if (this._shellBurstBytes >= SHELL_BURST_BYTES && this._shellBurstRepaints >= SHELL_BURST_REPAINTS) {
      this._shellBurstActive = true;
    }
    if (this._shellBurstActive) {
      if (this._shellBurstSettleTimer) clearTimeout(this._shellBurstSettleTimer);
      this._shellBurstSettleTimer = setTimeout(() => {
        this._shellBurstSettleTimer = null;
        this._shellBurstActive = false;
        this._shellBurstBytes = 0;
        this._shellBurstRepaints = 0;
        if (!this._isStopped) this.emit('needsRefresh');
      }, SHELL_BURST_SETTLE_MS);
    }
  }

  private _startWorkingFramePoller(): void {
    if (this._workingFramePollTimer) clearInterval(this._workingFramePollTimer);
    this._workingFramePollTimer = setInterval(() => {
      if (this._isStopped) return;
      const muxName = this._muxSession?.muxName;
      if (!muxName || typeof this._mux?.captureActivePaneBuffer !== 'function') return;
      const frame = this._mux.captureActivePaneBuffer(muxName);
      if (!frame) return;
      // The -e capture carries SGR escapes that can sit inside the pattern
      // (e.g. bold around "Working") — strip before matching.
      const plain = frame.replace(ANSI_ESCAPE_PATTERN_FULL, '');
      if (detectExternalCliWorkingFrame(plain, this.mode)) {
        this._noteExternalWorkingFrame();
      }
    }, WORKING_FRAME_POLL_MS);
  }

  /**
   * (Re-)arm the external-CLI quiet-window timer. Fires idle when no working
   * frame has been seen for EXTERNAL_CLI_IDLE_DELAY_MS — covering both a turn
   * that just finished (wasWorking) and a freshly spawned/attached session
   * whose _resetBuffers() 'busy' status would otherwise never clear because
   * codex's '›' prompt can't match the Claude '❯' initial-ready path.
   */
  private _armExternalCliIdleTimer(): void {
    if (this._externalCliIdleTimer) clearTimeout(this._externalCliIdleTimer);
    this._externalCliIdleTimer = setTimeout(() => {
      this._externalCliIdleTimer = null;
      if (this._isStopped) return;
      const wasWorking = this._isWorking;
      const isInitialReady = this._status === 'busy' && !this._isWorking;
      if (wasWorking || isInitialReady) {
        this._isWorking = false;
        this._status = 'idle';
        this._lastPromptTime = Date.now();
        this.emit('idle');
      }
    }, EXTERNAL_CLI_IDLE_DELAY_MS);
  }

  private _clearAllTimers(): void {
    // Clear activity timeout to prevent memory leak
    if (this.activityTimeout) {
      clearTimeout(this.activityTimeout);
      this.activityTimeout = null;
    }

    // Clear external CLI idle quiet-window timer
    if (this._externalCliIdleTimer) {
      clearTimeout(this._externalCliIdleTimer);
      this._externalCliIdleTimer = null;
    }

    // Clear the COD-181 remote working-frame poller
    if (this._workingFramePollTimer) {
      clearInterval(this._workingFramePollTimer);
      this._workingFramePollTimer = null;
    }

    // Clear the COD-189 shell burst settle timer
    if (this._shellBurstSettleTimer) {
      clearTimeout(this._shellBurstSettleTimer);
      this._shellBurstSettleTimer = null;
    }

    // Clear line buffer flush timer
    if (this._lineBufferFlushTimer) {
      clearTimeout(this._lineBufferFlushTimer);
      this._lineBufferFlushTimer = null;
    }

    // Destroy auto-compact/auto-clear automation (clears its timers)
    this._autoOps.destroy();

    // Clear prompt check timers
    if (this._promptCheckInterval) {
      clearInterval(this._promptCheckInterval);
      this._promptCheckInterval = null;
    }
    if (this._promptCheckTimeout) {
      clearTimeout(this._promptCheckTimeout);
      this._promptCheckTimeout = null;
    }

    // Clear shell idle timer
    if (this._shellIdleTimer) {
      clearTimeout(this._shellIdleTimer);
      this._shellIdleTimer = null;
    }

    // Clear expensive processing timer
    if (this._expensiveProcessTimer) {
      clearTimeout(this._expensiveProcessTimer);
      this._expensiveProcessTimer = null;
    }
    this._pendingCleanData = '';
  }

  private _handleJsonMessage(cleanLine: string, rawLine: string): void {
    try {
      const msg = JSON.parse(cleanLine) as ClaudeMessage;
      this._messages.push(msg);
      this.emit('message', msg);

      // Trim messages array for long-running sessions
      if (this._messages.length > MAX_MESSAGES) {
        this._messages = this._messages.slice(-Math.floor(MAX_MESSAGES * 0.8));
      }

      // Extract Claude session ID from messages (can be in any message type).
      // Support both sessionId (camelCase) and session_id (snake_case).
      // The constructor seeds _claudeSessionId with this.id as a placeholder;
      // once Claude CLI emits its real session ID, adopt it so JSONL lookups
      // (e.g. /api/sessions/:id/last-response) can find the transcript file.
      const msgSessionId =
        ((msg as unknown as Record<string, unknown>).sessionId as string | undefined) ?? msg.session_id;
      if (msgSessionId && msgSessionId !== this._claudeSessionId) {
        this._claudeSessionId = msgSessionId;
      }

      // Process message for task tracking
      this._taskTracker.processMessage(msg);

      if (msg.type === 'assistant' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text) {
            this._textOutput.append(block.text);
          }
        }
        // Track tokens from usage (with validation)
        if (msg.message.usage) {
          const inputDelta = msg.message.usage.input_tokens || 0;
          const outputDelta = msg.message.usage.output_tokens || 0;

          // Sanity check: max 100k tokens per message (generous limit)
          const MAX_TOKENS_PER_MESSAGE = 100_000;
          if (inputDelta > 0 && inputDelta <= MAX_TOKENS_PER_MESSAGE) {
            this._totalInputTokens += inputDelta;
          }
          if (outputDelta > 0 && outputDelta <= MAX_TOKENS_PER_MESSAGE) {
            this._totalOutputTokens += outputDelta;
          }

          // Check if we should auto-compact or auto-clear
          this._autoOps.checkAutoCompact();
          this._autoOps.checkAutoClear();
        }
      }

      if (msg.type === 'result' && msg.total_cost_usd) {
        this._totalCost = msg.total_cost_usd;
      }
    } catch (parseErr) {
      // Not JSON, just regular output - this is expected for non-JSON lines
      console.debug(
        '[Session] Line not JSON (expected for text output):',
        parseErr instanceof Error ? parseErr.message : parseErr
      );
      this._textOutput.append(rawLine + '\n');
    }
  }

  private processOutput(data: string): void {
    // Early return if session is stopped to prevent any processing or timer creation
    if (this._isStopped) return;

    // Try to extract JSON from output (Claude may output JSON in stream mode)
    this._lineBuffer += data;

    // Prevent unbounded line buffer growth for very long lines
    if (this._lineBuffer.length > MAX_LINE_BUFFER_SIZE) {
      // Force flush the oversized buffer as text output
      this._textOutput.append(this._lineBuffer + '\n');
      this._lineBuffer = '';
    }

    // Start flush timer if not running (handles partial lines after 100ms)
    if (!this._lineBufferFlushTimer && this._lineBuffer.length > 0 && !this._isStopped) {
      this._lineBufferFlushTimer = setTimeout(() => {
        this._lineBufferFlushTimer = null;
        if (this._lineBuffer.length > 0 && !this._isStopped) {
          // Flush partial line as text output
          this._textOutput.append(this._lineBuffer);
          this._lineBuffer = '';
        }
      }, LINE_BUFFER_FLUSH_INTERVAL);
    }

    const lines = this._lineBuffer.split('\n');
    this._lineBuffer = lines.pop() || '';

    // Clear flush timer if buffer is now empty
    if (this._lineBuffer.length === 0 && this._lineBufferFlushTimer) {
      clearTimeout(this._lineBufferFlushTimer);
      this._lineBufferFlushTimer = null;
    }

    for (const line of lines) {
      const trimmed = line.trim();
      // Remove ANSI escape codes for JSON parsing (use pre-compiled pattern)
      const cleanLine = trimmed.replace(ANSI_ESCAPE_PATTERN_FULL, '');

      if (cleanLine.startsWith('{') && cleanLine.endsWith('}')) {
        this._handleJsonMessage(cleanLine, line);
      } else if (trimmed) {
        this._textOutput.append(line + '\n');
      }

      // Parse task descriptions from terminal output (e.g., "Explore(Description)")
      // This captures the short description from Claude Code's Task tool output
      // Use direct method since cleanLine is already ANSI-stripped (line 1460)
      this.parseTaskDescriptionsDirect(cleanLine);
    }
    // Note: BufferAccumulator auto-trims when max size exceeded
  }

  /**
   * Parse task descriptions from terminal data (may contain multiple lines).
   * Called from interactive mode's onData handler with ANSI-stripped data.
   * @param cleanData - Terminal data with ANSI codes already stripped
   */
  private parseTaskDescriptionsFromTerminalData(cleanData: string): void {
    // Quick pre-check: skip if no parentheses present
    if (!cleanData.includes('(') || !cleanData.includes(')')) return;

    // Split by newlines and process each line (data already ANSI-stripped)
    const lines = cleanData.split(NEWLINE_SPLIT_PATTERN);
    for (const line of lines) {
      this.parseTaskDescriptionsDirect(line);
    }
  }

  /**
   * Parse task descriptions from a pre-cleaned line (no ANSI codes).
   * Used by both processOutput() and parseTaskDescriptionsFromTerminalData().
   */
  private parseTaskDescriptionsDirect(cleanLine: string): void {
    // Quick pre-check: skip expensive regex if no common tool patterns present
    if (!cleanLine.includes('(') || !cleanLine.includes(')')) return;

    execPattern(TASK_TOOL_PATTERN, cleanLine, (match) => {
      const description = match[2].trim();
      if (description && description.length > 0) {
        this._taskCache.add(Date.now(), description);
      }
    });
  }

  /**
   * Get recent task descriptions parsed from terminal output.
   * Returns descriptions sorted by timestamp (most recent first).
   */
  getRecentTaskDescriptions(): Array<{ timestamp: number; description: string }> {
    return this._taskCache.getAll();
  }

  /**
   * Find a task description that was parsed close to a given timestamp.
   * Used to correlate with SubagentWatcher discoveries.
   *
   * @param subagentStartTime - The timestamp when the subagent was discovered
   * @param maxAgeMs - Maximum age difference to consider (default 10 seconds)
   * @returns The matching description or undefined
   */
  findTaskDescriptionNear(subagentStartTime: number, maxAgeMs: number = 10000): string | undefined {
    return this._taskCache.findNear(subagentStartTime, maxAgeMs);
  }

  // Parse token count from Claude's status line in interactive mode
  // Matches patterns like "123.4k tokens", "5234 tokens", "1.2M tokens"
  //
  // SAFETY LIMITS:
  // - Max tokens per session: 500k (Claude's context is ~200k)
  // - Max delta per update: 100k (prevents sudden jumps from parsing errors)
  // - Rejects "M" suffix values > 0.5 (500k) to prevent false matches
  private parseTokensFromStatusLine(cleanData: string): void {
    // Quick pre-check: skip expensive regex if "token" not present (performance optimization)
    if (!cleanData.includes('token')) return;

    // Match patterns: "123.4k tokens", "5234 tokens", "1.2M tokens"
    // The status line typically shows total tokens like "1.2k tokens" near the prompt
    // Note: ANSI codes are already stripped by caller for performance
    const tokenMatch = cleanData.match(TOKEN_PATTERN);

    if (tokenMatch) {
      let tokenCount = parseFloat(tokenMatch[1]);
      const suffix = tokenMatch[2]?.toLowerCase();

      // Convert k/M suffix to actual number
      if (suffix === 'k') {
        tokenCount *= 1000;
      } else if (suffix === 'm') {
        // Safety: Reject M values that would result in > 500k tokens
        // Claude's context window is ~200k, so anything claiming millions is likely a false match
        if (tokenCount > 0.5) {
          console.warn(
            `[Session ${this.id}] Rejected suspicious M token value: ${tokenMatch[0]} (would be ${tokenCount * 1000000} tokens)`
          );
          return;
        }
        tokenCount *= 1000000;
      }

      // Safety: Absolute maximum tokens per session
      if (tokenCount > MAX_SESSION_TOKENS) {
        console.warn(`[Session ${this.id}] Rejected token count exceeding max: ${tokenCount} > ${MAX_SESSION_TOKENS}`);
        return;
      }

      // Only update if the new count is higher (tokens only increase within a session)
      // We use total tokens as an estimate - Claude shows combined input+output
      const currentTotal = this._totalInputTokens + this._totalOutputTokens;
      if (tokenCount > currentTotal) {
        const delta = tokenCount - currentTotal;

        // Safety: Reject suspiciously large jumps (max 100k per update)
        const MAX_DELTA_PER_UPDATE = 100_000;
        if (delta > MAX_DELTA_PER_UPDATE) {
          console.warn(
            `[Session ${this.id}] Rejected suspicious token jump: ${currentTotal} -> ${tokenCount} (delta: ${delta})`
          );
          return;
        }

        // Estimate: split roughly 60% input, 40% output (common ratio)
        // This is an approximation since interactive mode doesn't give us the breakdown
        this._totalInputTokens += Math.round(delta * 0.6);
        this._totalOutputTokens += Math.round(delta * 0.4);

        // Check if we should auto-compact or auto-clear
        this._autoOps.checkAutoCompact();
        this._autoOps.checkAutoClear();
      }
    }
  }

  // Parse Claude Code CLI info from terminal startup output
  // Extracts version, model, and account type for display in Codeman UI
  // Note: Expects cleanData with ANSI codes already stripped by caller
  private parseClaudeCodeInfo(cleanData: string): void {
    // Only parse once per session (during startup)
    if (this._cliInfoParsed) return;

    // Quick pre-checks
    if (
      !cleanData.includes('Claude') &&
      !cleanData.includes('current:') &&
      !cleanData.includes('Opus') &&
      !cleanData.includes('Sonnet')
    ) {
      return;
    }
    let changed = false;

    // Match "Claude Code v2.1.27" or "Claude Code vX.Y.Z"
    if (!this._cliVersion) {
      const versionMatch = cleanData.match(/Claude Code v(\d+\.\d+\.\d+)/);
      if (versionMatch) {
        this._cliVersion = versionMatch[1];
        changed = true;
      }
    }

    // Match model and account: "Opus 4.5 · Claude Max" or "Sonnet 4 · API"
    // The · character separates model from account type
    if (!this._cliModel || !this._cliAccountType) {
      // Try various model patterns
      const modelPatterns = [
        /(Opus \d+(?:\.\d+)?)\s*[·•]\s*(.+?)(?:\s*$|\s+[~/])/,
        /(Sonnet \d+(?:\.\d+)?)\s*[·•]\s*(.+?)(?:\s*$|\s+[~/])/,
        /(Haiku \d+(?:\.\d+)?)\s*[·•]\s*(.+?)(?:\s*$|\s+[~/])/,
      ];

      for (const pattern of modelPatterns) {
        const match = cleanData.match(pattern);
        if (match) {
          if (!this._cliModel) {
            this._cliModel = match[1].trim();
            changed = true;
          }
          if (!this._cliAccountType) {
            this._cliAccountType = match[2].trim();
            changed = true;
          }
          break;
        }
      }
    }

    // Match version check: "current: 2.1.27" and "latest: 2.1.27"
    if (!this._cliLatestVersion) {
      const latestMatch = cleanData.match(/latest:\s*(\d+\.\d+\.\d+)/);
      if (latestMatch) {
        this._cliLatestVersion = latestMatch[1];
        changed = true;
      }
    }

    // Mark as parsed once we have the essential info
    if (this._cliVersion && this._cliModel) {
      this._cliInfoParsed = true;
    }

    // Emit update if anything changed
    if (changed) {
      this.emit('cliInfoUpdated', {
        version: this._cliVersion,
        model: this._cliModel,
        accountType: this._cliAccountType,
        latestVersion: this._cliLatestVersion,
      });
    }
  }

  // Note: checkAutoCompact/checkAutoClear moved to SessionAutoOps (this._autoOps)

  /**
   * Sends input directly to the PTY process.
   *
   * For interactive sessions, this is how you send user input to Claude.
   * Remember to include `\r` (carriage return) to simulate pressing Enter.
   *
   * @example
   * ```typescript
   * session.write('hello world');  // Text only, no Enter
   * session.write('\r');           // Enter key
   * session.write('ls -la\r');     // Command with Enter
   * ```
   *
   * @param data - The input data to send (text, escape sequences, etc.)
   * @returns true if the data reached a PTY. A session whose PTY is gone still
   * discards the data, but it used to do so with no signal at all — which is how
   * input could disappear while the caller believed it had been delivered.
   */
  write(data: string): boolean {
    this._trackSubmit(data);
    if (!this.ptyProcess) return false;
    this.ptyProcess.write(data);
    return true;
  }

  // ── Conversation tracking ─────────────────────────────────────────────
  // When this pane last submitted a message (Enter). The response-viewer
  // correlates this against the CLI's own history.jsonl entry timestamps to
  // find the conversation the pane is ACTUALLY on — the only signal that
  // survives /clear, /resume, /new and /fork typed inside the TUI itself,
  // none of which announce themselves on the PTY's stdout.
  private _lastSubmitAt = 0;

  /** Wall-clock ms of this pane's last Enter; 0 if it has never submitted. */
  get lastSubmitAt(): number {
    return this._lastSubmitAt;
  }

  private _trackSubmit(data: string): void {
    if (data.includes('\r') || data.includes('\n')) {
      this._lastSubmitAt = Date.now();
      // Codex last-response resolution compares submit times ACROSS sessions (a
      // sibling codex pane's submit would otherwise be mistaken for this one's),
      // so codex panes additionally publish theirs to the shared map.
      if (this.mode === 'codex') Session.codexSubmitTimes.set(this.id, this._lastSubmitAt);
    }
  }

  /**
   * Per-client highest-applied input sequence, for exactly-once input delivery.
   * Keyed by the web client's stable `clientId`. Bounded so many devices over a
   * long-lived session can't grow it without limit (insertion order = MRU, so
   * eviction drops the least-recently-active client).
   */
  private _appliedInputSeq = new Map<string, number>();
  private static readonly MAX_INPUT_DEDUP_CLIENTS = 256;

  /**
   * Decide whether an input frame should be applied to the PTY or skipped as a
   * duplicate redelivery. Returns true exactly once per (clientId, seq): the
   * first time a seq strictly greater than the client's last-applied is seen.
   * A redelivery of an already-applied seq (the client never got our ACK and
   * resent) returns false. Callers should ACK regardless — a duplicate is, from
   * the client's view, "delivered" — and only `write()` the PTY when this is
   * true. Relies on the client delivering one client's frames in seq order over
   * a single ordered stream, so `seq <= last` ⇒ already applied.
   *
   * Without this, the client's at-least-once redelivery (needed because a
   * half-open socket silently drops frames with no error) would type a prompt
   * twice whenever an ACK is lost after the write landed.
   */
  shouldApplyInput(clientId: string, seq: number): boolean {
    const last = this._appliedInputSeq.get(clientId);
    if (last !== undefined && seq <= last) return false;
    // Re-insert to move this client to the MRU end for fair eviction.
    if (last !== undefined) this._appliedInputSeq.delete(clientId);
    this._appliedInputSeq.set(clientId, seq);
    if (this._appliedInputSeq.size > Session.MAX_INPUT_DEDUP_CLIENTS) {
      const oldest = this._appliedInputSeq.keys().next().value;
      if (oldest !== undefined) this._appliedInputSeq.delete(oldest);
    }
    return true;
  }

  /**
   * Undo the bookkeeping of {@link shouldApplyInput} for a delivery that failed.
   *
   * Without this, the reliable-delivery layer guarantees exactly-once delivery of
   * something that may never have been delivered: the seq is recorded as applied
   * BEFORE the write is attempted, so a client retry — the very mechanism the seq
   * exists for — is rejected as a duplicate and the input is lost for good.
   *
   * Only rolls back if `seq` is still the newest recorded one; a later input has
   * already superseded it and must not be re-opened.
   */
  forgetInputSeq(clientId: string, seq: number): void {
    if (this._appliedInputSeq.get(clientId) === seq) {
      this._appliedInputSeq.set(clientId, seq - 1);
    }
  }

  /**
   * Sends input via the terminal multiplexer's direct input mechanism.
   *
   * More reliable than direct PTY write for programmatic input, especially
   * with Claude CLI which uses Ink (React for terminals).
   * Uses tmux `send-keys -l` to inject text + Enter.
   *
   * @param data - Input data with optional `\r` for Enter
   * @returns true if input was sent, false if no mux session or PTY
   *
   * @example
   * ```typescript
   * session.writeViaMux('/clear\r');  // Send /clear command
   * session.writeViaMux('/new\r');    // Send /new command
   * ```
   */
  async writeViaMux(data: string): Promise<boolean> {
    this._trackSubmit(data);
    if (this._mux && this._muxSession) {
      return this._mux.sendInput(this.id, data);
    }
    // Fallback to PTY write
    if (this.ptyProcess) {
      this.ptyProcess.write(data);
      return true;
    }
    return false;
  }

  /**
   * Checkpoint-only delivery path. The generic boolean input contract remains
   * unchanged; checkpoint orchestration receives the exact failed stage.
   */
  async writeCheckpointViaMux(data: string): Promise<CommandDeliveryResult> {
    const checkpointRunId = this._autoOps.activeCheckpointRunId;
    const checkpointCommand = data.replace(/[\r\n]/g, '').trim();
    const isClear = checkpointCommand === '/clear';
    const isCodexFreshThread = this.mode === 'codex' && (isClear || checkpointCommand === '/new');
    if (isClear) {
      this._checkpointAwaitingInstantClear = true;
      this._checkpointInstantClearBaseline = this._checkpointReadyFingerprint;
      this._checkpointDirectPtySawClear = false;
    }
    if (isCodexFreshThread) {
      const baselineId = this._checkpointCodexConversationId;
      const codexHome = process.env.CODEX_HOME || path.join(process.env.HOME || '/tmp', '.codex');
      const baselineIds = await this._findRecentOwnedCodexConversationIds({
        codexHome,
        sessionId: this.id,
      });
      if (
        this._isStopped ||
        (checkpointRunId !== undefined && checkpointRunId !== this._autoOps.activeCheckpointRunId)
      ) {
        return { ok: false, stage: 'text', error: 'checkpoint run cancelled before delivery', attempt: 1 };
      }
      this._checkpointCodexFreshBaselineId = baselineId;
      this._checkpointCodexFreshBaselineIds =
        baselineId && !baselineIds.includes(baselineId) ? [...baselineIds, baselineId] : baselineIds;
      this._checkpointCodexFreshTransitionArmed = true;
    } else {
      this._trackSubmit(data);
    }
    if (this._isStopped || (checkpointRunId !== undefined && checkpointRunId !== this._autoOps.activeCheckpointRunId)) {
      return { ok: false, stage: 'text', error: 'checkpoint run cancelled before delivery', attempt: 1 };
    }
    if (this._mux && this._muxSession) {
      const result = await this._mux.sendCheckpointCommand(this.id, data);
      if (isClear && !result.ok) {
        this._checkpointAwaitingInstantClear = false;
        this._checkpointInstantClearBaseline = null;
      }
      return result;
    }
    // Claude retains its direct-PTY fallback. Codex and the other external
    // CLIs require tmux and cannot claim delivery without it.
    if (this.mode === 'claude' && this.ptyProcess) {
      try {
        this.ptyProcess.write(data);
        return { ok: true, attempt: 1 };
      } catch (err) {
        if (isClear) {
          this._checkpointAwaitingInstantClear = false;
          this._checkpointInstantClearBaseline = null;
        }
        return { ok: false, stage: 'text', error: getErrorMessage(err), attempt: 1 };
      }
    }
    if (isClear) {
      this._checkpointAwaitingInstantClear = false;
      this._checkpointInstantClearBaseline = null;
    }
    return { ok: false, stage: 'text', error: 'no terminal transport', attempt: 1 };
  }

  /** Current PTY dimensions — used to skip no-op resizes that trigger Ink redraws */
  private _ptyCols = 120;
  private _ptyRows = 40;

  /**
   * Live WebSocket connections that have announced a desktop viewport for this
   * session. While at least one is registered, small-viewport (mobile/tablet)
   * resizes are ignored so a phone glancing at the session can't reflow the
   * PTY under an active desktop view. Claims are connection-scoped: ws-routes
   * registers them on a desktop-typed resize and releases them on socket
   * close, so a mobile-only session (no desktop connected) keeps full control
   * of its own size — including narrowing below the spawn default.
   *
   * Deliberate tradeoff: claims are WS-only because only a socket has a
   * liveness signal. A desktop degraded to the stateless HTTP resize fallback
   * still applies its typed resizes but holds no claim, so a concurrent phone
   * can reflow it. This is cooperative UX arbitration, not a security
   * boundary — untyped (legacy/API) resizes bypass claims by design.
   */
  private _desktopSizeClaims = new Set<symbol>();

  /**
   * A desktop sizing claim only blocks small-viewport resizes while the
   * desktop is RECENTLY ACTIVE (claim registration or typed input within this
   * window). An abandoned-but-connected desktop tab (left open at home, screen
   * locked) must not hold a phone's view hostage: without this, the phone
   * renders a desktop-width stream in a narrow xterm — mid-word wraps, tmux
   * dot-fill, and Ink overdraw soup (the 0.9.8–0.9.12 mobile regression).
   */
  private static readonly DESKTOP_CLAIM_IDLE_MS = 90_000;

  /** Last evidence of a live desktop user (claim registered / typed input). */
  private _lastDesktopActivityAt = 0;

  /** Last desktop-typed dimensions, for re-asserting after a mobile override. */
  private _lastDesktopDims: { cols: number; rows: number } | null = null;

  /** True while a small viewport reflowed the pane past an idle desktop claim. */
  private _mobileSizeOverride = false;

  /** Register a live desktop sizing claim (see _desktopSizeClaims). */
  claimDesktopSizing(token: symbol): void {
    this._desktopSizeClaims.add(token);
    this._lastDesktopActivityAt = Date.now();
  }

  /** Release a desktop sizing claim when its connection goes away. */
  releaseDesktopSizing(token: symbol): void {
    this._desktopSizeClaims.delete(token);
  }

  /**
   * Record desktop user activity (typed input over a claim-holding socket).
   * If a phone reflowed the pane while the desktop was idle, the desktop
   * layout is restored — "whoever is actively using the session wins".
   */
  noteDesktopActivity(): void {
    this._lastDesktopActivityAt = Date.now();
    if (this._mobileSizeOverride && this._lastDesktopDims) {
      this._mobileSizeOverride = false;
      this.resize(this._lastDesktopDims.cols, this._lastDesktopDims.rows, { viewportType: 'desktop' });
    }
  }

  /**
   * Resizes the PTY terminal dimensions.
   * Skips the resize if dimensions haven't changed to avoid triggering
   * unnecessary Ink full-screen redraws (visible flicker on tab switch).
   *
   * Arbitration: while a desktop connection holds a sizing claim AND has been
   * active within DESKTOP_CLAIM_IDLE_MS, resizes from small viewports
   * (mobile/tablet) are ignored — shrink AND grow would both reflow the
   * desktop view. Once the desktop goes idle, a phone may take the pane (the
   * desktop re-asserts its size on its next typed input via
   * noteDesktopActivity). Without a desktop connected, small viewports
   * control the PTY size freely.
   *
   * @param cols - Number of columns (width in characters)
   * @param rows - Number of rows (height in lines)
   */
  resize(cols: number, rows: number, options: { viewportType?: ResizeViewportType; force?: boolean } = {}): void {
    const isSmallViewport = options.viewportType === 'mobile' || options.viewportType === 'tablet';
    if (options.viewportType === 'desktop') {
      this._lastDesktopDims = { cols, rows };
      this._lastDesktopActivityAt = Date.now();
      this._mobileSizeOverride = false;
    }
    if (isSmallViewport && this._desktopSizeClaims.size > 0) {
      if (Date.now() - this._lastDesktopActivityAt < Session.DESKTOP_CLAIM_IDLE_MS) {
        return;
      }
      this._mobileSizeOverride = true;
    }
    const dimsChanged = cols !== this._ptyCols || rows !== this._ptyRows;
    if (this.ptyProcess && (dimsChanged || options.force)) {
      this._ptyCols = cols;
      this._ptyRows = rows;
      if (!IS_TEST_MODE && this._mux && this._muxSession) {
        this._mux.resizeWindow?.(this._muxSession.muxName, cols, rows);
      }
      try {
        this.ptyProcess.resize(cols, rows);
      } catch {
        this.ptyProcess = null;
      }
      // COD-179: tell every connected client the shared geometry changed. A
      // viewer whose xterm has different dims renders the subsequent TUI
      // repaint frames misaligned (orphan "Working" rows in scrollback) and
      // needs to reconcile by rewriting from the tmux capture. Only a real
      // geometry change matters — a forced same-size SIGWINCH can't misalign.
      if (dimsChanged) {
        this.emit('resized', { cols, rows });
      }
    }
  }

  // Legacy method for compatibility with session-manager
  async start(): Promise<void> {
    this._status = 'idle';
  }

  // Legacy method for sending input - wraps runPrompt
  async sendInput(input: string): Promise<void> {
    this._status = 'busy';
    this._lastActivityAt = Date.now();
    this.runPrompt(input).catch((err) => {
      const errorMsg = getErrorMessage(err);
      // Clean up task state so the task queue doesn't get stuck
      if (this._currentTaskId) {
        const taskId = this._currentTaskId;
        this._currentTaskId = null;
        this._status = 'idle';
        this._lastActivityAt = Date.now();
        this.emit('taskError', taskId, errorMsg);
      } else {
        this._status = 'idle';
      }
      this.emit('error', errorMsg);
    });
  }

  /**
   * Remove event listeners from TaskTracker and RalphTracker.
   * Prevents memory leaks by ensuring handlers don't persist after session stop.
   */
  private cleanupTrackerListeners(): void {
    // Remove TaskTracker handlers
    if (this._taskTrackerHandlers) {
      this._taskTracker.off('taskCreated', this._taskTrackerHandlers.taskCreated);
      this._taskTracker.off('taskUpdated', this._taskTrackerHandlers.taskUpdated);
      this._taskTracker.off('taskCompleted', this._taskTrackerHandlers.taskCompleted);
      this._taskTracker.off('taskFailed', this._taskTrackerHandlers.taskFailed);
      this._taskTrackerHandlers = null;
    }

    // Remove RalphTracker handlers
    if (this._ralphHandlers) {
      this._ralphTracker.off('loopUpdate', this._ralphHandlers.loopUpdate);
      this._ralphTracker.off('todoUpdate', this._ralphHandlers.todoUpdate);
      this._ralphTracker.off('completionDetected', this._ralphHandlers.completionDetected);
      this._ralphTracker.off('statusBlockDetected', this._ralphHandlers.statusBlockDetected);
      this._ralphTracker.off('circuitBreakerUpdate', this._ralphHandlers.circuitBreakerUpdate);
      this._ralphTracker.off('exitGateMet', this._ralphHandlers.exitGateMet);
      this._ralphHandlers = null;
    }

    // Remove BashToolParser handlers
    if (this._bashToolHandlers) {
      this._bashToolParser.off('toolStart', this._bashToolHandlers.toolStart);
      this._bashToolParser.off('toolEnd', this._bashToolHandlers.toolEnd);
      this._bashToolParser.off('toolsUpdate', this._bashToolHandlers.toolsUpdate);
      this._bashToolHandlers = null;
    }

    // Destroy all trackers to release memory and stop timers
    this._bashToolParser.destroy();
    this._taskTracker.destroy();
    this._ralphTracker.destroy();
  }

  /**
   * Stops the session and cleans up resources.
   *
   * This kills the PTY process and optionally the associated tmux session.
   * All buffers are cleared and the session is marked as stopped.
   *
   * @param killMux - Whether to also kill the mux session (default: true)
   *
   * @example
   * ```typescript
   * // Stop and kill everything
   * await session.stop();
   *
   * // Stop but keep mux session running for later reattachment
   * await session.stop(false);
   * ```
   */
  async stop(killMux: boolean = true): Promise<void> {
    // Set stopped flag first to prevent new timers from being created
    this._isStopped = true;
    Session.codexSubmitTimes.delete(this.id);

    this._clearAllTimers();

    // Drop desktop sizing claims defensively. Sockets normally release their
    // own claim on close, but a hung client's close event can lag the session
    // teardown by up to a ping cycle — don't let a stale claim suppress
    // mobile resizes if this Session object sees any further use.
    this._desktopSizeClaims.clear();

    // Immediately cleanup Promise callbacks to prevent orphaned references
    // during the rest of stop() processing (e.g., if mux kill times out)
    if (this.rejectPromise && !this._promptResolved) {
      this._promptResolved = true;
      this.rejectPromise(new Error('Session stopped'));
    }
    this.resolvePromise = null;
    this.rejectPromise = null;

    // Remove event listeners from trackers to prevent memory leaks
    this.cleanupTrackerListeners();

    if (this.ptyProcess) {
      if (killMux) {
        // Full kill: SIGTERM → wait → SIGKILL the PTY and its children
        const pid = this.ptyProcess.pid;

        // First try graceful SIGTERM
        try {
          this.ptyProcess.kill();
        } catch (err) {
          console.warn('[Session] Failed to send SIGTERM to PTY process (may already be dead):', err);
        }

        // Give it a moment to terminate gracefully
        await new Promise((resolve) => setTimeout(resolve, GRACEFUL_SHUTDOWN_DELAY_MS));

        // Force kill with SIGKILL if still alive
        try {
          if (pid) {
            process.kill(pid, 'SIGKILL');
          }
        } catch (err) {
          console.warn('[Session] Failed to send SIGKILL to process (already terminated):', err);
        }

        // Also try to kill any child processes in the process group
        try {
          if (pid) {
            process.kill(-pid, 'SIGKILL');
          }
        } catch (err) {
          console.warn('[Session] Failed to send SIGKILL to process group (may not exist):', err);
        }
      } else {
        // Server shutdown: just detach — the process lives on inside tmux
        console.log('[Session] Detaching from PTY (server shutdown) — mux session preserved');
      }

      this.ptyProcess = null;
    }
    this._pid = null;
    this._status = killMux ? 'stopped' : 'idle';
    this._currentTaskId = null;

    // Clear task description cache and agent tree to prevent memory leak
    this._taskCache.clear();
    this._childAgentIds = [];

    // Kill the associated mux session if requested
    if (killMux && this._mux) {
      // Try to kill mux session even if _muxSession is not set (e.g., restored sessions)
      try {
        const killed = await this._mux.killSession(this.id);
        if (killed) {
          console.log('[Session] Killed mux session for:', this.id);
        }
      } catch (err) {
        console.error('[Session] Failed to kill mux session:', err);
      }
      this._muxSession = null;
    } else if (this._muxSession && !killMux) {
      console.log('[Session] Keeping mux session alive:', this._muxSession.muxName);
      this._muxSession = null; // Detach but don't kill
    }
  }

  /**
   * COD-124 — park an idle session: detach the tmux session and gracefully
   * stop the CLI (SIGTERM only, no forced SIGKILL escalation), while
   * PRESERVING the state.json record, workingDir, and — for claude-mode
   * sessions — the resumeSessionId needed to restore the conversation later
   * via `--resume`. The session stays in `SessionManager.sessions` (unlike
   * `stop()`, which is followed by deletion in every existing caller); it
   * just shows up in the UI as `status: 'parked'`.
   *
   * Deliberately, unlike `stop()`, this does NOT set `_isStopped` and does
   * NOT call `removeAllListeners()`: park/resume is designed for reusing
   * this SAME `Session` object later via `startInteractive()` (a flow
   * `stop()` never had to support — every existing `stop()` caller discards
   * the object), and `_isStopped` is checked by several async CLI-version
   * probes / buffer-flush guards that must still function after resume.
   *
   * Non-claude modes (codex/opencode/gemini/shell): resume-after-park is a
   * best-effort relaunch in the same workingDir with NO conversation
   * restore. `_resumeSessionId` is deliberately left untouched for these
   * modes here, even though `appendResumeFlag()` in tmux-manager.ts can in
   * principle carry a resume flag for gemini/codex too — COD-124 only
   * commits to full resume semantics for claude-mode sessions.
   *
   * Remote-attached (owned:false) sessions: `TerminalMultiplexer.killSession()`
   * already differentiates owned vs. non-owned sessions (COD-105) — a
   * non-owned session is always DETACHED locally, never killed on the
   * remote host. park() relies entirely on that existing guarantee; it does
   * not special-case remote sessions itself.
   *
   * Idempotent: calling park() on an already-parked session is a no-op.
   */
  async park(): Promise<void> {
    if (this._status === 'parked') {
      return;
    }

    // Preserve the conversation-resume id for claude-mode sessions only.
    if (this.mode === 'claude') {
      this._resumeSessionId = this._claudeSessionId || this._resumeSessionId || this.id;
    }

    this._clearAllTimers();
    this._desktopSizeClaims.clear();

    if (this.rejectPromise && !this._promptResolved) {
      this._promptResolved = true;
      this.rejectPromise(new Error('Session parked'));
    }
    this.resolvePromise = null;
    this.rejectPromise = null;

    this.cleanupTrackerListeners();

    if (this.ptyProcess) {
      // Graceful SIGTERM only — a parked session is expected to be resumed,
      // not torn down, so we don't escalate to SIGKILL the way stop() does.
      try {
        this.ptyProcess.kill();
      } catch (err) {
        console.warn('[Session] park: failed to send SIGTERM to PTY process (may already be dead):', err);
      }
      this.ptyProcess = null;
    }

    this._pid = null;
    this._currentTaskId = null;
    this._taskCache.clear();
    this._childAgentIds = [];

    // Detach the mux/tmux session. killSession() already implements the
    // COD-105-safe owned/non-owned differentiation (kill vs. local-only
    // detach for remote-attached sessions) — park() just delegates to it,
    // same as stop() does for its own killMux=true path.
    if (this._mux) {
      try {
        const detached = await this._mux.killSession(this.id);
        if (detached) {
          console.log('[Session] park: detached mux session for:', this.id);
        }
      } catch (err) {
        console.error('[Session] park: failed to detach mux session:', err);
      }
    }
    this._muxSession = null;

    this._status = 'parked';
  }

  assignTask(taskId: string): void {
    this._currentTaskId = taskId;
    this._status = 'busy';
    this._terminalBuffer.clear();
    this._textOutput.clear();
    this._errorBuffer = '';
    this._messages = [];
    this._lastActivityAt = Date.now();
  }

  clearTask(): void {
    this._currentTaskId = null;
    this._status = 'idle';
    this._lastActivityAt = Date.now();
  }

  getOutput(): string {
    return this._textOutput.value;
  }

  getError(): string {
    return this._errorBuffer;
  }

  getTerminalBuffer(): string {
    return this._terminalBuffer.value;
  }

  clearBuffers(): void {
    this._terminalBuffer.clear();
    this._textOutput.clear();
    this._errorBuffer = '';
    this._messages = [];
    this._taskTracker.clear();
    this._ralphTracker.clear();
    this._taskCache.clear();
  }
}
