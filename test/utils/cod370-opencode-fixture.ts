import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

const PREFIX = 'cod370-opencode-';
const POLL_MS = 20;
const HARNESS_ROOT = resolve(import.meta.dirname, '../..');

export interface Cod370OpenCodeFixtureOptions {
  runtimeRoot?: string;
}

export interface PaneIdentity {
  muxName: string;
  tmuxSessionId: string;
  windowId: string;
  paneId: string;
  panePid: number;
  opencodePid: number;
  command: string;
  cols: number;
  rows: number;
}

export interface LiveProcessIdentity {
  pid: number;
  startTimeTicks: string;
  executable: string;
  command: string;
  parentChain: Array<{ pid: number; startTimeTicks: string }>;
  panePid: number;
}

export interface LiveScenarioIdentity {
  muxName: string;
  tmuxSessionId: string;
  windowId: string;
  paneId: string;
  panePid: number;
  paneStartTimeTicks: string;
  opencode: LiveProcessIdentity;
}

export interface CleanupProof {
  desktopContextClosed: boolean;
  phoneContextClosed: boolean;
  browserClosed: boolean;
  sessionDeleted: boolean;
  sessionGet404: boolean;
  opencodePidDead: boolean;
  panePidDead: boolean;
  tmuxTargetAbsent: boolean;
  launcherDead: boolean;
  listenerDead: boolean;
  listenerWasDescendant: boolean;
  socketAbsent: boolean;
  portRebound: boolean;
  chromiumAbsent: boolean;
  taggedProcessesAbsent: boolean;
  rootAbsent: boolean;
}

export interface ProcessIdentity {
  pid: number;
  commandLine: string;
}

