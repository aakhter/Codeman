/**
 * @fileoverview Shared disk cache for expensive Office document previews.
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const OFFICE_CONVERSION_TIMEOUT_MS = 5 * 60_000;
const DOCUMENT_PREVIEW_CACHE_DIR = join(tmpdir(), 'codeman-document-preview-cache');

const inFlightOfficeConversions = new Map<string, Promise<string | null>>();

export function clearDocumentPreviewCache(): void {
  inFlightOfficeConversions.clear();
}

export async function getOfficePreviewPdfPath(filePath: string, extension: string): Promise<string | null> {
  const ext = extension.toLowerCase().replace(/^\./, '');
  if (ext !== 'docx' && ext !== 'pptx') return null;

  let sourceStat;
  try {
    sourceStat = await fs.stat(filePath);
  } catch {
    return null;
  }

  const cacheKey = createDocumentPreviewCacheKey(filePath, ext, sourceStat.size, sourceStat.mtimeMs ?? 0);
  const cachePath = join(DOCUMENT_PREVIEW_CACHE_DIR, `${cacheKey}.pdf`);

  if (await fileExists(cachePath)) {
    return cachePath;
  }

  const inFlight = inFlightOfficeConversions.get(cacheKey);
  if (inFlight) return inFlight;

  const conversion = convertOfficeDocumentToCachedPdf(filePath, cachePath);
  inFlightOfficeConversions.set(cacheKey, conversion);
  try {
    return await conversion;
  } finally {
    inFlightOfficeConversions.delete(cacheKey);
  }
}

function createDocumentPreviewCacheKey(filePath: string, extension: string, size: number, mtimeMs: number): string {
  return createHash('sha256').update(JSON.stringify({ filePath, extension, size, mtimeMs })).digest('hex').slice(0, 32);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return typeof stat.isFile !== 'function' || stat.isFile();
  } catch {
    return false;
  }
}

async function convertOfficeDocumentToCachedPdf(filePath: string, cachePath: string): Promise<string | null> {
  let workDir: string | undefined;
  try {
    await fs.mkdir(DOCUMENT_PREVIEW_CACHE_DIR, { recursive: true });
    workDir = await fs.mkdtemp(join(DOCUMENT_PREVIEW_CACHE_DIR, 'work-'));
    const profileDir = join(workDir, 'profile');
    await fs.mkdir(profileDir, { recursive: true });

    await execFileAsync(
      'soffice',
      [
        '--headless',
        '--nologo',
        '--nofirststartwizard',
        `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
        '--convert-to',
        'pdf',
        '--outdir',
        workDir,
        filePath,
      ],
      {
        timeout: OFFICE_CONVERSION_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      }
    );

    const converted = (await fs.readdir(workDir)).find((name) => name.toLowerCase().endsWith('.pdf'));
    if (!converted) return null;

    await fs.rename(join(workDir, converted), cachePath);
    return cachePath;
  } catch (err) {
    console.warn(
      `[DocumentPreviewCache] Failed to convert Office file to PDF (${filePath}):`,
      getCacheErrorMessage(err)
    );
    return null;
  } finally {
    if (workDir) {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export function getPreviewPdfDownloadName(fileName: string, extension: string): string {
  return `${basename(fileName, extname(fileName) || `.${extension}`)}.pdf`;
}

function getCacheErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
