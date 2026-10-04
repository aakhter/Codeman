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
 * @emits session:terminal, session:idle, session:working, session:completion, session:promptSubmitted, session:exit
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
  type EffortLevel,
  type CustomModelBookkeeping,
  type CustomModelSelection,
  type GeminiConfig,
  type SessionAttachmentHistoryItem,
  type AntigravityConfig,
  type PiConfig,
  type GrokConfig,
  type DeepSeekConfig,
  type OmpConfig,
  type SessionRemote,
  type SessionSource,
  type SessionDocker,
  type SessionActivityProjection,
  type SessionNameSource,
  type SessionWriteOptions,
  type PaneExit,
} from './types.js';
import { resolveAndClaimOmpSessionId } from './utils/omp-session-resolver.js';
import { claudeTranscriptExists } from './utils/claude-transcript.js';
import { matchesPattern } from './config/cli-registry/patterns.js';
import { probeDockerCliVersion } from './docker-hosts.js';
import { probeRemoteCliVersion } from './remote-hosts.js';
import type { TerminalMultiplexer, MuxSession, CommandDeliveryResult } from './mux-interface.js';
import { TaskTracker, type BackgroundTask } from './task-tracker.js';
import { RalphTracker } from './ralph-tracker.js';
import { BashToolParser } from './bash-tool-parser.js';
import {
  isTrustDialogScreen,
  trustDialogNextKey,
  TRUST_KEY_CONFIRM,
  TRUST_DIALOG_WINDOW_MS,
  TRUST_DIALOG_RETRY_MS,
  TRUST_DIALOG_MAX_ATTEMPTS,
  TRUST_DIALOG_SCAN_BYTES,
} from './session-trust-dialog.js';
import {
  trackActivityStreak,
  isSustainedActivity,
  isPaneQuiet,
  watchingLabel,
  isAwaitingWorkers,
  WATCHING_TAIL_LINES,
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
import { getCli } from './config/cli-registry/registry.js';
import { legacyResumeSlot } from './session-cli-registry-bridge.js';
import { SubmitVerifier } from './session-submit-verifier.js';
import { compileVersionRegex } from './config/cli-registry/patterns.js';
import { resolveSessionCliVersion } from './utils/cli-resolver.js';
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
import { isGeneratedSessionName, SubmittedPromptTracker } from './session-auto-name.js';
import { parseTerminalAttachmentRequests } from './attachment-magic.js';
import {
  sanitizeAttachmentHistory,
  upsertAttachmentHistory as upsertAttachmentHistoryList,
} from './session-attachment-history.js';
import type { CodexProviderEnvironment } from './readmymind-predictor.js';
import type { CodexProviderIdentity } from './codex-provider-identity.js';
import { workingFramePollCoordinator } from './working-frame-poll-coordinator.js';
import {
  TerminalSizingOwnership,
  type TerminalViewerDimensions,
  type TerminalViewportType,
} from './terminal-sizing-ownership.js';
import {
  hashMobileInputTraceValue,
  mobileInputTraceCollector,
  mobileInputTraceTimestamp,
  type MobileInputTraceCollector,
  type MobileInputTraceStage,
} from './perf/mobile-input-trace.js';

export type { BackgroundTask } from './task-tracker.js';
export type { RalphTrackerState, RalphTodoItem, ActiveBashTool } from './types.js';

export type ResizeViewportType = TerminalViewportType;

interface SessionMobileInputTraceRegistration {
  token?: symbol;
  trace: MobileInputTraceCollector;
  active: boolean;
}

const sessionMobileInputTraceRegistrations: SessionMobileInputTraceRegistration[] = [];
const globalSessionMobileInputTraceRegistration: SessionMobileInputTraceRegistration | undefined =
  mobileInputTraceCollector.enabled ? { trace: mobileInputTraceCollector, active: true } : undefined;

function currentSessionMobileInputTraceRegistration(): SessionMobileInputTraceRegistration | undefined {
  return sessionMobileInputTraceRegistrations.at(-1) ?? globalSessionMobileInputTraceRegistration;
}

type SessionMobileInputTraceRecorder = (stage: MobileInputTraceStage, data: string) => void;

/** Install an enabled trace collector only inside Vitest and return an exact restoration callback. */
export function setMobileInputTraceCollectorForTests(trace: MobileInputTraceCollector): () => void {
  if (!process.env.VITEST || !trace.enabled) {
    throw new Error('Session tracing tests require an enabled test trace collector');
  }
  const token = Symbol('session-mobile-input-trace');
  const registration: SessionMobileInputTraceRegistration = { token, trace, active: true };
  sessionMobileInputTraceRegistrations.push(registration);
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    registration.active = false;
    const index = sessionMobileInputTraceRegistrations.findIndex((registration) => registration.token === token);
    if (index !== -1) sessionMobileInputTraceRegistrations.splice(index, 1);
  };
}

export type SessionIdleReason = 'turn-end' | 'initial-ready' | 'shell-ready';

export interface SessionIdleInfo {
  reason: SessionIdleReason;
}

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
// How long after construction a RECOVERED session's wire activity stamp keeps
// its restored previous-run value. Recovery attaches every pane at boot and the
// attach repaint arrives as ordinary PTY output; without this window that
// repaint would overwrite every restored stamp within the same second, which is
// exactly the restart flattening the restore exists to prevent. Real actions
// (input, task assignment, respawn) always stamp through it.
const WIRE_ACTIVITY_SETTLE_MS = 15_000;

// Note: Auto-compact/clear timing constants moved to session-auto-ops.ts

/** Graceful shutdown delay when stopping session (100ms) */
const GRACEFUL_SHUTDOWN_DELAY_MS = 100;

/** SIGKILL can race a process or its process group exiting after SIGTERM. */
function isNoSuchProcessError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ESRCH';
}

// Conversations kept in a pane's chain. A pane that /clears repeatedly would
// otherwise grow state.json without bound; 32 covers any real session's history
// and the oldest entries are the ones whose transcripts Claude Code has pruned.
const MAX_CLAUDE_SESSION_CHAIN = 32;

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

/**
 * True for external-CLI run modes (non-Claude) that use their own TUI and output format:
 * no Claude transcript, no hooks, no Claude-format token/BashTool parsing.
 *
 * ⚠️ Reads its OWN capability flag rather than being derived from `hooks` or `kind`, and
 * that independence is load-bearing. `shell` has no hooks but is NOT external, so a
 * predicate derived from hooks would sweep it in here; `deepseek` HAS hooks but IS
 * external. Deriving one of these three predicates from another has already shipped a bug
 * (see CliCapabilities' own doc comment), which is why they are three separate fields.
 *
 * An UNREGISTERED mode is treated as external — the conservative answer, since it disables
 * Claude-specific parsing rather than pointing it at output that was never Claude's.
 */
export function isExternalCliMode(mode: SessionMode): boolean {
  return getCli(mode)?.capabilities.external ?? true;
}

export function detectExternalCliWorkingFrame(data: string, mode: SessionMode): boolean {
  if (mode === 'codex') {
    // Codex renders "Working (2s • esc to interrupt)", "Working (4m 03s • …)"
    // and sometimes unit-less "Working (31 • …)" (COD-175 prod screenshot), so
    // only anchor on "Working (<digits>" plus the interrupt hint in-parens.
    return /\bWorking \(\d+[^)\n]*esc to interrupt\)/.test(data);
  }
  if (mode === 'opencode') {
    // Opencode Bubble Tea TUI — see OPENCODE_WORKING_LINE_PATTERN for
    // rationale. Any single hit proves working; absence proves nothing.
    // COD-375: w6-tcc idle frame shows `esc interrupt` and `⬝` while idle — only Working/`…` timer or braille spinner prove working.
    if (/\bWorking\b/i.test(data)) return true;
    if (/…\s*\((?:\d+h\s+)?(?:\d+m\s+)?\d+s\b/.test(data)) return true;
    if (SPINNER_PATTERN.test(data)) return true;
    return false;
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

export type CodexRenderedState = 'working' | 'input-ready' | 'unknown';

const CODEX_COMPOSER_LINE_PATTERN = /^[ \t]*›(?![ \t]*\d+[.)](?:[ \t]|$))(?:[ \t]|$)/m;
const CODEX_NUMBERED_CHOICE_LINE_PATTERN = /^\s*([›❯])?\s*(\d+)[.)](?:[ \t]+(\S(?:.*\S)?))?[ \t]*$/;

function hasCodexNumberedChoiceBlock(frame: string): boolean {
  const lines = frame.split(NEWLINE_SPLIT_PATTERN);
  for (let start = 0; start < lines.length; start++) {
    const firstOption = lines[start].match(CODEX_NUMBERED_CHOICE_LINE_PATTERN);
    if (firstOption?.[2] !== '1') continue;

    let expectedOption = 1;
    let optionCount = 0;
    let selectionVisible = false;
    let previousOptionLine = start - 1;
    let coherent = true;
    for (let lineIndex = start; lineIndex < lines.length; lineIndex++) {
      if (lineIndex - previousOptionLine > 4) break;
      const option = lines[lineIndex].match(CODEX_NUMBERED_CHOICE_LINE_PATTERN);
      if (!option) continue;
      if (Number(option[2]) !== expectedOption || !option[3]) {
        coherent = false;
        break;
      }

      optionCount++;
      selectionVisible ||= Boolean(option[1]);
      previousOptionLine = lineIndex;
      expectedOption++;
    }
    if (coherent && optionCount >= 2 && optionCount <= 6 && selectionVisible) return true;
  }
  return false;
}

const CODEX_BACKGROUND_TERMINAL_WAIT_PATTERN = /\bwaiting for background terminal\b/i;

/**
 * Rendered-frame evidence that Codex is explicitly waiting on a background
 * terminal.
 *
 * A ready composer establishes parent-session availability. A remaining
 * background terminal can be a durable helper, such as a preview server, so a
 * numeric background-terminal count is informational rather than evidence that
 * Codex is currently working.
 */
export function detectCodexBackgroundTerminalWaitFrame(data: string): boolean {
  return CODEX_BACKGROUND_TERMINAL_WAIT_PATTERN.test(data);
}

