/** Read-only prompt samples; previewing never changes recovery eligibility. */
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { findCodexRecoveryTranscript, userPromptFromLine } from './codex-transcript.js';
import { claudeProjectsDir } from './utils/claude-transcript.js';
import type { SessionRecoveryRecord } from './types/session-recovery.js';

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_PROMPTS = 10000;
const EXCERPT_LENGTH = 3000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type RecoveryPreview = {
  available: boolean;
  message?: string;
  promptCount?: number;
  prompts?: Array<{ position: string; ordinal: number; text: string; truncated: boolean }>;
};
function textContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((block) => (block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
    .join('\n')
    .trim();
}

export async function readRecoveryPreview(record: SessionRecoveryRecord): Promise<RecoveryPreview> {
  const unavailable = (message: string): RecoveryPreview => ({ available: false, message });
  if (record.transport !== 'local' || record.launch.kind !== 'built-in')
    return unavailable('Preview is available for local built-in Claude and Codex conversations only.');
  const paths: string[] = [];
  const claudeId = record.claudeResumeId || record.sourceSessionId;
  if (record.mode === 'codex') {
    const path = await findCodexRecoveryTranscript(record);
    if (path) paths.push(path);
  } else if (record.mode === 'claude' && UUID.test(claudeId)) {
    for (const dir of await readdir(claudeProjectsDir(), { withFileTypes: true }).catch(() => [])) {
      if (dir.isDirectory()) paths.push(join(claudeProjectsDir(), dir.name, `${claudeId}.jsonl`));
    }
  }
  for (const path of paths) {
    const file = await open(path, 'r').catch(() => null);
    if (!file) continue;
    try {
      const info = await file.stat();
      if (!info.isFile()) continue;
      if (info.size > MAX_BYTES) return unavailable('This transcript exceeds the 64 MiB preview limit.');
      // Read a fixed snapshot, even if a running CLI appends during the request.
      const buffer = Buffer.alloc(info.size);
      let offset = 0;
      while (offset < buffer.length) {
        const read = await file.read(buffer, offset, buffer.length - offset, offset);
        if (!read.bytesRead) break;
        offset += read.bytesRead;
      }
      const direct: Array<{ text: string; truncated: boolean }> = [];
      const fallback: typeof direct = [];
      const seen = new Set<string>();
      let malformed = false;
      let validClaude = false;
      for (const line of buffer.subarray(0, offset).toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          malformed = true;
          continue;
        }
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
          malformed = true;
          continue;
        }
        let text = '';
        let destination = direct;
        if (record.mode === 'codex') {
          const prompt = userPromptFromLine(row);
          if (!prompt) continue;
          if (prompt.injectionProne) {
            if (prompt.text.startsWith('#') || prompt.text.startsWith('<')) continue;
            destination = fallback;
          }
          text = prompt.text;
        } else {
          if (row.sessionId !== claudeId || row.cwd !== record.workingDir || row.isSidechain) continue;
          if (row.type === 'user' || row.type === 'assistant') validClaude = true;
          if (row.type !== 'user') continue;
          if (typeof row.uuid === 'string') {
            if (seen.has(row.uuid)) continue;
            seen.add(row.uuid);
          }
          text = textContent(row.message?.content);
        }
        if (!text) continue;
        destination.push({ text: text.slice(0, EXCERPT_LENGTH), truncated: text.length > EXCERPT_LENGTH });
        if (destination.length > MAX_PROMPTS)
          return unavailable('This transcript exceeds the 10,000 prompt preview limit.');
      }
      if (record.mode === 'claude' && !validClaude) continue;
      const prompts = direct.length ? direct : fallback;
      if (!prompts.length) return unavailable('No readable user text prompts were found in this transcript.');
      const indices = [...new Set([0, Math.floor((prompts.length - 1) / 2), prompts.length - 1])];
      return {
        available: true,
        promptCount: prompts.length,
        ...(malformed
          ? { message: 'Unreadable transcript lines were skipped; samples reflect readable prompts only.' }
          : {}),
        prompts: indices.map((index) => ({
          position:
            prompts.length === 1
              ? 'Only prompt'
              : index === 0
                ? 'First prompt'
                : index === prompts.length - 1
                  ? 'Last prompt'
                  : 'Middle prompt',
          ordinal: index + 1,
          ...prompts[index],
        })),
      };
    } finally {
      await file.close();
    }
  }
  return unavailable('No matching saved transcript was found for this session.');
}
