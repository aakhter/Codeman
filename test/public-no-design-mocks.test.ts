/**
 * @fileoverview Design mocks must not ship as static assets (COD-537).
 *
 * Everything under src/web/public/ is copied into dist and served by the web
 * server, so a mock page dropped there goes to production. Mocks live in
 * docs/design/ instead.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PUBLIC_DIR = join(__dirname, '..', 'src', 'web', 'public');

describe('public assets carry no design mocks', () => {
  it('has no mocks directory under src/web/public', () => {
    expect(existsSync(join(PUBLIC_DIR, 'mocks'))).toBe(false);
  });

  it('keeps the moved mocks under docs/design', () => {
    const moved = readdirSync(join(__dirname, '..', 'docs', 'design', 'mobile-tabs-mocks'));
    expect(moved).toContain('index.html');
  });
});
