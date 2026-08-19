/**
 * @fileoverview Tests for the Antigravity CLI resolver wrapper.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAntigravityResolverForTest } from '../src/utils/antigravity-cli-resolver.js';
import type { CliResolverHost } from '../src/utils/cli-executable-resolver.js';

function createHost(
  options: {
    processPathResult?: string | null;
    loginShellResults?: Array<string | null>;
    existingPaths?: string[];
  } = {}
): CliResolverHost {
  const loginShellResults = [...(options.loginShellResults ?? [])];
  const existingPaths = new Set(options.existingPaths ?? []);
  return {
    processPath: '/service/bin',
    shellPath: '/bin/zsh',
    shellArgs: ['-l'],
    findOnProcessPath: () => options.processPathResult ?? null,
    findInLoginShell: () => loginShellResults.shift() ?? null,
    exists: (path) => existingPaths.has(path),
  };
}

describe('Antigravity CLI resolver', () => {
  it('resolves agy from the service PATH', () => {
    const binaryPath = '/service/bin/agy';
    const resolver = createAntigravityResolverForTest(
      createHost({ processPathResult: binaryPath, existingPaths: [binaryPath] })
    );

    expect(resolver.resolve()?.directory).toBe('/service/bin');
  });

  it('falls back to a common install directory', () => {
    const binaryPath = join(homedir(), '.local', 'bin', 'agy');
    const resolver = createAntigravityResolverForTest(createHost({ existingPaths: [binaryPath] }));

    expect(resolver.resolve()?.directory).toBe(join(homedir(), '.local', 'bin'));
  });

  it('resolves agy found only by the login shell', () => {
    const binaryPath = '/login-shell/bin/agy';
    const resolver = createAntigravityResolverForTest(
      createHost({ loginShellResults: [binaryPath], existingPaths: [binaryPath] })
    );

    expect(resolver.resolve()?.directory).toBe('/login-shell/bin');
  });

  it('returns null when agy is unavailable', () => {
    const resolver = createAntigravityResolverForTest(createHost());

    expect(resolver.resolve()).toBeNull();
  });

  it('retries a failed lookup and caches the first successful login-shell discovery', () => {
    const binaryPath = '/late-login-shell/bin/agy';
    const resolver = createAntigravityResolverForTest(
      createHost({ loginShellResults: [null, binaryPath], existingPaths: [binaryPath] })
    );

    expect(resolver.resolve()).toBeNull();
    expect(resolver.resolve()?.binaryPath).toBe(binaryPath);
    expect(resolver.resolve()?.binaryPath).toBe(binaryPath);
  });
});
