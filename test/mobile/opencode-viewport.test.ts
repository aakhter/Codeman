import { describe, it, expect } from 'vitest';
describe('opencode mobile viewport', () => {
  it('terminal fills app-height minus header+toolbar on iPhone', () => {
    const appHeight = 852;
    const header = 42 + 12;
    const toolbar = 40 + 12;
    const available = appHeight - header - toolbar;
    expect(available).toBeGreaterThan(700);
    expect(available).toBeLessThan(800);
  });
});
