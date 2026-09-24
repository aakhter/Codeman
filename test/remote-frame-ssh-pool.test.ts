import { existsSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RemoteFrameSshPool } from '../src/remote-frame-ssh-pool.js';

const BASE = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-p', '22'];
const TARGET = 'ubuntu@worker.example';
const OPTIONS = { timeout: 10_000, maxBuffer: 64 * 1024 * 1024 };

function controlPath(argv: string[]): string | undefined {
  return argv.find((arg) => arg.startsWith('ControlPath='))?.slice('ControlPath='.length);
}

describe('remote visible-frame SSH connection pool (COD-441)', () => {
  const pools: RemoteFrameSshPool[] = [];

  afterEach(async () => {
    await Promise.all(pools.splice(0).map((pool) => pool.close()));
  });

  it('uses a private socket shared only by the same owner and effective SSH target', async () => {
    const calls: string[][] = [];
    const pool = new RemoteFrameSshPool(async (argv) => {
      calls.push(argv);
      return 'same frame';
    });
    pools.push(pool);

    expect(await pool.capture(BASE, TARGET, 'capture-frame', 'alice', OPTIONS)).toBe('same frame');
    expect(await pool.capture(BASE, TARGET, 'capture-frame', 'alice', OPTIONS)).toBe('same frame');
    expect(await pool.capture(BASE, TARGET, 'capture-frame', 'bob', OPTIONS)).toBe('same frame');
    expect(await pool.capture([...BASE, '-i', '/other/key'], TARGET, 'capture-frame', 'alice', OPTIONS)).toBe(
      'same frame'
    );

    const alicePath = controlPath(calls[0]);
    expect(alicePath).toBeTruthy();
    expect(controlPath(calls[1])).toBe(alicePath);
    expect(controlPath(calls[2])).not.toBe(alicePath);
    expect(controlPath(calls[3])).not.toBe(alicePath);
    expect(statSync(dirname(alicePath!)).mode & 0o777).toBe(0o700);
    expect(calls[0]).toContain('ControlMaster=auto');
    expect(calls[0]).toContain('ControlPersist=60');

    await pool.close();
    expect(existsSync(dirname(alicePath!))).toBe(false);
  });

  it('keeps explicit saved SSH control options untouched', async () => {
    const calls: string[][] = [];
    const pool = new RemoteFrameSshPool(async (argv) => {
      calls.push(argv);
      return 'frame';
    });
    pools.push(pool);

    await pool.capture([...BASE, '-o', 'ControlPath=/user/socket'], TARGET, 'capture-frame', 'alice', OPTIONS);

    expect(calls[0]).toEqual([...BASE, '-o', 'ControlPath=/user/socket', TARGET, 'capture-frame']);
  });

  it('removes a stale socket and establishes a fresh master without changing the frame command', async () => {
    const calls: string[][] = [];
    let checkFailed = false;
    const pool = new RemoteFrameSshPool(async (argv) => {
      calls.push(argv);
      if (argv.includes('check')) {
        checkFailed = true;
        throw new Error('stale master');
      }
      const path = controlPath(argv);
      if (path) writeFileSync(path, 'stale socket placeholder');
      return 'frame';
    });
    pools.push(pool);

    await pool.capture(BASE, TARGET, 'capture-frame', 'alice', OPTIONS);
    const path = controlPath(calls[0])!;
    await pool.capture(BASE, TARGET, 'capture-frame', 'alice', OPTIONS);

    expect(checkFailed).toBe(true);
    expect(controlPath(calls.at(-1)!)).toBe(path);
    expect(calls.at(-1)!.at(-1)).toBe('capture-frame');
    expect(existsSync(path)).toBe(true);
  });

  it('discards the master after a capture failure so the next request can reconnect', async () => {
    const calls: string[][] = [];
    let fail = false;
    const pool = new RemoteFrameSshPool(async (argv) => {
      calls.push(argv);
      if (argv.includes('check') || argv.includes('exit')) return '';
      if (fail) {
        fail = false;
        throw Object.assign(new Error('capture timed out'), { code: 255 });
      }
      const path = controlPath(argv);
      if (path) writeFileSync(path, 'socket placeholder');
      return 'frame';
    });
    pools.push(pool);

    await pool.capture(BASE, TARGET, 'capture-frame', 'alice', OPTIONS);
    const path = controlPath(calls[0])!;
    fail = true;
    await expect(pool.capture(BASE, TARGET, 'capture-frame', 'alice', OPTIONS)).rejects.toThrow('capture timed out');
    expect(existsSync(path)).toBe(false);
    await expect(pool.capture(BASE, TARGET, 'capture-frame', 'alice', OPTIONS)).resolves.toBe('frame');
  });

  it('preserves a healthy shared master when a remote tmux command fails', async () => {
    const calls: string[][] = [];
    let fail = false;
    const pool = new RemoteFrameSshPool(async (argv) => {
      calls.push(argv);
      if (argv.includes('check') || argv.includes('exit')) return '';
      if (fail) {
        fail = false;
        throw Object.assign(new Error('pane missing'), { code: 1 });
      }
      const path = controlPath(argv);
      if (path) writeFileSync(path, 'socket placeholder');
      return 'frame';
    });
    pools.push(pool);

    await pool.capture(BASE, TARGET, 'capture-frame', 'alice', OPTIONS);
    const path = controlPath(calls[0])!;
    fail = true;
    await expect(pool.capture(BASE, TARGET, 'capture-frame', 'alice', OPTIONS)).rejects.toThrow('pane missing');
    expect(existsSync(path)).toBe(true);
    await expect(pool.capture(BASE, TARGET, 'capture-frame', 'alice', OPTIONS)).resolves.toBe('frame');
    expect(controlPath(calls.at(-1)!)).toBe(path);
  });
});
