/**
 * @fileoverview tmux session manager for persistent Claude sessions.
 *
 * This module provides the TmuxManager class which creates and manages
 * tmux sessions that wrap Claude CLI processes. tmux provides:
 *
 * - **Persistence**: Sessions survive server restarts and disconnects
 * - **Ghost recovery**: Orphaned sessions are discovered and reattached on startup
 * - **Resource tracking**: Memory, CPU, and child process stats per session
 * - **Reliable input**: `send-keys -l` sends literal text in a single command
 * - **Teammate support**: Immutable pane IDs enable targeting individual teammates
 *
 * tmux sessions are named `codeman-{sessionId}` and stored in ~/.codeman/mux-sessions.json.
 *
 * Key features:
 * - `send-keys 'text' Enter` sends literal text in a single command
 * - `list-sessions -F` provides structured queries
 * - `display-message -p '#{pane_pid}'` for reliable PID discovery
 * - Single server architecture
 *
 * @module tmux-manager
 */

import { EventEmitter } from 'node:events';
import { MAX_INPUT_LENGTH } from './config/terminal-limits.js';
import { collectDescendants } from './proc-tree.js';
import { getCli } from './config/cli-registry/registry.js';
import type { CliDockerResume, CliEntry } from './config/cli-registry/types.js';
import { missingCliMessage, resolveCliBinDir } from './utils/cli-resolver.js';
import {
  buildSpawnCommandFromRegistry,
  rawLaunchCommand,
  rawLaunchCommandForMode,
  configSetenvValues,
  legacyConfigForMode,
} from './session-cli-registry-bridge.js';
import type { SpawnBridgeOptions } from './session-cli-registry-bridge.js';
import { execSync, exec, execFile } from 'node:child_process';
import { RemoteFrameSshPool } from './remote-frame-ssh-pool.js';
import { RemoteCaptureBackoff } from './remote-capture-backoff.js';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
/** Activity frames are small; reject unexpectedly large captures. */
const ASYNC_TEXT_CAPTURE_MAX_BUFFER = 256 * 1024;
/** Activity polling must settle quickly when a pane disappears or tmux stalls. */
const ASYNC_TEXT_CAPTURE_TIMEOUT_MS = 1_500;
/** ssh roundtrip budget for a remote pane capture (COD-180) — LAN is ~100-300ms; WAN gets headroom. */
const REMOTE_CAPTURE_TIMEOUT_MS = 10_000;
/** Remote full-history captures can span tens of thousands of lines with SGR escapes. */
const REMOTE_CAPTURE_MAX_BUFFER = 64 * 1024 * 1024;
/** COD-187 — separates capture output from the geometry line in the combined remote frame fetch. */
const REMOTE_FRAME_GEOM_DELIM = '__CODEMAN_GEOM__';
import { existsSync, statSync, readFileSync, mkdirSync } from 'node:fs';
import { writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import {
  dataPath,
  DEFAULT_TMUX_SOCKET,
  CODEMAN_INSTANCE,
  SAFE_TMUX_SOCKET_PATTERN,
  resolveTmuxSocketName,
} from './config/instance.js';
import {
  ProcessStats,
  PersistedRespawnConfig,
  getErrorMessage,
  DEFAULT_NICE_CONFIG,
  type PaneInfo,
  type ClaudeMode,
  type SessionMode,
  type NiceConfig,
  type OpenCodeConfig,
  type CodexConfig,
  type GeminiConfig,
  type EffortLevel,
  type AntigravityConfig,
  type PiConfig,
  type GrokConfig,
  type DeepSeekConfig,
  type OmpConfig,
  type SessionRemote,
  type SessionDocker,
  type DockerCommandMode,
  type PaneExit,
} from './types.js';
import {
  resolveStatusLineCliCommand,
  readPlanUsageTelemetryEnabled,
  findEffectiveUserStatusLineCommand,
} from './hooks-config.js';
import {
  buildSshConnectionArgs,
  buildSshConnectionArgv,
  defaultRemoteCommandForMode,
  remoteLoginShellCommand,
  remoteSshTarget,
  remoteTmuxSessionAlive,
  withRemotePathBootstrap,
} from './remote-hosts.js';
import {
  buildDockerBaseArgs,
  buildDockerCreateArgs,
  containerApiUrl,
  CONTAINER_HOME,
  defaultDockerCommandForMode,
  hostGatewayAlias,
  resolveDockerClaudeArtifacts,
  resolveDockerCredentialArtifacts,
  resolveDockerDaemonMountSource,
  type DockerCreateContext,
  type DockerMount,
  type DockerSeedCopy,
} from './docker-hosts.js';
import { wrapWithNice, SAFE_PATH_PATTERN, resolveLocalShell, loginShellArgs } from './utils/index.js';
import type {
  TerminalMultiplexer,
  MuxSession,
  MuxSessionWithStats,
  CreateSessionOptions,
  RespawnPaneOptions,
  CommandDeliveryResult,
  PaneCaptureOptions,
} from './mux-interface.js';
import type { CodexProviderEnvironment } from './codex-provider-identity.js';
import { resolveCodexRecoveryStrategy } from './codex-command-profiles.js';
import {
  decideReconnect,
  advanceBackoff,
  freshReconnectState,
  resetReconnectState,
  type RemoteReconnectState,
} from './remote-reconnect.js';
import { canUsernameRunPrivilegedCommands } from './user-store.js';

// ============================================================================
// Timing Constants
// ============================================================================

import { EXEC_TIMEOUT_MS } from './config/exec-timeout.js';
import {
  resolveHeadroomClaudeBaseUrl,
  reconcileCodexHeadroomPatch,
  resolveHeadroomRouted,
} from './config/headroom-routing.js';
import { ensureDeepSeekStatusShim } from './deepseek-status-shim.js';

/** How long a cached process snapshot stays usable. */
const PROC_SNAPSHOT_TTL_MS = 2000;

/**
 * How long the kill path waits for a fresh snapshot before giving up on it.
 * Shorter than EXEC_TIMEOUT_MS on purpose: killSession has two further strategies
 * (process group, tmux kill-session) and must reach them even when `ps` is wedged.
 */
const PROC_SNAPSHOT_WAIT_MS = 1500;
import { DEFAULT_TMUX_HISTORY_LIMIT, DEFAULT_TERMINAL_BUFFER_MAX_BYTES } from './config/terminal-history.js';

/**
 * Extra stdout headroom for the full-history `capture-pane` child process on
 * top of the consumer's byte cap: raw scrollback carries per-line SGR/ANSI
 * overhead that the route pipeline strips before applying its cap, so the
 * capture must be allowed to exceed the final payload size.
 */
const FULL_HISTORY_CAPTURE_SLACK_BYTES = 8 * 1024 * 1024;

/** Delay after tmux session creation — enough for detached tmux to be queryable */
const TMUX_CREATION_WAIT_MS = 100;

/** Max retries for getPanePid — tmux server cold-start (e.g. macOS) may need extra time */
const GET_PID_MAX_RETRIES = 5;
const GET_PID_RETRY_MS = 200;

/** Delay after tmux kill command (200ms) */
const TMUX_KILL_WAIT_MS = 200;

/** Delay for graceful shutdown (100ms) */
const GRACEFUL_SHUTDOWN_WAIT_MS = 100;

/** Default stats collection interval (2 seconds) */
const DEFAULT_STATS_INTERVAL_MS = 2000;

/**
 * How often the pane-exit watcher re-reads every pane on the socket. The
 * watcher owns this cadence: it does NOT ride `startStatsCollection()`, whose
 * lifetime a browser panel controls (see {@link TmuxManager.startPaneExitWatcher}).
 * Matched to the stats cadence above because both cost one batched tmux read.
 * ⚠ It does NOT bound a read: EXEC_TIMEOUT_MS is 5000 ms, so a slow read can
 * outlive two ticks, which is exactly why `paneExitReadInFlight` exists.
 */
const DEFAULT_PANE_EXIT_INTERVAL_MS = 2000;

/** Default remote-reconnect watcher poll interval (5 seconds) — COD-108 */
const DEFAULT_REMOTE_RECONNECT_INTERVAL_MS = 5000;

/** Remote SSH connects should fail fast; TCP default retries can hang UI actions for minutes. */

/** Wait slightly longer than SSH ConnectTimeout before accepting a remote respawn as connected. */
const REMOTE_RESPAWN_CONNECT_VERIFY_WAIT_MS = 10_500;

/** Stable cwd for tmux server/pane launch; actual session cwd is reached inside the pane. */
const TMUX_LAUNCH_CWD = '/tmp';

/** Claude Code native macOS recommendation for avoiding low nofile startup failures. */
export const CLAUDE_CODE_NOFILE_LIMIT = 2147483646;

/**
 * SAFETY: Test mode detection.
 * When running under vitest (VITEST env var is set automatically),
 * ALL tmux shell commands are disabled. TmuxManager becomes a pure
 * in-memory mock that cannot interact with real tmux sessions.
 *
 * This makes it PHYSICALLY IMPOSSIBLE for any test to:
 * - Kill a tmux session
 * - Create a tmux session
 * - Send input to a tmux session
 * - Discover/reconcile real tmux sessions
 * - Read/write ~/.codeman/mux-sessions.json
 */
const IS_TEST_MODE = !!process.env.VITEST;

/** Path to persisted mux session metadata */
const MUX_SESSIONS_FILE = dataPath('mux-sessions.json');

/**
 * COD-108 kill-switch: `remoteAutoReconnect` app setting (default ON). Read at
 * call time (like headroom routing) so a settings change takes effect without a
 * restart. Absent/non-boolean ⇒ true (feature on).
 */
function isRemoteAutoReconnectEnabled(): boolean {
  try {
    const s = JSON.parse(readFileSync(dataPath('settings.json'), 'utf8')) as Record<string, unknown>;
    return typeof s.remoteAutoReconnect === 'boolean' ? s.remoteAutoReconnect : true;
  } catch {
    return true;
  }
}

/** Regex to validate tmux session names (only allow safe characters) */
const SAFE_MUX_NAME_PATTERN = /^codeman-[a-f0-9-]+$/;

/** Legacy pattern for pre-rename sessions (claudeman- prefix) */
const LEGACY_MUX_NAME_PATTERN = /^claudeman-[a-f0-9-]+$/;

/** Regex to validate tmux pane targets (e.g., "%3" pane ids, "0" pane indexes, or active pane). */
const SAFE_PANE_TARGET_PATTERN = /^(%\d+|\d+|active)$/;
/** Bare Codex skill token that opens the interactive picker before submission. */
const CODEX_SKILL_INVOCATION_PATTERN = /^\$[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** A recovery launch was deliberately refused rather than starting an opaque command fresh. */
export class ManualRecoveryRequiredError extends Error {
  constructor() {
    super('Manual recovery is required for this custom Codex command');
    this.name = 'ManualRecoveryRequiredError';
  }
}

/** Dedicated tmux socket for new Codeman-owned sessions (instance-scoped:
 *  `codeman` for prod, `codeman-beta` on the beta branch). */
const DEFAULT_CODEMAN_TMUX_SOCKET = DEFAULT_TMUX_SOCKET;

/**
 * Separator used in `tmux list-panes -F` output between session name and pid.
 *
 * Must NOT be a backslash-escape (e.g. `\t`, `\n`): under non-tty execution
 * contexts (launchd on macOS, systemd without TTYPath) tmux can emit such
 * escapes as the literal two characters `\` + letter rather than the control
 * byte, breaking the parser and causing every tracked session to be classified
 * as dead — which wipes state.json on restart. '|' is passed through verbatim
 * in every environment and is rejected by tmux's own session-name validation,
 * so it cannot appear inside `#{session_name}` and cause a false split.
 */
const PANE_LIST_SEP = '|';

/**
 * Format string for `tmux list-panes -F`. Keep in sync with {@link parsePaneRows}.
 *
 * The three `pane_dead*` fields carry the agent-exit signal of Ark0N/Codeman#446.
 * Appending them is backward compatible in both directions. A tmux that does not
 * know a variable substitutes the empty string rather than failing, which is how
 * tmux 3.2a answers `#{pane_dead_signal}` (added in 3.4), and the parser reads a
 * short row as "pid known, deadness unknown" rather than discarding it.
 */
const PANE_LIST_FORMAT =
  `#{session_name}${PANE_LIST_SEP}#{pane_pid}` +
  `${PANE_LIST_SEP}#{pane_dead}${PANE_LIST_SEP}#{pane_dead_status}${PANE_LIST_SEP}#{pane_dead_signal}`;
const PANE_CWD_FORMAT = `#{pane_active}${PANE_LIST_SEP}#{session_name}${PANE_LIST_SEP}#{pane_current_path}`;

/**
 * 构建 pane 启动前的 nofile 修复命令。
 *
 * macOS launchd/tmux 组合有时会让 pane 继承 256 的 soft nofile；
 * 新版 Claude Code 会在这种环境下直接退出。这里避免使用 $变量
 * 或命令替换，因为 fullCmd 目前经由双引号 bash -c 传递，外层
 * shell 会提前展开它们。
 */
export function buildNofileLimitCommand(targetLimit = CLAUDE_CODE_NOFILE_LIMIT): string {
  const safeLimit = Number.isSafeInteger(targetLimit) && targetLimit > 0 ? targetLimit : CLAUDE_CODE_NOFILE_LIMIT;
  return `ulimit -Sn ${safeLimit} 2>/dev/null || ulimit -n ${safeLimit} 2>/dev/null || true`;
}

/** One pane of one tmux session, as {@link parsePaneRows} reads it off the wire. */
export interface PaneRow {
  /** tmux session this pane belongs to. Repeats once per pane of a split session. */
  sessionName: string;
  /** `#{pane_pid}` — the process tmux started in the pane. */
  pid: number;
  /** `#{pane_dead}` — true for 1, false for 0, undefined when tmux said nothing. */
  dead?: boolean;
  /** `#{pane_dead_status}` — the exit code, absent when tmux reported none. */
  exitStatus?: number;
  /** `#{pane_dead_signal}` — the killing signal, absent before tmux 3.4 and when unsignalled. */
  exitSignal?: number;
}

/**
 * One pane-exit reading, with the pane pid that produced it.
 *
 * The pid never leaves this module. It is what distinguishes "the same dead
 * pane, seen again" from "a second command in the same pane that also exited
 * with the same status", so the `at` stamp can hold across the first and must
 * not across the second. {@link PaneExit} itself stays free of it: the pid on
 * the session record is the attach client's, and a second pid there would
 * invite exactly the confusion Ark0N/Codeman#446 is about.
 */
export interface PaneExitObservation {
  /** `#{pane_pid}` of the pane this reading came from. */
  panePid: number;
  /** What to publish on the session record. */
  exit: PaneExit;
}

/**
 * A {@link PaneExitObservation} as the manager stores it, with a count of the
 * authoritative reads that have seen this same exit. The count is what lets
 * the exited-agent sweep act only on a death that more than one read agreed on
 * (`CLEAN_EXIT_CONFIRMING_READS` in `pane-exit-sweep.ts`). A failed or skipped
 * read never reaches {@link TmuxManager.applyPaneExits}, so it neither raises
 * the count nor resets it.
 */
interface TrackedPaneExit extends PaneExitObservation {
  /** Authoritative reads that saw this exit, counting the first. */
  reads: number;
}

/** Read one optional numeric field; a blank or non-numeric value is "not reported". */
function paneField(fields: string[], index: number): number | undefined {
  const raw = fields[index];
  if (raw === undefined || raw === '') return undefined;
  const value = parseInt(raw, 10);
  return Number.isNaN(value) ? undefined : value;
}

/**
 * Parse the output of `tmux list-panes -a -F` under {@link PANE_LIST_FORMAT}
 * into one row per pane, in tmux's own order. Exported for unit testing.
 *
 * - Skips empty lines and lines without the separator.
 * - Skips entries with a non-numeric pid or empty name.
 * - Leaves every field after the pid undefined when it is blank or absent, so a
 *   row from an older tmux still yields its pid.
 */
export function parsePaneRows(output: string): PaneRow[] {
  const rows: PaneRow[] = [];
  for (const line of output.split('\n')) {
    if (!line) continue;
    if (!line.includes(PANE_LIST_SEP)) continue;
    const fields = line.split(PANE_LIST_SEP);
    const sessionName = fields[0];
    const pid = parseInt(fields[1] ?? '', 10);
    if (!sessionName || Number.isNaN(pid)) continue;
    const deadFlag = fields[2];
    rows.push({
      sessionName,
      pid,
      dead: deadFlag === '1' ? true : deadFlag === '0' ? false : undefined,
      exitStatus: paneField(fields, 3),
      exitSignal: paneField(fields, 4),
    });
  }
  return rows;
}

/** Compatibility views used by existing session discovery and integrations. */
export function parsePaneRecords(output: string): Array<{ name: string; pid: number; dead: boolean }> {
  return parsePaneRows(output).map((row) => ({ name: row.sessionName, pid: row.pid, dead: row.dead === true }));
}

export function parsePaneList(output: string): Map<string, number> {
  return new Map(
    parsePaneRows(output)
      .filter((row) => !row.dead)
      .map((row) => [row.sessionName, row.pid])
  );
}

/**
 * Decide, from every pane tmux listed, which tmux sessions have an exited agent.
 * Exported for unit testing. Returns one entry per session with a known answer;
 * a session absent from the map is UNKNOWN, which must never render as alive.
 *
 * Two rules make a positive answer trustworthy:
 *
 * A session answers only when tmux listed EXACTLY ONE pane for it. Codeman
 * creates one pane per session and `isPaneDead()` reads one pane, so a session
 * the user has split by hand has no single "the agent" to report on, and
 * guessing which of its panes speaks for the session could report a live
 * session as exited.
 *
 * A pane answers only when `#{pane_dead}` said 1 or 0. An empty field is a tmux
 * that did not answer, not a live pane.
 *
 * `status` and `signal` stay absent when tmux did not report them. Measured on
 * tmux 3.2a, a SIGKILLed pane reports neither, so folding an absent status into
 * 0 would turn an unexplained death into a clean exit.
 */
export function derivePaneExits(rows: PaneRow[], now: number): Map<string, PaneExitObservation> {
  const panesPerSession = new Map<string, number>();
  for (const row of rows) {
    panesPerSession.set(row.sessionName, (panesPerSession.get(row.sessionName) ?? 0) + 1);
  }
  const exits = new Map<string, PaneExitObservation>();
  for (const row of rows) {
    if (panesPerSession.get(row.sessionName) !== 1) continue;
    if (row.dead !== true) continue;
    exits.set(row.sessionName, {
      panePid: row.pid,
      exit: {
        ...(row.exitStatus !== undefined ? { status: row.exitStatus } : {}),
        ...(row.exitSignal !== undefined ? { signal: row.exitSignal } : {}),
        at: now,
      },
    });
  }
  return exits;
}

/**
 * Could any of these tmux sessions ever produce a pane-exit answer? Exported
 * for unit testing.
 *
 * Mirrors `Session.paneExitApplies`, which is where the rule is enforced. A
 * remote session's local pane holds the ssh client, a docker case's holds a
 * `docker exec` into the container's own tmux, and a record rebuilt from the
 * socket carries no provenance at all, so the session end forces all three to
 * UNKNOWN whatever tmux reports. A tick that sees only those has nothing to
 * learn, and `refreshPaneExits()` skips its tmux read rather than paying for
 * the answer.
 *
 * ⚠ This gates the READ, never the watcher. The watcher is always-on by
 * design (see {@link TmuxManager.startPaneExitWatcher}), so it keeps ticking
 * with nothing to observe and picks the read straight back up as soon as one
 * local session exists.
 */
export function hasObservablePaneSession(sessions: Iterable<MuxSession>): boolean {
  for (const session of sessions) {
    if (session.remote) continue;
    if (session.docker) continue;
    if (session.discovered === true) continue;
    return true;
  }
  return false;
}

/**
 * Parse `tmux list-panes -a -F '#{pane_active}|#{session_name}|#{pane_current_path}'`
 * into muxName → the ACTIVE pane's current working directory (COD-386).
 *
 * ⚠ Field order is load-bearing. A directory name may legitimately contain the
 * separator, so the path has to be the LAST field and is taken as the whole
 * remainder rather than split further. `pane_active` leads so the two fixed
 * fields are both in front of it.
 *
 * Only active panes are kept: a split window has several, and "the pane's cwd"
 * is only a well-defined question for the one the user is looking at. A
 * relative path is a bare string, so anything that is not absolute is dropped
 * rather than guessed at.
 */
export function parsePaneCurrentPaths(output: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of output.split('\n')) {
    if (!line) continue;
    const sep = line.indexOf(PANE_LIST_SEP);
    if (sep === -1) continue;
    if (line.slice(0, sep) !== '1') continue;
    const rest = line.slice(sep + 1);
    const sep2 = rest.indexOf(PANE_LIST_SEP);
    if (sep2 === -1) continue;
    const name = rest.slice(0, sep2);
    const path = rest.slice(sep2 + 1);
    if (name && path.startsWith('/')) result.set(name, path);
  }
  return result;
}

/**
 * Whether it's safe to (re)spawn a tmux pane into `dir`.
 *
 * Reconciles two protections:
 *  - COD-43: don't respawn into a *deleted* cwd — `cd` into it makes
 *    `respawn-pane` exit immediately and crash-loop. So refuse a real deletion.
 *  - FUSE/rclone hardening: a transient mount blip can make a perfectly valid
 *    workspace momentarily unreachable; refusing there would defeat the pane's
 *    `/tmp` + `cd`-bounce recovery, which reaches the path via the live mount
 *    table once the blip clears.
 *
 * Distinguisher: a real deletion leaves the *parent* a healthy directory; a
 * mount blip takes the parent down too. So refuse only when `dir` is missing
 * but its parent is a healthy directory; otherwise allow the respawn to proceed.
 */
export function isUsableWorkingDir(dir: string): boolean {
  // Present → usable iff it's actually a directory (a file cwd is unusable).
  try {
    if (existsSync(dir)) {
      return statSync(dir).isDirectory();
    }
  } catch {
    // existsSync said present but statSync threw (removal race or mount EIO) —
    // fall through to the parent check to classify it.
  }
  // `dir` is missing/vanished. Healthy parent ⇒ real deletion ⇒ refuse.
  // Parent also unreachable ⇒ transient mount blip ⇒ let cd-bounce recover.
  try {
    const parent = dirname(dir);
    if (parent && parent !== dir && existsSync(parent) && statSync(parent).isDirectory()) {
      return false;
    }
  } catch {
    /* parent unreachable → treat as a transient blip */
  }
  return true;
}

/**
 * Resolve an app-level pane reference into a tmux target.
 *
 * Important: a numeric pane target is a pane index (`session.0`), not a tmux
 * pane id (`%0`). Pane ids are global and monotonically assigned by tmux, so
 * assuming `%0` exists breaks restored sessions whose real pane id is `%3`,
 * `%12`, etc.
 */
export function resolveTmuxPaneTarget(muxName: string, paneTarget?: string): string | null {
  if (!isValidMuxName(muxName)) {
    return null;
  }
  if (paneTarget === undefined || paneTarget === 'active') {
    return muxName;
  }
  if (!SAFE_PANE_TARGET_PATTERN.test(paneTarget)) {
    return null;
  }
  return `${muxName}.${paneTarget}`;
}

/**
 * Pick the active pane id from `tmux list-panes -F '#{pane_id}:#{pane_active}'`
 * output (lines like `%0:1`). Returns the pane id whose active flag is 1.
 */
export function resolveActivePaneTarget(output: string): string | null {
  for (const line of output.split('\n')) {
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const paneId = line.slice(0, sep).trim();
    const active = line.slice(sep + 1).trim();
    if (paneId && active === '1') return paneId;
  }
  return null;
}

const CODEX_PROVIDER_ENVIRONMENT_KEYS = ['CODEX_HOME', 'OPENAI_API_KEY', 'CODEX_API_KEY'] as const;

/** Parse `tmux show-environment` through the closed Codex provider allowlist. */
export function parseTmuxCodexProviderEnvironment(output: string): CodexProviderEnvironment {
  const environment: CodexProviderEnvironment = {};
  for (const line of output.split('\n')) {
    const equals = line.indexOf('=');
    if (equals <= 0) continue;
    const key = line.slice(0, equals);
    const value = line.slice(equals + 1);
    if (!value || !CODEX_PROVIDER_ENVIRONMENT_KEYS.includes(key as (typeof CODEX_PROVIDER_ENVIRONMENT_KEYS)[number])) {
      continue;
    }
    environment[key as (typeof CODEX_PROVIDER_ENVIRONMENT_KEYS)[number]] = value;
  }
  return environment;
}

export type TmuxEnvironmentExecutor = (file: string, args: string[]) => Promise<{ stdout: string }>;

export interface TmuxPaneTextExecOptions {
  encoding: 'utf8';
  timeout: number;
  maxBuffer: number;
  signal?: AbortSignal;
}

export type TmuxPaneTextExecutor = (
  file: string,
  args: string[],
  options: TmuxPaneTextExecOptions
) => Promise<{ stdout: string }>;

const executePaneTextCapture: TmuxPaneTextExecutor = async (file, args, options) => {
  const { stdout } = await execFileAsync(file, args, options);
  return { stdout };
};

export async function readTmuxCodexProviderEnvironment(
  socket: string,
  muxName: string,
  tracked: boolean,
  execute: TmuxEnvironmentExecutor
): Promise<CodexProviderEnvironment | null> {
  if (!tracked || !SAFE_TMUX_SOCKET_PATTERN.test(socket) || !isValidMuxName(muxName)) return null;
  try {
    const { stdout } = await execute('tmux', ['-L', socket, 'show-environment', '-t', muxName]);
    return parseTmuxCodexProviderEnvironment(stdout);
  } catch {
    return null;
  }
}

type GraphemeSegmenter = {
  segment(input: string): Iterable<{ segment: string }>;
};

const GRAPHEME_SEGMENTER: GraphemeSegmenter | null = (() => {
  try {
    const Segmenter = (
      Intl as typeof Intl & {
        Segmenter?: new (locale?: string, options?: { granularity: 'grapheme' }) => GraphemeSegmenter;
      }
    ).Segmenter;
    return Segmenter ? new Segmenter(undefined, { granularity: 'grapheme' }) : null;
  } catch {
    return null;
  }
})();

function findEscapeEnd(text: string, start: number): number {
  const type = text[start + 1];
  if (type === '[') {
    for (let i = start + 2; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code >= 0x40 && code <= 0x7e) return i;
    }
    return text.length - 1;
  }

  if (type === ']') {
    for (let i = start + 2; i < text.length; i++) {
      if (text.charCodeAt(i) === 0x07) return i;
      if (text[i] === '\x1b' && text[i + 1] === '\\') return i + 1;
    }
    return text.length - 1;
  }

  if (type === 'P' || type === '^' || type === '_' || type === 'X') {
    for (let i = start + 2; i < text.length; i++) {
      if (text.charCodeAt(i) === 0x07) return i;
      if (text[i] === '\x1b' && text[i + 1] === '\\') return i + 1;
    }
    return text.length - 1;
  }

  return Math.min(start + 1, text.length - 1);
}

