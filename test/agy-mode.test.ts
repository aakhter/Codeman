/**
 * @fileoverview Schema tests for agy session mode.
 */
import { describe, expect, it } from 'vitest';
import { CreateSessionSchema, QuickStartSchema } from '../src/web/schemas.js';

describe('Agy mode schemas', () => {
  it('accepts agy session creation config', () => {
    const parsed = CreateSessionSchema.parse({
      workingDir: '/tmp',
      mode: 'agy',
      agyConfig: {
        model: 'claude-3-5-sonnet',
      },
    });

    expect(parsed.mode).toBe('agy');
    expect(parsed.agyConfig).toEqual({ model: 'claude-3-5-sonnet' });
  });

  it('accepts agy quick-start config', () => {
    const parsed = QuickStartSchema.parse({
      caseName: 'agy-case',
      mode: 'agy',
      agyConfig: {
        resumeSession: 'latest',
      },
    });

    expect(parsed.mode).toBe('agy');
    expect(parsed.agyConfig?.resumeSession).toBe('latest');
  });

  it('rejects unsafe agy model strings', () => {
    expect(() =>
      CreateSessionSchema.parse({
        workingDir: '/tmp',
        mode: 'agy',
        agyConfig: { model: 'agy; rm -rf /' },
      })
    ).toThrow();
  });

  it('rejects unsafe agy resumeSession strings', () => {
    expect(() =>
      CreateSessionSchema.parse({
        workingDir: '/tmp',
        mode: 'agy',
        agyConfig: { resumeSession: '../../../etc/passwd' },
      })
    ).toThrow();
  });
});
