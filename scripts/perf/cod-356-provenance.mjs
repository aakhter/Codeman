import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalJson(value[key])])
  );
}

export function assertRuntimePackageManifestMatches({ branchPointContent, actualContent }) {
  const normalize = (content) => {
    const manifest = JSON.parse(content);
    if (manifest.scripts) delete manifest.scripts['perf:cod356'];
    return JSON.stringify(canonicalJson(manifest));
  };
  const branchPoint = normalize(branchPointContent);
  const actual = normalize(actualContent);
  if (actual !== branchPoint) throw new Error('runtime package manifest does not match branch point');
  return { allowedDifference: 'scripts.perf:cod356 only', normalizedHash: sha256(actual) };
}

export function assertRuntimeTreeMatchesRevision({ branchPointRevision, changedPaths, untrackedPaths }) {
  const differences = [...changedPaths, ...untrackedPaths];
  if (differences.length > 0) {
    throw new Error(
      `runtime tree does not match branch point ${branchPointRevision}: ${differences.sort().join(', ')}`
    );
  }
  return true;
}

export function buildHarnessProvenance({
  branchPointRevision,
  headRevision,
  runtimeTreeHash,
  harnessFiles,
  dirtyHarnessPaths = dirtyTrackedPaths,
  dirtyTrackedPaths,
  ownedPaths,
}) {
  const manifest = harnessFiles
    .map(({ path, content }) => {
      const bytes = Buffer.from(content);
      return { path, bytes: bytes.length, sha256: sha256(bytes) };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  const harnessPathSet = new Set(manifest.map(({ path }) => path));
  const ownedPathSet = new Set(ownedPaths);
  return {
    runtimeRevision: branchPointRevision,
    branchPointRevision,
    runtimeTreeHash,
    headRevision: {
      value: headRevision,
      semantics: 'informational only; not the measured runtime or harness identity',
    },
    harness: {
      algorithm: 'sha256 of sorted path/byte-length/content-sha256 manifest',
      contentHash: sha256(JSON.stringify(manifest)),
      files: manifest,
      dirty: dirtyHarnessPaths.some((path) => harnessPathSet.has(path)),
    },
    outOfScopeTrackedDirtyPaths: dirtyTrackedPaths.filter((path) => !ownedPathSet.has(path)).sort(),
  };
}

export function parseTrackedStatusPaths(output) {
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const value = line.slice(3);
      const renameSeparator = value.indexOf(' -> ');
      return renameSeparator === -1 ? value : value.slice(renameSeparator + 4);
    });
}

function git(root, ...arguments_) {
  return new Promise((resolveOutput, reject) => {
    execFile('git', arguments_, { cwd: root, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${arguments_.join(' ')} failed: ${stderr.trim() || error.message}`));
      else resolveOutput(stdout);
    });
  });
}

export async function collectBenchmarkProvenance({
  root,
  branchPointRevision,
  runtimePaths,
  harnessPaths,
  ownedPaths,
}) {
  const resolvedBranchPoint = (await git(root, 'rev-parse', branchPointRevision)).trim();
  if (resolvedBranchPoint !== branchPointRevision) throw new Error('declared branch point revision did not resolve');
  const changedPaths = (await git(root, 'diff', '--name-only', branchPointRevision, '--', ...runtimePaths))
    .trim()
    .split('\n')
    .filter(Boolean);
  const untrackedPaths = (await git(root, 'ls-files', '--others', '--exclude-standard', '--', ...runtimePaths))
    .trim()
    .split('\n')
    .filter(Boolean);
  assertRuntimeTreeMatchesRevision({ branchPointRevision, changedPaths, untrackedPaths });

  const runtimeManifest = await git(root, 'ls-tree', '-r', branchPointRevision, '--', ...runtimePaths);
  const packageManifestVerification = assertRuntimePackageManifestMatches({
    branchPointContent: await git(root, 'show', `${branchPointRevision}:package.json`),
    actualContent: await readFile(join(root, 'package.json'), 'utf8'),
  });
  const harnessFiles = await Promise.all(
    harnessPaths.map(async (path) => ({ path, content: await readFile(join(root, path)) }))
  );
  const dirtyHarnessPaths = parseTrackedStatusPaths(
    await git(root, 'status', '--porcelain=v1', '--untracked-files=all')
  );
  const dirtyTrackedPaths = parseTrackedStatusPaths(
    await git(root, 'status', '--porcelain=v1', '--untracked-files=no')
  );
  return {
    ...buildHarnessProvenance({
      branchPointRevision,
      headRevision: (await git(root, 'rev-parse', 'HEAD')).trim(),
      runtimeTreeHash: sha256(runtimeManifest),
      harnessFiles,
      dirtyHarnessPaths,
      dirtyTrackedPaths,
      ownedPaths,
    }),
    runtimePaths,
    packageManifestVerification,
    runtimeVerification: 'git diff and untracked-file checks against branch point passed before resource creation',
  };
}
