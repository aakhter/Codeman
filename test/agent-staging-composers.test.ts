/** @fileoverview Characterized composer profiles and explicit multiline authorization. */
import { expect, it } from 'vitest';
import * as staging from '../src/agent-staging.js';
import { formatPaneSnapshot } from '../src/tmux-manager.js';
const frame = (rows: string[], x: number, y: number) =>
  formatPaneSnapshot(rows, { cols: 120, rows: 30, cursorX: x, cursorY: y });

it('accepts exactly reconstructed Codex multiline rows and end caret only with authorization', () => {
  const screen = frame(['› first', '  second', '  GPT-6-Luna default · ~/case'], 8, 1);
  expect(staging.readGuardedComposerSnapshot(screen, 'codex', true)).toBe('first\nsecond');
  expect(staging.readGuardedComposerSnapshot(screen, 'codex')).toBeNull();
  expect(
    staging.readGuardedComposerSnapshot(
      frame(['› first', '  second', '  GPT-6-Luna default · ~/case'], 7, 1),
      'codex',
      true
    )
  ).toBeNull();
});
it('retains interior whitespace and blank lines while refusing unindented continuations', () => {
  expect(
    staging.readGuardedComposerSnapshot(
      frame(['› first', '', '    indented', '  GPT-6-Luna default · ~/case'], 12, 2),
      'codex',
      true
    )
  ).toBe('first\n\n  indented');
  expect(
    staging.readGuardedComposerSnapshot(
      frame(['› first', 'second', '  GPT-6-Luna default · ~/case'], 6, 1),
      'codex',
      true
    )
  ).toBeNull();
});
it('verifies a bordered Claude composer and supported footer, not a trust dialog', () => {
  const rows = ['────────────────', '❯ hello', '────────────────', '  ⏵⏵ bypass permissions on (shift+tab to cycle)'];
  expect(staging.readGuardedComposerSnapshot(frame(rows, 7, 1), 'claude')).toBe('hello');
  expect(
    staging.readGuardedComposerSnapshot(frame(['❯ Yes, I trust this folder', '  Enter to confirm'], 28, 0), 'claude')
  ).toBeNull();
  expect(staging.readGuardedComposerSnapshot(frame(rows, 6, 1), 'claude')).toBeNull();
});
it('verifies Claude multiline without treating continuation as an automatic submission', () => {
  expect(
    staging.readGuardedComposerSnapshot(
      frame(
        [
          '────────────────',
          '❯ first',
          '  second',
          '────────────────',
          '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
        ],
        8,
        2
      ),
      'claude',
      true
    )
  ).toBe('first\nsecond');
});
it('rejects working, unknown-footer and raw frames even with a composer glyph', () => {
  expect(
    staging.readGuardedComposerSnapshot(
      frame(
        [
          '✻ Thinking… (esc to interrupt)',
          '────────────────',
          '❯ hello',
          '────────────────',
          '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
        ],
        7,
        2
      ),
      'claude'
    )
  ).toBeNull();
  expect(
    staging.readGuardedComposerSnapshot(
      frame(['────────────────', '❯ hello', '────────────────', 'shell footer'], 7, 1),
      'claude'
    )
  ).toBeNull();
  expect(staging.readGuardedComposerSnapshot('› hello\n  GPT-6-Luna default · ~/case', 'codex')).toBeNull();
});
it('normalizes exactly one file terminator without erasing meaningful whitespace', () => {
  expect(staging.normalizeGuardedMessageFile('first\nsecond\n')).toBe('first\nsecond');
  expect(staging.normalizeGuardedMessageFile('hello\r\n')).toBe('hello');
  expect(staging.normalizeGuardedMessageFile('hello\n\n')).toBe('hello\n');
  expect(staging.normalizeGuardedMessageFile('hello  ')).toBe('hello  ');
});
it('requires explicit multiline and still refuses controls, ambiguous trailing spaces and invalid UTF8', () => {
  expect(staging.guardedMessageRefusal('first\nsecond')).toBeTruthy();
  expect(staging.guardedMessageRefusal('first\nsecond', true)).toBeUndefined();
  for (const value of ['first\rsecond', 'first\tsecond', 'first\u001bsecond', 'first \nsecond', 'first\n', '\ud800'])
    expect(staging.guardedMessageRefusal(value, true)).toBeTruthy();
});
it('authorized multiline staging retains one-shot hash and changed-input protection', async () => {
  let text = '',
    revision = 0;
  const writes: string[] = [];
  const target: staging.GuardedInputTarget = {
    id: 'pane',
    snapshot: () => ({ generation: 'generation', revision, composerSha: staging.promptSha256(text) }),
    write: async (value) => {
      writes.push(value);
      text += value;
      revision++;
      return true;
    },
    submit: async () => {
      writes.push('\r');
      return true;
    },
  };
  const store = new staging.GuardedStageStore();
  const receipt = await store.stage(target, 'owner', 'first\nsecond', { multiline: true });
  expect(writes).toEqual(['first\nsecond']);
  expect(receipt.sha256).toBe(staging.promptSha256('first\nsecond'));
  await store.submit(target, 'owner', receipt.stageId, receipt.sha256);
  await expect(store.submit(target, 'owner', receipt.stageId, receipt.sha256)).rejects.toThrow();
  expect(writes).toEqual(['first\nsecond', '\r']);
});

it('excludes dim Claude placeholder text and rejects extra dialog rows below the footer', () => {
  const rows = [
    '────────────────',
    '❯ \x1b[2mTry "edit the file"\x1b[0m',
    '────────────────',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  ];
  expect(staging.readGuardedComposerSnapshot(frame(rows, 2, 1), 'claude')).toBe('');
  expect(staging.readGuardedComposerSnapshot(frame([...rows, '  Enter to confirm'], 2, 1), 'claude')).toBeNull();
});
