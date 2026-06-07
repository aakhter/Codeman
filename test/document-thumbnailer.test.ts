import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { generateFirstPageThumbnail } from '../src/document-thumbnailer.js';

vi.mock('node:child_process', () => ({
  execFile: vi.fn((_cmd, _args, _options, callback) => {
    callback(null, { stdout: '', stderr: '' });
    return {};
  }),
}));

vi.mock('node:fs/promises', () => ({
  default: {
    stat: vi.fn(async () => ({ size: 100, isFile: () => true })),
    readFile: vi.fn(async () => Buffer.from('png')),
    readdir: vi.fn(async () => ['converted.pdf']),
    mkdtemp: vi.fn(async () => '/tmp/codeman-thumb-test'),
    rm: vi.fn(async () => undefined),
  },
}));

const mockedExecFile = vi.mocked(execFile);
const mockedStat = vi.mocked(fs.stat);
const mockedReadFile = vi.mocked(fs.readFile);
const mockedReaddir = vi.mocked(fs.readdir);
const mockedMkdtemp = vi.mocked(fs.mkdtemp);
const mockedRm = vi.mocked(fs.rm);

describe('document-thumbnailer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedStat.mockResolvedValue({ size: 500 * 1024 * 1024, isFile: () => true } as never);
    mockedReadFile.mockResolvedValue(Buffer.from('large thumbnail') as never);
    mockedReaddir.mockResolvedValue(['converted.pdf'] as never);
    mockedMkdtemp.mockResolvedValue('/tmp/codeman-thumb-test' as never);
    mockedRm.mockResolvedValue(undefined as never);
    mockedExecFile.mockImplementation((_cmd, _args, _options, callback) => {
      callback(null, { stdout: '', stderr: '' });
      return {} as never;
    });
  });

  it('renders first-page thumbnails for large documents without an app-level size cap', async () => {
    const result = await generateFirstPageThumbnail('/tmp/large-deck.pdf', 'pdf');

    expect(result).toEqual({
      content: Buffer.from('large thumbnail'),
      contentType: 'image/png',
    });
    expect(mockedExecFile).toHaveBeenCalledWith(
      'pdftoppm',
      expect.arrayContaining(['-png', '-singlefile', '-f', '1', '-l', '1']),
      expect.any(Object),
      expect.any(Function)
    );
  });

  it('keeps the converted Office PDF until the first page thumbnail is rendered', async () => {
    let officePreviewDirRemoved = false;

    mockedMkdtemp.mockImplementation(async (prefix) =>
      String(prefix).includes('codeman-thumb-office-')
        ? '/tmp/codeman-thumb-office-test'
        : '/tmp/codeman-thumb-pdf-test'
    );
    mockedRm.mockImplementation(async (path) => {
      if (path === '/tmp/codeman-thumb-office-test') {
        officePreviewDirRemoved = true;
      }
    });
    mockedExecFile.mockImplementation((cmd, _args, _options, callback) => {
      if (cmd === 'pdftoppm' && officePreviewDirRemoved) {
        callback(new Error('converted PDF was removed before rasterization'));
        return {} as never;
      }

      callback(null, { stdout: '', stderr: '' });
      return {} as never;
    });

    const result = await generateFirstPageThumbnail('/tmp/deck.pptx', 'pptx');

    expect(result).toEqual({
      content: Buffer.from('large thumbnail'),
      contentType: 'image/png',
    });
  });
});
