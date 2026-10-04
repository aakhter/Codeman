import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRecoveryPreview } from '../src/session-recovery-preview.js';
import type { SessionRecoveryRecord } from '../src/types/session-recovery.js';

const id = '01a0c810-a5c4-7b32-be0b-1599d9d5995d';
const record: SessionRecoveryRecord = {
  id: 'recovery',
  sourceSessionId: 'pane',
  mode: 'codex',
  workingDir: '/work',
  transport: 'local',
  status: 'unavailable',
  launch: { kind: 'built-in' },
  createdAt: 1,
};
let root: string;
let env: Record<string, string | undefined>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'recovery-preview-'));
  env = { CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.CODEX_HOME = join(root, 'codex');
  process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
});
afterEach(() => {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});
function codex(rows: unknown[], metadata = {}) {
  const dir = join(process.env.CODEX_HOME!, 'sessions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'rollout-preview.jsonl'),
    [
      { type: 'session_meta', payload: { id, cwd: '/work', originator: 'codeman_pane', source: 'cli', ...metadata } },
      ...rows,
    ]
      .map((row) => JSON.stringify(row))
      .join('\n')
  );
}
const event = (text: string) => ({ type: 'event_msg', payload: { type: 'user_message', message: text } });

describe('read-only recovery previews', () => {
  it('samples first, middle and last without counting response-item duplicates or changing state', async () => {
    codex(
      ['one', 'two', 'three', 'four', 'five'].flatMap((text) => [
        event(text),
        { type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text }] } },
      ])
    );
    const before = structuredClone(record);
    expect(await readRecoveryPreview(record)).toMatchObject({
      available: true,
      promptCount: 5,
      prompts: [
        { position: 'First prompt', ordinal: 1, text: 'one' },
        { position: 'Middle prompt', ordinal: 3, text: 'three' },
        { position: 'Last prompt', ordinal: 5, text: 'five' },
      ],
    });
    expect(record).toEqual(before);
  });
  it('never substitutes a different ID, workspace-only match, or subagent transcript', async () => {
    codex([event('wrong conversation')], { originator: 'another-pane' });
    expect((await readRecoveryPreview(record)).available).toBe(false);
    expect((await readRecoveryPreview({ ...record, nativeResumeId: 'missing' })).available).toBe(false);
    codex([event('child')], { source: { subagent: 'parent' } });
    expect((await readRecoveryPreview({ ...record, nativeResumeId: id })).available).toBe(false);
  });
  it('does not repeat a single prompt and marks shortened excerpts', async () => {
    codex([event('x'.repeat(4000))]);
    const preview = await readRecoveryPreview(record);
    expect(preview.prompts).toHaveLength(1);
    expect(preview.prompts![0]).toMatchObject({ position: 'Only prompt', truncated: true });
    expect(preview.prompts![0].text).toHaveLength(3000);
  });
  it('filters injected context from older Codex response-item transcripts', async () => {
    codex(
      ['<environment_context>injected</environment_context>', '# AGENTS.md instructions', 'real input'].map((text) => ({
        type: 'response_item',
        payload: { role: 'user', content: [{ type: 'input_text', text }] },
      }))
    );
    expect(await readRecoveryPreview(record)).toMatchObject({ promptCount: 1, prompts: [{ text: 'real input' }] });
  });
  it('reads exact Claude identity and excludes tool results, sidechains and duplicate UUIDs', async () => {
    const dir = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', 'workspace');
    mkdirSync(dir, { recursive: true });
    const user = (text: string, uuid: string) => ({
      type: 'user',
      sessionId: id,
      cwd: '/work',
      uuid,
      message: { content: [{ type: 'text', text }] },
    });
    const rows = [
      user('first', 'a'),
      user('first', 'a'),
      { ...user('sidechain', 'b'), isSidechain: true },
      { ...user('tool', 'c'), message: { content: [{ type: 'tool_result', content: 'tool output' }] } },
      user('middle', 'd'),
      user('last', 'e'),
    ];
    writeFileSync(join(dir, `${id}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n'));
    expect(await readRecoveryPreview({ ...record, mode: 'claude', claudeResumeId: id })).toMatchObject({
      promptCount: 3,
      prompts: [{ text: 'first' }, { text: 'middle' }, { text: 'last' }],
    });
    expect(
      (await readRecoveryPreview({ ...record, mode: 'claude', claudeResumeId: id, workingDir: '/wrong' })).available
    ).toBe(false);
  });
  it('reports missing transcripts and malformed rows without pretending the preview is complete', async () => {
    expect((await readRecoveryPreview(record)).available).toBe(false);
    codex([event('readable'), null]);
    appendFileSync(join(process.env.CODEX_HOME!, 'sessions', 'rollout-preview.jsonl'), '\n{broken json');
    expect(await readRecoveryPreview(record)).toMatchObject({
      available: true,
      promptCount: 1,
      message: 'Unreadable transcript lines were skipped; samples reflect readable prompts only.',
    });
  });
  it('refuses oversized transcripts rather than labeling a partial scan as the last prompt', async () => {
    codex([event('first')]);
    truncateSync(join(process.env.CODEX_HOME!, 'sessions', 'rollout-preview.jsonl'), 64 * 1024 * 1024 + 1);
    expect(await readRecoveryPreview(record)).toMatchObject({
      available: false,
      message: 'This transcript exceeds the 64 MiB preview limit.',
    });
  });
});
