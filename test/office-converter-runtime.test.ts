/**
 * @fileoverview Tests for the office-converter capability probe (COD-426).
 *
 * The spawn boundary is injected, so nothing here needs a real LibreOffice.
 * The load-bearing property is that success is decided by "a .pdf appeared",
 * NEVER by the exit code: LibreOffice exits 0 while printing
 * `Error: source file could not be loaded` and producing nothing.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import {
  OFFICE_CONVERTER_BIN_ENV,
  OFFICE_PROBE_FAILURE_TTL_MS,
  OFFICE_PROBE_SUCCESS_TTL_MS,
} from '../src/config/office-converter.js';
import {
  probeOfficeConverter,
  resolveOfficeConverterBin,
  resetOfficeConverterProbeCache,
  type OfficeConverterProbeIo,
} from '../src/office-converter-runtime.js';

interface FakeIo extends OfficeConverterProbeIo {
  runs: Array<{ bin: string; args: string[] }>;
  whichCalls: string[];
  limitDepth: number[];
}

function outDirOf(args: readonly string[]): string {
  const i = args.indexOf('--outdir');
  return args[i + 1] ?? '';
}

function makeIo(overrides: Partial<OfficeConverterProbeIo> & { produce?: boolean; throws?: Error } = {}): FakeIo {
  const runs: Array<{ bin: string; args: string[] }> = [];
  const whichCalls: string[] = [];
  const limitDepth: number[] = [];
  let depth = 0;
  const io: FakeIo = {
    runs,
    whichCalls,
    limitDepth,
    env: {},
    now: () => Date.now(),
    async which(bin: string) {
      whichCalls.push(bin);
      return bin === 'soffice' ? '/usr/bin/soffice' : null;
    },
    async fileExists() {
      return true;
    },
    async run(bin: string, args: readonly string[]) {
      runs.push({ bin, args: [...args] });
      if (overrides.throws) throw overrides.throws;
      if (overrides.produce !== false) {
        await fs.writeFile(join(outDirOf(args), 'probe.pdf'), '%PDF-1.4\n');
      }
    },
    async withLimit<T>(task: () => Promise<T>): Promise<T> {
      depth++;
      limitDepth.push(depth);
      try {
        return await task();
      } finally {
        depth--;
      }
    },
  };
  const { produce: _p, throws: _t, ...rest } = overrides;
  return Object.assign(io, rest);
}

beforeEach(() => {
  resetOfficeConverterProbeCache();
});

describe('resolveOfficeConverterBin', () => {
  it('tries the shared candidate list in order and returns the first hit', async () => {
    const io = makeIo();
    await expect(resolveOfficeConverterBin(io)).resolves.toBe('/usr/bin/soffice');
    expect(io.whichCalls).toEqual(['libreoffice', 'soffice']);
  });

  it('uses an absolute override verbatim when it exists', async () => {
    const io = makeIo({ env: { [OFFICE_CONVERTER_BIN_ENV]: '/opt/lo/program/soffice' } });
    await expect(resolveOfficeConverterBin(io)).resolves.toBe('/opt/lo/program/soffice');
    expect(io.whichCalls).toEqual([]);
  });

  it('does not fall back to the default list when the override is missing', async () => {
    const io = makeIo({
      env: { [OFFICE_CONVERTER_BIN_ENV]: '/nope/soffice' },
      fileExists: async () => false,
    });
    await expect(resolveOfficeConverterBin(io)).resolves.toBeNull();
    expect(io.whichCalls).toEqual([]);
  });

  it('returns null when nothing resolves', async () => {
    const io = makeIo({ which: async () => null });
    await expect(resolveOfficeConverterBin(io)).resolves.toBeNull();
  });
});

describe('probeOfficeConverter', () => {
  it('is usable when the resolved binary produces a PDF', async () => {
    const io = makeIo();
    const verdict = await probeOfficeConverter(io);
    expect(verdict.usable).toBe(true);
    expect(verdict.bin).toBe('/usr/bin/soffice');
    expect(io.runs).toHaveLength(1);
    const { bin, args } = io.runs[0]!;
    expect(bin).toBe('/usr/bin/soffice');
    expect(args.slice(0, 3)).toEqual(['--headless', '--nologo', '--nofirststartwizard']);
    expect(args.some((a) => a.startsWith('-env:UserInstallation=file://'))).toBe(true);
    expect(args).toContain('--convert-to');
    expect(args).toContain('pdf');
    expect(args).toContain('--outdir');
  });

  it('is UNUSABLE when the converter exits 0 but produces no PDF', async () => {
    const io = makeIo({ produce: false });
    const verdict = await probeOfficeConverter(io);
    expect(verdict.usable).toBe(false);
    if (verdict.usable) throw new Error('unreachable');
    expect(verdict.reason).toContain('/usr/bin/soffice');
    expect(verdict.reason).toContain(OFFICE_CONVERTER_BIN_ENV);
  });

  it('is unusable when the spawn itself fails or times out', async () => {
    const io = makeIo({ throws: new Error('spawn ETIMEDOUT') });
    const verdict = await probeOfficeConverter(io);
    expect(verdict.usable).toBe(false);
    if (verdict.usable) throw new Error('unreachable');
    expect(verdict.reason).toContain('ETIMEDOUT');
  });

  it('reports missing (with the candidates tried) when nothing resolves', async () => {
    const io = makeIo({ which: async () => null });
    const verdict = await probeOfficeConverter(io);
    expect(verdict.usable).toBe(false);
    if (verdict.usable) throw new Error('unreachable');
    expect(verdict.bin).toBeNull();
    expect(verdict.reason).toContain('libreoffice');
    expect(verdict.reason).toContain('soffice');
    expect(io.runs).toHaveLength(0);
  });

  it('leaves no probe fixtures behind', async () => {
    const io = makeIo();
    await probeOfficeConverter(io);
    const outDir = outDirOf(io.runs[0]!.args);
    await expect(fs.stat(outDir)).rejects.toThrow();
  });

  it('takes exactly one conversion-limiter slot, never nested', async () => {
    const io = makeIo();
    await probeOfficeConverter(io);
    expect(io.limitDepth).toEqual([1]);
  });

  it('caches the verdict and re-uses it within the TTL', async () => {
    const io = makeIo();
    await probeOfficeConverter(io);
    await probeOfficeConverter(io);
    await probeOfficeConverter(io);
    expect(io.runs).toHaveLength(1);
  });

  it('re-probes a FAILURE after the shorter failure TTL', async () => {
    let now = 1_000_000;
    const io = makeIo({ produce: false, now: () => now });
    await probeOfficeConverter(io);
    now += OFFICE_PROBE_FAILURE_TTL_MS - 1;
    await probeOfficeConverter(io);
    expect(io.runs).toHaveLength(1);
    now += 2;
    await probeOfficeConverter(io);
    expect(io.runs).toHaveLength(2);
  });

  it('holds a SUCCESS far longer than a failure', async () => {
    let now = 1_000_000;
    const io = makeIo({ now: () => now });
    await probeOfficeConverter(io);
    now += OFFICE_PROBE_FAILURE_TTL_MS + 1;
    await probeOfficeConverter(io);
    expect(io.runs).toHaveLength(1);
    now += OFFICE_PROBE_SUCCESS_TTL_MS;
    await probeOfficeConverter(io);
    expect(io.runs).toHaveLength(2);
  });

  it('shares one in-flight probe across concurrent callers', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const io = makeIo();
    const slowRun = io.run.bind(io);
    io.run = async (bin, args) => {
      await gate;
      await slowRun(bin, args);
    };
    const all = Promise.all([probeOfficeConverter(io), probeOfficeConverter(io), probeOfficeConverter(io)]);
    release?.();
    const verdicts = await all;
    expect(io.runs).toHaveLength(1);
    expect(verdicts.every((v) => v.usable)).toBe(true);
  });

  it('resetOfficeConverterProbeCache forces a fresh probe', async () => {
    const io = makeIo();
    await probeOfficeConverter(io);
    resetOfficeConverterProbeCache();
    await probeOfficeConverter(io);
    expect(io.runs).toHaveLength(2);
  });
});
