/**
 * @fileoverview PDF export for document previews (COD-61).
 *
 * One-click "Export PDF" of the open document. PDF is the only supported format
 * (DOCX/pandoc/templates are explicitly deferred). Two document classes:
 *
 *  - docx/pptx → reuse the existing LibreOffice→PDF preview cache
 *    (`getOfficePreviewPdfPath`). Pure reuse, no new conversion path.
 *  - markdown/text → render to HTML server-side (pandoc preferred, vendored
 *    `marked` as a fallback), then convert that HTML to PDF with the SAME
 *    `soffice --convert-to pdf` invocation used for the office preview cache.
 *
 * The pure pieces (format/type validation, the type→branch decision, and the
 * standalone-HTML wrapping) are split out so they can be unit-tested without
 * shelling out to soffice/pandoc.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { probeOfficeConverter } from './office-converter-runtime.js';

const execFileAsync = promisify(execFile);

const SOFFICE_TIMEOUT_MS = 5 * 60_000;
const PANDOC_TIMEOUT_MS = 30_000;
const PANDOC_MAX_BUFFER = 32 * 1024 * 1024;
const EXPORT_WORK_DIR = join(tmpdir(), 'codeman-document-export');

/** The only export format supported today (DOCX/templates are deferred). */
export type ExportFormat = 'pdf';

/** How the requested document maps onto an export pathway. */
export type ExportBranch = 'office' | 'text' | 'unsupported';

const OFFICE_EXTENSIONS = new Set(['docx', 'pptx']);
const TEXT_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'txt', 'text']);

function normalizeExtension(extension: string): string {
  return extension.toLowerCase().replace(/^\./, '');
}

/** True when `format` is an export format we currently support (pdf only). */
export function isSupportedExportFormat(format: string | undefined): format is ExportFormat {
  return (format ?? 'pdf').toLowerCase() === 'pdf';
}

/**
 * Decide which export pathway a document extension takes:
 *  - 'office' → reuse the LibreOffice preview-PDF cache (docx/pptx)
 *  - 'text'   → render md/markdown/txt to HTML, then HTML→PDF via soffice
 *  - 'unsupported' → anything else (caller returns 400)
 */
export function classifyExportBranch(extension: string): ExportBranch {
  const ext = normalizeExtension(extension);
  if (OFFICE_EXTENSIONS.has(ext)) return 'office';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  return 'unsupported';
}

