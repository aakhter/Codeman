/**
 * @fileoverview Codex rollout parsing and Read My Mind signal projection tests.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODEX_ROLLOUT_TAIL_BYTES, parseCodexRollout, readCodexRolloutSignals } from '../src/codex-rollout-reader.js';
import { MAX_READMYMIND_ASSISTANT_CHARS } from '../src/readmymind-signal-limits.js';

const eventUser = (message: string, timestamp = '2026-08-16T10:00:00.000Z', extra: Record<string, unknown> = {}) =>
  JSON.stringify({ timestamp, type: 'event_msg', payload: { type: 'user_message', message, ...extra } });

const legacyUser = (text: string, timestamp = '2026-08-16T10:00:00.000Z') =>
  JSON.stringify({
    timestamp,
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  });

const assistant = (text: string, timestamp = '2026-08-16T10:00:00.000Z') =>
  JSON.stringify({
    timestamp,
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
  });

describe('parseCodexRollout', () => {
  it('uses modern event turns, retains legacy-only turns, and removes one matching legacy twin', () => {
    const parsed = parseCodexRollout([
      legacyUser('legacy prompt'),
      assistant('legacy reply'),
      eventUser('repeated real prompt', '2026-08-16T10:01:00.000Z'),
      legacyUser('repeated real prompt', '2026-08-16T10:01:01.000Z'),
      eventUser('repeated real prompt', '2026-08-16T10:02:00.000Z'),
      legacyUser('repeated real prompt', '2026-08-16T10:02:01.000Z'),
      assistant('latest reply', '2026-08-16T10:03:00.000Z'),
    ]);

    expect(parsed.messages.map(({ role, text }) => [role, text])).toEqual([
      ['user', 'legacy prompt'],
      ['assistant', 'legacy reply'],
      ['user', 'repeated real prompt'],
      ['user', 'repeated real prompt'],
      ['assistant', 'latest reply'],
    ]);
    expect(parsed.signals.recentPrompts).toEqual([
      { text: 'legacy prompt', timestamp: '2026-08-16T10:00:00.000Z' },
      { text: 'repeated real prompt', timestamp: '2026-08-16T10:01:00.000Z' },
      { text: 'repeated real prompt', timestamp: '2026-08-16T10:02:00.000Z' },
    ]);
  });

  it('does not let a later modern turn consume an earlier legacy-only prompt with identical text', () => {
    const parsed = parseCodexRollout([
      legacyUser('same', '2026-08-16T10:00:00.000Z'),
      assistant('legacy answer', '2026-08-16T10:00:01.000Z'),
      eventUser('same', '2026-08-16T10:01:00.000Z'),
      legacyUser('same', '2026-08-16T10:01:01.000Z'),
    ]);

    expect(parsed.messages).toEqual([
      { role: 'user', text: 'same', timestamp: '2026-08-16T10:00:00.000Z' },
      { role: 'assistant', text: 'legacy answer', timestamp: '2026-08-16T10:00:01.000Z' },
      { role: 'user', text: 'same', timestamp: '2026-08-16T10:01:00.000Z' },
    ]);
  });

  it('filters injected context while preserving image placeholders only in viewer history', () => {
    const parsed = parseCodexRollout([
      legacyUser('# AGENTS.md instructions for this workspace'),
      legacyUser('<environment_context>environment</environment_context>'),
      eventUser('<turn_aborted />'),
      eventUser('<codex_internal_context>internal</codex_internal_context>'),
      eventUser('<recommended_plugins>plugins</recommended_plugins>'),
      eventUser('<user_instructions>instructions</user_instructions>'),
      legacyUser('# Options\nignored'),
      eventUser('', '2026-08-16T10:01:00.000Z', { images: ['first', 'second'] }),
      eventUser('real prompt', '2026-08-16T10:02:00.000Z', { local_images: ['third'] }),
    ]);

    expect(parsed.messages.map(({ text }) => text)).toEqual(['*[image ×2]*', 'real prompt\n\n*[image ×1]*']);
    expect(parsed.signals.recentPrompts).toEqual([{ text: 'real prompt', timestamp: '2026-08-16T10:02:00.000Z' }]);
  });

  it('extracts the final assistant text and bounded recent function/custom tool summaries without tool output', () => {
    const tools = Array.from({ length: 12 }, (_, index) =>
      JSON.stringify({
        timestamp: `2026-08-16T10:${String(index).padStart(2, '0')}:00.000Z`,
        type: 'response_item',
        payload: {
          type: index % 2 === 0 ? 'function_call' : 'custom_tool_call',
          name: index % 2 === 0 ? 'exec_command' : 'apply_patch',
          ...(index % 2 === 0
            ? { arguments: JSON.stringify({ command: `npm test -- test/${index}.test.ts` }) }
            : { input: { file_path: `src/${index}.ts` } }),
        },
      })
    );
    const parsed = parseCodexRollout([
      ...tools,
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'ignored', output: 'never include output' },
      }),
      assistant('first answer'),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'last answer' }] },
      }),
    ]);

    expect(parsed.lastAssistantText).toBe('last answer');
    expect(parsed.signals.lastAssistantText).toBe('last answer');
    expect(parsed.signals.recentTools).toHaveLength(10);
    expect(parsed.signals.recentTools[0]).toEqual({ name: 'exec_command', detail: 'npm test -- test/2.test.ts' });
    expect(parsed.signals.recentTools[9]).toEqual({ name: 'apply_patch', detail: 'src/11.ts' });
  });

  it('skips malformed rows and malformed tool arguments', () => {
    const parsed = parseCodexRollout([
      '{"type":"response_item",',
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'bad', arguments: '{bad' } }),
      assistant('valid answer'),
    ]);

    expect(parsed.lastAssistantText).toBe('valid answer');
    expect(parsed.signals.recentTools).toEqual([{ name: 'bad', detail: undefined }]);
  });

  it('bounds the Read My Mind assistant signal like the Claude transcript collector', () => {
    const parsed = parseCodexRollout([assistant('x'.repeat(MAX_READMYMIND_ASSISTANT_CHARS + 1))]);

    expect(parsed.signals.lastAssistantText).toHaveLength(MAX_READMYMIND_ASSISTANT_CHARS);
  });

  it('can retain only the last assistant response without building viewer or Read My Mind projections', () => {
    const parsed = parseCodexRollout(
      [eventUser('ignored prompt'), legacyUser('ignored prompt'), assistant('last answer')],
      { includeMessages: false, includeSignals: false }
    );

    expect(parsed).toEqual({
      lastAssistantText: 'last answer',
      lastAssistantTimestamp: '2026-08-16T10:00:00.000Z',
      messages: [],
      signals: { lastAssistantText: null, recentPrompts: [], recentTools: [] },
    });
  });
});

describe('readCodexRolloutSignals', () => {
  it('reads only the final bounded tail and drops its first partial JSONL row', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-rollout-reader-'));
    const path = join(dir, 'resolved-rollout.jsonl');
    try {
      const tooOld = eventUser('old prompt') + '\n';
      const filler = 'x'.repeat(CODEX_ROLLOUT_TAIL_BYTES - tooOld.length + 10);
      writeFileSync(path, tooOld + filler + '\n' + eventUser('tail prompt') + '\n' + assistant('tail answer') + '\n');

      await expect(readCodexRolloutSignals(path)).resolves.toEqual({
        lastAssistantText: 'tail answer',
        recentPrompts: [{ text: 'tail prompt', timestamp: '2026-08-16T10:00:00.000Z' }],
        recentTools: [],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retains the first buffered record when the tail starts exactly after a newline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-rollout-reader-'));
    const path = join(dir, 'resolved-rollout.jsonl');
    try {
      const tailRecords = eventUser('first tail prompt') + '\n' + assistant('tail answer') + '\n';
      const boundedTail = tailRecords + '\n'.repeat(CODEX_ROLLOUT_TAIL_BYTES - tailRecords.length);
      writeFileSync(path, 'old row that must not be parsed\n' + boundedTail);

      await expect(readCodexRolloutSignals(path)).resolves.toEqual({
        lastAssistantText: 'tail answer',
        recentPrompts: [{ text: 'first tail prompt', timestamp: '2026-08-16T10:00:00.000Z' }],
        recentTools: [],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
