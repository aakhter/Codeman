/**
 * @fileoverview Pure validators for the document-upload endpoint (COD-241 unit 1).
 *
 * Mirrors the paste-image byte-signature approach (`imageMagicMatchesExt` in
 * session-routes.ts): the multipart filename and Content-Type are both
 * attacker-controlled, the raw bytes are not, so we trust a magic prefix over
 * the declared type. This module is intentionally IO-free and node/vm-safe so it
 * can be unit-tested without a server or jsdom.
 *
 * Signatures: https://en.wikipedia.org/wiki/List_of_file_signatures
 */

/** Document extensions accepted by POST /api/sessions/:id/attachments/upload. */
export const UPLOAD_ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set([
  'pdf',
  'docx',
  'pptx',
  'xlsx',
  'md',
  'markdown',
  'txt',
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
]);

/** Normalize an extension: lowercase, strip a single leading dot. */
function normalizeExt(ext: string): string {
  return ext.toLowerCase().replace(/^\./, '');
}

/** True when `ext` (with or without a leading dot, any case) is uploadable. */
export function isAllowedUploadExtension(ext: string): boolean {
  return UPLOAD_ALLOWED_EXTENSIONS.has(normalizeExt(ext));
}

/** How far into a text buffer we sniff for a NUL byte (binary tell). */
const TEXT_SNIFF_BYTES = 8 * 1024;

/**
 * Byte-signature check: does `data` plausibly match the declared `ext`?
 *
 * - `pdf`  → begins with `%PDF-` (0x25 50 44 46 2D).
 * - `docx`/`pptx`/`xlsx` → OOXML is a ZIP; accept the ZIP local-file-header
 *   `PK\x03\x04`, plus the empty-archive `PK\x05\x06` and spanned
 *   `PK\x07\x08` variants. We do NOT crack the zip in unit 1 — a header match
 *   is sufficient and mirrors how paste-image trusts a magic prefix.
 * - `md`/`markdown`/`txt` → no reliable magic; reject only if a NUL byte
 *   appears in the first 8KB (a strong binary tell), else accept.
 * - unknown ext → false.
 */
export function documentMagicMatchesExt(data: Buffer, ext: string): boolean {
  const normalized = normalizeExt(ext);
  switch (normalized) {
    case 'pdf':
      return (
        data.length >= 5 &&
        data[0] === 0x25 &&
        data[1] === 0x50 &&
        data[2] === 0x44 &&
        data[3] === 0x46 &&
        data[4] === 0x2d
      );
    case 'docx':
    case 'pptx':
    case 'xlsx': {
      if (data.length < 4 || data[0] !== 0x50 || data[1] !== 0x4b) return false;
      // PK\x03\x04 (local file header), PK\x05\x06 (empty archive),
      // PK\x07\x08 (spanned archive).
      return (
        (data[2] === 0x03 && data[3] === 0x04) ||
        (data[2] === 0x05 && data[3] === 0x06) ||
        (data[2] === 0x07 && data[3] === 0x08)
      );
    }
    case 'md':
    case 'markdown':
    case 'txt':
    case 'py':
    case 'js':
    case 'ts':
    case 'jsx':
    case 'tsx':
    case 'json':
    case 'yaml':
    case 'yml':
    case 'toml':
    case 'ini':
    case 'cfg':
    case 'conf':
    case 'sh':
    case 'bash':
    case 'zsh':
    case 'go':
    case 'rs':
    case 'java':
    case 'c':
    case 'cpp':
    case 'h':
    case 'hpp':
    case 'cs':
    case 'rb':
    case 'php':
    case 'swift':
    case 'kt':
    case 'scala':
    case 'sql':
    case 'html':
    case 'css':
    case 'csv': {
      const end = Math.min(data.length, TEXT_SNIFF_BYTES);
      for (let i = 0; i < end; i++) {
        if (data[i] === 0x00) return false;
      }
      return true;
    }
    case 'png': {
      if (data.length < 8) return false;
      return data.readUInt32BE(0) === 0x89504e47 && data.readUInt32BE(4) === 0x0d0a1a0a;
    }
    case 'jpg':
    case 'jpeg': {
      return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    }
    case 'gif': {
      return (
        data.length >= 6 &&
        data[0] === 0x47 &&
        data[1] === 0x49 &&
        data[2] === 0x46 &&
        data[3] === 0x38 &&
        (data[4] === 0x37 || data[4] === 0x39) &&
        data[5] === 0x61
      );
    }
    case 'webp': {
      if (data.length < 12) return false;
      return data.readUInt32BE(0) === 0x52494646 && data.readUInt32BE(8) === 0x57454250;
    }
    case 'bmp': {
      return data.length >= 2 && data[0] === 0x42 && data[1] === 0x4d;
    }
    default:
      return false;
  }
}

/** Windows reserved device names (case-insensitive, with or without extension). */
const WINDOWS_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/** Max length of the returned display base name. */
const MAX_FILENAME_LENGTH = 200;

/**
 * Produce a display-safe base name from an attacker-supplied multipart filename.
 *
 * This is NOT the on-disk name (the route appends a random suffix) — it is the
 * human-facing `fileName` shown on the attachment card. It:
 *  - takes the basename only (strips any dir components / traversal, `/` and `\`),
 *  - removes control characters and remaining path separators,
 *  - prefixes reserved Windows device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9),
 *  - caps length at 200 chars,
 *  - falls back to `file` when the result is empty.
 */
export function sanitizeUploadFilename(name: string): string {
  if (typeof name !== 'string') return 'file';

  // Basename only: split on both separators, take the last non-empty segment.
  const segments = name.split(/[/\\]/);
  let base = '';
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i].trim();
    if (seg && seg !== '.' && seg !== '..') {
      base = seg;
      break;
    }
  }

  // Strip control chars (0x00-0x1F, 0x7F) and any lingering path separators.
  // eslint-disable-next-line no-control-regex
  base = base.replace(/[\x00-\x1f\x7f/\\]/g, '');
  base = base.trim();

  if (!base || base === '.' || base === '..') return 'file';

  // Neutralize reserved Windows device names by prefixing.
  if (WINDOWS_DEVICE_NAMES.test(base)) {
    base = `_${base}`;
  }

  if (base.length > MAX_FILENAME_LENGTH) {
    base = base.slice(0, MAX_FILENAME_LENGTH);
  }

  return base || 'file';
}