function sanitizePaneLineStyles(line: string): string {
  let result = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '\x1b') {
      result += line[i];
      continue;
    }

    const end = findEscapeEnd(line, i);
    const sequence = line.slice(i, end + 1);
    if (isSgrSequence(sequence)) {
      result += sequence;
    }
    i = end;
  }
  return result;
}

function isSgrSequence(sequence: string): boolean {
  return (
    sequence.length >= 3 &&
    sequence.charCodeAt(0) === 27 &&
    sequence[1] === '[' &&
    sequence.endsWith('m') &&
    /^[0-9;:]*$/.test(sequence.slice(2, -1))
  );
}

function isZeroWidthCodePoint(codePoint: number): boolean {
  return (
    codePoint === 0x00ad ||
    codePoint === 0x034f ||
    codePoint === 0x061c ||
    codePoint === 0x115f ||
    codePoint === 0x1160 ||
    codePoint === 0x17b4 ||
    codePoint === 0x17b5 ||
    codePoint === 0x180e ||
    codePoint === 0x200b ||
    codePoint === 0x200c ||
    codePoint === 0x200d ||
    codePoint === 0x2060 ||
    codePoint === 0xfeff ||
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x0483 && codePoint <= 0x0489) ||
    (codePoint >= 0x0591 && codePoint <= 0x05bd) ||
    codePoint === 0x05bf ||
    (codePoint >= 0x05c1 && codePoint <= 0x05c2) ||
    (codePoint >= 0x05c4 && codePoint <= 0x05c5) ||
    codePoint === 0x05c7 ||
    (codePoint >= 0x0610 && codePoint <= 0x061a) ||
    (codePoint >= 0x064b && codePoint <= 0x065f) ||
    codePoint === 0x0670 ||
    (codePoint >= 0x06d6 && codePoint <= 0x06dc) ||
    (codePoint >= 0x06df && codePoint <= 0x06e4) ||
    (codePoint >= 0x06e7 && codePoint <= 0x06e8) ||
    (codePoint >= 0x06ea && codePoint <= 0x06ed) ||
    codePoint === 0x0711 ||
    (codePoint >= 0x0730 && codePoint <= 0x074a) ||
    (codePoint >= 0x07a6 && codePoint <= 0x07b0) ||
    (codePoint >= 0x07eb && codePoint <= 0x07f3) ||
    (codePoint >= 0x0816 && codePoint <= 0x0819) ||
    (codePoint >= 0x081b && codePoint <= 0x0823) ||
    (codePoint >= 0x0825 && codePoint <= 0x0827) ||
    (codePoint >= 0x0829 && codePoint <= 0x082d) ||
    (codePoint >= 0x0859 && codePoint <= 0x085b) ||
    (codePoint >= 0x08d3 && codePoint <= 0x08e1) ||
    (codePoint >= 0x08e3 && codePoint <= 0x0902) ||
    (codePoint >= 0x093a && codePoint <= 0x093c) ||
    codePoint === 0x094d ||
    (codePoint >= 0x0951 && codePoint <= 0x0957) ||
    (codePoint >= 0x0962 && codePoint <= 0x0963) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  );
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  );
}

function nextGrapheme(text: string, start: number): { value: string; nextIndex: number } {
  if (GRAPHEME_SEGMENTER) {
    const iterator = GRAPHEME_SEGMENTER.segment(text.slice(start))[Symbol.iterator]();
    const next = iterator.next();
    if (!next.done && next.value.segment) {
      return { value: next.value.segment, nextIndex: start + next.value.segment.length };
    }
  }

  const first = text.codePointAt(start);
  if (first === undefined) return { value: '', nextIndex: start + 1 };
  let value = String.fromCodePoint(first);
  let nextIndex = start + value.length;
  while (nextIndex < text.length) {
    const codePoint = text.codePointAt(nextIndex);
    if (codePoint === undefined || !isZeroWidthCodePoint(codePoint)) break;
    const mark = String.fromCodePoint(codePoint);
    value += mark;
    nextIndex += mark.length;
  }
  return { value, nextIndex };
}

function terminalCellWidth(grapheme: string): number {
  let hasVisible = false;
  let hasWide = false;
  for (let i = 0; i < grapheme.length; i++) {
    const codePoint = grapheme.codePointAt(i);
    if (codePoint === undefined) continue;
    if (codePoint > 0xffff) i++;
    if (isZeroWidthCodePoint(codePoint) || codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) {
      continue;
    }
    hasVisible = true;
    if (isWideCodePoint(codePoint)) hasWide = true;
  }
  if (!hasVisible) return 0;
  return hasWide ? 2 : 1;
}

function truncatePaneLineByVisibleColumns(line: string, maxColumns: number): string {
  let result = '';
  let visibleColumns = 0;
  let sawSgr = false;

  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\x1b') {
      const end = findEscapeEnd(line, i);
      const sequence = line.slice(i, end + 1);
      if (isSgrSequence(sequence)) {
        result += sequence;
        sawSgr = true;
      }
      i = end;
      continue;
    }

    const grapheme = nextGrapheme(line, i);
    const width = terminalCellWidth(grapheme.value);
    if (width === 0) {
      result += grapheme.value;
    } else if (visibleColumns + width <= maxColumns) {
      result += grapheme.value;
      visibleColumns += width;
    } else {
      break;
    }
    i = grapheme.nextIndex - 1;
    if (visibleColumns >= maxColumns) {
      continue;
    }
  }

  if (sawSgr) {
    result += '\x1b[0m';
  }
  return result;
}

/**
 * Normalize scrollback line endings to `\r\n` so a fresh xterm replays each line
 * at column 0 (COD-138).
 *
 * `capture-pane -p -e -S -` (full-history capture) joins scrollback rows with a
 * BARE `\n`. The browser xterm is created with the default `convertEol: false`
 * (correct for the live PTY stream, which already carries real `\r\n`), so a bare
 * `\n` drops a row without returning the cursor to column 0. Replaying that raw
 * buffer on a full page reload makes every line start one column further right —
 * the diagonal "staircase". The visible/tab-switch path avoids this by repainting
 * each row with an absolute cursor CSI (`formatPaneSnapshot`); the full-history
 * path returns raw scrollback, so it must be CRLF-normalized here.
 *
 * `\r?\n → \r\n` is idempotent on already-CRLF input and leaves a lone `\r` (an
 * intentional in-line column reset / overwrite) untouched.
 */
export function normalizeScrollbackEol(buffer: string): string {
  return buffer.replace(/\r?\n/g, '\r\n');
}

/** Pane geometry and caret position, as `display-message` reports them. */
interface PaneCursorGeometry {
  cols: number;
  rows: number;
  cursorX: number;
  cursorY: number;
}

/**
 * Read the pane's cursor and size, or null when tmux cannot say.
 *
 * Every field is validated together: a caller that gets a value back can place
 * a caret with it, and one that gets null must not try.
 */
export function queryPaneCursor(run: () => string): PaneCursorGeometry | null {
  let raw: string;
  try {
    raw = run().trim();
  } catch (cursorErr) {
    console.error('[TmuxManager] Failed to query pane cursor after capture:', cursorErr);
    return null;
  }
  return parsePaneGeometry(raw);
}

