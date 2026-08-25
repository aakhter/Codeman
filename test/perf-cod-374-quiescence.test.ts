import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  BROWSER_MAX_DRIFT_MS,
  BROWSER_MAX_P95_DRIFT_MS,
  BROWSER_TICK_COUNT,
  BROWSER_TIMER_INTERVAL_MS,
  HOST_MAX_LOAD_PER_CPU,
  HOST_MIN_IDLE_PERCENT,
  HOST_MIN_WINDOW_MS,
  HOST_SAMPLE_COUNT,
  HOST_SAMPLE_INTERVAL_MS,
  calculateCpuIdlePercent,
  classifyHostProcesses,
  collectCurrentUidProcesses,
  discoverStableAncestorIdentities,
  measureHostQuiescence,
  nearestRankPercentile,
  parseAggregateCpuStat,
  readBoundedProcFile,
  readStableProcessRecord,
  validateBrowserQuiescence,
  validateHostQuiescence,
  validatePersistedHostQuiescence,
} from '../scripts/perf/cod-374-quiescence.mjs';

const hash16 = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);
const processHash = (command: string, cwd?: string, exe?: string) =>
  hash16(cwd === undefined && exe === undefined ? command : [command, cwd ?? '', exe ?? ''].join('\0'));

function hostEvidence(overrides: Record<string, unknown> = {}) {
  return {
    cpuCount: 8,
    sampleCount: 11,
    sampleIntervalMs: 500,
    startedAtMs: 1_000,
    endedAtMs: 6_000,
    sampleTimesMs: Array.from({ length: 11 }, (_, index) => 1_000 + index * 500),
    idlePercent: 80,
    firstLoad1: 4,
    finalLoad1: 4,
    processes: [],
    measurementErrorHash: null,
    passed: true,
    ...overrides,
  };
}

function browserEvidence(overrides: Record<string, unknown> = {}) {
  const driftsMs = Array.from({ length: 50 }, (_, index) => (index === 49 ? 25 : index >= 47 ? 10 : 1));
  return {
    tickCount: 50,
    timerIntervalMs: 20,
    driftsMs,
    p95DriftMs: 10,
    maxDriftMs: 25,
    longTaskDurationsMs: [],
    pageErrorHashes: [],
    consoleErrorHashes: [],
    resizeCount: 0,
    overflowed: false,
    measurementErrorHash: null,
    passed: true,
    ...overrides,
  };
}

describe('COD-374 quiescence constants and CPU normalization', () => {
  it('freezes the approved host and browser thresholds', () => {
    expect({
      HOST_SAMPLE_COUNT,
      HOST_SAMPLE_INTERVAL_MS,
      HOST_MIN_WINDOW_MS,
      HOST_MIN_IDLE_PERCENT,
      HOST_MAX_LOAD_PER_CPU,
      BROWSER_TICK_COUNT,
      BROWSER_TIMER_INTERVAL_MS,
      BROWSER_MAX_P95_DRIFT_MS,
      BROWSER_MAX_DRIFT_MS,
    }).toEqual({
      HOST_SAMPLE_COUNT: 11,
      HOST_SAMPLE_INTERVAL_MS: 500,
      HOST_MIN_WINDOW_MS: 5_000,
      HOST_MIN_IDLE_PERCENT: 80,
      HOST_MAX_LOAD_PER_CPU: 0.5,
      BROWSER_TICK_COUNT: 50,
      BROWSER_TIMER_INTERVAL_MS: 20,
      BROWSER_MAX_P95_DRIFT_MS: 10,
      BROWSER_MAX_DRIFT_MS: 25,
    });
  });

  it('parses aggregate /proc/stat and normalizes idle plus iowait', () => {
    expect(parseAggregateCpuStat('cpu  10 20 30 40 5 6 7 8 9 10\ncpu0 1 2 3 4 5 6 7 8 9 10\n')).toEqual({
      idle: 45n,
      total: 126n,
    });
    expect(calculateCpuIdlePercent({ idle: 100n, total: 200n }, { idle: 180n, total: 300n })).toBe(80);
  });

  it.each([
    ['missing aggregate', 'intr 1 2 3'],
    ['short aggregate', 'cpu 1 2 3'],
    ['negative counter', 'cpu 1 2 3 -4 5 6 7 8'],
    ['non-decimal counter', 'cpu 1 2 3 nope 5 6 7 8'],
    ['malformed later counter', 'cpu 1 2 3 4 5 6 7 8 nope'],
  ])('rejects malformed CPU counters: %s', (_label, value) => {
    expect(() => parseAggregateCpuStat(value)).toThrow('COD-374 quiescence invalid: CPU counters');
  });

  it.each([
    [
      { idle: 100n, total: 200n },
      { idle: 99n, total: 300n },
    ],
    [
      { idle: 100n, total: 200n },
      { idle: 180n, total: 199n },
    ],
    [
      { idle: 100n, total: 200n },
      { idle: 201n, total: 300n },
    ],
  ])('rejects decreasing or impossible normalized deltas', (first, last) => {
    expect(() => calculateCpuIdlePercent(first, last)).toThrow('COD-374 quiescence invalid: CPU counters');
  });
});