/** True for the markdown family (vs. plain text), used to pick the renderer. */
function isMarkdownExtension(extension: string): boolean {
  const ext = normalizeExtension(extension);
  return ext === 'md' || ext === 'markdown' || ext === 'mdown';
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Wrap an HTML body fragment in a minimal standalone document with simple print
 * CSS (readable serif, sane margins, code/pre styling). The result is converted
 * to PDF locally by LibreOffice and never served to a browser, so XSS isn't the
 * risk here — escaping in the body fragment is enough; this just makes a
 * well-formed, printable document.
 */
export function wrapStandaloneHtml(bodyHtml: string, title: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  @page { margin: 2cm; }
  body { font-family: Georgia, 'Times New Roman', serif; font-size: 11pt; line-height: 1.5; color: #111; max-width: 40em; margin: 0 auto; }
  h1, h2, h3, h4, h5, h6 { font-family: 'Helvetica Neue', Arial, sans-serif; line-height: 1.25; margin: 1.2em 0 0.5em; }
  h1 { font-size: 1.8em; }
  h2 { font-size: 1.4em; }
  h3 { font-size: 1.2em; }
  p { margin: 0 0 0.8em; }
  pre, code { font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', monospace; font-size: 0.9em; }
  pre { background: #f5f5f5; padding: 0.8em 1em; border-radius: 4px; overflow-x: auto; white-space: pre-wrap; word-wrap: break-word; }
  code { background: #f5f5f5; padding: 0.1em 0.3em; border-radius: 3px; }
  pre code { background: none; padding: 0; }
  blockquote { margin: 0 0 0.8em; padding-left: 1em; border-left: 3px solid #ccc; color: #555; }
  table { border-collapse: collapse; margin: 0 0 0.8em; }
  th, td { border: 1px solid #ccc; padding: 0.3em 0.6em; }
  img { max-width: 100%; }
  a { color: #06c; }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>
`;
}

/**
 * Build a standalone, printable HTML document from raw markdown/text content.
 *
 * Plain text (txt/text) is HTML-escaped into a single <pre> so whitespace is
 * preserved. Markdown is rendered to an HTML fragment via the preference ladder
 * (pandoc, then vendored marked); if no renderer is available the markdown is
 * also escaped into a <pre> as a last resort and `renderer: 'none'` is reported
 * so the caller can decide whether that fidelity is acceptable.
 */
export async function buildTextExportHtml(
  content: string,
  extension: string,
  title: string
): Promise<{ html: string; renderer: 'pandoc' | 'marked' | 'plaintext' | 'none' }> {
  if (!isMarkdownExtension(extension)) {
    return { html: wrapStandaloneHtml(`<pre>${escapeHtml(content)}</pre>`, title), renderer: 'plaintext' };
  }

  const rendered = await renderMarkdownToHtmlFragment(content);
  if (rendered) {
    return { html: wrapStandaloneHtml(rendered.fragment, title), renderer: rendered.renderer };
  }
  // No markdown renderer available — fall back to escaped <pre> so the export
  // still works, but report it so the route/orchestrator can surface the gap.
  return { html: wrapStandaloneHtml(`<pre>${escapeHtml(content)}</pre>`, title), renderer: 'none' };
}

/**
 * Render markdown to an HTML fragment using the cleanest mechanism actually
 * available at runtime:
 *   1. pandoc (gfm → html) if on PATH — highest fidelity, already a runtime dep
 *      for the docx text/html paths (COD-66/68).
 *   2. the vendored `marked` UMD bundle, required from node.
 * Returns null when neither is usable.
 */
async function renderMarkdownToHtmlFragment(
  content: string
): Promise<{ fragment: string; renderer: 'pandoc' | 'marked' } | null> {
  const viaPandoc = await renderMarkdownViaPandoc(content);
  if (viaPandoc !== null) return { fragment: viaPandoc, renderer: 'pandoc' };

  const viaMarked = await renderMarkdownViaMarked(content);
  if (viaMarked !== null) return { fragment: viaMarked, renderer: 'marked' };

  return null;
}

async function renderMarkdownViaPandoc(content: string): Promise<string | null> {
  // Pass the markdown as a temp file rather than stdin: execFile's async form
  // has no `input` option (that's the *Sync variants), and spawning to pipe
  // stdin is more moving parts than a throwaway file.
  let mdPath: string | undefined;
  try {
    await fs.mkdir(EXPORT_WORK_DIR, { recursive: true });
    mdPath = join(EXPORT_WORK_DIR, `pandoc-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
    await fs.writeFile(mdPath, content, 'utf-8');
    const { stdout } = await execFileAsync('pandoc', ['-f', 'gfm', '-t', 'html', '--wrap=none', mdPath], {
      timeout: PANDOC_TIMEOUT_MS,
      maxBuffer: PANDOC_MAX_BUFFER,
    });
    return stdout;
  } catch {
    // pandoc not on PATH or conversion failed — fall through to the next renderer.
    return null;
  } finally {
    if (mdPath) await fs.rm(mdPath, { force: true }).catch(() => {});
  }
}

async function renderMarkdownViaMarked(content: string): Promise<string | null> {
  try {
    // The vendored UMD bundle has no type declarations and isn't part of the
    // TS program; import it dynamically with the type asserted below.
    // @ts-expect-error - vendored JS bundle, no declaration file
    const mod = (await import('./web/public/vendor/marked.min.js')) as unknown as {
      marked?: { parse?: (src: string) => string } | ((src: string) => string);
      parse?: (src: string) => string;
      default?: { marked?: { parse?: (src: string) => string }; parse?: (src: string) => string };
    };
    const parse =
      (typeof mod.marked === 'function' && mod.marked) ||
      (mod.marked && typeof mod.marked.parse === 'function' && mod.marked.parse.bind(mod.marked)) ||
      (typeof mod.parse === 'function' && mod.parse) ||
      (mod.default && typeof mod.default.parse === 'function' && mod.default.parse) ||
      (mod.default?.marked && typeof mod.default.marked.parse === 'function' && mod.default.marked.parse);
    if (!parse) return null;
    const out = (parse as (src: string) => string)(content);
    return typeof out === 'string' ? out : null;
  } catch {
    return null;
  }
}

/**
 * Convert a standalone HTML document to a PDF on disk via the same
 * `soffice --convert-to pdf` invocation the office preview cache uses. Writes
 * the HTML to a temp `.html` in an isolated work dir, runs soffice with a
 * throwaway profile, and returns the path to the produced `.pdf`. Returns null
 * when soffice produced no output. The caller owns cleanup of the returned PDF;
 * the work dir's HTML is removed here in a finally.
 *
 * NOTE: this is a deliberate sibling of
 * `convertLibreOfficeDocumentToCachedPdf` in document-preview-cache.ts — the
 * cache module converts office docs into a content-addressed cache, whereas
 * this converts an ephemeral HTML file for a one-shot download, so the soffice
 * invocation is shared in spirit but the surrounding lifecycle differs.
 */
export async function convertHtmlToPdf(html: string): Promise<string | null> {
  // COD-426: fail fast on an unusable converter instead of blocking for the
  // multi-minute conversion timeout. Kept outside any conversion-limiter slot
  // (the probe takes one of its own and the limiter is not re-entrant).
  const verdict = await probeOfficeConverter();
  if (!verdict.usable) {
    console.warn(`[DocumentPdfExport] Skipping HTML→PDF conversion: ${verdict.reason}`);
    return null;
  }

  let workDir: string | undefined;
  try {
    await fs.mkdir(EXPORT_WORK_DIR, { recursive: true });
    workDir = await fs.mkdtemp(join(EXPORT_WORK_DIR, 'work-'));
    const profileDir = join(workDir, 'profile');
    await fs.mkdir(profileDir, { recursive: true });
    const htmlPath = join(workDir, 'document.html');
    await fs.writeFile(htmlPath, html, 'utf-8');

    await execFileAsync(
      verdict.bin,
      [
        '--headless',
        '--nologo',
        '--nofirststartwizard',
        `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
        '--convert-to',
        'pdf',
        '--outdir',
        workDir,
        htmlPath,
      ],
      {
        timeout: SOFFICE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      }
    );

    const converted = (await fs.readdir(workDir)).find((name) => name.toLowerCase().endsWith('.pdf'));
    if (!converted) {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
      return null;
    }
    return join(workDir, converted);
  } catch (err) {
    if (workDir) await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    console.warn('[DocumentPdfExport] Failed to convert HTML to PDF:', err instanceof Error ? err.message : err);
    return null;
  }
}