/** SGR attributes, which is all `capture-pane -e` emits. */
// eslint-disable-next-line no-control-regex
const CAPTURE_STYLE_SEQUENCE = /\x1b\[[0-9;:]*m/g;

/** Whether a capture holds anything a reader would see, styles discounted. */
export function hasVisibleContent(capture: string): boolean {
  return /\S/.test(capture.replace(CAPTURE_STYLE_SEQUENCE, ''));
}

/**
 * Put the caret back where the pane has it, counting UP from the bottom of what
 * was just replayed.
 *
 * Relative rather than absolute (`CUP`) on purpose. `\x1b[<row>;<col>H` numbers
 * rows from the top of the browser's screen, so it only lands correctly while
 * the browser's row count equals the pane's — and it need not, because
 * `resizeWindow` fires its tmux resize without waiting, so a capture can be
 * taken before a requested resize has been applied. Counting up from the last
 * replayed row is anchored to the content instead, which is the thing both ends
 * genuinely share.
 *
 * ⚠️ The LIVE full-history path goes through `formatFullHistoryCapture` below,
 * which is COD-433's tail-anchored variant of this same idea (it additionally
 * falls back to absolute addressing when the capture is too short to establish
 * the tail anchor). This one stays as the minimal, separately-pinned primitive.
 */
export function formatCursorRestore(geometry: PaneCursorGeometry): string {
  const up = Math.max(0, geometry.rows - 1 - geometry.cursorY);
  const right = Math.max(0, geometry.cursorX);
  // `\r` first so the column is known: the replay leaves the caret wherever the
  // last row's text ended.
  return `${up > 0 ? `\x1b[${up}A` : ''}\r${right > 0 ? `\x1b[${right}C` : ''}`;
}

function parsePaneGeometry(output: string): { cols: number; rows: number; cursorX: number; cursorY: number } | null {
  const [cursorX, cursorY, cols, rows] = output
    .trim()
    .split(/\s+/)
    .map((value) => parseInt(value, 10));
  if (
    Number.isFinite(cursorX) &&
    Number.isFinite(cursorY) &&
    Number.isFinite(cols) &&
    Number.isFinite(rows) &&
    cursorX >= 0 &&
    cursorY >= 0 &&
    cols > 0 &&
    rows > 0
  ) {
    return { cols, rows, cursorX, cursorY };
  }
  return null;
}

export function formatFullHistoryCapture(
  buffer: string,
  geometry?: { cols: number; rows: number; cursorX: number; cursorY: number } | null
): string {
  const normalized = normalizeScrollbackEol(buffer);
  if (!geometry || geometry.cols <= 0 || geometry.rows <= 0) return normalized;
  const cursorX = Math.max(0, Math.min(geometry.cols - 1, geometry.cursorX));
  const cursorY = Math.max(0, Math.min(geometry.rows - 1, geometry.cursorY));
  // Full captures retain the final screen's blank rows. Anchor to that tail:
  // an absolute source-pane row clamps to the browser's last row when its
  // viewport is shorter (COD-433), placing input on the footer. CR also clears
  // pending autowrap when the last captured row fills the terminal width.
  // Incomplete captures cannot establish that anchor; retain the legacy fallback.
  if (normalized.split('\n').length >= geometry.rows) {
    const rowsBelowCursor = geometry.rows - 1 - cursorY;
    return `${normalized}\r${rowsBelowCursor ? `\x1b[${rowsBelowCursor}A` : ''}\x1b[${cursorX + 1}G`;
  }
  return `${normalized}\x1b[${cursorY + 1};${cursorX + 1}H`;
}

export function formatPaneSnapshot(
  lines: string[],
  geometry: { cols: number; rows: number; cursorX: number; cursorY: number }
): string {
  const cols = Math.max(1, geometry.cols);
  // Paint the full pane width. Earlier this dropped the rightmost column
  // (cols - 1) out of caution about last-column autowrap, but every painted
  // row is immediately followed by an absolute cursor-position CSI (the next
  // row's `\x1b[r;1H`, or the final cursor move), which cancels xterm's
  // pending-wrap state before any further glyph — so the last column is safe.
  const paintCols = cols;
  const rows = Math.max(1, geometry.rows);
  const parts: string[] = [];
  for (let row = 0; row < Math.min(lines.length, rows); row++) {
    const safeLine = truncatePaneLineByVisibleColumns(sanitizePaneLineStyles(lines[row]), paintCols);
    parts.push(`\x1b[${row + 1};1H${safeLine}`);
  }
  const cursorX = Math.max(0, Math.min(cols - 1, geometry.cursorX));
  const cursorY = Math.max(0, Math.min(rows - 1, geometry.cursorY));
  parts.push(`\x1b[${cursorY + 1};${cursorX + 1}H`);
  return parts.join('');
}

/**
 * COD-187 — capture start flag: full scrollback (`-S -`) or, for the history
 * view's fast first page, only the last N lines (`-S -N`). Bounded so a
 * hostile/buggy value can't inject anything (integer, floored).
 */
export function captureStartFlag(lastLines?: number): string {
  if (lastLines && Number.isFinite(lastLines) && lastLines > 0) {
    return `-S -${Math.floor(lastLines)}`;
  }
  return '-S -';
}

/**
 * COD-187 — the combined remote frame-fetch command: visible-frame capture,
 * a delimiter line, then the pane geometry. One ssh roundtrip fetches both so
 * the snapshot and its cursor position are consistent.
 */
export function buildRemoteFrameCommand(target: string, socket = 'codeman'): string {
  return (
    `tmux -L ${socket} capture-pane -p -e -t ${shellescape(target)}; ` +
    `printf '${REMOTE_FRAME_GEOM_DELIM}\\n'; ` +
    `tmux -L ${socket} display-message -p -t ${shellescape(target)} '#{cursor_x} #{cursor_y} #{pane_width} #{pane_height}'`
  );
}

/**
 * COD-187 — parse the combined remote frame-fetch output. With valid geometry
 * the frame is repainted at absolute positions (parity with the local visible
 * path); on delimiter/geometry failure it degrades to linear one-screen text
 * (paints acceptably into a reset terminal; cursor lands at end). Returns null
 * for an empty capture so callers fall back to the local wrapper frame.
 */
export function parseRemoteFrameCapture(stdout: string): string | null {
  const delim = `\n${REMOTE_FRAME_GEOM_DELIM}\n`;
  const delimIdx = stdout.indexOf(delim);
  if (delimIdx >= 0) {
    const capture = stdout.slice(0, delimIdx);
    const geometry = parsePaneGeometry(stdout.slice(delimIdx + delim.length));
    if (geometry && capture.length > 0) {
      return formatPaneSnapshot(capture.split('\n'), geometry);
    }
  }
  const raw = stdout.split(delim)[0].replace(/\n+$/g, '');
  return raw.length > 0 ? normalizeScrollbackEol(raw) : null;
}

/** COD-463 — backoff key: one entry per distinct ssh destination + connection options. */
function remoteCaptureHostKey(sshArgv: string[], sshTarget: string): string {
  return JSON.stringify([sshTarget, sshArgv]);
}

/**
 * COD-463 — the combined remote full-history command: pane geometry, a
 * delimiter line, then the scrollback capture. One ssh roundtrip (it used to be
 * two fresh connections: capture, then a separate cursor query). Geometry goes
 * FIRST so the delimiter is found before any captured text, which could contain
 * anything.
 */
export function buildRemoteFullHistoryCommand(target: string, socket = 'codeman', lastLines?: number): string {
  return (
    `tmux -L ${socket} display-message -p -t ${shellescape(target)} '#{cursor_x} #{cursor_y} #{pane_width} #{pane_height}'; ` +
    `printf '${REMOTE_FRAME_GEOM_DELIM}\\n'; ` +
    `tmux -L ${socket} capture-pane -p -e ${captureStartFlag(lastLines)} -t ${shellescape(target)}`
  );
}

/**
 * COD-463 — parse {@link buildRemoteFullHistoryCommand} output. A failed
 * geometry query prints nothing before the delimiter and degrades to the
 * cursor-less format. Returns null for an empty capture so callers fall back.
 */
export function parseRemoteFullHistoryCapture(stdout: string): string | null {
  const delim = `${REMOTE_FRAME_GEOM_DELIM}\n`;
  const delimIdx = stdout.indexOf(delim);
  const geometry = delimIdx >= 0 ? parsePaneGeometry(stdout.slice(0, delimIdx)) : null;
  // COD-190: same trailing-blank preservation as the local fullHistory path.
  const buffer = (delimIdx >= 0 ? stdout.slice(delimIdx + delim.length) : stdout).replace(/\n$/, '');
  if (buffer.length === 0) return null;
  return formatFullHistoryCapture(buffer, geometry);
}

/** Characters unsafe in paths — shell metacharacters, quotes, and control chars */
const UNSAFE_PATH_CHARS = /[;&|$`(){}<>'"\n\r]/;

/**
 * Validates that a session name contains only safe characters.
 * Prevents command injection via malformed session IDs.
 */
function isValidMuxName(name: string): boolean {
  return SAFE_MUX_NAME_PATTERN.test(name) || LEGACY_MUX_NAME_PATTERN.test(name);
}

/** Remote tmux session targets are `codeman-ssh-<hex>` for owned sessions or a
 * discovered `codeman-*` name (e.g. `codeman-disco1`) for non-owned attaches.
 * The `ssh` prefix deliberately fails SAFE_MUX_NAME_PATTERN, so we validate
 * with a wider but still shell-safe pattern here. */
function isValidRemoteTmuxTarget(name: string): boolean {
  return /^codeman-[a-zA-Z0-9._-]+$/.test(name);
}

function isValidTerminalDimension(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= 1000;
}

/**
 * Validates that a path contains only safe characters.
 * Prevents command injection via malformed paths.
 */
function isValidPath(path: string): boolean {
  if (UNSAFE_PATH_CHARS.test(path)) {
    return false;
  }
  if (path.includes('..')) {
    return false;
  }
  return SAFE_PATH_PATTERN.test(path);
}

// ===========================================================================
// Single-socket architecture: ALL Codeman sessions live on one dedicated tmux
// socket (`tmux -L codeman`), isolated from the user's default tmux server.
// The socket name is a process-wide constant (env-overridable for test/multi-
// instance isolation) — it is never stored per-session, so it cannot drift.
// ===========================================================================

/**
 * Resolve the process-wide Codeman tmux socket name. Always returns a valid
 * name: `CODEMAN_TMUX_SOCKET` env override if safe, else the built-in default.
 */
function resolveConfiguredTmuxSocket(): string {
  const raw = process.env.CODEMAN_TMUX_SOCKET ?? DEFAULT_CODEMAN_TMUX_SOCKET;
  if (!SAFE_TMUX_SOCKET_PATTERN.test(raw)) {
    console.warn(`[TmuxManager] Ignoring invalid CODEMAN_TMUX_SOCKET: ${JSON.stringify(raw)}`);
  }
  return resolveTmuxSocketName();
}

/** Build the `tmux -L <socket>` command prefix. Socket name is shell-escaped. */
function tmuxCommand(socket: string): string {
  return `tmux -L ${shellescape(socket)}`;
}

/**
 * Build Claude CLI permission flags for the tmux command string.
 * Validates allowedTools to prevent command injection.
 */
function buildClaudePermissionFlags(claudeMode?: ClaudeMode, allowedTools?: string): string {
  const mode = claudeMode || 'dangerously-skip-permissions';
  switch (mode) {
    case 'dangerously-skip-permissions':
      return ' --dangerously-skip-permissions';
    case 'auto':
      return ' --permission-mode auto';
    case 'allowedTools':
      if (allowedTools) {
        // Sanitize: allow tool names with patterns like Bash(git:*), space/comma-separated
        // Block shell metacharacters: ; & | $ ` \ { } < > ' " newlines
        const hasDangerousChars = /[;&|$`\\{}<>'"[\]\n\r]/.test(allowedTools);
        if (!hasDangerousChars) {
          return ` --allowedTools "${allowedTools}"`;
        }
      }
      // Fall back to normal mode if tools are invalid or missing
      return '';
    case 'normal':
      return '';
  }
}

/** Pi's `--thinking` levels. Runtime allowlist — defense in depth beyond the Zod enum. */

/**
 * Build the spawn command for any session mode.
 * Shared by createSession() and respawnPane() to avoid duplication.
 */
export function buildSpawnCommand(options: {
  mode: SessionMode;
  sessionId: string;
  model?: string;
  claudeMode?: ClaudeMode;
  allowedTools?: string;
  openCodeConfig?: OpenCodeConfig;
  codexConfig?: CodexConfig;
  geminiConfig?: GeminiConfig;
  antigravityConfig?: AntigravityConfig;
  piConfig?: PiConfig;
  grokConfig?: GrokConfig;
  deepSeekConfig?: DeepSeekConfig;
  ompConfig?: OmpConfig;
  resumeSessionId?: string;
  effort?: EffortLevel;
  /** Resolved by resolveStatusLineCliCommand (hooks-config.ts) — undefined skips the exporter. Claude only. */
  statusLineCommand?: string;
  /** Name pinned on claude as `--name` (version-gated, sanitized; local spawns only). Only a user-chosen name: see `Session.cliPinnedName`. */
  sessionName?: string;
  /**
   * Claude CLI version for the `--name` gate. Omitted = probe the local CLI
   * (getClaudeCliVersion; null under vitest). Tests inject a value here; the
   * docker/remote paths never see this builder's output, which is what keeps the
   * gate measuring the RIGHT binary, the local one.
   */
  claudeCliVersion?: string | null;
}): string {
  // ⚠️ COD-392 stays a CODE-LEVEL early return, before the engine. The value is a complete
  // server-resolved shell command line, and the argv engine forbids shell text BY DESIGN — there
  // is no `ArgSpec` that could carry it, and inventing one would reopen the injection surface the
  // engine exists to close. Which config key holds it is registry DATA (`launch.rawCommandField`),
  // so the early return no longer has to know that codex is the CLI that has one.
  const rawCommand = rawLaunchCommandForMode(options.mode, options as unknown as Record<string, unknown>);
  if (rawCommand !== undefined) return rawCommand;

  // Everything else is registry DATA: `launch.variants` rendered by the argv engine, read out of
  // the legacy `<Mode>Config` objects through `legacyConfigAliases`. This replaced a nine-way
  // `if (options.mode === …)` chain that dispatched to nine hand-written builders; each builder
  // was a second copy of a launch spec the registry already declared.
  //
  // Verified byte-identical before the swap, not assumed: a 35-case differential across every
  // mode and every declared param found 33 exact matches, and the only two divergences were the
  // two intentional ones handled here — `baseCommand` above, and `shell` below.
  const entry = getCli(options.mode);
  if (entry) {
    const rendered = buildSpawnCommandFromRegistry(entry, options);
    if (rendered !== undefined) return rendered;
  }

  // `shell` (and any entry declaring no launch variants) falls through here on purpose: the
  // engine returns undefined for it because there is no CLI to template.
  //
  // #208: NOT the literal '$SHELL'. This string is embedded in the `bash -c "…"`
  // argument of the respawn-pane line, which execSync runs through `/bin/sh -c`,
  // so a `$SHELL` here is expanded by the SERVER process's shell against the
  // SERVER process's env — empty in containers and system systemd units, leaving
  // the pane command ending in a dangling `&&` ("syntax error: unexpected end of
  // file", pane dead on arrival). Resolve it in Node and quote the result.
  // #209: launch it as a LOGIN shell, which is what tmux itself does for a pane
  // with no `default-command`, so a Codeman shell tab matches a hand-started tmux
  // one. That is what picks up /etc/profile and /etc/profile.d/* — a systemd
  // --user service never sourced them, so its PATH is what every pane inherited.
  // The flags come from loginShellArgs() rather than being hardcoded: they are
  // appended to a path that ultimately comes from the passwd entry, and a shell
  // that rejects an unknown flag exits on the spot, which is #208 all over again.
  const shell = resolveLocalShell();
  return `${shellescape(shell)}${loginShellArgs(shell)}`;
}

/**
 * Whether a mode launches an external agent CLI whose env must be inherited.
 *
 * COD-416: `kind` IS this question — the nine-arm switch it replaces listed every agent entry
 * and `shell`, i.e. it restated the catalog. An unregistered mode is NOT an agent CLI, which
 * is the conservative answer: it inherits no agent env rather than inheriting one blindly.
 */
function isAgentCliMode(mode: SessionMode): boolean {
  return getCli(mode)?.kind === 'agent';
}

/**
 * Detailed resolver diagnostics for an external agent CLI that could not be found.
 *
 * COD-416: delegates to the registry's generic `missingCliMessage()`, which builds the same
 * message from `discovery.install` + `label` and appends the same PATH/login-shell/search-dir
 * diagnostics through the per-CLI resolver's own hook. The ten-arm switch this replaces was a
 * SECOND dispatch table over the same nine resolvers.
 *
 * ⚠️ Two messages change wording slightly, measured rather than assumed: claude loses one word
 * ("Install it with" -> "Install with") and deepseek reads "DeepSeek CLI not found" rather than
 * "DeepSeek Harness CLI (dsh) not found". The other seven are byte-identical. The `dsh` binary
 * name is still in deepseek's install command in the same message, so it is not lost.
 */
export function cliNotFoundMessage(mode: SessionMode): string {
  const message = missingCliMessage(mode);
  // `shell` has no binary to find, so it has no such error — the switch threw here too.
  if (message === null) throw new Error(`No external CLI error exists for ${mode} mode`);
  return message;
}

/** Apply process priority to both legs of the controlled Claude resume fallback. */
export function wrapSpawnCommandWithNice(command: string, config: NiceConfig): string {
  const legs = command.split(' || ');
  if (legs.length === 2 && legs.every((leg) => leg.startsWith('claude '))) {
    return legs.map((leg) => wrapWithNice(leg, config)).join(' || ');
  }
  return wrapWithNice(command, config);
}

/** Select exactly one transport builder without evaluating callbacks for discarded transports. */
export function selectLaunchCommand(options: {
  local: () => string;
  remote?: () => string;
  docker?: () => string;
}): string {
  if (options.docker) return options.docker();
  if (options.remote) return options.remote();
  return options.local();
}

/** Build the final tmux respawn command while preserving launch text through the outer server shell. */
export function buildRespawnPaneCommand(options: {
  tmuxCommand: string;
  muxName: string;
  workingDir: string;
  launchCommand: string;
  local: boolean;
}): string {
  const launchCommand = options.local
    ? `cd ${shellescape(options.workingDir)} && ${options.launchCommand}`
    : options.launchCommand;
  return `${options.tmuxCommand} respawn-pane -k -c ${TMUX_LAUNCH_CWD} -t "${options.muxName}" bash -c ${shellescape(launchCommand)}`;
}

/** Prepend a resolved CLI directory without allowing its characters to be reinterpreted by the login shell. */
export function buildCliPathExport(directory: string): string {
  return `export PATH=${shellescape(directory)}:"$PATH" && `;
}

/** Keep the controlled Claude resume fallback in its shell; only the final successful leg replaces it. */
function buildLocalAgentExecCommand(mode: SessionMode, command: string): string {
  const legs = command.split(' || ');
  if (mode === 'claude' && legs.length === 2) {
    return `${legs[0]} || exec ${legs[1]}`;
  }
  return `exec ${command}`;
}

/**
 * COD-276 — assemble the local pane launch command. Agent modes re-`exec` through
 * the user's login shell so the CLI inherits the user's shell env, using the same
 * `resolveLocalShell()`/`loginShellArgs()` (`<shell> -i -l`) pattern upstream uses
 * for local shell mode and remote agents — `-i -l` pulls ~/.bash_profile and
 * ~/.bashrc (bash) or ~/.zprofile and ~/.zshrc (zsh). `shell` mode itself is left
 * to buildSpawnCommand. `pathExport` is the `export PATH="…" && ` string from
 * buildPathExport.
 */
export function buildLocalPaneCommand(opts: {
  mode: SessionMode;
  pathExport: string;
  envExports: string[];
  cmd: string;
  /** COD-392: owner-authored command is a complete shell line, including any exec. */
  exactCommand?: boolean;
}): string {
  const nofile = buildNofileLimitCommand();
  if (isAgentCliMode(opts.mode)) {
    const shell = resolveLocalShell();
    const loginArgs = loginShellArgs(shell);
    // Run Codeman's path/export AFTER the profile so Codeman-controlled values still
    // win; the trailing exec keeps the pane PID as the agent CLI itself.
    const agentCommand = opts.exactCommand ? opts.cmd : buildLocalAgentExecCommand(opts.mode, opts.cmd);
    const body = [opts.pathExport.replace(/ && $/, ''), ...opts.envExports, agentCommand]
      .filter((s) => s.trim().length > 0)
      .join(' && ');
    return `${nofile} && exec ${shellescape(shell)}${loginArgs} -c ${shellescape(body)}`;
  }
  return `${nofile} && ${opts.pathExport}${opts.envExports.join(' && ')} && ${opts.cmd}`;
}

/**
 * Dedicated tmux socket for remote sessions. A Codeman instance running on the
 * TARGET host watches its own `codeman` socket and would otherwise see our
 * session name, so its `reconcileSessions()` would ADOPT our session (attach a
 * PTY, resize, respawn-pane it locally) — the cross-machine form of the "2nd
 * instance attaches live sessions" hazard. A private socket keeps our remote
 * sessions off that instance's radar entirely.
 */
const REMOTE_TMUX_SOCKET = 'codeman-remote';

/**
 * Deterministic, reattach-stable remote tmux session name for a Codeman session.
 *
 * Derived from the same stable field the LOCAL muxName uses (the first 8 chars
 * of the sessionId), so reconnecting (which re-issues the exact same
 * `ssh … new-session -A`) lands back in the SAME remote session. Must NOT be
 * random/time-based — it has to be stable across reconnects.
 *
 * The `codeman-ssh-` prefix is deliberately chosen to FAIL a remote Codeman's
 * `SAFE_MUX_NAME_PATTERN` (`^codeman-[a-f0-9-]+$`) — the `s`/`h` letters mean a
 * remote instance's discovery never treats one as its own session (belt to the
 * dedicated-socket suspenders above).
 */
export function remoteTmuxSessionName(sessionId: string): string {
  return `codeman-ssh-${sessionId.slice(0, 8)}`;
}

/**
 * The `<VAR>=<json> ` prefix for a CLI whose config travels as ONE env var
 * (`env.configContentVar` — opencode's `OPENCODE_CONFIG_CONTENT`). Empty for every CLI that
 * declares none, and for a caller that supplied nothing worth setting.
 *
 * The JSON comes from `resolveConfigContent`, the SAME resolver the local `tmux setenv` path
 * uses, so a remote pane and a local one agree on what "auto-allow layered over the caller's
 * JSON" means rather than each deciding for itself.
 */
function buildConfigContentEnvPrefix(entry: CliEntry, options: SpawnBridgeOptions): string {
  const contentVar = entry.env.configContentVar;
  if (!contentVar) return '';
  const content = resolveConfigContent(legacyConfigForMode(entry.id, options as unknown as Record<string, unknown>));
  return content ? `${contentVar}=${shellescape(content)} ` : '';
}

/**
 * The remote pane command for a CLI that carries its session config to the remote host, or
 * `undefined` for one that does not — the caller then falls back to the static
 * `defaultRemoteCommandForMode`.
 *
 * ⚠️ WHICH CLIs carry it is registry DATA (`overlays.remote.fromLaunchSpec`), and it describes
 * the four hand-written builders this replaced rather than granting anything new. A CLI without
 * the flag reaches a remote host with its model / resume / permission flags dropped, which is
 * pre-registry behaviour preserved on purpose (COD-416 wave 3e).
 */
export function renderRemoteCliCommand(mode: SessionMode, options: SpawnBridgeOptions): string | undefined {
  const entry = getCli(mode);
  const overlay = entry?.overlays.remote;
  if (!entry || !overlay || 'disabled' in overlay || overlay.fromLaunchSpec !== true) return undefined;
  // The raw owner-authored command line (codex's COD-392 `baseCommand`) replaces the templated
  // launch on a remote host exactly as it does locally; the grant that authorises it is
  // re-checked on the launch paths, not here.
  const command = rawLaunchCommand(entry, options) ?? buildSpawnCommandFromRegistry(entry, options);
  if (command === undefined) return undefined;
  return `${buildConfigContentEnvPrefix(entry, options)}${command}`;
}

/**
 * COD-104 — build the SSH command that launches (or reattaches) a remote
 * session INSIDE a tmux server on the remote host, so the remote agent survives
 * an SSH drop.
 *
 * Emits:
 *   ssh -o BatchMode=yes -t [<COD-107 connection opts>] user@host \
 *     'tmux -L codeman new-session -A -s codeman-<id> -c <path> "cd <path> && exec <cli>" \
 *        \; set -g status off \; set -g mouse off \; set -sg escape-time 0 \; set -g prefix C-q'
 *
 * COD-107 — the connection options (`-p`, `-i`, `-J`, SOCKS `-o ProxyCommand`,
 * arbitrary `-o`) come from the shared `buildSshConnectionArgs(remote)`, so the
 * prereq tmux probe and this launch connect with identical options.
 *
 * - `new-session -A -s codeman-<id>` = attach-if-exists-else-create (idempotent),
 *   so reconnect re-runs the same command and reattaches the still-running agent.
 * - `-L codeman` = canonical remote socket (for Phase 2/3 discovery).
 * - The whole tmux invocation is a SINGLE ssh argument (the remote login shell
 *   runs it), so it is shell-quoted as one unit; the `cd && exec` command is in
 *   turn a single tmux argument (tmux runs it via `/bin/sh -c`), so the path is
 *   shell-quoted inside it too. This keeps escaping correct through every layer
 *   even when the remote path contains spaces.
 */
export function buildRemoteLaunchCommand(options: {
  mode: SessionMode;
  remote: SessionRemote;
  sessionId: string;
  codexConfig?: CodexConfig;
  openCodeConfig?: OpenCodeConfig;
  geminiConfig?: GeminiConfig;
  antigravityConfig?: AntigravityConfig;
  claudeMode?: ClaudeMode;
  allowedTools?: string;
  /** Remote tmux history-limit (COD-180). Set BEFORE new-session so the initial pane gets it. */
  historyLimit?: number;
  /** OMP only — resume/continue overrides for the remote omp relaunch (dead-pane respawn). */
  ompConfig?: OmpConfig;
  resumeSessionId?: string;
}): string {
  const {
    mode,
    remote,
    sessionId,
    codexConfig,
    openCodeConfig,
    geminiConfig,
    antigravityConfig,
    claudeMode,
    allowedTools,
    historyLimit,
    ompConfig,
    resumeSessionId,
  } = options;
  // §6.3: honor the session's EFFECTIVE claude permission mode on remote instead of
  // hardcoding --dangerously-skip-permissions, so a non-granted multi-user user's
  // downgraded 'auto' actually reaches the remote agent (the default command otherwise
  // ignored claudeMode). A per-host `commands.<mode>` override stays authoritative
  // (admin's explicit choice). Wrapped in `$SHELL -i -l -c` for the same reason as
  // `defaultRemoteCommandForMode`: the agent CLIs live under a per-user PATH entry
  // that only an interactive login shell resolves (see that function's comment).
  // Codex/OpenCode/Gemini/Antigravity keep their own builders so per-session config flags survive the wrap.
  const override = remote.commands?.[mode];
  const codexRecovery =
    mode === 'codex' && codexConfig?.resumeSessionId
      ? resolveCodexRecoveryStrategy(
          { command: override, resumeCommandTemplate: remote.codexResumeCommandTemplate },
          codexConfig.resumeSessionId
        )
      : undefined;
  if (codexRecovery?.kind === 'manual_required') throw new ManualRecoveryRequiredError();
  // COD-416 wave 3e: the four per-session builders this replaces (codex / opencode / gemini /
  // antigravity) were each a second copy of a launch spec the registry already declares, and the
  // list of WHICH CLIs get their session config on a remote host is now `overlays.remote
  // .fromLaunchSpec` rather than four arms of a conditional.
  //
  // ⚠️ That flag is descriptive, not a widening: the CLIs without it (pi, grok, deepseek) still
  // reach a remote host through `defaultRemoteCommandForMode`, i.e. with their model / resume /
  // permission flags dropped. That is pre-registry behaviour and this change preserves it
  // deliberately rather than quietly fixing it on a path no test and no beta can exercise.
  // (omp is the exception: it has its own arm below, added upstream for dead-pane respawn, which
  // renders through the registry directly rather than through `overlays.remote.fromLaunchSpec`.)
  const perSessionRemote = renderRemoteCliCommand(mode, {
    mode,
    sessionId,
    codexConfig,
    openCodeConfig,
    geminiConfig,
    antigravityConfig,
  });
  let modeCommand: string;
  if (codexRecovery?.kind === 'template') {
    modeCommand = codexRecovery.command;
  } else if (override) {
    modeCommand = override;
  } else if (perSessionRemote !== undefined) {
    modeCommand = remoteLoginShellCommand(perSessionRemote);
  } else if (mode === 'claude') {
    // Deterministic conversation pinning for SSH-remote claude (mirrors the
    // docker-claude shape in claudeDockerPaneCommand, INCLUDING the distinct
    // resumeId branch it declares — this used to only mirror the same-id
    // fallback shape, silently dropping an explicit resumeSessionId that
    // differs from sessionId, e.g. a resume-from-history launch): the FIRST
    // run creates the conversation under --session-id <sessionId>; a respawn
    // / reattach re-runs the same idempotent command, --session-id exits
    // non-zero ("already in use"), and the `||` fallback RESUMES that same
    // conversation. Without a pinned id, every reattach relaunched a bare
    // `claude` and started a NEW conversation (found live 2026-08-29: remote
    // claude ctrl-d / ctrl-c relaunched a fresh session). A per-host
    // `commands.claude` override stays authoritative (admin's explicit
    // choice) and skips this entirely.
    const permFlags = buildClaudePermissionFlags(claudeMode, allowedTools);
    const cmd = `claude${permFlags}`;
    // Defense in depth, mirroring claudeDockerPaneCommand's own belt-and-braces check:
    // sessionId is server-minted and always safe in practice, but this command is built
    // as a single shellescaped string and then executed as shell code on the remote
    // host, so an unsafe value here is validated rather than trusted.
    if (!RESUME_ID_SAFE.test(sessionId)) {
      modeCommand = remoteLoginShellCommand(cmd);
    } else {
      const rid = resumeSessionId && RESUME_ID_SAFE.test(resumeSessionId) ? resumeSessionId : undefined;
      modeCommand = remoteLoginShellCommand(
        rid && rid !== sessionId
          ? `${cmd} --resume ${rid} || ${cmd} --session-id ${sessionId}`
          : `${cmd} --session-id ${sessionId} || ${cmd} --resume ${sessionId}`
      );
    }
  } else if (mode === 'omp') {
    // Remote OMP respawn must RESUME the same conversation instead of
    // relaunching fresh (found live 2026-08-29: remote ctrl-c/ctrl-d relaunched
    // a brand-new omp session). The pinned id, when known, is passed as an
    // explicit --resume; otherwise fall back to omp's own "most recent"
    // --continue so a dead-pane respawn still lands back in the conversation.
    // Rendered through the CLI registry (buildSpawnCommandFromRegistry), the
    // SAME mode-agnostic path local/docker spawns use — not appendResumeFlag(),
    // which would hand the id to the login shell as $0 after the quoted `-c
    // 'omp'`, and not a raw buildOmpCommand() call, which the registry refactor
    // (#347) deleted. Gives every registry CLI with a resume form this
    // behaviour for free, and the flags can't drift from the local builder.
    const ompEntry = getCli('omp');
    const ompCmd = ompEntry
      ? (buildSpawnCommandFromRegistry(ompEntry, {
          mode: 'omp',
          sessionId,
          ompConfig: {
            ...ompConfig,
            resumeSessionId: resumeSessionId || ompConfig?.resumeSessionId,
          },
        }) ?? 'omp')
      : 'omp';
    modeCommand = remoteLoginShellCommand(ompCmd);
  } else {
    modeCommand = defaultRemoteCommandForMode(mode);
  }
  const remoteName = remoteTmuxSessionName(sessionId);

  // Innermost: the command tmux runs in the new pane. Run via `/bin/sh -c` by
  // tmux, so the path needs shell-quoting here. `exec` replaces the shell with
  // the CLI so the pane PID is the agent itself.
  // Remote user-env sourcing is handled upstream by `defaultRemoteCommandForMode`
  // / `remoteLoginShellCommand` (`$SHELL -i -l -c`), so agent commands here already
  // cary the remote user's shell env; a per-host override stays authoritative.
  const paneCommand = `cd ${shellescape(remote.remotePath)} && ${withRemotePathBootstrap(modeCommand)}`;

  // The tmux command line, with `\;` separating commands so the config `set`s
  // apply on the SAME connection (and are idempotent on reattach). Options are
  // scoped per-session (`set -t <name>` / server `set -s`), NEVER `-g`, so a
  // shared remote tmux server's other sessions keep their own prefix/mouse.
  //
  // COD-180 — the remote tmux history is the CANONICAL scrollback for a remote
  // session (the local wrapper accumulates none: nested tmux repaints in place).
  // Without an explicit history-limit the remote server runs the tmux default
  // (2000 lines) and long sessions silently lose their oldest history.
  //
  // COD-180 — history-limit is the ONE option that stays `-g`, and it must run
  // BEFORE new-session: a session option cannot be scoped to a session that does
  // not exist yet, and applying it afterwards only affects panes created later,
  // leaving the pane we just made on tmux's 2000-line default. Unlike
  // prefix/mouse/status it changes no interactive behavior of a sibling session —
  // only the scrollback budget of panes created from here on.
  // COD-471: a CLI that reads tmux's `mouse` option once at startup to decide whether to capture
  // the mouse (registry `overlays.remote.tmuxMouseAtStartupSeconds`, codex) starts with the
  // session `mouse on`, then a delayed `run-shell -C` (a tmux command, no shell, needs tmux >= 3.2
  // like remain-on-exit `failed` below) switches it off, which is where every other remote
  // session sits. `-b` keeps the delay from holding the rest of the chain.
  const remoteOverlay = getCli(mode)?.overlays.remote;
  const mouseAtStartup =
    remoteOverlay && !('disabled' in remoteOverlay) ? remoteOverlay.tmuxMouseAtStartupSeconds : undefined;
  const mouseCommands =
    mouseAtStartup && Number.isInteger(mouseAtStartup) && mouseAtStartup > 0
      ? [
          `set -t ${remoteName} mouse on`,
          `run-shell -b -d ${mouseAtStartup} -C ${shellescape(`set -t ${remoteName} mouse off`)}`,
        ]
      : [`set -t ${remoteName} mouse off`];
  const historyLimitPrefix =
    historyLimit && Number.isFinite(historyLimit) ? [`set -g history-limit ${Math.floor(historyLimit)}`] : [];
  const tmuxInvocation = withRemotePathBootstrap(
    [
      `tmux -L ${REMOTE_TMUX_SOCKET} ${[...historyLimitPrefix, `new-session -A -s ${remoteName} -c ${shellescape(remote.remotePath)} ${shellescape(paneCommand)}`].join(' \\; ')}`,
      `set -t ${remoteName} status off`,
      ...mouseCommands,
      `set -t ${remoteName} prefix C-q`,
      'set -s escape-time 0',
      // COD-106 — shared/collaborative sessions: tmux defaults to sizing a window
      // to the SMALLEST attached client, so two Codemans at different viewports
      // would fight (clamp to the smaller). `window-size latest` sizes to the
      // most-recently-active client instead, so concurrent clients coexist.
      // Per-session scoped (`set -t <name>`, matching #145's hardening) so a shared
      // remote tmux server's other sessions keep their own sizing behavior.
      `set -t ${remoteName} window-size latest`,
      // #210: keep a CRASHED pane so the failure is still on screen. Without this,
      // tmux destroys the pane -> window -> session (and, being the only session,
      // the whole remote server) the instant the pane command exits, which tears the
      // local `ssh -t` attach down with it; reconnect's `-A` then builds a fresh
      // session and the cycle can repeat as a flap loop with no evidence surviving.
      // That is how the exit-127 PATH bug fixed above stayed invisible.
      //
      // `failed`, NOT `on`: `on` keeps the pane on a CLEAN exit too, so typing
      // `exit` in a remote shell leaves a dead pane behind, the session outlives it,
      // and the next launch's `-A` reattaches to that corpse ("Pane is dead (status
      // 0)") instead of starting a shell — verified against a real tmux. `failed`
      // keeps the pane only on a non-zero exit, which is exactly the diagnostic case.
      //
      // LAST in the chain on purpose: tmux aborts the remaining commands of a `\;`
      // sequence once one errors (also verified), and `failed` needs tmux >= 3.2 on
      // the REMOTE host. Trailing, a rejection costs only this option; leading, it
      // would silently drop status/mouse/prefix/escape-time/window-size with it.
      `set -t ${remoteName} remain-on-exit failed`,
    ].join(' \\; ')
  );

  // ssh runs its trailing args through the remote login shell, so the entire
  // tmux invocation is passed as one shell-quoted argument.
  //
  // COD-107 — connection options (port, identity, SOCKS ProxyCommand, jump host,
  // arbitrary -o) come from the shared `buildSshConnectionArgs` so the launch and
  // the tmux-prereq probe connect IDENTICALLY. The shared builder includes the
  // bounded connection timeout; `-t` follows all connection options.
  const [ssh, ...connectionArgs] = buildSshConnectionArgs(remote);
  const sshParts = [ssh, ...connectionArgs, '-t', remoteSshTarget(remote), shellescape(tmuxInvocation)];
  return sshParts.join(' ');
}

/**
 * COD-105 — build the SSH command that ATTACHES to an EXISTING `codeman-*` tmux
 * session on the remote host (one this Codeman didn't create — discovered via
 * `listRemoteCodemanSessions`). Sibling of `buildRemoteLaunchCommand`.
 *
 * Emits:
 *   ssh -o BatchMode=yes -t [<COD-107 connection opts>] user@host \
 *     'tmux -L codeman attach -t <session>'
 *
 * - `attach` (NOT `new-session -A`) so we only join an existing session; the
 *   remote session keeps running independent of us, which is exactly why the
 *   resulting Codeman session is NON-OWNED (see `SessionRemote.owned`): closing
 *   the local tab must detach, never `kill-session` the remote.
 * - The remote session name is shell-escaped so a value with metachars stays a
 *   single token inside the quoted tmux invocation.
 * - COD-107 — connection options (`-p`, `-i`, `-J`, SOCKS `-o ProxyCommand`,
 *   arbitrary `-o`) come from the shared `buildSshConnectionArgs`, so attach
 *   connects identically to launch / discovery / the prereq probe. `-t` follows
 *   the connection options (a PTY is required for interactive tmux).
 */
export function buildRemoteAttachCommand(remote: SessionRemote, remoteSessionName: string): string {
  const socket = remote.owned !== false ? REMOTE_TMUX_SOCKET : 'codeman';
  const tmuxInvocation = withRemotePathBootstrap(`tmux -L ${socket} attach -t ${shellescape(remoteSessionName)}`);
  const [ssh, ...connectionArgs] = buildSshConnectionArgs(remote);
  const sshParts = [ssh, ...connectionArgs, '-t', remoteSshTarget(remote), shellescape(tmuxInvocation)];
  return sshParts.join(' ');
}

/**
 * COD-109 — build the SSH command that KILLS an OWNED remote tmux session on the
 * host. COD-104 made remote sessions durable (they live in `tmux -L codeman` and
 * outlive the local pane), so tearing down the local pane only DETACHES; ending a
 * session we OWN requires propagating `kill-session` to the remote socket. No `-t`
 * (kill-session is non-interactive). Connection options come from the shared
 * `buildSshConnectionArgs` (COD-107), identical to launch/attach/discovery.
 */
export function buildRemoteKillCommand(remote: SessionRemote, remoteSessionName: string): string {
  const socket = remote.owned !== false ? REMOTE_TMUX_SOCKET : 'codeman';
  const tmuxInvocation = withRemotePathBootstrap(`tmux -L ${socket} kill-session -t ${shellescape(remoteSessionName)}`);
  const sshParts = [...buildSshConnectionArgs(remote), remoteSshTarget(remote), shellescape(tmuxInvocation)];
  return sshParts.join(' ');
}

/**
 * COD-105 — choose the right remote ssh command for a session's ownership:
 *   - NON-owned (`remote.owned === false`): ATTACH to a discovered remote tmux
 *     session by its EXISTING name (`remote.remoteSessionName`, falling back to
 *     this session's deterministic name). We only join — never create.
 *   - owned (default): LAUNCH/attach-or-create via `buildRemoteLaunchCommand`
 *     (COD-104), which we then own and may explicitly kill.
 */
function buildRemoteSessionCommand(
  mode: SessionMode,
  remote: SessionRemote,
  sessionId: string,
  options: {
    codexConfig?: CodexConfig;
    openCodeConfig?: OpenCodeConfig;
    geminiConfig?: GeminiConfig;
    antigravityConfig?: AntigravityConfig;
    historyLimit?: number;
    claudeMode?: ClaudeMode;
    allowedTools?: string;
    /** OMP only — resume/continue overrides for the remote omp relaunch (dead-pane respawn). */
    ompConfig?: OmpConfig;
    /** Pins the remote claude/omp conversation across a respawn or reattach. */
    resumeSessionId?: string;
  } = {}
): string {
  if (remote.owned === false || remote.remoteSessionName) {
    const target = remote.remoteSessionName || remoteTmuxSessionName(sessionId);
    return buildRemoteAttachCommand(remote, target);
  }
  return buildRemoteLaunchCommand({
    mode,
    remote,
    sessionId,
    codexConfig: options.codexConfig,
    openCodeConfig: options.openCodeConfig,
    geminiConfig: options.geminiConfig,
    antigravityConfig: options.antigravityConfig,
    claudeMode: options.claudeMode,
    allowedTools: options.allowedTools,
    historyLimit: options.historyLimit,
    ompConfig: options.ompConfig,
    resumeSessionId: options.resumeSessionId,
  });
}

// ========== Docker cases (COD-Docker) ==========
//
// The docker analog of the remote-SSH launch above. Instead of a local tmux pane
// running `ssh -t host 'tmux new-session …'`, it runs `docker exec -it <container>
// sh -lc 'tmux new-session …'` into a DURABLE in-container tmux server. The
// container is per-CASE, so many sessions `docker exec` into the same one. See
// docs/docker-cases-plan.md.

/**
 * DEDICATED in-container tmux socket. A Codeman running INSIDE the container uses
 * `-L codeman`; ours is `-L codeman-docker` with a `codeman-dkr-*` session name
 * that deliberately FAILS SAFE_MUX_NAME_PATTERN, so an in-container Codeman never
 * adopts/resizes/respawns our session (same defence as the remote socket).
 */
const DOCKER_TMUX_SOCKET = 'codeman-docker';
/**
 * Deterministic, reattach-stable in-container tmux session name. Derived from the
 * same stable field the local muxName uses (first 8 chars of the sessionId), so a
 * reconnect re-issues the exact same `new-session -A` and lands back in the SAME
 * in-container session. The `dkr` letters make it fail SAFE_MUX_NAME_PATTERN.
 */
export function dockerTmuxSessionName(sessionId: string): string {
  return `codeman-dkr-${sessionId.slice(0, 8)}`;
}

/** Resume ids are UUID-ish; reject anything with shell metacharacters (defensive). */
const RESUME_ID_SAFE = /^[A-Za-z0-9._-]+$/;

/**
 * Append the CLI-specific resume flag to a pane command (codex/gemini/antigravity). Only fires
 * when the in-container tmux is RE-CREATED (`new-session -A` makes the flag inert
 * on a live reattach), i.e. exactly when the previous live agent was lost and we
 * want to resume the conversation from the bind-mounted transcript. Claude mode
 * uses claudeDockerPaneCommand instead.
 */
function appendResumeFlag(modeCommand: string, mode: SessionMode, resumeId: string): string {
  if (!RESUME_ID_SAFE.test(resumeId)) return modeCommand;
  // `launch.resumeAppend` was DECLARED for exactly this function and read by nothing until now
  // — the switch it replaces was the hand-written copy. Absent = this CLI has no resume flag to
  // append (claude, shell, opencode), which is the old `default` arm.
  const spec = getCli(mode)?.launch.resumeAppend;
  if (!spec) return modeCommand;
  return spec.style === 'flag' ? `${modeCommand} ${spec.flag} ${resumeId}` : `${modeCommand} ${spec.token} ${resumeId}`;
}

/**
 * Claude-mode pane command with a DETERMINISTIC conversation id (the docker analog
 * of buildSpawnCommand's --resume/--session-id logic). A fresh launch passes
 * `--session-id <sessionId>`, so the in-container conversation id is knowable
 * host-side (resume-id capture + subagent/workflow correlation) WITHOUT relying on
 * hook reachability. When the in-container tmux was re-created after a container
 * stop/reboot, the same command re-runs against the surviving transcript:
 * `--session-id` exits 1 ("already in use") and the `||` fallback RESUMES that
 * conversation (verified CLI behavior). An explicit resumeId gets the local
 * builder's shape — resume first, session-id fallback — so a stale id never
 * dead-panes. The leading `exec ` is stripped: an exec'd first branch could never
 * fall back.
 */
function claudeDockerPaneCommand(modeCommand: string, sessionId: string, resumeId?: string): string {
  if (!RESUME_ID_SAFE.test(sessionId)) return modeCommand; // defensive — ids are server-minted uuids
  const cmd = modeCommand.replace(/^exec\s+/, '');
  const rid = resumeId && RESUME_ID_SAFE.test(resumeId) ? resumeId : undefined;
  if (rid && rid !== sessionId) {
    return `${cmd} --resume ${rid} || ${cmd} --session-id ${sessionId}`;
  }
  const cid = rid ?? sessionId;
  return `${cmd} --session-id ${cid} || ${cmd} --resume ${cid}`;
}

/** Fully-resolved inputs for buildDockerLaunchCommand (pure). */
export interface DockerLaunchOptions {
  mode: SessionMode;
  docker: SessionDocker;
  sessionId: string;
  resumeSessionId?: string;
  createContext: DockerCreateContext;
  /** exec-time inline env (non-secret): TERM, COLORTERM, CODEMAN_SESSION_ID, CODEMAN_MUX */
  execEnv: Record<string, string>;
  /** exec-time NAME-ONLY env forwarded from Codeman's process env (codex/gemini keys) */
  execEnvNames: string[];
  /**
   * Files to copy from read-only seed mounts into the container's writable HOME once
   * before launch (guarded so reconnects never clobber). Isolates Claude state: the
   * merged `~/.claude.json`, plus `~/.claude/.credentials.json` + `settings.json`,
   * are writable copies (not host mounts), so the container never re-auths and never
   * writes its runtime state back into the host `~/.claude`.
   */
  seedCopies?: DockerSeedCopy[];
}

/** The in-container resume policy this CLI declares, if any (`overlays.docker.resume`). */
function dockerResumePolicy(mode: SessionMode): CliDockerResume | undefined {
  const overlay = getCli(mode)?.overlays.docker;
  return overlay && !('disabled' in overlay) ? overlay.resume : undefined;
}

/**
 * Re-render a CLI's launch command carrying ONLY a resume id — the `style: 'rebuild'` docker
 * resume, for a CLI whose continuation is a first-class launch param rather than a token that
 * can be appended.
 *
 * ⚠️ Deliberately carries nothing else from the original session's config. This path exists for
 * a container whose in-container tmux was re-created, where the only thing being asked for is
 * "re-attach to that conversation"; inventing the rest of a config here would launch something
 * the user never configured.
 */
function renderResumeOnlyCommand(mode: SessionMode, sessionId: string, resumeId: string): string | undefined {
  const entry = getCli(mode);
  if (!entry) return undefined;
  const field = entry.launch.legacyConfigField;
  const resumeKey = entry.launch.legacyConfigAliases?.resumeId ?? 'resumeId';
  const config = { [resumeKey]: resumeId };
  return buildSpawnCommandFromRegistry(entry, {
    mode,
    sessionId,
    ...(field ? { [field]: config } : config),
  } as unknown as SpawnBridgeOptions);
}

/**
 * Build the ONE `bash -c` launch string for a docker session: image-check ->
 * ensure (inspect-or-create) -> start -> `exec docker exec -it` into the durable
 * in-container tmux (resume-aware). PURE and unit-testable. The escaping survives
 * four layers: outer `bash -c "…"` (JSON.stringify at respawn-pane) -> the joined
 * command -> `docker exec … sh -lc '<tmux>'` -> tmux `'<paneCommand>'`.
 */
export function buildDockerLaunchCommand(opts: DockerLaunchOptions): string {
  const { mode, docker, sessionId, resumeSessionId, createContext, execEnv, execEnvNames, seedCopies } = opts;
  const base = buildDockerBaseArgs(docker).join(' ');
  // ADOPTED container (docker.owned === false): the user built it and runs it, so
  // this chain may only LOOK and then exec. No image check (the image is theirs),
  // no create, and above all no `start` — starting a container we do not own is
  // exactly the lifecycle mutation adoption promises never to perform. A missing
  // or stopped container fails closed with an actionable message instead.
  const adopted = docker.owned === false;
  // Built lazily: an adopted case has no meaningful create-config, so computing
  // create args for it would demand a context the adopt path never assembles.
  const createArgs = adopted ? '' : buildDockerCreateArgs(createContext).join(' ');
  const name = shellescape(docker.containerName);
  const workdir = shellescape(docker.containerWorkdir);
  const image = shellescape(docker.image);
  const dkrName = dockerTmuxSessionName(sessionId);
  const sid = sessionId.slice(0, 8);

  let modeCommand =
    docker.commands?.[mode as DockerCommandMode] || defaultDockerCommandForMode(mode, !!docker.runsAsRoot);
  if (mode === 'claude') {
    modeCommand = claudeDockerPaneCommand(modeCommand, sessionId, resumeSessionId);
  } else if (resumeSessionId) {
    // COD-416 wave 3e: HOW a resume reaches an in-container pane is registry DATA
    // (`overlays.docker.resume`), not two id-checks. Three shapes, and the default is the
    // plain append every flag-style CLI has always used:
    //   - `refuseWhenOverridden` + the case supplied its own `commands.<mode>` -> refuse. The
    //     override is opaque text; appending to it or replacing it would silently start a
    //     fresh conversation, which is the one outcome a resume must never produce.
    //   - `style: 'rebuild'` -> re-render from the launch spec with only the resume param set,
    //     for a CLI whose resume IS a launch param (opencode's `--session`).
    //   - anything else -> append `launch.resumeAppend` to the already-built command.
    const resume = dockerResumePolicy(mode);
    const overridden = docker.commands?.[mode as DockerCommandMode] !== undefined;
    if (resume?.refuseWhenOverridden && overridden) throw new ManualRecoveryRequiredError();
    if (resume?.style === 'rebuild') {
      modeCommand = renderResumeOnlyCommand(mode, sessionId, resumeSessionId) ?? modeCommand;
    } else {
      modeCommand = appendResumeFlag(modeCommand, mode, resumeSessionId);
    }
  }
  // Run by tmux via /bin/sh -c, so the path is shell-quoted here. `exec` makes the
  // pane PID the agent itself.
  const paneCommand = `cd ${workdir} && ${modeCommand}`;

  // `setenv -g` primes the session id so reattaches / newly-created panes inherit
  // it. `new-session -A` = attach-or-create (idempotent + resume-aware). Options
  // are scoped per-session (`set -t`) or server (`set -s`), never `-g`, so a shared
  // in-container tmux server's other sessions keep their own prefix/mouse.
  const tmuxInvocation = [
    `tmux -L ${DOCKER_TMUX_SOCKET} setenv -g CODEMAN_SESSION_ID ${shellescape(sid)}`,
    'setenv -g CODEMAN_MUX 1',
    `new-session -A -s ${dkrName} -c ${workdir} ${shellescape(paneCommand)}`,
    `set -t ${dkrName} status off`,
    `set -t ${dkrName} mouse off`,
    `set -t ${dkrName} prefix C-q`,
    'set -s escape-time 0',
  ].join(' \\; ');

  const execEnvFlags: string[] = [];
  for (const [k, v] of Object.entries(execEnv)) execEnvFlags.push('--env', shellescape(`${k}=${v}`));
  // NAME-ONLY forwards: docker reads the VALUE from Codeman's own process env, so
  // the secret never appears in argv (no `ps` leak) and is not committed.
  for (const n of execEnvNames) execEnvFlags.push('--env', n);
  for (const extra of docker.extraExecArgs ?? []) execEnvFlags.push(shellescape(extra));

  const imageMissingMsg = shellescape(
    `Codeman: base image ${docker.image} not present (it is normally auto-built on first use)`
  );
  const startFailMsg = shellescape(`Codeman: container ${docker.containerName} failed to start (docker daemon down?)`);

  const notFoundMsg = shellescape(
    `Codeman: container ${docker.containerName} not found. Adopted containers are never created by Codeman - start it yourself, then reopen this session.`
  );
  const notRunningMsg = shellescape(
    `Codeman: container ${docker.containerName} is not running. Codeman never starts a container it does not own - start it yourself, then reopen this session.`
  );

  const imageCheck = adopted
    ? ''
    : `${base} image inspect ${image} >/dev/null 2>&1 || { echo ${imageMissingMsg}; exit 1; }`;
  // create-if-missing (idempotent): reconnect / boot recovery re-runs this exact
  // chain. A daemon without swap accounting warns whenever --memory is present,
  // even when --memory-swap is omitted. In compatibility mode, retain the memory
  // cap and filter ONLY that exact warning; all other stdout/stderr and the real
  // create exit status are preserved so mount/config failures remain visible.
  // A session-unique file avoids shell variables and command substitution, both
  // of which would be expanded too early by the nested bash/tmux launch layers.
  const createOutputPath = shellescape(`/tmp/codeman-create-${sessionId}.log`);
  const filteredCreateOutput = `sed '/^WARNING: Your kernel does not support swap limit capabilities or the cgroup is not mounted\\. Memory limited without swap\\.$/d' ${createOutputPath}`;
  const removeCreateOutput = `rm -f ${createOutputPath}`;
  const createCommand = createContext.disableSwapLimit
    ? `{ if ${base} ${createArgs} >${createOutputPath} 2>&1; ` +
      `then ${filteredCreateOutput}; ${removeCreateOutput}; ` +
      `elif ${base} inspect ${name} >/dev/null 2>&1; then ${removeCreateOutput}; ` +
      `else ${filteredCreateOutput} >&2; ${removeCreateOutput}; false; fi; }`
    : `${base} ${createArgs}`;
  const ensure = adopted
    ? `${base} inspect ${name} >/dev/null 2>&1 || { echo ${notFoundMsg}; exit 1; }`
    : `${base} inspect ${name} >/dev/null 2>&1 || ${createCommand}`;
  // ⚠️ No double quotes and no `$(…)` here. This whole chain is embedded in an
  // outer `bash -c "…"`, so an unescaped `"` closes that string early, the rest
  // is re-tokenized, and tmux fails to exec with a bare `execvp(3) failed`. A
  // `grep -qx` pipeline reads the same answer using only the single-quoted form
  // every other line in this builder already uses.
  const start = adopted
    ? `${base} inspect -f ${shellescape('{{.State.Running}}')} ${name} 2>/dev/null | grep -qx true || { echo ${notRunningMsg}; exit 1; }`
    : `${base} start ${name} >/dev/null 2>&1 || { echo ${startFailMsg}; exit 1; }`;
  // Seed writable credential config from read-only host mounts ONCE per container
  // (guarded by [ -e ] so reconnects never clobber in-container config; `cp -a` for
  // whole-dir credential seeds). mkdir -p the parent so a file seed works even when
  // no sibling share-mount pre-created the dir. Paths are fixed CONTAINER_HOME
  // constants (no shell metachars), so the whole inner command is shell-quoted once.
  // An ADOPTED container gets NO seed copies: those read from create-time
  // read-only mounts that do not exist here, and writing host credentials into a
  // container the user owns is a mutation adoption does not permit. Its CLIs must
  // already be authenticated inside it.
  const seedSteps = (adopted ? [] : (seedCopies ?? [])).map((s) => {
    const cp = s.recursive ? 'cp -a' : 'cp';
    const parent = s.to.slice(0, s.to.lastIndexOf('/'));
    return `mkdir -p ${parent} 2>/dev/null; [ -e ${s.to} ] || ${cp} ${s.from} ${s.to} 2>/dev/null || true`;
  });
  const innerCmd = seedSteps.length ? `${seedSteps.join(' ; ')} ; ${tmuxInvocation}` : tmuxInvocation;
  const execCmd = `exec ${base} exec -it --workdir ${workdir} ${execEnvFlags.join(' ')} ${name} sh -lc ${shellescape(innerCmd)}`;

  return [imageCheck, ensure, start, execCmd].filter(Boolean).join(' ; ');
}

/**
 * Kill ONLY this session's in-container tmux session. The container is shared by
 * the case's other sessions, so this NEVER `docker stop`s it — stopping/removing
 * the container is an explicit teardown (buildDockerStopCommand) or case-delete
 * (buildDockerRemoveCommand). Fired best-effort on session kill.
 */
export function buildDockerKillCommand(options: { docker: SessionDocker; sessionId: string }): string {
  const { docker, sessionId } = options;
  const base = buildDockerBaseArgs(docker).join(' ');
  const dkrName = dockerTmuxSessionName(sessionId);
  return `${base} exec ${shellescape(docker.containerName)} tmux -L ${DOCKER_TMUX_SOCKET} kill-session -t ${shellescape(dkrName)}`;
}

/**
 * Guard for the two builders that mutate CONTAINER lifecycle. They are pure
 * string builders, so refusing here means an adopted container cannot even have
 * a stop/remove command constructed for it — there is no shape of caller bug
 * that turns into a `docker stop`/`rm` on something we do not own.
 */
function assertOwnedContainer(docker: SessionDocker, action: string): void {
  if (docker.owned === false) {
    throw new Error(
      `Refusing to ${action} adopted container "${docker.containerName}": Codeman does not own its lifecycle.`
    );
  }
}

/** Explicit container stop (frees RAM/CPU; conversation resumes on next launch via --resume). */
export function buildDockerStopCommand(docker: SessionDocker): string {
  assertOwnedContainer(docker, 'stop');
  return `${buildDockerBaseArgs(docker).join(' ')} stop -t 10 ${shellescape(docker.containerName)}`;
}

/** Explicit container removal (case-delete). Destroys in-image state; bind mounts survive. */
export function buildDockerRemoveCommand(docker: SessionDocker): string {
  assertOwnedContainer(docker, 'remove');
  return `${buildDockerBaseArgs(docker).join(' ')} rm -f ${shellescape(docker.containerName)}`;
}

/**
 * Resolve the environment-dependent bits of a docker launch (host uid, existing
 * credential mounts, derived api url, hook-secret mount, Desktop detection) into
 * the pure buildDockerLaunchCommand inputs. IO; only ever called from the real
 * launch path (createSession/respawnPane no-op under VITEST).
 */
export function resolveDockerLaunchOptions(
  mode: SessionMode,
  docker: SessionDocker,
  sessionId: string,
  resumeSessionId?: string
): DockerLaunchOptions {
  const home = homedir();
  const isDesktop = process.platform === 'darwin'; // Docker Desktop translates uids + native host.docker.internal
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  const userArgs: string[] =
    docker.engine === 'podman'
      ? ['--userns=keep-id'] // rootless podman: map host uid to the image `agent` uid
      : isDesktop
        ? [] // Desktop: run as the image's baked uid (a mac uid wouldn't own /home/agent)
        : ['--user', `${uid}:0`]; // Linux: host uid + GID 0 (OpenShift arbitrary-uid writable HOME)
  const gatewayAlias = hostGatewayAlias(docker.engine);

  const credentialMounts: DockerMount[] = [];
  const extraMounts: DockerMount[] = [];
  // Isolated credential state (Claude + codex/gemini/gcloud/opencode): each store
  // shares ONLY what a host feature / --resume needs (Claude projects/, codex
  // sessions/+history) and seeds everything else (tokens, settings, configs) as
  // writable copies, so the container is authed WITHOUT re-auth and WITHOUT writing
  // its runtime state back into the host dirs. Only when credentials are mounted.
  let seedCopies: DockerSeedCopy[] = [];
  if (docker.mountCredentials) {
    const claudeArtifacts = resolveDockerClaudeArtifacts(home, docker.containerName, docker.containerWorkdir);
    const credArtifacts = resolveDockerCredentialArtifacts(home);
    extraMounts.push(...claudeArtifacts.mounts, ...credArtifacts.mounts);
    seedCopies = [...claudeArtifacts.seedCopies, ...credArtifacts.seedCopies];
  }
  const envCreate: Record<string, string> = {
    HOME: CONTAINER_HOME,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    // Force a UTF-8 locale (the base image defaults to POSIX/C). Without this, tmux
    // runs in non-UTF-8 mode and renders Claude's Unicode box-drawing (─│┌┐) as raw
    // VT100 ACS glyphs (`qqqq…`). `C.UTF-8` is built into glibc (no locale-gen).
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    // Give claude a temp dir it will own inside HOME. Its default `/tmp/claude-<uid>`
    // is refused when that path pre-exists root-owned — which happens when the
    // workspace bind-mount path traverses it (e.g. a workspace under /tmp/claude-<uid>).
    // A nonexistent HOME subpath is created+owned by the running uid, so this is robust
    // to any workspace location. Non-secret path, safe to be committed on export.
    CLAUDE_CODE_TMPDIR: `${CONTAINER_HOME}/.cache/codeman-claude-tmp`,
  };
  if (docker.hooksEnabled) {
    // Derive a container-reachable API url (scheme + port preserved; host swapped
    // for the engine gateway alias). Prod is HTTPS on 3000.
    envCreate.CODEMAN_API_URL = containerApiUrl(process.env.CODEMAN_API_URL, docker.engine);
    const hookSecretPath = dataPath('hook-secret');
    if (existsSync(hookSecretPath)) {
      const dst = `${CONTAINER_HOME}/.codeman/hook-secret`;
      extraMounts.push({ src: hookSecretPath, dst, readonly: true });
      envCreate.CODEMAN_HOOK_SECRET_FILE = dst; // a path is non-secret; the bytes ride the bind mount
    }
  }

  const createContext: DockerCreateContext = {
    docker,
    sessionId,
    instance: CODEMAN_INSTANCE,
    userArgs,
    credentialMounts: credentialMounts.map((mount) => ({
      ...mount,
      src: resolveDockerDaemonMountSource(mount.src, home, process.env.CODEMAN_DOCKER_HOST_HOME),
    })),
    extraMounts: extraMounts.map((mount) => ({
      ...mount,
      src: resolveDockerDaemonMountSource(mount.src, home, process.env.CODEMAN_DOCKER_HOST_HOME),
    })),
    envCreate,
    addHostGateway: !isDesktop,
    gatewayAlias,
    disableSwapLimit: process.env.CODEMAN_DOCKER_DISABLE_SWAP_LIMIT === '1',
  };

  const execEnv: Record<string, string> = {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    // UTF-8 at exec time too, so the tmux CLIENT this exec launches is UTF-8 and
    // renders box-drawing correctly even when reattaching to a container created
    // before this fix (client_utf8 is per-client, resolved from the exec's locale).
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    CODEMAN_SESSION_ID: sessionId.slice(0, 8),
    CODEMAN_MUX: '1',
  };
  // NAME-ONLY exec env forwarded from Codeman's process env (the docker client
  // inherits it), so API-key CLIs get their key without it appearing in argv.
  // COD-416 wave 3e: `env.dockerExecEnvNames` has always declared exactly this list per CLI;
  // the two-arm conditional was a second copy of it.
  const execEnvNames = getCli(mode)?.env.dockerExecEnvNames ?? [];

  return { mode, docker, sessionId, resumeSessionId, createContext, execEnv, execEnvNames, seedCopies };
}

/**
 * PURE: the `tmux setenv` pairs a session in this mode needs, in issue order.
 *
 * Extracted so the DECISION (which vars, from where, with what validation) is unit-testable
 * without a tmux socket — the four hand-written `set<Cli>EnvVars` helpers this replaces were
 * async side-effect loops, so nothing could assert what they would set.
 *
 * Three sources, all registry DATA:
 *   1. `env.tmuxSetenvKeys` — names forwarded from the SERVER's own environment (secrets).
 *   2. `env.configSetenv`   — values the CALLER supplied, re-validated against the declared
 *      ParamSpec by `configSetenvValues()`. For dsh the value IS a permission level, so a
 *      builder must never trust its caller here.
 *   3. `env.configContentVar` — a JSON blob pushed as one var (opencode's config content).
 *
 * ⚠️ `env.setenvProfile` is deliberately NOT here: it writes an executable shim to disk and
 * needs the resulting path, which is a side effect a pure planner must not perform.
 */
export function planCliEnvSetenv(
  entry: CliEntry,
  legacyConfig: Record<string, unknown> | undefined,
  serverEnv: NodeJS.ProcessEnv = process.env
): Array<{ key: string; value: string }> {
  const pairs: Array<{ key: string; value: string }> = [];
  for (const key of entry.env.tmuxSetenvKeys) {
    const val = serverEnv[key];
    if (val) pairs.push({ key, value: val });
  }
  for (const [key, value] of Object.entries(configSetenvValues(entry, legacyConfig))) {
    pairs.push({ key, value: String(value) });
  }
  const contentVar = entry.env.configContentVar;
  if (contentVar) {
    const content = resolveConfigContent(legacyConfig);
    if (content) pairs.push({ key: contentVar, value: content });
  }
  return pairs;
}

/**
 * PURE: opencode's `OPENCODE_CONFIG_CONTENT` blob, or undefined when there is nothing to set.
 *
 * `autoAllowTools` layers a blanket allow OVER any caller JSON (the caller's keys merge in
 * first, then `permission` is forced), and invalid caller JSON is REFUSED rather than passed
 * through — a malformed blob would otherwise reach the CLI as config.
 */
function resolveConfigContent(legacyConfig: Record<string, unknown> | undefined): string | undefined {
  const autoAllow = legacyConfig?.autoAllowTools === true;
  const raw = typeof legacyConfig?.configContent === 'string' ? legacyConfig.configContent : undefined;
  if (autoAllow) {
    const permConfig: Record<string, unknown> = { permission: { '*': 'allow' } };
    if (raw) {
      try {
        Object.assign(permConfig, JSON.parse(raw) as Record<string, unknown>);
        permConfig.permission = { '*': 'allow' };
      } catch {
        /* invalid JSON, use default permConfig */
      }
    }
    return JSON.stringify(permConfig);
  }
  if (!raw) return undefined;
  try {
    JSON.parse(raw);
    return raw;
  } catch {
    console.error('[TmuxManager] Invalid JSON in openCodeConfig.configContent, skipping');
    return undefined;
  }
}

/**
 * Issue one `tmux setenv`. Values stay off the bash command line (invisible in `ps`).
 *
 * ⚠️ execAsync, NEVER execSync. COD-212 converted exactly these paths off the sync helper
 * because a blocking spawn during session create froze `/api/status` for a measured 5.08s
 * (23.7s event-loop lag in the prod journal). Upstream's generic helper is synchronous;
 * adopting it as-is silently reverts that fix.
 */
async function setTmuxEnvVar(tmuxCmd: string, muxName: string, key: string, value: string): Promise<void> {
  const escaped = value.replace(/'/g, "'\\''");
  try {
    await execAsync(`${tmuxCmd} setenv -t '${muxName}' ${key} '${escaped}'`, {
      encoding: 'utf8',
      timeout: EXEC_TIMEOUT_MS,
    });
  } catch {
    /* Non-critical — the key may not be needed */
  }
}

/**
 * Pure: the extra env-export lines that route a session through the Headroom
 * proxy. Claude-only (the proxy fronts Anthropic for Claude); other modes get
 * nothing here. `headroomClaudeUrl` is resolved by the caller via
 * resolveHeadroomClaudeBaseUrl() (config + health gate) -- undefined => no routing.
 */
export function buildHeadroomExports(mode: SessionMode, headroomClaudeUrl?: string): string[] {
  if (mode === 'claude' && headroomClaudeUrl) {
    return [`export ANTHROPIC_BASE_URL=${shellescape(headroomClaudeUrl)}`];
  }
  return [];
}

interface WindowResizeRequest {
  cols: number;
  rows: number;
  onComplete?: (success: boolean) => void;
  completed: boolean;
}

/**
 * Manages tmux sessions that wrap Claude CLI or shell processes.
 *
 * Implements the TerminalMultiplexer interface.
 *
 * @example
 * ```typescript
 * const manager = new TmuxManager();
 *
 * // Create a tmux session for Claude
 * const session = await manager.createSession({ sessionId, workingDir: '/project', mode: 'claude' });
 *
 * // Send input (single command, no delay!)
 * manager.sendInput(sessionId, '/clear\r');
 *
 * // Kill when done
 * await manager.killSession(sessionId);
 * ```
 */
export class TmuxManager extends EventEmitter implements TerminalMultiplexer {
  readonly backend = 'tmux' as const;
  private sessions: Map<string, MuxSession> = new Map();
  private readonly tmuxSocket = resolveConfiguredTmuxSocket();
  private statsInterval: NodeJS.Timeout | null = null;
  private mouseSyncInterval: NodeJS.Timeout | null = null;
  /** Track last-known pane count per session to avoid unnecessary tmux set-option calls */
  private lastPaneCount: Map<string, number> = new Map();
  private readonly pendingWindowResizes = new Map<
    string,
    {
      generation: number;
      running: boolean;
      active: WindowResizeRequest | null;
      pending: WindowResizeRequest | null;
      cancelled: boolean;
    }
  >();
  private windowResizeGeneration = 0;
  /**
   * muxName → the exited agent the pane-exit watcher last observed
   * (Ark0N/Codeman#446). Absence is the UNKNOWN arm of the tri-state, so an
   * entry goes the moment tmux stops reporting the pane dead, and the map is
   * empty until the first read runs. The manager reports what tmux says and
   * nothing more: the scoping that hides this for remote and docker sessions
   * lives on `Session`, because the remote-reconnect watcher above needs the
   * raw pane reading.
   */
  private paneExits: Map<string, TrackedPaneExit> = new Map();
  /** The pane-exit watcher's own interval. Runs whether or not stats are on. */
  private paneExitInterval: NodeJS.Timeout | null = null;
  /**
   * True while a pane read is in flight. `EXEC_TIMEOUT_MS` is 5000 ms against a
   * poll interval of 2000 ms, so without this a slow read overlaps the next two
   * and the older one can resolve last and win.
   */
  private paneExitReadInFlight = false;
  /**
   * Bumped by every deliberate {@link clearPaneExit}. A read that started before
   * a clear carries the older generation and is discarded rather than writing
   * the death back over the pane that has just replaced it.
   */
  private paneExitGeneration = 0;

  // ── COD-108 remote-reconnect watcher state ────────────────────────────────
  /** Periodic watcher that re-establishes dropped remote sessions. */
  private remoteReconnectInterval: NodeJS.Timeout | null = null;
  /** Per-session backoff/attempt bookkeeping (sessionId → state). */
  private reconnectState: Map<string, RemoteReconnectState> = new Map();
  /**
   * Sessions excluded from auto-reconnect because they are being intentionally
   * torn down (killed/detached/stopping). A guarded session is NEVER revived.
   */
  private reconnectGuard: Set<string> = new Set();
  /**
   * Cached result of the remote tmux `has-session` probe (sessionId → alive).
   * `true` = the durable remote tmux session exists (transport drop → reconnect
   * is safe); `false` = remote session gone (agent exited cleanly → do NOT
   * reconnect); `undefined` = not yet probed / probe failed. Only sessions
   * whose pane is otherwise dead+eligible get probed, so a clean exit tears
   * down the remote tmux and the probe reports false — killing the auto-revive
   * (found live 2026-08-29: remote omp/opencode ctrl-c/ctrl-d auto-respawned
   * fresh agents because the watcher couldn't tell a clean exit from a
   * transport drop).
   */
  private remoteAliveCache: Map<string, boolean | undefined> = new Map();
  /**
   * Sessions with a `has-session` probe currently in flight. The probe is a
   * fire-and-forget ssh round-trip with a 15s timeout against a 5s tick, so
   * without this an unreachable host would accumulate three overlapping ssh
   * processes per dead session.
   */
  private remoteAliveInFlight: Set<string> = new Set();

  private trueColorConfigured = false;
  private readonly checkpointExecutor?: (command: string) => Promise<void>;
  private readonly checkpointDelayMs: number;
  private readonly notesExecutor?: (file: string, args: string[]) => Promise<void>;
  private readonly notesDelayMs: number;
  private readonly paneTextExecutor: TmuxPaneTextExecutor;
  /** tmux 3.7+ can resize pane history after creation; older releases cannot. */
  private liveHistoryResizeSupported: boolean | null = null;
  private readonly remoteFrameSshPool = new RemoteFrameSshPool();
  /** COD-463: skips blocking ssh captures for a host whose transport just timed out. */
  private readonly remoteCaptureBackoff = new RemoteCaptureBackoff();

  constructor(
    options: {
      checkpointExecutor?: (command: string) => Promise<void>;
      checkpointDelayMs?: number;
      notesExecutor?: (file: string, args: string[]) => Promise<void>;
      notesDelayMs?: number;
      paneTextExecutor?: TmuxPaneTextExecutor;
    } = {}
  ) {
    super();
    this.checkpointExecutor = options.checkpointExecutor;
    this.checkpointDelayMs = options.checkpointDelayMs ?? 50;
    this.notesExecutor = options.notesExecutor;
    this.notesDelayMs = options.notesDelayMs ?? 50;
    this.paneTextExecutor = options.paneTextExecutor ?? executePaneTextCapture;
    this.setMaxListeners(50);
    if (!IS_TEST_MODE) {
      this.loadSessions();
    }
  }

  /** The dedicated tmux socket all Codeman sessions live on (see {@link TerminalMultiplexer.muxSocket}). */
  get muxSocket(): string {
    return this.tmuxSocket;
  }

  private tmux(): string {
    return tmuxCommand(this.tmuxSocket);
  }

  private supportsLiveHistoryResize(): boolean {
    if (this.liveHistoryResizeSupported !== null) return this.liveHistoryResizeSupported;

    try {
      const output = execSync(`${this.tmux()} -V`, {
        encoding: 'utf8',
        timeout: EXEC_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const match = output.match(/(?:^|\D)(\d+)\.(\d+)/);
      const major = match ? Number(match[1]) : 0;
      const minor = match ? Number(match[2]) : 0;
      this.liveHistoryResizeSupported = major > 3 || (major === 3 && minor >= 7);
    } catch {
      // Unknown versions take the legacy path required by tmux <3.7.
      this.liveHistoryResizeSupported = false;
    }
    return this.liveHistoryResizeSupported;
  }

  // Load saved sessions from disk (NEVER called in test mode)
  private loadSessions(): void {
    if (IS_TEST_MODE) return;

    try {
      if (existsSync(MUX_SESSIONS_FILE)) {
        const content = readFileSync(MUX_SESSIONS_FILE, 'utf-8');
        const data = JSON.parse(content);
        if (Array.isArray(data)) {
          // Dedup by muxName: one live tmux session must map to exactly one
          // tracked entry. A per-session socket-tag mismatch could historically
          // let the same session be tracked twice — once under its real UUID and
          // once under a "restored-<id>" placeholder — surfacing as duplicate tabs.
          // Single-socket unification removed that failure mode; this pass stays
          // to clean any stale duplicates already on disk. Keep the real (UUID)
          // entry and drop placeholder twins.
          let dropped = 0;
          const keptByMuxName = new Map<string, string>(); // muxName -> kept sessionId
          for (const session of data) {
            // Strip the obsolete per-session tmuxSocket tag (now a process-wide
            // constant). Left in place it would be written back by saveSessions()
            // and linger on disk as a zombie field forever.
            delete (session as { tmuxSocket?: unknown }).tmuxSocket;
            const muxName: string | undefined = session.muxName;
            const priorId = muxName ? keptByMuxName.get(muxName) : undefined;
            if (priorId) {
              const incomingIsPlaceholder = String(session.sessionId).startsWith('restored-');
              const priorIsPlaceholder = priorId.startsWith('restored-');
              // Drop the incoming unless it's the real twin of a placeholder we kept.
              if (incomingIsPlaceholder || !priorIsPlaceholder) {
                dropped++;
                continue;
              }
              this.sessions.delete(priorId);
              dropped++;
            }
            this.sessions.set(session.sessionId, session);
            if (muxName) keptByMuxName.set(muxName, session.sessionId);
          }
          // Persist the cleaned list so the stale duplicates don't reload.
          if (dropped > 0) {
            console.log(`[TmuxManager] Dropped ${dropped} duplicate mux session record(s) on load`);
            this.saveSessions();
          }
        }
      }
    } catch (err) {
      console.error('[TmuxManager] Failed to load sessions:', err);
    }
  }

  /**
   * Save sessions to disk asynchronously. (NEVER writes in test mode)
   * Uses atomic temp+rename to prevent corruption on crash.
   */
  private saveSessions(): void {
    if (IS_TEST_MODE) return;

    try {
      const dir = dirname(MUX_SESSIONS_FILE);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const data = Array.from(this.sessions.values());
      const json = JSON.stringify(data, null, 2);

      const tempPath = MUX_SESSIONS_FILE + '.tmp';
      writeFile(tempPath, json, 'utf-8')
        .then(() => rename(tempPath, MUX_SESSIONS_FILE))
        .catch((err) => {
          console.error('[TmuxManager] Failed to save sessions:', err);
        });
    } catch (err) {
      console.error('[TmuxManager] Failed to save sessions:', err);
    }
  }

  /**
   * Build the array of environment export commands shared by createSession() and respawnPane().
   * Includes locale, mux markers, session identity, and API URL.
   *
   * User-supplied envOverrides are NOT inlined here — they go through applyEnvOverrides()
   * via `tmux setenv` so secret values (e.g., OPENCODE_API_KEY) never appear in the bash
   * command line (visible in `ps`). This also sidesteps shell-metachar injection via keys.
   */
  private buildEnvExports(
    sessionId: string,
    muxName: string,
    mode: SessionMode,
    truecolorEnabled?: boolean,
    headroomClaudeUrl?: string
  ): string[] {
    const entry = getCli(mode);
    const declaredExports = entry?.env.exports ?? [];
    const declaredUnset = entry?.env.unset ?? [];

    // COLORTERM is unset for Claude sessions by default to avoid tmux→PTY→xterm.js
    // color glitches (an empirical rendering choice). The `truecolorEnabled` app
    // setting (COD-75) lets the user opt Claude back into 24-bit truecolor.
    // Bubble Tea/Ink TUIs (OpenCode, Codex, Gemini) always get truecolor so their
    // background/color palette negotiation matches xterm's 24-bit renderer.
    //
    // COD-416: the eight-mode `||` chain became "does this entry DECLARE the export".
    // ⚠️ Still a UNION with `truecolorEnabled`, and both halves are load-bearing — the
    // registry answers "does this CLI always want truecolor", the setting answers "has the
    // user opted THIS session in". Dropping either loses a real behaviour (the chain's own
    // comment said so, and it was right).
    const declaresTruecolor = declaredExports.some((e) => e.name === 'COLORTERM' && e.value === 'truecolor');
    const colorTermExport = declaresTruecolor || truecolorEnabled ? 'export COLORTERM=truecolor' : 'unset COLORTERM';
    const exports = [
      'export LANG=en_US.UTF-8',
      'export LC_ALL=en_US.UTF-8',
      // Settings-driven (see colorTermExport above); the registry declares the per-CLI
      // half, we honor the user's truecolor toggle on top of it.
      colorTermExport,
      ...(declaredUnset.includes('NO_COLOR') ? ['unset NO_COLOR'] : []),
      // Stamp each Codex pane with a unique originator so the response-viewer
      // can locate THIS pane's rollout exactly — codex writes the value into
      // session_meta.originator of every rollout it creates. Without it,
      // rollouts are matched by cwd+mtime and two panes in the same directory
      // bleed into each other. Declared as `env.exports` with an ENGINE value, so the
      // `mode === 'codex'` test became "which entry asks for this".
      ...declaredExports
        .filter((e) => typeof e.value === 'object' && e.value.engine === 'codemanPrefixedSessionId')
        .map((e) => `export ${e.name}=codeman_${sessionId}`),
      'export CODEMAN_MUX=1',
      `export CODEMAN_SESSION_ID=${sessionId}`,
      `export CODEMAN_MUX_NAME=${muxName}`,
      // Only exported when the server has stamped the real URL (scheme+host+port,
      // set in WebServer.start()). A hardcoded fallback here exported the wrong
      // scheme on HTTPS installs; leaving the variable unset makes in-session
      // guards fail closed instead of curling a URL that was never right.
      ...(process.env.CODEMAN_API_URL ? [`export CODEMAN_API_URL=${process.env.CODEMAN_API_URL}`] : []),
      // Path only (not the secret value): hook curl commands cat the file at
      // execution time, so the COD-54 hook secret stays off the command line.
      `export CODEMAN_HOOK_SECRET_FILE="${dataPath('hook-secret')}"`,
    ];
    // Claude is the only entry declaring CLAUDECODE in `env.unset`, and it goes BEFORE the
    // COLORTERM line — the splice index is preserved exactly, since the ordering of these
    // lines is part of the pane command this builds.
    if (declaredUnset.includes('CLAUDECODE')) exports.splice(2, 0, 'unset CLAUDECODE');
    exports.push(...buildHeadroomExports(mode, headroomClaudeUrl));
    return exports;
  }

  /**
   * Apply user-supplied env overrides to a tmux session via `tmux setenv`.
   * Values stay off the bash command line (not visible in `ps`), and are inherited
   * by new panes — including `respawn-pane`. Persists at tmux-session level, so
   * Codeman server restarts don't lose the setting as long as the tmux session lives.
   *
   * Key validation is strict (`/^[A-Z_][A-Z0-9_]*$/`) as defense-in-depth against
   * shell-metachar injection even if upstream schema check is bypassed.
   */
  private async applyEnvOverrides(
    muxName: string,
    envOverrides?: Record<string, string>,
    unsetKeys?: string[]
  ): Promise<void> {
    const VALID_KEY = /^[A-Z_][A-Z0-9_]*$/;
    // Legacy cleanup: pre-0.7.2 set CLAUDE_CODE_EFFORT_LEVEL via setenv, which persists
    // on the tmux session and hard-locks /effort switching in every respawned pane.
    // Effort now flows as a `--settings` soft default (see buildEffortSettingsFlag),
    // so unconditionally unset the stale var before applying current overrides.
    //
    // The caller's own unsets ride the same path, and run BEFORE the overrides are
    // (re)applied: a key that is both unset and present in `envOverrides` ends up set,
    // so a stale unset can never clobber a live value. Removing a key from the map is
    // not enough on its own — `setenv` persists at the tmux-session level and is
    // inherited by `respawn-pane`, measured: `setenv FOO bar` survived two successive
    // `respawn-pane -k`. Clearing a custom-model selection is what needs this.
    for (const key of ['CLAUDE_CODE_EFFORT_LEVEL', ...(unsetKeys ?? [])]) {
      if (!VALID_KEY.test(key)) {
        console.warn(`[TmuxManager] Skipping invalid env unset key: ${JSON.stringify(key)}`);
        continue;
      }
      try {
        execSync(`${this.tmux()} setenv -t ${shellescape(muxName)} -u ${key}`, {
          timeout: EXEC_TIMEOUT_MS,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch {
        /* Non-critical — var may not exist */
      }
    }
    if (!envOverrides) return;
    for (const [key, value] of Object.entries(envOverrides)) {
      if (!value) continue; // Skip empty — nothing to set
      if (!VALID_KEY.test(key)) {
        console.warn(`[TmuxManager] Skipping invalid env override key: ${JSON.stringify(key)}`);
        continue;
      }
      try {
        await execAsync(`${this.tmux()} setenv -t ${shellescape(muxName)} ${key} ${shellescape(value)}`, {
          timeout: EXEC_TIMEOUT_MS,
        });
      } catch (err) {
        console.warn(`[TmuxManager] Failed to set env override ${key}:`, err);
      }
    }
  }

  /**
   * Resolve the CLI binary directory and return the PATH export prefix string.
   * Returns '' if no override is needed (shell mode) or the binary dir is not found.
   * In createSession(), a missing binary dir throws — the caller handles that separately.
   */
  private buildPathExport(mode: SessionMode): { pathExport: string; dir: string | null } {
    // COD-416: a nine-arm dispatch to nine per-CLI `resolveXDir()` helpers became one call to
    // the registry's generic resolver. `shell` (and any unregistered mode) resolves to null,
    // which is the old `return { pathExport: '', dir: null }` fallthrough.
    //
    // ⚠️ All nine now emit `buildCliPathExport`, which SHELL-ESCAPES the directory. Six arms
    // already did; grok/deepseek/omp hand-built `export PATH="<dir>:$PATH"` with the path
    // unescaped inside double quotes. For an ordinary directory the resulting PATH is
    // identical — for one containing a quote or `$` the old form was broken and injectable,
    // so this normalises three outliers onto the safe form the majority already used.
    const dir = resolveCliBinDir(mode);
    return { pathExport: dir ? buildCliPathExport(dir) : '', dir };
  }

  /**
   * Configure this CLI's environment on a tmux session, entirely from registry data.
   *
   * Replaces `_configureOpenCode` / `_configureCodex` / `_configureGemini` /
   * `_configureDeepSeek` and the four near-identical key-list loops behind them. Everything
   * goes via `tmux setenv`, so secrets are inherited by the pane without appearing in `ps`.
   *
   * ⚠️ FULLY ASYNC, and that is the point. `_configureDeepSeek` was still `execSync` — up to
   * six blocking spawns in the session-create path, which is exactly the pattern COD-212
   * removed from the other three (a measured 5.08s `/api/status` freeze). Generalising the
   * three async ones without bringing deepseek with them would have left the bug in place;
   * adopting upstream's synchronous helper would have reintroduced it for all four.
   */
  private async _configureCliEnv(
    muxName: string,
    sessionId: string,
    mode: SessionMode,
    options: Record<string, unknown>
  ): Promise<void> {
    const entry = getCli(mode);
    if (!entry) return;
    const tmuxCmd = this.tmux();
    const legacyConfig = legacyConfigForMode(mode, options);

    for (const { key, value } of planCliEnvSetenv(entry, legacyConfig)) {
      await setTmuxEnvVar(tmuxCmd, muxName, key, value);
    }

    // `env.setenvProfile` — genuinely code-shaped work, kept out of the pure planner because
    // it writes an executable shim to DISK and then exports that shim's path.
    if (entry.env.setenvProfile === 'deepseek-status-bridge') {
      // The bridge is what upgrades dsh from output-stabilization guessing to definitive
      // idle/working/blocked events; a session may disarm it, and then Codeman must not
      // claim to be its supervisor.
      if (legacyConfig?.statusReporting === false) return;
      const shim = ensureDeepSeekStatusShim();
      if (!shim) return;
      await setTmuxEnvVar(tmuxCmd, muxName, 'HERDR_ENV', '1');
      await setTmuxEnvVar(tmuxCmd, muxName, 'HERDR_BIN_PATH', shim);
      // The pane id IS the Codeman session id, which is how the shim attributes a report
      // without trusting anything the agent could influence.
      await setTmuxEnvVar(tmuxCmd, muxName, 'HERDR_PANE_ID', sessionId);
    }
  }

  /**
   * Export the user's own REAL statusLine command (found by
   * findEffectiveUserStatusLineCommand) via tmux setenv, so the shared
   * exporter script (statusLineExporterScriptContent in hooks-config.ts) can
   * wrap it. Via setenv rather than embedding it in the spawn command line:
   * tmux stores a setenv value verbatim and never re-parses it as shell
   * syntax, so once safely escaped for THIS one command, the command's own
   * `$`/quotes survive untouched into the claude process's environment — the
   * same reasoning that made the exporter script itself necessary (see
   * ensureStatusLineExporterScript's doc comment). Only this ONE line needs
   * shellescape(); the stored value itself is opaque to tmux from then on.
   *
   * With NO user command the variable is UNSET rather than left alone: a tmux
   * setenv survives respawn-pane, so a user who deleted their own statusline
   * would otherwise keep getting the stale one wrapped (and lose Codeman's
   * footer print-through) until the tmux session was recreated. Same shape as
   * the CLAUDE_CODE_EFFORT_LEVEL cleanup in applyEnvOverrides.
   */
  private _configureStatusLineUserCommand(muxName: string, command: string | undefined): void {
    const setOrUnset = command
      ? `CODEMAN_USER_STATUSLINE_CMD ${shellescape(command)}`
      : '-u CODEMAN_USER_STATUSLINE_CMD';
    try {
      execSync(`${this.tmux()} setenv -t ${shellescape(muxName)} ${setOrUnset}`, {
        timeout: EXEC_TIMEOUT_MS,
        stdio: 'ignore',
      });
    } catch {
      // Non-critical: the exporter prints its own footer, or nothing.
    }
  }

  /**
   * Creates a new tmux session wrapping Claude CLI or a shell.
   * In test mode: creates an in-memory session only (no real tmux session).
   */
  async createSession(options: CreateSessionOptions): Promise<MuxSession> {
    const {
      sessionId,
      workingDir,
      mode,
      name,
      cliName,
      niceConfig,
      model,
      claudeMode,
      allowedTools,
      openCodeConfig,
      codexConfig,
      geminiConfig,
      antigravityConfig,
      piConfig,
      grokConfig,
      deepSeekConfig,
      ompConfig,
      resumeSessionId,
      envOverrides,
      effort,
      truecolorEnabled,
      historyLimit = DEFAULT_TMUX_HISTORY_LIMIT,
      remote,
      initialCols,
      initialRows,
      docker,
      owner,
    } = options;
    const muxName = `codeman-${sessionId.slice(0, 8)}`;

    if (!isValidMuxName(muxName)) {
      throw new Error('Invalid session name: contains unsafe characters');
    }
    if (!isValidPath(workingDir)) {
      throw new Error('Invalid working directory path: contains unsafe characters');
    }

    // TEST MODE: Create in-memory session only — no real tmux session
    if (IS_TEST_MODE) {
      const session: MuxSession = {
        sessionId,
        muxName,
        pid: 99999,
        createdAt: Date.now(),
        workingDir,
        remote,
        docker,
        owner,
        mode,
        attached: false,
        name,
      };
      this.sessions.set(sessionId, session);
      this.emit('sessionCreated', session);
      return session;
    }

    const local = !remote && !docker;

    // COD-392: resolved local Codex commands are arbitrary owner-authored shell
    // text on the shared host. Recheck the grant on every launch path so a
    // revoked permission fails closed instead of respawning the command.
    if (local && mode === 'codex' && codexConfig?.baseCommand?.trim()) {
      const owner = options.owner;
      if (!(await canUsernameRunPrivilegedCommands(owner))) {
        throw new Error('Custom Codex commands require the can-bypass-permissions grant');
      }
    }

    // Registry-gated (capabilities.statusLineTelemetry — claude only today), local
    // spawns only (remote/docker have their own separate command builders — out of
    // scope here). Also self-heals: strips any legacy disk-written exporter from an
    // older Codeman build the first time a session starts in that workspace again.
    const statusLineCommand =
      getCli(mode)?.capabilities.statusLineTelemetry && !remote && !docker
        ? await resolveStatusLineCliCommand(workingDir, await readPlanUsageTelemetryEnabled())
        : undefined;
    // The user's own REAL statusLine, if any (walked via Claude Code's own
    // settings precedence) — exported below so the shared exporter script
    // can wrap it. Only worth discovering when we're actually injecting.
    const userStatusLineCommand = statusLineCommand ? await findEffectiveUserStatusLineCommand(workingDir) : undefined;

    if (local && mode === 'codex') await reconcileCodexHeadroomPatch();
    const headroomClaudeUrl = local ? await resolveHeadroomClaudeBaseUrl(mode) : undefined;
    const headroomRouted = local
      ? mode === 'claude'
        ? headroomClaudeUrl !== undefined
        : mode === 'codex'
          ? await resolveHeadroomRouted('codex')
          : undefined
      : undefined;

    try {
      const fullCmd = selectLaunchCommand({
        local: () => {
          const { pathExport, dir } = this.buildPathExport(mode);
          if (isAgentCliMode(mode) && !dir) {
            throw new Error(cliNotFoundMessage(mode));
          }
          const envExports = this.buildEnvExports(sessionId, muxName, mode, truecolorEnabled, headroomClaudeUrl);
          const baseCmd = buildSpawnCommand({
            mode,
            sessionId,
            model,
            claudeMode,
            allowedTools,
            openCodeConfig,
            codexConfig,
            geminiConfig,
            antigravityConfig,
            piConfig,
            grokConfig,
            deepSeekConfig,
            ompConfig,
            resumeSessionId,
            effort,
            statusLineCommand,
            sessionName: cliName ?? name,
          });
          const exactCommand = mode === 'codex' && Boolean(codexConfig?.baseCommand?.trim());
          const cmd = exactCommand ? baseCmd : wrapSpawnCommandWithNice(baseCmd, niceConfig || DEFAULT_NICE_CONFIG);
          return buildLocalPaneCommand({
            mode,
            pathExport,
            envExports,
            cmd,
            exactCommand,
          });
        },
        remote: remote
          ? () =>
              buildRemoteSessionCommand(mode, remote, sessionId, {
                codexConfig,
                openCodeConfig,
                geminiConfig,
                antigravityConfig,
                claudeMode,
                allowedTools,
                historyLimit,
                ompConfig,
                resumeSessionId,
              })
          : undefined,
        docker: docker
          ? () => buildDockerLaunchCommand(resolveDockerLaunchOptions(mode, docker, sessionId, resumeSessionId))
          : undefined,
      });

      // Create tmux session in three steps to handle cold-start (no server running)
      // and avoid the race where the command exits before remain-on-exit is set:
      // 2. Set remain-on-exit (server now exists, session won't vanish on exit)
      // 3. Replace shell with actual command via respawn-pane (no terminal echo)
      // Unset $TMUX so nested sessions work when the dev server itself runs inside tmux.
      // (Production uses systemd which has a clean env, but dev/test may be nested.)
      const cleanEnv = { ...process.env };
      delete cleanEnv.TMUX;
      // Create the session on the dedicated socket (${this.tmux()} = `tmux -L <socket>`),
      // launched in TMUX_LAUNCH_CWD (/tmp) rather than the real workingDir: a FUSE/rclone
      // mount that isn't ready yet makes `getcwd` fail and breaks the spawn (see #110). The
      // pane cd's into workingDir below via respawn-pane.
      // tmux <3.7 allocates history only at pane creation, so its global default
      // must be set immediately BEFORE new-session. tmux 3.7+ can resize a pane
      // after creation; target only the new session there because changing the
      // global option can resize (and when lowered, trim) unrelated live panes.
      const safeHistoryLimit =
        Number.isSafeInteger(historyLimit) && historyLimit > 0 ? Math.trunc(historyLimit) : DEFAULT_TMUX_HISTORY_LIMIT;
      const createSessionCommand = this.supportsLiveHistoryResize()
        ? `${this.tmux()} new-session -ds "${muxName}" -c ${TMUX_LAUNCH_CWD} \\; set-option -t "${muxName}" history-limit ${safeHistoryLimit}`
        : `${this.tmux()} set-option -g history-limit ${safeHistoryLimit} \\; new-session -ds "${muxName}" -c ${TMUX_LAUNCH_CWD} \\; set-option -t "${muxName}" history-limit ${safeHistoryLimit}`;
      execSync(createSessionCommand, {
        cwd: TMUX_LAUNCH_CWD,
        timeout: EXEC_TIMEOUT_MS,
        stdio: 'ignore',
        env: cleanEnv,
      });
      // Spawn at the creating browser's dims when known (COD-179) so the TUI's
      // first frames are already the right geometry; 120x40 is the legacy
      // fallback for API/CLI creates that carry no viewport.
      this.resizeWindow(muxName, initialCols ?? 120, initialRows ?? 40);

      // Set remain-on-exit now that the server is running — must be before respawn-pane
      try {
        await execAsync(`${this.tmux()} set-option -t "${muxName}" remain-on-exit on`, {
          timeout: EXEC_TIMEOUT_MS,
        });
      } catch {
        /* Non-critical */
      }

      // Per-CLI env: API keys, config blobs, config-sourced vars, status bridges. All of
      // it is registry data, so this is one unconditional call rather than a per-mode ladder.
      this._configureCliEnv(
        muxName,
        sessionId,
        mode,
        legacyConfigForMode(mode, options as unknown as Record<string, unknown>) ?? {}
      );
      this._configureStatusLineUserCommand(muxName, userStatusLineCommand);

      // Apply user-supplied env overrides (e.g., CLAUDE_CODE_EFFORT_LEVEL) via tmux setenv
      // so secret values stay off the bash command line. Must run before respawn-pane.
      await this.applyEnvOverrides(muxName, envOverrides);

      // Replace the shell with the actual command (no echo in terminal). Keep
      // pane launch in /tmp, then cd inside bash against the current mount table.
      await execAsync(
        buildRespawnPaneCommand({
          tmuxCommand: this.tmux(),
          muxName,
          workingDir,
          launchCommand: fullCmd,
          local,
        }),
        { timeout: EXEC_TIMEOUT_MS }
      );

      // Wait for tmux session to be queryable
      await new Promise((resolve) => setTimeout(resolve, TMUX_CREATION_WAIT_MS));

      // Non-critical tmux config — run in parallel to avoid blocking event loop.
      // These configure UX niceties (no status bar, true color).
      // Mouse mode is OFF by default so xterm.js handles text selection natively.
      // It gets enabled dynamically when panes are split (agent teams).
      const configPromises: Promise<void>[] = [
        // Disable tmux status bar — Codeman's web UI provides session info
        execAsync(`${this.tmux()} set-option -t "${muxName}" status off`, { timeout: EXEC_TIMEOUT_MS })
          .then(() => {})
          .catch(() => {
            /* Non-critical — session still works with status bar */
          }),
        // Override global remain-on-exit with session-level setting
        execAsync(`${this.tmux()} set-option -t "${muxName}" remain-on-exit on`, { timeout: EXEC_TIMEOUT_MS })
          .then(() => {})
          .catch(() => {
            /* Already set globally as fallback */
          }),
      ];

      // Enable 24-bit true color passthrough — server-wide, set once per lifetime
      if (!this.trueColorConfigured) {
        configPromises.push(
          execAsync(`${this.tmux()} set-option -sa terminal-overrides ",*:Tc"`, { timeout: EXEC_TIMEOUT_MS })
            .then(() => {
              this.trueColorConfigured = true;
            })
            .catch(() => {
              /* Non-critical — colors limited to 256 */
            })
        );
      }

      // Fire-and-forget — these are non-critical UX niceties that don't need
      // to complete before the session is usable. Errors are already swallowed.
      void Promise.all(configPromises);

      // Get the PID of the pane process (retry for tmux server cold-start)
      let pid = await this.getPanePid(muxName);
      for (let i = 0; !pid && i < GET_PID_MAX_RETRIES; i++) {
        await new Promise((resolve) => setTimeout(resolve, GET_PID_RETRY_MS));
        pid = await this.getPanePid(muxName);
      }
      if (!pid) {
        throw new Error('Failed to get tmux pane PID');
      }

      const session: MuxSession = {
        sessionId,
        muxName,
        pid,
        createdAt: Date.now(),
        workingDir,
        remote,
        docker,
        owner,
        mode,
        attached: false,
        name,
        headroomRouted,
        headroomRoutedAt: headroomRouted === undefined ? undefined : Date.now(),
      };

      this.sessions.set(sessionId, session);
      this.saveSessions();
      this.emit('sessionCreated', session);

      return session;
    } catch (err) {
      throw new Error(`Failed to create tmux session: ${getErrorMessage(err)}`);
    }
  }

  /**
   * Get the PID of the process running in the tmux pane.
   */
  private async getPanePid(muxName: string): Promise<number | null> {
    if (IS_TEST_MODE) return 99999;

    if (!isValidMuxName(muxName)) {
      console.error('[TmuxManager] Invalid session name in getPanePid:', muxName);
      return null;
    }

    try {
      const { stdout } = await execAsync(`${this.tmux()} display-message -t "${muxName}" -p '#{pane_pid}'`, {
        encoding: 'utf-8',
        timeout: EXEC_TIMEOUT_MS,
      });
      const pid = parseInt(stdout.trim(), 10);
      return Number.isNaN(pid) ? null : pid;
    } catch {
      return null;
    }
  }

  /**
   * Check if a tmux session exists.
   */
  async muxSessionExists(muxName: string): Promise<boolean> {
    return this.sessionExists(muxName);
  }

  /**
   * Check if the pane in a tmux session is dead (command exited but remain-on-exit keeps it).
   * Returns true if the session exists but the pane's command has exited.
   */
  async isPaneDead(muxName: string): Promise<boolean> {
    if (IS_TEST_MODE) return false;
    if (!isValidMuxName(muxName)) return false;
    try {
      const { stdout } = await execAsync(`${this.tmux()} display-message -t "${muxName}" -p '#{pane_dead}'`, {
        encoding: 'utf-8',
        timeout: EXEC_TIMEOUT_MS,
      });
      return stdout.trim() === '1';
    } catch {
      return false;
    }
  }

  /**
   * Respawn a dead pane in an existing tmux session.
   * Uses `tmux respawn-pane -k` to restart the command in the same pane,
   * preserving the session and its scrollback buffer.
   */
  async respawnPane(options: RespawnPaneOptions): Promise<number | null> {
    const {
      sessionId,
      workingDir,
      mode,
      niceConfig,
      model,
      claudeMode,
      allowedTools,
      openCodeConfig,
      codexConfig,
      geminiConfig,
      antigravityConfig,
      piConfig,
      grokConfig,
      deepSeekConfig,
      ompConfig,
      resumeSessionId,
      envOverrides,
      unsetEnvKeys,
      effort,
      truecolorEnabled,
      historyLimit = DEFAULT_TMUX_HISTORY_LIMIT,
      remote,
      docker,
      cliName,
    } = options;
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const muxName = session.muxName;

    if (!isValidMuxName(muxName) || !isValidPath(workingDir)) return null;

    // Don't respawn into a working directory that no longer exists — `cd` into a
    // deleted cwd makes respawn-pane exit immediately and crash-loop (COD-43).
    // Fail clearly so callers can surface/prune the dead session.
    if (!IS_TEST_MODE && !isUsableWorkingDir(workingDir)) {
      console.error(`[TmuxManager] Refusing to respawn ${muxName}: working directory missing: ${workingDir}`);
      return null;
    }

    const local = !remote && !docker;

    // See createSession()'s identical resolution for rationale.
    const statusLineCommand =
      getCli(mode)?.capabilities.statusLineTelemetry && !remote && !docker
        ? await resolveStatusLineCliCommand(workingDir, await readPlanUsageTelemetryEnabled())
        : undefined;
    const userStatusLineCommand = statusLineCommand ? await findEffectiveUserStatusLineCommand(workingDir) : undefined;

    if (local && mode === 'codex') await reconcileCodexHeadroomPatch();
    const headroomClaudeUrl = local ? await resolveHeadroomClaudeBaseUrl(mode) : undefined;
    const headroomRouted = local
      ? mode === 'claude'
        ? headroomClaudeUrl !== undefined
        : mode === 'codex'
          ? await resolveHeadroomRouted('codex')
          : undefined
      : undefined;

    const fullCmd = selectLaunchCommand({
      local: () => {
        const { pathExport } = this.buildPathExport(mode);
        const envExports = this.buildEnvExports(sessionId, muxName, mode, truecolorEnabled, headroomClaudeUrl);
        const command = buildSpawnCommand({
          mode,
          sessionId,
          model,
          claudeMode,
          allowedTools,
          openCodeConfig,
          codexConfig,
          geminiConfig,
          antigravityConfig,
          piConfig,
          grokConfig,
          deepSeekConfig,
          ompConfig,
          resumeSessionId,
          effort,
          statusLineCommand,
          sessionName: cliName,
        });
        const exactCommand = mode === 'codex' && Boolean(codexConfig?.baseCommand?.trim());
        const wrapped = exactCommand ? command : wrapSpawnCommandWithNice(command, niceConfig || DEFAULT_NICE_CONFIG);
        return buildLocalPaneCommand({
          mode,
          pathExport,
          envExports,
          cmd: wrapped,
          exactCommand,
        });
      },
      remote: remote
        ? () =>
            buildRemoteSessionCommand(mode, remote, sessionId, {
              codexConfig,
              openCodeConfig,
              geminiConfig,
              antigravityConfig,
              claudeMode,
              allowedTools,
              historyLimit,
              ompConfig,
              resumeSessionId,
            })
        : undefined,
      docker: docker
        ? () => buildDockerLaunchCommand(resolveDockerLaunchOptions(mode, docker, sessionId, resumeSessionId))
        : undefined,
    });

    try {
      // Same per-CLI env setup as createSession, re-applied so the respawned pane inherits it.
      this._configureCliEnv(
        muxName,
        sessionId,
        mode,
        legacyConfigForMode(mode, options as unknown as Record<string, unknown>) ?? {}
      );
      this._configureStatusLineUserCommand(muxName, userStatusLineCommand);

      // Re-apply user env overrides before respawn so the new shell inherits them,
      // dropping the ones the caller retired first (see applyEnvOverrides).
      await this.applyEnvOverrides(muxName, envOverrides, unsetEnvKeys);

      // -c /tmp + cd bounce — see createSession() for rationale (stale FUSE state).
      // buildRespawnPaneCommand owns the `cd` for local panes (remote/docker keep theirs).
      await execAsync(
        buildRespawnPaneCommand({
          tmuxCommand: this.tmux(),
          muxName,
          workingDir,
          launchCommand: fullCmd,
          local,
        }),
        {
          timeout: EXEC_TIMEOUT_MS,
        }
      );
      // Wait for the respawned process to start
      await new Promise((resolve) => setTimeout(resolve, TMUX_CREATION_WAIT_MS));
      // The pane now runs a fresh command, so whatever the last read observed of
      // the old one is history. Clearing it here rather than waiting for the next
      // poll also invalidates any read already in flight, which would otherwise
      // write the old death back over the pane that just replaced it.
      this.clearPaneExit(muxName);
      const pid = await this.getPanePid(muxName);
      if (!pid) return null;
      if (remote) {
        await new Promise((resolve) => setTimeout(resolve, REMOTE_RESPAWN_CONNECT_VERIFY_WAIT_MS));
        if (await this.isPaneDead(muxName)) return null;
      }
      const verifiedPid = (await this.getPanePid(muxName)) ?? pid;
      session.pid = verifiedPid;
      session.headroomRouted = headroomRouted;
      session.headroomRoutedAt = headroomRouted === undefined ? undefined : Date.now();
      this.saveSessions();
      return verifiedPid;
    } catch (err) {
      console.error('[TmuxManager] Failed to respawn pane:', err);
      return null;
    }
  }

  private async sessionExists(muxName: string): Promise<boolean> {
    if (IS_TEST_MODE) return false;
    if (!isValidMuxName(muxName)) return false;

    try {
      await execAsync(`${this.tmux()} has-session -t "${muxName}" 2>/dev/null`, {
        encoding: 'utf-8',
        timeout: EXEC_TIMEOUT_MS,
      });
      return true;
    } catch {
      return false;
    }
  }

  /** One `ps` snapshot of the whole process table, cached briefly. */
  private static procSnapshot: { at: number; byParent: Map<number, number[]> } | null = null;
  /** Single-flight guard so a hung `ps` cannot pile up parallel refreshes. */
  private static procRefresh: { started: number; promise: Promise<Map<number, number[]>> } | null = null;

  /**
   * Fork ONE `ps` asynchronously and cache the parent -> children map.
   *
   * Async on purpose: a synchronous fork here would block the event loop on every
   * stats tick, and under the procfs pathology this module exists to survive,
   * `execSync`'s timeout cannot return at all (spawnSync waits for the unkillable
   * child) — freezing the whole server where a hung async poll only costs staleness.
   */
  private static refreshProcSnapshot(): Promise<Map<number, number[]>> {
    const inFlight = TmuxManager.procRefresh;
    // Reuse an in-flight refresh — unless it is old enough to be presumed stuck.
    if (inFlight && Date.now() - inFlight.started < EXEC_TIMEOUT_MS * 2) return inFlight.promise;

    const started = Date.now();
    const promise = new Promise<Map<number, number[]>>((resolve) => {
      execFile('ps', ['-eo', 'pid=,ppid='], { timeout: EXEC_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
        if (TmuxManager.procRefresh?.started === started) TmuxManager.procRefresh = null;
        if (err) {
          // ANY error, not just an empty one: a timed-out or truncated `ps` yields
          // partial output, and caching that as fresh would make whole subtrees
          // invisible — including to the kill path. Stale beats wrong.
          console.error('[TmuxManager] process snapshot failed:', err);
          resolve(TmuxManager.procSnapshot?.byParent ?? new Map());
          return;
        }
        const byParent = new Map<number, number[]>();
        for (const line of String(out).split('\n')) {
          const parts = line.trim().split(/\s+/);
          if (parts.length < 2) continue;
          const pid = parseInt(parts[0], 10);
          const ppid = parseInt(parts[1], 10);
          if (Number.isNaN(pid) || Number.isNaN(ppid)) continue;
          const list = byParent.get(ppid);
          if (list) list.push(pid);
          else byParent.set(ppid, [pid]);
        }
        TmuxManager.procSnapshot = { at: Date.now(), byParent };
        resolve(byParent);
      });
    });
    TmuxManager.procRefresh = { started, promise };
    return promise;
  }

  /**
   * Best snapshot WITHOUT forking: returns the cache, kicking off a background
   * refresh when it has gone stale, and never blocks. Stats and window-title
   * consumers tolerate data one interval old; nothing that KILLS may use this.
   */
  private childrenByParent(): Map<number, number[]> {
    const cached = TmuxManager.procSnapshot;
    if (!cached || Date.now() - cached.at >= PROC_SNAPSHOT_TTL_MS) {
      void TmuxManager.refreshProcSnapshot();
    }
    return cached?.byParent ?? new Map();
  }

  /**
   * Descendants from a snapshot that is not the cached one — the kill path's variant.
   *
   * killSession re-scans for survivors between SIGTERM and SIGKILL, and the wait in
   * between (200ms) sits far inside the cache TTL (2000ms): reading the cache there
   * returns the pre-SIGTERM state verbatim, so children spawned since are invisible
   * and SIGKILL aims at stale PIDs, guarded only by kill(pid, 0) — which cannot
   * detect PID reuse.
   *
   * It forces a refresh rather than guaranteeing recency: an already-running refresh
   * is reused, so the snapshot can predate this call by up to one `ps` runtime. A
   * strict postdate guarantee would mean chaining a second `ps` behind every
   * in-flight one, which is the fork storm this code exists to avoid.
   *
   * Bounded by design: waiting forever would freeze killSession before it reaches
   * its process-group and tmux fallbacks.
   */
  private async getChildPidsFresh(pid: number): Promise<number[]> {
    let byParent: ReadonlyMap<number, readonly number[]>;
    try {
      byParent = await Promise.race([
        TmuxManager.refreshProcSnapshot(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('proc snapshot timeout')), PROC_SNAPSHOT_WAIT_MS)
        ),
      ]);
    } catch {
      console.warn('[TmuxManager] process snapshot did not return in time; using the cached one');
      byParent = TmuxManager.procSnapshot?.byParent ?? new Map<number, number[]>();
    }
    return collectDescendants(pid, byParent, {
      onTruncated: (root, cap, reason) =>
        console.warn(`[TmuxManager] descendant walk for ${root} hit the ${cap}-${reason} cap; truncating`),
    });
  }

  // Check if a process is still alive
  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  // Verify all PIDs are dead, with retry
  private async verifyProcessesDead(pids: number[], maxWaitMs: number = 1000): Promise<boolean> {
    const startTime = Date.now();
    const checkInterval = 100;

    while (Date.now() - startTime < maxWaitMs) {
      const aliveCount = pids.filter((pid) => this.isProcessAlive(pid)).length;
      if (aliveCount === 0) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, checkInterval));
    }

    const stillAlive = pids.filter((pid) => this.isProcessAlive(pid));
    if (stillAlive.length > 0) {
      console.warn(`[TmuxManager] ${stillAlive.length} processes still alive after kill: ${stillAlive.join(', ')}`);
    }
    return stillAlive.length === 0;
  }

  /**
   * Kill a tmux session and all its child processes.
   * Uses a 4-strategy approach (children → process group → tmux kill → SIGKILL).
   * In test mode: removes from memory only (no real kill).
   */
  async killSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    // COD-108: an intentional kill/detach must NEVER be auto-revived by the
    // remote-reconnect watcher. Guard BEFORE any teardown so a tick that fires
    // mid-kill (especially the non-owned DETACH early-return below, where the
    // dead local pane would otherwise look reconnectable) sees the guard.
    this.guardRemoteReconnect(sessionId);

    // TEST MODE: Remove from memory only — NEVER touch real tmux sessions
    if (IS_TEST_MODE) {
      this.invalidateWindowResize(session.muxName);
      this.sessions.delete(sessionId);
      this.clearRemoteReconnectState(sessionId);
      this.saveSessions();
      this.emit('sessionKilled', { sessionId });
      return true;
    }

    // SAFETY: Never kill the tmux session we're running inside of
    const currentMuxName = process.env.CODEMAN_MUX_NAME;
    if (currentMuxName && session.muxName === currentMuxName) {
      console.error(`[TmuxManager] BLOCKED: Refusing to kill own tmux session: ${session.muxName}`);
      return false;
    }

    this.invalidateWindowResize(session.muxName);

    // COD-105 — DETACH-NOT-KILL for NON-owned remote sessions.
    //
    // When this session was created by ATTACHING a remote tmux session another
    // Codeman owns (`remote.owned === false`), closing the tab must NOT propagate
    // a remote `tmux kill-session` — that would nuke work the remote's own
    // Codeman (or another instance) still relies on. We tear down ONLY the LOCAL
    // pane that holds the ssh client: killing the local ssh sends SIGHUP to its
    // remote `tmux attach`, which DETACHES (the durable remote session survives).
    //
    // This early return is the structural guarantee: no code below this point
    // (now or in future for owned sessions) can ever issue a remote kill-session
    // for a non-owned session. The only `kill-session` we run is on OUR LOCAL
    // socket (`this.tmux()` = `tmux -L codeman` on THIS host), which kills the
    // local pane — it does NOT reach the REMOTE socket.
    if (session.remote && session.remote.owned === false) {
      console.log(`[TmuxManager] DETACH (non-owned remote): tearing down local pane only for ${session.muxName}`);
      if (isValidMuxName(session.muxName)) {
        try {
          // Local socket only — detaches the remote session by killing the local ssh pane.
          await execAsync(`${this.tmux()} kill-session -t "${session.muxName}" 2>/dev/null`, {
            timeout: EXEC_TIMEOUT_MS,
          });
        } catch {
          // Local pane may already be gone.
        }
      }
      this.lastPaneCount.delete(session.muxName);
      this.clearPaneExit(session.muxName);
      this.sessions.delete(sessionId);
      this.clearRemoteReconnectState(sessionId);
      this.saveSessions();
      this.emit('sessionKilled', { sessionId });
      return true;
    }

    // COD-109 — propagate the kill to the REMOTE for OWNED remote sessions.
    // Non-owned sessions never reach here (detach-only early-return above). Since
    // COD-104, an owned remote session lives in `tmux -L codeman` on the host and
    // outlives the local pane, so the local teardown below would only DETACH it;
    // an explicit kill of a session we OWN must also end it on the remote.
    // Best-effort: if the host is unreachable or the session is already gone, fall
    // through to the local teardown.
    if (session.remote) {
      const remoteName = session.remote.remoteSessionName || remoteTmuxSessionName(sessionId);
      if (isValidRemoteTmuxTarget(remoteName)) {
        try {
          await execAsync(buildRemoteKillCommand(session.remote, remoteName), { timeout: EXEC_TIMEOUT_MS });
          console.log(`[TmuxManager] COD-109 killed owned remote session ${remoteName} on ${session.remote.host}`);
        } catch {
          // Remote unreachable or session already gone — local teardown still runs.
        }
      }
    }

    // Get current PID (may have changed)
    const currentPid = (await this.getPanePid(session.muxName)) || session.pid;

    console.log(`[TmuxManager] Killing session ${session.muxName} (PID ${currentPid})`);

    const allPids: number[] = [currentPid];

    // Strategy 1: Kill all child processes recursively
    let childPids = await this.getChildPidsFresh(currentPid);
    if (childPids.length > 0) {
      console.log(`[TmuxManager] Found ${childPids.length} child processes to kill`);
      allPids.push(...childPids);

      for (const childPid of [...childPids].reverse()) {
        if (this.isProcessAlive(childPid)) {
          try {
            process.kill(childPid, 'SIGTERM');
          } catch {
            // Process may already be dead
          }
        }
      }

      await new Promise((resolve) => setTimeout(resolve, TMUX_KILL_WAIT_MS));

      childPids = await this.getChildPidsFresh(currentPid);
      for (const childPid of childPids) {
        if (this.isProcessAlive(childPid)) {
          try {
            process.kill(childPid, 'SIGKILL');
          } catch {
            // Process already terminated
          }
        }
      }
    }

    // Strategy 2: Kill the entire process group
    if (this.isProcessAlive(currentPid)) {
      try {
        process.kill(-currentPid, 'SIGTERM');
        await new Promise((resolve) => setTimeout(resolve, GRACEFUL_SHUTDOWN_WAIT_MS));
        if (this.isProcessAlive(currentPid)) {
          process.kill(-currentPid, 'SIGKILL');
        }
      } catch {
        // Process group may not exist or already terminated
      }
    }

    // Strategy 3: Kill tmux session by name (guard the name before it reaches the shell)
    if (isValidMuxName(session.muxName)) {
      try {
        await execAsync(`${this.tmux()} kill-session -t "${session.muxName}" 2>/dev/null`, {
          timeout: EXEC_TIMEOUT_MS,
        });
      } catch {
        // Session may already be dead
      }
    }

    // Strategy 3c: Docker sessions run a DURABLE in-container tmux session. Kill
    // ONLY this session's in-container tmux session (best-effort). The container is
    // PER-CASE and shared by the case's other sessions, so we deliberately do NOT
    // `docker stop` it here — stopping/removing is an explicit teardown/case-delete.
    // (Remote-session kill is propagated by the COD-109 block earlier in this method.)
    if (session.docker && !IS_TEST_MODE) {
      try {
        exec(buildDockerKillCommand({ docker: session.docker, sessionId }), { timeout: EXEC_TIMEOUT_MS }, () => {});
      } catch {
        // Best-effort — never affects the local kill result.
      }
    }

    // Strategy 4: Direct kill by PID as final fallback
    if (this.isProcessAlive(currentPid)) {
      try {
        process.kill(currentPid, 'SIGKILL');
      } catch {
        // Already dead
      }
    }

    // Verify all processes are dead
    const allDead = await this.verifyProcessesDead(allPids, 2000);
    if (!allDead) {
      console.error(`[TmuxManager] Warning: Some processes may still be alive for session ${session.muxName}`);
    }

    this.lastPaneCount.delete(session.muxName);
    this.clearPaneExit(session.muxName);
    this.sessions.delete(sessionId);
    this.clearRemoteReconnectState(sessionId);
    this.saveSessions();
    this.emit('sessionKilled', { sessionId });

    return true;
  }

  /** Remove this Codeman's local SSH/tmux wrapper without touching the remote durable session. */
  async detachRemoteWrapper(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.guardRemoteReconnect(sessionId);
    if (!IS_TEST_MODE) {
      await execAsync(`${this.tmux()} kill-session -t ${shellescape(session.muxName)} 2>/dev/null`, {
        timeout: EXEC_TIMEOUT_MS,
      }).catch(() => {});
    }
    this.sessions.delete(sessionId);
    this.clearRemoteReconnectState(sessionId);
    this.saveSessions();
    this.emit('sessionKilled', { sessionId });
    return true;
  }

  getSessions(): MuxSession[] {
    return Array.from(this.sessions.values());
  }

  getSession(sessionId: string): MuxSession | undefined {
    return this.sessions.get(sessionId);
  }

  updateSessionName(sessionId: string, name: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }
    session.name = name;
    this.saveSessions();
    return true;
  }

  async setHistoryLimit(limit: number): Promise<void> {
    const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.trunc(limit) : DEFAULT_TMUX_HISTORY_LIMIT;

    if (IS_TEST_MODE) {
      return;
    }

    if (this.supportsLiveHistoryResize()) {
      const updates = Array.from(this.sessions.values()).map((session) =>
        execAsync(`${this.tmux()} set-option -t ${shellescape(session.muxName)} history-limit ${safeLimit}`, {
          timeout: EXEC_TIMEOUT_MS,
        })
      );
      await Promise.allSettled(updates);
      return;
    }

    await execAsync(`${this.tmux()} set-option -g history-limit ${safeLimit}`, {
      timeout: EXEC_TIMEOUT_MS,
    }).catch(() => {
      // No tmux server yet is fine: legacy createSession sets the same default
      // immediately before it creates the first pane.
    });
  }

  /**
   * Reconcile tracked sessions with actual running tmux sessions.
   */
  async reconcileSessions(): Promise<{ alive: string[]; dead: string[]; discovered: string[] }> {
    // TEST MODE: Return all registered sessions as alive, never discover real ones
    if (IS_TEST_MODE) {
      return {
        alive: Array.from(this.sessions.keys()),
        dead: [],
        discovered: [],
      };
    }

    const alive: string[] = [];
    const dead: string[] = [];
    const discovered: string[] = [];

    // Single batched query against the one socket Codeman owns. With a single
    // socket a session's location is a constant, so there is no per-session
    // socket tag to reconcile and no cross-socket ambiguity that could mark a
    // live session dead (the root cause of vanished/duplicate tabs).
    let panes: PaneRow[];
    let active: Map<string, number>;
    try {
      const { stdout } = await execAsync(`${this.tmux()} list-panes -a -F '${PANE_LIST_FORMAT}' 2>/dev/null || true`, {
        encoding: 'utf-8',
        timeout: EXEC_TIMEOUT_MS,
      });
      const rows = parsePaneRows(stdout.trim());
      panes = rows;
      active = new Map(rows.filter((row) => !row.dead).map((row) => [row.sessionName, row.pid]));
      // The same read answers both questions, so recovery starts with a pane-exit
      // reading rather than waiting for the first stats tick — which may never
      // come, since the collector only starts when boot found a live session.
      if (rows.length > 0) {
        this.applyPaneExits(derivePaneExits(rows, Date.now()));
      }
    } catch (err) {
      console.error('[TmuxManager] Failed to list tmux panes:', err);
      panes = [];
      active = new Map();
    }

    // Check tracked sessions against the live pane list.
    for (const [sessionId, session] of this.sessions) {
      const pid = active.get(session.muxName);
      if (pid !== undefined) {
        alive.push(sessionId);
        if (pid !== session.pid) session.pid = pid;
      } else {
        dead.push(sessionId);
        this.sessions.delete(sessionId);
        this.clearPaneExit(session.muxName);
        this.clearRemoteReconnectState(sessionId);
        this.emit('sessionDied', { sessionId });
      }
    }

    // Discover untracked codeman/claudeman sessions on our socket. Dedup by
    // muxName (globally unique) so a name we already track never spawns a
    // second "Restored:" entry.
    const knownMuxNames = new Set<string>();
    for (const session of this.sessions.values()) {
      knownMuxNames.add(session.muxName);
    }

    for (const pane of panes) {
      if (!pane.dead) continue;
      if (!pane.sessionName.startsWith('codeman-') && !pane.sessionName.startsWith('claudeman-')) continue;
      if (knownMuxNames.has(pane.sessionName)) continue;
      if (!isValidMuxName(pane.sessionName)) {
        console.warn(`[TmuxManager] Skipping dead tmux session with unsafe name: ${pane.sessionName}`);
        continue;
      }
      try {
        await execAsync(`${this.tmux()} kill-session -t "${pane.sessionName}" 2>/dev/null`, {
          timeout: EXEC_TIMEOUT_MS,
        });
        console.log(`[TmuxManager] Cleaned up untracked dead tmux session: ${pane.sessionName}`);
      } catch {
        // Session may already be gone.
      }
    }

    for (const [sessionName, pid] of active) {
      if (!sessionName.startsWith('codeman-') && !sessionName.startsWith('claudeman-')) continue;
      // Only admit names that pass the safe-name pattern. A foreign process on the
      // shared `tmux -L codeman` socket could create a `codeman-…` session whose name
      // contains shell metacharacters; rejecting it here keeps it out of this.sessions
      // and away from the name-interpolating tmux call sites (M1).
      if (!isValidMuxName(sessionName)) {
        console.warn(`[TmuxManager] Skipping discovered tmux session with unsafe name: ${sessionName}`);
        continue;
      }
      if (knownMuxNames.has(sessionName)) continue;

      const fragment = sessionName.replace(/^(?:codeman|claudeman)-/, '');
      const sessionId = `restored-${fragment}`;
      const session: MuxSession = {
        sessionId,
        muxName: sessionName,
        pid,
        createdAt: Date.now(),
        workingDir: process.cwd(),
        mode: 'claude',
        attached: false,
        name: `Restored: ${sessionName}`,
        // Every field above except the name and the pid is a guess: this record
        // was rebuilt from the socket because Codeman's own bookkeeping did not
        // have it. The synthetic id also cannot find the session's state.json
        // entry, so a remote or docker session rediscovered this way arrives
        // looking local. Consumers that would be wrong about such a session
        // read this flag and fail closed — see `Session.paneExitApplies`.
        discovered: true,
      };
      this.sessions.set(sessionId, session);
      knownMuxNames.add(sessionName);
      discovered.push(sessionId);
      console.log(`[TmuxManager] Discovered unknown tmux session: ${sessionName} (PID ${pid})`);
    }

    if (dead.length > 0 || discovered.length > 0) {
      this.saveSessions();
    }

    return { alive, dead, discovered };
  }

  async getCodexProviderEnvironment(muxName: string): Promise<CodexProviderEnvironment | null> {
    if (IS_TEST_MODE) return null;
    const tracked = [...this.sessions.values()].some((session) => session.muxName === muxName);
    return readTmuxCodexProviderEnvironment(this.tmuxSocket, muxName, tracked, async (file, args) => {
      const { stdout } = await execFileAsync(file, args, {
        encoding: 'utf8',
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
      return { stdout };
    });
  }

  async getProcessStats(sessionId: string): Promise<ProcessStats | null> {
    if (IS_TEST_MODE) return { memoryMB: 0, cpuPercent: 0, childCount: 0, updatedAt: Date.now() };

    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    try {
      const psOutput = (
        await execAsync(`ps -o rss=,pcpu= -p ${session.pid} 2>/dev/null || echo "0 0"`, {
          encoding: 'utf-8',
          timeout: EXEC_TIMEOUT_MS,
        })
      ).stdout.trim();

      const [rss, cpu] = psOutput.split(/\s+/).map((x) => parseFloat(x) || 0);

      // From the shared snapshot: this runs per session on every stats tick, and a
      // pgrep per session was a fork per session per interval.
      let childCount = 0;
      try {
        childCount = (this.childrenByParent().get(session.pid) ?? []).length;
      } catch {
        // No children or snapshot unavailable
      }

      return {
        memoryMB: Math.round((rss / 1024) * 10) / 10,
        cpuPercent: Math.round(cpu * 10) / 10,
        childCount,
        updatedAt: Date.now(),
      };
    } catch {
      return null;
    }
  }

  async getSessionsWithStats(): Promise<MuxSessionWithStats[]> {
    if (IS_TEST_MODE) {
      return Array.from(this.sessions.values()).map((s) => ({
        ...s,
        stats: { memoryMB: 0, cpuPercent: 0, childCount: 0, updatedAt: Date.now() },
      }));
    }

    const sessions = Array.from(this.sessions.values());
    if (sessions.length === 0) {
      return [];
    }

    const sessionPids = sessions.map((s) => s.pid);
    const statsMap = new Map<number, ProcessStats>();

    try {
      // Step 1: Get descendant PIDs
      const descendantMap = new Map<number, number[]>();

      // Derived from the ONE snapshot instead of a shell loop that forks a pgrep
      // per session — the shape that turned into a fork storm under load.
      const byParent = this.childrenByParent();
      const childLines = sessionPids.map((p) => `${p}:${(byParent.get(p) ?? []).join(',')}`).join('\n');

      for (const line of childLines.split('\n')) {
        const [pidStr, childrenStr] = line.split(':');
        const sessionPid = parseInt(pidStr, 10);
        if (!Number.isNaN(sessionPid)) {
          const children = (childrenStr || '')
            .split(',')
            .map((s) => parseInt(s.trim(), 10))
            .filter((n) => !Number.isNaN(n) && n > 0);
          descendantMap.set(sessionPid, children);
        }
      }

      // Step 2: Collect all PIDs
      const allPids = new Set<number>(sessionPids);
      for (const children of descendantMap.values()) {
        for (const child of children) {
          allPids.add(child);
        }
      }

      // Step 3: Single ps call
      const pidArray = Array.from(allPids);
      if (pidArray.length > 0) {
        const psOutput = (
          await execAsync(`ps -o pid=,rss=,pcpu= -p ${pidArray.join(',')} 2>/dev/null || true`, {
            encoding: 'utf-8',
            timeout: EXEC_TIMEOUT_MS,
          })
        ).stdout.trim();

        const processStats = new Map<number, { rss: number; cpu: number }>();
        for (const line of psOutput.split('\n')) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 3) {
            const pid = parseInt(parts[0], 10);
            const rss = parseFloat(parts[1]) || 0;
            const cpu = parseFloat(parts[2]) || 0;
            if (!Number.isNaN(pid)) {
              processStats.set(pid, { rss, cpu });
            }
          }
        }

        // Step 4: Aggregate stats
        for (const sessionPid of sessionPids) {
          const children = descendantMap.get(sessionPid) || [];
          const sessionStats = processStats.get(sessionPid) || { rss: 0, cpu: 0 };

          let totalRss = sessionStats.rss;
          let totalCpu = sessionStats.cpu;

          for (const childPid of children) {
            const childStats = processStats.get(childPid);
            if (childStats) {
              totalRss += childStats.rss;
              totalCpu += childStats.cpu;
            }
          }

          statsMap.set(sessionPid, {
            memoryMB: Math.round((totalRss / 1024) * 10) / 10,
            cpuPercent: Math.round(totalCpu * 10) / 10,
            childCount: children.length,
            updatedAt: Date.now(),
          });
        }
      }
    } catch {
      // Fall back to individual queries
      const statsPromises = sessions.map((session) => this.getProcessStats(session.sessionId));
      const results = await Promise.allSettled(statsPromises);
      return sessions.map((session, i) => ({
        ...session,
        stats: results[i].status === 'fulfilled' ? (results[i].value ?? undefined) : undefined,
      }));
    }

    return sessions.map((session) => ({
      ...session,
      stats: statsMap.get(session.pid) || undefined,
    }));
  }

  /**
   * What the last pane read saw of this tmux session's agent. `undefined` is
   * the UNKNOWN answer and must never be rendered as "alive": it covers a pane
   * that is running, a tmux session that no longer exists, a probe that failed,
   * and every poll that has not run yet. See {@link PaneExit}.
   */
  getPaneExit(muxName: string): PaneExit | undefined {
    return this.paneExits.get(muxName)?.exit;
  }

  /**
   * How many authoritative pane reads have agreed on the exit that
   * {@link getPaneExit} reports, or 0 when it reports none. A new observation
   * starts at 1, and every later read that sees the same pane with the same
   * status and signal adds one.
   */
  getPaneExitReadCount(muxName: string): number {
    return this.paneExits.get(muxName)?.reads ?? 0;
  }

  /**
   * Re-read every pane on the socket and refresh {@link paneExits}. ONE batched
   * `tmux list-panes -a` answers for every session at once, which is why this
   * polls rather than probing per session.
   *
   * A failed or empty probe leaves the previous answers ALONE rather than
   * clearing them, because the two cannot be told apart: the command ends in
   * `|| true`, so a tmux that errored and a socket with genuinely no panes both
   * arrive as empty output. Treating that as "tmux did not answer" is the
   * conservative reading — clearing on it would turn a transient failure into a
   * silent retraction of a death Codeman had already observed, and the cost of
   * being wrong the other way is one stale entry for a socket that no longer
   * has the pane. A NON-empty read is different: `list-panes -a` lists
   * every pane on the socket, so it is authoritative and {@link applyPaneExits}
   * prunes against it.
   *
   * Two guards keep a slow read from undoing a fast one. A read already in
   * flight suppresses the next poll, and a read that started before a
   * {@link clearPaneExit} is discarded when it lands.
   *
   * A third guard skips the read entirely while no session on this manager
   * could produce an answer ({@link hasObservablePaneSession}). Skipping
   * retracts nothing, for the same reason a failed read does not: the map
   * still holds what the last real read saw, and every path that puts a new
   * command in a pane calls {@link clearPaneExit} itself.
   */
  async refreshPaneExits(now: number = Date.now()): Promise<void> {
    // Nothing on this socket could answer, so do not read tmux to find that
    // out. See `hasObservablePaneSession`: the watcher above still ticks.
    if (!hasObservablePaneSession(this.sessions.values())) return;
    if (this.paneExitReadInFlight) return;

    const generation = this.paneExitGeneration;
    this.paneExitReadInFlight = true;
    let rows: PaneRow[];
    try {
      rows = await this.readPaneRows();
    } finally {
      this.paneExitReadInFlight = false;
    }
    if (rows.length === 0) return;
    // A pane was respawned or killed while this read was out, so what it saw is
    // already history. Dropping it is what stops a freshly respawned pane from
    // being republished as exited.
    if (generation !== this.paneExitGeneration) return;

    this.applyPaneExits(derivePaneExits(rows, now));
  }

  /**
   * Read every pane on the socket. The ONLY part of the pane-exit watcher that
   * touches tmux, which is what lets a test subclass drive the guards in
   * {@link refreshPaneExits} — the in-flight suppression, the generation
   * check, the empty-read retraction rule and the read gate — against rows it
   * chooses. Split out for the reason `runRemoteReconnectTick` is: a guard no
   * test can reach is a guard that can be deleted without anything failing.
   *
   * A failed read answers with NO rows, which the caller treats as "tmux did
   * not answer" and which therefore retracts nothing.
   */
  protected async readPaneRows(): Promise<PaneRow[]> {
    // The test-mode gate lives HERE rather than at the top of the tick, so that
    // what tests cannot do is spawn a process, not exercise the bookkeeping.
    if (IS_TEST_MODE) return [];
    try {
      // execAsync, not execSync: this runs on a 2000 ms timer, and a synchronous
      // exec freezes the port while the process stays alive (see the
      // event-loop-monitor note in CLAUDE.md). The three `isPaneDead()` callers
      // stay synchronous because each is answering one request right then.
      const { stdout } = await execAsync(`${this.tmux()} list-panes -a -F '${PANE_LIST_FORMAT}' 2>/dev/null || true`, {
        encoding: 'utf-8',
        timeout: EXEC_TIMEOUT_MS,
      });
      return parsePaneRows(stdout.trim());
    } catch (err) {
      console.error('[TmuxManager] Failed to read pane exit state:', err);
      return [];
    }
  }

  /**
   * Fold one authoritative observation into {@link paneExits}. Split out from
   * the tmux call so the merge rules are unit-testable.
   *
   * `observed` comes from a read of EVERY pane on the socket, so a session
   * missing from it has no exit to report and its entry goes. That is what
   * keeps the map from growing without bound as tmux sessions come and go
   * outside `killSession()`. Only the caller may decide a read is authoritative:
   * a failed or empty one never reaches here.
   *
   * An entry keeps the `at` of the FIRST read that saw that exit, so the stamp
   * says when the agent was found gone rather than when the last poll ran. A
   * changed status, a changed signal, or a different pane pid all start a new
   * observation — the pid is what catches a second command in the same pane
   * that happened to exit the same way.
   *
   * The same rule decides the read count: a repeat of the stored exit adds one,
   * and anything that starts a new observation starts the count again at 1.
   */
  applyPaneExits(observed: Map<string, PaneExitObservation>): void {
    for (const muxName of [...this.paneExits.keys()]) {
      if (!observed.has(muxName)) this.paneExits.delete(muxName);
    }
    for (const [muxName, next] of observed) {
      const prev = this.paneExits.get(muxName);
      const sameExit =
        prev !== undefined &&
        prev.panePid === next.panePid &&
        prev.exit.status === next.exit.status &&
        prev.exit.signal === next.exit.signal;
      this.paneExits.set(muxName, sameExit ? { ...prev, reads: prev.reads + 1 } : { ...next, reads: 1 });
    }
  }

  /**
   * Forget a session's exit observation, e.g. once its pane has been respawned.
   * Also invalidates any read already in flight, so the answer this retracts
   * cannot be written back a moment later.
   */
  clearPaneExit(muxName: string): void {
    this.paneExits.delete(muxName);
    this.paneExitGeneration++;
  }

  /**
   * Poll for exited agents, on the manager's own interval.
   *
   * Deliberately NOT part of `startStatsCollection()`. That collector is armed
   * when the browser opens the Monitor panel and DISARMED when it closes it
   * (`panels-ui.js`), and it is skipped at boot entirely when no session was
   * recovered — so riding it would leave a session created on a freshly booted
   * server reporting nothing at all, and would let one browser turn exit
   * detection off for every other. Started unconditionally, like the mouse-mode
   * sync and the remote-reconnect watcher below.
   *
   * The `paneExitsUpdated` event is internal to the server; nothing here adds an
   * SSE event, and the field reaches the browser on `session:updated`.
   */
  startPaneExitWatcher(intervalMs: number = DEFAULT_PANE_EXIT_INTERVAL_MS): void {
    if (this.paneExitInterval) {
      clearInterval(this.paneExitInterval);
    }
    this.paneExitInterval = setInterval(() => {
      // No IS_TEST_MODE guard: `readPaneRows()` is the only thing that would
      // spawn a process and it refuses under test, so a test can drive this
      // whole loop with fake timers instead of being locked out of it.
      void this.refreshPaneExits()
        .then(() => this.emit('paneExitsUpdated'))
        .catch((err) => console.error('[TmuxManager] Pane exit watcher error:', err));
    }, intervalMs);
  }

  stopPaneExitWatcher(): void {
    if (this.paneExitInterval) {
      clearInterval(this.paneExitInterval);
      this.paneExitInterval = null;
    }
  }

  startStatsCollection(intervalMs: number = DEFAULT_STATS_INTERVAL_MS): void {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
    }

    this.statsInterval = setInterval(async () => {
      try {
        const sessionsWithStats = await this.getSessionsWithStats();
        this.emit('statsUpdated', sessionsWithStats);
      } catch (err) {
        console.error('[TmuxManager] Stats collection error:', err);
      }
    }, intervalMs);
  }

  stopStatsCollection(): void {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
  }

  /**
   * Start periodic mouse mode sync for all tracked sessions.
   * Polls pane counts every 5s and toggles mouse on/off as needed.
   * Polls every 5s. On pane count change, toggles mouse on (>1 pane) or off (1 pane).
   * If enableMouseMode/disableMouseMode fails, lastPaneCount is NOT updated so it retries next poll.
   */
  startMouseModeSync(intervalMs: number = 5000): void {
    if (this.mouseSyncInterval) {
      clearInterval(this.mouseSyncInterval);
    }

    this.mouseSyncInterval = setInterval(async () => {
      if (IS_TEST_MODE) return;

      for (const session of this.sessions.values()) {
        const panes = await this.listPanes(session.muxName);
        const count = panes.length;
        if (count === 0) continue;

        const prev = this.lastPaneCount.get(session.muxName);
        if (prev === count) continue;

        // Pane count changed — toggle mouse mode
        if (count > 1) {
          if (await this.enableMouseMode(session.muxName)) {
            this.lastPaneCount.set(session.muxName, count);
          }
          // If enableMouseMode fails, DON'T update lastPaneCount — retry next poll
        } else {
          if (await this.disableMouseMode(session.muxName)) {
            this.lastPaneCount.set(session.muxName, count);
          }
        }
      }
    }, intervalMs);
  }

  stopMouseModeSync(): void {
    if (this.mouseSyncInterval) {
      clearInterval(this.mouseSyncInterval);
      this.mouseSyncInterval = null;
    }
    this.lastPaneCount.clear();
  }

  // ── COD-108 remote-session auto-reconnect watcher ─────────────────────────

  /**
   * Start the remote-reconnect watcher (COD-108). Each tick, for every tracked
   * session with `session.remote` whose local pane is DEAD, not intentionally
   * guarded, and within its backoff budget, emit `remoteSessionDropped` so the
   * session owner reattaches (re-running the idempotent remote command rejoins
   * the durable remote tmux session). After the attempt cap, emit
   * `remoteReconnectExhausted` once and go quiet.
   *
   * No-op tick body under `IS_TEST_MODE` (mirrors `startMouseModeSync`): tests
   * drive the logic deterministically via {@link runRemoteReconnectTick}.
   */
  startRemoteReconnectWatcher(intervalMs: number = DEFAULT_REMOTE_RECONNECT_INTERVAL_MS): void {
    if (this.remoteReconnectInterval) {
      clearInterval(this.remoteReconnectInterval);
    }
    this.remoteReconnectInterval = setInterval(async () => {
      if (IS_TEST_MODE) return;
      try {
        await this.runRemoteReconnectTick(Date.now(), isRemoteAutoReconnectEnabled());
      } catch (err) {
        console.error('[TmuxManager] Remote reconnect watcher error:', err);
      }
    }, intervalMs);
  }

  stopRemoteReconnectWatcher(): void {
    if (this.remoteReconnectInterval) {
      clearInterval(this.remoteReconnectInterval);
      this.remoteReconnectInterval = null;
    }
  }

  /**
   * Run ONE watcher tick. Extracted (and given an injected `now`/`enabled`) so
   * the reconnect logic is deterministically testable even though the live
   * `setInterval` body no-ops under test mode. For each remote session it
   * applies the pure {@link decideReconnect} decision and translates the result
   * into events + backoff/state transitions. Public for tests + the watcher.
   */
  /**
   * Refresh the cached remote-tmux liveness for a session whose pane is dead.
   * Fire-and-forget (async, not awaited by the sync tick): the probe is a slow
   * ssh round-trip, so it must not block the 5s watcher interval. On success it
   * writes the cached result; the NEXT tick then makes the revive decision with
   * fresh data. A clean exit makes the remote tmux session vanish, so the probe
   * resolves false and the watcher stops reviving it (2026-08-29).
   */
  private async refreshRemoteAlive(session: MuxSession): Promise<void> {
    if (!session.remote) return;
    if (this.remoteAliveInFlight.has(session.sessionId)) return;
    this.remoteAliveInFlight.add(session.sessionId);
    const remoteName = session.remote.remoteSessionName || remoteTmuxSessionName(session.sessionId);
    try {
      const alive = await remoteTmuxSessionAlive(session.remote, remoteName);
      this.remoteAliveCache.set(session.sessionId, alive);
    } catch {
      this.remoteAliveCache.set(session.sessionId, undefined);
    } finally {
      this.remoteAliveInFlight.delete(session.sessionId);
    }
  }

  async runRemoteReconnectTick(now: number, enabled: boolean): Promise<void> {
    for (const session of this.sessions.values()) {
      if (!session.remote) continue;
      const sessionId = session.sessionId;
      const state = this.reconnectState.get(sessionId);
      // Only probe when the pane is actually dead — otherwise the ssh round-trip
      // would run every 5s for every healthy remote session. The cache is
      // refreshed lazily so a clean exit (remote tmux gone) flips it to false
      // on the next tick and stops the auto-revive.
      const paneDead = await this.isPaneDead(session.muxName);
      if (!paneDead) {
        // A live pane makes whatever the probe last said STALE, so forget it:
        // after a successful reattach (or a manual restart) the next dead pane
        // must be probed afresh. A cached `true` from the transport drop would
        // otherwise revive a later CLEAN exit, the exact bug this cache exists
        // to prevent, and a cached `false` from a clean exit would leave a
        // manually restarted session with auto-reconnect permanently off.
        this.remoteAliveCache.delete(sessionId);
      } else if (this.remoteAliveCache.get(sessionId) === undefined) {
        void this.refreshRemoteAlive(session);
      }
      const action = decideReconnect({
        session: {
          sessionId,
          isRemote: true,
          paneDead,
          remoteAlive: this.remoteAliveCache.get(sessionId),
        },
        state,
        guarded: this.reconnectGuard.has(sessionId),
        enabled,
        now,
      });

      if (action.kind === 'emit') {
        const base = state ?? freshReconnectState();
        // Mark in-flight + advance backoff BEFORE emitting so a re-entrant tick
        // (or a synchronous listener) can never stack a second reconnect.
        this.reconnectState.set(sessionId, { ...advanceBackoff(base, now), inFlight: true });
        this.emit('remoteSessionDropped', { sessionId, attempt: action.attempt });
      } else if (action.kind === 'exhaust') {
        const base = state ?? freshReconnectState();
        if (!base.exhaustedEmitted) {
          this.reconnectState.set(sessionId, { ...base, exhausted: true, exhaustedEmitted: true });
          this.emit('remoteReconnectExhausted', { sessionId });
        }
      }
      // 'skip' → nothing to do.
    }
  }

  /**
   * Tell the watcher a reattach attempt for `sessionId` finished. On success,
   * reset the backoff so the session is healthy again; on failure, just clear
   * the in-flight flag so the next due tick can retry under the existing
   * backoff schedule. Called by the session owner after `respawnPane`.
   */
  noteRemoteReconnect(sessionId: string, success: boolean): void {
    if (success) {
      this.reconnectState.set(sessionId, resetReconnectState());
      return;
    }
    const state = this.reconnectState.get(sessionId);
    if (state) this.reconnectState.set(sessionId, { ...state, inFlight: false });
  }

  /**
   * Exclude a session from auto-reconnect (intentional teardown). Adds it to the
   * guard set and drops any backoff state so a closed/killed tab — especially a
   * non-owned remote DETACH — is never auto-revived. Idempotent.
   */
  guardRemoteReconnect(sessionId: string): void {
    this.reconnectGuard.add(sessionId);
    this.reconnectState.delete(sessionId);
    this.remoteAliveCache.delete(sessionId);
    this.remoteAliveInFlight.delete(sessionId);
  }

  /** Clear all per-session reconnect + guard state (e.g. when a session is removed). */
  clearRemoteReconnectState(sessionId: string): void {
    this.reconnectState.delete(sessionId);
    this.reconnectGuard.delete(sessionId);
    this.remoteAliveCache.delete(sessionId);
    this.remoteAliveInFlight.delete(sessionId);
  }

  destroy(): void {
    this.invalidateAllWindowResizes();
    this.stopStatsCollection();
    this.stopPaneExitWatcher();
    this.paneExits.clear();
    this.stopMouseModeSync();
    this.stopRemoteReconnectWatcher();
    this.reconnectState.clear();
    this.reconnectGuard.clear();
    this.remoteAliveCache.clear();
    this.remoteAliveInFlight.clear();
    this.remoteCaptureBackoff.clear();
    void this.remoteFrameSshPool.close().catch(() => {});
  }

  /** Release app-owned SSH control masters before web-server shutdown. */
  closeRemoteFrameConnections(): Promise<void> {
    return this.remoteFrameSshPool.close();
  }

  registerSession(session: MuxSession): void {
    this.sessions.set(session.sessionId, session);
    this.saveSessions();
  }

  setAttached(sessionId: string, attached: boolean): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.attached = attached;
      this.saveSessions();
    }
  }

  updateRespawnConfig(sessionId: string, config: PersistedRespawnConfig | undefined): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.respawnConfig = config;
      this.saveSessions();
    }
  }

  clearRespawnConfig(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session && session.respawnConfig) {
      delete session.respawnConfig;
      this.saveSessions();
    }
  }

  updateRalphEnabled(sessionId: string, enabled: boolean): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.ralphEnabled = enabled;
      this.saveSessions();
    }
  }

  /** Notes-only literal paste: preserve bytes and separate submission; never replay a partial paste. */
  async sendNotesInput(sessionId: string, text: string, canWrite: () => boolean = () => true): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (
      !session ||
      !isValidMuxName(session.muxName) ||
      !canWrite() ||
      Buffer.byteLength(text, 'utf8') > MAX_INPUT_LENGTH - 1
    )
      return false;
    if (IS_TEST_MODE && !this.notesExecutor) return true;
    const targetArgs = ['-L', this.tmuxSocket, 'send-keys', '-t', session.muxName];
    const execute = async (args: string[]) => {
      if (this.notesExecutor) await this.notesExecutor('tmux', args);
      else await execFileAsync('tmux', args, { timeout: EXEC_TIMEOUT_MS });
    };
    try {
      const paste = '\x1b[200~' + text + '\x1b[201~';
      await execute([...targetArgs, '-l', paste]);
      if (this.notesDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.notesDelayMs));
      if (this.sessions.get(sessionId) !== session || !canWrite()) return false;
      await execute([...targetArgs, 'Enter']);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Send input directly to a tmux session using `send-keys`.
   *
   * Uses tmux send-keys for reliable input delivery:
   * - `-l` flag sends literal text (no key interpretation)
   * - `Enter` key is sent as a SEPARATE tmux invocation after a small delay
   * - Ink (Claude CLI) needs text and Enter split to avoid treating Enter as a newline
   */
  async sendInput(sessionId: string, input: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.error(
        `[TmuxManager] sendInput failed: no session found for ${sessionId}. Known: ${Array.from(this.sessions.keys()).join(', ')}`
      );
      return false;
    }

    // TEST MODE: No-op — don't send input to real tmux sessions
    if (IS_TEST_MODE) {
      return true;
    }

    console.log(
      `[TmuxManager] sendInput to ${session.muxName}, input length: ${input.length}, hasCarriageReturn: ${input.includes('\r')}`
    );

    if (!isValidMuxName(session.muxName)) {
      console.error('[TmuxManager] Invalid session name in sendInput:', session.muxName);
      return false;
    }

    try {
      const hasCarriageReturn = input.includes('\r');
      const textPart = input.replace(/\r/g, '').replace(/\n/g, '').trimEnd();

      if (textPart && hasCarriageReturn) {
        // Send text first, then Enter as a SEPARATE tmux command after a short delay.
        // Ink (Claude CLI's terminal framework) needs them split — sending both in a
        // single tmux invocation (via \;) causes Ink to interpret Enter as a newline
        // character in the input buffer rather than as form submission.
        await execAsync(`${this.tmux()} send-keys -t "${session.muxName}" -l ${shellescape(textPart)}`, {
          timeout: EXEC_TIMEOUT_MS,
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        await execAsync(`${this.tmux()} send-keys -t "${session.muxName}" Enter`, {
          timeout: EXEC_TIMEOUT_MS,
        });
      } else if (textPart) {
        // Text only, no Enter
        await execAsync(`${this.tmux()} send-keys -t "${session.muxName}" -l ${shellescape(textPart)}`, {
          timeout: EXEC_TIMEOUT_MS,
        });
      } else if (hasCarriageReturn) {
        // Enter only
        await execAsync(`${this.tmux()} send-keys -t "${session.muxName}" Enter`, {
          timeout: EXEC_TIMEOUT_MS,
        });
      }

      return true;
    } catch (err) {
      console.error('[TmuxManager] Failed to send input:', err);
      return false;
    }
  }

  /**
   * Submit checkpoint input with independently acknowledged text and Enter
   * stages. Each stage gets one bounded retry; an acknowledged text stage is
   * never repeated merely because Enter failed.
   */
  async sendCheckpointCommand(sessionId: string, input: string): Promise<CommandDeliveryResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { ok: false, stage: 'text', error: `no session found for ${sessionId}`, attempt: 1 };
    }
    if (!isValidMuxName(session.muxName)) {
      return { ok: false, stage: 'text', error: `invalid session name: ${session.muxName}`, attempt: 1 };
    }

    // Normal vitest instances remain a no-op for tmux safety. A deliberately
    // injected executor exercises this exact production adapter without
    // touching the user's tmux server.
    if (IS_TEST_MODE && !this.checkpointExecutor) return { ok: true, attempt: 1 };

    const hasCarriageReturn = input.includes('\r');
    const textPart = input.replace(/\r/g, '').replace(/\n/g, '').trimEnd();
    const isCodexSkillInvocation = session.mode === 'codex' && CODEX_SKILL_INVOCATION_PATTERN.test(textPart);
    const textCommand = `${this.tmux()} send-keys -t "${session.muxName}" -l ${shellescape(textPart)}`;
    const enterCommand = `${this.tmux()} send-keys -t "${session.muxName}" Enter`;
    let deliveryAttempt = 1;

    const execute = async (command: string): Promise<void> => {
      if (this.checkpointExecutor) {
        await this.checkpointExecutor(command);
        return;
      }
      await execAsync(command, { timeout: EXEC_TIMEOUT_MS });
    };

    const runStage = async (
      stage: 'text' | 'enter',
      command: string
    ): Promise<{ ok: true } | { ok: false; result: CommandDeliveryResult }> => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        deliveryAttempt = Math.max(deliveryAttempt, attempt);
        try {
          await execute(command);
          return { ok: true };
        } catch (err) {
          if (attempt === 2) {
            return {
              ok: false,
              result: { ok: false, stage, error: getErrorMessage(err), attempt },
            };
          }
        }
      }
      return { ok: false, result: { ok: false, stage, attempt: 2 } };
    };

    if (textPart) {
      const text = await runStage('text', textCommand);
      if (!text.ok) return text.result;
    }

    if (hasCarriageReturn) {
      if (textPart && this.checkpointDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.checkpointDelayMs));
      }
      const enter = await runStage('enter', enterCommand);
      if (!enter.ok) return enter.result;

      if (isCodexSkillInvocation) {
        // Codex's first Enter accepts the picker selection and stages the skill
        // token; a second, independently acknowledged Enter submits the turn.
        // Reusing runStage means a submission retry never replays text or the
        // already-acknowledged selection Enter.
        if (this.checkpointDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.checkpointDelayMs));
        }
        const submit = await runStage('enter', enterCommand);
        if (!submit.ok) return submit.result;
      }
    }

    return { ok: true, attempt: deliveryAttempt };
  }

  // ========== Pane Methods (for Agent Team teammate panes) ==========

  /**
   * Enable mouse mode for an existing tmux session.
   * Allows clicking to select panes in agent team split-pane layouts.
   * When mouse mode is on, tmux intercepts mouse events (slow selection, no browser copy).
   */
  async enableMouseMode(muxName: string): Promise<boolean> {
    if (IS_TEST_MODE) return true;
    if (!isValidMuxName(muxName)) {
      console.error('[TmuxManager] Invalid session name in enableMouseMode:', muxName);
      return false;
    }

    try {
      await execAsync(`${this.tmux()} set-option -t "${muxName}" mouse on`, {
        encoding: 'utf-8',
        timeout: EXEC_TIMEOUT_MS,
      });
      console.log(`[TmuxManager] Mouse mode ON for ${muxName}`);
      return true;
    } catch (err) {
      console.error(`[TmuxManager] Failed to enable mouse mode for ${muxName}:`, err);
      return false;
    }
  }

  /**
   * Disable mouse mode for an existing tmux session.
   * Restores native xterm.js text selection and browser clipboard copy.
   */
  async disableMouseMode(muxName: string): Promise<boolean> {
    if (IS_TEST_MODE) return true;
    if (!isValidMuxName(muxName)) {
      console.error('[TmuxManager] Invalid session name in disableMouseMode:', muxName);
      return false;
    }

    try {
      await execAsync(`${this.tmux()} set-option -t "${muxName}" mouse off`, {
        encoding: 'utf-8',
        timeout: EXEC_TIMEOUT_MS,
      });
      console.log(`[TmuxManager] Mouse mode OFF for ${muxName}`);
      return true;
    } catch (err) {
      console.error(`[TmuxManager] Failed to disable mouse mode for ${muxName}:`, err);
      return false;
    }
  }

  /**
   * Sync mouse mode based on pane count: enable if split (>1 pane), disable if single.
   * Called by TeamWatcher when teammates spawn/despawn panes.
   * Uses `tmux list-panes` for bulletproof detection — counts actual panes, not config.
   */
  async syncMouseMode(muxName: string): Promise<boolean> {
    if (IS_TEST_MODE) return true;
    const panes = await this.listPanes(muxName);
    if (panes.length > 1) {
      return this.enableMouseMode(muxName);
    } else {
      return this.disableMouseMode(muxName);
    }
  }

  /**
   * List all panes in a tmux session.
   * Returns structured info for each pane.
   */
  /**
   * Every tracked session's live pane cwd, in ONE exec (COD-386).
   *
   * Batched deliberately: this runs on an interval, and a per-session
   * `display-message` would scale the exec count with the tab count for
   * information that is a single `list-panes -a` away.
   */
  async listPaneCurrentPaths(): Promise<Map<string, string>> {
    if (IS_TEST_MODE) return new Map();

    try {
      const { stdout } = await execAsync(`${this.tmux()} list-panes -a -F '${PANE_CWD_FORMAT}' 2>/dev/null || true`, {
        encoding: 'utf-8',
        timeout: EXEC_TIMEOUT_MS,
      });
      return parsePaneCurrentPaths(stdout.trim());
    } catch (err) {
      console.error('[TmuxManager] Failed to list pane paths:', getErrorMessage(err));
      return new Map();
    }
  }

  async listPanes(muxName: string): Promise<PaneInfo[]> {
    if (IS_TEST_MODE) return [];
    if (!isValidMuxName(muxName)) {
      console.error('[TmuxManager] Invalid session name in listPanes:', muxName);
      return [];
    }

    try {
      const output = (
        await execAsync(
          `${this.tmux()} list-panes -t "${muxName}" -F '#{pane_id}:#{pane_index}:#{pane_pid}:#{pane_width}:#{pane_height}'`,
          { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS }
        )
      ).stdout.trim();

      return output
        .split('\n')
        .map((line) => {
          const [paneId, indexStr, pidStr, widthStr, heightStr] = line.split(':');
          return {
            paneId,
            paneIndex: parseInt(indexStr, 10),
            panePid: parseInt(pidStr, 10),
            width: parseInt(widthStr, 10),
            height: parseInt(heightStr, 10),
          };
        })
        .filter((p) => !Number.isNaN(p.paneIndex));
    } catch {
      return [];
    }
  }

  /**
   * Send input to a specific pane within a tmux session.
   * Uses the same literal text approach as sendInput() but targets a specific pane.
   */
  sendInputToPane(muxName: string, paneTarget: string, input: string): boolean {
    if (IS_TEST_MODE) return true;
    const target = resolveTmuxPaneTarget(muxName, paneTarget);
    if (!target) {
      console.error('[TmuxManager] Invalid pane target in sendInputToPane:', { muxName, paneTarget });
      return false;
    }

    const tmux = this.tmux();

    try {
      const hasCarriageReturn = input.includes('\r');
      const textPart = input.replace(/\r/g, '').replace(/\n/g, '').trimEnd();

      if (textPart && hasCarriageReturn) {
        execSync(`${tmux} send-keys -t ${shellescape(target)} -l ${shellescape(textPart)}`, {
          encoding: 'utf-8',
          timeout: EXEC_TIMEOUT_MS,
        });
        execSync(`${tmux} send-keys -t ${shellescape(target)} Enter`, {
          encoding: 'utf-8',
          timeout: EXEC_TIMEOUT_MS,
        });
      } else if (textPart) {
        execSync(`${tmux} send-keys -t ${shellescape(target)} -l ${shellescape(textPart)}`, {
          encoding: 'utf-8',
          timeout: EXEC_TIMEOUT_MS,
        });
      } else if (hasCarriageReturn) {
        execSync(`${tmux} send-keys -t ${shellescape(target)} Enter`, {
          encoding: 'utf-8',
          timeout: EXEC_TIMEOUT_MS,
        });
      }

      return true;
    } catch (err) {
      console.error('[TmuxManager] Failed to send input to pane:', err);
      return false;
    }
  }

  /**
   * Capture a pane's text and SGR styles.
   *
   * Two modes:
   * - Visible (default): `capture-pane -p -e` grabs only the on-screen frame,
   *   then `formatPaneSnapshot` repaints each row at its absolute position so
   *   the browser xterm reproduces the live frame. Used for fast tab switches.
   * - Full history (`opts.fullHistory`): `capture-pane -p -e -S -` grabs the
   *   ENTIRE tmux scrollback (COD-47; `captureStartFlag` bounds it to the last
   *   N lines for the history view's fast first page, COD-187), returned as
   *   linear scrollback text with SGR codes preserved. Rows are not repainted
   *   at absolute positions — a multi-screen history can't be painted into a
   *   single visible frame — but the capture DOES end with a cursor move
   *   putting the caret back where the pane has it, anchored to the captured
   *   tail (COD-185/COD-433, `formatFullHistoryCapture`), so xterm does not
   *   leave the cursor at the end of the final captured status row. Returns ''
   *   for a pane holding nothing visible, so the caller keeps whatever history
   *   it already had.
   *   Caveat: lines tmux has already evicted past its history-limit are gone.
   */
  /**
   * Plain visible-frame text for the working/idle probe (see `session.ts`).
   *
   * One `capture-pane` and nothing else: no `-e` styles, no `display-message`
   * cursor query, no repaint reconstruction: this feeds a regex, not a
   * terminal. Returns null in tests (no tmux) so callers fall back to their
   * stream heuristics rather than reading an empty screen as "not working".
   */
  capturePaneText(muxName: string, paneTarget?: string): string | null {
    if (IS_TEST_MODE) return null;
    const target = resolveTmuxPaneTarget(muxName, paneTarget);
    if (!target) return null;
    try {
      return execSync(`${this.tmux()} capture-pane -p -t ${shellescape(target)}`, {
        encoding: 'utf-8',
        timeout: EXEC_TIMEOUT_MS,
      });
    } catch {
      // A dead/renamed pane is an ordinary outcome here, not an error worth logging
      // on a timer; the caller treats null as "no evidence either way".
      return null;
    }
  }

  /**
   * Capture the visible screen from the session's active pane without
   * blocking the event loop. Passing argv directly to execFile avoids a shell
   * and targeting the session lets tmux resolve its active pane in one command.
   */
  async capturePaneTextAsync(muxName: string, opts?: { signal?: AbortSignal }): Promise<string | null> {
    if (!SAFE_TMUX_SOCKET_PATTERN.test(this.tmuxSocket) || !isValidMuxName(muxName)) return null;

    const execOptions: TmuxPaneTextExecOptions = {
      encoding: 'utf8',
      timeout: ASYNC_TEXT_CAPTURE_TIMEOUT_MS,
      maxBuffer: ASYNC_TEXT_CAPTURE_MAX_BUFFER,
    };
    if (opts?.signal) execOptions.signal = opts.signal;

    try {
      const { stdout } = await this.paneTextExecutor(
        'tmux',
        ['-L', this.tmuxSocket, 'capture-pane', '-p', '-t', muxName],
        execOptions
      );
      if (Buffer.byteLength(stdout, 'utf8') > ASYNC_TEXT_CAPTURE_MAX_BUFFER) return null;
      return stdout;
    } catch {
      // Dead/renamed panes, aborts, timeouts, and bounded-buffer overflow are
      // all ordinary polling outcomes. The activity caller treats null as
      // inconclusive and will retry on its next scheduled turn.
      return null;
    }
  }

  capturePaneBuffer(muxName: string, paneTarget?: string, opts?: PaneCaptureOptions): string | null {
    if (IS_TEST_MODE) return '';
    const target = resolveTmuxPaneTarget(muxName, paneTarget);
    if (!target) {
      console.error('[TmuxManager] Invalid pane target in capturePaneBuffer:', { muxName, paneTarget });
      return null;
    }

    const fullHistory = opts?.fullHistory === true;

    try {
      // `-S -` extends the capture start to the very top of the scrollback.
      const captureFlags = fullHistory
        ? `capture-pane -p -e ${captureStartFlag(opts?.lastLines)}`
        : 'capture-pane -p -e';
      // execSync's default maxBuffer (1MB) kills multi-MB scrollback dumps
      // (ENOBUFS) and would silently degrade full-history capture to the byte
      // buffer for exactly the long sessions it exists for — size it from the
      // consumer's byte cap plus ANSI-overhead slack instead.
      const execOpts: { encoding: 'utf-8'; timeout: number; maxBuffer?: number } = {
        encoding: 'utf-8',
        timeout: EXEC_TIMEOUT_MS,
      };
      if (fullHistory) {
        execOpts.maxBuffer =
          (opts?.maxCaptureBytes ?? DEFAULT_TERMINAL_BUFFER_MAX_BYTES) + FULL_HISTORY_CAPTURE_SLACK_BYTES;
      }
      const rawCapture = execSync(`${this.tmux()} ${captureFlags} -t ${shellescape(target)}`, execOpts);
      // Query the cursor BEFORE deciding anything else. On the full-history path
      // it settles both how the capture is trimmed and whether a cursor move is
      // appended, and those two have to agree: trailing blank rows are only safe
      // to keep when a move follows to put the caret back above them.
      const geometry = queryPaneCursor(() =>
        execSync(
          `${this.tmux()} display-message -p -t ${shellescape(target)} '#{cursor_x} #{cursor_y} #{pane_width} #{pane_height}'`,
          { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS }
        )
      );
      // Report the size the pane was really drawing at. The visible-frame path
      // below addresses every row absolutely, so a consumer whose terminal is
      // shorter than this piles the overflow rows onto its last line and loses
      // the rows it overwrote. The full-history path instead ends in a RELATIVE
      // cursor move, which costs it nothing when the two sizes disagree, so the
      // geometry is reported there for diagnosis rather than for repair. Only
      // the caller can see both sizes, so hand it this one.
      if (opts && geometry) opts.capturedGeometry = { cols: geometry.cols, rows: geometry.rows };

      if (fullHistory) {
        // COD-190: fullHistory keeps the final screen's trailing blank rows so a
        // replayed buffer reproduces the exact tmux screen geometry (the
        // history-view no-jump landing and the appended cursor CSI both depend
        // on it); only the terminating newline is trimmed. Visible-frame mode is
        // row-positioned by formatPaneSnapshot and never needed the blanks.
        const trimmed = rawCapture.replace(/\n$/, '');
        // An all-blank pane has to keep reading as "nothing to replay". The caller
        // treats an empty string as "capture unavailable" and keeps the byte
        // history; blank rows plus a cursor move are not empty, so without this a
        // blank pane REPLACES that history with a blank screen — the downgrade
        // `_replayWouldShrinkBuffer` exists to refuse, arriving from the server
        // side where that guard cannot see it.
        if (!hasVisibleContent(trimmed)) return '';
        // Full-history spans many screens — return it as raw linear scrollback
        // rather than repainting rows at single-screen absolute positions. tmux
        // joins scrollback rows with a bare `\n`; normalize to `\r\n` so a fresh
        // xterm (convertEol:false) starts each replayed line at column 0 instead
        // of staircasing diagonally (COD-138), then anchor the caret to the
        // captured tail (COD-433). With no geometry that anchor is unavailable
        // and the normalized scrollback is returned as-is.
        return formatFullHistoryCapture(trimmed, geometry);
      }

      const buffer = rawCapture.replace(/\n+$/g, '');
      if (geometry) return formatPaneSnapshot(buffer.split('\n'), geometry);
      // Cursor query failed or geometry was invalid, so we skip the absolute-
      // positioned snapshot repaint and fall back to the raw capture. Normalize
      // its bare `\n` line endings to `\r\n` so the replay doesn't staircase
      // diagonally in a fresh xterm (COD-138, same reason as the fullHistory path).
      return normalizeScrollbackEol(buffer);
    } catch (err) {
      // ENOBUFS carries the truncated multi-MB stdout on the error object —
      // log a concise line instead of dumping it into the journal.
      if ((err as NodeJS.ErrnoException)?.code === 'ENOBUFS') {
        console.error('[TmuxManager] Pane capture exceeded maxBuffer (ENOBUFS); falling back to byte history');
      } else {
        console.error('[TmuxManager] Failed to capture pane buffer:', err);
      }
      return null;
    }
  }

  /**
   * Capture the active pane for a tmux session.
   *
   * Pane ids are not stable across respawns or restores, so callers should not
   * assume the first pane remains `%0`.
   */
  captureActivePaneBuffer(muxName: string, opts?: { fullHistory?: boolean; lastLines?: number }): string | null {
    if (IS_TEST_MODE) return '';
    if (!isValidMuxName(muxName)) {
      console.error('[TmuxManager] Invalid session name in captureActivePaneBuffer:', muxName);
      return null;
    }

    try {
      const output = execSync(`${this.tmux()} list-panes -t ${shellescape(muxName)} -F '#{pane_id}:#{pane_active}'`, {
        encoding: 'utf-8',
        timeout: EXEC_TIMEOUT_MS,
      }).trim();
      const target = resolveActivePaneTarget(output);
      return target ? this.capturePaneBuffer(muxName, target, opts) : null;
    } catch (err) {
      console.error('[TmuxManager] Failed to resolve active pane for capture:', err);
      return null;
    }
  }

  /**
   * COD-180 — capture a REMOTE session's pane buffer over ssh.
   *
   * For remote sessions the canonical scrollback lives ONLY on the remote tmux
   * server: the local wrapper window is a nested-tmux client that gets repainted
   * in place, so its own history is essentially empty (~one screen). Replay,
   * tab-switch rewrite, and the COD-179 reconcile must therefore capture from
   * the remote server, not the local wrapper.
   *
   * Connects with the same `buildSshConnectionArgv` options as the launch/probe
   * paths (COD-107) and targets the remote session by its deterministic
   * `codeman-<id8>` name (or `remote.remoteSessionName` for attached, non-owned
   * sessions). Returns null on any failure — callers fall back to local data.
   */
  async captureRemotePaneBuffer(
    remote: SessionRemote,
    sessionId: string,
    muxName: string,
    opts?: { fullHistory?: boolean; visibleFrame?: boolean; lastLines?: number; owner?: string }
  ): Promise<string | null> {
    if (IS_TEST_MODE) return '';
    // Owned sessions (this Codeman launched them via `new-session -A`) live on
    // the dedicated `codeman-remote` socket under their deterministic
    // `codeman-ssh-<id8>` name. Non-owned (discovered + attached) sessions were
    // created by another instance on the canonical `codeman` socket and carry
    // their existing name in `remote.remoteSessionName`. Capture from whichever
    // socket/name holds the canonical scrollback, mirroring the launch/attach
    // logic in buildRemoteSessionCommand.
    const owned = remote.owned !== false;
    const isOwnedRemoteTarget = owned && !remote.remoteSessionName;
    const target = remote.remoteSessionName || remoteTmuxSessionName(sessionId) || muxName;
    const socket = isOwnedRemoteTarget ? REMOTE_TMUX_SOCKET : 'codeman';
    if (!isValidRemoteTmuxTarget(target)) {
      console.error('[TmuxManager] Invalid remote session name in captureRemotePaneBuffer:', target);
      return null;
    }
    const sshArgv = buildSshConnectionArgv(remote);
    const sshTarget = remoteSshTarget(remote);
    // COD-463: every capture rides the pooled ControlMaster transport and goes
    // through the per-host backoff, so a host whose NEW ssh sessions hang costs
    // one timeout, not one per tab switch. A null from the backoff means "host
    // degraded, not tried": the caller serves its local fallback at once.
    const hostKey = remoteCaptureHostKey(sshArgv, sshTarget);
    const runCapture = (command: string) =>
      this.remoteCaptureBackoff.run(hostKey, () =>
        this.remoteFrameSshPool.capture(sshArgv, sshTarget, command, opts?.owner, {
          timeout: REMOTE_CAPTURE_TIMEOUT_MS,
          maxBuffer: REMOTE_CAPTURE_MAX_BUFFER,
        })
      );
    // COD-187 (live mirror) — visible-frame snapshot with cursor positioning,
    // parity with the local visible path (formatPaneSnapshot). ONE combined ssh
    // invocation fetches capture + geometry; a delimiter line separates them.
    if (opts?.visibleFrame) {
      try {
        const stdout = await runCapture(withRemotePathBootstrap(buildRemoteFrameCommand(target, socket)));
        return stdout === null ? null : parseRemoteFrameCapture(stdout);
      } catch (err) {
        console.error('[TmuxManager] Remote frame capture failed (falling back to local wrapper):', err);
        return null;
      }
    }
    // The remote login shell may not have tmux on PATH (macOS non-interactive
    // zsh lacks /opt/homebrew/bin) — bootstrap PATH exactly like the launcher.
    const captureCmd = withRemotePathBootstrap(
      opts?.fullHistory
        ? buildRemoteFullHistoryCommand(target, socket, opts?.lastLines)
        : `tmux -L ${socket} capture-pane -p -e -t ${shellescape(target)}`
    );
    try {
      const stdout = await runCapture(captureCmd);
      if (stdout === null) return null;
      if (opts?.fullHistory) return parseRemoteFullHistoryCapture(stdout);
      return normalizeScrollbackEol(stdout.replace(/\n+$/g, ''));
    } catch (err) {
      console.error('[TmuxManager] Remote pane capture failed (falling back to local):', err);
      return null;
    }
  }

  /**
   * COD-463: true while this remote's host is in capture backoff — captures are
   * being served from the local wrapper, which may not be live and holds only
   * about one screen of history.
   */
  isRemoteCaptureDegraded(remote: SessionRemote): boolean {
    return this.remoteCaptureBackoff.isDegraded(
      remoteCaptureHostKey(buildSshConnectionArgv(remote), remoteSshTarget(remote))
    );
  }

  /**
   * Start piping pane output to a file using tmux pipe-pane.
   * Only pipes output direction (-O) to avoid echoing input.
   */
  startPipePane(muxName: string, paneTarget: string, outputFile: string): boolean {
    if (IS_TEST_MODE) return true;
    const target = resolveTmuxPaneTarget(muxName, paneTarget);
    if (!target) {
      console.error('[TmuxManager] Invalid pane target in startPipePane:', { muxName, paneTarget });
      return false;
    }
    if (!isValidPath(outputFile)) {
      console.error('[TmuxManager] Invalid output file path:', outputFile);
      return false;
    }

    try {
      execSync(`${this.tmux()} pipe-pane -O -t ${shellescape(target)} ${shellescape('cat >> ' + outputFile)}`, {
        encoding: 'utf-8',
        timeout: EXEC_TIMEOUT_MS,
      });
      return true;
    } catch (err) {
      console.error('[TmuxManager] Failed to start pipe-pane:', err);
      return false;
    }
  }

  /**
   * Stop piping pane output (calling pipe-pane with no command stops piping).
   */
  stopPipePane(muxName: string, paneTarget: string): boolean {
    if (IS_TEST_MODE) return true;
    const target = resolveTmuxPaneTarget(muxName, paneTarget);
    if (!target) {
      console.error('[TmuxManager] Invalid pane target in stopPipePane:', { muxName, paneTarget });
      return false;
    }

    try {
      execSync(`${this.tmux()} pipe-pane -t ${shellescape(target)}`, {
        encoding: 'utf-8',
        timeout: EXEC_TIMEOUT_MS,
      });
      return true;
    } catch (err) {
      console.error('[TmuxManager] Failed to stop pipe-pane:', err);
      return false;
    }
  }

  getAttachCommand(): string {
    return 'tmux';
  }

  getAttachArgs(muxName: string): string[] {
    return ['-L', this.tmuxSocket, 'attach-session', '-t', muxName];
  }

  setManualWindowSize(muxName: string): boolean {
    if (!isValidMuxName(muxName)) {
      console.error('[TmuxManager] Invalid session name in setManualWindowSize:', muxName);
      return false;
    }

    try {
      execSync(`${this.tmux()} set-window-option -t ${shellescape(muxName)} window-size manual`, {
        timeout: EXEC_TIMEOUT_MS,
        stdio: 'ignore',
      });
      return true;
    } catch (err) {
      console.error('[TmuxManager] Failed to set manual window size:', err);
      return false;
    }
  }

  resizeWindow(muxName: string, cols: number, rows: number, onComplete?: (success: boolean) => void): boolean {
    if (!isValidMuxName(muxName)) {
      console.error('[TmuxManager] Invalid session name in resizeWindow:', muxName);
      return false;
    }
    if (!isValidTerminalDimension(cols) || !isValidTerminalDimension(rows)) {
      console.error('[TmuxManager] Invalid resize dimensions:', { cols, rows });
      return false;
    }

    const state = this.pendingWindowResizes.get(muxName) ?? {
      generation: ++this.windowResizeGeneration,
      running: false,
      active: null,
      pending: null,
      cancelled: false,
    };
    const superseded = state.pending;
    state.pending = { cols, rows, onComplete, completed: false };
    this.pendingWindowResizes.set(muxName, state);
    if (superseded) this.completeWindowResizeRequest(superseded, false);
    if (!state.running) this.drainWindowResize(muxName, state);
    return true;
  }

  private drainWindowResize(
    muxName: string,
    state: {
      generation: number;
      running: boolean;
      active: WindowResizeRequest | null;
      pending: WindowResizeRequest | null;
      cancelled: boolean;
    }
  ): void {
    if (state.running || state.cancelled || !this.isCurrentWindowResize(muxName, state)) return;

    const next = state.pending;
    if (!next) {
      this.pendingWindowResizes.delete(muxName);
      return;
    }

    state.pending = null;
    state.active = next;
    state.running = true;
    let completed = false;
    const complete = (error: unknown): void => {
      if (completed) return;
      completed = true;
      try {
        if (error) {
          try {
            console.error('[TmuxManager] Failed to resize tmux window:', error);
          } catch {
            // Error reporting is best-effort and must not strand the resize queue.
          }
        }
      } finally {
        const succeeded = !error && !state.cancelled && this.isCurrentWindowResize(muxName, state);
        this.completeWindowResizeRequest(next, succeeded);
        state.active = null;
        state.running = false;
        if (!state.cancelled && this.isCurrentWindowResize(muxName, state)) {
          this.drainWindowResize(muxName, state);
        }
      }
    };

    // Fire-and-forget: this runs on the interactive resize path (WS {t:'z'} and
    // HTTP /resize), so use a non-blocking exec — a slow/hung tmux must not stall
    // the Fastify event loop while other sessions' input/SSE are served. The sole
    // caller (Session.resize) ignores the result, and under `window-size manual`
    // the subsequent ptyProcess.resize is subordinate to this authoritative size.
    try {
      exec(
        `${this.tmux()} resize-window -t ${shellescape(muxName)} -x ${next.cols} -y ${next.rows}`,
        { timeout: EXEC_TIMEOUT_MS },
        complete
      );
    } catch (error) {
      complete(error);
    }
  }

  private completeWindowResizeRequest(request: WindowResizeRequest, success: boolean): void {
    if (request.completed) return;
    request.completed = true;
    try {
      request.onComplete?.(success);
    } catch (error) {
      try {
        console.error('[TmuxManager] Resize completion callback failed:', error);
      } catch {
        // Completion reporting is best-effort and must not strand the queue.
      }
    }
  }

  private isCurrentWindowResize(muxName: string, state: { generation: number }): boolean {
    const current = this.pendingWindowResizes.get(muxName);
    return current === state && current.generation === state.generation;
  }

  private invalidateWindowResize(muxName: string): void {
    const state = this.pendingWindowResizes.get(muxName);
    if (!state) return;
    state.cancelled = true;
    const active = state.active;
    const pending = state.pending;
    state.active = null;
    state.pending = null;
    if (this.isCurrentWindowResize(muxName, state)) {
      this.pendingWindowResizes.delete(muxName);
    }
    if (active) this.completeWindowResizeRequest(active, false);
    if (pending) this.completeWindowResizeRequest(pending, false);
  }

  private invalidateAllWindowResizes(): void {
    for (const state of this.pendingWindowResizes.values()) {
      state.cancelled = true;
      const active = state.active;
      const pending = state.pending;
      state.active = null;
      state.pending = null;
      if (active) this.completeWindowResizeRequest(active, false);
      if (pending) this.completeWindowResizeRequest(pending, false);
    }
    this.pendingWindowResizes.clear();
  }

  isAvailable(): boolean {
    return TmuxManager.isTmuxAvailable();
  }

  /**
   * Check if tmux is available on the system.
   */
  static isTmuxAvailable(): boolean {
    try {
      execSync('which tmux', { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Shell-escape a string for use as a single argument.
 * Wraps in single quotes, escaping any embedded single quotes.
 */
function shellescape(str: string): string {
  // Replace single quotes with '\'' (end quote, escaped quote, restart quote)
  return "'" + str.replace(/'/g, "'\\''") + "'";
}
