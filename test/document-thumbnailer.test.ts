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
    mkdtemp: vi.fn(async () => '/tmp/codeman-thumb-test'),
    rm: vi.fn(async () => undefined),
  },
}));

const mockedExecFile = vi.mocked(execFile);
const mockedStat = vi.mocked(fs.stat);
const mockedReadFile = vi.mocked(fs.readFile);
const mockedMkdtemp = vi.mocked(fs.mkdtemp);
const mockedRm = vi.mocked(fs.rm);

describe('document-thumbnailer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedStat.mockResolvedValue({ size: 500 * 1024 * 1024, isFile: () => true } as never);
    mockedReadFile.mockResolvedValue(Buffer.from('large thumbnail') as never);
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
});
