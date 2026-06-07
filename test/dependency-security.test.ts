import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');

type PackageLockPackage = {
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

type PackageLock = {
  packages: Record<string, PackageLockPackage>;
};

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(resolve(root, relativePath), 'utf8')) as T;
}

function compareVersions(actual: string, expected: string): number {
  const actualParts = actual.split('.').map((part) => Number(part.replace(/\D.*/, '')) || 0);
  const expectedParts = expected.split('.').map((part) => Number(part.replace(/\D.*/, '')) || 0);
  for (let i = 0; i < Math.max(actualParts.length, expectedParts.length); i++) {
    const left = actualParts[i] ?? 0;
    const right = expectedParts[i] ?? 0;
    if (left > right) return 1;
    if (left < right) return -1;
  }
  return 0;
}

function packageNameFromLockPath(lockPath: string): string | null {
  const parts = lockPath.split('node_modules/');
  if (parts.length < 2) return null;
  return parts[parts.length - 1] ?? null;
}

function lockedVersions(lock: PackageLock, packageName: string): string[] {
  const versions = new Set<string>();
  for (const [lockPath, pkg] of Object.entries(lock.packages)) {
    if (packageNameFromLockPath(lockPath) === packageName && pkg.version) {
      versions.add(pkg.version);
    }
  }
  return [...versions].sort();
}

function expectEveryLockedVersionAtLeast(lock: PackageLock, packageName: string, minimum: string): void {
  const versions = lockedVersions(lock, packageName);
  expect(versions, `${packageName} should be present in package-lock.json`).not.toHaveLength(0);
  for (const version of versions) {
    expect(
      compareVersions(version, minimum),
      `${packageName}@${version} should be >= ${minimum}`
    ).toBeGreaterThanOrEqual(0);
  }
}

function expectNoVulnerableVite(lock: PackageLock): void {
  const versions = lockedVersions(lock, 'vite');
  expect(versions, 'vite should be present in package-lock.json').not.toHaveLength(0);
  for (const version of versions) {
    const major = Number(version.split('.')[0]);
    if (major === 6) {
      expect(compareVersions(version, '6.4.2'), `vite@${version} should be >= 6.4.2`).toBeGreaterThanOrEqual(0);
    } else if (major === 7) {
      expect(compareVersions(version, '7.3.2'), `vite@${version} should be >= 7.3.2`).toBeGreaterThanOrEqual(0);
    } else {
      expect(major, `vite@${version} should be on a supported patched major`).toBeGreaterThanOrEqual(8);
    }
  }
}

function expectNoVulnerablePicomatch(lock: PackageLock): void {
  const versions = lockedVersions(lock, 'picomatch');
  expect(versions, 'picomatch should be present in package-lock.json').not.toHaveLength(0);
  for (const version of versions) {
    const major = Number(version.split('.')[0]);
    if (major === 2) {
      expect(compareVersions(version, '2.3.2'), `picomatch@${version} should be >= 2.3.2`).toBeGreaterThanOrEqual(0);
    } else if (major === 4) {
      expect(compareVersions(version, '4.0.4'), `picomatch@${version} should be >= 4.0.4`).toBeGreaterThanOrEqual(0);
    }
  }
}

describe('dependency security policy', () => {
  it('keeps direct security-sensitive dependency ranges on patched versions', () => {
    const rootPackage = readJson<PackageLockPackage>('package.json');
    const xtermPackage = readJson<PackageLockPackage>('packages/xterm-zerolag-input/package.json');

    expect(rootPackage.dependencies?.fastify).toBe('^5.8.5');
    expect(rootPackage.devDependencies?.vitest).toBe('^4.1.8');
    expect(rootPackage.devDependencies?.['@vitest/coverage-v8']).toBe('^4.1.8');
    expect(xtermPackage.devDependencies?.vitest).toBe('^4.1.8');
  });

  it('keeps critical and high audit findings resolved in the lockfile', () => {
    const lock = readJson<PackageLock>('package-lock.json');

    expectEveryLockedVersionAtLeast(lock, 'vitest', '4.1.0');
    expectEveryLockedVersionAtLeast(lock, '@vitest/coverage-v8', '4.1.0');
    expectEveryLockedVersionAtLeast(lock, 'fastify', '5.8.5');
    expectEveryLockedVersionAtLeast(lock, 'fast-uri', '3.1.2');
    expectEveryLockedVersionAtLeast(lock, 'basic-ftp', '5.3.1');
    expectEveryLockedVersionAtLeast(lock, 'flatted', '3.4.2');
    expectNoVulnerableVite(lock);
    expectNoVulnerablePicomatch(lock);
  });

  it('keeps standalone workspace lockfiles on patched test tooling', () => {
    const lock = readJson<PackageLock>('packages/xterm-zerolag-input/package-lock.json');

    expect(lock.packages['']?.devDependencies?.vitest).toBe('^4.1.8');
    expectEveryLockedVersionAtLeast(lock, 'vitest', '4.1.0');
    expectNoVulnerableVite(lock);
    expectNoVulnerablePicomatch(lock);
  });
});