describe('COD-374 host evidence', () => {
  it('accepts the exact idle, load, count, and window boundaries', () => {
    expect(validateHostQuiescence(hostEvidence())).toEqual(hostEvidence());
  });

  it.each([
    ['idle', { idlePercent: 79.999 }],
    ['first load', { firstLoad1: 4.001 }],
    ['final load', { finalLoad1: 4.001 }],
    ['sample count', { sampleCount: 10, sampleTimesMs: Array.from({ length: 10 }, (_, index) => 1_000 + index * 500) }],
    ['sample interval', { sampleIntervalMs: 499 }],
    ['window', { endedAtMs: 5_999 }],
    [
      'per-sample spacing',
      { sampleTimesMs: [1_000, 1_499, 2_000, 2_500, 3_000, 3_500, 4_000, 4_500, 5_000, 5_500, 6_000] },
    ],
  ])('rejects a host outside the %s boundary', (_label, override) => {
    expect(() => validateHostQuiescence(hostEvidence(override))).toThrow('COD-374 host is not quiescent');
  });

  it('derives the gate result before separately checking persisted pass anti-forgery', () => {
    expect(() => validateHostQuiescence(hostEvidence({ idlePercent: 79, passed: true }))).toThrow(
      'COD-374 host is not quiescent'
    );
    expect(validateHostQuiescence(hostEvidence({ passed: false }))).toEqual(hostEvidence({ passed: true }));
    expect(() => validatePersistedHostQuiescence(hostEvidence({ passed: false }))).toThrow(
      'COD-374 quiescence invalid: host pass assertion'
    );
  });

  it('retains only hashed process identities and allows the current PID ancestor chain', () => {
    const ownCommand = '/usr/bin/node scripts/perf/cod-374-runner.mjs --secret token';
    const parentCommand = '/bin/bash /private/worktree/runner.sh';
    const records = classifyHostProcesses({
      currentPid: 100,
      ancestorPids: [
        { pid: 100, startIdentity: '1000' },
        { pid: 50, startIdentity: '500' },
      ],
      processes: [
        { pid: 100, ppid: 50, uid: 1_000, startIdentity: '1000', command: ownCommand },
        { pid: 50, ppid: 1, uid: 1_000, startIdentity: '500', command: parentCommand },
      ],
    });

    expect(records).toEqual([
      {
        classification: 'allowed-ancestor',
        commandHash: hash16(ownCommand),
        startIdentity: '1000',
        allowedAncestor: true,
      },
      {
        classification: 'allowed-ancestor',
        commandHash: hash16(parentCommand),
        startIdentity: '500',
        allowedAncestor: true,
      },
    ]);
    expect(JSON.stringify(records)).not.toContain('--secret');
    expect(JSON.stringify(records)).not.toContain('/private');
  });

  it('classifies every frozen unrelated conflict including associated Chromium', () => {
    const records = classifyHostProcesses({
      currentPid: 100,
      ancestorPids: [
        { pid: 100, startIdentity: '1000' },
        { pid: 50, startIdentity: '500' },
      ],
      processes: [
        { pid: 201, ppid: 1, uid: 1_000, startIdentity: '2010', command: 'node vitest run one.test.ts' },
        {
          pid: 202,
          ppid: 1,
          uid: 1_000,
          startIdentity: '2020',
          command: 'node node_modules/@playwright/test/cli.js test mobile',
        },
        {
          pid: 203,
          ppid: 1,
          uid: 1_000,
          startIdentity: '2030',
          command: 'node scripts/perf/cod-374-runner.mjs',
        },
        { pid: 204, ppid: 1, uid: 1_000, startIdentity: '2040', command: 'tsx /tmp/cod370-runtime/src/index.ts' },
        { pid: 206, ppid: 202, uid: 1_000, startIdentity: '2060', command: 'node browser-launch-helper.js' },
        { pid: 205, ppid: 206, uid: 1_000, startIdentity: '2050', command: '/usr/bin/google-chrome --headless' },
      ],
    });

    expect(records.map(({ classification }) => classification)).toEqual([
      'vitest',
      'playwright-runner',
      'cod-374-runner',
      'disposable-runtime',
      'associated-chromium',
    ]);
    expect(records.every(({ allowedAncestor }) => allowedAncestor === false)).toBe(true);
    expect(() => validateHostQuiescence(hostEvidence({ processes: records, passed: false }))).toThrow(
      'COD-374 host is not quiescent'
    );
  });

  it('rejects more than 32 retained process identities and raw or extra fields', () => {
    const processes = Array.from({ length: 33 }, (_, index) => ({
      classification: 'vitest',
      commandHash: hash16(`vitest-${index}`),
      startIdentity: `${index + 1}`,
      allowedAncestor: false,
    }));
    expect(() => validateHostQuiescence(hostEvidence({ processes, passed: false }))).toThrow(
      'COD-374 quiescence invalid'
    );
    expect(() =>
      validateHostQuiescence(
        hostEvidence({
          processes: [{ ...processes[0], command: 'raw secret' }],
          passed: false,
        })
      )
    ).toThrow('COD-374 quiescence invalid');
  });

  it('binds allowed ancestors to PID plus start identity and rejects PID reuse', () => {
    const reused = classifyHostProcesses({
      currentPid: 100,
      ancestorPids: [
        { pid: 100, startIdentity: '1000' },
        { pid: 50, startIdentity: '500' },
      ],
      processes: [
        { pid: 100, ppid: 50, uid: 1_000, startIdentity: '1000', command: 'node original.js' },
        { pid: 100, ppid: 50, uid: 1_000, startIdentity: '1001', command: 'node unrelated.js' },
        { pid: 50, ppid: 1, uid: 1_000, startIdentity: '500', command: 'bash' },
      ],
    });

    expect(reused).toContainEqual({
      classification: 'allowed-ancestor',
      commandHash: hash16('node original.js'),
      startIdentity: '1000',
      allowedAncestor: true,
    });
    expect(reused).toContainEqual({
      classification: 'ancestor-pid-reused',
      commandHash: hash16('node unrelated.js'),
      startIdentity: '1001',
      allowedAncestor: false,
    });
    expect(() => validateHostQuiescence(hostEvidence({ processes: reused, passed: false }))).toThrow(
      'COD-374 host is not quiescent'
    );
  });

  it('caps conflicts at 32 independently from retained allowed ancestors', () => {
    const processes = [
      { pid: 100, ppid: 50, uid: 1_000, startIdentity: '1000', command: 'node gate.js' },
      { pid: 50, ppid: 1, uid: 1_000, startIdentity: '500', command: 'bash' },
      ...Array.from({ length: 32 }, (_, index) => ({
        pid: 200 + index,
        ppid: 1,
        uid: 1_000,
        startIdentity: `${2_000 + index}`,
        command: `node vitest run conflict-${index}.test.ts`,
      })),
    ];
    const records = classifyHostProcesses({
      currentPid: 100,
      ancestorPids: [
        { pid: 100, startIdentity: '1000' },
        { pid: 50, startIdentity: '500' },
      ],
      processes,
    });
    expect(records).toHaveLength(34);
    expect(records.filter(({ allowedAncestor }) => !allowedAncestor)).toHaveLength(32);
    expect(() =>
      classifyHostProcesses({
        currentPid: 100,
        ancestorPids: [
          { pid: 100, startIdentity: '1000' },
          { pid: 50, startIdentity: '500' },
        ],
        processes: [
          ...processes,
          { pid: 999, ppid: 1, uid: 1_000, startIdentity: '9990', command: 'node vitest run overflow.test.ts' },
        ],
      })
    ).toThrow('COD-374 quiescence invalid: process inventory cardinality');
  });

  it('classifies actual generic fixture server, OpenCode, and tmux commands from disposable path identity', () => {
    const root = '/tmp/cod374-fixture-123/runtime';
    const processes = [
      {
        pid: 100,
        ppid: 50,
        uid: 1_000,
        startIdentity: '1000',
        command: 'node scripts/perf/cod-374-runner.mjs',
        cwd: root,
        exe: '/usr/bin/node',
      },
      {
        pid: 300,
        ppid: 1,
        uid: 1_000,
        startIdentity: '3000',
        command: 'node node_modules/.bin/tsx src/index.ts web',
        cwd: root,
        exe: '/usr/bin/node',
      },
      {
        pid: 301,
        ppid: 1,
        uid: 1_000,
        startIdentity: '3010',
        command: 'opencode',
        cwd: root,
        exe: '/usr/bin/opencode',
      },
      {
        pid: 302,
        ppid: 1,
        uid: 1_000,
        startIdentity: '3020',
        command: 'tmux -L cod370-opencode-302-m0abc12z new-session',
        cwd: '/tmp',
        exe: '/usr/bin/tmux',
      },
      {
        pid: 303,
        ppid: 1,
        uid: 1_000,
        startIdentity: '3030',
        command: '/usr/bin/tmux -L cod374-opencode-303-m0abc130 new-session',
        cwd: '/tmp',
        exe: '/usr/bin/tmux',
      },
      {
        pid: 304,
        ppid: 1,
        uid: 1_000,
        startIdentity: '3040',
        command: 'tmux -L cod370-opencode-dev-team new-session',
        cwd: '/tmp',
        exe: '/usr/bin/tmux',
      },
      {
        pid: 305,
        ppid: 1,
        uid: 1_000,
        startIdentity: '3050',
        command: 'tmux -L personal-305-1724572802 new-session',
        cwd: '/tmp',
        exe: '/usr/bin/tmux',
      },
      {
        pid: 306,
        ppid: 1,
        uid: 1_000,
        startIdentity: '3060',
        command: 'tmux -L cod370-opencode-306-M0ABC131 new-session',
        cwd: '/tmp',
        exe: '/usr/bin/tmux',
      },
      {
        pid: 307,
        ppid: 1,
        uid: 1_000,
        startIdentity: '3070',
        command: 'tmux -L cod374-opencode-307-m0abc-132 new-session',
        cwd: '/tmp',
        exe: '/usr/bin/tmux',
      },
      {
        pid: 308,
        ppid: 1,
        uid: 1_000,
        startIdentity: '3080',
        command: 'tmux -L cod370-opencode-308 new-session',
        cwd: '/tmp',
        exe: '/usr/bin/tmux',
      },
    ];
    const records = classifyHostProcesses({
      currentPid: 100,
      ancestorPids: [{ pid: 100, startIdentity: '1000' }],
      processes,
    });

    expect(records[0]).toEqual({
      classification: 'allowed-ancestor',
      commandHash: processHash(processes[0].command, processes[0].cwd, processes[0].exe),
      startIdentity: '1000',
      allowedAncestor: true,
    });
    expect(records.slice(1).map(({ classification }) => classification)).toEqual([
      'disposable-runtime',
      'disposable-runtime',
      'disposable-runtime',
      'disposable-runtime',
    ]);
    expect(JSON.stringify(records)).not.toContain(root);
    expect(records).toHaveLength(5);
    expect(JSON.stringify(records)).not.toContain('cod370-opencode-302');
    expect(JSON.stringify(records)).not.toContain('cod374-opencode-303');
  });
});

