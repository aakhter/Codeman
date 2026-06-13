/**
 * @fileoverview Codeman CLI command definitions
 *
 * Defines all CLI commands and subcommands for managing Claude sessions,
 * tasks, Ralph loops, and the web server.
 *
 * @module cli
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { createRequire } from 'module';
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { dataPath } from './config/instance.js';
import { getSessionManager } from './session-manager.js';
import { getTaskQueue } from './task-queue.js';
import { getRalphLoop } from './ralph-loop.js';
import { getStore } from './state-store.js';
import { getErrorMessage } from './types.js';
import { isSupportedAttachmentExtension } from './attachment-registry.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

const program = new Command();

program.name('codeman').description('Claude Code session manager with autonomous Ralph Loop').version(pkg.version);

function makeAttachmentMagicLink(filePath: string): string {
  return `codeman://attach?path=${encodeURIComponent(filePath)}`;
}

function readCodemanEnv(): Record<string, string> {
  const envPath = dataPath('.env');
  try {
    const text = readFileSync(envPath, 'utf-8');
    const result: Record<string, string> = {};
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      result[match[1]] = value;
    }
    return result;
  } catch {
    return {};
  }
}

/** Minimal shape of a `/api/mux-sessions` row used by the `mux` command. */
interface MuxRow {
  sessionId: string;
  muxName: string;
  name?: string;
  mode?: string;
  attached?: boolean;
  pid?: number;
}

/**
 * Render the tmux <-> Codeman session mapping as an aligned text table.
 *
 * Pure helper (no IO) so it can be unit-tested in isolation. Columns:
 * Display name | tmux session (muxName) | sessionId | mode | status.
 */
export function formatMuxTable(rows: MuxRow[]): string {
  if (!rows || rows.length === 0) {
    return 'No tmux/Codeman sessions found on the running instance.';
  }

  const headers = ['Display name', 'tmux session', 'sessionId', 'mode', 'status'];
  const cells = rows.map((r) => [
    r.name || '(unnamed)',
    r.muxName || '',
    r.sessionId || '',
    r.mode || '',
    r.attached ? 'attached' : 'detached',
  ]);

  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((row) => row[i].length)));
  const renderRow = (vals: string[]): string =>
    vals
      .map((v, i) => v.padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  const separator = widths.map((w) => '-'.repeat(w)).join('  ');

  return [renderRow(headers), separator, ...cells.map(renderRow)].join('\n');
}

async function postAttachment(apiUrl: string, sessionId: string, filePath: string): Promise<boolean> {
  const envFile = readCodemanEnv();
  const username = process.env.CODEMAN_USERNAME || envFile.CODEMAN_USERNAME || 'admin';
  const password = process.env.CODEMAN_PASSWORD || envFile.CODEMAN_PASSWORD;
  const url = new URL(`/api/sessions/${encodeURIComponent(sessionId)}/attachments`, apiUrl);
  const body = JSON.stringify({ path: filePath });
  const transport = url.protocol === 'https:' ? https : http;

  return new Promise((resolve) => {
    const headers: Record<string, string | number> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    };
    if (password) {
      headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    }

    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        method: 'POST',
        path: `${url.pathname}${url.search}`,
        rejectUnauthorized: false,
        headers,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 300)));
      }
    );
    req.on('error', () => resolve(false));
    req.write(body);
    req.end();
  });
}

/** Header carrying the per-instance hook secret on `/api/hook-event`. */
const HOOK_SECRET_HEADER = 'X-Codeman-Hook-Secret';

/**
 * POST a hook event to `/api/hook-event` using the per-instance hook secret
 * (read from `$CODEMAN_HOOK_SECRET_FILE`) — mirrors how Claude Code hook curls
 * authenticate. Resolves the parsed JSON response body, or null on failure.
 */