export function sameLiveProcessIdentity(left: LiveProcessIdentity, right: LiveProcessIdentity): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function hasMandatoryCleanupProof(proof: CleanupProof): boolean {
  return Object.values(proof).every((value) => value === true);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function commandLine(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`).toString().replaceAll('\0', ' ').trim();
  } catch {
    return '';
  }
}

function procIdentity(pid: number): {
  pid: number;
  ppid: number;
  startTimeTicks: string;
  executable: string;
  command: string;
} {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').trim();
  const afterCommand = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
  const ppid = Number(afterCommand[1]);
  const startTimeTicks = afterCommand[19];
  const executable = readlinkSync(`/proc/${pid}/exe`);
  const command = commandLine(pid).replace(/\s+/g, ' ').trim();
  if (!Number.isInteger(ppid) || !startTimeTicks || !executable || !command) {
    throw new Error(`incomplete /proc identity for pid ${pid}`);
  }
  return { pid, ppid, startTimeTicks, executable, command };
}

async function waitUntil<T>(label: string, probe: () => T | false | Promise<T | false>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== false) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, POLL_MS));
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`Timed out waiting for ${label}${detail}`);
}

async function allocatePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const listener = createServer();
    listener.once('error', rejectPort);
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      listener.close((error) => (error ? rejectPort(error) : resolvePort(port)));
    });
  });
}

function listProcesses(): Array<{ pid: number; ppid: number; command: string }> {
  const output = execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' });
  return output
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((match): match is RegExpMatchArray => !!match)
    .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }));
}

function chromiumDescendants(rootPid: number): number[] {
  const processes = listProcesses();
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  return processes
    .filter((entry) => /(?:chrome|chromium)/i.test(entry.command))
    .filter((entry) => {
      let current = entry;
      const seen = new Set<number>();
      while (current.ppid > 1 && !seen.has(current.pid)) {
        if (current.ppid === rootPid) return true;
        seen.add(current.pid);
        const parent = byPid.get(current.ppid);
        if (!parent) return false;
        current = parent;
      }
      return false;
    })
    .map((entry) => entry.pid);
}

function isDescendant(pid: number, ancestorPid: number): boolean {
  const byPid = new Map(listProcesses().map((entry) => [entry.pid, entry]));
  let current = byPid.get(pid);
  const seen = new Set<number>();
  while (current && current.ppid > 1 && !seen.has(current.pid)) {
    if (current.ppid === ancestorPid) return true;
    seen.add(current.pid);
    current = byPid.get(current.ppid);
  }
  return false;
}

function descendantsOf(ancestorPid: number): number[] {
  const processes = listProcesses();
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  return processes
    .filter((entry) => {
      let current = entry;
      const seen = new Set<number>();
      while (current.ppid > 1 && !seen.has(current.pid)) {
        if (current.ppid === ancestorPid) return true;
        seen.add(current.pid);
        const parent = byPid.get(current.ppid);
        if (!parent) return false;
        current = parent;
      }
      return false;
    })
    .map((entry) => entry.pid);
}

function liveOpenCodeIdentity(panePid: number): LiveProcessIdentity {
  const descendants = [panePid, ...descendantsOf(panePid)]
    .map((pid) => {
      try {
        return procIdentity(pid);
      } catch {
        return null;
      }
    })
    .filter((entry): entry is NonNullable<typeof entry> => !!entry);
  const candidates = descendants.filter((entry) => {
    const executableName = basename(entry.executable).toLowerCase();
    const arguments_ = entry.command.split(' ').map((argument) => argument.toLowerCase());
    return executableName === 'opencode' || arguments_.some((argument) => /(?:^|\/)opencode$/.test(argument));
  });
  if (candidates.length !== 1) {
    throw new Error(
      `expected one live OpenCode descendant of pane ${panePid}, found ${candidates.length}: ${
        candidates.map((entry) => `${entry.pid}:${entry.executable}:${entry.command}`).join('; ') || 'none'
      }; all descendants: ${
        descendants.map((entry) => `${entry.pid}:${entry.executable}:${entry.command}`).join('; ') || 'none'
      }`
    );
  }
  const processIdentity = candidates[0];
  const parentChain: LiveProcessIdentity['parentChain'] =
    processIdentity.pid === panePid
      ? [{ pid: processIdentity.pid, startTimeTicks: processIdentity.startTimeTicks }]
      : [];
  let parentPid = processIdentity.ppid;
  const seen = new Set<number>();
  while (processIdentity.pid !== panePid && parentPid > 1 && !seen.has(parentPid)) {
    seen.add(parentPid);
    const parent = procIdentity(parentPid);
    parentChain.push({ pid: parent.pid, startTimeTicks: parent.startTimeTicks });
    if (parent.pid === panePid) break;
    parentPid = parent.ppid;
  }
  if (parentChain.at(-1)?.pid !== panePid) {
    throw new Error(`OpenCode pid ${processIdentity.pid} is no longer parented by pane ${panePid}`);
  }
  return {
    pid: processIdentity.pid,
    startTimeTicks: processIdentity.startTimeTicks,
    executable: processIdentity.executable,
    command: processIdentity.command,
    parentChain,
    panePid,
  };
}

export class Cod370OpenCodeFixture {
  readonly runtimeRoot: string;
  root = '';
  dataDir = '';
  homeDir = '';
  workingDir = '';
  socketName = '';
  port = 0;
  baseUrl = '';
  instance = '';
  server: ChildProcess | null = null;
  serverIdentity: ProcessIdentity | null = null;
  listenerIdentity: ProcessIdentity | null = null;
  listenerPid = 0;
  serverLog = '';
  browser: Browser | null = null;
  desktopContext: BrowserContext | null = null;
  phoneContext: BrowserContext | null = null;
  desktopPage: Page | null = null;
  phonePage: Page | null = null;
  chromiumPids: number[] = [];
  sessionId = '';
  pane: PaneIdentity | null = null;
  initialOpenCodeIdentity: LiveProcessIdentity | null = null;
  cleanupProof: CleanupProof = {
    desktopContextClosed: false,
    phoneContextClosed: false,
    browserClosed: false,
    sessionDeleted: false,
    sessionGet404: false,
    opencodePidDead: false,
    panePidDead: false,
    tmuxTargetAbsent: false,
    launcherDead: false,
    listenerDead: false,
    listenerWasDescendant: false,
    socketAbsent: false,
    portRebound: false,
    chromiumAbsent: false,
    taggedProcessesAbsent: false,
    rootAbsent: false,
  };

  constructor(options: Cod370OpenCodeFixtureOptions = {}) {
    this.runtimeRoot = resolve(options.runtimeRoot ?? HARNESS_ROOT);
  }

  private tmux(args: string[], ignoreError = false): string {
    try {
      return execFileSync('tmux', ['-L', this.socketName, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch (error) {
      if (ignoreError) return '';
      throw error;
    }
  }

  private serverPidStillOwned(pid: number): boolean {
    const current = commandLine(pid);
    return (
      current.includes(resolve(HARNESS_ROOT, 'node_modules/tsx/dist/cli.mjs')) &&
      current.includes('src/index.ts web') &&
      current.includes(String(this.port))
    );
  }

  private assertNoPriorArtifacts(): void {
    const roots = readdirSync(tmpdir()).filter((entry) => entry.startsWith(PREFIX));
    const tmuxDir = join(tmpdir(), `tmux-${process.getuid?.() ?? 0}`);
    const sockets = existsSync(tmuxDir) ? readdirSync(tmuxDir).filter((entry) => entry.startsWith(PREFIX)) : [];
    const processes = listProcesses().filter(
      (entry) =>
        entry.pid !== process.pid && (entry.command.includes(PREFIX) || entry.command.includes('cod370-opencode'))
    );
    if (roots.length || sockets.length || processes.length) {
      throw new Error(
        `COD-370 fixture refused tainted state: roots=${roots.join(',') || 'none'} sockets=${
          sockets.join(',') || 'none'
        } processes=${processes.map((entry) => entry.pid).join(',') || 'none'}`
      );
    }
  }

  async start(): Promise<void> {
    this.assertNoPriorArtifacts();
    this.root = realpathSync(mkdtempSync(join(tmpdir(), PREFIX)));
    if (dirname(this.root) !== realpathSync(tmpdir()) || !basename(this.root).startsWith(PREFIX)) {
      throw new Error(`Unsafe COD-370 scenario root: ${this.root}`);
    }
    this.dataDir = join(this.root, 'data');
    this.homeDir = join(this.root, 'home');
    this.workingDir = join(this.root, 'workspace');
    for (const directory of [this.dataDir, this.homeDir, this.workingDir]) mkdirSync(directory, { recursive: true });
    this.socketName = `${PREFIX}${process.pid}-${Date.now().toString(36)}`;
    this.instance = `${PREFIX}${process.pid}`;
    this.port = await allocatePort();
    if (this.port === 3002) throw new Error('Dynamic allocator returned forbidden production port 3002');
    this.baseUrl = `http://127.0.0.1:${this.port}`;

    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of ['VITEST', 'VITEST_MODE', 'VITEST_POOL_ID', 'VITEST_WORKER_ID', 'NODE_ENV']) delete env[key];
    Object.assign(env, {
      HOME: this.homeDir,
      XDG_CONFIG_HOME: join(this.homeDir, '.config'),
      XDG_CACHE_HOME: join(this.homeDir, '.cache'),
      XDG_DATA_HOME: join(this.homeDir, '.local', 'share'),
      CODEMAN_DATA_DIR: this.dataDir,
      CODEMAN_INSTANCE: this.instance,
      CODEMAN_TMUX_SOCKET: this.socketName,
      PATH: `${dirname(execFileSync('sh', ['-lc', 'command -v opencode'], { encoding: 'utf8' }).trim())}:${
        process.env.PATH ?? ''
      }`,
    });

    const child = spawn(
      process.execPath,
      [
        resolve(HARNESS_ROOT, 'node_modules/tsx/dist/cli.mjs'),
        'src/index.ts',
        'web',
        '--host',
        '127.0.0.1',
        '--port',
        String(this.port),
      ],
      { cwd: this.runtimeRoot, env, stdio: ['ignore', 'pipe', 'pipe'], detached: false }
    );
    this.server = child;
    if (!child.pid) throw new Error('Codeman child has no PID');
    this.serverIdentity = { pid: child.pid, commandLine: commandLine(child.pid) };
    const listenMarker = `Codeman web interface running at http://127.0.0.1:${this.port}`;
    let markerSeen = false;
    const append = (chunk: Buffer) => {
      this.serverLog = `${this.serverLog}${chunk.toString()}`.slice(-30_000);
      markerSeen ||= this.serverLog.includes(listenMarker);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    try {
      await waitUntil(
        `owned Codeman server on ${this.port}`,
        async () => {
          if (child.exitCode !== null || child.signalCode !== null) {
            throw new Error(`server exited early\n${this.serverLog}`);
          }
          if (!markerSeen) return false;
          const response = await fetch(`${this.baseUrl}/api/status`).catch(() => null);
          if (!response?.ok) return false;
          const ss = execFileSync('ss', ['-ltnp', 'sport', '=', `:${this.port}`], { encoding: 'utf8' });
          const match = ss.match(/pid=(\d+)/);
          if (!match) return false;
          this.listenerPid = Number(match[1]);
          if (this.listenerPid !== child.pid && !isDescendant(this.listenerPid, child.pid!)) return false;
          this.cleanupProof.listenerWasDescendant =
            this.listenerPid === child.pid || isDescendant(this.listenerPid, child.pid!);
          this.listenerIdentity = { pid: this.listenerPid, commandLine: commandLine(this.listenerPid) };
          return true;
        },
        60_000
      );
    } catch (error) {
      const ss = execFileSync('ss', ['-ltnp', 'sport', '=', `:${this.port}`], { encoding: 'utf8' });
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nlistener=${ss}\n${this.serverLog}`);
    }
    this.serverIdentity = { pid: child.pid, commandLine: commandLine(child.pid) };
    if (!this.serverIdentity.commandLine.includes(String(this.port)))
      throw new Error('Server identity lacks owned port');

    this.browser = await chromium.launch({ headless: true });
    this.desktopContext = await this.browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    this.phoneContext = await this.browser.newContext({
      viewport: { width: 390, height: 844 },
      screen: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      hasTouch: true,
      isMobile: true,
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1',
    });
    this.desktopPage = await this.desktopContext.newPage();
    this.phonePage = await this.phoneContext.newPage();
    this.chromiumPids = chromiumDescendants(process.pid);
  }

  async navigatePages(): Promise<void> {
    for (const page of [this.desktopPage, this.phonePage]) {
      if (!page) throw new Error('Browser page was not created');
      await page.goto(this.baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.waitForFunction(() => document.body.classList.contains('app-loaded'), undefined, { timeout: 20_000 });
    }
  }

  async api(method: string, path: string, body?: unknown): Promise<any> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let payload: any = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }
    if (!response.ok) throw new Error(`${method} ${path} failed: ${response.status} ${text}`);
    return payload?.data ?? payload;
  }

  async createOpenCodeSession(): Promise<PaneIdentity> {
    const created = await this.api('POST', '/api/sessions', {
      name: 'COD-370 active viewer',
      mode: 'opencode',
      workingDir: this.workingDir,
      cols: 140,
      rows: 44,
    });
    this.sessionId = created?.session?.id ?? created?.id ?? created?.sessionId;
    if (!this.sessionId) throw new Error(`Session response lacks id: ${JSON.stringify(created)}`);
    await this.api('POST', `/api/sessions/${this.sessionId}/interactive`);
    const muxName = `codeman-${this.sessionId.slice(0, 8)}`;
    this.pane = await waitUntil(
      `real OpenCode pane ${muxName}`,
      () => {
        const output = this.tmux(
          [
            'list-panes',
            '-t',
            muxName,
            '-F',
            '#{session_name}\t#{session_id}\t#{window_id}\t#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_width}\t#{pane_height}',
          ],
          true
        );
        if (!output) return false;
        const [actualMux, tmuxSessionId, windowId, paneId, pidText, command, colsText, rowsText] = output.split('\t');
        const panePid = Number(pidText);
        const identity = {
          muxName: actualMux,
          tmuxSessionId,
          windowId,
          paneId,
          panePid,
          opencodePid: 0,
          command,
          cols: Number(colsText),
          rows: Number(rowsText),
        };
        if (actualMux !== muxName || !Number.isInteger(panePid) || !processAlive(panePid)) {
          return false;
        }
        return identity;
      },
      30_000
    );
    const opencode = await waitUntil(
      'unambiguous live OpenCode process identity',
      () => liveOpenCodeIdentity(this.pane!.panePid),
      20_000
    );
    const detail = await this.api('GET', `/api/sessions/${this.sessionId}`);
    const attachPid = Number(detail?.pid);
    const attachCommand = commandLine(attachPid);
    if (
      !Number.isInteger(attachPid) ||
      !processAlive(attachPid) ||
      !this.server?.pid ||
      !isDescendant(attachPid, this.server.pid) ||
      !attachCommand.includes(`-L ${this.socketName}`) ||
      !attachCommand.includes(`attach-session -t ${muxName}`)
    ) {
      throw new Error(
        `API PTY pid ${detail?.pid} is not the live server-owned tmux attachment for ${muxName}: ${attachCommand}`
      );
    }
    this.initialOpenCodeIdentity = opencode;
    this.pane.opencodePid = opencode.pid;
    return this.pane;
  }

  paneIdentity(): PaneIdentity {
    if (!this.pane) throw new Error('OpenCode pane has not been created');
    const output = this.tmux([
      'list-panes',
      '-t',
      this.pane.muxName,
      '-F',
      '#{session_name}\t#{session_id}\t#{window_id}\t#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_width}\t#{pane_height}',
    ]);
    const [muxName, tmuxSessionId, windowId, paneId, pidText, command, colsText, rowsText] = output.split('\t');
    return {
      muxName,
      tmuxSessionId,
      windowId,
      paneId,
      panePid: Number(pidText),
      opencodePid: liveOpenCodeIdentity(Number(pidText)).pid,
      command,
      cols: Number(colsText),
      rows: Number(rowsText),
    };
  }

  identities(): LiveScenarioIdentity {
    const pane = this.paneIdentity();
    const paneProcess = procIdentity(pane.panePid);
    const opencode = liveOpenCodeIdentity(pane.panePid);
    if (!processAlive(opencode.pid)) throw new Error(`OpenCode pid ${opencode.pid} died during identity read`);
    if (this.initialOpenCodeIdentity && !sameLiveProcessIdentity(this.initialOpenCodeIdentity, opencode)) {
      throw new Error(
        `OpenCode process was replaced: initial=${JSON.stringify(this.initialOpenCodeIdentity)} live=${JSON.stringify(
          opencode
        )}`
      );
    }
    return {
      muxName: pane.muxName,
      tmuxSessionId: pane.tmuxSessionId,
      windowId: pane.windowId,
      paneId: pane.paneId,
      panePid: pane.panePid,
      paneStartTimeTicks: paneProcess.startTimeTicks,
      opencode,
    };
  }

  paneCount(): number {
    if (!this.pane) throw new Error('OpenCode pane has not been created');
    const output = this.tmux(['list-panes', '-t', this.pane.muxName, '-F', '#{pane_id}']);
    return output ? output.split('\n').filter(Boolean).length : 0;
  }

  paneText(): string {
    if (!this.pane) throw new Error('OpenCode pane has not been created');
    return this.tmux(['capture-pane', '-p', '-t', this.pane.paneId, '-S', '-200']);
  }

  async cleanup(): Promise<void> {
    const errors: Error[] = [];
    const attempt = async (label: string, operation: () => void | Promise<void>, mark?: () => void) => {
      try {
        await operation();
        mark?.();
      } catch (error) {
        errors.push(new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
      }
    };

    await attempt(
      'desktop browser context closed',
      async () => {
        if (!this.desktopContext) throw new Error('desktop browser context was never created');
        const pages = this.desktopContext.pages();
        await this.desktopContext.close();
        if (pages.some((page) => !page.isClosed())) throw new Error('desktop browser page remains open');
      },
      () => (this.cleanupProof.desktopContextClosed = true)
    );
    this.desktopContext = null;
    await attempt(
      'phone browser context closed',
      async () => {
        if (!this.phoneContext) throw new Error('phone browser context was never created');
        const pages = this.phoneContext.pages();
        await this.phoneContext.close();
        if (pages.some((page) => !page.isClosed())) throw new Error('phone browser page remains open');
      },
      () => (this.cleanupProof.phoneContextClosed = true)
    );
    this.phoneContext = null;
    await attempt(
      'browser closed',
      async () => this.browser?.close(),
      () => (this.cleanupProof.browserClosed = true)
    );
    this.browser = null;

    if (this.sessionId) {
      const id = this.sessionId;
      await attempt(
        `session ${id.slice(0, 8)} deleted`,
        async () => {
          if (!this.server || this.server.exitCode !== null || this.server.signalCode !== null) {
            throw new Error('owned server exited before mandatory session DELETE');
          }
          await this.api('DELETE', `/api/sessions/${id}`);
        },
        () => (this.cleanupProof.sessionDeleted = true)
      );
      await attempt(
        `session ${id.slice(0, 8)} GET 404`,
        async () => {
          if (!this.server || this.server.exitCode !== null || this.server.signalCode !== null) {
            throw new Error('owned server exited before mandatory session GET404');
          }
          await waitUntil(
            'session GET 404',
            async () => (await fetch(`${this.baseUrl}/api/sessions/${id}`)).status === 404,
            5_000
          );
        },
        () => (this.cleanupProof.sessionGet404 = true)
      );
    }

    if (this.pane) {
      const pane = this.pane;
      if (this.initialOpenCodeIdentity) {
        const opencodePid = this.initialOpenCodeIdentity.pid;
        await attempt(
          `OpenCode pid ${opencodePid} dead`,
          async () => waitUntil(`OpenCode pid ${opencodePid} to die`, () => !processAlive(opencodePid), 5_000),
          () => (this.cleanupProof.opencodePidDead = true)
        );
      } else {
        errors.push(new Error('OpenCode cleanup identity was never established'));
      }
      await attempt(
        `pane pid ${pane.panePid} dead`,
        async () => waitUntil(`pane pid ${pane.panePid} to die`, () => !processAlive(pane.panePid), 5_000),
        () => (this.cleanupProof.panePidDead = true)
      );
      await attempt(
        `tmux target ${pane.muxName} absent`,
        async () =>
          waitUntil(
            `tmux target ${pane.muxName} absent`,
            () => !this.tmux(['list-sessions', '-F', '#{session_name}'], true).split('\n').includes(pane.muxName),
            5_000
          ),
        () => (this.cleanupProof.tmuxTargetAbsent = true)
      );
    }

    if (this.server) {
      const child = this.server;
      const identity = this.serverIdentity;
      await attempt(
        `server pid ${child.pid ?? 'unknown'} stopped and reaped`,
        async () => {
          let listener = this.listenerIdentity;
          if (!listener && child.pid && processAlive(child.pid)) {
            const ss = execFileSync('ss', ['-ltnp', 'sport', '=', `:${this.port}`], { encoding: 'utf8' });
            const match = ss.match(/pid=(\d+)/);
            if (match) {
              const pid = Number(match[1]);
              if (pid !== child.pid && !isDescendant(pid, child.pid)) {
                throw new Error(`port ${this.port} listener ${pid} is not owned by launcher ${child.pid}`);
              }
              listener = { pid, commandLine: commandLine(pid) };
            }
          }
          if (child.pid && processAlive(child.pid)) {
            if (!identity || identity.pid !== child.pid || !this.serverPidStillOwned(child.pid)) {
              throw new Error('server PID identity changed before signal');
            }
            if (
              listener &&
              (!processAlive(listener.pid) ||
                commandLine(listener.pid) !== listener.commandLine ||
                (listener.pid !== child.pid && !isDescendant(listener.pid, child.pid)))
            ) {
              throw new Error('listener PID identity changed before signal');
            }
            child.kill('SIGTERM');
            try {
              await waitUntil(
                'server launcher/listener SIGTERM exit',
                () => !processAlive(child.pid!) && (!listener || !processAlive(listener.pid)),
                5_000
              );
            } catch {
              if (!this.serverPidStillOwned(child.pid)) throw new Error('server PID identity changed before SIGKILL');
              child.kill('SIGKILL');
              await waitUntil(
                'server launcher/listener SIGKILL exit',
                () => !processAlive(child.pid!) && (!listener || !processAlive(listener.pid)),
                5_000
              );
            }
          } else if (listener && processAlive(listener.pid)) {
            if (commandLine(listener.pid) !== listener.commandLine) {
              throw new Error('orphaned listener PID identity changed before signal');
            }
            process.kill(listener.pid, 'SIGTERM');
            await waitUntil('orphaned listener SIGTERM exit', () => !processAlive(listener!.pid), 5_000);
          }
          await new Promise<void>((resolveExit) => {
            if (child.exitCode !== null || child.signalCode !== null) resolveExit();
            else child.once('exit', () => resolveExit());
          });
          if (child.pid && processAlive(child.pid)) throw new Error(`launcher pid ${child.pid} remains alive`);
          if (listener && processAlive(listener.pid)) throw new Error(`listener pid ${listener.pid} remains alive`);
        },
        () => {
          this.cleanupProof.launcherDead = true;
          this.cleanupProof.listenerDead = true;
        }
      );
      this.server = null;
    }

    if (this.socketName) {
      await attempt(
        `tmux socket ${this.socketName} stopped`,
        async () => {
          this.tmux(['kill-server'], true);
          if (this.tmux(['list-sessions'], true)) throw new Error('sessions remain on disposable tmux socket');
          const socketPath = join(tmpdir(), `tmux-${process.getuid?.() ?? 0}`, this.socketName);
          rmSync(socketPath, { force: true });
          if (existsSync(socketPath)) throw new Error(`${socketPath} remains`);
        },
        () => (this.cleanupProof.socketAbsent = true)
      );
    }

    if (this.port) {
      await attempt(
        `port ${this.port} rebound`,
        async () => {
          await waitUntil(
            `port ${this.port} rebind`,
            () =>
              new Promise<true | false>((resolveProbe) => {
                const listener = createServer();
                listener.once('error', () => resolveProbe(false));
                listener.listen(this.port, '127.0.0.1', () =>
                  listener.close((error) => resolveProbe(error ? false : true))
                );
              }),
            5_000
          );
        },
        () => (this.cleanupProof.portRebound = true)
      );
    }

    await attempt(
      'fixture-owned Chromium children dead',
      async () =>
        waitUntil(
          'fixture Chromium children to die',
          () => this.chromiumPids.every((pid) => !processAlive(pid)),
          5_000
        ),
      () => (this.cleanupProof.chromiumAbsent = true)
    );
    await attempt(
      'scenario-tagged processes absent',
      () => {
        const survivors = listProcesses().filter(
          (entry) =>
            entry.pid !== process.pid &&
            [this.root, this.socketName, this.instance].some((tag) => tag && entry.command.includes(tag))
        );
        if (survivors.length)
          throw new Error(`survivors: ${survivors.map((entry) => `${entry.pid}:${entry.command}`).join('; ')}`);
      },
      () => (this.cleanupProof.taggedProcessesAbsent = true)
    );
    if (this.root) {
      await attempt(
        `scenario root ${this.root} removed`,
        () => {
          if (dirname(this.root) !== realpathSync(tmpdir()) || !basename(this.root).startsWith(PREFIX)) {
            throw new Error(`refusing unsafe removal: ${this.root}`);
          }
          rmSync(this.root, { recursive: true, force: true });
          if (existsSync(this.root)) throw new Error('scenario root remains');
        },
        () => (this.cleanupProof.rootAbsent = true)
      );
    }

    if (errors.length) throw new AggregateError(errors, `COD-370 fixture cleanup failed\n${this.serverLog}`);
  }
}