describe('bounded proc reads', () => {
  it('allocates only the bound plus one sentinel byte and rejects oversized proc content', async () => {
    const close = vi.fn(async () => undefined);
    const read = vi.fn(async (buffer: Buffer) => {
      buffer.fill(97);
      return { bytesRead: buffer.length, buffer };
    });
    const openFile = vi.fn(async () => ({ read, close }));

    await expect(readBoundedProcFile('/proc/secret-path', { maxBytes: 8, openFile })).rejects.toThrow(
      'COD-374 quiescence invalid: bounded proc read'
    );
    expect(read.mock.calls[0][0]).toHaveLength(9);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('assembles partial reads and stops after a zero-byte result', async () => {
    const chunks = [Buffer.from('abc'), Buffer.from('def')];
    const close = vi.fn(async () => undefined);
    const read = vi.fn(async (buffer: Buffer, offset: number) => {
      const chunk = chunks.shift();
      if (!chunk) return { bytesRead: 0, buffer };
      chunk.copy(buffer, offset);
      return { bytesRead: chunk.length, buffer };
    });
    const result = await readBoundedProcFile('/proc/fake', {
      maxBytes: 8,
      openFile: vi.fn(async () => ({ read, close })),
    });
    expect(result.toString()).toBe('abcdef');
    expect(read).toHaveBeenCalledTimes(3);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes after a read exception', async () => {
    const close = vi.fn(async () => undefined);
    const read = vi.fn(async () => {
      throw new Error('read failed');
    });
    await expect(
      readBoundedProcFile('/proc/fake', { maxBytes: 8, openFile: vi.fn(async () => ({ read, close })) })
    ).rejects.toThrow('read failed');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('returns an empty buffer after an immediate zero-byte read', async () => {
    const close = vi.fn(async () => undefined);
    const result = await readBoundedProcFile('/proc/fake', {
      maxBytes: 8,
      openFile: vi.fn(async () => ({ read: vi.fn(async (buffer: Buffer) => ({ bytesRead: 0, buffer })), close })),
    });
    expect(result).toEqual(Buffer.alloc(0));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each([{ bytesRead: '1' }, { bytesRead: -1 }, { bytesRead: 10 }])(
    'rejects malformed bytesRead value $bytesRead',
    async (readResult) => {
      const close = vi.fn(async () => undefined);
      await expect(
        readBoundedProcFile('/proc/fake', {
          maxBytes: 8,
          openFile: vi.fn(async () => ({ read: vi.fn(async () => readResult), close })),
        })
      ).rejects.toThrow('COD-374 quiescence invalid: bounded proc read');
      expect(close).toHaveBeenCalledTimes(1);
    }
  );
});

describe('stable and bounded process inventory', () => {
  const procStat = (pid: number, ppid: number, startIdentity: string) =>
    `${pid} (node) S ${ppid} ${Array(17).fill('0').join(' ')} ${startIdentity} 0\n`;

  it.each([
    ['parent', 2, '3000', 1_000],
    ['start identity', 1, '3001', 1_000],
    ['UID', 1, '3000', 1_001],
  ])(
    'rejects a PID %s change across the stable read without retrying',
    async (_label, finalPpid, finalStart, finalUid) => {
      let statRead = 0;
      let baseMetadataRead = 0;
      const readProcFile = vi.fn(async (path: string) => {
        if (path.endsWith('/cmdline')) return Buffer.from('node\0worker.js\0');
        statRead += 1;
        return statRead === 3 ? procStat(300, finalPpid, finalStart) : procStat(300, 1, '3000');
      });
      const lstatPath = vi.fn(async (path: string) => {
        if (path === '/proc/300') {
          baseMetadataRead += 1;
          return { uid: baseMetadataRead === 2 ? finalUid : 1_000, dev: 1, ino: 300 };
        }
        return { uid: 1_000, dev: 1, ino: path.endsWith('/cwd') ? 301 : 302 };
      });
      const readLinkPath = vi.fn(async (path: string) => (path.endsWith('/cwd') ? '/tmp/work' : '/usr/bin/node'));
      const realpathPath = vi.fn(async (path: string) => readLinkPath(path));
      await expect(
        readStableProcessRecord(300, 1_000, { readProcFile, lstatPath, readLinkPath, realpathPath })
      ).rejects.toThrow('COD-374 quiescence invalid: unstable process identity');
      expect(readProcFile).toHaveBeenCalledTimes(5);
      expect(lstatPath).toHaveBeenCalledTimes(6);
    }
  );

  it('rejects proc-entry overflow before reading a process', async () => {
    const readProcess = vi.fn();
    await expect(
      collectCurrentUidProcesses(1_000, {
        listProcEntries: vi.fn(async () => Array.from({ length: 4_097 }, (_, index) => `${index + 1}`)),
        readProcess,
      })
    ).rejects.toThrow('COD-374 quiescence invalid: process inventory work bound');
    expect(readProcess).not.toHaveBeenCalled();
  });

  it.each([
    ['benign to Vitest', Buffer.from('node\0worker.js\0'), Buffer.from('node\0vitest\0run\0race.test.ts\0')],
    ['Vitest to benign', Buffer.from('node\0vitest\0run\0race.test.ts\0'), Buffer.from('node\0worker.js\0')],
  ])(
    'rejects an exec transition from %s while process identity remains stable',
    async (_label, firstCommand, lastCommand) => {
      const stat = procStat(300, 1, '3000');
      const commands = [firstCommand, lastCommand];
      const readProcFile = vi.fn(async (path: string) => (path.endsWith('/cmdline') ? commands.shift() : stat));
      const lstatPath = vi.fn(async (path: string) => ({
        uid: 1_000,
        dev: 1,
        ino: path.endsWith('/cwd') ? 301 : path.endsWith('/exe') ? 302 : 300,
      }));
      const readLinkPath = vi.fn(async (path: string) =>
        path.endsWith('/cwd') ? '/tmp/cod374-fixture/runtime' : '/usr/bin/node'
      );
      const realpathPath = vi.fn(async (path: string) => readLinkPath(path));

      await expect(
        readStableProcessRecord(300, 1_000, { readProcFile, lstatPath, readLinkPath, realpathPath })
      ).rejects.toThrow('COD-374 quiescence invalid: unstable process identity');
      expect(commands).toHaveLength(0);
    }
  );

  it.each(['node vitest run replacement.test.ts', 'node node_modules/@playwright/test/cli.js test replacement'])(
    'rejects a parent PID reused as %s before it can enter the ancestor allowlist',
    async (replacementCommand) => {
      const readIdentity = vi
        .fn()
        .mockResolvedValueOnce({ pid: 100, ppid: 50, startIdentity: '1000' })
        .mockResolvedValueOnce({ pid: 50, ppid: 1, startIdentity: '5001', command: replacementCommand })
        .mockResolvedValueOnce({ pid: 100, ppid: 1, startIdentity: '1000' });

      await expect(discoverStableAncestorIdentities(100, { readIdentity })).rejects.toThrow(
        'COD-374 quiescence invalid: unstable ancestor edge'
      );
      expect(readIdentity).toHaveBeenCalledTimes(3);
    }
  );

  it('rejects current-UID process overflow with bounded read work', async () => {
    const readProcess = vi.fn(async (pid: number) => ({
      pid,
      ppid: 1,
      uid: 1_000,
      startIdentity: `${pid}0`,
      command: 'node worker.js',
    }));
    await expect(
      collectCurrentUidProcesses(1_000, {
        listProcEntries: vi.fn(async () => Array.from({ length: 513 }, (_, index) => `${index + 1}`)),
        readProcess,
      })
    ).rejects.toThrow('COD-374 quiescence invalid: process inventory work bound');
    expect(readProcess.mock.calls.length).toBeLessThanOrEqual(513);
  });

  it('rejects aggregate current-UID command bytes before retaining unbounded raw inventory', async () => {
    const readProcess = vi.fn(async (pid: number) => ({
      pid,
      ppid: 1,
      uid: 1_000,
      startIdentity: `${pid}0`,
      command: 'x'.repeat(32 * 1024),
    }));
    await expect(
      collectCurrentUidProcesses(1_000, {
        listProcEntries: vi.fn(async () => Array.from({ length: 65 }, (_, index) => `${index + 1}`)),
        readProcess,
      })
    ).rejects.toThrow('COD-374 quiescence invalid: process inventory work bound');
    expect(readProcess).toHaveBeenCalledTimes(65);
  });

  it.each(['ENOENT', 'ESRCH'])(
    'retains a safe disappeared observation for expected %s inventory races',
    async (code) => {
      const readProcess = vi.fn(async (pid: number) => {
        if (pid === 2) {
          const error = new Error('raw /proc/2 path');
          Object.assign(error, { code });
          throw error;
        }
        return { pid, ppid: 1, uid: 1_000, startIdentity: `${pid}0`, command: 'node worker.js' };
      });
      const records = await collectCurrentUidProcesses(1_000, {
        listProcEntries: vi.fn(async () => ['1', '2', '3']),
        readProcess,
      });
      const classified = classifyHostProcesses({
        currentPid: 1,
        ancestorPids: [{ pid: 1, startIdentity: '10' }],
        processes: records,
      });

      expect(readProcess).toHaveBeenCalledTimes(3);
      expect(classified).toContainEqual({
        classification: 'disappeared',
        commandHash: expect.stringMatching(/^[0-9a-f]{16}$/),
        startIdentity: '0',
        allowedAncestor: false,
      });
      expect(JSON.stringify(classified)).not.toContain('/proc/2');
      expect(JSON.stringify(classified)).not.toContain('"pid"');
    }
  );
});

describe('COD-374 browser evidence', () => {
  it('uses nearest-rank p95 and accepts exact 10ms p95 and 25ms max boundaries', () => {
    expect(nearestRankPercentile(browserEvidence().driftsMs, 95)).toBe(10);
    expect(validateBrowserQuiescence(browserEvidence())).toEqual(browserEvidence());
  });

  it.each([
    ['cardinality', { driftsMs: Array(49).fill(1), tickCount: 49, p95DriftMs: 1, maxDriftMs: 1, passed: false }],
    ['interval', { timerIntervalMs: 19, passed: false }],
    [
      'p95',
      {
        driftsMs: [...Array(47).fill(1), ...Array(3).fill(10.001)],
        p95DriftMs: 10.001,
        maxDriftMs: 10.001,
        passed: false,
      },
    ],
    ['maximum', { driftsMs: [...Array(49).fill(1), 25.001], p95DriftMs: 1, maxDriftMs: 25.001, passed: false }],
    ['long task', { longTaskDurationsMs: [50], passed: false }],
    ['page error', { pageErrorHashes: ['a'.repeat(16)], passed: false }],
    ['console error', { consoleErrorHashes: ['b'.repeat(16)], passed: false }],
    ['resize', { resizeCount: 1, passed: false }],
    ['overflow', { overflowed: true, passed: false }],
  ])('rejects browser %s contamination', (_label, override) => {
    expect(() => validateBrowserQuiescence(browserEvidence(override))).toThrow('COD-374 browser is not quiescent');
  });

  it('rejects malformed values, raw diagnostics, and forged summaries', () => {
    expect(() => validateBrowserQuiescence(browserEvidence({ driftsMs: [...Array(49).fill(1), Number.NaN] }))).toThrow(
      'COD-374 quiescence invalid'
    );
    expect(() => validateBrowserQuiescence(browserEvidence({ pageErrorHashes: ['raw error /secret/path'] }))).toThrow(
      'COD-374 quiescence invalid'
    );
    expect(() => validateBrowserQuiescence(browserEvidence({ p95DriftMs: 9 }))).toThrow('COD-374 quiescence invalid');
    expect(() => validateBrowserQuiescence(browserEvidence({ rawError: 'secret' }))).toThrow(
      'COD-374 quiescence invalid'
    );
  });

  it.each([0, 1, 49])('validates failed browser evidence after %i completed ticks', (tickCount) => {
    const driftsMs = Array.from({ length: tickCount }, (_, index) => index + 1);
    const evidence = browserEvidence({
      tickCount,
      driftsMs,
      p95DriftMs: tickCount === 0 ? 0 : nearestRankPercentile(driftsMs, 95),
      maxDriftMs: tickCount === 0 ? 0 : tickCount,
      measurementErrorHash: 'c'.repeat(16),
      passed: false,
    });
    expect(validateBrowserQuiescence(evidence)).toEqual(evidence);
  });

  it('rejects partial browser cardinality that disagrees with tickCount', () => {
    expect(() =>
      validateBrowserQuiescence(
        browserEvidence({
          tickCount: 1,
          driftsMs: [1, 2],
          p95DriftMs: 2,
          maxDriftMs: 2,
          measurementErrorHash: 'c'.repeat(16),
          passed: false,
        })
      )
    ).toThrow('COD-374 quiescence invalid');
  });
});

describe('measureHostQuiescence', () => {
  function samplerAdapters(overrides: Record<string, unknown> = {}) {
    let now = 1_000;
    let cpuRead = 0;
    const inventory = vi.fn(async () => [
      { pid: 100, ppid: 50, uid: 1_000, startIdentity: '1000', command: 'node cod-374-quiescence' },
      { pid: 50, ppid: 1, uid: 1_000, startIdentity: '500', command: 'bash' },
    ]);
    return {
      currentUid: () => 1_000,
      cpuCount: () => 8,
      monotonicNow: () => now,
      delay: vi.fn(async (ms: number) => {
        now += ms;
      }),
      readCpuStat: vi.fn(async () => {
        const value = cpuRead++ * 10;
        return `cpu ${value} 0 0 ${value * 4} 0 0 0 0\n`;
      }),
      load1: vi.fn(() => 1),
      ancestorPids: vi.fn(async () => [
        { pid: 100, startIdentity: '1000' },
        { pid: 50, startIdentity: '500' },
      ]),
      inventory,
      ...overrides,
    };
  }

  it('samples the host exactly 11 times across 10 fixed delays and inventories only the boundaries', async () => {
    const adapters = samplerAdapters();
    const result = await measureHostQuiescence({ currentPid: 100, adapters });

    expect(adapters.readCpuStat).toHaveBeenCalledTimes(11);
    expect(adapters.delay).toHaveBeenCalledTimes(10);
    expect(adapters.delay).toHaveBeenCalledWith(500);
    expect(adapters.load1).toHaveBeenCalledTimes(2);
    expect(adapters.inventory).toHaveBeenCalledTimes(2);
    expect(result).toEqual(
      hostEvidence({
        startedAtMs: 1_000,
        endedAtMs: 6_000,
        firstLoad1: 1,
        finalLoad1: 1,
        processes: [
          {
            classification: 'allowed-ancestor',
            commandHash: hash16('node cod-374-quiescence'),
            startIdentity: '1000',
            allowedAncestor: true,
          },
          {
            classification: 'allowed-ancestor',
            commandHash: hash16('bash'),
            startIdentity: '500',
            allowedAncestor: true,
          },
        ],
      })
    );
  });

  it('fails closed with a safe hash on malformed /proc counters without retrying', async () => {
    const secret = 'malformed /proc/stat at /secret/path';
    const adapters = samplerAdapters({ readCpuStat: vi.fn(async () => secret) });
    const result = await measureHostQuiescence({ currentPid: 100, adapters });

    expect(adapters.readCpuStat).toHaveBeenCalledTimes(1);
    expect(result.passed).toBe(false);
    expect(result.measurementErrorHash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain('/secret');
  });

  it('fails closed when a process disappears during either boundary inventory and does not retry', async () => {
    const inventory = vi.fn().mockRejectedValueOnce(new Error('ENOENT /proc/777')).mockResolvedValueOnce([]);
    const adapters = samplerAdapters({ inventory });
    const result = await measureHostQuiescence({ currentPid: 100, adapters });

    expect(inventory).toHaveBeenCalledTimes(1);
    expect(result.passed).toBe(false);
    expect(result.measurementErrorHash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(result)).not.toContain('/proc/777');
  });

  it('fails closed on final-boundary inventory disappearance without a third inventory retry', async () => {
    const first = [
      { pid: 100, ppid: 50, uid: 1_000, startIdentity: '1000', command: 'node host-gate' },
      { pid: 50, ppid: 1, uid: 1_000, startIdentity: '500', command: 'bash' },
    ];
    const inventory = vi.fn().mockResolvedValueOnce(first).mockRejectedValueOnce(new Error('ENOENT /proc/888'));
    const adapters = samplerAdapters({ inventory });
    const result = await measureHostQuiescence({ currentPid: 100, adapters });

    expect(inventory).toHaveBeenCalledTimes(2);
    expect(result.passed).toBe(false);
    expect(result.measurementErrorHash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(result)).not.toContain('/proc/888');
  });

  it.each(['first', 'final'])(
    'retains a disappeared conflict at the %s inventory boundary without retry',
    async (boundary) => {
      const ancestors = [
        { pid: 100, ppid: 50, uid: 1_000, startIdentity: '1000', command: 'node host-gate' },
        { pid: 50, ppid: 1, uid: 1_000, startIdentity: '500', command: 'bash' },
      ];
      const disappeared = {
        pid: 777,
        ppid: 0,
        uid: 1_000,
        startIdentity: '0',
        command: 'disappeared:777',
        disappeared: true as const,
      };
      const inventory = vi
        .fn()
        .mockResolvedValueOnce(boundary === 'first' ? [...ancestors, disappeared] : ancestors)
        .mockResolvedValueOnce(boundary === 'final' ? [...ancestors, disappeared] : ancestors);
      const adapters = samplerAdapters({ inventory });

      await expect(measureHostQuiescence({ currentPid: 100, adapters })).rejects.toMatchObject({
        message: 'COD-374 host is not quiescent',
        evidence: {
          sampleCount: 11,
          measurementErrorHash: null,
          passed: false,
          processes: expect.arrayContaining([
            expect.objectContaining({ classification: 'disappeared', startIdentity: '0', allowedAncestor: false }),
          ]),
        },
      });
      expect(inventory).toHaveBeenCalledTimes(2);
    }
  );

  it('classifies first and final observations before deduping a reused process identity', async () => {
    const benign = { pid: 777, ppid: 1, uid: 1_000, startIdentity: '7770', command: 'node harmless-worker.js' };
    const conflicting = {
      pid: 777,
      ppid: 1,
      uid: 1_000,
      startIdentity: '7770',
      command: 'node vitest run final-boundary.test.ts',
    };
    const ancestors = [
      { pid: 100, ppid: 50, uid: 1_000, startIdentity: '1000', command: 'node host-gate' },
      { pid: 50, ppid: 1, uid: 1_000, startIdentity: '500', command: 'bash' },
    ];
    const inventory = vi
      .fn()
      .mockResolvedValueOnce([...ancestors, benign])
      .mockResolvedValueOnce([...ancestors, conflicting]);
    const adapters = samplerAdapters({ inventory });

    await expect(measureHostQuiescence({ currentPid: 100, adapters })).rejects.toMatchObject({
      message: 'COD-374 host is not quiescent',
      evidence: {
        passed: false,
        processes: expect.arrayContaining([
          {
            classification: 'vitest',
            commandHash: hash16(conflicting.command),
            startIdentity: '7770',
            allowedAncestor: false,
          },
        ]),
      },
    });
  });

  it('does not retroactively associate first-boundary Chrome with a final-boundary reused Playwright PID', async () => {
    const ancestors = [
      { pid: 100, ppid: 50, uid: 1_000, startIdentity: '1000', command: 'node host-gate' },
      { pid: 50, ppid: 1, uid: 1_000, startIdentity: '500', command: 'bash' },
    ];
    const firstChrome = {
      pid: 400,
      ppid: 300,
      uid: 1_000,
      startIdentity: '4000',
      command: '/usr/bin/google-chrome --headless',
    };
    const inventory = vi
      .fn()
      .mockResolvedValueOnce([
        ...ancestors,
        { pid: 300, ppid: 1, uid: 1_000, startIdentity: '3000', command: 'node harmless-parent.js' },
        firstChrome,
      ])
      .mockResolvedValueOnce([
        ...ancestors,
        {
          pid: 300,
          ppid: 1,
          uid: 1_000,
          startIdentity: '3001',
          command: 'node node_modules/@playwright/test/cli.js test final.test.ts',
        },
      ]);
    const adapters = samplerAdapters({ inventory });

    try {
      await measureHostQuiescence({ currentPid: 100, adapters });
      throw new Error('expected host rejection');
    } catch (error) {
      expect(error).toMatchObject({ message: 'COD-374 host is not quiescent' });
      const evidence = (error as { evidence: ReturnType<typeof hostEvidence> }).evidence;
      expect(evidence.processes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ classification: 'playwright-runner', startIdentity: '3001' }),
        ])
      );
      expect(evidence.processes).not.toContainEqual({
        classification: 'associated-chromium',
        commandHash: hash16(firstChrome.command),
        startIdentity: '4000',
        allowedAncestor: false,
      });
    }
  });

  it('does not mistake an adapter error message for a derived host threshold result', async () => {
    const readCpuStat = vi.fn(async () => {
      throw new Error('COD-374 host is not quiescent');
    });
    const adapters = samplerAdapters({ readCpuStat });
    const result = await measureHostQuiescence({ currentPid: 100, adapters });

    expect(readCpuStat).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ passed: false, sampleCount: 0, sampleTimesMs: [] });
    expect(result.measurementErrorHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('normalizes adversarial CPU and clock values into schema-valid failed evidence', async () => {
    const adapters = samplerAdapters({
      cpuCount: () => 1_000_000,
      monotonicNow: () => Number.MAX_VALUE,
      ancestorPids: vi.fn(async () => {
        throw new Error('preflight failed');
      }),
    });
    const result = await measureHostQuiescence({ currentPid: 100, adapters });
    expect(result).toMatchObject({ cpuCount: 1, startedAtMs: 0, endedAtMs: 0, passed: false });
    expect(validatePersistedHostQuiescence(result)).toEqual(result);
  });

  it('attaches bounded measured evidence when an unrelated process makes the host non-quiescent', async () => {
    const secretCommand = 'node vitest run /secret/cod374.test.ts --token=private';
    const inventory = vi.fn(async () => [
      { pid: 100, ppid: 50, uid: 1_000, startIdentity: '1000', command: 'node host-gate' },
      { pid: 50, ppid: 1, uid: 1_000, startIdentity: '500', command: 'bash' },
      { pid: 777, ppid: 1, uid: 1_000, startIdentity: '7770', command: secretCommand },
    ]);
    const adapters = samplerAdapters({ inventory });

    await expect(measureHostQuiescence({ currentPid: 100, adapters })).rejects.toMatchObject({
      message: 'COD-374 host is not quiescent',
      evidence: {
        passed: false,
        measurementErrorHash: null,
        processes: expect.arrayContaining([
          {
            classification: 'vitest',
            commandHash: hash16(secretCommand),
            startIdentity: '7770',
            allowedAncestor: false,
          },
        ]),
      },
    });
    try {
      await measureHostQuiescence({ currentPid: 100, adapters: samplerAdapters({ inventory }) });
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain('/secret');
      expect(JSON.stringify(error)).not.toContain('--token');
    }
  });
});
