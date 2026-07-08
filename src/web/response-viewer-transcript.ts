export type ResponseViewerTranscriptKind = 'prompt' | 'response' | 'status' | 'tool';

export interface ResponseViewerTranscriptBlock {
  kind: ResponseViewerTranscriptKind;
  label: 'Prompt' | 'Response' | 'Status' | 'Tool';
  text: string;
}

const EXTERNAL_CLI_MODES = new Set(['codex', 'gemini', 'opencode', 'agy']);

function isPromptLine(line: string): boolean {
  return /^\s*›\s*/.test(line);
}

function isToolHeaderLine(line: string): boolean {
  return /^\s*[•*-]\s+(Explored|Viewed|Read|Edited|Updated|Created|Deleted|Ran|Searched|Opened|Listed|Found|Applied|Patched|Used|Wrote|Executed|Modified|Analyzed|Compared|Fetched|Installed)\b/.test(
    line.trim()
  );
}

function isToolContinuationLine(line: string, currentKind: ResponseViewerTranscriptKind | null): boolean {
  if (currentKind !== 'tool') return false;
  const trimmed = line.trimEnd();
  if (!trimmed) return true;
  return /^\s*[│├└]/.test(trimmed) || /^\s{2,}\S/.test(line);
}

function isStatusLine(line: string, mode: string): boolean {
  if (!EXTERNAL_CLI_MODES.has(mode)) return false;
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^(model|directory):\s+/i.test(trimmed)) return true;
  if (/\bContext\b.*\bleft\b/i.test(trimmed)) return true;
  if (/\b\/model to change\b/i.test(trimmed)) return true;
  if (/\bReady\b/i.test(trimmed) && /·/.test(trimmed)) return true;
  if (/^(gpt|o\d|claude|gemini)\b/i.test(trimmed) && /·/.test(trimmed)) return true;
  if (/^Tip:/i.test(trimmed)) return true;
  if (/^\s*[•*-]\s+(Working|Thinking|Loading|Starting\b|Waiting\b)/i.test(trimmed)) return true;
  return false;
}

function isStandaloneMarkdownLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^#{1,6}\s/.test(trimmed)) return true;
  if (/^>\s/.test(trimmed)) return true;
  if (/^(```|~~~)/.test(trimmed)) return true;
  if (/^[-*+]\s/.test(trimmed)) return true;
  if (/^\d+[.)]\s/.test(trimmed)) return true;
  if (/^\|/.test(trimmed)) return true;
  if (/^\s{4,}\S/.test(line)) return true;
  return false;
}

function shouldJoinWrappedLine(previous: string, next: string): boolean {
  const prev = previous.trimEnd();
  const curr = next.trim();
  if (!prev || !curr) return false;
  if (/[.!?]$/.test(prev)) return false;
  if (/[:;]$/.test(prev)) return false;
  if (isStandaloneMarkdownLine(curr)) return false;
  if (/^[a-z(]/.test(curr)) return true;
  if (prev.length >= 72 && /^[A-Za-z0-9"'(]/.test(curr)) return true;
  return false;
}

function normalizeWrappedText(lines: string[]): string {
  const out: string[] = [];
  let paragraph = '';

  const flushParagraph = () => {
    if (!paragraph) return;
    out.push(paragraph);
    paragraph = '';
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      if (out[out.length - 1] !== '') out.push('');
      continue;
    }
    if (isStandaloneMarkdownLine(line)) {
      flushParagraph();
      out.push(trimmed);
      continue;
    }
    if (!paragraph) {
      paragraph = trimmed;
      continue;
    }
    if (shouldJoinWrappedLine(paragraph, trimmed)) {
      paragraph += ` ${trimmed}`;
      continue;
    }
    flushParagraph();
    paragraph = trimmed;
  }

  flushParagraph();
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanTerminalTranscript(buffer: string): string {
  return String(buffer || '')
    .replace(/\x1b\[[\x30-\x3F]*[\x20-\x2F]*[\x40-\x7E]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, '')
    .replace(/\x1b[NO()][A-Z0-9]?/g, '')
    .replace(/\x1b[>=<78cDEHM]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

function trimLeadingStartup(lines: string[]): string[] {
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] || '';
    const trimmed = line.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }
    if (/^[╭╰│─].*[╮╯│]?$/.test(trimmed)) {
      index += 1;
      continue;
    }
    if (/^>_\s*OpenAI Codex/i.test(trimmed)) {
      index += 1;
      continue;
    }
    if (/^(model|directory):\s+/i.test(trimmed)) {
      index += 1;
      continue;
    }
    break;
  }
  return lines.slice(index);
}

function pushBlock(
  blocks: ResponseViewerTranscriptBlock[],
  kind: ResponseViewerTranscriptKind | null,
  lines: string[]
): void {
  if (!kind || lines.length === 0) return;
  const text =
    kind === 'tool' || kind === 'status'
      ? lines
          .join('\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim()
      : normalizeWrappedText(lines);
  if (!text) return;
  const label = (kind.charAt(0).toUpperCase() + kind.slice(1)) as ResponseViewerTranscriptBlock['label'];
  blocks.push({ kind, label, text });
}

export function isExternalCliTranscriptMode(mode: string | null | undefined): boolean {
  return EXTERNAL_CLI_MODES.has(String(mode || ''));
}

export function parseExternalCliTranscript(
  buffer: string,
  mode: string | null | undefined
): ResponseViewerTranscriptBlock[] {
  const resolvedMode = String(mode || '');
  if (!isExternalCliTranscriptMode(resolvedMode)) return [];

  const cleaned = cleanTerminalTranscript(buffer);
  if (!cleaned) return [];

  const lines = trimLeadingStartup(cleaned.split('\n'));
  const blocks: ResponseViewerTranscriptBlock[] = [];
  let currentKind: ResponseViewerTranscriptKind | null = null;
  let currentLines: string[] = [];

  const flush = () => {
    pushBlock(blocks, currentKind, currentLines);
    currentKind = null;
    currentLines = [];
  };

  for (const line of lines) {
    if (isPromptLine(line)) {
      flush();
      currentKind = 'prompt';
      currentLines = [line.replace(/^\s*›\s*/, '').trim()];
      continue;
    }

    if (isToolHeaderLine(line)) {
      if (currentKind !== 'tool') flush();
      currentKind = 'tool';
      currentLines.push(line.trimEnd());
      continue;
    }

    if (isToolContinuationLine(line, currentKind)) {
      currentLines.push(line.trimEnd());
      continue;
    }

    if (isStatusLine(line, resolvedMode)) {
      if (currentKind !== 'status') flush();
      currentKind = 'status';
      currentLines.push(line.trim());
      continue;
    }

    if (!line.trim()) {
      currentLines.push('');
      continue;
    }

    if (currentKind !== 'response') flush();
    currentKind = 'response';
    currentLines.push(line);
  }

  flush();
  return blocks.filter((block) => block.text.trim().length > 0);
}

export function getLastTranscriptResponse(blocks: ResponseViewerTranscriptBlock[]): string {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    if (blocks[i]?.kind === 'response') return blocks[i].text;
  }
  return '';
}