export function classifyCodexRenderedState(frame: string | null | undefined): CodexRenderedState {
  if (!frame) return 'unknown';

  const plain = frame.replace(TMUX_ABSOLUTE_ROW_START_PATTERN, '\n').replace(ANSI_ESCAPE_PATTERN_FULL, '');
  if (detectCodexCheckpointWorkingFrame(plain)) return 'working';
  // A genuine question outranks a running background terminal: the human still
  // has to answer it, so it must stay input-ready and keep raising an alert.
  if (hasCodexNumberedChoiceBlock(plain)) return 'input-ready';
  if (detectCodexBackgroundTerminalWaitFrame(plain)) return 'working';
  if (CODEX_COMPOSER_LINE_PATTERN.test(plain)) return 'input-ready';
  return 'unknown';
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

/**
 * The `^`-anchored composer-prompt matcher for a declared glyph.
 *
 * ⚠️ Built per call rather than shared: a `/g`-less regex has no `lastIndex` to reset, but these
 * are cheap and the alternative — a module-level cache keyed by glyph — buys nothing measurable
 * on a path that already just captured and ANSI-stripped a pane frame.
 *
 * The glyph is registry data, so it is escaped rather than interpolated raw: a custom entry
 * declaring `.` must match a literal dot, not any character.
 */
function checkpointPromptPattern(glyph: string): RegExp {
  return new RegExp(`^\\s*${glyph.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`, 'm');
}

/**
 * Dispatch to the frame classifier a CLI's `capabilities.checkpoint.workingFrameProfile` names.
 *
 * ⚠️ An UNKNOWN profile returns false — "no working evidence" — which is the same answer a CLI
 * with no classifier at all gets, and it is the safe direction here: a false positive would
 * make a checkpoint wait forever for a pane that is already idle. `schema.ts` rejects an
 * unknown name at LOAD time, so reaching this arm means a build/registry mismatch, not a typo.
 */
function detectCheckpointWorkingFrame(grammar: { workingFrameProfile: string }, plain: string): boolean {
  switch (grammar.workingFrameProfile) {
    case 'codex-checkpoint':
      return detectCodexCheckpointWorkingFrame(plain);
    case 'claude-checkpoint':
      return detectClaudeCheckpointWorkingFrame(plain);
    default:
      return false;
  }
}

/** Display name for a run mode. Falls back to the raw id for an unregistered one. */
function getModeLabel(mode: SessionMode): string {
  return getCli(mode)?.label ?? mode;
}

/**
 * Does this CLI's launch spec gate anything on its own version?
 *
 * Only such a CLI needs its version probed at session start — probing one with no gates
 * would spawn a `--version` subprocess whose answer nothing reads. Today that is claude
 * (the `--name` flag, gated at 2.1.224), which is why the probe used to be written as
 * `mode === 'claude'`.
 */
function cliNeedsVersionProbe(mode: SessionMode): boolean {
  return Object.keys(getCli(mode)?.capabilities.gates ?? {}).length > 0;
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
 * TUI that may rely on it), `pi` (below) and `grok` (a fullscreen alt-screen TUI
 * with mouse support, i.e. the opencode case, not the Ink case). Keep parity
 * with the replay-side strip in session-routes.ts.
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
  return getCli(mode)?.capabilities.altScreen === 'strip-full';
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
  private _nameSource: SessionNameSource;
  /**
   * Reconstructs the composer draft from USER keystrokes so the first real
   * prompt can name the tab. Fed only when a write says `fromUser`, and never
   * for a CLI whose Enter runs a command rather than submitting a prompt
   * (`startMode: 'shell'`), so a shell tab is not renamed after every `ls`.
   */
  private readonly _submittedPromptTracker = new SubmittedPromptTracker();
  private readonly _acceptsPrompts: boolean;
  private ptyProcess: pty.IPty | null = null;
  private _pid: number | null = null;
  private _status: SessionStatus = 'idle';
  private _activityProjection: SessionActivityProjection = {
    activityStatus: 'idle',
    activityStatusSince: null,
  };
  private _terminalActivityEpoch = 0;
  private _mobileInputTraceOrdinal = 0;
  private _currentTaskId: string | null = null;

  // COD-118: bound repeated non-zero interactive-PTY exits. Recorded in the
  // interactive PTY onExit handler; when it trips, the session flips to 'error'
  // and startInteractive() refuses to respawn until an explicit user restart
  // calls resetRespawnBreaker(). Defense-in-depth over the COD-115 crash-loop.
  private readonly _ptyExitBreaker = new InteractivePtyExitBreaker();
  private _respawnBlocked = false;
  // COD-386: the pane's live `#{pane_current_path}`, refreshed by the server's
  // sweep. Runtime-only in the same sense as _respawnBlocked — serialized by
  // toState() but never restored by the constructor.
  private _cwd?: string;
  private readonly _terminalBufferMaxSize: number;
  private readonly _terminalBufferTrimSize: number;
  /** Creating browser's terminal dims — new tmux windows spawn at this size instead of 120x40 (COD-179) */
  private readonly _initialDims?: { cols: number; rows: number };
  // Use BufferAccumulator for hot-path buffers to reduce GC pressure
  private _terminalBuffer: BufferAccumulator;
  private _textOutput = new BufferAccumulator(MAX_TEXT_OUTPUT_SIZE, TEXT_OUTPUT_TRIM_SIZE);
  private _errorBuffer: string = '';
  private _lastActivityAt: number;
  // Display twin of _lastActivityAt, reported by toState()/the getter. It can
  // lag behind on recovery: the restored previous-run stamp survives the attach
  // repaint (see _markActivity), so a restart does not flatten the home
  // screens' quiet ordering. Idle detection never reads it.
  private _wireActivityAt: number;
  private _wireActivitySettleUntil: number;
  private readonly _restoredIdleAnchorAt?: number;
  private _claudeSessionId: string | null = null;
  private _claudeAuthoritativeSessionId: string | null = null;
  private _claudeSessionIdentityAdopted = false;
  private _claudeSessionStartHookReady: boolean;
  // Set only when the id came from the CLI's own UserPromptSubmit/Stop hook
  // payload, keyed on this pane's $CODEMAN_SESSION_ID. That binding is a fact,
  // not a correlation: it never consults cwd, so a sibling pane on the same
  // folder cannot steal it. Runtime-only — a restart must re-earn it from the
  // next hook rather than trust a persisted claim.
  private _claudeSessionIdIsFirstHand = false;
  // Conversations this pane has been on, oldest first, current last. Grows only
  // through a first-hand adoption, so it can never splice in a foreign
  // conversation. Persisted, because `/clear` is otherwise unrecoverable: the
  // predecessor id exists nowhere else once the pane moves on.
  private _claudeSessionChain: string[] = [];
  private _totalCost: number = 0;
  private _messages: ClaudeMessage[] = [];
  private _lineBuffer: string = '';
  private _lineBufferFlushTimer: NodeJS.Timeout | null = null;
  // Alt-screen-strip modes (Codex/Claude): trailing partial CSI held back so
  // sequences split across PTY chunks can't slip past the alt-screen/scrollback
  // strip (see _handleTerminalOutput / isAltScreenStripMode)
  private _altScreenSeqCarry: string = '';

  /**
   * Mouse-tracking DECSET modes the CLI currently has ON, as observed while
   * STRIPPING them out of the stream below. Kept as a set rather than a boolean
   * because a TUI may enable 1002 and later disable 1000 (a mode it never
   * enabled); tracking is on while any of them is.
   */
  private _cliMouseModes = new Set<number>();
  private _cliMouseTracking = false;
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
  /** Shared rendered-frame poll registration for external-CLI sessions (local AND remote). */
  private _workingFramePollUnregister: (() => void) | null = null;
  private _workingFramePollGeneration = 0;
  private _workingFrameFirstPollCompleted = false;
  private _workingFrameCapture: {
    generation: number;
    mux: TerminalMultiplexer;
    muxName: string;
    controller: AbortController;
    promise: Promise<string | null>;
  } | null = null;
  private _externalCliIdleGeneration = 0;
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
  /**
   * Background work the pane's own footer reports, e.g. `1 monitor`; null for none.
   *
   * Cached BESIDE `_lastPaneProbeWorking` and refreshed only by a capture that really
   * happened, so it goes stale exactly as that verdict does. The probe returns its
   * cached boolean without re-capturing inside `PANE_PROBE_MIN_INTERVAL_MS`, and a
   * label derived from a capture nobody took would be a guess wearing a fact's clothes.
   *
   * ⚠️ It then FREEZES once `_confirmIdle()` concludes: `activityTimeout` is null from
   * there, and nothing looks at the pane again until it produces output. That is
   * correct rather than merely tolerable, because work ending repaints the pane either
   * way — a monitor firing wakes the agent, and codex drops its background-terminal row
   * on its own. Do not add a timer to keep this fresh; it would spend a `capture-pane`
   * per idle session per tick to learn nothing.
   *
   * A server restart is not a hole in that either, though it looks like one: this field
   * is live state and starts empty. Reconciliation re-attaches the pane, the attach
   * repaint carries the composer glyph, and the idle confirmation that arms on it probes
   * and re-reads the label with no input from anyone — measured 2026-09-23 on a restarted
   * instance, back within ~20 s for a session whose background terminal was still
   * running. A session that comes back with no label has no chip on its screen.
   */
  private _watching: string | null = null;
  /** Lazily compiled `capabilities.workDetect.workingLine`. See _workingLinePattern(). */
  private _workingLineRe: RegExp | undefined = undefined;
  /** Lazily compiled `capabilities.workDetect.watchingLine`. See _watchingLinePattern(). */
  private _watchingLineRe: RegExp | null | undefined = undefined;
  /** Resolved with the pattern above: how many rows at the foot of the screen to search. */
  private _watchingWindow = WATCHING_TAIL_LINES;
  /** Lazily compiled `capabilities.workDetect.awaitingLine`. See _awaitingLinePattern(). */
  private _awaitingLineRe: RegExp | null | undefined = undefined;
  private _trustDialogAccepted: boolean = false; // Stops the trust-dialog scan (answered, or given up)
  private _trustDialogAttempts = 0; // Keystrokes sent at the trust dialog
  private _lastTrustDialogScanAt = 0; // Throttle for the trust-dialog screen read
  private _trustDialogTimer: NodeJS.Timeout | null = null; // Re-read after a keystroke (see below)
  /** Re-sends Enter while a programmatic prompt still sits in the composer (session-submit-verifier.ts). */
  private _submitVerifier: SubmitVerifier | null = null;
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
  /**
   * The agent in this session's local tmux pane has exited (Ark0N/Codeman#446).
   * `null` is the UNKNOWN arm of the tri-state and is what {@link setPaneExit}
   * stores for every session shape the field does not apply to. See
   * {@link PaneExit} for the shapes and for why an unknown answer must never be
   * rendered as "alive".
   */
  private _paneExit: PaneExit | null = null;
  /**
   * How many starts, attaches or relaunches are running for this session's
   * pane. While one is, a dead-pane reading may describe a pane that is being
   * revived on purpose, so the exited-agent sweep leaves the session alone
   * (Ark0N/Codeman#446). A counter rather than a flag, so two overlapping
   * operations cannot clear each other's mark.
   */
  private _paneLifecycleOps = 0;
  /** When the last pane start, attach or relaunch finished (ms), 0 when none has run. */
  private _paneStartedAt = 0;
  /**
   * The server has started closing this session, so no start or attach may
   * begin (see {@link markClosing}).
   */
  private _closing = false;
  /**
   * This session was rebuilt from the tmux socket rather than from Codeman's
   * own records, so its `remote`/`docker` metadata is missing rather than known
   * to be absent. See {@link MuxSession.discovered}.
   */
  private _discoveredMuxSession = false;
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
  // Grok configuration (only for mode === 'grok')
  private _grokConfig: GrokConfig | undefined;

  // DeepSeek Harness configuration (only for mode === 'deepseek')
  private _deepSeekConfig: DeepSeekConfig | undefined;
  // OMP configuration (only for mode === 'omp')
  private _ompConfig: OmpConfig | undefined;
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

  // Custom Model Endpoint Profiles (docs/custom-model-endpoints-plan.md). `envKeys`,
  // `configDir` and `launchModel` are internal bookkeeping ONLY (never surfaced via
  // toState()/the customModel getter): they are what setCustomModel() needs to undo a
  // previous injection (remove exactly the env keys it added, delete a previous isolated
  // config dir) without guessing what it once wrote. Persisted disk-only (`__customModel`).
  private _customModel: CustomModelBookkeeping | undefined;

  // Env keys a retired custom-model selection injected that the NEXT respawn must
  // `tmux setenv -u`. Deleting a key from `_envOverrides` alone does nothing to the
  // tmux session, which keeps every `setenv` and hands it to `respawn-pane`, so the
  // relaunched CLI would come back still pointed at the old endpoint (measured, see
  // TmuxManager.applyEnvOverrides). Drained after a successful respawn.
  private _pendingEnvUnsets = new Set<string>();

  // tmux history-limit (scrollback lines) allocated when this session's pane is created.
  private readonly _tmuxHistoryLimit: number;

  // Remote execution metadata, present when this session runs over SSH through local tmux.
  private readonly _remote?: SessionRemote;

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
  private _notesLaunchCase?: import('./types/api.js').CaseInfo;

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
      /**
       * Who owns the name (see `SessionNameSource`). Omitted, it is inferred
       * from the name: Codeman's own `w<n>-<case>` placeholders (or no name)
       * stay eligible for auto-naming, anything else counts as the user's.
       */
      nameSource?: SessionNameSource;
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
      /** Grok configuration (only for mode === 'grok') */
      grokConfig?: GrokConfig;
      /** DeepSeek Harness configuration (only for mode === 'deepseek') */
      deepSeekConfig?: DeepSeekConfig;
      /** OMP configuration (only for mode === 'omp') */
      ompConfig?: OmpConfig;
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
      /** Restored conversation chain, oldest first (see `claudeSessionChain`). */
      claudeSessionChain?: string[];
      /** Restored agent-exit observation for this session's pane (see `paneExit`). */
      paneExit?: PaneExit;
      /** This session was rebuilt from the tmux socket, so its metadata is a guess. */
      discoveredMuxSession?: boolean;
      /** Restored wall-clock ms of the pane's last output (recovery only; see `_wireActivityAt`). */
      lastActivityAt?: number;
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
      notesLaunchCase?: import('./types/api.js').CaseInfo;
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
    this._nameSource =
      config.nameSource ?? (!this._name || isGeneratedSessionName(this._name) ? 'placeholder' : 'manual');
    this._acceptsPrompts = getCli(this.mode)?.capabilities.startMode !== 'shell';
    this._resumeSessionId = config.resumeSessionId;
    this._nativeResumeId = config.nativeResumeId ?? null;
    // NOW, not `createdAt`: recovery passes the ORIGINAL creation time of a
    // days-old tmux session, and seeding last-activity from it would report a
    // freshly re-attached pane as having been silent for days, which the idle
    // confirmation reads as "already quiet". For a genuinely new session the
    // two are the same instant.
    this._lastActivityAt = Date.now();
    this._terminalBufferMaxSize = config.terminalBufferConfig?.maxBytes ?? MAX_TERMINAL_BUFFER_SIZE;
    this._terminalBufferTrimSize = config.terminalBufferConfig?.trimBytes ?? TERMINAL_BUFFER_TRIM_SIZE;
    this._tmuxHistoryLimit = config.tmuxHistoryLimit ?? DEFAULT_TMUX_HISTORY_LIMIT;
    this._remote = config.remote;
    this._initialDims = config.initialDims;
    this._terminalBuffer = new BufferAccumulator(this._terminalBufferMaxSize, this._terminalBufferTrimSize);
    // The WIRE copy of the stamp is allowed to be older: recovery threads the
    // previous run's value so a restart does not flatten the home screens'
    // most-recently-quiet ordering (every stamp otherwise resets to boot time,
    // and the attach repaint re-bumps the rest within the same second). The
    // settle window in _markActivity() carries the restored value through that
    // repaint; the private stamp above stays boot-anchored because the idle
    // confirmation reads it as "how long has the pane been quiet".
    this._wireActivityAt = config.lastActivityAt || Date.now();
    this._wireActivitySettleUntil = config.lastActivityAt ? Date.now() + WIRE_ACTIVITY_SETTLE_MS : 0;
    // Set claudeSessionId — when resuming, the Claude conversation ID is the resumed one.
    // For omp and codex, `claudeSessionId` doubles as the generic "external
    // transcript id" alias key mergeUnifiedSessions() folds a history row into
    // its owning session by: each mints its OWN thread id, unrelated to this
    // Codeman id, so without this the conversation's Past-Sessions row (keyed by
    // that thread id) would never merge with its own live/persisted row (keyed
    // by this id) — it would just show up a second time. For codex a duplicate
    // is worse than cosmetic: the stale row still resumes, so clicking it starts
    // a SECOND `codex resume` on a thread already open in another pane.
    //
    // This covers a RESUMED codex session, which knows its thread id up front. A
    // fresh one learns its id only once codex writes the rollout, so it is folded
    // from the other side — see the originator stamping in `gatherUnifiedInputs()`.
    this._claudeSessionId =
      config.claudeSessionId ??
      config.resumeSessionId ??
      config.ompConfig?.resumeSessionId ??
      config.codexConfig?.resumeSessionId ??
      this.id;
    this._claudeAuthoritativeSessionId = config.claudeSessionId ?? config.resumeSessionId ?? null;
    this._claudeSessionIdentityAdopted = config.claudeSessionIdentityAdopted ?? Boolean(config.resumeSessionId);
    this._claudeSessionStartHookReady = config.claudeSessionStartHookReady ?? this.mode !== 'claude';
    // Restored from state.json on boot recovery. start() resets _claudeSessionId
    // to the launch id even when re-attaching to a mux session whose CLI has
    // moved on (a `/clear` before the restart), so this anchor is what lets the
    // response viewer re-derive the live conversation without waiting for the
    // user to type again.
    this._lastSubmitAt = config.lastSubmitAt ?? 0;
    this._restoredIdleAnchorAt = config.lastActivityAt
      ? Math.max(config.lastActivityAt, config.lastSubmitAt ?? 0)
      : undefined;
    // Restored chain: its tail is the conversation the CLI was actually on when
    // the server stopped, which outranks the launch id seeded just above. The
    // FIRST-HAND flag is deliberately NOT restored — a persisted claim is not a
    // fact, so the pane re-earns the guess-free path from its next hook.
    this._claudeSessionChain = Array.isArray(config.claudeSessionChain) ? [...config.claudeSessionChain] : [];
    const restoredConversation = this._claudeSessionChain[this._claudeSessionChain.length - 1];
    if (restoredConversation) this._claudeSessionId = restoredConversation;
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

    // Apply Codex configuration. COD-392 baseCommand is server-resolved and
    // private: keep it on the in-memory config so respawn reuses the exact
    // launch text, but never expose it through toState()/toDetailedState().
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
    // Apply OMP configuration
    if (config.ompConfig) {
      this._ompConfig = config.ompConfig;
    }

    // Apply DeepSeek Harness configuration
    if (config.deepSeekConfig) {
      this._deepSeekConfig = config.deepSeekConfig;
    }

    // Apply Grok configuration
    if (config.grokConfig) {
      this._grokConfig = config.grokConfig;
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
    this._discoveredMuxSession = config.discoveredMuxSession === true;
    // Restored so a record that says the agent exited survives a server restart
    // rather than being blanked by the first persist after boot. It runs here
    // because the scoping reads `_remote`, `_docker` and the mux fields, all of
    // which are set by now. It is a claim about a pane this process has not
    // looked at yet, so every path that starts or re-attaches a pane drops it
    // (see `_setupOrAttachMuxSession`) and the pane-exit watcher's own tick
    // replaces it with a first-hand reading. NOT the stats collector, which a
    // browser panel arms and disarms — see `startPaneExitWatcher`.
    this.setPaneExit(config.paneExit);
    // Never self-parent: a session pointing at itself would draw a zero-length
    // lineage arc under its own tab. Only reachable via the recovery path, where
    // both the id and the saved parent come from disk.
    this._notesLaunchCase = config.notesLaunchCase ? structuredClone(config.notesLaunchCase) : undefined;
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
      isIdleAutomationBlocked: () => this.blocksIdleAutomation,
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
    return this._wireActivityAt;
  }

  /** Recovery-only lower bound for when a persisted raw-idle episode could begin. */
  get restoredIdleAnchorAt(): number | undefined {
    return this._status === 'idle' ? this._restoredIdleAnchorAt : undefined;
  }

  /**
   * Stamp activity NOW. The private stamp (idle detection's "how long has the
   * pane been quiet") always moves; the wire stamp holds its restored value
   * through the post-recovery attach-repaint window unless the activity is a
   * real action (input, task assignment, respawn), which always writes through.
   */
  private _markActivity(realAction = false): void {
    this._lastActivityAt = Date.now();
    if (realAction || Date.now() >= this._wireActivitySettleUntil) {
      this._wireActivityAt = this._lastActivityAt;
      this._wireActivitySettleUntil = 0;
    }
  }

  get claudeSessionId(): string | null {
    return this._claudeSessionId;
  }

  /**
   * True when `claudeSessionId` came from the CLI's own hook payload rather than
   * from the launch config or a history correlation. The response viewer uses it
   * to skip guessing entirely — see resolveActiveClaudeSessionIdFromHistory().
   */
  get claudeSessionIdIsFirstHand(): boolean {
    return this._claudeSessionIdIsFirstHand;
  }

  /** Conversations this pane has been on, oldest first, current last. */
  get claudeSessionChain(): readonly string[] {
    return this._claudeSessionChain;
  }

  /** Docker execution metadata when this session runs inside a container, else undefined. */
  get docker(): SessionDocker | undefined {
    return this._docker;
  }

  /** Remote-SSH metadata when this session runs on a remote host, else undefined. */
  get remote(): SessionRemote | undefined {
    return this._remote;
  }

  /**
   * `deepSeekConfig.statusReporting` verbatim: `undefined` when the caller sent
   * none (i.e. ON), `false` when the user disarmed the status bridge for this
   * session.
   *
   * Exposed because whether a dsh session can deliver `stop`/`blocked` is a
   * per-SESSION fact, not a per-mode one, and `hooksAvailableForMode()` is pure
   * and holds no `Session` reference by design. Undefined for every other mode,
   * where the flag is meaningless.
   */
  get deepSeekStatusReporting(): boolean | undefined {
    return this._deepSeekConfig?.statusReporting;
  }

  /**
   * This session's `DSH_HOME` override, if it set one.
   *
   * Deliberately ONE key rather than an `envOverrides` getter: the map can hold
   * provider credentials (`DEEPSEEK_API_KEY`, `GEMINI_API_KEY`, …) and is
   * kept off the public `SessionState` for exactly that reason. The transcript
   * reader needs the profile tree's location and nothing else, so that is all
   * this exposes.
   */
  get deepSeekHomeOverride(): string | undefined {
    const value = this._envOverrides?.DSH_HOME;
    return value && value.trim() ? value.trim() : undefined;
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
  //
  // In interactive PTY mode Claude CLI emits no JSON to stdout, so
  // `_handleJsonMessage` never sees `session_id`; hooks are the only signal
  // that conveys a post-/clear conversation switch.
  //
  // `firstHand` marks an id that came from the CLI process itself — a hook
  // payload whose delivery was keyed on this pane's $CODEMAN_SESSION_ID. Only
  // those extend the chain: a history-correlated guess must never be able to
  // write a foreign conversation into this pane's permanent record.
  adoptClaudeSessionId(newId: string, options: { firstHand?: boolean } = {}): void {
    if (!newId) return;
    if (options.firstHand) {
      this._claudeSessionIdIsFirstHand = true;
      this._recordClaudeSessionInChain(newId);
    }
    if (newId === this._claudeSessionId) return;
    this._claudeSessionId = newId;
  }

  /**
   * Adopt the authoritative identity delivered by Claude's SessionStart hook.
   *
   * SessionStart is delivered to this pane on its own $CODEMAN_SESSION_ID, so it
   * is first-hand by construction and extends the conversation chain.
   */
  adoptClaudeSessionStartId(newId: string): void {
    if (!newId) return;
    this._claudeSessionStartHookReady = true;
    this._claudeSessionIdentityAdopted = true;
    this._claudeAuthoritativeSessionId = newId;
    this.adoptClaudeSessionId(newId, { firstHand: true });
  }

  /**
   * Append to the conversation chain, oldest first. A repeat of the current tail
   * is a no-op (every prompt in a conversation reports the same id), and an id
   * already in the chain moves to the tail rather than duplicating, which is
   * what a `/resume` back to an earlier conversation does.
   */
  private _recordClaudeSessionInChain(id: string): void {
    if (this._claudeSessionChain[this._claudeSessionChain.length - 1] === id) return;
    const existing = this._claudeSessionChain.indexOf(id);
    if (existing !== -1) this._claudeSessionChain.splice(existing, 1);
    this._claudeSessionChain.push(id);
    // A pane that /clears in a loop must not grow this without bound.
    if (this._claudeSessionChain.length > MAX_CLAUDE_SESSION_CHAIN) {
      this._claudeSessionChain.splice(0, this._claudeSessionChain.length - MAX_CLAUDE_SESSION_CHAIN);
    }
  }

  /** The tmux session name, if the session is running inside a mux */
  get muxName(): string | null {
    return this._muxSession?.muxName ?? null;
  }

  /**
   * True when a tmux pane's death would mean THIS session's agent has exited.
   *
   * Four shapes fail the test, and each would otherwise publish a death that is
   * not the agent's. A direct-PTY session owns no pane at all. A remote SSH
   * session's local pane holds the ssh client, whose death means a transport
   * drop OR an exit, which is the ambiguity PR #355 was about. A docker case's
   * local pane holds a `docker exec` into the container's own tmux.
   *
   * The fourth is a session rebuilt from the socket. Absent `remote`/`docker`
   * normally means "this is local", but on a discovered record it only means
   * "Codeman never found the metadata": the synthetic `restored-<fragment>` id
   * matches no `state.json` entry, so a remote session rediscovered after
   * `mux-sessions.json` was lost arrives looking local, and its next transport
   * drop would be published as an agent exit. Unproven locality fails closed.
   */
  private get paneExitApplies(): boolean {
    if (this._discoveredMuxSession) return false;
    return this._useMux && this._muxSession !== null && !this._remote && !this._docker;
  }

  /** What Codeman last observed of this pane's agent, or undefined for UNKNOWN. */
  get paneExit(): PaneExit | undefined {
    return this._paneExit ?? undefined;
  }

  /**
   * True while a start, attach or relaunch is running for this session's pane.
   * The exited-agent sweep reads it (see `pane-exit-sweep.ts`): the dead-pane
   * branch of {@link _setupOrAttachMuxSession} respawns an exited pane, and
   * until it finishes and clears the exit, the pane still reads as dead.
   */
  get paneLifecycleInFlight(): boolean {
    return this._paneLifecycleOps > 0;
  }

  /**
   * When the last start, attach or relaunch of this pane finished, or 0 when
   * none has run in this process. The exited-agent sweep keeps an exit that
   * lands within `CLEAN_EXIT_MIN_PANE_LIFETIME_MS` of it, since that reads as a
   * CLI failing at startup rather than a user ending it. An attach to a pane
   * that was already running stamps it too, which only costs a user who
   * `/exit`s within seconds of a server restart a row to close by hand.
   */
  get paneStartedAt(): number {
    return this._paneStartedAt;
  }

  /**
   * Mark this session as being closed, or clear the mark after a close that
   * failed. While it is set, {@link startInteractive} and {@link startShell}
   * refuse to run. A start that raced a close would otherwise launch a CLI in a
   * tmux session whose record is about to be deleted (Ark0N/Codeman#446).
   */
  markClosing(closing: boolean): void {
    this._closing = closing;
  }

  /** Run one pane start, attach or relaunch with {@link paneLifecycleInFlight} raised. */
  private async _withPaneLifecycle<T>(op: () => Promise<T>): Promise<T> {
    this._paneLifecycleOps++;
    try {
      return await op();
    } finally {
      this._paneLifecycleOps--;
      this._paneStartedAt = Date.now();
    }
  }

  /**
   * Forget this pane's exit, on both this record and the mux layer's cache.
   * Every path that starts or relaunches a command in the pane calls it, and
   * the mux half also invalidates a pane read already in flight.
   *
   * It does not persist or broadcast by itself; the caller owns both. ⚠ That
   * caller MUST persist, and the pane-exit watcher is not a fallback for it:
   * the watcher's next tick reads UNKNOWN, finds this field already cleared,
   * reports no change and therefore writes nothing, so a caller that only
   * broadcasts leaves `state.json` saying the agent exited for as long as the
   * session stays quiet. `/interactive` and `/shell` did exactly that until
   * Ark0N/Codeman#446 review; both now persist on their success path.
   */
  private clearPaneExitForNewPane(): void {
    this.setPaneExit(undefined);
    if (this._muxSession) this._mux?.clearPaneExit?.(this._muxSession.muxName);
  }

  /**
   * Record what the mux layer observed of this pane's agent, and say whether
   * that changed the answer. The caller persists and broadcasts on a true.
   *
   * A session the field does not apply to is forced to UNKNOWN here rather than
   * at the reporting end, so the rule lives in one place and the mux layer stays
   * free to report the raw pane reading its own remote-reconnect watcher needs.
   */
  setPaneExit(next: PaneExit | undefined): boolean {
    const resolved = this.paneExitApplies ? (next ?? null) : null;
    const prev = this._paneExit;
    if (prev === resolved) return false;
    if (
      prev !== null &&
      resolved !== null &&
      prev.status === resolved.status &&
      prev.signal === resolved.signal &&
      prev.at === resolved.at
    ) {
      return false;
    }
    this._paneExit = resolved;
    return true;
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

  /** Agent activity or uncertainty must not be mistaken for autonomous availability. */
  get blocksIdleAutomation(): boolean {
    return (
      this._activityProjection.activityStatus === 'waiting_agents' ||
      this._activityProjection.activityStatus === 'checking_agents'
    );
  }

  /** Raw idle plus a fail-safe server activity projection. */
  isAutonomouslyIdle(): boolean {
    return this.isIdle() && !this.blocksIdleAutomation;
  }

  /** Current server-derived activity. This projection is never persisted by toState(). */
  get activityProjection(): SessionActivityProjection {
    return { ...this._activityProjection };
  }

  /** Monotonic invalidation token for decisions based on terminal quiescence. */
  get terminalActivityEpoch(): number {
    return this._terminalActivityEpoch;
  }

  setActivityProjection(projection: SessionActivityProjection, options: { reconstructEpisode?: boolean } = {}): void {
    const isAgentActivity =
      projection.activityStatus === 'waiting_agents' || projection.activityStatus === 'checking_agents';
    const wasAgentActivity =
      this._activityProjection.activityStatus === 'waiting_agents' ||
      this._activityProjection.activityStatus === 'checking_agents';
    this._activityProjection = {
      ...projection,
      activityStatusSince:
        isAgentActivity && wasAgentActivity && !options.reconstructEpisode
          ? this._activityProjection.activityStatusSince
          : isAgentActivity
            ? projection.activityStatusSince
            : null,
    };
  }

  /**
   * What the pane says is still running in the background, e.g. `1 monitor`, or null when
   * nothing is. A session with a label here has ended its turn without wanting anything
   * from the user, so a surface that would otherwise file it under "needs you" can say
   * what it is waiting for instead.
   */
  get watching(): string | null {
    return this._watching;
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
    // WHERE the id goes is registry data (`legacyConfigField` + the `resumeId` alias), so the
    // four-way chain this replaces was a second copy of pairs already declared per entry.
    const slot = legacyResumeSlot(this.mode);
    if (!slot) return; // claude/shell: no <Mode>Config object, so nothing to merge into.
    const current = this._legacyConfigSlot(slot.field);
    if (!current) return;
    const existing = current.read();
    // An explicit caller-supplied resume target always outranks an opportunistically
    // captured one — the `??` the original chain repeated four times.
    if (existing?.[slot.key] !== undefined && existing[slot.key] !== null) return;
    current.write({ ...existing, [slot.key]: this._nativeResumeId });
  }

  /**
   * Read/write access to this session's `<Mode>Config` slots, addressed by the registry's own
   * `legacyConfigField` name.
   *
   * These are eight separately-typed private fields, so something has to map a field NAME to
   * one — but that is a property of this class's storage, not a per-CLI behaviour decision:
   * the registry still chooses which slot and which key. Anything not listed (claude, shell)
   * has no config object and returns undefined.
   */
  private _legacyConfigSlot(
    field: string
  ): { read: () => Record<string, unknown> | undefined; write: (v: Record<string, unknown>) => void } | undefined {
    const slots: Record<string, { read: () => object | undefined; write: (v: never) => void }> = {
      openCodeConfig: { read: () => this._openCodeConfig, write: (v) => (this._openCodeConfig = v) },
      codexConfig: { read: () => this._codexConfig, write: (v) => (this._codexConfig = v) },
      geminiConfig: { read: () => this._geminiConfig, write: (v) => (this._geminiConfig = v) },
      antigravityConfig: { read: () => this._antigravityConfig, write: (v) => (this._antigravityConfig = v) },
      piConfig: { read: () => this._piConfig, write: (v) => (this._piConfig = v) },
      grokConfig: { read: () => this._grokConfig, write: (v) => (this._grokConfig = v) },
      deepSeekConfig: { read: () => this._deepSeekConfig, write: (v) => (this._deepSeekConfig = v) },
      ompConfig: { read: () => this._ompConfig, write: (v) => (this._ompConfig = v) },
    };
    const slot = slots[field];
    if (!slot) return undefined;
    return {
      read: () => slot.read() as Record<string, unknown> | undefined,
      write: (v) => slot.write(v as never),
    };
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

  // Custom Model Endpoint Profiles (docs/custom-model-endpoints-plan.md) — public-safe
  // subset only (never envKeys/configDir/launchModel, the bookkeeping for setCustomModel).
  get customModel(): CustomModelSelection | undefined {
    if (!this._customModel) return undefined;
    const { endpointId, modelId, label } = this._customModel;
    return { endpointId, modelId, label };
  }

  /**
   * The full selection incl. bookkeeping, for state.json ONLY (`__customModel`, the
   * same disk-only convention as `getEnvOverridesForPersist()`). Carries no env values,
   * so nothing secret lands on disk; recovery re-derives them from the endpoint store.
   * Without this a Codeman restart left the pane on the custom endpoint (tmux keeps
   * its `setenv`s) while `customModel` came back undefined, so the state was wrong and
   * clearing had nothing to unset. Must NOT be included in any API-bound serializer.
   */
  getCustomModelForPersist(): CustomModelBookkeeping | undefined {
    return this._customModel ? { ...this._customModel, envKeys: [...this._customModel.envKeys] } : undefined;
  }

  /**
   * Update this session's custom-model selection and merge the endpoint's injected env
   * vars into `_envOverrides` — first UNDOING whatever the previous selection injected
   * (removing exactly those env keys), so switching endpoints, or clearing back to the
   * harness's native cloud default, never leaves a stale key behind. Synchronous and
   * side-effect-free beyond mutating state, matching `setNice`/`setColor` above — this
   * class does no file IO, so it reports the PREVIOUS `configDir` (if any) for the
   * caller to clean up on disk (custom-model-injection.ts's configDir kind).
   *
   * Keys the previous selection injected that the new one does not re-set are queued
   * for `tmux setenv -u` on the next respawn (`_pendingEnvUnsets`, threaded through
   * `_buildRespawnPaneOptions().unsetEnvKeys`): the tmux session inherits every
   * `setenv` into `respawn-pane`, so dropping them from the map alone would relaunch
   * the CLI still pointed at the old endpoint — and for the `configDir` kinds, at a
   * `HOME`/`CODEX_HOME`/`GROK_HOME` the caller has just deleted.
   */
  setCustomModel(
    next: CustomModelBookkeeping | undefined,
    envOverrides?: Record<string, string>
  ): { removedEnvKeys: string[]; previousConfigDir: string | undefined } {
    const previousConfigDir = this._customModel?.configDir;
    const removedEnvKeys: string[] = [];
    if (this._customModel) {
      for (const key of this._customModel.envKeys) {
        if (this._envOverrides) delete this._envOverrides[key];
        removedEnvKeys.push(key);
        this._pendingEnvUnsets.add(key);
      }
    }
    this._customModel = next ? { ...next, envKeys: [...next.envKeys] } : undefined;
    if (envOverrides && Object.keys(envOverrides).length > 0) {
      this._envOverrides = { ...(this._envOverrides ?? {}), ...envOverrides };
      // A key the new selection sets again does not need an unset (applyEnvOverrides
      // would set it right back anyway); keep the list to what actually goes away.
      for (const key of Object.keys(envOverrides)) this._pendingEnvUnsets.delete(key);
    }
    return { removedEnvKeys, previousConfigDir };
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

  /** An explicit rename: the name is the user's from here on and auto-naming never touches it. */
  set name(value: string) {
    this._name = value;
    this._nameSource = 'manual';
  }

  /**
   * Names the tab after its first prompt. Only a placeholder is eligible, and
   * the session stops being one whether or not the string changed: "first
   * prompt" means the first, not "every prompt until a rename". Returns
   * whether the name changed, so the caller knows whether to persist and
   * broadcast.
   */
  applyAutoName(value: string): boolean {
    if (this._nameSource !== 'placeholder') return false;
    const name = value.trim();
    if (!name) return false;
    this._nameSource = 'auto';
    if (this._name === name) return false;
    this._name = name;
    return true;
  }

  get nameSource(): SessionNameSource {
    return this._nameSource;
  }

  /**
   * The name to pin on the Claude CLI as `--name`, or undefined to let Claude
   * title the conversation itself. `--name` is the prompt-box label, the
   * `/resume` picker entry and the terminal title all at once, and a pinned
   * title stops Claude generating its own, so only a name the user chose is
   * worth pinning. Pinning the `w1-myapp` placeholder gave every conversation
   * in a case the same `/resume` entry; an auto name is a cut of the first
   * prompt, which Claude's own generated title already beats.
   */
  get cliPinnedName(): string | undefined {
    return this._nameSource === 'manual' ? this._name : undefined;
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

  /** Whether an agent-initiated checkpoint handoff is currently active. */
  get isCheckpointActive(): boolean {
    return this._autoOps.isCheckpointActive;
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
    // COD-416: which glyph means "ready" and which frame means "working" is registry DATA
    // (`capabilities.checkpoint`), read once here. ABSENT is meaningful — see the type.
    const checkpointGrammar = getCli(this.mode)?.capabilities.checkpoint;
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
      const renderedWorking = checkpointGrammar ? detectCheckpointWorkingFrame(checkpointGrammar, plain) : false;
      working = working || renderedWorking;
      const promptVisible = checkpointGrammar
        ? checkpointPromptPattern(checkpointGrammar.promptGlyph).test(plain)
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
    } else if (checkpointGrammar?.directPtyPromptTransition) {
      // Direct-PTY fallback uses the existing positively recorded prompt
      // transition; initial `idle` alone is not sufficient evidence.
      ready = this._lastPromptTime > 0 && this._status === 'idle' && !working;
    } else if (!checkpointGrammar) {
      // Preserve legacy behavior for modes without verified prompt syntax. ⚠️ A CLI that
      // DECLARES a grammar but has no frame lands in neither arm and stays not-ready, which
      // is the point: it has a prompt we know how to see, and we did not see it.
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

  /**
   * Restore a pin from a persisted record, keeping the moment it was pinned.
   *
   * `setPinned()` stamps `pinnedAt` with now, which is right for a user pinning a
   * session and wrong for a restore: the session-manager orders its pinned group
   * by that stamp, so a restored session would jump to the front of a list it had
   * been sitting further down.
   */
  restorePin(pinned: boolean, pinnedAt?: number): void {
    this._pinned = pinned;
    this._pinnedAt = pinned ? (pinnedAt ?? Date.now()) : null;
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

  /** Only trusted launch/restoration code supplies this snapshot; never derived from live cwd. */
  setNotesLaunchCase(info: import('./types/api.js').CaseInfo): void {
    if (!this._notesLaunchCase) this._notesLaunchCase = structuredClone(info);
  }

  toState(): SessionState {
    return {
      id: this.id,
      pid: this.pid,
      status: this._status,
      workingDir: this.workingDir,
      cwd: this._cwd,
      remote: this._remote,
      docker: this._docker,
      owner: this._owner,
      parentSessionId: this._parentSessionId,
      notesLaunchCase: this._notesLaunchCase ? structuredClone(this._notesLaunchCase) : undefined,
      currentTaskId: this._currentTaskId,
      createdAt: this.createdAt,
      // The wire twin, not the private stamp: it survives the post-recovery
      // attach repaint, so the home screens' quiet ordering survives a restart.
      lastActivityAt: this._wireActivityAt,
      name: this._name,
      nameSource: this._nameSource,
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
      cliMouseTracking: this._cliMouseTracking || undefined,
      cliVersion: this._cliVersion || undefined,
      cliModel: this._cliModel || undefined,
      cliAccountType: this._cliAccountType || undefined,
      cliLatestVersion: this._cliLatestVersion || undefined,
      openCodeConfig: this._openCodeConfig,
      codexConfig: this._codexConfig
        ? (({ baseCommand: _baseCommand, ...publicCodexConfig }) => publicCodexConfig)(this._codexConfig)
        : undefined,
      geminiConfig: this._geminiConfig,
      antigravityConfig: this._antigravityConfig,
      piConfig: this._piConfig,
      grokConfig: this._grokConfig,
      deepSeekConfig: this._deepSeekConfig,
      ompConfig: this._ompConfig,
      resumeSessionId: this._resumeSessionId,
      nativeResumeId: this._nativeResumeId,
      effort: this._effort,
      customModel: this.customModel,
      // COD-118: runtime-only — surfaced so the frontend can require explicit user
      // intent before restarting a crash-looped session. Deliberately NOT restored
      // by the constructor: a Codeman restart starts with a fresh breaker so boot
      // recovery can re-attach.
      respawnBlocked: this._respawnBlocked || undefined,
      // Ark0N/Codeman#446 — the agent in this pane has exited, published here so
      // it rides the existing `session:updated` broadcast and lands in state.json
      // through the same persist. `status` and `pid` above stay untouched by it.
      paneExit: this._paneExit ?? undefined,
      attachmentHistory: this.attachmentHistory.length > 0 ? this.attachmentHistory : undefined,
      sources: this.getSourcesForPersist(),
      lastSubmitAt: this._lastSubmitAt || undefined,
      // Only a chain the CLI's own hooks vouched for is persisted, and only when
      // the pane actually moved conversation. Its LAST entry is the live one, so
      // it is also what restores `claudeSessionId` across a restart — `start()`
      // resets that field to the launch id at three separate points, which is
      // why a recovered pane otherwise shows its pre-/clear transcript forever.
      claudeSessionChain: this._claudeSessionChain.length > 0 ? [...this._claudeSessionChain] : undefined,
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

  /**
   * Server-only resolved Codex launch command for disk persistence. Never
   * include this in SessionState serializers or API responses; it can carry
   * an arbitrary owner-authored command line.
   */
  getResolvedCodexCommandForPersist(): string | undefined {
    if (this.mode !== 'codex') return undefined;
    const command = this._codexConfig?.baseCommand?.trim();
    return command ? command : undefined;
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
      watching: this._watching,
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
  }): Promise<{ isRestored: boolean; respawnedResumeId?: string; respawnedDeadPane: boolean }> {
    return this._withPaneLifecycle(() => this._doSetupOrAttachMuxSession(options));
  }

  private async _doSetupOrAttachMuxSession(options: {
    respawnPaneOptions: import('./mux-interface.js').RespawnPaneOptions;
    createSessionOptions: import('./mux-interface.js').CreateSessionOptions;
    spawnErrLabel: string;
  }): Promise<{ isRestored: boolean; respawnedResumeId?: string; respawnedDeadPane: boolean }> {
    const mux = this._mux!;

    // Verify stale mux session — tmux may have been destroyed (e.g., killed externally).
    // A session that HAD a mux session relaunches its CLI below just like a failed
    // respawn does (tmux kill-server, a tmux crash, an external kill-session), so
    // its transcript collides with the bare `--session-id` the same way. A
    // genuinely new session starts with `_muxSession` null and never sets this.
    let muxSessionVanished = false;
    if (this._muxSession && !mux.muxSessionExists(this._muxSession.muxName)) {
      console.log('[Session] Stale mux session detected (tmux gone):', this._muxSession.muxName);
      this._muxSession = null;
      muxSessionVanished = true;
    }

    // Check if session exists but pane is dead (remain-on-exit keeps it alive)
    // Respawn the pane instead of creating a whole new session — preserves tmux scrollback
    let needsNewSession = false;
    let respawnedDeadPane = false;
    let respawnedResumeId: string | undefined;
    if (this._muxSession && (await mux.isPaneDead(this._muxSession.muxName))) {
      console.log('[Session] Dead pane detected, respawning:', this._muxSession.muxName);
      // Confirmed dead — safe to resolve/pin now (see `_pinOmpRespawnId()`).
      // `options.respawnPaneOptions` was built eagerly before this dead-pane
      // check ran, so it still carries the pre-pin ompConfig; rebuild it.
      this._pinOmpRespawnId();
      const respawnOptions = await this._buildRespawnPaneOptionsWithResumePin();
      const newPid = await mux.respawnPane(respawnOptions);
      if (!newPid) {
        console.error('[Session] Failed to respawn pane, will create new session');
        needsNewSession = true;
      } else {
        respawnedDeadPane = true;
        respawnedResumeId = respawnOptions.resumeSessionId;
        this._pendingEnvUnsets.clear();
        // Wait a moment for the respawned process to fully start
        await new Promise((resolve) => setTimeout(resolve, MUX_STARTUP_DELAY_MS));
      }
    }

    // Whatever the last reading said about the OLD command in this pane is now
    // history: the branch above either respawned the pane or found it alive, and
    // the branch below creates a new one. The paths that reach here are boot
    // recovery and an explicit start, NOT a click on an exited tab — the browser
    // re-attaches only on a null pid, and the premise of Ark0N/Codeman#446 is
    // that an exited pane keeps its pid. `restartCli()` clears separately.
    this.clearPaneExitForNewPane();

    // Check if we already have a mux session (restored session)
    const isRestored = this._muxSession !== null && !needsNewSession;
    if (isRestored) {
      console.log('[Session] Attaching to existing mux session:', this._muxSession!.muxName);
    } else {
      // Create a new mux session. When this is the FALLBACK after a failed
      // respawn, the eagerly-built create options still carry the unpinned
      // launch seed, so a session whose transcript exists would meet the same
      // `--session-id ... already in use` refusal the respawn just lost to —
      // the recovery of last resort failing for the very reason it was needed.
      // A genuinely new session has no transcript under any of its candidate
      // ids, so nothing is pinned and its command shape is unchanged.
      //
      // `_resumeSessionId` is written alongside, not just the create options:
      // this branch leaves `isRestored` false, so the block that sets
      // `_claudeSessionId` below reads that field and would otherwise settle on
      // `this.id` while the CLI resumes the chain tail. The response viewer,
      // Read My Mind and the unified-list alias map all read `_claudeSessionId`
      // until the next first-hand hook, so the two have to name the same
      // conversation. The vanished-tmux-session branch above relaunches for the
      // same reason and takes the same pin.
      if (needsNewSession || muxSessionVanished) {
        const pinned = (await this._buildRespawnPaneOptionsWithResumePin()).resumeSessionId;
        if (pinned) {
          options.createSessionOptions.resumeSessionId = pinned;
          this._resumeSessionId = pinned;
        }
      }
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
      this._notePtySpawnGeometry(ptyCols, ptyRows);
    } catch (spawnErr) {
      console.error(`[Session] Failed to spawn PTY for ${options.spawnErrLabel}:`, spawnErr);
      this.emit('error', `Failed to attach to mux session: ${spawnErr}`);
      throw spawnErr;
    }

    return { isRestored, respawnedResumeId, respawnedDeadPane };
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

    this._stopWorkingFramePoller();
    // Confirmed the mux session (and thus the pane) exists but this reattach
    // is about to respawn it — safe to resolve/pin now.
    this._pinOmpRespawnId();
    const newPid = await mux.respawnPane(this._buildRespawnPaneOptions());
    if (!newPid) {
      console.error('[Session] reattachRemote: respawnPane failed for', this._muxSession.muxName);
      return false;
    }
    // No-op for the record (a remote session's field is always UNKNOWN), but the
    // mux layer's cache is keyed by muxName and this pane now runs a new client.
    this.clearPaneExitForNewPane();
    console.log('[Session] reattachRemote: reattached remote session', this._muxSession.muxName, 'pid', newPid);
    if (isExternalCliMode(this.mode)) this._startWorkingFramePoller();
    return true;
  }

  /**
   * Kill and relaunch this session's CLI process IN PLACE — same pane, same tmux
   * session, fresh env/args from current state. Custom Model Endpoint Profiles
   * (docs/custom-model-endpoints-plan.md) is the first caller: after `setCustomModel()` merges new
   * env vars into `_envOverrides`, the running CLI process still has the OLD env
   * (inherited at its own process start, not live-reloaded), so switching a
   * session's model/endpoint requires this restart to actually take effect.
   *
   * A GENERALIZED {@link reattachRemote} with the `!this._remote` guard dropped —
   * `_buildRespawnPaneOptions()` already passes `remote: this._remote` through
   * unconditionally, so `mux.respawnPane()` builds the right command either way
   * (a local session gets `respawn-pane -k` + the real launch line, which is the
   * kill-and-relaunch this method exists for; a remote session gets the existing
   * reattach-to-durable-tmux behavior). Deliberately does NOT check `isBusy()` —
   * that's the caller's job (mirrors `/interactive`'s guard), since a raw restart
   * primitive shouldn't itself decide when it's safe to use.
   *
   * @returns true if the pane was respawned, false otherwise (no mux session, or
   *   the mux session is gone — see {@link reattachRemote} for that reasoning).
   */
  async restartCli(): Promise<boolean> {
    return this._withPaneLifecycle(() => this._doRestartCli());
  }

  private async _doRestartCli(): Promise<boolean> {
    if (!this._useMux || !this._mux || !this._muxSession) return false;
    const mux = this._mux;

    if (!mux.muxSessionExists(this._muxSession.muxName)) {
      console.log('[Session] restartCli: mux session gone, skipping:', this._muxSession.muxName);
      return false;
    }

    this._pinOmpRespawnId();
    const newPid = await mux.respawnPane(await this._buildRespawnPaneOptionsWithResumePin());
    if (!newPid) {
      console.error('[Session] restartCli: respawnPane failed for', this._muxSession.muxName);
      return false;
    }
    this._pendingEnvUnsets.clear();
    // A relaunch in the same pane, so any exit observed of the previous command
    // is history. Without this the caller's persist-and-broadcast writes the old
    // exit straight back onto a session that is running again.
    this.clearPaneExitForNewPane();
    console.log('[Session] restartCli: restarted CLI for', this._muxSession.muxName, 'pid', newPid);
    return true;
  }

  /**
   * Assemble the {@link RespawnPaneOptions} for this session. Single source of
   * truth shared by interactive start, shell start (via their inline copies),
   * {@link reattachRemote}, and {@link restartCli} so no respawn path can drift from
   * the spawn path.
   */
  private _buildRespawnPaneOptions(): import('./mux-interface.js').RespawnPaneOptions {
    const options: import('./mux-interface.js').RespawnPaneOptions = {
      sessionId: this.id,
      workingDir: this.workingDir,
      mode: this.mode,
      name: this._name,
      cliName: this.cliPinnedName,
      niceConfig: this._niceConfig,
      model: this._model,
      claudeMode: this._claudeMode,
      allowedTools: this._allowedTools,
      openCodeConfig: this._openCodeConfig,
      codexConfig: this._codexConfig,
      geminiConfig: this._geminiConfig,
      antigravityConfig: this._antigravityConfig,
      piConfig: this._piConfig,
      grokConfig: this._grokConfig,
      deepSeekConfig: this._deepSeekConfig,
      // OMP resolution/pinning does NOT happen here. This object is built
      // EAGERLY — including on every boot-recovery reattach, before anyone
      // knows whether the pane is actually dead — so resolving here mutated
      // `_ompConfig`/`_claudeSessionId` even for a pane that was simply being
      // reattached to, not respawned; with two omp tabs in the same case dir
      // that mis-pinned the ALIVE session onto whichever file happened to be
      // newest on disk (reported live in the Ark0N/Codeman#353 review). The
      // real pin now happens in `_pinOmpRespawnId()`, called by callers ONLY
      // once they've confirmed an actual respawn is about to happen.
      ompConfig: this._ompConfig,
      resumeSessionId: this._resumeSessionId,
      envOverrides: this._envOverrides,
      unsetEnvKeys: this._pendingEnvUnsets.size > 0 ? [...this._pendingEnvUnsets] : undefined,
      effort: this._effort,
      truecolorEnabled: this._truecolorEnabled,
      historyLimit: this._tmuxHistoryLimit,
      remote: this._remote,
      docker: this._docker,
      owner: this._owner,
    };
    return this._withCustomModelLaunchModel(options);
  }

  /**
   * Respawn options for a pane whose command is being REPLACED, with the
   * conversation pinned so the relaunch resumes rather than collides.
   *
   * A CLI that launches with `--session-id <id>` refuses an id that is already
   * in use (claude: `Error: Session ID ... is already in use.`), and every
   * session whose agent has been prompted owns a transcript under that id. So
   * relaunching such a pane with the bare launch line fails, the pane dies
   * again immediately, and the user's conversation is stranded. A launch that
   * declares a `fallback` chain renders `resume || new` once a resume id is
   * set, which is the shape that survives both cases.
   *
   * Three candidates are tried in priority order — the conversation chain's
   * tail, the launch seed, then the session's own id — and the first one a
   * transcript backs is pinned. Four conditions gate that walk, each protecting
   * against a way of resuming the WRONG conversation or of making a working
   * relaunch fail.
   *
   * ⚠️ **A remote or docker session is never pinned.** Unlike `restartCli()`,
   * whose route refuses both, the dead-pane respawn is reached by every session
   * shape. Their pane commands (`buildRemoteLaunchCommand`,
   * `claudeDockerPaneCommand`) already render a SELF-HEALING
   * `--session-id <sid> || --resume <sid>`, and both flip to resume-first the
   * moment the resume id differs from the session id. The conversation lives on
   * the far side, so a local id pinned onto it resolves to nothing there, the
   * resume fails, and the `--session-id` fallback then collides with the
   * transcript the far side really does hold — both branches fail and the pane
   * dies. `_pinOmpRespawnId()` refuses remote for the same reason.
   *
   * ⚠️ **The candidates come from the conversation CHAIN, never from
   * `_claudeSessionId`.** That field holds either a first-hand id from the
   * CLI's own hook payload or a history correlation, which is a guess keyed on
   * the working directory. `_recordClaudeSessionInChain()` refuses a guess
   * precisely so it cannot "write a foreign conversation into this pane's
   * permanent record", and launching from one would do worse than the display
   * bug that rule exists to prevent: the relaunched CLI would open and WRITE to
   * a conversation that was never this pane's. The chain's tail is the live
   * conversation and is hook-vouched, so it leads the walk, ahead of the launch
   * seed, which is written once at construction and never moves off a `/clear`.
   *
   * ⚠️ **Every candidate must be backed by a transcript, the session's own id
   * included, and a candidate that has none is passed over rather than ending
   * the walk.** A pin that differs from the session id leaves
   * `--session-id <this.id>` in the fallback branch, so a resume that finds
   * nothing collides there and the pane dies exactly as it did before this
   * pinning existed. Pinning `this.id` renders the self-healing
   * `--resume <id> || --session-id <id>`, which is correct whether or not a
   * transcript exists, but a pane that has none pays for the shape twice:
   * claude prints "No conversation found" into the scrollback of a session that
   * is brand new, and `wrapWithNice()` prefixes only the FIRST branch of the
   * rendered `a || b`, so the branch that actually runs loses its priority for
   * the life of the session. Falling off the end of the walk therefore adds
   * no pin (the options keep any launch seed they already carried), which is
   * the right answer: with no transcript anywhere there is nothing for the
   * bare `--session-id <this.id>` to collide with.
   *
   * The create route pre-validates a resume id for the same reason, though it
   * additionally requires the transcript be substantial — here mere existence
   * is the question, because a one-line transcript still makes `--session-id`
   * collide.
   *
   * The registry shape is the last gate, not the CLI's name: an entry whose
   * resume id is minted by the CLI itself (codex/pi/omp/grok) declares no
   * `fallback` chain and reads its resume field from its own `<Mode>Config`.
   *
   * `reattachRemote()` deliberately does NOT call this. It re-runs the remote
   * session command, which attaches to the durable remote tmux with the agent
   * still inside it and renders no local `--session-id` to collide.
   */
  private async _buildRespawnPaneOptionsWithResumePin(): Promise<import('./mux-interface.js').RespawnPaneOptions> {
    const options = this._buildRespawnPaneOptions();
    if (this._remote || this._docker) return options;
    const entry = getCli(this.mode);
    if (entry?.launch.chain !== 'fallback') return options;

    const resumeIdPattern = entry.launch.params?.resumeId;
    const configDir = this._claudeConfigDir();
    const chainTail = this._claudeSessionChain[this._claudeSessionChain.length - 1];
    const candidates = [chainTail, options.resumeSessionId, this.id].filter((v): v is string => !!v);
    for (const candidate of candidates) {
      // A session Codeman DISCOVERED on the socket rather than created carries a
      // synthetic `restored-<fragment>` id, which fails claude's `uuid` token
      // pattern. The renderer would silently drop the resume flag and emit the
      // unpinned command, so say so here rather than letting the caller believe
      // the pane was pinned.
      if (resumeIdPattern?.type === 'token' && !matchesPattern(resumeIdPattern.pattern, candidate)) {
        console.log(`[Session] Not pinning resume id ${candidate} for relaunch: the CLI cannot accept that id shape`);
        continue;
      }
      if (!(await claudeTranscriptExists(candidate, configDir))) continue;
      options.resumeSessionId = candidate;
      return options;
    }
    // Nothing on disk to collide with, so the bare `--session-id <this.id>` the
    // unpinned options already carry is the correct command.
    return options;
  }

  /** The session's Claude config dir when it has been relocated (#255), else undefined. */
  private _claudeConfigDir(): string | undefined {
    // Trimmed like `claudeProjectsDir()` trims the process-wide override: the
    // envOverrides schema validates keys only, and a whitespace-only value would
    // otherwise resolve to a relative path and read "no transcript" for everything.
    return this._envOverrides?.CLAUDE_CONFIG_DIR?.trim() || undefined;
  }

  /**
   * Force the custom-model selection's `launchModel` (pi/omp `custom/<id>`, grok's
   * `[model.<name>]` block name) onto the CLI's `model` launch param. Where that param
   * lives is registry DATA — the entry's `legacyConfigField` (`piConfig`, `grokConfig`,
   * ...) or the top-level `model` for an entry that declares none — so this stays a
   * generic reader rather than a branch per CLI. Applied on the OPTIONS only: the stored
   * `<Mode>Config` keeps whatever model the user chose at create, which is exactly what a
   * later clear must fall back to.
   */
  private _withCustomModelLaunchModel(
    options: import('./mux-interface.js').RespawnPaneOptions
  ): import('./mux-interface.js').RespawnPaneOptions {
    const launchModel = this._customModel?.launchModel;
    if (!launchModel) return options;
    const entry = getCli(this.mode);
    if (!entry) return options;
    const field = entry.launch.legacyConfigField;
    if (!field) return { ...options, model: launchModel };
    const bag = options as unknown as Record<string, unknown>;
    const existing = (bag[field] ?? {}) as Record<string, unknown>;
    return { ...options, [field]: { ...existing, model: launchModel } };
  }

  /**
   * OMP-only: resolve and PIN the exact conversation to continue when
   * respawning a dead pane, so every later respawn reuses the same id
   * instead of re-resolving (and re-risking picking up a DIFFERENT
   * conversation that happened to touch this directory more recently). See
   * the comment at the call site in {@link _buildRespawnPaneOptions} for why
   * "newest file on disk" is safe here specifically. Non-omp modes and a
   * session that already carries an explicit id pass through untouched.
   */
  private _pinOmpRespawnId(): void {
    // The omp-jsonl transcript reader is what this pin exists to feed, so ask for the
    // reader rather than for the CLI's name.
    if (getCli(this.mode)?.capabilities.transcript !== 'omp-jsonl') return;
    if (this._ompConfig?.resumeSessionId) return;
    // Callers MUST call this only immediately before an ACTUAL respawn (a
    // confirmed-dead pane, or a genuine remote reattach) — never while merely
    // building options that might not lead to a respawn. A fresh "Run OMP"
    // click has no _muxSession yet and must never inherit whatever omp
    // conversation happens to be newest on disk for this working directory
    // (reported live 2026-08-27, fixed in 13a19f79); this guard keeps that
    // fix intact now that resolution has moved out of the eager options build.
    if (!this._muxSession) return;
    // `resolveAndClaimOmpSessionId` scans THIS HOST's `~/.omp/agent/sessions/`, which is
    // meaningless for a remote session — the conversation and its session file live on the
    // remote host, under the REMOTE user's home. Worse than a no-op: `this.workingDir` for a
    // remote session is the remote path (e.g. `/home/user/dotfiles`), so if the local machine
    // happens to have its own omp history under a directory that mangles to the same name,
    // this would silently claim and pin a COMPLETELY UNRELATED local session's id onto a
    // remote respawn. Skip straight to the CLI's own `--continue` fallback, which the remote
    // pane command already renders (see buildRemoteLaunchCommand's omp branch) — safe there
    // because each remote respawn talks to exactly one remote pane's own omp history.
    if (this._remote) {
      this._ompConfig = { ...this._ompConfig, continueSession: true };
      return;
    }
    const resolvedId = resolveAndClaimOmpSessionId(this.workingDir);
    if (resolvedId) {
      this._ompConfig = { ...this._ompConfig, resumeSessionId: resolvedId };
      // Alias omp's own session uuid to this Codeman id — see the
      // constructor's claudeSessionId comment for why this field is the
      // (generically-named) mechanism that folds a Past-Sessions row back
      // into its live/persisted session instead of duplicating it.
      this._claudeSessionId = resolvedId;
      return;
    }
    // Nothing unclaimed on disk (the dying process never got far enough to
    // write a session file, or a sibling already claimed the only candidate)
    // — fall back to the CLI's own "most recent" heuristic.
    console.warn(
      `[Session] OMP: no session file found under ${this.workingDir} to pin --resume on respawn; falling back to ambiguous --continue`
    );
    this._ompConfig = { ...this._ompConfig, continueSession: true };
  }

  /**
   * Remember whether the CLI currently wants to be told about mouse clicks.
   *
   * The strip in {@link _handleTerminalOutput} is the ONLY place these sequences
   * exist. After it, neither the browser nor xterm can ever learn that the CLI
   * asked for mouse tracking, so `terminal.modes.mouseTrackingMode` is
   * permanently 'none' for a stripped mode. The browser hand-encodes SGR reports
   * to compensate (`_sendSyntheticSgrTap` in terminal-ui.js), and with no state
   * to consult it had to do that on EVERY click, delivering mouse reports to a
   * CLI that never asked for them. Publishing this through `toState()` is what
   * lets the browser report a click only when the CLI is listening.
   *
   * Only the TRACKING modes count. 1005/1006 select an encoding and 1007 is
   * alt-scroll; a CLI that picks SGR encoding without turning a tracking mode on
   * is not asking about clicks, and counting those would put the stray reports
   * straight back.
   *
   * This must stay in lockstep with the strip regex that calls it: a sequence
   * removed from the stream but not recorded here is one the browser can neither
   * see nor be told about.
   */
  private _recordStrippedMouseMode(seq: string): void {
    // eslint-disable-next-line no-control-regex
    const match = /\x1b\[\?(\d+)([hl])$/.exec(seq);
    if (!match) return;
    const mode = Number(match[1]);
    if (mode !== 1000 && mode !== 1001 && mode !== 1002 && mode !== 1003) return;
    if (match[2] === 'h') this._cliMouseModes.add(mode);
    else this._cliMouseModes.delete(mode);
    this._syncCliMouseTracking();
  }

  /** Emit only on a real transition: a TUI re-emitting its enable on every repaint costs nothing. */
  private _syncCliMouseTracking(): void {
    const active = this._cliMouseModes.size > 0;
    if (active === this._cliMouseTracking) return;
    this._cliMouseTracking = active;
    this.emit('mouseTrackingChanged', active);
  }

  private _handleTerminalOutput(data: string, recordTrace?: SessionMobileInputTraceRecorder): void {
    recordTrace?.('server.output.handler-enter', data);
    // Invalidate idle decisions for every raw PTY chunk, including bytes held
    // back by the sanitizer while it waits for the rest of an incomplete CSI.
    this._terminalActivityEpoch++;
    this.emit('terminalActivity');
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
          .replace(/\x1b\[\?(?:1000|1001|1002|1003|1005|1006|1007)[hl]/g, (seq) => {
            this._recordStrippedMouseMode(seq);
            return '';
          });
      }
    }

    // Scan terminal output for attachment requests. `codeman://attach?...` is an
    // explicit magic link (all modes); Codex generated images report
    // `Saved to: file://...` — that scanner (and its relaxed trust policy) is
    // only enabled for codex-mode sessions. The web server applies the trust
    // boundary for each request source.
    // Codex is the only CLI that announces generated artifacts in its pane output, and it
    // is also the only one whose transcript is a rollout file — one implies the other.
    const attachmentRequests = parseTerminalAttachmentRequests(data, {
      codexArtifacts: getCli(this.mode)?.capabilities.transcript === 'codex-rollout',
    });
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
    this._markActivity();
    recordTrace?.('server.output.terminal-emitted', data);
    this.emit('terminal', data);
    this.emit('output', data);
  }

  private _recordMobileInputOutputTrace(
    trace: MobileInputTraceCollector,
    stage: MobileInputTraceStage,
    data: string
  ): void {
    try {
      trace.record({
        stage,
        ...mobileInputTraceTimestamp(),
        sessionHash: hashMobileInputTraceValue(this.id),
        ordinal: ++this._mobileInputTraceOrdinal,
        bytes: Buffer.byteLength(data),
        valueHash: hashMobileInputTraceValue(data),
      });
    } catch {
      // Trace observation is test-only and must never affect terminal output.
    }
  }

  async startInteractive(): Promise<void> {
    const traceRegistration = currentSessionMobileInputTraceRegistration();
    if (this.ptyProcess) {
      throw new Error('Session already has a running process');
    }
    if (this._closing) {
      throw new Error('Session is being closed');
    }

    // Viewer ownership is valid only for a fully initialized interactive PTY.
    // Keep it suspended across every attach/spawn/fallback failure path and
    // resume only after the new PTY has all synchronous listeners installed.
    this._suspendTerminalViewerSizing();

    // Bounds the workspace-trust scan (see _maybeAcceptTrustDialog). Stamped here
    // rather than at PTY spawn so a slow mux attach still counts as startup.
    this._interactiveStartedAt = Date.now();
    this._trustDialogAttempts = 0;
    this._lastTrustDialogScanAt = 0;
    if (this._trustDialogTimer) {
      clearTimeout(this._trustDialogTimer);
      this._trustDialogTimer = null;
    }

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
    if (cliNeedsVersionProbe(this.mode) && !this._remote && !this._docker && !this._cliVersion) {
      const probedVersion = resolveSessionCliVersion(this.mode);
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
    if (cliNeedsVersionProbe(this.mode) && this._docker && !this._cliVersion) {
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
    if (cliNeedsVersionProbe(this.mode) && this._remote && !this._cliVersion) {
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

    // ⚠️ Hoisted, because the "third reset point" below runs unconditionally
    // AFTER the mux branch and would otherwise stomp the restored conversation
    // straight back to the launch id.
    let restoredConversation: string | undefined;

    // If mux wrapping is enabled, create or attach to a mux session
    if (this._useMux && this._mux) {
      try {
        const { isRestored, respawnedResumeId, respawnedDeadPane } = await this._setupOrAttachMuxSession({
          // Single source of truth shared with reattachRemote() (COD-108).
          respawnPaneOptions: this._buildRespawnPaneOptions(),
          createSessionOptions: {
            sessionId: this.id,
            workingDir: this.workingDir,
            mode: this.mode,
            name: this._name,
            cliName: this.cliPinnedName,
            niceConfig: this._niceConfig,
            model: this._model,
            claudeMode: this._claudeMode,
            allowedTools: this._allowedTools,
            openCodeConfig: this._openCodeConfig,
            // The mux create path needs the same resolved command as respawn.
            // API/state serializers strip this private field separately.
            codexConfig: this._codexConfig,
            geminiConfig: this._geminiConfig,
            antigravityConfig: this._antigravityConfig,
            piConfig: this._piConfig,
            grokConfig: this._grokConfig,
            deepSeekConfig: this._deepSeekConfig,
            ompConfig: this._ompConfig,
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

        // Set claudeSessionId — when resuming, the Claude conversation ID is the
        // resumed one. `_pinOmpRespawnId()` (called just above, inside
        // `_setupOrAttachMuxSession()`'s dead-pane branch) may have JUST aliased
        // this to omp's own session uuid — that already-resolved id must win
        // over the generic `this.id` fallback, or this line clobbers it back
        // to the Codeman id
        // on every single respawn. codex needs the same fallback for the same
        // reason: its thread id lives in `_codexConfig`, so without it every
        // respawn drops a resumed codex session's alias and its Past-Sessions
        // row springs back as a duplicate that still resumes.
        // ⚠️ A RESTORED mux session is the one case where the launch id is a
        // lie: the CLI never stopped, so a `/clear` before the Codeman restart
        // already moved it to a conversation `this.id` knows nothing about. The
        // persisted chain's tail is that conversation, reported first-hand by
        // the CLI's own hook, so it outranks every fallback here. A NEW pane has
        // an empty chain and falls through to the resume/alias fallbacks.
        //
        // A dead-pane respawn is NOT that case for a CLI whose relaunch the resume
        // pin walk governs (`launch.chain === 'fallback'`): the CLI did stop, and
        // the walk may have passed over a chain tail with no transcript behind it,
        // so the conversation is whatever the respawn actually resumed. Undefined
        // there means the pane launched unpinned, which the fallbacks below name.
        const pinGovernsRespawn = respawnedDeadPane && getCli(this.mode)?.launch.chain === 'fallback';
        restoredConversation = pinGovernsRespawn
          ? respawnedResumeId
          : isRestored
            ? this._claudeSessionChain[this._claudeSessionChain.length - 1]
            : undefined;
        this._claudeSessionId =
          restoredConversation ||
          this._resumeSessionId ||
          this._ompConfig?.resumeSessionId ||
          this._codexConfig?.resumeSessionId ||
          this.id;

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
      // Every external CLI requires tmux and has NO direct-PTY fallback, because its
      // secrets are injected with socket-scoped `tmux setenv` and so must never touch a
      // spawn command line. DeepSeek additionally needs it for the HERDR_* status-bridge
      // triple, without which the mode silently loses its definitive idle/blocked signals.
      //
      // Refusing is the only safe answer: falling back to a direct PTY would start the CLI
      // unauthenticated (or, worse, tempt a future change into passing the key as an
      // argument, where every process on the box can read it).
      if (getCli(this.mode)?.capabilities.requiresMux) {
        throw new Error(`${getModeLabel(this.mode)} sessions require tmux. Direct PTY fallback is not supported.`);
      }
      try {
        // Pass --session-id to use the SAME ID as the Codeman session
        // This ensures subagents can be directly matched to the correct tab.
        // No plan-usage statusLine exporter on this path: the ephemeral
        // `--settings` injection (resolveStatusLineCliCommand, hooks-config.ts)
        // is wired into the tmux spawn builders only, so a direct-PTY session
        // has no Claude telemetry in the header chip. Documented in
        // architecture-invariants (Plan-usage chip); tmux is the supported path.
        const args = buildInteractiveArgs(
          this.id,
          this._claudeMode,
          this._model,
          this._allowedTools,
          this._effort,
          this.cliPinnedName,
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
        this._notePtySpawnGeometry(120, 40);
      } catch (spawnErr) {
        console.error('[Session] Failed to spawn Claude PTY:', spawnErr);
        this._status = 'stopped';
        this.emit('error', `Failed to start Claude: ${spawnErr}`);
        throw new Error(`Failed to spawn Claude process: ${spawnErr}`);
      }
    }

    // Set claudeSessionId — when resuming, the Claude conversation ID is the resumed one.
    // Mirrors the mux branch above and must not clobber it: this line runs
    // unconditionally after both the mux and direct-PTY paths, so it also needs
    // the ompConfig and codexConfig fallbacks or it stomps the mux branch's
    // correctly-resolved OMP/codex alias back to this.id on every mux/plain-
    // reattach boot recovery (the "third reset point" — see DECISIONS.md).
    // For the same reason it needs `restoredConversation`: on a RESTORED mux
    // attach the CLI never stopped and may have `/clear`ed before the restart,
    // so the launch id is a lie and the chain's tail is the live conversation.
    // It is empty on every other path, so those paths keep the alias chain.
    this._claudeSessionId =
      restoredConversation ||
      this._resumeSessionId ||
      this._ompConfig?.resumeSessionId ||
      this._codexConfig?.resumeSessionId ||
      this.id;

    this._pid = this.ptyProcess.pid;
    console.log('[Session] Interactive PTY spawned with PID:', this._pid);

    const boundRecordTrace: SessionMobileInputTraceRecorder | undefined = traceRegistration
      ? (stage, data) => this._recordMobileInputOutputTrace(traceRegistration.trace, stage, data)
      : undefined;
    this.ptyProcess.onData((rawData: string) => {
      const recordTrace = traceRegistration?.active ? boundRecordTrace : undefined;
      recordTrace?.('server.output.pty-received', rawData);
      // Filter out focus escape sequences and Ctrl+L (form feed)
      const data = rawData.replace(FOCUS_ESCAPE_FILTER, '').replace(CTRL_L_PATTERN, ''); // Remove Ctrl+L
      if (!data) return; // Skip if only filtered sequences

      this._handleTerminalOutput(data, recordTrace);

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
      this._suspendTerminalViewerSizing();
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
      this._externalCliIdleGeneration += 1;
      this._stopWorkingFramePoller();
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

    if (this.ptyProcess) {
      this._resumeTerminalViewerSizing();
    }
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

  /** The pane's live working directory, when the sweep has observed one (COD-386). */
  get cwd(): string | undefined {
    return this._cwd;
  }

  /**
   * Record the pane's live cwd. Returns whether it CHANGED, so the caller can
   * broadcast only on a real transition instead of once per sweep tick.
   *
   * A remote/docker session is refused outright rather than filtered upstream:
   * its local pane runs the ssh/docker-exec client, so a cwd read from it names
   * a host directory the agent was never in, and resolving relative paths there
   * would be a new wrong answer in place of the old one.
   */
  setCwd(cwd: string | undefined): boolean {
    const next = this._remote || this._docker ? undefined : cwd?.startsWith('/') ? cwd : undefined;
    if (next === this._cwd) return false;
    this._cwd = next;
    return true;
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
   * ⚠️ **The keystroke is read off the screen, never assumed.** Claude Code
   * 2.1.252 dropped the option numbers, put "No, exit" first, and highlights IT
   * by default, so the bare `\r` this used to send now answers *exit*: a fresh
   * case died (`Pane is dead (status 1)`) about six seconds after spawning.
   * `trustDialogNextKey()` returns one step at a time — an arrow while the
   * cursor is on the wrong option, Enter only once the screen shows it on the
   * trust option — and this method re-reads the pane between the two, so a
   * dropped arrow costs a repaint instead of the session.
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

    // Null means the frame does not say which option is highlighted. Waiting for
    // the next repaint is the safe move; pressing Enter blind is the bug.
    const key = trustDialogNextKey(screen);
    if (key === null) return;

    this._trustDialogAttempts++;
    if (this._trustDialogAttempts > TRUST_DIALOG_MAX_ATTEMPTS) {
      this._trustDialogAccepted = true; // leave it to the user rather than keep typing
      console.warn(`[Session] Workspace trust dialog did not clear after retries: ${this.id}`);
      return;
    }
    const step = key === TRUST_KEY_CONFIRM ? 'confirming' : 'moving to the trust option';
    console.log(
      `[Session] Auto-accepting workspace trust dialog for: ${this.id} (attempt ${this._trustDialogAttempts}, ${step})`
    );
    this.writeViaMux(key);

    // ⚠️ Schedule the next read; do NOT wait for more PTY output. This scan only
    // ever ran from `onData`, which was enough while one Enter answered the
    // dialog. It is not enough now: the arrow that moves the cursor is the LAST
    // output the pane produces, so a dialog left sitting on the trust option
    // never gets its Enter and the worker stays parked on it forever (measured
    // on a live 2.1.252 spawn: cursor moved at 6 s, then nothing). The timer is
    // one-shot and self-rearming through this same path, and every exit route
    // goes through _clearAllTimers().
    // The +100ms puts the re-entry OUTSIDE the scan throttle above; firing at
    // exactly the throttle boundary would let the scan return early and break
    // the chain with the dialog still on screen.
    if (this._trustDialogTimer) clearTimeout(this._trustDialogTimer);
    this._trustDialogTimer = setTimeout(() => {
      this._trustDialogTimer = null;
      this._maybeAcceptTrustDialog();
    }, TRUST_DIALOG_RETRY_MS + 100);
  }

  /**
   * Per-chunk working/idle detection for an interactive pane. Split out of the
   * PTY `onData` handler so it can be unit tested without spawning one.
   *
   * @param data raw PTY chunk, ANSI included
   */
  private _detectInteractiveActivity(data: string): void {
    this._noteDirectPtyCheckpointGeneration(data);
    const workDetect = getCli(this.mode)?.capabilities.workDetect;
    // The composer row carries this glyph when the CLI is waiting for input. It only
    // ARMS the check and is NOT evidence the turn ended: a CLI redraws its composer
    // about once a second all the way through a turn, which is exactly how a working
    // session used to flip to idle two seconds in. _confirmIdle() waits for the pane to
    // actually go quiet before believing it. A CLI that declares no glyph keeps Claude's,
    // which is the glyph every such session has been armed by until now.
    if (data.includes(workDetect?.promptGlyph ?? '❯')) {
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
    else if (SPINNER_PATTERN.test(data)) {
      // For external CLIs the spinner must also re-arm the quiet-window
      // timer — otherwise the session latches busy forever because only
      // _noteExternalWorkingFrame arms the idle timer (observed on
      // idle opencode panes that emit a stray braille char in their
      // Bubble Tea chrome).
      if (isExternalCliMode(this.mode)) this._noteExternalWorkingFrame();
      else this._markWorking();
    }

    // Activity fallback: current Claude Code animates `✻ Actualizing…` instead of a
    // braille spinner, so the fast path above misses entire turns, and matching the
    // new status line does not rescue it either (tmux repaints partially, so the
    // complete line reaches the PTY only every few tens of seconds). An unbroken run
    // of repaints is the signal that survives. See session-activity.ts for the
    // measurement. This needs a pane Codeman can read: without a glyph to arm the idle
    // confirmation, a session latches busy forever. A CLI that declares work detection
    // supplies its own glyph, and the non-external modes keep the run they always had.
    if (workDetect || !isExternalCliMode(this.mode)) {
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
    // A turn that ended by handing off to workers the CLI waits for is work too: the
    // composer is up and the pane is quiet, but the next turn starts without the user.
    this._lastPaneProbeWorking =
      text === null ? null : this._workingLinePattern().test(text) || this._paneAwaitsWorkers(text);
    this._readWatching(text);
    return this._lastPaneProbeWorking;
  }

  /**
   * Read the background-work chip off the same capture the working probe just took.
   *
   * The two questions are different. A turn that is running is work the user is waiting
   * for; a monitor, a backgrounded shell or a cloud session the agent started is work
   * the AGENT is waiting for, and it is the reason a pane can sit at its composer with
   * nothing to say and still not want anything from the user. `_confirmIdle` takes this
   * capture at exactly the moment the turn ends, which is the moment the answer starts
   * mattering.
   *
   * A capture that could not be read CLEARS the label rather than keeping the last one.
   * The two wrong answers are not symmetric: a stale label opens the next idle prompt
   * already acknowledged, so a failed capture would silence a real alert, while a dropped
   * label only costs a card and an alert that the next readable capture takes back.
   * Degrading toward the alert is the rule the whole signal is built on.
   */
  private _readWatching(paneText: string | null): void {
    const pattern = this._watchingLinePattern();
    if (!pattern) return;
    // `null` is "the screen could not be read". That is no evidence either way, so the
    // label falls to null (and the change is announced below like any other).
    const label = paneText === null ? null : watchingLabel(paneText, pattern, this._watchingWindow);
    if (label === this._watching) return;
    this._watching = label;
    // ⚠️ This CHANGES while the session's status does not, so it needs an event of its
    // own. The label is usually set on the idle transition, which broadcasts anyway, but
    // it CLEARS when the work ends — and for a CLI whose background work ends without
    // taking a turn (measured on codex: a background terminal finishing repaints the row
    // away and nothing else happens) the session is idle before and after. Without this,
    // the server knew the badge was gone and every open page went on drawing it until
    // some unrelated event arrived.
    this.emit('watchingChanged');
  }

  /**
   * The regex matching this CLI's background-work chip, or null for a CLI whose registry
   * entry declares none. Compiled once per session, like the working-line pattern, and
   * null rather than a fallback: no other CLI has been measured drawing such a chip, and
   * guessing one would badge sessions on the strength of an unread screen.
   */
  private _watchingLinePattern(): RegExp | null {
    if (this._watchingLineRe === undefined) {
      // The pattern and the window it runs over are one decision, so they are resolved
      // together: how far up the screen a CLI's row can sit is as much a property of its
      // layout as the row itself. Claude writes on the last row and keeps the default,
      // Codex pins one above its composer and declares more.
      const detect = getCli(this.mode)?.capabilities.workDetect;
      this._watchingLineRe = detect?.watchingLine ? compileVersionRegex(detect.watchingLine) : null;
      this._watchingWindow = detect?.watchingLines ?? WATCHING_TAIL_LINES;
    }
    return this._watchingLineRe;
  }

  /**
   * Whether the newest turn on this screen ended waiting for workers the CLI started
   * (Claude's `✻ Waiting for 1 dynamic workflow to finish`). False for a CLI whose
   * registry entry declares no `awaitingLine`. See `isAwaitingWorkers()`.
   */
  private _paneAwaitsWorkers(paneText: string): boolean {
    if (this._awaitingLineRe === undefined) {
      const src = getCli(this.mode)?.capabilities.workDetect?.awaitingLine;
      this._awaitingLineRe = src ? compileVersionRegex(src) : null;
    }
    if (!this._awaitingLineRe) return false;
    const glyph = getCli(this.mode)?.capabilities.workDetect?.promptGlyph ?? '❯';
    return isAwaitingWorkers(paneText, this._awaitingLineRe, glyph);
  }

  /**
   * The regex matching this CLI's "a turn is running" status line.
   *
   * Compiled once per session and cached: `_probePaneWorking` runs it against a whole
   * pane capture on a timer, and the throttled text detector runs it against every
   * accumulated chunk. A CLI that declares no pattern falls back to Claude's, which is
   * the pattern every session used before the registry carried one.
   */
  private _workingLinePattern(): RegExp {
    if (this._workingLineRe === undefined) {
      const src = getCli(this.mode)?.capabilities.workDetect?.workingLine;
      // Same guard the schema applies, not a second opinion: `compileVersionRegex()` is
      // what keeps a nested quantifier out of this pattern, and this one runs on the PTY
      // hot path. It returns null rather than throwing, and Claude's pattern is the
      // fallback every session used before the registry carried one.
      this._workingLineRe = (src ? compileVersionRegex(src) : null) ?? CLAUDE_WORKING_LINE_PATTERN;
    }
    return this._workingLineRe;
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
    this._terminalActivityEpoch++;
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
      if (wasWorking) this._maybeCaptureOmpSessionId();
      this.emit('idle', { reason: wasWorking ? 'turn-end' : 'initial-ready' } satisfies SessionIdleInfo);
    }
  }

  /**
   * A brand-new omp session (never yet respawned, so
   * {@link _pinOmpRespawnId} has never run) has no captured
   * omp-native session id: `_claudeSessionId` still defaults to this
   * session's OWN Codeman id from the constructor. Until something aliases
   * it, the omp history scan's row for this exact conversation (keyed by
   * omp's own uuid) merges with nothing and shows up a second time. The
   * first turn going idle is the first moment omp has definitely written
   * its session file, so resolve and alias it here — best-effort, and only
   * once (skips once `_claudeSessionId` differs from `this.id`, whether from
   * this capture or a resume/respawn that already resolved one).
   */
  private _maybeCaptureOmpSessionId(): void {
    if (getCli(this.mode)?.capabilities.transcript !== 'omp-jsonl' || this._claudeSessionId !== this.id) return;
    // Same host-local-filesystem trap as `_pinOmpRespawnId`: the omp session file for a
    // remote session lives on the remote host, not here, so scanning locally risks aliasing
    // this session onto an unrelated local omp conversation that happens to mangle to the
    // same directory name. Never resolvable from here — skip.
    if (this._remote) return;
    try {
      const resolvedId = resolveAndClaimOmpSessionId(this.workingDir);
      if (resolvedId) {
        this._claudeSessionId = resolvedId;
        this._ompConfig = { ...this._ompConfig, resumeSessionId: resolvedId };
      }
    } catch {
      // Best-effort: a failed capture just means the next respawn tries again.
    }
  }

  /**
   * Process expensive parsers (ANSI strip, Ralph, bash tool, token, CLI info, task descriptions).
   * Called on a throttled schedule (every EXPENSIVE_PROCESS_INTERVAL_MS) instead of on every
   * PTY data chunk. Receives accumulated raw data to process in one batch.
   */
  private _processExpensiveParsers(rawData: string): void {
    // Lazy ANSI strip: only compute cleanData when a consumer actually needs it.
    let _cleanData: string | null = null;
    const getCleanData = (): string => {
      if (_cleanData === null) {
        _cleanData = rawData.replace(ANSI_ESCAPE_PATTERN_FULL, '');
      }
      return _cleanData;
    };

    // Work detection by status line, ahead of the external-CLI gate below. The pattern
    // comes from the CLI's own registry entry, so this is the one parser here that is not
    // Claude-specific — and it sat under that gate, which is why an external CLI reported
    // itself idle through an entire turn. Guarded on the descriptor so a CLI without one
    // still skips the ANSI strip the gate used to save it.
    if (!this._isWorking && getCli(this.mode)?.capabilities.workDetect) {
      if (this._workingLinePattern().test(getCleanData())) this._markWorking();
    }

    // Skip Claude-specific parsers for external CLI sessions (Ralph tracker,
    // BashToolParser, token + CLI-info parsing all depend on Claude's output format).
    if (isExternalCliMode(this.mode)) return;

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

    // Legacy gerunds, Claude-only. The status-line pattern above already ran for every
    // CLI that declares one, so this adds only the older wording. Current Claude
    // randomizes the word ("Actualizing…", "Finagling…"), so these catch a fraction of
    // turns; the pattern above and the activity streak carry the rest.
    if (!this._isWorking) {
      const cleanData = getCleanData();
      if (
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
    if (this._closing) {
      throw new Error('Session is being closed');
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
        this._notePtySpawnGeometry(120, 40);
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
      this.emit('idle', { reason: 'shell-ready' } satisfies SessionIdleInfo);
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
          this._notePtySpawnGeometry(120, 40);
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
    this._stopWorkingFramePoller();
    this._status = 'busy';
    // A Session object can be restarted after its PTY exits. Do not carry a
    // latched working frame from the previous process into the new startup
    // quiet window, where it would be misclassified as a completed turn.
    this._isWorking = false;
    this._terminalBuffer.clear();
    this._textOutput.clear();
    this._errorBuffer = '';
    this._messages = [];
    this._lineBuffer = '';
    this._altScreenSeqCarry = '';
    // A restarted pane starts with no mouse mode: the new program has not asked
    // for one yet, and carrying the old CLI's state over would report clicks
    // into a program that never enabled tracking.
    this._cliMouseModes.clear();
    this._syncCliMouseTracking();
    this._markActivity(true);
  }

  /**
   * Positive external-CLI working signal — from a stream chunk match OR from
   * the COD-181 rendered-frame poller. Marks the session busy and re-arms the
   * quiet-window timer. For Codex, expiry must also find positive rendered
   * input-ready evidence before it can end the turn.
   */
  private _noteExternalWorkingFrame(): void {
    if (!this._isWorking) {
      this._isWorking = true;
      this._status = 'busy';
      this._terminalActivityEpoch++;
      this.emit('working');
      this._autoOps.notifyWorking();
    }
    this._awaitingIdleConfirmation = false;
    if (this.activityTimeout) clearTimeout(this.activityTimeout);
    this._armExternalCliIdleTimer();
  }

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
    this._stopWorkingFramePoller();
    const generation = this._workingFramePollGeneration;
    this._workingFrameFirstPollCompleted = false;
    this._workingFramePollUnregister = workingFramePollCoordinator.register({
      key: this.id,
      capture: () => this._captureWorkingFrameAsync(generation),
      onFrame: (frame) => {
        if (generation !== this._workingFramePollGeneration || this._isStopped) return;
        this._workingFrameFirstPollCompleted = true;
        if (!frame) return;
        // The async capture may carry SGR escapes that can sit inside the
        // pattern (e.g. bold around "Working") — strip before matching.
        const plain = frame.replace(ANSI_ESCAPE_PATTERN_FULL, '');
        if (detectExternalCliWorkingFrame(plain, this.mode)) {
          this._noteExternalWorkingFrame();
        }
      },
    });
  }

  private _stopWorkingFramePoller(): void {
    this._workingFramePollGeneration += 1;
    this._workingFramePollUnregister?.();
    this._workingFramePollUnregister = null;
    this._workingFrameFirstPollCompleted = false;
    this._workingFrameCapture?.controller.abort();
    this._workingFrameCapture = null;
  }

  private _captureWorkingFrameAsync(generation = this._workingFramePollGeneration): Promise<string | null> {
    if (generation !== this._workingFramePollGeneration || this._isStopped) return Promise.resolve(null);
    const mux = this._mux;
    const muxName = this._muxSession?.muxName;
    if (!muxName || !mux || typeof mux.capturePaneTextAsync !== 'function') return Promise.resolve(null);

    const current = this._workingFrameCapture;
    if (current && current.generation === generation && current.mux === mux && current.muxName === muxName) {
      return current.promise;
    }

    const controller = new AbortController();
    const capture = {
      generation,
      mux,
      muxName,
      controller,
      promise: Promise.resolve<string | null>(null),
    };
    capture.promise = mux
      .capturePaneTextAsync(muxName, { signal: controller.signal })
      .then((frame) => {
        if (
          generation !== this._workingFramePollGeneration ||
          this._isStopped ||
          this._mux !== mux ||
          this._muxSession?.muxName !== muxName
        ) {
          return null;
        }
        return frame;
      })
      .finally(() => {
        if (this._workingFrameCapture === capture) this._workingFrameCapture = null;
        if (
          generation === this._workingFramePollGeneration &&
          !this._isStopped &&
          this._mux === mux &&
          this._muxSession?.muxName === muxName
        ) {
          this._workingFrameFirstPollCompleted = true;
        }
      });
    this._workingFrameCapture = capture;
    return capture.promise;
  }

  /**
   * (Re-)arm the external-CLI quiet-window timer. For a working Codex turn,
   * expiry consults the rendered pane and only an input-ready state ends the
   * turn; working or unknown state re-arms the timer. Startup readiness and
   * other external CLIs retain the original quiet-window behavior.
   */
  private _armExternalCliIdleTimer(): void {
    if (this._externalCliIdleTimer) clearTimeout(this._externalCliIdleTimer);
    const idleGeneration = ++this._externalCliIdleGeneration;
    this._externalCliIdleTimer = setTimeout(async () => {
      this._externalCliIdleTimer = null;
      if (this._isStopped || idleGeneration !== this._externalCliIdleGeneration) return;
      const wasWorking = this._isWorking;
      const isInitialReady = this._status === 'busy' && !this._isWorking;
      if (isInitialReady && workingFramePollCoordinator.has(this.id) && !this._workingFrameFirstPollCompleted) {
        const pollGeneration = this._workingFramePollGeneration;
        // The shared poller can be queue-bound when many sessions register at
        // once. Wait for this session's first/current capture before declaring
        // startup idle so a queued Working frame cannot arrive after a false
        // initial-ready transition.
        const frame = await workingFramePollCoordinator.captureNow(this.id);
        if (this._isStopped || idleGeneration !== this._externalCliIdleGeneration) return;
        if (pollGeneration !== this._workingFramePollGeneration) {
          if (this._status === 'busy' && !this._isWorking) this._armExternalCliIdleTimer();
          return;
        }
        if (this._isWorking) return;
        if (frame) {
          const plain = frame.replace(ANSI_ESCAPE_PATTERN_FULL, '');
          if (detectExternalCliWorkingFrame(plain, this.mode)) {
            this._noteExternalWorkingFrame();
            return;
          }
        }
      }
      if (wasWorking && this.mode === 'codex') {
        const frame = await workingFramePollCoordinator.captureNow(this.id);
        if (this._isStopped || idleGeneration !== this._externalCliIdleGeneration || !this._isWorking) return;
        if (classifyCodexRenderedState(frame) !== 'input-ready') {
          this._armExternalCliIdleTimer();
          return;
        }
      }
      if (wasWorking || isInitialReady) {
        this._isWorking = false;
        this._status = 'idle';
        this._lastPromptTime = Date.now();
        this.emit('idle', { reason: wasWorking ? 'turn-end' : 'initial-ready' } satisfies SessionIdleInfo);
      }
    }, EXTERNAL_CLI_IDLE_DELAY_MS);
  }

  private _clearAllTimers(): void {
    // Stop re-sending Enter for a prompt this session will never take now
    this._submitVerifier?.cancel();
    this._submitVerifier = null;
    // Clear the workspace-trust follow-up read
    if (this._trustDialogTimer) {
      clearTimeout(this._trustDialogTimer);
      this._trustDialogTimer = null;
    }

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
    this._externalCliIdleGeneration += 1;

    this._stopWorkingFramePoller();

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
  write(data: string, options: SessionWriteOptions = {}): boolean {
    const submittedPrompt = this._trackSubmit(data, options);
    if (!this.ptyProcess) return false;
    this.ptyProcess.write(data);
    this._emitSubmittedPrompt(submittedPrompt);
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

  /**
   * Stamps the pane's last Enter for EVERY write, and feeds the auto-name
   * tracker only for user-originated input on a prompt-taking CLI. Ralph
   * kick-starts, respawn `/clear`s, cron launches, approval answers and the
   * trust-dialog keys all arrive without `fromUser` and so can never name a tab.
   */
  private _trackSubmit(data: string, options: SessionWriteOptions): string[] {
    const submitted = options.fromUser && this._acceptsPrompts ? this._submittedPromptTracker.feed(data) : [];
    if (data.includes('\r') || data.includes('\n')) {
      this._lastSubmitAt = Date.now();
      this._terminalActivityEpoch++;
      this.emit('terminalActivity');
      // Codex last-response resolution compares submit times ACROSS sessions (a
      // sibling codex pane's submit would otherwise be mistaken for this one's),
      // so codex panes additionally publish theirs to the shared map.
      if (this.mode === 'codex') Session.codexSubmitTimes.set(this.id, this._lastSubmitAt);
    }
    return submitted;
  }

  /**
   * Feeds user input that reaches the pane AROUND the write paths: the
   * send-key route injects Shift+Enter's line feed through `tmux send-keys -H`
   * directly, and without this the two lines of a prompt joined with no
   * separator. Reports submissions like a write would (a line feed never is one).
   */
  trackUserInput(data: string): void {
    if (!this._acceptsPrompts) return;
    this._emitSubmittedPrompt(this._submittedPromptTracker.feed(data));
  }

  private _emitSubmittedPrompt(prompts: string[]): void {
    for (const prompt of prompts) {
      this.emit('promptSubmitted', prompt);
    }
  }

  /**
   * A prompt was submitted, reported by the CLI's own UserPromptSubmit hook.
   * `_trackSubmit` only sees input that flows through Codeman's write path, so
   * a pane the user drives by attaching to tmux directly never stamped this and
   * `lastSubmitAt` stayed 0 for its whole life.
   */
  markPromptSubmitted(): void {
    this._lastSubmitAt = Date.now();
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
  /**
   * The highest input seq recorded for `clientId`, or 0 when this session has
   * never seen it.
   *
   * Reported back on a REJECTED (duplicate) frame so the client can lift its own
   * counter above this watermark. Without that number a client whose persisted
   * counter fell behind ours has no way to find its way out: every fresh
   * keystroke it sends lands at or below the watermark, is dropped as a
   * duplicate, and is ACKed anyway — so the UI looks healthy while nothing is
   * delivered, and a reload restores the same stale counter from localStorage.
   */
  lastInputSeq(clientId: string): number {
    return this._appliedInputSeq.get(clientId) ?? 0;
  }

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

  /** Explicit private-note submission preserves literal multiline content using bracketed paste. */
  async writeNotesInput(text: string, canWrite: () => boolean = () => true): Promise<boolean> {
    if (this._isStopped || !canWrite()) return false;
    const eligible = () => !this._isStopped && canWrite();
    const paste = '\x1b[200~' + text + '\x1b[201~';
    if (this._mux && this._muxSession) {
      if (!this._mux.sendNotesInput) return false;
      const sent = await this._mux.sendNotesInput(this.id, text, eligible);
      if (sent) this._emitSubmittedPrompt(this._trackSubmit(paste + '\r', { fromUser: true }));
      return sent;
    }
    if (!this.ptyProcess) return false;
    const transport = this.ptyProcess;
    transport.write(paste);
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (this.ptyProcess !== transport || !eligible()) return false;
    transport.write('\r');
    this._emitSubmittedPrompt(this._trackSubmit(paste + '\r', { fromUser: true }));
    return true;
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
  async writeViaMux(data: string, options: SessionWriteOptions = {}): Promise<boolean> {
    const submittedPrompt = this._trackSubmit(data, options);
    if (this._mux && this._muxSession) {
      const sent = await this._mux.sendInput(this.id, data);
      if (sent) {
        this._emitSubmittedPrompt(submittedPrompt);
        this._verifySubmitted(data);
      }
      return sent;
    }
    // Fallback to PTY write
    if (this.ptyProcess) {
      this.ptyProcess.write(data);
      this._emitSubmittedPrompt(submittedPrompt);
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
    }
    if (this._isStopped || (checkpointRunId !== undefined && checkpointRunId !== this._autoOps.activeCheckpointRunId)) {
      return { ok: false, stage: 'text', error: 'checkpoint run cancelled before delivery', attempt: 1 };
    }
    if (this._mux && this._muxSession) {
      const result = await this._mux.sendCheckpointCommand(this.id, data);
      if (result.ok) {
        // Codex fresh-thread commands intentionally do not update lastSubmitAt:
        // they are not viewer-history prompts, but successful delivery still
        // invalidates pending idle decisions.
        if (isCodexFreshThread) {
          this._terminalActivityEpoch++;
          this.emit('terminalActivity');
        } else this._trackSubmit(data, {});
      }
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
        this._trackSubmit(data, {});
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

  /**
   * Arm the composer check for a prompt that went out some other way than
   * `writeViaMux`, e.g. cron's paste mode, which writes the body raw and its Enter
   * separately. `text` is what the composer line starts with while the prompt is still
   * unsent; the check re-presses Enter only while that holds.
   */
  verifySubmitted(text: string): void {
    this._verifySubmitted(`${text}\r`);
  }

  /**
   * Arm the composer check for a write that carried Enter (session-submit-verifier.ts):
   * Claude Code 2.1.277+ ignores Enter for the first 30-50 s after the composer paints,
   * so the pair `sendInput` just sent can leave the text stranded. Only a mux session
   * can read its pane, only text can be stranded, and the glyph is the CLI's own.
   */
  private _verifySubmitted(data: string): void {
    if (!data.includes('\r') || !this._mux?.capturePaneText || !this._muxSession) return;
    const text = data.replace(/[\r\n]/g, '').trimEnd();
    if (!text) return;
    this._submitVerifier ??= new SubmitVerifier({
      capture: () =>
        this._isStopped || !this._mux || !this._muxSession
          ? null
          : this._mux.capturePaneText?.(this._muxSession.muxName),
      sendEnter: () => this._mux?.sendInput(this.id, '\r'),
      // ⚠ NO fallback glyph here, unlike the screen-reading probe elsewhere in this file.
      // Only claude and codex declare a promptGlyph; the other eight modes would fall back
      // to claude's `❯`, which is ALSO starship's default shell prompt (and pure's, and
      // spaceship's, and p10k lean's). On a shell session the line `❯ npm run build` sits
      // on screen for as long as the command runs, promptStillInComposer() reads that as
      // "still unsubmitted", and the verifier presses Enter into the running program's
      // stdin on its 2s..60s schedule. Mostly a stray blank line; not harmless against a
      // y/N prompt, `read -p`, an installer or a pager, where it takes the default.
      // promptStillInComposer() returns undefined for an empty glyph, so this makes the
      // verifier inert for every CLI that does not declare one, which is what the Claude
      // Code 2.1.277 defect it exists for actually calls for.
      glyph: () => getCli(this.mode)?.capabilities.workDetect?.promptGlyph ?? '',
      log: (m) => console.log(`[Session ${this.id.slice(0, 8)}] ${m}`),
    });
    this._submitVerifier.arm(text);
  }

  /** Current PTY dimensions — used to skip no-op resizes that trigger Ink redraws */
  private _ptyCols = 120;
  private _ptyRows = 40;

  /**
   * Record the geometry a PTY was just spawned at. A reattached pane keeps the
   * tmux window's size, not the constructor's 120x40, and without this
   * `ptyGeometry` reported the old numbers for a live pane and the dedupe in
   * `resize()` skipped a real resize that happened to match them.
   */
  private _notePtySpawnGeometry(cols: number, rows: number): void {
    this._ptyCols = cols;
    this._ptyRows = rows;
  }

  /**
   * The geometry the CLI is actually drawing for, or null when nothing is
   * drawing.
   *
   * Exposed because `resize()` can decline a request outright (arbitration
   * below) and the asking client has no other way to find out: a browser
   * terminal that keeps a shape the PTY refused renders garbled output rather
   * than wrong-sized output, because Claude Code's repaints are computed from
   * the width it was told (issue #464). Both transports report this back.
   *
   * ⚠️ NULL WITHOUT A PANE, never the field values. The fields are seeded at
   * spawn (`_notePtySpawnGeometry`) and moved by `resize()`, but a session with
   * a dead pane (or one created through the API and never started) still
   * holds the constructor defaults of 120x40, or the size of a pane that is
   * gone. Reporting those made a client adopt a size no process had ever
   * been told, and on anything narrower than 120 columns it claimed another
   * device owned the pane when none existed. `reconcilePtyGeometry` treats a
   * report with no finite numbers as no evidence, which is the truth here.
   */
  get ptyGeometry(): { cols: number; rows: number } | null {
    return this.ptyProcess ? { cols: this._ptyCols, rows: this._ptyRows } : null;
  }

  private _terminalResizeRequestSequence = 0;
  private _terminalResizeConfirmedSequence = 0;
  private _terminalGeometryDirty = false;
  private _pendingTerminalResize: {
    sequence: number;
    cols: number;
    rows: number;
    authority?: { token: symbol; generation: number };
  } | null = null;

  private readonly _terminalSizing = new TerminalSizingOwnership();
  private _acceptsTerminalViewerSizing = true;

  private _suspendTerminalViewerSizing(): void {
    this._acceptsTerminalViewerSizing = false;
    this._terminalSizing.clear();
    this._terminalResizeRequestSequence += 1;
    this._pendingTerminalResize = null;
  }

  private _resumeTerminalViewerSizing(): void {
    if (!this._isStopped) {
      this._acceptsTerminalViewerSizing = true;
    }
  }

  rememberTerminalViewerSize(token: symbol, cols: number, rows: number, viewportType: TerminalViewportType): void {
    if (!this._acceptsTerminalViewerSizing) {
      return;
    }
    this._terminalSizing.remember(token, { cols, rows, viewportType });
  }

  activateTerminalViewer(token: symbol, dimensions?: TerminalViewerDimensions): number {
    if (!this._acceptsTerminalViewerSizing) {
      return this._terminalSizing.currentGeneration;
    }
    const activation = this._terminalSizing.activate(token, dimensions);
    if (activation.dimensions) {
      const { cols, rows, viewportType } = activation.dimensions;
      this._resizeTerminal(cols, rows, { viewportType }, { token, generation: activation.generation });
    }
    return activation.generation;
  }

  resizeFromTerminalViewer(
    token: symbol,
    cols: number,
    rows: number,
    viewportType: TerminalViewportType,
    force = false
  ): boolean {
    if (!this._acceptsTerminalViewerSizing) {
      return false;
    }
    this.rememberTerminalViewerSize(token, cols, rows, viewportType);
    if (!this._terminalSizing.isOwner(token)) {
      return false;
    }
    this._resizeTerminal(
      cols,
      rows,
      { viewportType, force },
      { token, generation: this._terminalSizing.currentGeneration }
    );
    return true;
  }

  bootstrapTerminalViewer(token: symbol, force = false): boolean {
    if (!this._acceptsTerminalViewerSizing) {
      return false;
    }
    const activation = this._terminalSizing.bootstrap(token);
    if (!activation?.dimensions) {
      return false;
    }
    const { cols, rows, viewportType } = activation.dimensions;
    this._resizeTerminal(cols, rows, { viewportType, force }, { token, generation: activation.generation });
    return true;
  }

  releaseTerminalViewer(token: symbol): void {
    this._terminalSizing.release(token);
  }

  /**
   * Resizes the PTY terminal dimensions.
   * Skips the resize if dimensions haven't changed to avoid triggering
   * unnecessary Ink full-screen redraws (visible flicker on tab switch).
   *
   * @param cols - Number of columns (width in characters)
   * @param rows - Number of rows (height in lines)
   */
  resize(cols: number, rows: number, options: { viewportType?: ResizeViewportType; force?: boolean } = {}): void {
    this._resizeTerminal(cols, rows, options);
  }

  resizeIfNoActiveTerminalViewer(cols: number, rows: number): boolean {
    if (this._terminalSizing.ownerToken !== null) return false;
    this.resize(cols, rows);
    return true;
  }

  private _resizeTerminal(
    cols: number,
    rows: number,
    options: { viewportType?: ResizeViewportType; force?: boolean },
    authority?: { token: symbol; generation: number }
  ): void {
    const pty = this.ptyProcess;
    if (!pty) return;

    const authoritativeResize = this._mux && this._muxSession ? this._mux.resizeWindow : undefined;
    const dimsChanged = cols !== this._ptyCols || rows !== this._ptyRows;
    const pending = this._pendingTerminalResize;
    const correctsStaleAuthority = !!pending && !!authority && pending.authority?.generation !== authority.generation;
    const needsAuthoritativeReconcile = !!authoritativeResize && this._terminalGeometryDirty;
    const duplicatesPending =
      !!pending && pending.cols === cols && pending.rows === rows && !correctsStaleAuthority && !options.force;
    if (
      (!dimsChanged && !options.force && !correctsStaleAuthority && !needsAuthoritativeReconcile) ||
      duplicatesPending
    ) {
      return;
    }

    const sequence = ++this._terminalResizeRequestSequence;
    const request = { sequence, cols, rows, authority };
    this._pendingTerminalResize = request;

    const confirm = (success: boolean, authoritativeGeometryMayHaveChanged = false): void => {
      const isLatestRequest = this._pendingTerminalResize?.sequence === sequence;
      if (isLatestRequest) this._pendingTerminalResize = null;
      const hasCurrentAuthority =
        !authority ||
        (this._acceptsTerminalViewerSizing &&
          this._terminalSizing.currentGeneration === authority.generation &&
          this._terminalSizing.isOwner(authority.token));
      if (!isLatestRequest || !success || !hasCurrentAuthority) {
        if (authoritativeGeometryMayHaveChanged && sequence > this._terminalResizeConfirmedSequence) {
          this._terminalGeometryDirty = true;
        }
        return;
      }
      const confirmedChange = cols !== this._ptyCols || rows !== this._ptyRows;
      this._ptyCols = cols;
      this._ptyRows = rows;
      this._terminalResizeConfirmedSequence = sequence;
      if (authoritativeResize) this._terminalGeometryDirty = false;
      // COD-179: tell every connected client the shared geometry changed. A
      // viewer whose xterm has different dims renders the subsequent TUI
      // repaint frames misaligned (orphan "Working" rows in scrollback) and
      // needs to reconcile by rewriting from the tmux capture. Only a real
      // geometry change matters — a forced same-size SIGWINCH can't misalign.
      if (confirmedChange) {
        this.emit('resized', { cols, rows });
      }
    };

    if (authoritativeResize && this._muxSession) {
      let admissionKnown = false;
      let synchronousCompletion: boolean | undefined;
      let accepted = false;
      try {
        accepted = authoritativeResize.call(this._mux, this._muxSession.muxName, cols, rows, (success) => {
          if (!admissionKnown) synchronousCompletion = success;
          else confirm(success, true);
        });
      } catch {
        admissionKnown = true;
        confirm(false);
        return;
      }
      admissionKnown = true;
      if (!accepted) {
        confirm(false);
        return;
      }
      try {
        pty.resize(cols, rows);
      } catch {
        if (this.ptyProcess === pty) this.ptyProcess = null;
      }
      if (synchronousCompletion !== undefined) confirm(synchronousCompletion, true);
      return;
    }

    try {
      pty.resize(cols, rows);
      confirm(true);
    } catch {
      if (this.ptyProcess === pty) this.ptyProcess = null;
      confirm(false);
    }
  }

  // Legacy method for compatibility with session-manager
  async start(): Promise<void> {
    this._status = 'idle';
  }

  // Legacy method for sending input - wraps runPrompt
  async sendInput(input: string): Promise<void> {
    this._status = 'busy';
    this._markActivity(true);
    this.runPrompt(input).catch((err) => {
      const errorMsg = getErrorMessage(err);
      // Clean up task state so the task queue doesn't get stuck
      if (this._currentTaskId) {
        const taskId = this._currentTaskId;
        this._currentTaskId = null;
        this._status = 'idle';
        this._markActivity(true);
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
    this._suspendTerminalViewerSizing();
    // A pane that is gone is watching nothing. Nothing probes a stopped session, so
    // without this the last chip it drew would ride along on its row forever.
    this._watching = null;

    this._clearAllTimers();

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
          if (!isNoSuchProcessError(err)) {
            console.warn('[Session] Failed to send SIGKILL to process (already terminated):', err);
          }
        }

        // Also try to kill any child processes in the process group
        try {
          if (pid) {
            process.kill(-pid, 'SIGKILL');
          }
        } catch (err) {
          if (!isNoSuchProcessError(err)) {
            console.warn('[Session] Failed to send SIGKILL to process group (may not exist):', err);
          }
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

    this._suspendTerminalViewerSizing();

    // Preserve the conversation-resume id for claude-mode sessions only.
    if (this.mode === 'claude') {
      this._resumeSessionId = this._claudeSessionId || this._resumeSessionId || this.id;
    }

    this._clearAllTimers();
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
    this._markActivity(true);
  }

  clearTask(): void {
    this._currentTaskId = null;
    this._status = 'idle';
    this._markActivity(true);
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
