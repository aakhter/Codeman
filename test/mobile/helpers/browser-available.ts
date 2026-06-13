import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

/**
 * Detect whether Playwright's Chromium browser binary is actually installed.
 *
 * COD-99: a fresh `npm install` pulls the `playwright` package but NOT the browser
 * binaries, so the `test/mobile/**` suite (which launches a real Chromium via
 * `helpers/browser.ts`) errors ~280× with "browserType.launch: Executable doesn't
 * exist". The default `config/vitest.config.ts` uses this to exclude that suite with a
 * clear message instead, so a browser-less `npm test` is clean (CI already excludes it).
 *
 * The check honors `PLAYWRIGHT_BROWSERS_PATH` automatically because it resolves through
 * Playwright's own `chromium.executablePath()` (the authoritative, version-pinned path),
 * then confirms the binary exists on disk.
 */

/** Resolve Playwright's expected Chromium executable path, or null if playwright can't load. */
export function resolveChromiumPath(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const { chromium } = require('playwright') as typeof import('playwright');
    return chromium.executablePath() || null;
  } catch {
    return null;
  }
}

/**
 * True iff Playwright's Chromium binary is present on disk.
 * Dependencies are injectable so the pure logic is unit-testable without a real browser.
 */
export function chromiumInstalled(
  resolve: () => string | null = resolveChromiumPath,
  exists: (p: string) => boolean = existsSync
): boolean {
  const path = resolve();
  return Boolean(path) && exists(path as string);
}
