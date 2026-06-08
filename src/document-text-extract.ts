/**
 * @fileoverview Extract diffable plain/markdown text from a document (COD-66).
 *
 * Used by the document revision-history feature to diff prose across versions.
 * Plain-text formats are read directly; `.docx` is converted to markdown via
 * pandoc so the existing word-diff can run on its prose content.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';

const execFileAsync = promisify(execFile);
const PANDOC_TIMEOUT_MS = 30_000;
const PANDOC_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Return the diffable text content of a document, or '' for formats we don't
 * extract. md/txt are read as UTF-8; docx is converted to markdown via pandoc.
 */
export async function extractDocumentText(filePath: string, extension: string): Promise<string> {
  const ext = extension.toLowerCase().replace(/^\./, '');
  if (ext === 'md' || ext === 'txt') {
    return fs.readFile(filePath, 'utf-8');
  }
  if (ext === 'docx') {
    const { stdout } = await execFileAsync('pandoc', ['-f', 'docx', '-t', 'markdown', '--wrap=none', filePath], {
      timeout: PANDOC_TIMEOUT_MS,
      maxBuffer: PANDOC_MAX_BUFFER,
    });
    return stdout;
  }
  return '';
}

/** True when a document extension supports text-based revision diffing. */
export function isDiffableDocExtension(extension: string): boolean {
  const ext = extension.toLowerCase().replace(/^\./, '');
  return ext === 'md' || ext === 'txt' || ext === 'docx';
}

/** True when the document is stored as raw bytes (binary) rather than text. */
export function isBinaryDocExtension(extension: string): boolean {
  return extension.toLowerCase().replace(/^\./, '') === 'docx';
}
