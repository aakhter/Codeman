import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const findingsPath = resolve(root, 'docs/reports/cod-356/frontend-findings.md');
const reportPaths = [
  resolve(root, 'docs/reports/cod-356/frontend-assets-before.json'),
  resolve(root, 'docs/reports/cod-356/frontend-assets-after.json'),
];

let subject: typeof import('../scripts/perf/cod-356-asset-report.mjs');
const tempRoots: string[] = [];

beforeAll(async () => {
  const argv = process.argv;
  process.argv = [process.execPath, resolve(root, 'test/import-only.mjs')];
  try {
    subject = await import('../scripts/perf/cod-356-asset-report.mjs');
  } finally {
    process.argv = argv;
  }
});

afterAll(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
});

async function tempRoot(label: string) {
  const path = await mkdtemp(join(tmpdir(), `cod356-${label}-`));
  tempRoots.push(path);
  return path;
}

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

describe('COD-356 asset profiler contracts', () => {
  it('validates required option values and sample counts before launch', () => {
    expect(() => subject.parseArgs(['--runtime-root'])).toThrow('--runtime-root requires a value');
    expect(() => subject.parseArgs(['--runtime-revision'])).toThrow('--runtime-revision requires a value');
    expect(() => subject.parseArgs(['--runtime-root', root])).toThrow('--runtime-revision is required');
    expect(() =>
      subject.parseArgs(['--runtime-root', root, '--runtime-revision', 'a'.repeat(40), '--samples', '0'])
    ).toThrow('samples must be a positive integer');
  });

  it('rejects mismatched revisions and tracked runtime changes', async () => {
    const repository = await tempRoot('provenance');
    git(repository, 'init', '-q');
    git(repository, 'config', 'user.email', 'cod356@example.invalid');
    git(repository, 'config', 'user.name', 'COD-356');
    writeFileSync(join(repository, 'tracked.txt'), 'clean\n');
    git(repository, 'add', 'tracked.txt');
    git(repository, 'commit', '-m', 'fixture');
    const revision = git(repository, 'rev-parse', 'HEAD');

    await expect(subject.verifyRuntimeProvenance(repository, '0'.repeat(40))).rejects.toThrow(
      'runtime revision mismatch'
    );
    writeFileSync(join(repository, 'tracked.txt'), 'dirty\n');
    await expect(subject.verifyRuntimeProvenance(repository, revision)).rejects.toThrow(
      'runtime root has tracked changes'
    );
  });

  it('summarizes every sample and labels the navigation plus post-ready observation window', () => {
    const sample = (appLoadedAt: number, durationMs: number) => ({
      appLoadedAt,
      domContentLoadedMs: appLoadedAt - 20,
      loadMs: appLoadedAt + 10,
      longTasks: [{ durationMs }],
      assets: [
        {
          path: '/asset.js',
          decodedBytes: 100,
          rawBytes: 100,
          gzipBytes: 80,
          brotliBytes: 70,
          startTimeMs: 1,
          responseEndMs: 2,
          parseEvaluateMs: 3,
          requiredBeforeAppLoaded: true,
        },
      ],
    });
    const result = subject.summarizeProfileSamples([sample(100, 60), sample(110, 80), sample(120, 70)]);

    expect(result.appLoadedMs).toMatchObject({ count: 3, median: 110, p95: 120 });
    expect(result.navigationPlusPostReadyLongTaskTotalDurationMs).toMatchObject({ median: 70, p95: 80 });
    expect(result.observationWindow).toEqual({ start: 'navigationStart', end: 'appLoadedAt + 500ms' });
    expect(result.assets['/asset.js'].sampleCount).toBe(3);
  });

  it('refuses publication before verified cleanup and leaves no partial output', async () => {
    const directory = await tempRoot('publication-refusal');
    const output = join(directory, 'report.json');
    await expect(
      subject.publishReport({
        output,
        report: { schemaVersion: 3 },
        cleanup: { browserClosed: true, childStopped: false, tempRootRemoved: true },
      })
    ).rejects.toThrow('incomplete profiler cleanup');
    expect(existsSync(output)).toBe(false);
    expect(readdirSync(directory)).toEqual([]);
  });

  it('publishes atomically after cleanup and removes a temporary file when rename fails', async () => {
    const directory = await tempRoot('atomic-publication');
    const output = join(directory, 'report.json');
    const cleanup = { browserClosed: true, childStopped: true, tempRootRemoved: true };
    await subject.publishReport({ output, report: { schemaVersion: 3 }, cleanup });
    expect(JSON.parse(await readFile(output, 'utf8'))).toEqual({ schemaVersion: 3 });
    expect(readdirSync(directory)).toEqual(['report.json']);

    const invalidOutput = join(directory, 'occupied');
    await mkdir(invalidOutput);
    await expect(subject.publishReport({ output: invalidOutput, report: {}, cleanup })).rejects.toThrow();
    expect(readdirSync(directory).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });

  it('binds reports to the exact profiler, repository state, and dependency inputs', async () => {
    const provenance = await subject.collectProfilerProvenance(root);
    expect(provenance.toolRepository).toMatchObject({
      headRevision: expect.stringMatching(/^[0-9a-f]{40}$/),
      headTree: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
    expect(provenance.dependencies).toMatchObject({
      node: process.version,
      playwright: expect.any(String),
    });
    for (const file of provenance.files) {
      const content = readFileSync(resolve(root, file.path));
      expect(file.bytes).toBe(content.byteLength);
      expect(file.sha256).toBe(createHash('sha256').update(content).digest('hex'));
    }
    expect(provenance.files.map((file) => file.path)).toEqual([
      'package-lock.json',
      'package.json',
      'scripts/perf/cod-356-asset-report.mjs',
    ]);

    for (const reportPath of reportPaths) {
      const report = JSON.parse(readFileSync(reportPath, 'utf8'));
      expect(report.schemaVersion).toBe(3);
      expect(report.profilerProvenance.contentHash).toBe(provenance.contentHash);
      expect(report.profilerProvenance.files).toEqual(provenance.files);
      expect(report.profilerProvenance.dependencies).toEqual(provenance.dependencies);
    }
  });

  it('states that the 4x5 matrix is longitudinal and uses exact paired profiles for causal rejection', () => {
    const findings = readFileSync(findingsPath, 'utf8');
    expect(findings).toContain('longitudinal comparison is confounded by intervening Task 2 and Task 3 changes');
    expect(findings).toMatch(/Causal rejection relies on the exact\s+`063880d7` versus `ef38287c` 5x4 profiles/);
    expect(findings).toContain('navigation plus 500ms post-ready observation window');
  });
});
