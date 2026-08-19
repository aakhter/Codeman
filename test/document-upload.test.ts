/**
 * @fileoverview Unit tests for the pure document-upload validator (COD-241 unit 1).
 *
 * Uses app.inject()-free, node/vm-safe pure-function tests (no jsdom).
 * Port: N/A (no server).
 */

import { describe, it, expect } from 'vitest';
import {
  UPLOAD_ALLOWED_EXTENSIONS,
  isAllowedUploadExtension,
  documentMagicMatchesExt,
  sanitizeUploadFilename,
} from '../src/web/document-upload.js';

describe('UPLOAD_ALLOWED_EXTENSIONS', () => {
  it('contains exactly the supported document extensions', () => {
    expect([...UPLOAD_ALLOWED_EXTENSIONS].sort()).toEqual(
      [
        'docx',
        'markdown',
        'md',
        'pdf',
        'pptx',
        'txt',
        'xlsx',
        'py',
        'js',
        'ts',
        'jsx',
        'tsx',
        'json',
        'yaml',
        'yml',
        'toml',
        'ini',
        'cfg',
        'conf',
        'sh',
        'bash',
        'zsh',
        'go',
        'rs',
        'java',
        'c',
        'cpp',
        'h',
        'hpp',
        'cs',
        'rb',
        'php',
        'swift',
        'kt',
        'scala',
        'sql',
        'html',
        'css',
        'csv',
        'png',
        'jpg',
        'jpeg',
        'gif',
        'webp',
        'bmp',
      ].sort()
    );
  });
});

describe('isAllowedUploadExtension', () => {
  it('accepts allowed extensions case-insensitively', () => {
    for (const ext of [
      'pdf',
      'PDF',
      'docx',
      'Pptx',
      'xlsx',
      'XLSX',
      'md',
      'markdown',
      'txt',
      'py',
      'PY',
      'js',
      'JS',
      'ts',
      'json',
      'yaml',
      'html',
      'css',
      'csv',
      'png',
      'PNG',
      'jpg',
      'JPG',
      'jpeg',
      'gif',
      'webp',
      'bmp',
    ]) {
      expect(isAllowedUploadExtension(ext)).toBe(true);
    }
  });

  it('tolerates a leading dot', () => {
    expect(isAllowedUploadExtension('.pdf')).toBe(true);
    expect(isAllowedUploadExtension('.TXT')).toBe(true);
    expect(isAllowedUploadExtension('.XLSX')).toBe(true);
  });

  it('rejects unsupported / unknown extensions', () => {
    for (const ext of ['exe', 'zip', 'doc', 'ppt', 'xls', '']) {
      expect(isAllowedUploadExtension(ext)).toBe(false);
    }
  });
});

