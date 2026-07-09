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

const WORD_HIGHLIGHT_CLASS: Record<string, string> = {
  black: 'black',
  blue: 'blue',
  cyan: 'cyan',
  darkBlue: 'dark-blue',
  darkCyan: 'dark-cyan',
  darkGray: 'dark-gray',
  darkGreen: 'dark-green',
  darkMagenta: 'dark-magenta',
  darkRed: 'dark-red',
  darkYellow: 'dark-yellow',
  green: 'green',
  lightGray: 'light-gray',
  magenta: 'magenta',
  red: 'red',
  white: 'white',
  yellow: 'yellow',
};

interface DocxHighlightSegment {
  colorClass: string;
  text: string;
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"' };

function decodeEntities(value: string): string {
  return value.replace(/&#x([0-9a-f]+);|&#([0-9]+);|&(amp|apos|gt|lt|nbsp|quot);/gi, (_match, hex, decimal, named) => {
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    if (decimal) return String.fromCodePoint(Number.parseInt(decimal, 10));
    return NAMED_ENTITIES[String(named).toLowerCase()] || '';
  });
}

function normalizeText(value: string): string {
  return decodeEntities(value.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

function extractRunText(runXml: string): string {
  let text = '';
  const tokenPattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:(tab|br|cr)\b[^>]*\/>/g;
  let token: RegExpExecArray | null;
  while ((token = tokenPattern.exec(runXml))) {
    text += token[1] === undefined ? (token[2] === 'tab' ? '\t' : '\n') : decodeEntities(token[1]);
  }
  return text;
}

/**
 * Pandoc translates Word highlights to bare `<mark>` tags and discards the Word
 * palette value. Rebuild the corresponding, contiguous source runs so their
 * color can be reapplied with a trusted CSS class (not an inline style).
 */
function extractDocxHighlightSegments(documentXml: string): DocxHighlightSegment[] {
  const segments: DocxHighlightSegment[] = [];
  const paragraphPattern = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g;
  let paragraph: RegExpExecArray | null;

  while ((paragraph = paragraphPattern.exec(documentXml))) {
    const runPattern = /<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g;
    let run: RegExpExecArray | null;
    let previousColorClass: string | null = null;

    while ((run = runPattern.exec(paragraph[1]))) {
      const colorMatch = /<w:highlight\b[^>]*\bw:val="([^"]+)"/.exec(run[1]);
      const colorClass = colorMatch ? WORD_HIGHLIGHT_CLASS[colorMatch[1]] : undefined;
      const text = extractRunText(run[1]);

      // Word inserts an empty, highlighted run for a comment-reference glyph.
      // It is not emitted in Pandoc's `<mark>` text, so it must not split the
      // surrounding source highlight into mismatched segments.
      if (!text) continue;
      if (!colorClass) {
        previousColorClass = null;
        continue;
      }
      const active = previousColorClass === colorClass ? segments.at(-1) : undefined;
      if (active) {
        active.text += text;
        continue;
      }

      segments.push({ colorClass, text });
      previousColorClass = colorClass;
    }
  }

  return segments;
}

function applyDocxHighlightClasses(html: string, documentXml: string): string {
  const sourceHighlights = extractDocxHighlightSegments(documentXml);
  let sourceIndex = 0;

  return html.replace(/<mark(\s[^>]*)?>([\s\S]*?)<\/mark>/g, (full, attributes = '', contents: string) => {
    const source = sourceHighlights[sourceIndex];
    // Do not guess when a converter update changes the mark/run boundaries.
    // An undecorated `<mark>` remains readable; a guessed color would be wrong.
    if (!source || normalizeText(source.text) !== normalizeText(contents)) return full;

    sourceIndex += 1;
    const classMatch = /\bclass="([^"]*)"/.exec(attributes);
    const classes = [classMatch?.[1], 'docx-highlight', `docx-highlight--${source.colorClass}`]
      .filter(Boolean)
      .join(' ');
    const withoutClass = attributes.replace(/\s*\bclass="[^"]*"/, '');
    return `<mark${withoutClass} class="${classes}">${contents}</mark>`;
  });
}

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

/**
 * Render a `.docx` to an HTML fragment via pandoc, for a selectable, annotatable
 * preview view (COD-68). The fragment is sanitized client-side before insertion.
 */
export async function convertDocxToHtml(filePath: string): Promise<string> {
  const { stdout } = await execFileAsync('pandoc', ['-f', 'docx', '-t', 'html', '--wrap=none', filePath], {
    timeout: PANDOC_TIMEOUT_MS,
    maxBuffer: PANDOC_MAX_BUFFER,
  });
  const { stdout: documentXml } = await execFileAsync('unzip', ['-p', filePath, 'word/document.xml'], {
    timeout: PANDOC_TIMEOUT_MS,
    maxBuffer: PANDOC_MAX_BUFFER,
  });
  return applyDocxHighlightClasses(stdout, documentXml);
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
