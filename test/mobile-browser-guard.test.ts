import { describe, it, expect } from 'vitest';
import { chromiumInstalled, resolveChromiumPath } from './mobile/helpers/browser-available.js';

// COD-99: the default vitest config excludes test/mobile/** when Chromium's binary is
// absent. This guards the pure detection logic that drives that decision, without
// launching a real browser (dependencies are injected).
describe('COD-99 mobile browser-available guard', () => {
  it('reports installed when Playwright resolves a path that exists on disk', () => {
    expect(
      chromiumInstalled(
        () => '/cache/ms-playwright/chromium-1223/chrome',
        () => true
      )
    ).toBe(true);
  });

  it('reports NOT installed when the resolved binary is missing (fresh worktree)', () => {
    // The package is present (path resolves) but the browser binary was never downloaded.
    expect(
      chromiumInstalled(
        () => '/cache/ms-playwright/chromium-1223/chrome',
        () => false
      )
    ).toBe(false);
  });

  it('reports NOT installed when Playwright cannot be resolved at all', () => {
    expect(
      chromiumInstalled(
        () => null,
        () => true
      )
    ).toBe(false);
  });

  it('resolveChromiumPath never throws and returns a string or null', () => {
    const p = resolveChromiumPath();
    expect(p === null || typeof p === 'string').toBe(true);
  });
});
