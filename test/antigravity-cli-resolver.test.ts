/**
 * @fileoverview Tests for the Agy CLI resolver.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const mockedExecSync = vi.mocked(execSync);
const mockedExistsSync = vi.mocked(existsSync);

// Reset module cache between tests so _agyDir caching doesn't bleed
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('resolveAntigravityDir', () => {
  it('returns directory from `which agy` when found in PATH', async () => {
    mockedExecSync.mockReturnValue('/home/user/.local/bin/agy\n');
    mockedExistsSync.mockReturnValue(true);
    const { resolveAntigravityDir } = await import('../src/utils/antigravity-cli-resolver.js');
    expect(resolveAntigravityDir()).toBe('/home/user/.local/bin');
  });

  it('returns null when agy is not found anywhere', async () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error('not found');
    });
    mockedExistsSync.mockReturnValue(false);
    const { resolveAntigravityDir } = await import('../src/utils/antigravity-cli-resolver.js');
    expect(resolveAntigravityDir()).toBeNull();
  });

  it('falls back to common install dirs when `which` fails', async () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error('not found');
    });
    mockedExistsSync.mockImplementation((p) => String(p).endsWith('/.local/bin/agy'));
    const { resolveAntigravityDir } = await import('../src/utils/antigravity-cli-resolver.js');
    const result = resolveAntigravityDir();
    expect(result).toMatch(/\.local\/bin$/);
  });
});

describe('isAntigravityAvailable', () => {
  it('returns true when resolveAntigravityDir returns a path', async () => {
    mockedExecSync.mockReturnValue('/home/user/.local/bin/agy\n');
    mockedExistsSync.mockReturnValue(true);
    const { isAntigravityAvailable } = await import('../src/utils/antigravity-cli-resolver.js');
    expect(isAntigravityAvailable()).toBe(true);
  });

  it('returns false when agy cannot be found', async () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error('not found');
    });
    mockedExistsSync.mockReturnValue(false);
    const { isAntigravityAvailable } = await import('../src/utils/antigravity-cli-resolver.js');
    expect(isAntigravityAvailable()).toBe(false);
  });
});
