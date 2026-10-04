/**
 * @fileoverview COD-463 — per-host backoff for remote pane captures, plus the
 * combined one-roundtrip full-history command.
 *
 * Prod incident: a remote host whose NEW ssh sessions hung (~136s, wedged
 * systemd/dbus) made every tab switch to its sessions sit out the 10s capture
 * timeout. After one transport failure the backoff must stop blocking on ssh.
 */
import { describe, expect, it } from 'vitest';
import { RemoteCaptureBackoff, isSshTransportFailure } from '../src/remote-capture-backoff.js';
import { buildRemoteFullHistoryCommand, parseRemoteFullHistoryCapture } from '../src/tmux-manager.js';

const timeout = () => Object.assign(new Error('Command failed: ssh'), { killed: true, signal: 'SIGTERM' });
const sshExit255 = () => Object.assign(new Error('ssh: connect failed'), { code: 255 });
const tmuxMissing = () => Object.assign(new Error("can't find session"), { code: 1 });

/** A controllable clock + a sleep that resolves only when the test says so. */
function harness() {
  let now = 1_000_000;
  const sleepers: Array<() => void> = [];
  const backoff = new RemoteCaptureBackoff({
    now: () => now,
    probeIntervalMs: 15_000,
    probeWaitMs: 1_500,
    sleep: () => new Promise<void>((resolve) => sleepers.push(resolve)),
  });
  return {
    backoff,
    advance: (ms: number) => {
      now += ms;
    },
    elapseProbeWait: () => {
      for (const wake of sleepers.splice(0)) wake();
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('isSshTransportFailure', () => {
  it('treats the execFile timeout kill and ssh exit 255 as transport failures, nothing else', () => {
    expect(isSshTransportFailure(timeout())).toBe(true);
    expect(isSshTransportFailure(sshExit255())).toBe(true);
    expect(isSshTransportFailure(tmuxMissing())).toBe(false);
    expect(isSshTransportFailure(null)).toBe(false);
  });
});

describe('RemoteCaptureBackoff', () => {
  it('runs captures normally while the host is healthy', async () => {
    const { backoff } = harness();
    await expect(backoff.run('h', async () => 'frame')).resolves.toBe('frame');
    expect(backoff.isDegraded('h')).toBe(false);
  });

  it('marks the host degraded on a transport failure and rethrows it', async () => {
    const { backoff } = harness();
    await expect(
      backoff.run('h', async () => {
        throw timeout();
      })
    ).rejects.toMatchObject({ killed: true });
    expect(backoff.isDegraded('h')).toBe(true);
    expect(backoff.isDegraded('other-host')).toBe(false);
  });

  it('does not degrade on a non-transport failure (the host answered)', async () => {
    const { backoff } = harness();
    await expect(
      backoff.run('h', async () => {
        throw tmuxMissing();
      })
    ).rejects.toBeTruthy();
    expect(backoff.isDegraded('h')).toBe(false);
  });

  it('while degraded, returns null at once without touching ssh until the probe interval passes', async () => {
    const { backoff, advance } = harness();
    await backoff.run('h', async () => Promise.reject(timeout())).catch(() => {});
    let calls = 0;
    const capture = async () => {
      calls++;
      return 'frame';
    };
    await expect(backoff.run('h', capture)).resolves.toBeNull();
    advance(14_999);
    await expect(backoff.run('h', capture)).resolves.toBeNull();
    expect(calls).toBe(0);
  });

  it('a probe that answers within the wait budget returns real data and clears the state', async () => {
    const { backoff, advance } = harness();
    await backoff.run('h', async () => Promise.reject(timeout())).catch(() => {});
    advance(15_000);
    await expect(backoff.run('h', async () => 'recovered frame')).resolves.toBe('recovered frame');
    expect(backoff.isDegraded('h')).toBe(false);
  });

  it('a slow probe is abandoned after the wait budget, runs on alone, and is never doubled', async () => {
    const { backoff, advance, elapseProbeWait } = harness();
    await backoff.run('h', async () => Promise.reject(timeout())).catch(() => {});
    advance(15_000);
    const slow = deferred<string>();
    let calls = 0;
    const pending = backoff.run('h', () => {
      calls++;
      return slow.promise;
    });
    await flush();
    elapseProbeWait();
    await expect(pending).resolves.toBeNull();
    // Probe still in flight: a second request must not start another ssh.
    await expect(
      backoff.run('h', async () => {
        calls++;
        return 'x';
      })
    ).resolves.toBeNull();
    expect(calls).toBe(1);

    // The late probe succeeding clears the backoff for the next request.
    slow.resolve('late frame');
    await flush();
    expect(backoff.isDegraded('h')).toBe(false);
  });

  it('a probe that fails on transport pushes the next probe out by the interval', async () => {
    const { backoff, advance } = harness();
    await backoff.run('h', async () => Promise.reject(timeout())).catch(() => {});
    advance(15_000);
    await expect(backoff.run('h', async () => Promise.reject(sshExit255()))).resolves.toBeNull();
    await flush();
    expect(backoff.isDegraded('h')).toBe(true);
    let calls = 0;
    advance(10_000);
    await backoff.run('h', async () => {
      calls++;
      return 'x';
    });
    expect(calls).toBe(0);
    advance(5_000);
    await expect(backoff.run('h', async () => 'back')).resolves.toBe('back');
  });

  it('a probe that fails with a non-transport error clears the state (ssh works again)', async () => {
    const { backoff, advance } = harness();
    await backoff.run('h', async () => Promise.reject(timeout())).catch(() => {});
    advance(15_000);
    await expect(backoff.run('h', async () => Promise.reject(tmuxMissing()))).resolves.toBeNull();
    await flush();
    expect(backoff.isDegraded('h')).toBe(false);
  });
});

describe('remote full-history capture in one ssh roundtrip', () => {
  it('queries geometry BEFORE the capture, separated by the delimiter line', () => {
    const cmd = buildRemoteFullHistoryCommand('codeman-ssh-4f58bb47', 'codeman-remote', 500);
    const display = cmd.indexOf("tmux -L codeman-remote display-message -p -t 'codeman-ssh-4f58bb47'");
    const delim = cmd.indexOf("printf '__CODEMAN_GEOM__\\n'");
    const capture = cmd.indexOf("tmux -L codeman-remote capture-pane -p -e -S -500 -t 'codeman-ssh-4f58bb47'");
    expect(display).toBeGreaterThan(-1);
    expect(delim).toBeGreaterThan(display);
    expect(capture).toBeGreaterThan(delim);
    expect(buildRemoteFullHistoryCommand('t', 'codeman')).toContain('capture-pane -p -e -S - -t');
  });

  it('positions the cursor from the geometry line', () => {
    const out = parseRemoteFullHistoryCapture('3 1 80 2\n__CODEMAN_GEOM__\nline one\nline two\n');
    // Two captured rows fill a 2-row pane: anchor to the tail, then the column.
    expect(out).toBe('line one\r\nline two\r\x1b[4G');
  });

  it('degrades to the cursor-less format when the geometry query printed nothing', () => {
    expect(parseRemoteFullHistoryCapture('__CODEMAN_GEOM__\nonly text\n')).toBe('only text');
  });

  it('a delimiter-looking line inside the capture is just text', () => {
    const out = parseRemoteFullHistoryCapture('0 0 80 1\n__CODEMAN_GEOM__\n__CODEMAN_GEOM__\n');
    expect(out).toContain('__CODEMAN_GEOM__');
  });

  it('returns null for an empty capture so the caller falls back', () => {
    expect(parseRemoteFullHistoryCapture('0 0 80 24\n__CODEMAN_GEOM__\n')).toBeNull();
    expect(parseRemoteFullHistoryCapture('')).toBeNull();
  });
});
