/**
 * @fileoverview Explicit local tmux operators. Never exposed over the HTTP API.
 * Captures prove the observed pane/composer only: independent tmux writers are not
 * serialized and cannot provide the managed API's input-revision guarantee.
 */
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { isUtf8 } from 'node:buffer';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { boundedUtf8Tail, INSPECT_MAX_BYTES } from './agent-inspection.js';
import {
  guardedMessageRefusal,
  normalizeGuardedMessageFile,
  promptSha256,
  readGuardedComposerSnapshot,
  STAGE_MAX_BYTES,
} from './agent-staging.js';
import { stripAnsi } from './utils/regex-patterns.js';
import { getCli } from './config/cli-registry/registry.js';

export type LocalTmuxRunner = (args: string[], input?: string) => Promise<string>;
export interface LocalTarget {
  socket: string;
  target: string;
}
export interface LocalStageOptions extends LocalTarget {
  mode: string;
  messageFile: string;
  multiline?: boolean;
}
interface Pane {
  serverPid: string;
  id: string;
  pid: string;
  tty: string;
  dead: boolean;
  cols: number;
  rows: number;
  cursorX: number;
  cursorY: number;
  alternate: boolean;
  bracketedPaste: boolean;
}
interface Frame {
  pane: Pane;
  screen: string;
  snapshot: string;
}
interface LocalReceipt {
  version: 1;
  stageId: string;
  uid: number;
  socket: string;
  requestedTarget: string;
  paneIdentity: string;
  target: string;
  mode: 'codex' | 'claude';
  multiline: boolean;
  expiresAt: number;
  sha256: string;
  frameSha: string;
}
export interface LocalTerminalOptions {
  run?: LocalTmuxRunner;
  receiptDir?: string;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  paintTimeoutMs?: number;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const META =
  '#{pid}\t#{pane_id}\t#{pane_pid}\t#{pane_tty}\t#{pane_dead}\t#{pane_width}\t#{pane_height}\t#{cursor_x}\t#{cursor_y}\t#{alternate_on}\t#{bracket_paste_flag}';
const uid = () => process.getuid?.() ?? 0;
const identity = (pane: Pane) => JSON.stringify([pane.serverPid, pane.id, pane.pid, pane.tty]);
const defaultRunner: LocalTmuxRunner = async (args, input) =>
  execFileSync('tmux', args, {
    input,
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 1048576,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

/** Local input is explicit; no environment-derived URL or target resolution. */
function validateTarget(options: LocalTarget): void {
  for (const [key, value] of Object.entries(options)) {
    if (key !== 'socket' && key !== 'target') continue;
    // eslint-disable-next-line no-control-regex
    if (typeof value !== 'string' || !value || value.length > 1024 || /[\x00-\x1f\x7f-\x9f]/.test(value))
      throw new Error(`An explicit printable tmux ${key} is required`);
  }
  if (!options.socket || !options.target) throw new Error('An explicit tmux socket and target are required');
}
function parsePane(raw: string): Pane {
  const values = raw.replace(/\r?\n$/, '').split('\t');
  if (values.length !== 11 || !/^%\d+$/.test(values[1])) throw new Error('Unrecognized tmux pane metadata');
  for (const index of [0, 2, 4, 5, 6, 7, 8, 9])
    if (!/^\d+$/.test(values[index])) throw new Error('Unrecognized tmux pane metadata');
  const [cols, rows, cursorX, cursorY] = values.slice(5, 9).map(Number);
  if (cols < 1 || rows < 1 || cols > 1000 || rows > 500 || cursorX >= cols || cursorY >= rows)
    throw new Error('Unsupported pane geometry');
  return {
    serverPid: values[0],
    id: values[1],
    pid: values[2],
    tty: values[3],
    dead: values[4] !== '0',
    cols,
    rows,
    cursorX,
    cursorY,
    alternate: values[9] === '1',
    bracketedPaste: values[10] === '1',
  };
}

/** Reject symlink components before creating or using the private receipt store. */
async function noSymlinkComponents(path: string): Promise<void> {
  let cursor = resolve(path);
  while (true) {
    const info = await lstat(cursor).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (info?.isSymbolicLink()) throw new Error('Symlink receipt directories are refused');
    const parent = dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}
async function readRegular(path: string, limit: number, privateFile = false): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => {
    throw new Error('A readable regular file is required (symlinks are refused)');
  });
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit || (privateFile && (info.uid !== uid() || (info.mode & 0o077) !== 0)))
      throw new Error('A bounded regular file with appropriate ownership and permissions is required');
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit || !isUtf8(buffer.subarray(0, bytesRead)))
      throw new Error('File exceeds byte budget or is not UTF8');
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Match kernel ancestry rather than guessing a pane from cwd or a pane-id prefix. */
async function currentProcessAncestry(): Promise<Set<string>> {
  const pids = new Set([String(process.pid), String(process.ppid)]);
  if (process.platform !== 'linux') return pids;
  let pid = process.pid;
  for (let depth = 0; depth < 32 && pid > 1; depth++) {
    try {
      const raw = (await readRegular(`/proc/${pid}/stat`, 4096)).toString('utf8');
      const match = raw.slice(raw.lastIndexOf(')') + 1).match(/^\s+\S\s+(\d+)/);
      if (!match) break;
      const parent = Number(match[1]);
      if (parent <= 0 || parent === pid) break;
      pids.add(String(parent));
      pid = parent;
    } catch {
      break;
    }
  }
  return pids;
}
function validReceipt(record: LocalReceipt): boolean {
  return (
    record.version === 1 &&
    UUID.test(record.stageId) &&
    record.uid === uid() &&
    typeof record.socket === 'string' &&
    typeof record.requestedTarget === 'string' &&
    typeof record.paneIdentity === 'string' &&
    /^%\d+$/.test(record.target) &&
    (record.mode === 'codex' || record.mode === 'claude') &&
    typeof record.multiline === 'boolean' &&
    Number.isFinite(record.expiresAt) &&
    record.expiresAt > 0 &&
    /^[a-f0-9]{64}$/.test(record.sha256) &&
    /^[a-f0-9]{64}$/.test(record.frameSha)
  );
}

export class LocalTerminal {
  private readonly run: LocalTmuxRunner;
  private readonly receiptDir: string;
  private readonly now: () => number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly paintTimeoutMs: number;
  private ancestry?: Promise<Set<string>>;
  constructor(options: LocalTerminalOptions = {}) {
    this.run = options.run ?? defaultRunner;
    this.receiptDir = options.receiptDir ?? join(homedir(), '.codeman', 'local-receipts');
    this.now = options.now ?? Date.now;
    this.env = options.env ?? process.env;
    this.paintTimeoutMs = options.paintTimeoutMs ?? 2000;
  }
  private tmux(options: LocalTarget, args: string[], input?: string): Promise<string> {
    return this.run(['-L', options.socket, ...args], input);
  }
  private async pane(options: LocalTarget): Promise<Pane> {
    return parsePane(await this.tmux(options, ['display-message', '-p', '-t', options.target, META]));
  }
  private async refuseSelf(pane: Pane): Promise<void> {
    const currentServer = this.env.TMUX?.split(',').at(-2);
    this.ancestry ??= currentProcessAncestry();
    if ((this.env.TMUX_PANE === pane.id && currentServer === pane.serverPid) || (await this.ancestry).has(pane.pid))
      throw new Error('Refusing to write to my own pane');
  }
  private async frame(options: LocalTarget, write = false): Promise<Frame> {
    validateTarget(options);
    const before = await this.pane(options);
    if (write) await this.refuseSelf(before);
    if (before.dead) throw new Error('Target pane is dead');
    const exact = { ...options, target: before.id };
    const screen = await this.tmux(exact, ['capture-pane', '-p', '-e', '-t', before.id]);
    const after = await this.pane(exact);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Pane changed during capture; inspect again');
    const lines = screen.split('\n');
    if (lines.length && lines.at(-1) === '') lines.pop();
    if (lines.length !== before.rows) throw new Error('Incomplete pane snapshot');
    const snapshot =
      lines.map((line, index) => `\x1b[${index + 1};1H${line}`).join('') +
      `\x1b[${before.cursorY + 1};${before.cursorX + 1}H`;
    return { pane: before, screen, snapshot };
  }
  async inspect(options: LocalTarget & { maxBytes?: number }) {
    const maxBytes = options.maxBytes ?? 8192;
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > INSPECT_MAX_BYTES)
      throw new Error('maxBytes must be 1–65536');
    const frame = await this.frame(options);
    const text = stripAnsi(frame.screen);
    const evidence = boundedUtf8Tail(text, maxBytes);
    return {
      source: 'pane-snapshot' as const,
      incremental: false,
      cursor: null,
      socket: options.socket,
      target: frame.pane.id,
      identity: identity(frame.pane),
      evidence,
      truncated: Buffer.byteLength(text) > Buffer.byteLength(evidence),
      guarantees: 'Observed local pane only; independent tmux writes are not serialized',
    };
  }
  private async store(): Promise<void> {
    await noSymlinkComponents(this.receiptDir);
    await mkdir(this.receiptDir, { recursive: true, mode: 0o700 });
    const info = await lstat(this.receiptDir);
    if (!info.isDirectory() || info.uid !== uid() || (info.mode & 0o077) !== 0)
      throw new Error('Receipt directory must be private (0700), regular and owned by this user');
  }
  private async capacity(): Promise<void> {
    const entries = await readdir(this.receiptDir, { withFileTypes: true });
    if (entries.length > 4096) throw new Error('Local receipt store scan capacity reached');
    let count = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !UUID.test(entry.name.replace(/\.json$/, '')) || !entry.name.endsWith('.json')) continue;
      const path = join(this.receiptDir, entry.name);
      let receipt: LocalReceipt;
      try {
        receipt = JSON.parse((await readRegular(path, 8192, true)).toString('utf8'));
      } catch {
        count++;
        continue;
      }
      if (receipt.uid === uid() && receipt.version === 1 && receipt.expiresAt <= this.now()) await rm(path);
      else count++;
    }
    if (count >= 1024) throw new Error('Local guarded receipt capacity reached');
  }
  async stage(options: LocalStageOptions) {
    validateTarget(options);
    const profile = getCli(options.mode)?.capabilities.nativeAssistantProfile;
    if (profile !== 'codex' && profile !== 'claude')
      throw new Error('Stage requires an installed mode with a characterized Codex or Claude composer profile');
    const message = normalizeGuardedMessageFile(
      (await readRegular(options.messageFile, STAGE_MAX_BYTES + 2)).toString('utf8')
    );
    const refusal = guardedMessageRefusal(message, options.multiline ?? false);
    if (refusal) throw new Error(refusal);
    await this.store();
    await this.capacity();
    const before = await this.frame(options, true);
    if (readGuardedComposerSnapshot(before.snapshot, profile, options.multiline) !== '')
      throw new Error('An empty, verifiable composer and caret are required');
    if (message.includes('\n') && !before.pane.bracketedPaste)
      throw new Error('Multiline staging requires active bracketed paste mode');
    const buffer = `codeman-local-${randomUUID()}`;
    const target = { ...options, target: before.pane.id };
    try {
      await this.tmux(target, ['load-buffer', '-b', buffer, '-'], message);
      const current = await this.frame(target, true);
      if (identity(current.pane) !== identity(before.pane) || current.snapshot !== before.snapshot)
        throw new Error('Pane or composer changed before paste');
      if (message.includes('\n') && !current.pane.bracketedPaste)
        throw new Error('Multiline staging requires active bracketed paste mode immediately before dispatch');
      await this.tmux(target, ['paste-buffer', '-p', '-d', '-b', buffer, '-t', before.pane.id]);
    } catch (error) {
      throw new Error(
        `Staging delivery failed or ambiguous; inspect before trying again: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      await this.tmux(target, ['delete-buffer', '-b', buffer]).catch(() => {});
    }
    const started = Date.now();
    let after: Frame;
    while (true) {
      after = await this.frame(target, true);
      if (identity(after.pane) !== identity(before.pane))
        throw new Error('Pane changed after paste; no receipt issued');
      if (readGuardedComposerSnapshot(after.snapshot, profile, options.multiline) === message) break;
      if (Date.now() - started >= this.paintTimeoutMs)
        throw new Error('Staged composer is not verified; no receipt issued, inspect before trying again');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const stageId = randomUUID();
    const record: LocalReceipt = {
      version: 1,
      stageId,
      uid: uid(),
      socket: options.socket,
      requestedTarget: options.target,
      paneIdentity: identity(after.pane),
      target: after.pane.id,
      mode: profile,
      multiline: options.multiline ?? false,
      expiresAt: this.now() + 120000,
      sha256: promptSha256(message),
      frameSha: promptSha256(after.snapshot),
    };
    const handle = await open(
      join(this.receiptDir, `${stageId}.json`),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600
    );
    try {
      await handle.writeFile(JSON.stringify(record));
    } finally {
      await handle.close();
    }
    return {
      stageId,
      sha256: record.sha256,
      expiresAt: record.expiresAt,
      target: record.target,
      socket: record.socket,
      submitted: false,
    };
  }
  async submit(options: LocalTarget & { stageId: string; confirmSha: string }) {
    validateTarget(options);
    if (!UUID.test(options.stageId)) throw new Error('A valid stage UUID is required');
    await this.store();
    const path = join(this.receiptDir, `${options.stageId}.json`);
    const record = JSON.parse((await readRegular(path, 8192, true)).toString('utf8')) as LocalReceipt;
    if (
      record.version !== 1 ||
      record.uid !== uid() ||
      record.stageId !== options.stageId ||
      record.socket !== options.socket ||
      (record.requestedTarget !== options.target && record.target !== options.target)
    )
      throw new Error('Foreign or invalid local stage receipt');
    // Atomic rename claims the receipt across processes. Every owned attempt consumes
    // it, including wrong hashes, unprovable frames and ambiguous Enter delivery.
    const claimed = join(this.receiptDir, `claimed-${randomUUID()}.json`);
    await rename(path, claimed).catch(() => {
      throw new Error('Stage receipt was already consumed');
    });
    try {
      const claimedBytes = await readRegular(claimed, 8192, true);
      if (claimedBytes.toString('utf8') !== JSON.stringify(record)) throw new Error('Stage receipt changed');
      if (!validReceipt(record)) throw new Error('Invalid local stage receipt');
      if (
        !/^[a-f0-9]{64}$/.test(options.confirmSha) ||
        record.sha256 !== options.confirmSha ||
        record.expiresAt <= this.now()
      )
        throw new Error('Expired stage receipt or confirmation hash mismatch');
      const current = await this.frame({ ...options, target: record.target }, true);
      if (
        identity(current.pane) !== record.paneIdentity ||
        promptSha256(current.snapshot) !== record.frameSha ||
        promptSha256(readGuardedComposerSnapshot(current.snapshot, record.mode, record.multiline) ?? '\0') !==
          record.sha256
      )
        throw new Error('Pane or exact staged composer changed; nothing submitted');
      try {
        await this.tmux({ ...options, target: record.target }, ['send-keys', '-t', record.target, 'Enter']);
      } catch {
        throw new Error('Enter delivery failed or ambiguous; receipt consumed, inspect the pane (no retry)');
      }
      return { stageId: record.stageId, target: record.target, submitted: true };
    } finally {
      await rm(claimed, { force: true });
    }
  }
}
