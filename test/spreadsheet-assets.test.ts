/** @fileoverview COD-280 local spreadsheet-preview asset delivery contracts. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('COD-280 spreadsheet preview assets', () => {
  it('pins the browser parser dependencies exactly', () => {
    const pkg = JSON.parse(read('package.json')) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies?.exceljs).toBe('4.4.0');
    expect(pkg.dependencies?.fflate).toBe('0.8.2');
  });

  it('prepares local vendor bundles for development and production', () => {
    const postinstall = read('scripts/postinstall.js');
    const build = read('scripts/build.mjs');
    const prepare = read('scripts/prepare-spreadsheet-assets.mjs');

    for (const source of [postinstall, build]) {
      expect(source).toContain('prepare-spreadsheet-assets.mjs');
    }
    expect(prepare).toContain('exceljs.min.js');
    expect(prepare).toContain('fflate.min.js');
    expect(prepare).toContain('sourceMappingURL');
  });

  it('checks the combined size budget and content-derived asset version', () => {
    const check = read('scripts/check-public-assets.mjs');
    expect(check).toContain('SPREADSHEET_VENDOR_MAX_BYTES');
    expect(check).toContain('1_100_000');
    expect(check).toContain('SPREADSHEET_ASSET_VERSION');
    expect(check).toContain('spreadsheet-preview-worker.js');
    expect(check).toContain('exceljs.min.js');
    expect(check).toContain('fflate.min.js');
    expect(check).toContain("createHash('sha256')");
  });
});
