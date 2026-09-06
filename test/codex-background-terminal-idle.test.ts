import { describe, expect, it } from 'vitest';
import { classifyCodexRenderedState } from '../src/session.js';

/**
 * COD-415 refines COD-366: a ready Codex composer must remain available even
 * when the prior turn left a durable background helper running.
 *
 * A background terminal can be a durable helper (for example, a preview
 * server), rather than continuing parent-agent work. Its presence is
 * informational; the ready composer controls parent-session availability.
 *
 * The frames below are the two shapes codex 0.146.0 actually renders (strings
 * lifted from the shipped binary): a `· N background terminal(s) running`
 * suffix on the status row, and a distinct `Waiting for background terminal`
 * label.
 */

const COMPOSER = '› type your message';
const MODEL_FOOTER = '  gpt-5.5 medium · /home/aakht/.codeman/app';

describe('COD-415 codex background-helper availability', () => {
  it('reports input-ready when the composer is ready alongside a background terminal', () => {
    const frame = ['• Done.', '  · 1 background terminal running', COMPOSER, MODEL_FOOTER].join('\r\n');

    expect(classifyCodexRenderedState(frame)).toBe('input-ready');
  });

  it('treats the explicit "Waiting for background terminal" screen as working', () => {
    const frame = ['• Waiting for background terminal', COMPOSER, MODEL_FOOTER].join('\r\n');

    expect(classifyCodexRenderedState(frame)).toBe('working');
  });

  it('reports input-ready for multiple background terminals when the composer is ready', () => {
    const frame = ['  · 3 background terminals running', COMPOSER].join('\r\n');

    expect(classifyCodexRenderedState(frame)).toBe('input-ready');
  });

  it('resumes input-ready once the last background terminal completes', () => {
    // AC3: normal classification resumes from the current codex state.
    const frame = ['• Done.', COMPOSER, MODEL_FOOTER].join('\r\n');

    expect(classifyCodexRenderedState(frame)).toBe('input-ready');
  });

  it('does not read the /bt "No background terminals running." line as work', () => {
    // The status surface says the opposite of what the substring suggests;
    // matching it would latch the session busy forever.
    const frame = ['Background terminals', '  No background terminals running.', COMPOSER].join('\r\n');

    expect(classifyCodexRenderedState(frame)).toBe('input-ready');
  });

  it('does not treat a zero count as a running terminal', () => {
    const frame = ['  · 0 background terminals running', COMPOSER].join('\r\n');

    expect(classifyCodexRenderedState(frame)).toBe('input-ready');
  });

  it('keeps a real action-required prompt actionable while a terminal runs', () => {
    // AC4: a genuine question must still reach the human even though a
    // background terminal is running, or the session would sit blocked with
    // no alert.
    const frame = [
      '  · 1 background terminal running',
      'Allow codex to run this command?',
      '› 1. Yes, run it',
      '  2. No, and tell codex what to do differently',
      COMPOSER,
    ].join('\r\n');

    expect(classifyCodexRenderedState(frame)).toBe('input-ready');
  });
});
