import { describe, expect, it } from 'vitest';
import { mergeReadMyMindPrompts } from '../src/readmymind-prompt-merge.js';

describe('mergeReadMyMindPrompts', () => {
  it('sanitizes rollout text and sorts valid timestamps chronologically and stably', () => {
    const intent = [
      { ts: 2_000, text: 'intent second' },
      { ts: 1_000, text: 'same text' },
    ];
    const rollout = [
      { timestamp: '1970-01-01T00:00:01.000Z', text: 'same text' },
      { timestamp: '1970-01-01T00:00:03.000Z', text: 'rollout\nthird' },
    ];

    const merged = mergeReadMyMindPrompts(intent, rollout);

    expect(merged.recentPrompts).toEqual([
      { ts: 1_000, text: 'same text' },
      { ts: 1_000, text: 'same text' },
      { ts: 2_000, text: 'intent second' },
      { ts: 3_000, text: 'rollout third' },
    ]);
    expect(merged.latestValidTimestamp).toBe(3_000);
    expect(intent).toEqual([
      { ts: 2_000, text: 'intent second' },
      { ts: 1_000, text: 'same text' },
    ]);
    expect(rollout[1].text).toBe('rollout\nthird');
  });

  it('keeps missing and invalid timestamps stable without making them future away markers', () => {
    const merged = mergeReadMyMindPrompts(
      [{ ts: 5_000, text: 'valid intent' }],
      [
        { text: 'missing timestamp' },
        { timestamp: 'not-an-iso-date', text: 'invalid timestamp' },
        { timestamp: '2026-02-30T12:00:00.000Z', text: 'invalid calendar timestamp' },
      ]
    );

    expect(merged.recentPrompts).toEqual([
      { ts: 5_000, text: 'valid intent' },
      { ts: 5_000, text: 'missing timestamp' },
      { ts: 5_000, text: 'invalid timestamp' },
      { ts: 5_000, text: 'invalid calendar timestamp' },
    ]);
    expect(merged.latestValidTimestamp).toBe(5_000);
  });

  it('drops unsanitizable rollout prompts and bounds the merged context to the newest 20', () => {
    const intent = Array.from({ length: 15 }, (_, index) => ({ ts: index + 1, text: `intent ${index}` }));
    const rollout = Array.from({ length: 10 }, (_, index) => ({
      timestamp: new Date(100 + index).toISOString(),
      text: index === 0 ? '  1  ' : `${'x'.repeat(600)} ${index}`,
    }));

    const merged = mergeReadMyMindPrompts(intent, rollout);

    expect(merged.recentPrompts).toHaveLength(20);
    expect(merged.recentPrompts.some((prompt) => prompt.text === '1')).toBe(false);
    expect(merged.recentPrompts.at(-1)?.text).toHaveLength(500);
  });
});