describe('documentMagicMatchesExt', () => {
  it('accepts a valid PDF header', () => {
    const pdf = Buffer.from('%PDF-1.4\n%âãÏÓ\n', 'latin1');
    expect(documentMagicMatchesExt(pdf, 'pdf')).toBe(true);
  });

  it('rejects a PDF ext when bytes are not %PDF-', () => {
    expect(documentMagicMatchesExt(Buffer.from('not a pdf'), 'pdf')).toBe(false);
    // %PDF without the trailing dash is not accepted.
    expect(documentMagicMatchesExt(Buffer.from('%PDF1.4'), 'pdf')).toBe(false);
  });

  it('accepts docx/pptx/xlsx with the ZIP local-file-header magic PK\\x03\\x04', () => {
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
    expect(documentMagicMatchesExt(zip, 'docx')).toBe(true);
    expect(documentMagicMatchesExt(zip, 'pptx')).toBe(true);
    expect(documentMagicMatchesExt(zip, 'xlsx')).toBe(true);
  });

  it('accepts the empty-archive (PK\\x05\\x06) and spanned (PK\\x07\\x08) ZIP variants', () => {
    const empty = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
    const spanned = Buffer.from([0x50, 0x4b, 0x07, 0x08]);
    expect(documentMagicMatchesExt(empty, 'docx')).toBe(true);
    expect(documentMagicMatchesExt(spanned, 'pptx')).toBe(true);
    expect(documentMagicMatchesExt(empty, 'xlsx')).toBe(true);
    expect(documentMagicMatchesExt(spanned, 'xlsx')).toBe(true);
  });

  it('rejects docx/pptx/xlsx when the bytes are not a ZIP header', () => {
    expect(documentMagicMatchesExt(Buffer.from('%PDF-1.4'), 'docx')).toBe(false);
    expect(documentMagicMatchesExt(Buffer.from('plain text'), 'pptx')).toBe(false);
    expect(documentMagicMatchesExt(Buffer.from('not a zip'), 'xlsx')).toBe(false);
  });

  it('accepts md/markdown/txt for plain text (no NUL byte in first 8KB)', () => {
    const text = Buffer.from('# Heading\n\nSome markdown text.\n');
    expect(documentMagicMatchesExt(text, 'md')).toBe(true);
    expect(documentMagicMatchesExt(text, 'markdown')).toBe(true);
    expect(documentMagicMatchesExt(text, 'txt')).toBe(true);
  });

  it('accepts empty text buffers (no NUL present)', () => {
    expect(documentMagicMatchesExt(Buffer.alloc(0), 'txt')).toBe(true);
  });

  it('rejects md/markdown/txt when a NUL byte appears in the first 8KB', () => {
    const binary = Buffer.from([0x68, 0x69, 0x00, 0x74, 0x68, 0x65, 0x72, 0x65]);
    expect(documentMagicMatchesExt(binary, 'txt')).toBe(false);
    expect(documentMagicMatchesExt(binary, 'md')).toBe(false);
  });

  it('only sniffs the first 8KB for a NUL byte (a NUL past 8KB is ignored)', () => {
    const big = Buffer.concat([Buffer.alloc(8 * 1024, 0x41), Buffer.from([0x00])]);
    expect(documentMagicMatchesExt(big, 'txt')).toBe(true);
  });

  it('returns false for an unknown extension regardless of bytes', () => {
    expect(documentMagicMatchesExt(Buffer.from('%PDF-1.4'), 'exe')).toBe(false);
    expect(documentMagicMatchesExt(Buffer.from('anything'), '')).toBe(false);
  });
});

describe('sanitizeUploadFilename', () => {
  it('strips directory components / traversal, keeping the basename', () => {
    expect(sanitizeUploadFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeUploadFilename('/abs/path/report.pdf')).toBe('report.pdf');
    expect(sanitizeUploadFilename('C:\\Users\\me\\deck.pptx')).toBe('deck.pptx');
    expect(sanitizeUploadFilename('sub/dir/notes.md')).toBe('notes.md');
  });

  it('falls back to "file" for empty / dot-only / whitespace names', () => {
    expect(sanitizeUploadFilename('')).toBe('file');
    expect(sanitizeUploadFilename('   ')).toBe('file');
    expect(sanitizeUploadFilename('.')).toBe('file');
    expect(sanitizeUploadFilename('..')).toBe('file');
    expect(sanitizeUploadFilename('/')).toBe('file');
  });

  it('strips control characters and path separators from the name', () => {
    expect(sanitizeUploadFilename('re\x00port\x1f.pdf')).toBe('report.pdf');
    expect(sanitizeUploadFilename('a\tb\nc.txt')).not.toMatch(/[\t\n]/);
  });

  it('prefixes reserved Windows device names so they are not left bare', () => {
    for (const name of ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM9', 'LPT1', 'LPT9', 'con.txt', 'lpt3.pdf']) {
      const out = sanitizeUploadFilename(name);
      expect(out).not.toMatch(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i);
      expect(out.length).toBeGreaterThan(0);
    }
  });

  it('caps the length at 200 characters', () => {
    const long = 'a'.repeat(500) + '.pdf';
    const out = sanitizeUploadFilename(long);
    expect(out.length).toBeLessThanOrEqual(200);
  });

  it('preserves ordinary safe filenames unchanged', () => {
    expect(sanitizeUploadFilename('Quarterly Report 2026.pdf')).toBe('Quarterly Report 2026.pdf');
    expect(sanitizeUploadFilename('notes_v2-final.md')).toBe('notes_v2-final.md');
  });
});
