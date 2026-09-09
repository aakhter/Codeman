/**
 * @fileoverview COD-426: both LibreOffice call sites must consult the capability
 * probe BEFORE taking a conversion-limiter slot, and must spawn the RESOLVED
 * binary rather than the bare name `soffice`.
 *
 * The "before, never inside" ordering is load-bearing: `runWithConversionLimit`
 * is not re-entrant, so a probe that took its own slot from inside a held slot
 * would deadlock under a full pool.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { getActiveConversionCount } from '../src/document-conversion-limiter.js';

const limiterDepthAtProbe: number[] = [];
let verdict: { usable: boolean; bin: string | null; reason?: string } = { usable: true, bin: '/usr/bin/libreoffice' };

vi.mock('../src/office-converter-runtime.js', () => ({
  probeOfficeConverter: vi.fn(async () => {
    limiterDepthAtProbe.push(getActiveConversionCount());
    return verdict;
  }),
  resolveOfficeConverterBin: vi.fn(async () => verdict.bin),
  resetOfficeConverterProbeCache: vi.fn(),
  getCachedOfficeConverterVerdict: vi.fn(() => null),
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn((_cmd, _args, _options, callback) => {
    setTimeout(() => callback(null, { stdout: '', stderr: '' }), 1);
    return {};
  }),
}));

vi.mock('node:fs/promises', () => ({
  default: {
    stat: vi.fn(async () => ({ size: 10, mtimeMs: 1, isFile: () => true })),
    mkdir: vi.fn(async () => undefined),
    copyFile: vi.fn(async () => undefined),
    mkdtemp: vi.fn(async () => '/tmp/codeman-document-preview-cache/work-test'),
    readdir: vi.fn(async () => ['deck.pdf']),
    rename: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    rm: vi.fn(async () => undefined),
  },
}));

const { clearDocumentPreviewCache, getOfficePreviewPdfPath } = await import('../src/document-preview-cache.js');
const { convertHtmlToPdf } = await import('../src/document-pdf-export.js');
const { probeOfficeConverter } = await import('../src/office-converter-runtime.js');

const mockedExecFile = vi.mocked(execFile);

function sofficeCalls() {
  return mockedExecFile.mock.calls.filter(([cmd]) => String(cmd) !== 'powershell.exe');
}

beforeEach(() => {
  vi.clearAllMocks();
  limiterDepthAtProbe.length = 0;
  clearDocumentPreviewCache();
  verdict = { usable: true, bin: '/usr/bin/libreoffice' };
  vi.mocked(fs.stat).mockImplementation(async (path) => {
    const text = String(path);
    if (text.endsWith('.pdf')) throw new Error('ENOENT');
    return { size: 10, mtimeMs: 1, isFile: () => true } as never;
  });
});

describe('document preview conversion', () => {
  it('spawns the RESOLVED binary, not the bare name soffice', async () => {
    await getOfficePreviewPdfPath('/tmp/deck.pptx', 'pptx');
    expect(probeOfficeConverter).toHaveBeenCalled();
    expect(sofficeCalls()).toHaveLength(1);
    expect(sofficeCalls()[0]![0]).toBe('/usr/bin/libreoffice');
  });

  it('probes strictly BEFORE taking a limiter slot (the limiter is not re-entrant)', async () => {
    await getOfficePreviewPdfPath('/tmp/deck.pptx', 'pptx');
    expect(limiterDepthAtProbe).toEqual([0]);
    expect(getActiveConversionCount()).toBe(0);
  });

  it('fails fast without spawning when the converter is unusable', async () => {
    verdict = { usable: false, bin: '/usr/bin/libreoffice', reason: 'LibreOffice could not convert a test document.' };
    const result = await getOfficePreviewPdfPath('/tmp/deck.pptx', 'pptx');
    expect(result).toBeNull();
    expect(sofficeCalls()).toHaveLength(0);
  });
});

describe('HTML → PDF export', () => {
  it('spawns the resolved binary and probes outside any limiter slot', async () => {
    await convertHtmlToPdf('<html><body>hi</body></html>');
    expect(sofficeCalls()).toHaveLength(1);
    expect(sofficeCalls()[0]![0]).toBe('/usr/bin/libreoffice');
    expect(limiterDepthAtProbe).toEqual([0]);
  });

  it('fails fast without spawning when the converter is unusable', async () => {
    verdict = { usable: false, bin: null, reason: 'No LibreOffice converter found.' };
    await expect(convertHtmlToPdf('<html></html>')).resolves.toBeNull();
    expect(sofficeCalls()).toHaveLength(0);
  });
});
