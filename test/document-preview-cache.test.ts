import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { clearDocumentPreviewCache, getOfficePreviewPdfPath } from '../src/document-preview-cache.js';

vi.mock('node:child_process', () => ({
  execFile: vi.fn((_cmd, _args, _options, callback) => {
    setTimeout(() => callback(null, { stdout: '', stderr: '' }), 1);
    return {};
  }),
}));

vi.mock('node:fs/promises', () => ({
  default: {
    stat: vi.fn(),
    mkdir: vi.fn(async () => undefined),
    mkdtemp: vi.fn(async () => '/tmp/codeman-document-preview-cache/work-test'),
    readdir: vi.fn(async () => ['deck.pdf']),
    rename: vi.fn(async () => undefined),
    rm: vi.fn(async () => undefined),
  },
}));

const mockedExecFile = vi.mocked(execFile);
const mockedStat = vi.mocked(fs.stat);
const mockedRename = vi.mocked(fs.rename);

describe('document-preview-cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearDocumentPreviewCache();

    let cachedPdfExists = false;
    mockedStat.mockImplementation(async (path) => {
      const pathText = String(path);
      if (pathText.includes('codeman-document-preview-cache') && pathText.endsWith('.pdf')) {
        if (!cachedPdfExists) throw new Error('ENOENT');
        return { size: 4096, isFile: () => true } as never;
      }

      return { size: 1845494, mtimeMs: 12345, isFile: () => true } as never;
    });
    mockedRename.mockImplementation(async () => {
      cachedPdfExists = true;
    });
  });

  it('deduplicates concurrent Office preview conversions and reuses the cached PDF', async () => {
    const [firstPath, secondPath] = await Promise.all([
      getOfficePreviewPdfPath('/tmp/deck.pptx', 'pptx'),
      getOfficePreviewPdfPath('/tmp/deck.pptx', 'pptx'),
    ]);
    const thirdPath = await getOfficePreviewPdfPath('/tmp/deck.pptx', 'pptx');

    expect(firstPath).toBeTruthy();
    expect(secondPath).toBe(firstPath);
    expect(thirdPath).toBe(firstPath);
    expect(mockedExecFile).toHaveBeenCalledTimes(1);
    expect(mockedExecFile).toHaveBeenCalledWith(
      'soffice',
      expect.arrayContaining([
        '--headless',
        '--convert-to',
        'pdf',
        expect.stringMatching(/^-env:UserInstallation=file:/),
      ]),
      expect.any(Object),
      expect.any(Function)
    );
  });
});