async function postHookEvent(
  apiUrl: string,
  event: string,
  sessionId: string,
  data: Record<string, unknown>
): Promise<unknown> {
  const url = new URL('/api/hook-event', apiUrl);
  const body = JSON.stringify({ event, sessionId, data });
  const transport = url.protocol === 'https:' ? https : http;

  let secret = '';
  const secretFile = process.env.CODEMAN_HOOK_SECRET_FILE;
  if (secretFile) {
    try {
      secret = readFileSync(secretFile, 'utf-8').trim();
    } catch {
      secret = '';
    }
  }

  return new Promise((resolve) => {
    const headers: Record<string, string | number> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    };
    if (secret) headers[HOOK_SECRET_HEADER] = secret;

    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        method: 'POST',
        path: `${url.pathname}${url.search}`,
        rejectUnauthorized: false,
        headers,
      },
      (res) => {
        let resBody = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk) => (resBody += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(resBody));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

// ============ Session Commands ============

const sessionCmd = program.command('session').alias('s').description('Manage Claude sessions');

sessionCmd
  .command('start')
  .description('Start a new Claude session')
  .option('-d, --dir <path>', 'Working directory', process.cwd())
  .action(async (options) => {
    try {
      const manager = getSessionManager();
      const session = await manager.createSession(options.dir);
      console.log(chalk.green(`✓ Session started: ${session.id}`));
      console.log(`  Working directory: ${session.workingDir}`);
      console.log(`  PID: ${session.pid}`);
    } catch (err) {
      console.error(chalk.red(`✗ Failed to start session: ${getErrorMessage(err)}`));
      process.exit(1);
    }
  });

sessionCmd
  .command('stop <id>')
  .description('Stop a session')
  .action(async (id) => {
    try {
      const manager = getSessionManager();
      await manager.stopSession(id);
      console.log(chalk.green(`✓ Session stopped: ${id}`));
    } catch (err) {
      console.error(chalk.red(`✗ Failed to stop session: ${getErrorMessage(err)}`));
      process.exit(1);
    }
  });

sessionCmd
  .command('list')
  .alias('ls')
  .description('List all sessions')
  .action(() => {
    const manager = getSessionManager();
    const sessions = manager.getAllSessions();
    const stored = manager.getStoredSessions();

    if (sessions.length === 0 && Object.keys(stored).length === 0) {
      console.log(chalk.yellow('No sessions found'));
      return;
    }

    console.log(chalk.bold('\nActive Sessions:'));
    if (sessions.length === 0) {
      console.log('  (none)');
    } else {
      for (const session of sessions) {
        const status =
          session.status === 'idle'
            ? chalk.green('idle')
            : session.status === 'busy'
              ? chalk.yellow('busy')
              : chalk.red(session.status);
        console.log(`  ${chalk.cyan(session.id.slice(0, 8))} ${status} ${session.workingDir}`);
      }
    }

    const stoppedSessions = Object.values(stored).filter((s) => s.status === 'stopped');
    if (stoppedSessions.length > 0) {
      console.log(chalk.bold('\nStopped Sessions:'));
      for (const session of stoppedSessions) {
        const name = session.name ? ` (${session.name})` : '';
        console.log(`  ${chalk.gray(session.id.slice(0, 8))} ${chalk.gray('stopped')}${name} ${session.workingDir}`);
      }
    }

    // Show active sessions from state (when web server manages them)
    const activeSessions = Object.values(stored).filter((s) => s.status !== 'stopped');
    if (sessions.length === 0 && activeSessions.length > 0) {
      console.log(chalk.bold('\nActive Sessions (from web server):'));
      for (const session of activeSessions) {
        const status =
          session.status === 'idle'
            ? chalk.green('idle')
            : session.status === 'busy'
              ? chalk.yellow('busy')
              : chalk.red(session.status);
        const name = session.name ? ` (${session.name})` : '';
        const mode = session.mode === 'shell' ? chalk.gray(' [shell]') : '';
        const cost = session.totalCost ? chalk.gray(` $${session.totalCost.toFixed(4)}`) : '';
        console.log(`  ${chalk.cyan(session.id.slice(0, 8))} ${status}${name}${mode}${cost} ${session.workingDir}`);
      }
    }
    console.log('');
  });

sessionCmd
  .command('logs <id>')
  .description('View session output')
  .option('-e, --errors', 'Show stderr instead of stdout')
  .action((id, options) => {
    const manager = getSessionManager();
    const output = options.errors ? manager.getSessionError(id) : manager.getSessionOutput(id);

    if (output === null) {
      console.log(chalk.yellow(`Session ${id} not found or not active`));
      return;
    }

    if (output === '') {
      console.log(chalk.gray('(no output)'));
      return;
    }

    console.log(output);
  });

program
  .command('attach <path>')
  .description('Show an attachment card for a local file')
  .option('-s, --session <id>', 'Codeman session ID (defaults to CODEMAN_SESSION_ID)')
  .option('--url <url>', 'Codeman API URL (defaults to CODEMAN_API_URL or https://127.0.0.1:3000)')
  .action(async (filePath, options) => {
    const extension = String(filePath).split('.').pop()?.toLowerCase() || '';
    if (!isAbsolute(filePath) || !isSupportedAttachmentExtension(extension)) {
      console.error(chalk.red('✗ attach requires an absolute path to a png, pdf, docx, pptx, md, or txt file'));
      process.exit(1);
    }

    const sessionId = options.session || process.env.CODEMAN_SESSION_ID;
    const apiUrl = options.url || process.env.CODEMAN_API_URL || 'https://127.0.0.1:3000';
    if (sessionId && (await postAttachment(apiUrl, sessionId, filePath))) {
      console.log(chalk.green('✓ Attachment card requested'));
      return;
    }

    console.log(makeAttachmentMagicLink(filePath));
  });

program
  .command('checkpoint')
  .alias('compact')
  .description('Signal Codeman to checkpoint (compact-or-clear, then continue) at a clean boundary')
  .option('-m, --mode <mode>', 'Checkpoint mode: compact or clear', 'compact')
  .option('-c, --continue <prompt>', 'Prompt to send after the op completes (default: continue)')
  .option('-s, --session <id>', 'Codeman session ID (defaults to CODEMAN_SESSION_ID)')
  .option('--url <url>', 'Codeman API URL (defaults to CODEMAN_API_URL or https://127.0.0.1:3000)')
  .action(async (options) => {
    const mode = options.mode === 'clear' ? 'clear' : 'compact';
    const sessionId = options.session || process.env.CODEMAN_SESSION_ID;
    const apiUrl = options.url || process.env.CODEMAN_API_URL || 'https://127.0.0.1:3000';

    if (!sessionId) {
      console.error(chalk.red('✗ checkpoint requires a session id (--session or CODEMAN_SESSION_ID)'));
      process.exit(1);
    }

    const data: Record<string, unknown> = { mode };
    if (options.continue) data.continuePrompt = String(options.continue);

    const body = await postHookEvent(apiUrl, 'checkpoint', sessionId, data);
    const triggered = Boolean(
      body &&
      typeof body === 'object' &&
      (body as { data?: { checkpoint?: { triggered?: boolean } } }).data?.checkpoint?.triggered
    );

    if (triggered) {
      console.log(chalk.green(`✓ checkpoint ${mode} requested`));
      return;
    }

    console.error(chalk.red('✗ checkpoint not enabled for this session — enable it in Session Options'));
    process.exit(1);
  });

/**
 * Unwrap the `{ success, data }` API envelope. Returns `body.data` when the
 * body looks like an envelope (has a `data` field), otherwise the body as-is.
 * Pure + defensive: `data` may be an object or a list. Exported for tests.
 */
export function unwrapEnvelope(body: unknown): unknown {
  if (body && typeof body === 'object' && 'data' in (body as Record<string, unknown>)) {
    return (body as { data: unknown }).data;
  }
  return body;
}

/**
 * GET an arbitrary JSON path from a running instance, mirroring the attach
 * command's transport (rejectUnauthorized: false, optional Basic auth from
 * the local .codeman/.env so localhost works without explicit creds).
 * Resolves the unwrapped `{ success, data }` envelope (or the parsed body when
 * there is no envelope), or rejects on connection / non-2xx / invalid-JSON.
 */
async function fetchServerJson(apiUrl: string, path: string): Promise<unknown> {
  const envFile = readCodemanEnv();
  const username = process.env.CODEMAN_USERNAME || envFile.CODEMAN_USERNAME || 'admin';
  const password = process.env.CODEMAN_PASSWORD || envFile.CODEMAN_PASSWORD;
  const url = new URL(path, apiUrl);
  const transport = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (password) {
      headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    }

    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        method: 'GET',
        path: `${url.pathname}${url.search}`,
        rejectUnauthorized: false,
        headers,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode ?? '???'}${body ? `: ${body.slice(0, 200)}` : ''}`));
            return;
          }
          try {
            resolve(unwrapEnvelope(JSON.parse(body)));
          } catch (err) {
            reject(new Error(`Invalid JSON response: ${getErrorMessage(err)}`));
          }
        });
      }
    );
    req.on('error', (err) => reject(err));
    req.end();
  });
}

/**
 * GET /api/mux-sessions from a running instance and resolve the `sessions`
 * array. Thin wrapper over {@link fetchServerJson}; the unwrapped `data` is
 * `{ sessions, muxAvailable }` (or, defensively, a bare array).
 */
async function fetchMuxSessions(apiUrl: string): Promise<MuxRow[]> {
  const data = await fetchServerJson(apiUrl, '/api/mux-sessions');
  const sessions = Array.isArray(data) ? data : ((data as { sessions?: MuxRow[] })?.sessions ?? []);
  return Array.isArray(sessions) ? (sessions as MuxRow[]) : [];
}

/**
 * Resolve the Codeman API base URL with instance scoping: explicit `--url`
 * wins, then `CODEMAN_API_URL`, then `https://127.0.0.1:<CODEMAN_PORT|3000>`.
 */
function resolveApiUrl(optionUrl?: string): string {
  return optionUrl || process.env.CODEMAN_API_URL || `https://127.0.0.1:${process.env.CODEMAN_PORT || '3000'}`;
}

/** Minimal session shape rendered by `status`/`ls` (live or stored). */
interface SessionRow {
  id?: string;
  status?: string;
  workingDir?: string;
}

/** Aggregated, render-ready summary of a `/api/status` payload. */
export interface StatusSummary {
  active: number;
  idle: number;
  busy: number;
  tasks: { total: number; running: number; completed: number; failed: number };
  ralphActive: boolean;
}

/** Coerce a `/api/status` payload (or a bare sessions array) into a session list. */
function extractSessions(payload: unknown): SessionRow[] {
  if (Array.isArray(payload)) return payload as SessionRow[];
  const sessions = (payload as { sessions?: unknown })?.sessions;
  return Array.isArray(sessions) ? (sessions as SessionRow[]) : [];
}

/**
 * Summarize a live `/api/status` payload into session/task counts and ralph
 * state. Pure + defensive: counts are derived from `sessions[]` (each session
 * carries `status`, `taskStats`, `ralphLoop`); accepts either the full status
 * object or a bare sessions array. Exported for tests.
 */
export function summarizeStatus(payload: unknown): StatusSummary {
  const sessions = extractSessions(payload);
  const tasks = { total: 0, running: 0, completed: 0, failed: 0 };
  let idle = 0;
  let busy = 0;
  let ralphActive = false;

  for (const s of sessions) {
    if (s?.status === 'idle') idle++;
    else if (s?.status === 'busy') busy++;
    const ts = (s as { taskStats?: typeof tasks })?.taskStats;
    if (ts) {
      tasks.total += ts.total ?? 0;
      tasks.running += ts.running ?? 0;
      tasks.completed += ts.completed ?? 0;
      tasks.failed += ts.failed ?? 0;
    }
    const ralph = (s as { ralphLoop?: { active?: boolean } })?.ralphLoop;
    if (ralph?.active) ralphActive = true;
  }

  // "active" = sessions that aren't stopped (live sessions are all non-stopped).
  const active = sessions.filter((s) => s?.status !== 'stopped').length;
  return { active, idle, busy, tasks, ralphActive };
}

/**
 * Render a list of sessions as indented rows (`<shortId> <status> <workingDir>`),
 * or a `(none)` placeholder when empty. Pure; exported for tests.
 */
export function formatSessionRows(sessions: SessionRow[]): string {
  if (!sessions || sessions.length === 0) {
    return '  (none)';
  }
  return sessions
    .map((s) => {
      const id = (s.id || '').slice(0, 8);
      const status =
        s.status === 'idle'
          ? chalk.green('idle')
          : s.status === 'busy'
            ? chalk.yellow('busy')
            : chalk.red(s.status || 'unknown');
      return `  ${chalk.cyan(id)} ${status} ${s.workingDir || ''}`.trimEnd();
    })
    .join('\n');
}

/**
 * Choose which session list to render: the live list when present, else the
 * persisted (stored) sessions as an offline fallback. Returns the chosen rows
 * and an `offline` flag so the caller can label the output. Pure; exported for
 * tests. `stored` is the `getStoredSessions()` map keyed by session id.
 */
export function selectSessionSource(
  live: SessionRow[] | null | undefined,
  stored: Record<string, SessionRow>
): { sessions: SessionRow[]; offline: boolean } {
  if (live && live.length > 0) {
    return { sessions: live, offline: false };
  }
  const storedRows = Object.values(stored || {});
  return { sessions: storedRows, offline: true };
}

program
  .command('mux')
  .alias('mux-sessions')
  .description('List the tmux↔Codeman session mapping from the running instance')
  .option('--url <url>', 'Codeman API URL (defaults to CODEMAN_API_URL or https://127.0.0.1:3000)')
  .option('--json', 'Output the raw mux-sessions array as JSON')
  .action(async (options) => {
    const apiUrl = resolveApiUrl(options.url);
    let rows: MuxRow[];
    try {
      rows = await fetchMuxSessions(apiUrl);
    } catch (err) {
      console.error(chalk.red(`✗ Failed to reach Codeman at ${apiUrl}: ${getErrorMessage(err)}`));
      console.error(chalk.gray('  Is the Codeman web server running? Try --url to point at the right instance.'));
      process.exit(1);
    }

    if (options.json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }

    console.log(formatMuxTable(rows));
  });

// ============ Task Commands ============

const taskCmd = program.command('task').alias('t').description('Manage tasks');

taskCmd
  .command('add <prompt>')
  .description('Add a new task')
  .option('-d, --dir <path>', 'Working directory', process.cwd())
  .option('-p, --priority <n>', 'Priority (higher = first)', '0')
  .option('-c, --completion <phrase>', 'Completion phrase to detect')
  .option('--timeout <ms>', 'Timeout in milliseconds')
  .action((prompt, options) => {
    const queue = getTaskQueue();
    const task = queue.addTask({
      prompt,
      workingDir: options.dir,
      priority: parseInt(options.priority, 10),
      completionPhrase: options.completion,
      timeoutMs: options.timeout ? parseInt(options.timeout, 10) : undefined,
    });
    console.log(chalk.green(`✓ Task added: ${task.id}`));
    console.log(`  Prompt: ${prompt.slice(0, 50)}${prompt.length > 50 ? '...' : ''}`);
    console.log(`  Priority: ${task.priority}`);
  });

taskCmd
  .command('list')
  .alias('ls')
  .description('List all tasks')
  .option('-s, --status <status>', 'Filter by status (pending, running, completed, failed)')
  .action((options) => {
    const queue = getTaskQueue();
    let tasks = queue.getAllTasks();

    if (options.status) {
      tasks = tasks.filter((t) => t.status === options.status);
    }

    if (tasks.length === 0) {
      console.log(chalk.yellow('No tasks found'));
      return;
    }

    const statusColors = {
      pending: chalk.gray,
      running: chalk.yellow,
      completed: chalk.green,
      failed: chalk.red,
    };

    console.log(chalk.bold('\nTasks:'));
    for (const task of tasks) {
      const color = statusColors[task.status];
      const prompt = task.prompt.slice(0, 40) + (task.prompt.length > 40 ? '...' : '');
      console.log(`  ${chalk.cyan(task.id.slice(0, 8))} ${color(task.status.padEnd(10))} [${task.priority}] ${prompt}`);
    }

    const counts = queue.getCount();
    console.log(chalk.bold('\nSummary:'));
    console.log(
      `  Pending: ${counts.pending}, Running: ${counts.running}, Completed: ${counts.completed}, Failed: ${counts.failed}`
    );
    console.log('');
  });

taskCmd
  .command('status <id>')
  .description('Show task details')
  .action((id) => {
    const queue = getTaskQueue();
    const task = queue.getTask(id);

    if (!task) {
      console.log(chalk.red(`Task ${id} not found`));
      return;
    }

    console.log(chalk.bold('\nTask Details:'));
    console.log(`  ID: ${task.id}`);
    console.log(`  Status: ${task.status}`);
    console.log(`  Priority: ${task.priority}`);
    console.log(`  Prompt: ${task.prompt}`);
    console.log(`  Working Dir: ${task.workingDir}`);
    if (task.assignedSessionId) {
      console.log(`  Session: ${task.assignedSessionId}`);
    }
    if (task.error) {
      console.log(`  Error: ${chalk.red(task.error)}`);
    }
    if (task.output) {
      console.log(chalk.bold('\nOutput:'));
      console.log(task.output.slice(0, 500) + (task.output.length > 500 ? '...' : ''));
    }
    console.log('');
  });

taskCmd
  .command('remove <id>')
  .alias('rm')
  .description('Remove a task')
  .action((id) => {
    const queue = getTaskQueue();
    if (queue.removeTask(id)) {
      console.log(chalk.green(`✓ Task removed: ${id}`));
    } else {
      console.log(chalk.red(`Task ${id} not found`));
    }
  });

taskCmd
  .command('clear')
  .description('Clear completed/failed tasks')
  .option('-a, --all', 'Clear all tasks')
  .option('-f, --failed', 'Clear only failed tasks')
  .action((options) => {
    const queue = getTaskQueue();
    let count: number;

    if (options.all) {
      count = queue.clearAll();
      console.log(chalk.green(`✓ Cleared ${count} tasks`));
    } else if (options.failed) {
      count = queue.clearFailed();
      console.log(chalk.green(`✓ Cleared ${count} failed tasks`));
    } else {
      count = queue.clearCompleted();
      console.log(chalk.green(`✓ Cleared ${count} completed tasks`));
    }
  });

// ============ Ralph Loop Commands ============

const ralphCmd = program.command('ralph').alias('r').description('Control the Ralph autonomous loop');

ralphCmd
  .command('start')
  .description('Start the Ralph loop')
  .option('-m, --min-hours <hours>', 'Minimum duration in hours')
  .option('--no-auto-generate', 'Disable auto-generating follow-up tasks')
  .action(async (options) => {
    const loop = getRalphLoop({
      autoGenerateTasks: options.autoGenerate,
    });

    if (options.minHours) {
      loop.setMinDuration(parseFloat(options.minHours));
    }

    if (loop.isRunning()) {
      console.log(chalk.yellow('Ralph loop is already running'));
      return;
    }

    loop.on('taskAssigned', (taskId, sessionId) => {
      console.log(chalk.cyan(`→ Task ${taskId.slice(0, 8)} assigned to session ${sessionId.slice(0, 8)}`));
    });

    loop.on('taskCompleted', (taskId) => {
      console.log(chalk.green(`✓ Task ${taskId.slice(0, 8)} completed`));
    });

    loop.on('taskFailed', (taskId, error) => {
      console.log(chalk.red(`✗ Task ${taskId.slice(0, 8)} failed: ${error}`));
    });

    loop.on('stopped', () => {
      console.log(chalk.yellow('\nRalph loop stopped'));
      printStats(loop.getStats());
      process.exit(0);
    });

    await loop.start();
    console.log(chalk.green('✓ Ralph loop started'));
    if (options.minHours) {
      console.log(`  Minimum duration: ${options.minHours} hours`);
    }
    console.log(chalk.gray('  Press Ctrl+C to stop\n'));

    // Keep process running
    process.on('SIGINT', () => {
      console.log(chalk.yellow('\nStopping Ralph loop...'));
      loop.stop();
    });
  });

ralphCmd
  .command('stop')
  .description('Stop the Ralph loop')
  .action(() => {
    const loop = getRalphLoop();
    if (!loop.isRunning()) {
      console.log(chalk.yellow('Ralph loop is not running'));
      return;
    }
    loop.stop();
    console.log(chalk.green('✓ Ralph loop stopped'));
  });

ralphCmd
  .command('status')
  .description('Show Ralph loop status')
  .action(() => {
    const loop = getRalphLoop();
    const stats = loop.getStats();
    printStats(stats);
  });

function printStats(stats: ReturnType<ReturnType<typeof getRalphLoop>['getStats']>) {
  const statusColor = stats.status === 'running' ? chalk.green : stats.status === 'paused' ? chalk.yellow : chalk.gray;

  console.log(chalk.bold('\nRalph Loop Status:'));
  console.log(`  Status: ${statusColor(stats.status)}`);
  console.log(`  Elapsed: ${stats.elapsedHours.toFixed(2)} hours`);
  if (stats.minDurationMs) {
    const minHours = stats.minDurationMs / (1000 * 60 * 60);
    console.log(
      `  Min Duration: ${minHours.toFixed(2)} hours (${stats.minDurationReached ? 'reached' : 'not reached'})`
    );
  }

  console.log(chalk.bold('\nTasks:'));
  console.log(`  Pending: ${stats.pending}`);
  console.log(`  Running: ${stats.running}`);
  console.log(`  Completed: ${stats.completed} (${stats.tasksCompleted} this session)`);
  console.log(`  Failed: ${stats.failed}`);
  console.log(`  Generated: ${stats.tasksGenerated}`);

  console.log(chalk.bold('\nSessions:'));
  console.log(`  Active: ${stats.activeSessions}`);
  console.log(`  Idle: ${stats.idleSessions}`);
  console.log(`  Busy: ${stats.busySessions}`);
  console.log('');
}

// ============ Utility Commands ============

program
  .command('status')
  .description('Show overall status')
  .option('--url <url>', 'Codeman API URL (defaults to CODEMAN_API_URL or https://127.0.0.1:3000)')
  .action(async (options) => {
    const apiUrl = resolveApiUrl(options.url);

    // Try the running web server first — the long-lived server owns the live
    // sessions; an in-process singleton in this short-lived CLI never sees them.
    let summary: StatusSummary;
    let ralphLabel: string;
    let offline = false;
    try {
      const statusPayload = await fetchServerJson(apiUrl, '/api/status');
      summary = summarizeStatus(statusPayload);
      ralphLabel = summary.ralphActive ? chalk.green('active') : chalk.gray('idle');
    } catch {
      // Server unreachable — fall back to the persisted state on disk.
      offline = true;
      const queue = getTaskQueue();
      const loop = getRalphLoop();
      const stored = getSessionManager().getStoredSessions();
      const storedValues = Object.values(stored);
      const taskCounts = queue.getCount();
      const loopStatus = loop.status;
      summary = {
        active: storedValues.filter((s) => s.status !== 'stopped').length,
        idle: storedValues.filter((s) => s.status === 'idle').length,
        busy: storedValues.filter((s) => s.status === 'busy').length,
        tasks: {
          total: taskCounts.total,
          running: taskCounts.running,
          completed: taskCounts.completed,
          failed: taskCounts.failed,
        },
        ralphActive: loopStatus === 'running',
      };
      const statusColor = loopStatus === 'running' ? chalk.green : loopStatus === 'paused' ? chalk.yellow : chalk.gray;
      ralphLabel = statusColor(loopStatus);
    }

    console.log(chalk.bold('\nCodeman Status'));
    console.log('─'.repeat(40));
    if (offline) {
      console.log(
        chalk.dim(`(offline — showing last persisted state from state.json; server at ${apiUrl} unreachable)`)
      );
    }

    console.log(chalk.bold('\nSessions:'));
    console.log(`  Active: ${summary.active}`);
    console.log(`  Idle: ${summary.idle}`);
    console.log(`  Busy: ${summary.busy}`);

    console.log(chalk.bold('\nTasks:'));
    console.log(`  Total: ${summary.tasks.total}`);
    console.log(`  Running: ${summary.tasks.running}`);
    console.log(`  Completed: ${summary.tasks.completed}`);
    console.log(`  Failed: ${summary.tasks.failed}`);

    console.log(chalk.bold('\nRalph Loop:'));
    console.log(`  Status: ${ralphLabel}`);
    console.log('');
  });

program
  .command('reset')
  .description('Reset all state')
  .option('-f, --force', 'Skip confirmation')
  .action(async (options) => {
    if (!options.force) {
      console.log(chalk.yellow('This will stop all sessions and clear all state.'));
      console.log(chalk.yellow('Use --force to confirm.'));
      return;
    }

    const manager = getSessionManager();
    const store = getStore();

    await manager.stopAllSessions();
    store.reset();

    console.log(chalk.green('✓ All state reset'));
  });

// Shorthand commands at root level
program
  .command('start')
  .description('Start a new session (shorthand)')
  .option('-d, --dir <path>', 'Working directory', process.cwd())
  .action(async (options) => {
    const manager = getSessionManager();
    const session = await manager.createSession(options.dir);
    console.log(chalk.green(`✓ Session started: ${session.id}`));
  });

program
  .command('list')
  .alias('ls')
  .description('List all sessions (shorthand)')
  .option('--url <url>', 'Codeman API URL (defaults to CODEMAN_API_URL or https://127.0.0.1:3000)')
  .action(async (options) => {
    const apiUrl = resolveApiUrl(options.url);

    // Query the running server first; only fall back to persisted state on disk
    // when it's unreachable (the CLI process has no view of live sessions).
    let live: SessionRow[] | null = null;
    let offline = false;
    try {
      live = extractSessions(await fetchServerJson(apiUrl, '/api/sessions'));
    } catch {
      offline = true;
    }

    const stored = offline ? getSessionManager().getStoredSessions() : {};
    const { sessions, offline: usedStored } = selectSessionSource(live, stored);

    if (sessions.length === 0) {
      console.log(chalk.yellow('No sessions found'));
      return;
    }

    console.log(chalk.bold(`\n${usedStored ? 'Sessions' : 'Active Sessions'}:`));
    if (usedStored) {
      console.log(
        chalk.dim(`(offline — showing last persisted state from state.json; server at ${apiUrl} unreachable)`)
      );
    }
    console.log(formatSessionRows(sessions));
    console.log('');
  });

// Web interface command
program
  .command('web')
  .description('Start the web interface')
  .option('-H, --host <host>', 'Host to bind to', process.env.CODEMAN_HOST || '127.0.0.1')
  .option('-p, --port <port>', 'Port to listen on (env: CODEMAN_PORT)', process.env.CODEMAN_PORT || '3000')
  .option('--https', 'Enable HTTPS with self-signed certificate (only needed for remote access, not localhost)')
  .option('--title-hostname <hostname>', 'Override the hostname shown in the browser title')
  .option(
    '--allow-unauthenticated-network',
    'Allow non-loopback web access without CODEMAN_PASSWORD (dangerous; terminal control is exposed)'
  )
  .action(async (options) => {
    const { startWebServer } = await import('./web/server.js');
    const host = options.host;
    const port = parseInt(options.port, 10);
    const https = !!options.https;
    const titleHostname = options.titleHostname;
    const allowUnauthenticatedNetwork = !!options.allowUnauthenticatedNetwork;
    const protocol = https ? 'https' : 'http';
    const displayHost = host === '0.0.0.0' ? 'localhost' : host;

    console.log(chalk.cyan(`Starting Codeman web interface on ${displayHost}:${port}${https ? ' (HTTPS)' : ''}...`));

    try {
      const server = await startWebServer(port, https, false, host, titleHostname, allowUnauthenticatedNetwork);
      console.log(chalk.green(`\n✓ Web interface running at ${protocol}://${displayHost}:${port}`));
      if (https) {
        console.log(chalk.yellow('  Note: Accept the self-signed certificate in your browser on first visit'));
      }
      console.log(chalk.gray('  Press Ctrl+C to stop\n'));

      // Graceful shutdown handler — flush state and clean up on SIGTERM/SIGINT
      let shuttingDown = false;
      const shutdown = async (signal: string) => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(chalk.yellow(`\n${signal} received, shutting down gracefully...`));
        try {
          await server.stop();
        } catch (err) {
          console.error(chalk.red(`Error during shutdown: ${getErrorMessage(err)}`));
        }
        process.exit(0);
      };
      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGHUP', () => shutdown('SIGHUP'));
    } catch (err) {
      console.error(chalk.red(`✗ Failed to start web server: ${getErrorMessage(err)}`));
      process.exit(1);
    }
  });

program
  .command('doctor')
  .alias('check-deps')
  .description('Check Codeman tool dependencies (Node, Claude CLI, tmux, LibreOffice, MS Office)')
  .option('--json', 'Output structured JSON instead of a table')
  .option('--category <name>', 'Only check one category (core|office|documents|media|other)')
  .action(async (options) => {
    const { createRealHost, checkAll } = await import('./utils/dependency-checker.js');
    const { renderTable, renderJson, computeExitCode } = await import('./utils/dependency-report.js');
    const { DEPENDENCY_REGISTRY } = await import('./config/dependency-registry.js');

    const host = createRealHost();
    const registry = options.category
      ? DEPENDENCY_REGISTRY.filter((t) => t.category === options.category)
      : DEPENDENCY_REGISTRY;
    const results = checkAll(registry, host);

    if (options.json) {
      console.log(JSON.stringify(renderJson(results, host.environment), null, 2));
    } else {
      console.log(renderTable(results, host.environment));
    }
    process.exit(computeExitCode(results));
  });

export { program };
