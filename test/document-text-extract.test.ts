import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({
  default: { readFile: vi.fn() },
}));

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { convertDocxToHtml, extractDocumentText } from '../src/document-text-extract.js';

const mockedExecFile = vi.mocked(execFile);
const mockedReadFile = vi.mocked(fs.readFile);

describe('extractDocumentText', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads md/txt as UTF-8 without shelling out', async () => {
    mockedReadFile.mockResolvedValue('# hello\nworld' as never);
    await expect(extractDocumentText('/x/a.md', 'md')).resolves.toBe('# hello\nworld');
    await expect(extractDocumentText('/x/b.txt', 'txt')).resolves.toBe('# hello\nworld');
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it('extracts docx text via pandoc (docx -> markdown)', async () => {
    mockedExecFile.mockImplementation((_cmd, _args, _opts, cb: (e: unknown, r: unknown) => void) => {
      cb(null, { stdout: '# Title\n\nExtracted prose.', stderr: '' });
      return {} as never;
    });
    const text = await extractDocumentText('/x/brief.docx', 'docx');
    expect(text).toBe('# Title\n\nExtracted prose.');
    const [cmd, args] = mockedExecFile.mock.calls[0];
    expect(cmd).toBe('pandoc');
    expect(args).toEqual(expect.arrayContaining(['-f', 'docx', '-t', 'markdown', '/x/brief.docx']));
  });

  it('returns empty string for unsupported types', async () => {
    await expect(extractDocumentText('/x/img.png', 'png')).resolves.toBe('');
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it('preserves a Word red highlight as a safe CSS class in the HTML preview', async () => {
    mockedExecFile.mockImplementation((cmd, _args, _opts, cb: (e: unknown, r: unknown) => void) => {
      if (cmd === 'pandoc') {
        cb(null, { stdout: '<p>Keep <mark>this review cut</mark>.</p>', stderr: '' });
      } else {
        cb(null, {
          stdout:
            '<w:document><w:body><w:p><w:r><w:t>Keep </w:t></w:r>' +
            '<w:r><w:rPr><w:highlight w:val="red"/></w:rPr><w:t>this review</w:t></w:r>' +
            '<w:r><w:rPr><w:highlight w:val="red"/></w:rPr><w:commentReference w:id="0"/></w:r>' +
            '<w:r><w:rPr><w:highlight w:val="red"/></w:rPr><w:t> cut</w:t></w:r>' +
            '<w:r><w:t>.</w:t></w:r></w:p></w:body></w:document>',
          stderr: '',
        });
      }
      return {} as never;
    });

    await expect(convertDocxToHtml('/x/review.docx')).resolves.toBe(
      '<p>Keep <mark class="docx-highlight docx-highlight--red">this review cut</mark>.</p>'
    );

    expect(mockedExecFile).toHaveBeenCalledWith(
      'unzip',
      ['-p', '/x/review.docx', 'word/document.xml'],
      expect.objectContaining({ timeout: 30_000 }),
      expect.any(Function)
    );
  });

  it('renders Word comments as local inline inspectors and a visible review list', async () => {
    mockedExecFile.mockImplementation((cmd, args, _opts, cb: (e: unknown, r: unknown) => void) => {
      if (cmd === 'pandoc') {
        cb(null, { stdout: '<p>Keep <mark>this review cut</mark>.</p>', stderr: '' });
      } else if (args?.at(-1) === 'word/comments.xml') {
        cb(null, {
          stdout:
            '<w:comments><w:comment w:id="0" w:author="Aamer Akhter">' +
            '<w:p><w:r><w:t>Remove this cut.</w:t></w:r></w:p>' +
            '</w:comment></w:comments>',
          stderr: '',
        });
      } else {
        cb(null, {
          stdout:
            '<w:document><w:body><w:p><w:r><w:t>Keep </w:t></w:r>' +
            '<w:commentRangeStart w:id="0"/>' +
            '<w:r><w:rPr><w:highlight w:val="red"/></w:rPr><w:t>this review cut</w:t></w:r>' +
            '<w:commentRangeEnd w:id="0"/>' +
            '<w:r><w:t>.</w:t></w:r></w:p></w:body></w:document>',
          stderr: '',
        });
      }
      return {} as never;
    });

    const html = await convertDocxToHtml('/x/review.docx');

    expect(html).toContain('docx-comment-marker');
    expect(html).toContain('docx-comment-button');
    expect(html).toContain('aria-controls="docx-comment-card-0"');
    expect(html).toContain('class="docx-comment-card"');
    expect(html).toContain('hidden');
    expect(html).not.toContain('href="#docx-comment-0"');
    expect(html).toContain('<div class="docx-comments"');
    expect(html).toContain('Aamer Akhter');
    expect(html).toContain('Remove this cut.');
  });
});
