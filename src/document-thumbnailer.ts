/**
 * @fileoverview Best-effort first-page thumbnails for attachment cards.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_THUMBNAIL_SOURCE_SIZE = 50 * 1024 * 1024;

export interface ThumbnailResult {
  content: Buffer;
  contentType: 'image/png';
}

export async function generateFirstPageThumbnail(filePath: string, extension: string): Promise<ThumbnailResult | null> {
  const ext = extension.toLowerCase().replace(/^\./, '');

  try {
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_THUMBNAIL_SOURCE_SIZE) return null;

    if (ext === 'png') {
      return { content: await fs.readFile(filePath), contentType: 'image/png' };
    }

    if (ext === 'pdf') {
      return renderPdfFirstPage(filePath);
    }

    if (ext === 'docx' || ext === 'pptx') {
      return renderOfficeFirstPage(filePath);
    }
  } catch {
    return null;
  }

  return null;
}

async function renderOfficeFirstPage(filePath: string): Promise<ThumbnailResult | null> {
  let previewDir: string | undefined;
  try {
    previewDir = await fs.mkdtemp(join(tmpdir(), 'codeman-thumb-office-'));
    await execFileAsync('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', previewDir, filePath], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });

    const converted = (await fs.readdir(previewDir)).find((name) => name.toLowerCase().endsWith('.pdf'));
    if (!converted) return null;
    return renderPdfFirstPage(join(previewDir, converted));
  } catch {
    return null;
  } finally {
    if (previewDir) {
      await fs.rm(previewDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function renderPdfFirstPage(filePath: string): Promise<ThumbnailResult | null> {
  let previewDir: string | undefined;
  try {
    previewDir = await fs.mkdtemp(join(tmpdir(), 'codeman-thumb-pdf-'));
    const prefix = join(previewDir, basename(filePath, extname(filePath)));
    await execFileAsync(
      'pdftoppm',
      ['-png', '-singlefile', '-f', '1', '-l', '1', '-scale-to', '520', filePath, prefix],
      {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      }
    );
    const content = await fs.readFile(`${prefix}.png`);
    return { content, contentType: 'image/png' };
  } catch {
    return null;
  } finally {
    if (previewDir) {
      await fs.rm(previewDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
