import { describe, expect, it } from 'vitest';
import { evaluateClaudeBackgroundAgentFrame } from '../src/claude-background-agent-frame.js';

const renderer = '✳ Waiting for 2 background agents to finish';
const composerStatusScaffold = `────────────────
❯
────────────────
Opus 5 (1M context)  in:123 out:45 ctx:67%`;

function currentStatusScaffold(waitLine = renderer): string {
  return `${waitLine}\n${composerStatusScaffold}`;
}

function evaluate(text: string, overrides: Record<string, unknown> = {}) {
  return evaluateClaudeBackgroundAgentFrame(
    {
      source: 'tmux_visible_frame',
      claudeRuntimeVersion: '2.1.237',
      text,
      ...overrides,
    },
    2
  );
}

describe('evaluateClaudeBackgroundAgentFrame', () => {
  it('accepts the anchored 2.1.237 renderer in the current visible frame bottom region', () => {
    expect(evaluate(`\n${currentStatusScaffold()}\n`)).toEqual({
      status: 'positive',
      reason: 'matching_visible_renderer',
      renderedCount: 2,
    });
  });

  it('rejects a raw buffer or scrollback source', () => {
    expect(evaluate(renderer, { source: 'raw_terminal_buffer' })).toMatchObject({
      status: 'negative',
      reason: 'untrusted_source',
    });
    expect(evaluate(renderer, { source: 'tmux_scrollback' })).toMatchObject({
      status: 'negative',
      reason: 'untrusted_source',
    });
  });

  it.each([
    `> ${renderer}`,
    `Claude said: ${renderer}`,
    `"${renderer}"`,
    '✳ Waiting for two background agents to finish',
    '✳ Waiting for 2 agents to finish',
  ])('rejects quoted or unrecognized renderer text: %s', (text) => {
    expect(evaluate(text)).toMatchObject({ status: 'negative', reason: 'renderer_not_found' });
  });

  it.each([renderer, `    ${renderer}`])(
    'rejects exact renderer prose without the Claude status scaffold: %s',
    (text) => {
      expect(evaluate(text)).toMatchObject({
        status: 'negative',
        reason: 'renderer_not_in_status_scaffold',
      });
    }
  );

  it.each([renderer, `    ${renderer}`])(
    'rejects exact renderer prose above the completion row and current status scaffold: %s',
    (text) => {
      expect(evaluate(`${text}\n✻ Worked for 1s\n${composerStatusScaffold}`)).toMatchObject({
        status: 'negative',
        reason: 'renderer_not_in_status_scaffold',
      });
    }
  );

  it('rejects a stale marker outside the anchored bottom region', () => {
    const laterRows = Array.from({ length: 13 }, (_, index) => `ordinary row ${index}`).join('\n');
    expect(evaluate(`${renderer}\n${laterRows}`)).toMatchObject({
      status: 'negative',
      reason: 'renderer_not_in_bottom_region',
    });
  });

  it('uses the current bottom renderer when a stale renderer remains near the top', () => {
    const middleRows = Array.from({ length: 13 }, (_, index) => `ordinary row ${index}`).join('\n');
    expect(evaluate(`✳ Waiting for 3 background agents to finish\n${middleRows}\n${currentStatusScaffold()}`)).toEqual({
      status: 'positive',
      reason: 'matching_visible_renderer',
      renderedCount: 2,
    });
  });

  it('rejects zero and a count different from the exact watcher live count', () => {
    expect(evaluate(currentStatusScaffold('✳ Waiting for 0 background agents to finish'))).toMatchObject({
      status: 'negative',
      reason: 'non_positive_count',
    });
    expect(evaluate(currentStatusScaffold('✳ Waiting for 3 background agents to finish'))).toEqual({
      status: 'negative',
      reason: 'count_mismatch',
      renderedCount: 3,
    });
  });

  it('requires a positive expected watcher count and the recognized runtime version', () => {
    expect(
      evaluateClaudeBackgroundAgentFrame(
        { source: 'tmux_visible_frame', claudeRuntimeVersion: '2.1.237', text: renderer },
        0
      )
    ).toMatchObject({ status: 'negative', reason: 'non_positive_expected_count' });
    expect(evaluate(renderer, { claudeRuntimeVersion: '2.1.238' })).toMatchObject({
      status: 'negative',
      reason: 'unsupported_runtime_version',
    });
  });
});
