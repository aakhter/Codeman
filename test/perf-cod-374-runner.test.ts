import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  adaptTask3Artifact,
  calibrateProcessStartWindow,
  canonicalizeRenderedIndexHtml,
  materializeVerifiedRuntimeOverlay,
  provisionRuntimeDependencies,
  provisionRuntimeVendorAssets,
  readTerminalFontPx,
  runPhaseBProducer,
  verifyServedRuntimeAssets,
  verifyProvisionedRuntimeDependencies,
  verifyProvisionedRuntimeVendorAssets,
} from '../scripts/perf/cod-374-runner.mjs';
import {
  awaitPhaseBAppReadiness,
  finishResizeCollection,
  focusPhaseBRuntime,
  launchConcretePhaseBRuntime,
  measureBrowserQuiescence,
} from '../scripts/perf/cod-374-playwright-runtime.js';
import { validateBrowserQuiescence } from '../scripts/perf/cod-374-quiescence.mjs';
import {
  CANDIDATE_PRODUCT,
  deriveSampleEvidence,
  HARNESS_FILES,
  OVERLAY_FILES,
} from '../scripts/perf/cod-374-summarize.mjs';
import { createMobileInputTraceCollector } from '../src/perf/mobile-input-trace.js';
import {
  Cod370OpenCodeFixture,
  FatalFixtureProbeError,
  chooseOpenCodeCandidate,
  waitForFixture,
} from './utils/cod370-opencode-fixture.js';
import {
  BROWSER_INPUT_STAGES,
  BROWSER_VISIBILITY_STAGES,
  armBrowserLatencyTrial,
  completeBrowserLatencyWindow,
  installBrowserLatencyHooks,
  installBrowserLatencyInitScript,
  readBrowserLatencyTrace,
  validateBrowserLatencyTrace,
  type BrowserLatencyEvent,
} from './utils/cod374-latency-trace.js';

const token = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);
const hash64 = (value: string) => createHash('sha256').update(value).digest('hex');
const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function actualTask3Artifact() {
  const clientId = '123e4567-e89b-42d3-a456-426614174000';
  const clockId = 'page-123e4567-e89b-42d3-a456-426614174000';
  const trialId = 'cod374-phaseb';
  let atMs = 0;
  const browserEvents: BrowserLatencyEvent[] = [];
  for (const [inputIndex, value] of ['q', 'qz', 'qz1'].entries()) {
    const context = {
      clock: 'browser' as const,
      clockId,
      trialId,
      generation: inputIndex + 1,
      inputIndex,
      tokenHash: token(value),
      tokenLength: value.length,
    };
    for (const stage of BROWSER_INPUT_STAGES) {
      browserEvents.push({
        ...context,
        stage,
        atMs: ++atMs,
        ...([
          'browser.durable-queued',
          'browser.ws-input-send',
          'browser.ws-input-send-return',
          'browser.ws-input-ack',
        ].includes(stage)
          ? { clientId, seq: 100 + inputIndex }
          : {}),
      });
    }
    if (inputIndex < 2) {
      browserEvents.push({
        ...context,
        stage: 'browser.generation-incomplete',
        atMs: ++atMs,
        incompleteReason: 'coalesced-before-exact-visibility',
      });
    }
  }
  const global = {
    clock: 'browser' as const,
    clockId,
    trialId,
    generation: 0,
    inputIndex: 0,
    tokenHash: token('qz1'),
    tokenLength: 3,
  };
  browserEvents.push(
    { ...global, stage: 'browser.ws-output-receive', atMs: ++atMs, ordinal: 1, valueHash: token('frame'), bytes: 5 },
    { ...global, stage: 'browser.output-handler', atMs: ++atMs, ordinal: 1 },
    { ...global, stage: 'browser.write-queued', atMs: ++atMs, ordinal: 1 },
    { ...global, stage: 'browser.xterm-write', atMs: ++atMs, ordinal: 1, writeId: 1, bytes: 5 },
    { ...global, stage: 'browser.xterm-write-return', atMs: ++atMs, ordinal: 1, writeId: 1, bytes: 5 },
    { ...global, stage: 'browser.xterm-write-callback', atMs: ++atMs, ordinal: 1, writeId: 1, bytes: 5 },
    { ...global, stage: 'browser.xterm-parsed', atMs: ++atMs, ordinal: 1, writeId: 1 },
    ...BROWSER_VISIBILITY_STAGES.map((stage) => ({
      clock: 'browser' as const,
      clockId,
      trialId,
      generation: 3,
      inputIndex: 2,
      tokenHash: token('qz1'),
      tokenLength: 3,
      stage,
      atMs: ++atMs,
      ordinal: 1,
      writeId: 1,
      attributedGeneration: 3,
      attributedInputIndex: 2,
    }))
  );
  const serverEvents = [
    'server.input.received',
    'server.input.parsed',
    'server.input.deduped',
    'server.input.activated',
    'server.input.pre-write',
    'server.input.post-write',
    'server.input.pre-ack',
    'server.input.post-ack',
  ].map((stage, index) => ({
    stage,
    monoNs: String(index + 1),
    clientId,
    seq: 100,
    connectionHash: '1111111111111111',
    sessionHash: '2222222222222222',
    ordinal: index + 1,
    ...(stage === 'server.input.deduped' ? { applied: true } : {}),
    ...(stage === 'server.input.post-write' ? { delivered: true } : {}),
  }));
  return {
    schemaVersion: 1,
    browserEvents,
    serverEvents,
    paneResults: ['q', 'qz', 'qz1'].map((value, inputIndex) => ({
      inputIndex,
      tokenHash: token(value),
      tokenLength: value.length,
      status: inputIndex === 2 ? 'visible' : 'incomplete',
      errorHash: inputIndex === 2 ? null : '3333333333333333',
      probes: [
        { startedNs: '1', completedNs: '2', present: false, durationMs: 0.1, errorHash: null },
        {
          startedNs: '3',
          completedNs: '4',
          present: inputIndex === 2,
          durationMs: 0.1,
          errorHash: null,
        },
      ],
    })),
    longTaskWindow: { startedMs: 0, endedMs: atMs, entries: [] },
    resizeEvents: [],
  };
}

function phaseBPlan() {
  const assetSha = hash64('asset');
  return {
    schemaVersion: 2,
    phase: 'calibration',
    experimentId: '1234567890abcdef',
    config: {
      label: 'trace-off',
      repetition: 1,
      traceEnabled: false,
      rates: [1, 4],
      samplesPerCell: 10,
      viewport: { width: 390, height: 844 },
      fontPx: 9,
      payloadHash: token('qz1'),
      payloadLength: 3,
    },
    provenance: {
      product: { ...CANDIDATE_PRODUCT },
      harness: {
        commit: 'a'.repeat(40),
        tree: 'b'.repeat(40),
        dirty: false,
        files: HARNESS_FILES.map((file) => ({ file, blob: 'c'.repeat(40), sha256: 'd'.repeat(64) })),
      },
      overlay: {
        semanticSha256: 'e'.repeat(64),
        patchSha256: 'f'.repeat(64),
        files: OVERLAY_FILES.map((file) => ({ file, mode: '100644', sha256: '1'.repeat(64) })),
        manifestSha256: '2'.repeat(64),
        servedAssets: ['/', '/app.js', '/styles.css'].map((path) => ({ path, sha256: assetSha })),
      },
      dependencies: {
        packageLockSha256: '3'.repeat(64),
        vendorManifestSha256: '4'.repeat(64),
        dependencyRootHash: '5'.repeat(64),
        dependencyContentHash: '6'.repeat(64),
        dependencyDevice: '64512',
        dependencyInode: '2951130',
      },
      runtimeVendorHash: null,
      host: {
        hostnameHash: '1111111111111111',
        cpuModelHash: '2222222222222222',
        cpuCount: 8,
        platform: 'linux',
        releaseHash: '3333333333333333',
        nodeVersionHash: '4444444444444444',
        opencodeVersionHash: token('fixture'),
      },
      process: {
        runId: '5555555555555555',
        tmuxSessionHash: '6666666666666666',
        tempRootHash: '7777777777777777',
        server: { pid: 1001, startedAt: '2026-08-24T00:00:00.100Z', startIdentity: '1', startUncertaintyMs: 10 },
        browser: { pid: 1002, startedAt: '2026-08-24T00:00:00.200Z', startIdentity: '2', startUncertaintyMs: 10 },
        opencode: { pid: 1003, startedAt: '2026-08-24T00:00:00.300Z', startIdentity: '3', startUncertaintyMs: 10 },
      },
    },
    timing: {
      startedAt: '2026-08-24T00:00:00.000Z',
      endedAt: '2026-08-24T00:01:00.000Z',
      loadAverageBefore: [0.1, 0.2, 0.3],
      loadAverageAfter: [0.1, 0.2, 0.3],
    },
    clock: {
      mode: 'component-local',
      browserClockId: 'page-123e4567-e89b-42d3-a456-426614174000',
      serverClockId: '8888888888888888',
      harnessClockId: '9999999999999999',
    },
    selection: { attempt: 1, lifecycle: 'completed', accepted: true, failureReasons: [] },
    cells: [],
    diagnostics: {
      traceOverflowed: false,
      observerErrorHashes: [],
      pageErrorHashes: [],
      consoleErrorHashes: [],
      processReplaced: false,
      resizeEvents: [],
      longTasks: [],
      errorHashes: [],
      serverStdoutHashes: [],
      serverStderrHashes: [],
      startupStageHashes: [],
      startupNameHashes: [],
      startupMessageHashes: [],
    },
    allocation: {
      browserClosed: true,
      serverStopped: true,
      tmuxRemoved: true,
      tempRootRemoved: true,
      hooksRestored: true,
      listenersDisposed: true,
    },
    cleanup: {
      browserClosed: true,
      serverStopped: true,
      tmuxRemoved: true,
      tempRootRemoved: true,
      hooksRestored: true,
      listenersDisposed: true,
    },
  };
}

function hostQuiescenceEvidence(passed = true) {
  return {
    cpuCount: 8,
    sampleCount: 11,
    sampleIntervalMs: 500,
    startedAtMs: 0,
    endedAtMs: 5_000,
    sampleTimesMs: Array.from({ length: 11 }, (_, index) => index * 500),
    idlePercent: passed ? 90 : 79,
    firstLoad1: 1,
    finalLoad1: 1,
    processes: [],
    measurementErrorHash: null,
    passed,
  };
}

function browserQuiescenceEvidence(passed = true) {
  const driftsMs = Array.from({ length: 50 }, () => (passed ? 1 : 11));
  return {
    tickCount: 50,
    timerIntervalMs: 20,
    driftsMs,
    p95DriftMs: passed ? 1 : 11,
    maxDriftMs: passed ? 1 : 11,
    longTaskDurationsMs: [],
    pageErrorHashes: [],
    consoleErrorHashes: [],
    resizeCount: 0,
    overflowed: false,
    measurementErrorHash: null,
    passed,
  };
}

async function gateProducerFixture({
  experimentRoot,
  runtimeRoot,
  calls,
  hostEvidence = hostQuiescenceEvidence(),
  browserEvidence = browserQuiescenceEvidence(),
  hostError,
  browserError,
  runtimeCleanupError,
  repositoryError,
  processReplacementAfterGate = false,
  processReadErrorAfterGate,
  runtimeCleanupResult = 'complete',
}: {
  experimentRoot: string;
  runtimeRoot: string;
  calls: string[];
  hostEvidence?: ReturnType<typeof hostQuiescenceEvidence>;
  browserEvidence?: ReturnType<typeof browserQuiescenceEvidence>;
  hostError?: Error;
  browserError?: Error;
  runtimeCleanupError?: Error;
  repositoryError?: Error;
  processReplacementAfterGate?: boolean;
  processReadErrorAfterGate?: Error;
  runtimeCleanupResult?: 'complete' | 'undefined' | 'missing' | 'false' | 'malformed';
}) {
  const plan = phaseBPlan();
  const launchedAt = new Date(Date.now() - 1_000).toISOString();
  let runtimeCleanupCalls = 0;
  let overlayCleanupCalls = 0;
  let captureCalls = 0;
  let processReads = 0;
  const options = {
    experimentRoot,
    repositoryRoot: '/repo',
    vendorManifestPath: '/repo/vendor.json',
    repetition: plan,
    overlayArtifact: { ...plan.provenance.overlay, product: plan.provenance.product },
    testAdapters: {
      gitVerifier: async () => {
        calls.push('repository-preflight');
        if (repositoryError) throw repositoryError;
      },
      measureHostQuiescence: async () => {
        calls.push('host-quiescence');
        if (hostError) throw hostError;
        return hostEvidence;
      },
      materialize: async () => {
        calls.push('overlay-materialize');
        return {
          root: runtimeRoot,
          files: plan.provenance.overlay.files,
          manifestSha256: plan.provenance.overlay.manifestSha256,
          cleanup: async () => {
            calls.push('overlay-cleanup');
            overlayCleanupCalls += 1;
          },
        };
      },
      provisionDependencies: async () => {
        calls.push('dependency-provision');
        return {
          dependencyRootHash: plan.provenance.dependencies.dependencyRootHash,
          dependencyContentHash: plan.provenance.dependencies.dependencyContentHash,
          dependencyDevice: plan.provenance.dependencies.dependencyDevice,
          dependencyInode: plan.provenance.dependencies.dependencyInode,
        };
      },
      verifyProvisionedDependencies: async () => ({
        dependencyRootHash: plan.provenance.dependencies.dependencyRootHash,
        dependencyContentHash: plan.provenance.dependencies.dependencyContentHash,
        dependencyDevice: plan.provenance.dependencies.dependencyDevice,
        dependencyInode: plan.provenance.dependencies.dependencyInode,
      }),
      provisionVendorAssets: async () => {
        calls.push('vendor-provision');
        return { vendorRuntimeHash: '7'.repeat(64) };
      },
      verifyProvisionedVendorAssets: async () => ({ vendorRuntimeHash: '7'.repeat(64) }),
      verifyServedAssets: async () => {
        calls.push('asset-readiness');
      },
      procIdentity: async (pid: number) => {
        processReads += 1;
        if (processReads > 3 && processReadErrorAfterGate) throw processReadErrorAfterGate;
        return {
          pid,
          startIdentity: processReplacementAfterGate && processReads > 3 && pid === 1001 ? '9999' : String(pid),
          startedAt: launchedAt,
          startUncertaintyMs: 10,
          cwd: runtimeRoot,
          cmdlineHash: token(String(pid)),
          cmdline:
            pid === 1001
              ? 'node src/index.ts web --host 127.0.0.1'
              : pid === 1003
                ? 'opencode --serve'
                : 'chromium --headless',
        };
      },
      launch: async () => {
        calls.push('runtime-launch');
        return {
          runtimeRoot,
          serverPid: 1001,
          browserPid: 1002,
          opencodePid: 1003,
          baseUrl: 'http://127.0.0.1:3000',
          launchedAt,
          fetch: async () => new Response('asset'),
          page: {
            evaluate: async (callback: () => unknown) => {
              calls.push(String(callback).includes('innerWidth') ? 'viewport-readiness' : 'font-readiness');
              return String(callback).includes('innerWidth') ? { width: 390, height: 844 } : 9;
            },
          },
          opencodeVersion: async () => {
            calls.push('opencode-readiness');
            return 'fixture';
          },
          identities: async () => {
            calls.push('identity-readiness');
            return { tmuxSession: 'tmux-fixture', tempRoot: runtimeRoot };
          },
          measureBrowserQuiescence: async () => {
            calls.push('browser-quiescence');
            if (browserError) throw browserError;
            return browserEvidence;
          },
          captureRepetition: async () => {
            calls.push('capture-repetition');
            captureCalls += 1;
            return [];
          },
          diagnostics: async () => ({ pageErrorHashes: [], consoleErrorHashes: [], processReplaced: false }),
          cleanup: async () => {
            calls.push('runtime-cleanup');
            runtimeCleanupCalls += 1;
            const cleanupProof = {
              browserClosed: true,
              serverStopped: true,
              tmuxRemoved: true,
              tempRootRemoved: true,
              hooksRestored: true,
              listenersDisposed: true,
            };
            if (runtimeCleanupError) throw Object.assign(runtimeCleanupError, { cleanupProof });
            if (runtimeCleanupResult === 'undefined') return undefined;
            if (runtimeCleanupResult === 'missing') {
              const { listenersDisposed: _omitted, ...missing } = cleanupProof;
              return missing;
            }
            if (runtimeCleanupResult === 'false') return { ...cleanupProof, browserClosed: false };
            if (runtimeCleanupResult === 'malformed') return { ...cleanupProof, browserClosed: 'yes' };
            return cleanupProof;
          },
        };
      },
    },
  };
  return {
    options,
    plan,
    counts: () => ({ runtimeCleanupCalls, overlayCleanupCalls, captureCalls }),
  };
}

describe('COD-374 Phase B producer contracts', () => {
  it('measures the exact terminal option instead of inherited xterm root CSS', async () => {
    const originalWindow = (globalThis as any).window;
    const originalDocument = (globalThis as any).document;
    const originalGetComputedStyle = (globalThis as any).getComputedStyle;
    const terminal = { options: { fontSize: 9 } };
    (globalThis as any).window = { app: { terminal } };
    (globalThis as any).document = { querySelector: () => ({}) };
    (globalThis as any).getComputedStyle = () => ({ fontSize: '16px' });
    const page = { evaluate: async (callback: () => unknown) => callback() } as any;
    try {
      await expect(readTerminalFontPx(page)).resolves.toBe(9);
      for (const invalid of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, '9']) {
        terminal.options.fontSize = invalid as never;
        await expect(readTerminalFontPx(page)).rejects.toThrow(/terminal font/i);
      }
    } finally {
      (globalThis as any).window = originalWindow;
      (globalThis as any).document = originalDocument;
      (globalThis as any).getComputedStyle = originalGetComputedStyle;
    }
  });

  it('provisions only the exact hash-bound ignored vendor files and detects mutation or symlink escape', async () => {
    const container = await mkdtemp(join(tmpdir(), 'cod374-runtime-vendor-'));
    temporaryRoots.push(container);
    const repositoryRoot = join(container, 'repository');
    const runtimeRoot = join(container, 'runtime');
    const vendorDirectory = join('src', 'web', 'public', 'vendor');
    await mkdir(join(repositoryRoot, vendorDirectory), { recursive: true });
    await mkdir(join(runtimeRoot, vendorDirectory), { recursive: true });
    const files = [
      'dompurify.min.js',
      'exceljs.min.js',
      'fflate.min.js',
      'marked.min.js',
      'xterm-addon-fit.min.js',
      'xterm-addon-serialize.min.js',
      'xterm-addon-unicode11.min.js',
      'xterm-addon-webgl.min.js',
      'xterm-predictive-echo.js',
      'xterm-zerolag-input.js',
      'xterm.css',
      'xterm.min.js',
    ].map((name) => `src/web/public/vendor/${name}`);
    const manifest = { schemaVersion: 1, files: [] as Array<{ file: string; sha256: string }> };
    for (const file of files) {
      const contents = `fixture:${file}\n`;
      await writeFile(join(repositoryRoot, file), contents);
      if (file.endsWith('/dompurify.min.js') || file.endsWith('/marked.min.js')) {
        await writeFile(join(runtimeRoot, file), contents);
      }
      manifest.files.push({ file, sha256: hash64(contents) });
    }
    const manifestPath = join(container, 'vendor.json');
    const manifestBytes = JSON.stringify(manifest);
    await writeFile(manifestPath, manifestBytes);
    const options = {
      runtimeRoot,
      repositoryRoot,
      vendorManifestPath: manifestPath,
      expectedManifestSha256: hash64(manifestBytes),
    };
    const proof = await provisionRuntimeVendorAssets(options);
    expect(proof).toEqual({ vendorRuntimeHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect((await lstat(join(runtimeRoot, 'src/web/public/vendor/xterm.min.js'))).isSymbolicLink()).toBe(true);
    await expect(verifyProvisionedRuntimeVendorAssets({ ...options, expectedProof: proof })).resolves.toEqual(proof);
    await writeFile(join(repositoryRoot, 'src/web/public/vendor/xterm.min.js'), 'mutated\n');
    await expect(verifyProvisionedRuntimeVendorAssets({ ...options, expectedProof: proof })).rejects.toThrow(
      /vendor.*changed|hash/i
    );
    await writeFile(
      join(repositoryRoot, 'src/web/public/vendor/xterm.min.js'),
      'fixture:src/web/public/vendor/xterm.min.js\n'
    );
    await rm(join(runtimeRoot, 'src/web/public/vendor/xterm.min.js'));
    await symlink('/etc/passwd', join(runtimeRoot, 'src/web/public/vendor/xterm.min.js'));
    await expect(verifyProvisionedRuntimeVendorAssets({ ...options, expectedProof: proof })).rejects.toThrow(
      /vendor.*target|vendor.*symlink/i
    );
  });

  it('rejects unknown, duplicate, and escaping vendor runtime entries', async () => {
    const container = await mkdtemp(join(tmpdir(), 'cod374-runtime-vendor-invalid-'));
    temporaryRoots.push(container);
    const manifestPath = join(container, 'vendor.json');
    const invalid = JSON.stringify({
      schemaVersion: 1,
      files: [
        { file: 'src/web/public/vendor/xterm.min.js', sha256: 'a'.repeat(64) },
        { file: 'src/web/public/vendor/xterm.min.js', sha256: 'a'.repeat(64) },
        { file: 'src/web/public/vendor/unknown.js', sha256: 'b'.repeat(64) },
      ],
    });
    await writeFile(manifestPath, invalid);
    await expect(
      provisionRuntimeVendorAssets({
        runtimeRoot: container,
        repositoryRoot: process.cwd(),
        vendorManifestPath: manifestPath,
        expectedManifestSha256: hash64(invalid),
      })
    ).rejects.toThrow(/vendor manifest/i);
  });

  it('provisions exact harness dependencies into the verified detached runtime', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'cod374-runtime-deps-'));
    temporaryRoots.push(runtimeRoot);
    const expectedLockSha256 = createHash('sha256')
      .update(await readFile('package-lock.json'))
      .digest('hex');
    const proof = await provisionRuntimeDependencies({
      runtimeRoot,
      repositoryRoot: process.cwd(),
      expectedLockSha256,
    });
    expect(await realpath(join(runtimeRoot, 'node_modules'))).toBe(await realpath('node_modules'));
    expect((await lstat(join(runtimeRoot, 'node_modules'))).isSymbolicLink()).toBe(true);
    expect(proof).toMatchObject({
      dependencyRootHash: hash64(await realpath('node_modules')),
      dependencyContentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      dependencyDevice: expect.stringMatching(/^[1-9][0-9]*$/),
      dependencyInode: expect.stringMatching(/^[1-9][0-9]*$/),
    });
    await expect(
      provisionRuntimeDependencies({ runtimeRoot, repositoryRoot: process.cwd(), expectedLockSha256 })
    ).rejects.toThrow(/absent|exists|target/i);
  });

  it('rejects in-place mutation of the bounded installed dependency content manifest', async () => {
    const container = await mkdtemp(join(tmpdir(), 'cod374-dependency-proof-'));
    temporaryRoots.push(container);
    const repositoryRoot = join(container, 'repository');
    const runtimeRoot = join(container, 'runtime');
    await mkdir(runtimeRoot);
    await mkdir(join(repositoryRoot, 'node_modules/example'), { recursive: true });
    await mkdir(join(repositoryRoot, 'node_modules/hoisted-transitive'), { recursive: true });
    await mkdir(join(repositoryRoot, 'node_modules/tsx/node_modules/esbuild'), { recursive: true });
    await mkdir(join(repositoryRoot, 'node_modules/tsx/node_modules/@esbuild/linux-x64'), { recursive: true });
    await mkdir(join(repositoryRoot, 'node_modules/esbuild'), { recursive: true });
    await mkdir(join(repositoryRoot, 'node_modules/playwright-core'), { recursive: true });
    await mkdir(join(repositoryRoot, 'packages/workspace'), { recursive: true });
    await mkdir(join(repositoryRoot, '.worktrees/transient'), { recursive: true });
    await mkdir(join(repositoryRoot, 'tmp/transient'), { recursive: true });
    await symlink('..', join(repositoryRoot, 'node_modules/aicodeman'), 'dir');
    await symlink('../packages/workspace', join(repositoryRoot, 'node_modules/workspace'), 'dir');
    const packageLock = '{"lockfileVersion":3}\n';
    const installedLock = `${JSON.stringify({
      lockfileVersion: 3,
      packages: {
        'node_modules/aicodeman': { resolved: '', link: true },
        'node_modules/example': { version: '1.0.0' },
        'node_modules/hoisted-transitive': { version: '1.0.0' },
        'node_modules/workspace': { version: '1.0.0' },
        'node_modules/tsx': { version: '1.0.0', dev: true },
        'node_modules/tsx/node_modules/esbuild': { version: '2.0.0', dev: true },
        'node_modules/tsx/node_modules/@esbuild/linux-x64': { version: '2.0.0', dev: true, optional: true },
        'node_modules/esbuild': { version: '1.0.0', dev: true },
        'node_modules/playwright-core': { version: '1.0.0', dev: true },
      },
    })}\n`;
    await writeFile(join(repositoryRoot, 'package.json'), '{"dependencies":{"example":"1.0.0"}}\n');
    await writeFile(join(repositoryRoot, 'package-lock.json'), packageLock);
    await writeFile(join(repositoryRoot, 'node_modules/.package-lock.json'), installedLock);
    await writeFile(join(repositoryRoot, 'node_modules/example/index.js'), 'export const value = 1;\n');
    await writeFile(join(repositoryRoot, 'node_modules/hoisted-transitive/index.js'), 'export const nested = 1;\n');
    await writeFile(join(repositoryRoot, 'node_modules/tsx/index.js'), 'export const loader = 1;\n');
    await writeFile(
      join(repositoryRoot, 'node_modules/tsx/node_modules/esbuild/index.js'),
      'export const nestedLoader = 1;\n'
    );
    await writeFile(
      join(repositoryRoot, 'node_modules/tsx/node_modules/@esbuild/linux-x64/bin'),
      'nested-platform-binary\n'
    );
    await writeFile(join(repositoryRoot, 'node_modules/esbuild/index.js'), 'export const compiler = 1;\n');
    await writeFile(join(repositoryRoot, 'node_modules/playwright-core/index.js'), 'export const browser = 1;\n');
    await writeFile(join(repositoryRoot, 'packages/workspace/index.js'), 'export const workspace = 1;\n');
    await writeFile(join(repositoryRoot, '.worktrees/transient/ignored.js'), 'export const transient = 1;\n');
    await symlink('/etc/passwd', join(repositoryRoot, 'tmp/transient/runtime-link'));
    const options = {
      runtimeRoot,
      repositoryRoot,
      expectedLockSha256: hash64(packageLock),
    };
    const proof = await provisionRuntimeDependencies(options);
    await writeFile(join(repositoryRoot, '.worktrees/transient/ignored.js'), 'export const transient = 2;\n');
    await expect(verifyProvisionedRuntimeDependencies({ ...options, expectedProof: proof })).resolves.toEqual(proof);
    await writeFile(join(repositoryRoot, 'node_modules/hoisted-transitive/index.js'), 'export const nested = 2;\n');
    await expect(verifyProvisionedRuntimeDependencies({ ...options, expectedProof: proof })).rejects.toThrow(
      /dependency identity changed/i
    );
    await writeFile(join(repositoryRoot, 'node_modules/hoisted-transitive/index.js'), 'export const nested = 1;\n');
    await expect(verifyProvisionedRuntimeDependencies({ ...options, expectedProof: proof })).resolves.toEqual(proof);
    await writeFile(
      join(repositoryRoot, 'node_modules/tsx/node_modules/esbuild/index.js'),
      'export const nestedLoader = 2;\n'
    );
    await expect(verifyProvisionedRuntimeDependencies({ ...options, expectedProof: proof })).rejects.toThrow(
      /dependency identity changed/i
    );
    await writeFile(
      join(repositoryRoot, 'node_modules/tsx/node_modules/esbuild/index.js'),
      'export const nestedLoader = 1;\n'
    );
    await writeFile(join(repositoryRoot, 'packages/workspace/index.js'), 'export const workspace = 2;\n');
    await expect(verifyProvisionedRuntimeDependencies({ ...options, expectedProof: proof })).rejects.toThrow(
      /dependency identity changed/i
    );
    await writeFile(join(repositoryRoot, 'packages/workspace/index.js'), 'export const workspace = 1;\n');
    await writeFile(join(repositoryRoot, 'node_modules/playwright-core/index.js'), 'export const browser = 2;\n');
    await expect(verifyProvisionedRuntimeDependencies({ ...options, expectedProof: proof })).rejects.toThrow(
      /dependency identity changed/i
    );
  });

  it('fails fixture readiness immediately when the owned child exits', async () => {
    const startedAt = Date.now();
    await expect(
      waitForFixture(
        'owned child',
        async () => {
          throw new FatalFixtureProbeError('ERR_MODULE_NOT_FOUND');
        },
        60_000
      )
    ).rejects.toThrow(/ERR_MODULE_NOT_FOUND/);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('retains and proves tmux cleanup when the interactive response fails after dispatch', async () => {
    const fixture = new Cod370OpenCodeFixture();
    (fixture as any).api = async (method: string, path: string) => {
      if (method === 'POST' && path === '/api/sessions') return { id: '12345678abcdef00' };
      if (method === 'POST' && path.endsWith('/interactive')) throw new Error('injected interactive response loss');
      throw new Error(`unexpected fixture API call ${method} ${path}`);
    };
    await expect(fixture.createOpenCodeSession()).rejects.toThrow(/interactive response loss/);
    expect(fixture.resourceAllocation().tmuxRemoved).toBe(true);
    fixture.socketName = `cod370-opencode-allocation-${process.pid}`;
    (fixture as any).tmux = () => '';
    await expect(fixture.cleanup()).rejects.toThrow(/fixture cleanup failed/);
    expect(fixture.cleanupProof).toMatchObject({ tmuxTargetAbsent: true, socketAbsent: true });
  });

  it('keeps the pane-owned OpenCode identity while a transient version probe is live', () => {
    expect(
      chooseOpenCodeCandidate(101, [
        { pid: 101, executable: '/opt/opencode', command: 'opencode' },
        { pid: 202, executable: '/opt/opencode', command: 'opencode --version' },
      ])
    ).toMatchObject({ pid: 101, command: 'opencode' });
  });

  it('waits for terminal options and session hydration before selecting and focusing the exact composer row', async () => {
    const calls: string[] = [];
    const sessionId = 'session-ready-contract';
    const app: any = {
      terminal: null,
      sessions: new Map(),
      activeSessionId: null,
      _wsReady: false,
      _wsSessionId: null,
      selectSession(id: string) {
        calls.push('select');
        expect(app.terminal?.options).toBeTruthy();
        expect(app.sessions.has(id)).toBe(true);
        app.activeSessionId = id;
        app._wsReady = true;
        app._wsSessionId = id;
      },
    };
    const fakeWindow = { app };
    const fakeDocument = { activeElement: { classList: { contains: () => true } } };
    const originalWindow = (globalThis as any).window;
    const originalDocument = (globalThis as any).document;
    (globalThis as any).window = fakeWindow;
    (globalThis as any).document = fakeDocument;
    let clickedPosition: { x: number; y: number } | null = null;
    let xtermComposerRow = 2;
    let viewportProbe = 0;
    const screen = {
      boundingBox: async () => ({ x: 0, y: 0, width: 390, height: 440 }),
      click: async ({ position }: any) => {
        calls.push('click');
        clickedPosition = position;
      },
    };
    const page: any = {
      bringToFront: async () => calls.push('front'),
      waitForFunction: async (callback: (argument?: unknown) => boolean, argument?: unknown) => {
        if (!app.terminal) {
          calls.push('ready');
          app.terminal = {
            options: {},
            rows: 3,
            buffer: {
              active: {
                length: 7,
                viewportY: 4,
                getLine: (row: number) => ({
                  translateToString: () => (row === 4 + xtermComposerRow ? '┃ Ask anything' : row < 4 ? 'old' : '┃'),
                }),
              },
            },
          };
          app.sessions.set(sessionId, {});
        }
        expect(callback(argument)).toBe(true);
      },
      evaluate: async (callback: (argument?: unknown) => unknown, argument?: unknown) => {
        const result = callback(argument);
        return typeof result === 'number' && viewportProbe >= 4 ? 6 : result;
      },
      locator: (selector: string) => {
        expect(selector).toBe('#terminalContainer .xterm-screen');
        return screen;
      },
    };
    const fixture: any = {
      phonePage: page,
      sessionId,
      paneText: () => '┃ Ask anything\nold scrollback\n┃\n┃\n┃ Ask anything\n',
      paneViewportText: () => {
        const paneRows = [2, 1, 1, 1];
        const xtermRows = [2, 2, 1, 1];
        const index = Math.min(viewportProbe++, paneRows.length - 1);
        xtermComposerRow = xtermRows[index];
        return ['┃', '┃', '┃'].map((line, row) => (row === paneRows[index] ? '┃ Ask anything' : line)).join('\n');
      },
    };
    try {
      await focusPhaseBRuntime(fixture);
    } finally {
      (globalThis as any).window = originalWindow;
      (globalThis as any).document = originalDocument;
    }
    expect(calls.slice(0, 3)).toEqual(['front', 'ready', 'select']);
    expect(calls).toContain('click');
    expect(viewportProbe).toBeGreaterThanOrEqual(4);
    expect(clickedPosition).toEqual({ x: 30, y: expect.closeTo((1.5 * 440) / 3, 8) });
  });

  it('uses the production loader for self-contained browser payloads', () => {
    const child = String.raw`
      const { chromium } = await import('playwright');
      const { createServer } = await import('node:http');
      const runtimeModule = await import('./scripts/perf/cod-374-playwright-runtime.ts');
      const traceModule = await import('./test/utils/cod374-latency-trace.ts');
      const {
        armBrowserLatencyTrial, completeBrowserLatencyWindow, installBrowserLatencyHooks,
        installBrowserLatencyInitScript, readBrowserLatencyTrace, removeBrowserLatencyHooks,
      } = traceModule;
      let captured;
      await installBrowserLatencyInitScript({ addInitScript: async (payload) => { captured = payload; } });
      const content = typeof captured === 'function' ? String(captured) : captured?.content;
      const browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      const serializedBrowserCallbacks = [];
      const serializedBrowserExpressions = [];
      const originalEvaluate = page.evaluate.bind(page);
      const originalWaitForFunction = page.waitForFunction.bind(page);
      page.evaluate = async (callback, argument) => {
        if (typeof callback === 'function') serializedBrowserCallbacks.push(String(callback));
        if (typeof callback === 'string') serializedBrowserExpressions.push(callback);
        return originalEvaluate(callback, argument);
      };
      page.waitForFunction = async (callback, argument, options) => {
        if (typeof callback === 'function') serializedBrowserCallbacks.push(String(callback));
        return originalWaitForFunction(callback, argument, options);
      };
      const server = createServer((_request, response) => response.end('<title>cod374-init</title>'));
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      const pageErrors = [];
      const consoleErrors = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      page.on('console', (message) => {
        const type = message.type();
        const value = message.text();
        if (type === 'error' || (type === 'warning' && /(?:crash|exception|uncaught|failed|fatal)/i.test(value))) {
          consoleErrors.push(type + ': ' + value);
        }
      });
      try {
        await installBrowserLatencyInitScript(page);
        await page.goto('http://127.0.0.1:' + address.port);
        await originalEvaluate("window.app = {_sendInputAsync(){},_reliableSend(){},_drainSession(){},_pendingDeliveries:new Map(),_clientId:'browser-client',_wsSessionId:'session',_onWsInputAck(){},_onSessionTerminal(){},batchTerminalWrite(){},flushPendingWrites(){},_connectionStatus:'connected',eventSource:{readyState:1},terminal:{options:{},write(){},onWriteParsed(){return{dispose(){}}},onRender(){return{dispose(){}}},buffer:{active:{length:0,getLine(){return null}}}}}");
        await runtimeModule.awaitPhaseBAppReadiness(page);
        let hookError = null;
        try {
          await installBrowserLatencyHooks(page);
        } catch (error) {
          hookError = error instanceof Error ? error.message : String(error);
        }
        await originalEvaluate(() => {
          const browserWindow = window;
          browserWindow.__cod374PhaseBLongTasks = [{ startTime: 1, duration: 999 }];
          browserWindow.__cod374PhaseBResizeEvents = [1];
          browserWindow.__cod374PhaseBResizeCollecting = false;
          browserWindow.__cod374PhaseBOnResize = () => {
            if (browserWindow.__cod374PhaseBResizeCollecting) {
              browserWindow.__cod374PhaseBResizeEvents.push(performance.now());
            }
          };
          window.addEventListener('resize', browserWindow.__cod374PhaseBOnResize);
          browserWindow.__cod374PhaseBResizeObserver = new ResizeObserver(browserWindow.__cod374PhaseBOnResize);
          browserWindow.__cod374PhaseBResizeObserver.observe(document.documentElement);
          browserWindow.__cod374PhaseBLongTaskObserver = new PerformanceObserver((list) => {
            browserWindow.__cod374PhaseBLongTasks.push(
              ...list.getEntries().map((entry) => ({ startTime: entry.startTime, duration: entry.duration }))
            );
          });
          browserWindow.__cod374PhaseBLongTaskObserver.observe({ type: 'longtask', buffered: false });
          const originalTakeRecords = browserWindow.__cod374PhaseBLongTaskObserver.takeRecords.bind(
            browserWindow.__cod374PhaseBLongTaskObserver
          );
          browserWindow.__cod374PhaseBObserverTakeRecordsCalls = 0;
          browserWindow.__cod374PhaseBLongTaskObserver.takeRecords = () => {
            browserWindow.__cod374PhaseBObserverTakeRecordsCalls += 1;
            return originalTakeRecords();
          };
          browserWindow.__cod374PhaseBOriginalLongTaskObserver = browserWindow.__cod374PhaseBLongTaskObserver;
          browserWindow.__cod374PhaseBOriginalResizeObserver = browserWindow.__cod374PhaseBResizeObserver;
          browserWindow.__cod374LatencyTrace.overflowed = true;
          browserWindow.__cod374PhaseBTraceOverflowed = true;
          browserWindow.__cod374PhaseBOriginalRequestAnimationFrame = window.requestAnimationFrame;
          browserWindow.__cod374PhaseBRafCalls = 0;
          window.requestAnimationFrame = (callback) =>
            browserWindow.__cod374PhaseBOriginalRequestAnimationFrame.call(window, (atMs) => {
              browserWindow.__cod374PhaseBRafCalls += 1;
              callback(atMs);
            });
        });
        pageErrors.push('stale page error');
        consoleErrors.push('warning: stale fatal console error');
        const browserQuiescence = await runtimeModule.measureBrowserQuiescence(page, {
          pageErrors,
          consoleErrors,
        });
        const browserQuiescenceState = await originalEvaluate(() => {
          const browserWindow = window;
          return {
            observerTakeRecordsCalls: browserWindow.__cod374PhaseBObserverTakeRecordsCalls,
            rafCalls: browserWindow.__cod374PhaseBRafCalls,
            longTaskCount: browserWindow.__cod374PhaseBLongTasks.length,
            resizeCount: browserWindow.__cod374PhaseBResizeEvents.length,
            resizeCollecting: browserWindow.__cod374PhaseBResizeCollecting,
            overflowed:
              browserWindow.__cod374PhaseBTraceOverflowed === true ||
              browserWindow.__cod374LatencyTrace.overflowed === true,
            longTaskObserverPreserved:
              browserWindow.__cod374PhaseBLongTaskObserver === browserWindow.__cod374PhaseBOriginalLongTaskObserver,
            resizeObserverPreserved:
              browserWindow.__cod374PhaseBResizeObserver === browserWindow.__cod374PhaseBOriginalResizeObserver,
          };
        });
        await originalEvaluate(() => {
          setTimeout(() => {
            window.dispatchEvent(new Event('resize'));
            queueMicrotask(() => {
              throw new Error('current-window page error');
            });
          }, 250);
        });
        const contaminatedBrowserQuiescence = await runtimeModule.measureBrowserQuiescence(page, {
          pageErrors,
          consoleErrors,
        });
        const browserQuiescenceLifecycle = await originalEvaluate(() => {
          const browserWindow = window;
          const resizeCount = browserWindow.__cod374PhaseBResizeEvents.length;
          browserWindow.__cod374PhaseBResizeCollecting = true;
          window.dispatchEvent(new Event('resize'));
          const resizeListenerPreserved = browserWindow.__cod374PhaseBResizeEvents.length === resizeCount + 1;
          browserWindow.__cod374PhaseBResizeCollecting = false;
          const longTaskObserverPreserved =
            browserWindow.__cod374PhaseBLongTaskObserver === browserWindow.__cod374PhaseBOriginalLongTaskObserver;
          const resizeObserverPreserved =
            browserWindow.__cod374PhaseBResizeObserver === browserWindow.__cod374PhaseBOriginalResizeObserver;
          browserWindow.__cod374PhaseBLongTaskObserver.disconnect();
          browserWindow.__cod374PhaseBResizeObserver.disconnect();
          window.removeEventListener('resize', browserWindow.__cod374PhaseBOnResize);
          window.requestAnimationFrame = browserWindow.__cod374PhaseBOriginalRequestAnimationFrame;
          const requestAnimationFrameRestored =
            window.requestAnimationFrame === browserWindow.__cod374PhaseBOriginalRequestAnimationFrame;
          return {
            longTaskObserverPreserved,
            resizeObserverPreserved,
            resizeListenerPreserved,
            requestAnimationFrameRestored,
          };
        });
        await armBrowserLatencyTrial(page, {
          trialId: 'loader-audit', inputIndex: 0, tokenHash: '8e35c2cd3bf6641b', tokenLength: 1, token: 'q'
        });
        await completeBrowserLatencyWindow(page, 'loader-audit');
        await readBrowserLatencyTrace(page, 'loader-audit');
        await originalEvaluate("window.__cod374PhaseBResizeEvents=[];window.__cod374PhaseBResizeCollecting=true");
        await runtimeModule.finishResizeCollection(page);
        const stateCreated = await page.evaluate(() => {
          const state = window.__cod374LatencyTrace;
          return !!state && Array.isArray(state.events);
        });
        const hookState = await originalEvaluate("(()=>{const state=window.__cod374LatencyTrace;return{listenerCount:state?.listenerCount,wrappersInstalled:state?.wrappersInstalled}})()");
        const callbackContent = serializedBrowserCallbacks.join('\n');
        const expressionContent = serializedBrowserExpressions.join('\n');
        const missingAuditExports = ['cpuProbe', 'terminalText', 'captureWindow'].filter(
          (name) => typeof runtimeModule[name] !== 'function'
        );
        const cleanupProof = await removeBrowserLatencyHooks(page);
        process.stdout.write(JSON.stringify({
          payloadKind: typeof captured === 'object' && typeof captured?.content === 'string' ? 'content' : typeof captured,
          forbiddenHelpers: typeof content === 'string'
            ? [...new Set(content.match(/\b(?:__name|__vite\w*|__toESM|__import\w*|import_\w+)\b/g) ?? [])]
            : ['missing-content'],
          callbackHelpers: [...new Set(callbackContent.match(/\b(?:__name|__vite\w*|__toESM|__import\w*|import_\w+)\b/g) ?? [])],
          expressionHelpers: [...new Set(expressionContent.match(/\b(?:__name|__vite\w*|__toESM|__import\w*|import_\w+)\b/g) ?? [])],
          missingAuditExports,
          stateCreated,
          hookState,
          hookError,
          browserQuiescence: {
            tickCount: browserQuiescence.tickCount,
            timerIntervalMs: browserQuiescence.timerIntervalMs,
            driftCount: browserQuiescence.driftsMs.length,
            measurementErrorHash: browserQuiescence.measurementErrorHash,
            pageErrorHashes: browserQuiescence.pageErrorHashes,
            consoleErrorHashes: browserQuiescence.consoleErrorHashes,
            longTaskDurationsMs: browserQuiescence.longTaskDurationsMs,
            resizeCount: browserQuiescence.resizeCount,
            overflowed: browserQuiescence.overflowed,
          },
          browserQuiescenceState,
          contaminatedBrowserQuiescence: {
            tickCount: contaminatedBrowserQuiescence.tickCount,
            pageErrorHashes: contaminatedBrowserQuiescence.pageErrorHashes,
            resizeCount: contaminatedBrowserQuiescence.resizeCount,
            measurementErrorHash: contaminatedBrowserQuiescence.measurementErrorHash,
            passed: contaminatedBrowserQuiescence.passed,
          },
          browserQuiescenceLifecycle,
          cleanupProof,
          pageErrors,
          consoleErrors,
        }));
      } finally {
        await browser.close();
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    `;
    const result = JSON.parse(
      execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', child], {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 30_000,
      })
    );
    expect(result).toEqual({
      payloadKind: 'content',
      forbiddenHelpers: [],
      callbackHelpers: [],
      expressionHelpers: [],
      missingAuditExports: [],
      stateCreated: true,
      hookState: { listenerCount: 3, wrappersInstalled: true },
      hookError: null,
      browserQuiescence: {
        tickCount: 50,
        timerIntervalMs: 20,
        driftCount: 50,
        measurementErrorHash: null,
        pageErrorHashes: [],
        consoleErrorHashes: [],
        longTaskDurationsMs: [],
        resizeCount: 0,
        overflowed: false,
      },
      browserQuiescenceState: {
        observerTakeRecordsCalls: 2,
        rafCalls: 4,
        longTaskCount: 0,
        resizeCount: 0,
        resizeCollecting: false,
        overflowed: false,
        longTaskObserverPreserved: true,
        resizeObserverPreserved: true,
      },
      contaminatedBrowserQuiescence: {
        tickCount: 50,
        pageErrorHashes: [token('current-window page error')],
        resizeCount: 1,
        measurementErrorHash: null,
        passed: false,
      },
      browserQuiescenceLifecycle: {
        longTaskObserverPreserved: true,
        resizeObserverPreserved: true,
        resizeListenerPreserved: true,
        requestAnimationFrameRestored: true,
      },
      cleanupProof: { wrappersRestored: true, listenersDisposed: true },
      pageErrors: ['stale page error', 'current-window page error'],
      consoleErrors: ['warning: stale fatal console error'],
    });
  }, 40_000);

  it('measures browser quiescence with 50 sequential ticks and snapshots reset diagnostics', async () => {
    const calls: string[] = [];
    const pageErrors = ['stale page error'];
    const consoleErrors = ['stale console error'];
    const page: any = {
      evaluate: async (expression: string) => {
        calls.push('evaluate');
        expect(typeof expression).toBe('string');
        expect(expression).not.toMatch(/\b__name\b/);
        if (expression.includes('for (let index = 0; index < 50; index += 1)')) {
          return {
            tickCount: 50,
            driftsMs: Array.from({ length: 50 }, (_, index) => index / 10),
            overflowed: false,
            measurementError: null,
          };
        }
        if (expression.includes('pendingLongTasks')) {
          return { longTaskDurationsMs: [], resizeCount: 0, overflowed: false };
        }
      },
    };

    const evidence = await measureBrowserQuiescence(page, {
      pageErrors,
      consoleErrors,
      resetTraceDiagnostics: async () => calls.push('reset-trace'),
      snapshotTraceDiagnostics: async () => {
        calls.push('snapshot-trace');
        return { overflowed: false };
      },
    });

    expect(calls).toEqual(['reset-trace', 'evaluate', 'evaluate', 'evaluate', 'snapshot-trace']);
    expect(evidence).toEqual({
      tickCount: 50,
      timerIntervalMs: 20,
      driftsMs: Array.from({ length: 50 }, (_, index) => index / 10),
      p95DriftMs: 4.7,
      maxDriftMs: 4.9,
      longTaskDurationsMs: [],
      pageErrorHashes: [],
      consoleErrorHashes: [],
      resizeCount: 0,
      overflowed: false,
      measurementErrorHash: null,
      passed: true,
    });
    expect(validateBrowserQuiescence(evidence)).toBe(evidence);
  });

  it('fails browser quiescence closed for drift, long tasks, resize, trace overflow, and diagnostics', async () => {
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const page: any = {
      evaluate: async () => {
        pageErrors.push('page exploded');
        consoleErrors.push('warning: fatal browser condition');
        return {
          tickCount: 50,
          driftsMs: [...Array(48).fill(0), 11, 26],
          longTaskDurationsMs: [51],
          resizeCount: 1,
          overflowed: false,
          measurementError: null,
        };
      },
    };

    const evidence = await measureBrowserQuiescence(page, {
      pageErrors,
      consoleErrors,
      snapshotTraceDiagnostics: async () => ({ overflowed: true }),
    });

    expect(evidence).toMatchObject({
      tickCount: 50,
      p95DriftMs: 0,
      maxDriftMs: 26,
      longTaskDurationsMs: [51],
      pageErrorHashes: [token('page exploded')],
      consoleErrorHashes: [token('warning: fatal browser condition')],
      resizeCount: 1,
      overflowed: true,
      measurementErrorHash: null,
      passed: false,
    });
  });

  it('returns safe failed partial browser quiescence evidence when browser evaluation fails', async () => {
    const evidence = await measureBrowserQuiescence(
      {
        evaluate: async () => {
          throw new Error('evaluation transport failed');
        },
      } as any,
      { pageErrors: [], consoleErrors: [] }
    );

    expect(evidence).toEqual({
      tickCount: 0,
      timerIntervalMs: 20,
      driftsMs: [],
      p95DriftMs: 0,
      maxDriftMs: 0,
      longTaskDurationsMs: [],
      pageErrorHashes: [],
      consoleErrorHashes: [],
      resizeCount: 0,
      overflowed: false,
      measurementErrorHash: token('Error:evaluation transport failed'),
      passed: false,
    });
    expect(validateBrowserQuiescence(evidence)).toBe(evidence);
  });

  it('preserves 0-49 completed ticks in safe failed browser quiescence evidence', async () => {
    const evidence = await measureBrowserQuiescence(
      {
        evaluate: async () => ({
          tickCount: 49,
          driftsMs: Array(49).fill(2),
          longTaskDurationsMs: [],
          resizeCount: 0,
          overflowed: false,
          measurementError: 'Error:timer failed',
        }),
      } as any,
      { pageErrors: [], consoleErrors: [] }
    );

    expect(evidence).toMatchObject({
      tickCount: 49,
      driftsMs: Array(49).fill(2),
      p95DriftMs: 2,
      maxDriftMs: 2,
      measurementErrorHash: token('Error:timer failed'),
      passed: false,
    });
  });

  it('retains simultaneous browser quiescence contamination when timer measurement fails', async () => {
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const evidence = await measureBrowserQuiescence(
      {
        evaluate: async () => {
          pageErrors.push('tick page error');
          consoleErrors.push('error: tick console error');
          return {
            tickCount: 17,
            driftsMs: Array(17).fill(3),
            longTaskDurationsMs: [75],
            resizeCount: 2,
            overflowed: true,
            measurementError: 'Error:tick timer failed',
          };
        },
      } as any,
      { pageErrors, consoleErrors }
    );

    expect(evidence).toMatchObject({
      tickCount: 17,
      driftsMs: Array(17).fill(3),
      longTaskDurationsMs: [75],
      pageErrorHashes: [token('tick page error')],
      consoleErrorHashes: [token('error: tick console error')],
      resizeCount: 2,
      overflowed: true,
      measurementErrorHash: token('Error:tick timer failed'),
      passed: false,
    });
    expect(validateBrowserQuiescence(evidence)).toBe(evidence);
  });

  it('binds browser quiescence page and console diagnostics to the timer window only', async () => {
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const evidence = await measureBrowserQuiescence(
      {
        evaluate: async () => {
          pageErrors.push('tick page error');
          consoleErrors.push('error: tick console error');
          return {
            tickCount: 50,
            driftsMs: Array(50).fill(0),
            longTaskDurationsMs: [],
            resizeCount: 0,
            overflowed: false,
            measurementError: null,
          };
        },
      } as any,
      {
        pageErrors,
        consoleErrors,
        resetTraceDiagnostics: async () => {
          pageErrors.push('pre-reset page error');
          consoleErrors.push('error: pre-reset console error');
        },
        snapshotTraceDiagnostics: async () => {
          pageErrors.push('post-snapshot page error');
          consoleErrors.push('error: post-snapshot console error');
          return { overflowed: false };
        },
      }
    );

    expect(evidence.pageErrorHashes).toEqual([token('tick page error')]);
    expect(evidence.consoleErrorHashes).toEqual([token('error: tick console error')]);
  });

  it('retains browser quiescence evidence when the trace snapshot fails', async () => {
    const pageErrors: string[] = [];
    const evidence = await measureBrowserQuiescence(
      {
        evaluate: async (expression: string) => {
          if (expression.includes('for (let index = 0; index < 50; index += 1)')) {
            pageErrors.push('tick page error');
            return { tickCount: 50, driftsMs: Array(50).fill(1), overflowed: false, measurementError: null };
          }
          if (expression.includes('pendingLongTasks')) {
            return { longTaskDurationsMs: [88], resizeCount: 3, overflowed: false };
          }
        },
      } as any,
      {
        pageErrors,
        consoleErrors: [],
        snapshotTraceDiagnostics: async () => {
          throw new Error('trace snapshot failed');
        },
      }
    );

    expect(evidence).toMatchObject({
      tickCount: 50,
      driftsMs: Array(50).fill(1),
      longTaskDurationsMs: [88],
      pageErrorHashes: [token('tick page error')],
      resizeCount: 3,
      overflowed: true,
      measurementErrorHash: token('Error:trace snapshot failed'),
      passed: false,
    });
    expect(validateBrowserQuiescence(evidence)).toBe(evidence);
  });

  it('collects browser quiescence diagnostics only while the static tick payload is armed', async () => {
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const longTasks: Array<{ label: string; duration: number }> = [];
    const resizeEvents: string[] = [];
    let resizeCollecting = false;
    let traceOverflowed = false;
    const assignResizeState = (expression: string, before: number, after: number) => {
      const matches = [...expression.slice(before, after).matchAll(/__cod374PhaseBResizeCollecting = (true|false)/g)];
      if (matches.length) resizeCollecting = matches.at(-1)![1] === 'true';
    };
    const inject = (label: string, { trace = false } = {}) => {
      longTasks.push({ label, duration: label === 'in-loop' ? 60 : 90 });
      if (resizeCollecting) resizeEvents.push(label);
      if (trace) traceOverflowed = true;
      pageErrors.push(`${label} page error`);
      consoleErrors.push(`error: ${label} console error`);
    };
    const evidence = await measureBrowserQuiescence(
      {
        evaluate: async (expression: string) => {
          if (expression.includes('__cod374PhaseBLongTaskObserver?.takeRecords();')) {
            longTasks.length = 0;
            resizeEvents.length = 0;
            traceOverflowed = false;
            assignResizeState(expression, 0, expression.length);
            inject('pre-gap', { trace: true });
            return;
          }
          if (expression.includes('for (let index = 0; index < 50; index += 1)')) {
            const loopAt = expression.indexOf('for (let index = 0; index < 50; index += 1)');
            assignResizeState(expression, 0, loopAt);
            if (expression.slice(0, loopAt).includes('__cod374PhaseBLongTasks.length = 0')) longTasks.length = 0;
            if (expression.slice(0, loopAt).includes('__cod374PhaseBResizeEvents.length = 0')) resizeEvents.length = 0;
            if (expression.slice(0, loopAt).includes('__cod374PhaseBTraceOverflowed = false')) traceOverflowed = false;
            inject('in-loop');
            const tickOverflowed = traceOverflowed;
            assignResizeState(expression, loopAt, expression.length);
            return {
              tickCount: 50,
              driftsMs: Array(50).fill(0),
              measurementError: null,
              overflowed: tickOverflowed,
            };
          }
          inject('post-gap', { trace: true });
          assignResizeState(expression, 0, expression.length);
          const selectedLongTasks = expression.includes('__cod374PhaseBWindowStartedMs')
            ? longTasks.filter((entry) => entry.label === 'in-loop')
            : longTasks;
          return {
            longTaskDurationsMs: selectedLongTasks.map((entry) => entry.duration),
            resizeCount: resizeEvents.length,
            overflowed: traceOverflowed,
          };
        },
      } as any,
      { pageErrors, consoleErrors }
    );

    expect(evidence).toMatchObject({
      longTaskDurationsMs: [60],
      pageErrorHashes: [token('in-loop page error')],
      consoleErrorHashes: [token('error: in-loop console error')],
      resizeCount: 1,
      overflowed: false,
      measurementErrorHash: null,
      passed: false,
    });
  });

  it('disarms browser quiescence when executed timer payload timestamps throw', async () => {
    const descriptors = new Map(
      ['window', 'performance', 'requestAnimationFrame', 'setTimeout'].map((name) => [
        name,
        Object.getOwnPropertyDescriptor(globalThis, name),
      ])
    );
    try {
      for (const failurePoint of ['initial', 'finally'] as const) {
        let nowCalls = 0;
        const browserWindow: any = {
          __cod374PhaseBLongTasks: [],
          __cod374PhaseBResizeEvents: [],
          __cod374PhaseBResizeCollecting: false,
          __cod374PhaseBTraceOverflowed: false,
          __cod374LatencyTrace: { overflowed: false },
        };
        Object.defineProperties(globalThis, {
          window: { configurable: true, value: browserWindow },
          performance: {
            configurable: true,
            value: {
              now: () => {
                nowCalls += 1;
                if (failurePoint === 'initial' || nowCalls === 52) throw new Error(`${failurePoint} timestamp failed`);
                return (nowCalls - 1) * 20;
              },
            },
          },
          requestAnimationFrame: {
            configurable: true,
            value: (callback: (atMs: number) => void) => {
              queueMicrotask(() => callback(0));
              return 1;
            },
          },
          setTimeout: {
            configurable: true,
            value: (callback: () => void) => {
              queueMicrotask(callback);
              return 1;
            },
          },
        });

        const evidence = await measureBrowserQuiescence(
          { evaluate: async (expression: string) => (0, eval)(expression) } as any,
          { pageErrors: [], consoleErrors: [] }
        );

        expect(evidence).toMatchObject({
          measurementErrorHash: expect.stringMatching(/^[0-9a-f]{16}$/),
          passed: false,
        });
        expect(browserWindow.__cod374PhaseBResizeCollecting).toBe(false);
      }
    } finally {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete (globalThis as any)[name];
      }
    }
  });

  it('measures browser quiescence without starting CPU calibration or capture work', async () => {
    const evaluations: unknown[] = [];
    const page: any = {
      evaluate: async (expression: unknown) => {
        evaluations.push(expression);
        return {
          tickCount: 50,
          driftsMs: Array(50).fill(0),
          longTaskDurationsMs: [],
          resizeCount: 0,
          overflowed: false,
          measurementError: null,
        };
      },
    };
    await measureBrowserQuiescence(page, { pageErrors: [], consoleErrors: [] });
    expect(evaluations).toHaveLength(3);
    for (const expression of evaluations) {
      expect(expression).toEqual(expect.any(String));
      expect(expression).not.toContain('400_000');
      expect(expression).not.toContain('dispatchRapidKeys');
    }
    expect(evaluations.filter((expression) => String(expression).includes('index < 50'))).toHaveLength(1);
  });

  it('joins the real parse, render, and RAF visibility chain to its selected write', async () => {
    const callbacks: Record<string, () => void> = {};
    const originalWindow = (globalThis as any).window;
    const originalAnimationFrame = (globalThis as any).requestAnimationFrame;
    const listeners = new Map<string, Set<() => void>>();
    class FakeWebSocket {
      static OPEN = 1;
      addEventListener(name: string, callback: () => void) {
        const registered = listeners.get(name) ?? new Set();
        registered.add(callback);
        listeners.set(name, registered);
      }
      removeEventListener(name: string, callback: () => void) {
        listeners.get(name)?.delete(callback);
      }
      send() {}
    }
    const terminal = {
      write(_data: string, callback: () => void) {
        callback();
        callbacks.parsed();
      },
      onWriteParsed(callback: () => void) {
        callbacks.parsed = callback;
        return { dispose() {} };
      },
      onRender(callback: () => void) {
        callbacks.render = callback;
        return { dispose() {} };
      },
      buffer: {
        active: {
          length: 1,
          getLine: () => ({ translateToString: () => '┃ qz1' }),
        },
      },
    };
    const browserWindow: any = {
      performance,
      crypto,
      TextEncoder,
      WebSocket: FakeWebSocket,
      Terminal: class {},
      addEventListener(name: string, callback: () => void) {
        const registered = listeners.get(name) ?? new Set();
        registered.add(callback);
        listeners.set(name, registered);
      },
      removeEventListener(name: string, callback: () => void) {
        listeners.get(name)?.delete(callback);
      },
    };
    const app = {
      _sendInputAsync() {},
      _reliableSend() {},
      _drainSession() {},
      _pendingDeliveries: new Map(),
      _clientId: 'browser-client',
      _wsSessionId: 'session',
      _onWsInputAck() {},
      _onSessionTerminal() {},
      batchTerminalWrite() {},
      flushPendingWrites() {},
      terminal,
    };
    browserWindow.app = app;
    (globalThis as any).window = browserWindow;
    (globalThis as any).requestAnimationFrame = (callback: () => void) => {
      queueMicrotask(callback);
      return 1;
    };
    const evaluate = async (callback: any, argument?: unknown) => {
      if (typeof callback === 'string') return Function(`return ${callback}`)();
      return callback(argument);
    };
    const page = {
      addInitScript: async ({ content }: { content: string }) => Function(content)(),
      evaluate,
      isClosed: () => false,
    } as any;
    try {
      await installBrowserLatencyInitScript(page);
      await installBrowserLatencyHooks(page);
      for (const [inputIndex, tokenValue] of ['q', 'qz', 'qz1'].entries()) {
        await armBrowserLatencyTrial(page, {
          trialId: 'real-hook-contract',
          inputIndex,
          tokenHash: token(tokenValue),
          tokenLength: tokenValue.length,
          token: tokenValue,
        });
      }
      await page.evaluate(() => {
        const state = (window as any).__cod374LatencyTrace;
        for (const context of state.contexts) {
          for (const stage of BROWSER_INPUT_STAGES) {
            const identity = [
              'browser.durable-queued',
              'browser.ws-input-send',
              'browser.ws-input-send-return',
              'browser.ws-input-ack',
            ].includes(stage)
              ? { clientId: 'browser-client', seq: 100 + context.inputIndex }
              : {};
            const coalescing = [
              'browser.logical',
              'browser.durable-queued',
              'browser.ws-input-send',
              'browser.ws-input-send-return',
              'browser.ws-input-ack',
            ].includes(stage)
              ? { coalescedIndex: 0, coalescedCount: 1 }
              : {};
            state.originals.record(stage, { ...identity, ...coalescing }, context);
          }
          state.ackedGenerations[context.generation] = true;
        }
        state.firstAcked = true;
        state.originals.record('browser.ws-output-receive', { ordinal: 1, bytes: 5, rawValue: 'frame' });
        state.originals.record('browser.output-handler', { ordinal: 1 });
        state.originals.record('browser.write-queued', { ordinal: 1 });
        state.flushingOutput = { ordinal: 1 };
        (window as any).app.terminal.write('frame', () => {});
        state.flushingOutput = null;
        callbacks.render();
      });
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      await completeBrowserLatencyWindow(page, 'real-hook-contract');
      const browserEvents = await readBrowserLatencyTrace(page, 'real-hook-contract');
      expect(validateBrowserLatencyTrace(browserEvents)).toBe(browserEvents);
      const artifact = actualTask3Artifact();
      artifact.browserEvents = browserEvents;
      artifact.serverEvents = [];
      artifact.longTaskWindow = {
        startedMs: 0,
        endedMs: browserEvents.at(-1)!.atMs,
        entries: [],
      };
      const sample = adaptTask3Artifact(artifact, 0);
      expect(() => deriveSampleEvidence(sample, false)).not.toThrow();
      const visibility = sample.evidence.browserEvents.filter((event) =>
        BROWSER_VISIBILITY_STAGES.includes(event.stage as any)
      );
      expect(visibility).toHaveLength(4);
      expect(visibility).toEqual(
        visibility.map((event) =>
          expect.objectContaining({
            generation: 3,
            inputIndex: 2,
            attributedGeneration: 3,
            attributedInputIndex: 2,
            ordinal: 1,
            writeId: 1,
          })
        )
      );
    } finally {
      (globalThis as any).window = originalWindow;
      (globalThis as any).requestAnimationFrame = originalAnimationFrame;
    }
  });

  it('rejects non-whitelisted hook failure data before browser evaluation', async () => {
    let evaluateCalls = 0;
    await expect(
      installBrowserLatencyHooks(
        {
          evaluate: async () => {
            evaluateCalls++;
          },
        } as any,
        { failAfter: '</script>' }
      )
    ).rejects.toThrow(/hook failure stage is invalid/i);
    expect(evaluateCalls).toBe(0);
  });

  it('canonicalizes only the exact frozen renderIndexHtml mutations', () => {
    const source = [
      '<head>',
      '<title>Codeman</title>',
      '<link rel="stylesheet" href="styles.css">',
      '<script defer src="app.js"></script>',
      '</head>',
      '<button class="btn-multimonitor btn-multimonitor--hidden"></button>',
      '<button class="btn-away-digest btn-away-digest--hidden"></button>',
    ].join('\n');
    const cliFlags = {
      claude: true,
      opencode: true,
      codex: false,
      gemini: false,
      antigravity: false,
      pi: false,
      cloudflared: true,
      git: true,
    };
    const rendered = source
      .replace('<title>Codeman</title>', '<title>codeman:fixture-host</title>')
      .replace('styles.css"', 'styles.css?v=1724512345678"')
      .replace('app.js"', 'app.js?v=1724512345679"')
      .replace(' btn-multimonitor--hidden', '')
      .replace('</head>', `<script>window.__codemanCliAvailable=${JSON.stringify(cliFlags)};</script>\n</head>`);
    expect(
      canonicalizeRenderedIndexHtml({
        sourceHtml: source,
        renderedHtml: rendered,
        expectedTitle: 'codeman:fixture-host',
      })
    ).toBe(source);

    const mutations = [
      rendered.replace('1724512345678', 'not-numeric'),
      rendered.replace('?v=1724512345678', ''),
      rendered.replace('</head>', '<script>alert(1)</script>\n</head>'),
      rendered.replace('window.__codemanCliAvailable=', 'window.__codemanCliAvailable={}||'),
      rendered.replace('{"claude":true,"opencode":true', '{"opencode":true,"claude":true'),
      rendered.replace(
        '</head>',
        `${rendered.match(/<script>window\.__codemanCliAvailable=.*?<\/script>\n/)![0]}</head>`
      ),
      rendered.replace('<title>codeman:fixture-host</title>', '<title>codeman:other-host</title>'),
      rendered.replace('<script defer src="app.js?v=1724512345679"></script>', ''),
    ];
    for (const mutation of mutations) {
      expect(() =>
        canonicalizeRenderedIndexHtml({
          sourceHtml: source,
          renderedHtml: mutation,
          expectedTitle: 'codeman:fixture-host',
        })
      ).toThrow(/rendered index/i);
    }
  });

  it('keeps the source index hash immutable while verifying rendered root and byte-exact referenced assets', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'cod374-assets-'));
    temporaryRoots.push(runtimeRoot);
    const publicRoot = join(runtimeRoot, 'src/web/public');
    await mkdir(publicRoot, { recursive: true });
    const source = [
      '<head>',
      '<title>Codeman</title>',
      '<link rel="stylesheet" href="styles.css">',
      '<script defer src="app.js"></script>',
      '</head>',
      '<button class="btn-multimonitor btn-multimonitor--hidden"></button>',
      '<button class="btn-away-digest btn-away-digest--hidden"></button>',
    ].join('\n');
    const app = 'window.app = {};\n';
    const styles = 'body { color: white; }\n';
    await writeFile(join(publicRoot, 'index.html'), source);
    await writeFile(join(publicRoot, 'app.js'), app);
    await writeFile(join(publicRoot, 'styles.css'), styles);
    const rendered = source
      .replace('<title>Codeman</title>', '<title>codeman:fixture-host</title>')
      .replace('styles.css"', 'styles.css?v=1"')
      .replace('app.js"', 'app.js?v=2"')
      .replace(
        '</head>',
        '<script>window.__codemanCliAvailable={"claude":false,"opencode":true,"codex":false,"gemini":false,"antigravity":false,"pi":false,"cloudflared":false,"git":true};</script>\n</head>'
      );
    expect(hash64(rendered)).not.toBe(hash64(source));
    const expectedAssets = [
      { path: '/', sha256: hash64(source) },
      { path: '/app.js', sha256: hash64(app) },
      { path: '/styles.css', sha256: hash64(styles) },
    ];
    const bodies = new Map([
      ['/', rendered],
      ['/app.js', app],
      ['/styles.css', styles],
    ]);
    await expect(
      verifyServedRuntimeAssets({
        runtimeRoot,
        baseUrl: 'http://127.0.0.1:3000',
        fetch: async (url: string) => new Response(bodies.get(new URL(url).pathname)),
        expectedAssets,
        expectedTitle: 'codeman:fixture-host',
      })
    ).resolves.toEqual({
      sourceIndexSha256: hash64(source),
      renderedIndexSha256: hash64(rendered),
      appSha256: hash64(app),
      stylesSha256: hash64(styles),
    });

    for (const path of ['/app.js', '/styles.css']) {
      const mutated = new Map(bodies);
      mutated.set(path, `${mutated.get(path)}/* mutation */`);
      await expect(
        verifyServedRuntimeAssets({
          runtimeRoot,
          baseUrl: 'http://127.0.0.1:3000',
          fetch: async (url: string) => new Response(mutated.get(new URL(url).pathname)),
          expectedAssets,
          expectedTitle: 'codeman:fixture-host',
        })
      ).rejects.toThrow(/served asset hash mismatch/i);
    }
  });

  it('launches real candidate source with the exact tracing overlay and provisioned bare dependencies', async () => {
    const container = await mkdtemp(join(tmpdir(), 'cod374-real-runtime-'));
    temporaryRoots.push(container);
    const patchPath = join(container, 'candidate.patch');
    const patch = execFileSync(
      'git',
      ['diff', '--full-index', '--binary', CANDIDATE_PRODUCT.sha, '23ef0f1d', '--', ...OVERLAY_FILES],
      { maxBuffer: 32 * 1024 * 1024 }
    );
    await writeFile(patchPath, patch);
    const files = OVERLAY_FILES.map((file) => {
      const contents = execFileSync('git', ['show', `23ef0f1d:${file}`], { maxBuffer: 16 * 1024 * 1024 });
      const mode = execFileSync('git', ['ls-tree', '23ef0f1d', '--', file], { encoding: 'utf8' }).slice(0, 6);
      return { file, mode, sha256: createHash('sha256').update(contents).digest('hex') };
    });
    const handle = await materializeVerifiedRuntimeOverlay({
      patchPath,
      patchSha256: createHash('sha256').update(patch).digest('hex'),
      product: CANDIDATE_PRODUCT,
      files,
      manifestSha256: createHash('sha256')
        .update(files.map((entry) => `${entry.file}\0${entry.mode}\0${entry.sha256}\n`).join(''))
        .digest('hex'),
    });
    try {
      const beforeRoots = (await readdir(tmpdir())).filter((entry) => entry.startsWith('cod370-opencode-')).sort();
      const startedAt = Date.now();
      let missingDependencyError: any;
      try {
        await launchConcretePhaseBRuntime({ runtimeRoot: handle.root, plan: phaseBPlan() });
      } catch (error) {
        missingDependencyError = error;
      }
      expect(missingDependencyError).toBeInstanceOf(AggregateError);
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(missingDependencyError.cleanupAllocation).toMatchObject({
        serverStopped: true,
        tempRootRemoved: true,
      });
      expect([
        ...missingDependencyError.serverDiagnostics.stdoutHashes,
        ...missingDependencyError.serverDiagnostics.stderrHashes,
      ]).toHaveLength(1);
      expect((await readdir(tmpdir())).filter((entry) => entry.startsWith('cod370-opencode-')).sort()).toEqual(
        beforeRoots
      );
      const expectedLockSha256 = createHash('sha256')
        .update(await readFile('package-lock.json'))
        .digest('hex');
      await provisionRuntimeDependencies({
        runtimeRoot: handle.root,
        repositoryRoot: process.cwd(),
        expectedLockSha256,
      });
      let missingVendorError: any;
      try {
        await launchConcretePhaseBRuntime({ runtimeRoot: handle.root, plan: phaseBPlan() });
      } catch (error) {
        missingVendorError = error;
      }
      expect(missingVendorError).toBeInstanceOf(AggregateError);
      expect(missingVendorError.cleanupProof).toMatchObject({
        browserClosed: true,
        serverStopped: true,
        tempRootRemoved: true,
      });
      expect((await readdir(tmpdir())).filter((entry) => entry.startsWith('cod370-opencode-')).sort()).toEqual(
        beforeRoots
      );
      const vendorManifestPath = join(container, 'vendor-manifest.json');
      const vendorFiles = (await readdir('src/web/public/vendor'))
        .sort()
        .map((name) => `src/web/public/vendor/${name}`);
      const vendorManifestBytes = JSON.stringify({
        schemaVersion: 1,
        files: await Promise.all(vendorFiles.map(async (file) => ({ file, sha256: hash64(await readFile(file)) }))),
      });
      await writeFile(vendorManifestPath, vendorManifestBytes);
      await provisionRuntimeVendorAssets({
        runtimeRoot: handle.root,
        repositoryRoot: process.cwd(),
        vendorManifestPath,
        expectedManifestSha256: hash64(vendorManifestBytes),
      });
      let runtime: Awaited<ReturnType<typeof launchConcretePhaseBRuntime>> | undefined;
      try {
        runtime = await launchConcretePhaseBRuntime({ runtimeRoot: handle.root, plan: phaseBPlan() });
        expect(runtime.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        expect(await runtime.fetch(`${runtime.baseUrl}/api/status`).then((response: Response) => response.ok)).toBe(
          true
        );
        const sourceAssetBytes = await Promise.all(
          ['index.html', 'app.js', 'styles.css'].map((name) => readFile(join(handle.root, 'src/web/public', name)))
        );
        const liveIndexBytes = Buffer.from(
          await runtime.fetch(`${runtime.baseUrl}/`).then((response) => response.arrayBuffer())
        );
        expect(hash64(liveIndexBytes)).not.toBe(hash64(sourceAssetBytes[0]));
        await expect(
          verifyServedRuntimeAssets({
            runtimeRoot: handle.root,
            baseUrl: runtime.baseUrl,
            fetch: runtime.fetch,
            expectedAssets: ['/', '/app.js', '/styles.css'].map((path, index) => ({
              path,
              sha256: hash64(sourceAssetBytes[index]),
            })),
          })
        ).resolves.toMatchObject({
          sourceIndexSha256: hash64(sourceAssetBytes[0]),
          renderedIndexSha256: hash64(liveIndexBytes),
          appSha256: hash64(sourceAssetBytes[1]),
          stylesSha256: hash64(sourceAssetBytes[2]),
        });
        expect(runtime.serverPid).toBeGreaterThan(1);
        expect(runtime.browserPid).toBeGreaterThan(1);
        expect(runtime.opencodePid).toBeGreaterThan(1);
        await expect(
          runtime.page.evaluate(() => {
            const state = (window as any).__cod374LatencyTrace;
            return { listenerCount: state?.listenerCount, wrappersInstalled: state?.wrappersInstalled };
          })
        ).resolves.toEqual({ listenerCount: 5, wrappersInstalled: true });
        await expect(runtime.identities()).resolves.toEqual({
          tmuxSession: expect.stringMatching(/^codeman-[^:]+:\$\d+$/),
          tempRoot: expect.stringContaining('cod370-opencode-'),
        });
      } finally {
        if (runtime) {
          const originalEvaluate = runtime.page.evaluate.bind(runtime.page);
          let cleanupEvaluateCalls = 0;
          (runtime.page as any).evaluate = async (...args: unknown[]) => {
            cleanupEvaluateCalls += 1;
            if (cleanupEvaluateCalls === 1) throw new Error('injected hook restoration failure');
            return originalEvaluate(...(args as Parameters<typeof runtime.page.evaluate>));
          };
          let cleanupError: any;
          try {
            await runtime.cleanup();
          } catch (error) {
            cleanupError = error;
          }
          expect(cleanupError).toBeInstanceOf(AggregateError);
          expect(cleanupError.cleanupProof).toEqual({
            browserClosed: true,
            serverStopped: true,
            tmuxRemoved: true,
            tempRootRemoved: true,
            hooksRestored: false,
            listenersDisposed: true,
          });
        }
      }
      expect((await readdir(tmpdir())).filter((entry) => entry.startsWith('cod370-opencode-')).sort()).toEqual(
        beforeRoots
      );
    } finally {
      await handle.cleanup();
    }
  }, 120_000);

  it('drains queued resize observer delivery before closing the measured window', async () => {
    const originalWindow = (globalThis as any).window;
    const originalAnimationFrame = (globalThis as any).requestAnimationFrame;
    const state = { __cod374PhaseBResizeCollecting: true, __cod374PhaseBResizeEvents: [] as number[] };
    let frames = 0;
    (globalThis as any).window = state;
    (globalThis as any).requestAnimationFrame = (callback: (atMs: number) => void) => {
      queueMicrotask(() => {
        frames += 1;
        if (frames === 1 && state.__cod374PhaseBResizeCollecting) state.__cod374PhaseBResizeEvents.push(123);
        callback(123);
      });
      return frames;
    };
    try {
      await expect(
        finishResizeCollection({ evaluate: async (callback: () => unknown) => callback() } as any)
      ).resolves.toEqual([{ atMs: 123 }]);
      expect(state.__cod374PhaseBResizeCollecting).toBe(false);
      expect(frames).toBe(2);
    } finally {
      (globalThis as any).window = originalWindow;
      (globalThis as any).requestAnimationFrame = originalAnimationFrame;
    }
  });

  it('brackets sub-second process starts without integer btime quantization', () => {
    expect(
      calibrateProcessStartWindow({
        beforeWallMs: 10_000.2,
        beforeUptimeSeconds: 5.001,
        afterWallMs: 10_001.1,
        afterUptimeSeconds: 5.0018,
        startTicks: 450,
        clockTicks: 100,
        uptimeResolutionMs: 10,
      })
    ).toEqual({ startedAt: '1970-01-01T00:00:09.504Z', startUncertaintyMs: 12 });
  });
  it('adapts the actual Task 3 browser shape without enriching ordinal-only stages', () => {
    const artifact = actualTask3Artifact();
    expect(validateBrowserLatencyTrace(artifact.browserEvents)).toBe(artifact.browserEvents);
    const sample = adaptTask3Artifact(artifact, 0);
    expect(sample.inputs[0].clientId).toBe(token('123e4567-e89b-42d3-a456-426614174000'));
    expect(sample.evidence.browserEvents).not.toContainEqual(
      expect.objectContaining({ clientId: artifact.browserEvents[3].clientId })
    );
    expect(sample.inputs.map((input) => input.tokenHash)).toEqual([token('q'), token('qz'), token('qz1')]);
    for (const stage of ['browser.output-handler', 'browser.write-queued']) {
      expect(sample.evidence.browserEvents.find((event) => event.stage === stage)).toEqual(
        expect.not.objectContaining({ valueHash: expect.anything(), bytes: expect.anything() })
      );
    }
  });

  it('accepts the actual server event schema without inventing post-ACK delivery', () => {
    const artifact = actualTask3Artifact();
    const collector = createMobileInputTraceCollector({ nodeEnv: 'test', traceFlag: '1', secret: 'fixture' });
    for (const event of artifact.serverEvents) expect(collector.record(event as never)).toBe(true);
    expect(artifact.serverEvents.at(-1)).toEqual(expect.not.objectContaining({ delivered: expect.anything() }));
  });

  it('preserves the real q plus coalesced z,1 client-sequence identity', () => {
    const artifact = actualTask3Artifact();
    for (const event of artifact.browserEvents) {
      if (event.generation < 2) continue;
      if (
        [
          'browser.logical',
          'browser.durable-queued',
          'browser.ws-input-send',
          'browser.ws-input-send-return',
          'browser.ws-input-ack',
        ].includes(event.stage)
      ) {
        event.coalescedIndex = event.inputIndex - 1;
        event.coalescedCount = 2;
      }
      if (event.clientId !== undefined) event.seq = 101;
    }
    expect(validateBrowserLatencyTrace(artifact.browserEvents)).toBe(artifact.browserEvents);
    expect(adaptTask3Artifact(artifact, 0).inputs).toEqual([
      expect.objectContaining({ seq: 100, coalescedIndex: 0, coalescedCount: 1 }),
      expect.objectContaining({ seq: 101, coalescedIndex: 0, coalescedCount: 2 }),
      expect.objectContaining({ seq: 101, coalescedIndex: 1, coalescedCount: 2 }),
    ]);
  });

  it('materializes and keeps the exact verified overlay worktree alive until explicit cleanup', async () => {
    const patch = Buffer.from('patch');
    const files = OVERLAY_FILES.map((file) => ({
      file,
      mode: '100644',
      sha256: createHash('sha256').update(file).digest('hex'),
    }));
    const manifestSha256 = createHash('sha256')
      .update(files.map((entry) => `${entry.file}\0${entry.mode}\0${entry.sha256}\n`).join(''))
      .digest('hex');
    const calls: string[][] = [];
    let cleaned = false;
    const handle = await materializeVerifiedRuntimeOverlay(
      {
        patchPath: '/tmp/cod374.patch',
        patchSha256: createHash('sha256').update(patch).digest('hex'),
        product: { sha: 'a'.repeat(40), tree: 'b'.repeat(40) },
        files,
        manifestSha256,
      },
      {
        repositoryRoot: '/repo',
        read: async (path: string) =>
          path === '/tmp/cod374.patch' ? patch : Buffer.from(OVERLAY_FILES.find((file) => path.endsWith(file)) ?? ''),
        stat: async () => ({ isFile: () => true, isSymbolicLink: () => false, mode: 0o100644 }),
        resolveRealpath: async (path: string) => path,
        git: async (args: string[]) => {
          calls.push(args);
          if (args[0] === 'rev-parse') return Buffer.from(`${args[1] === 'HEAD' ? 'a'.repeat(40) : 'b'.repeat(40)}\n`);
          if (args[0] === 'status') return Buffer.from(OVERLAY_FILES.map((file) => ` M ${file}\0`).join(''));
          if (args[0] === 'worktree' && args[1] === 'remove') cleaned = true;
          return Buffer.from('');
        },
      }
    );
    expect(handle.root).toContain('cod374-overlay-runtime-');
    expect(cleaned).toBe(false);
    await handle.cleanup();
    expect(cleaned).toBe(true);
    expect(calls).toContainEqual(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching']);
  });

  it('rejects a non-frozen final q,z,1 identity', () => {
    const artifact = actualTask3Artifact();
    artifact.browserEvents.find(
      (event) => event.stage === 'browser.durable-queued' && event.inputIndex === 2
    )!.tokenHash = 'ffffffffffffffff';
    expect(() => adaptTask3Artifact(artifact, 0)).toThrow(/rapid input identity/i);
  });

  it('publishes a canonical prerequisite preflight when repository verification fails before host measurement', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const experimentRoot = await mkdtemp(join(tmpdir(), 'cod374-repository-preflight-'));
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'cod374-repository-preflight-runtime-'));
    temporaryRoots.push(experimentRoot, runtimeRoot);
    const calls: string[] = [];
    const repositoryError = new Error('repository proof failed');
    const fixture = await gateProducerFixture({ experimentRoot, runtimeRoot, calls, repositoryError });

    await runPhaseBProducer(fixture.options);

    const published = JSON.parse(await readFile(join(experimentRoot, 'attempts/attempt-0001.json'), 'utf8'));
    expect(calls).toEqual(['repository-preflight']);
    expect(published.selection).toEqual({
      attempt: 1,
      lifecycle: 'preflight',
      accepted: false,
      failureReasons: [{ code: 'prerequisite-verification-failed', detailHash: token(String(repositoryError)) }],
    });
    expect(published.quiescence).toEqual({ host: null, browser: null, passed: false });
    expect(published.cells).toEqual([]);
    expect(Object.values(published.allocation)).toEqual([false, false, false, false, false, false]);
    expect(Object.values(published.cleanup)).toEqual([true, true, true, true, true, true]);
    expect(published.provenance.process).toMatchObject({
      tmuxSessionHash: null,
      tempRootHash: null,
      server: null,
      browser: null,
      opencode: null,
    });
    expect(JSON.stringify(published)).not.toContain(repositoryError.message);
    expect(fixture.counts()).toEqual({ runtimeCleanupCalls: 0, overlayCleanupCalls: 0, captureCalls: 0 });
  });

  it('publishes one immutable host-not-quiescent preflight before allocating resources', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const experimentRoot = await mkdtemp(join(tmpdir(), 'cod374-host-gate-'));
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'cod374-host-gate-runtime-'));
    temporaryRoots.push(experimentRoot, runtimeRoot);
    const calls: string[] = [];
    const fixture = await gateProducerFixture({
      experimentRoot,
      runtimeRoot,
      calls,
      hostEvidence: hostQuiescenceEvidence(false),
    });

    await runPhaseBProducer(fixture.options);

    const published = JSON.parse(await readFile(join(experimentRoot, 'attempts/attempt-0001.json'), 'utf8'));
    expect(calls).toEqual(['repository-preflight', 'host-quiescence']);
    expect(published.selection).toMatchObject({
      lifecycle: 'preflight',
      accepted: false,
      failureReasons: [expect.objectContaining({ code: 'host-not-quiescent' })],
    });
    expect(published.quiescence).toEqual({
      host: hostQuiescenceEvidence(false),
      browser: null,
      passed: false,
    });
    expect(published.cells).toEqual([]);
    expect(published.allocation).toEqual({
      browserClosed: false,
      serverStopped: false,
      tmuxRemoved: false,
      tempRootRemoved: false,
      hooksRestored: false,
      listenersDisposed: false,
    });
    expect(published.cleanup).toEqual({
      browserClosed: true,
      serverStopped: true,
      tmuxRemoved: true,
      tempRootRemoved: true,
      hooksRestored: true,
      listenersDisposed: true,
    });
    expect(fixture.counts()).toEqual({ runtimeCleanupCalls: 0, overlayCleanupCalls: 0, captureCalls: 0 });

    await expect(runPhaseBProducer(fixture.options)).rejects.toThrow(/stopped after rejected attempt/i);
    expect(calls).toEqual(['repository-preflight', 'host-quiescence']);
  });

  it('turns a host quiescence measurement exception into terminal safe host-not-quiescent evidence', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const experimentRoot = await mkdtemp(join(tmpdir(), 'cod374-host-gate-error-'));
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'cod374-host-gate-error-runtime-'));
    temporaryRoots.push(experimentRoot, runtimeRoot);
    const calls: string[] = [];
    const fixture = await gateProducerFixture({
      experimentRoot,
      runtimeRoot,
      calls,
      hostError: new Error('host probe secret'),
    });

    await runPhaseBProducer(fixture.options);

    const published = JSON.parse(await readFile(join(experimentRoot, 'attempts/attempt-0001.json'), 'utf8'));
    expect(calls).toEqual(['repository-preflight', 'host-quiescence']);
    expect(published.selection.failureReasons).toEqual([expect.objectContaining({ code: 'host-not-quiescent' })]);
    expect(published.quiescence.host).toMatchObject({
      sampleCount: 0,
      sampleTimesMs: [],
      measurementErrorHash: expect.stringMatching(/^[0-9a-f]{16}$/),
      passed: false,
    });
    expect(published.quiescence.browser).toBeNull();
    expect(JSON.stringify(published)).not.toContain('host probe secret');
    expect(fixture.counts()).toEqual({ runtimeCleanupCalls: 0, overlayCleanupCalls: 0, captureCalls: 0 });
  });

  it('publishes browser-not-quiescent partial evidence before capture and cleans allocated resources once', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const experimentRoot = await mkdtemp(join(tmpdir(), 'cod374-browser-gate-'));
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'cod374-browser-gate-runtime-'));
    temporaryRoots.push(experimentRoot, runtimeRoot);
    const calls: string[] = [];
    const fixture = await gateProducerFixture({
      experimentRoot,
      runtimeRoot,
      calls,
      browserEvidence: browserQuiescenceEvidence(false),
    });

    await runPhaseBProducer(fixture.options);

    const published = JSON.parse(await readFile(join(experimentRoot, 'attempts/attempt-0001.json'), 'utf8'));
    expect(calls.indexOf('repository-preflight')).toBeLessThan(calls.indexOf('host-quiescence'));
    expect(calls.indexOf('host-quiescence')).toBeLessThan(calls.indexOf('overlay-materialize'));
    expect(calls.indexOf('identity-readiness')).toBeLessThan(calls.indexOf('browser-quiescence'));
    expect(calls).not.toContain('capture-repetition');
    expect(published.selection).toMatchObject({
      lifecycle: 'partial',
      accepted: false,
      failureReasons: [expect.objectContaining({ code: 'browser-not-quiescent' })],
    });
    expect(published.quiescence).toEqual({
      host: hostQuiescenceEvidence(),
      browser: browserQuiescenceEvidence(false),
      passed: false,
    });
    expect(published.provenance.runtimeVendorHash).toBe('7'.repeat(64));
    expect(published.provenance.process.server).toMatchObject({ pid: 1001 });
    expect(published.cells).toEqual([]);
    expect(published.cleanup).toEqual({
      browserClosed: true,
      serverStopped: true,
      tmuxRemoved: true,
      tempRootRemoved: true,
      hooksRestored: true,
      listenersDisposed: true,
    });
    expect(fixture.counts()).toEqual({ runtimeCleanupCalls: 1, overlayCleanupCalls: 1, captureCalls: 0 });

    await expect(runPhaseBProducer(fixture.options)).rejects.toThrow(/stopped after rejected attempt/i);
    expect(calls.filter((call) => call === 'browser-quiescence')).toHaveLength(1);
  });

  it('turns a browser quiescence exception into safe browser-not-quiescent evidence and still cleans once', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const experimentRoot = await mkdtemp(join(tmpdir(), 'cod374-browser-gate-error-'));
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'cod374-browser-gate-error-runtime-'));
    temporaryRoots.push(experimentRoot, runtimeRoot);
    const calls: string[] = [];
    const fixture = await gateProducerFixture({
      experimentRoot,
      runtimeRoot,
      calls,
      browserError: new Error('browser probe secret'),
    });

    await runPhaseBProducer(fixture.options);

    const published = JSON.parse(await readFile(join(experimentRoot, 'attempts/attempt-0001.json'), 'utf8'));
    expect(calls).not.toContain('capture-repetition');
    expect(published.selection.failureReasons).toEqual([expect.objectContaining({ code: 'browser-not-quiescent' })]);
    expect(published.quiescence.browser).toMatchObject({
      tickCount: 0,
      driftsMs: [],
      measurementErrorHash: expect.stringMatching(/^[0-9a-f]{16}$/),
      passed: false,
    });
    expect(JSON.stringify(published)).not.toContain('browser probe secret');
    expect(fixture.counts()).toEqual({ runtimeCleanupCalls: 1, overlayCleanupCalls: 1, captureCalls: 0 });
  });

  it('retains browser-not-quiescent independently from cleanup failure evidence', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const experimentRoot = await mkdtemp(join(tmpdir(), 'cod374-browser-gate-cleanup-'));
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'cod374-browser-gate-cleanup-runtime-'));
    temporaryRoots.push(experimentRoot, runtimeRoot);
    const calls: string[] = [];
    const cleanupError = new Error('browser gate cleanup failed');
    const fixture = await gateProducerFixture({
      experimentRoot,
      runtimeRoot,
      calls,
      browserEvidence: browserQuiescenceEvidence(false),
      runtimeCleanupError: cleanupError,
    });

    await runPhaseBProducer(fixture.options);

    const published = JSON.parse(await readFile(join(experimentRoot, 'attempts/attempt-0001.json'), 'utf8'));
    expect(published.selection.failureReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'browser-not-quiescent' }),
        { code: 'runtime-cleanup-failed', detailHash: token(String(cleanupError)) },
      ])
    );
    expect(published.diagnostics.errorHashes).toContain(token(String(cleanupError)));
    expect(published.diagnostics.startupStageHashes).toContain(token('runtime-cleanup'));
    expect(fixture.counts()).toEqual({ runtimeCleanupCalls: 1, overlayCleanupCalls: 1, captureCalls: 0 });
  });

  it('retains browser-not-quiescent plus process contamination when a process is replaced during the gate', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const experimentRoot = await mkdtemp(join(tmpdir(), 'cod374-browser-gate-replacement-'));
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'cod374-browser-gate-replacement-runtime-'));
    temporaryRoots.push(experimentRoot, runtimeRoot);
    const calls: string[] = [];
    const fixture = await gateProducerFixture({
      experimentRoot,
      runtimeRoot,
      calls,
      browserEvidence: browserQuiescenceEvidence(false),
      processReplacementAfterGate: true,
    });

    await runPhaseBProducer(fixture.options);

    const published = JSON.parse(await readFile(join(experimentRoot, 'attempts/attempt-0001.json'), 'utf8'));
    expect(published.selection.failureReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'browser-not-quiescent' }),
        expect.objectContaining({ code: 'runtime-contaminated' }),
      ])
    );
    expect(published.diagnostics.processReplaced).toBe(true);
    expect(published.provenance.process.server).toMatchObject({ pid: 1001, startIdentity: '1001' });
    expect(published.cells).toEqual([]);
    expect(fixture.counts()).toEqual({ runtimeCleanupCalls: 1, overlayCleanupCalls: 1, captureCalls: 0 });
  });

  it('retains browser-not-quiescent plus process contamination when a post-gate identity read fails', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const experimentRoot = await mkdtemp(join(tmpdir(), 'cod374-browser-gate-process-read-'));
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'cod374-browser-gate-process-read-runtime-'));
    temporaryRoots.push(experimentRoot, runtimeRoot);
    const calls: string[] = [];
    const processReadError = new Error('post-gate process read failed secret');
    const fixture = await gateProducerFixture({
      experimentRoot,
      runtimeRoot,
      calls,
      browserEvidence: browserQuiescenceEvidence(false),
      processReadErrorAfterGate: processReadError,
    });

    await runPhaseBProducer(fixture.options);

    const published = JSON.parse(await readFile(join(experimentRoot, 'attempts/attempt-0001.json'), 'utf8'));
    expect(published.selection.failureReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'browser-not-quiescent' }),
        expect.objectContaining({ code: 'runtime-contaminated' }),
      ])
    );
    expect(published.diagnostics).toMatchObject({
      processReplaced: true,
      errorHashes: expect.arrayContaining([token(String(processReadError))]),
      startupStageHashes: expect.arrayContaining([token('runtime-process-verification')]),
    });
    expect(JSON.stringify(published)).not.toContain('post-gate process read failed secret');
    expect(fixture.counts()).toEqual({ runtimeCleanupCalls: 1, overlayCleanupCalls: 1, captureCalls: 0 });
  });

  it.each([
    [
      'undefined',
      {
        browserClosed: false,
        serverStopped: false,
        tmuxRemoved: false,
        hooksRestored: false,
        listenersDisposed: false,
      },
    ],
    [
      'missing',
      { browserClosed: true, serverStopped: true, tmuxRemoved: true, hooksRestored: true, listenersDisposed: false },
    ],
    [
      'false',
      { browserClosed: false, serverStopped: true, tmuxRemoved: true, hooksRestored: true, listenersDisposed: true },
    ],
    [
      'malformed',
      { browserClosed: false, serverStopped: true, tmuxRemoved: true, hooksRestored: true, listenersDisposed: true },
    ],
  ] as const)(
    'treats a resolved %s runtime cleanup result as failure while retaining true proof fields',
    async (runtimeCleanupResult, expectedRuntimeProof) => {
      vi.stubEnv('NODE_ENV', 'test');
      const experimentRoot = await mkdtemp(join(tmpdir(), `cod374-browser-gate-cleanup-${runtimeCleanupResult}-`));
      const runtimeRoot = await mkdtemp(join(tmpdir(), `cod374-browser-gate-cleanup-${runtimeCleanupResult}-runtime-`));
      temporaryRoots.push(experimentRoot, runtimeRoot);
      const calls: string[] = [];
      const fixture = await gateProducerFixture({
        experimentRoot,
        runtimeRoot,
        calls,
        browserEvidence: browserQuiescenceEvidence(false),
        runtimeCleanupResult,
      });

      await runPhaseBProducer(fixture.options);

      const published = JSON.parse(await readFile(join(experimentRoot, 'attempts/attempt-0001.json'), 'utf8'));
      expect(published.selection.failureReasons).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'browser-not-quiescent' }),
          expect.objectContaining({ code: 'runtime-cleanup-failed' }),
        ])
      );
      expect(published.cleanup).toEqual({ ...expectedRuntimeProof, tempRootRemoved: expectedRuntimeProof.tmuxRemoved });
      expect(published.diagnostics).toMatchObject({
        errorHashes: [expect.stringMatching(/^[0-9a-f]{16}$/)],
        startupStageHashes: expect.arrayContaining([token('runtime-cleanup')]),
      });
      expect(fixture.counts()).toEqual({ runtimeCleanupCalls: 1, overlayCleanupCalls: 1, captureCalls: 0 });
    }
  );

  it('runs the concrete producer transaction through test-only async adapters and publishes measured evidence', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const experimentRoot = await mkdtemp(join(tmpdir(), 'cod374-runner-'));
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'cod374-runtime-'));
    temporaryRoots.push(experimentRoot, runtimeRoot);
    const plan = phaseBPlan();
    const launchedAt = new Date(Date.now() - 1_000).toISOString();
    let captured = 0;
    let runtimeCleaned = false;
    let overlayCleaned = false;
    let vendorVerifications = 0;
    let assetVerifications = 0;
    const gateCalls: string[] = [];
    const makeTraceOffArtifact = (sequenceBase: number) => {
      const artifact = structuredClone(actualTask3Artifact());
      artifact.serverEvents = [];
      for (const event of artifact.browserEvents) {
        if (event.clientId !== undefined && event.seq !== undefined) event.seq = sequenceBase + event.inputIndex;
      }
      return artifact;
    };

    const producerOptions = {
      experimentRoot,
      repositoryRoot: '/repo',
      vendorManifestPath: '/repo/vendor.json',
      repetition: plan,
      overlayArtifact: { ...plan.provenance.overlay, product: plan.provenance.product },
      testAdapters: {
        gitVerifier: async () => undefined,
        measureHostQuiescence: async () => {
          gateCalls.push('host-quiescence');
          return hostQuiescenceEvidence();
        },
        provisionDependencies: async () => ({
          dependencyRootHash: plan.provenance.dependencies.dependencyRootHash,
          dependencyContentHash: plan.provenance.dependencies.dependencyContentHash,
          dependencyDevice: plan.provenance.dependencies.dependencyDevice,
          dependencyInode: plan.provenance.dependencies.dependencyInode,
        }),
        verifyProvisionedDependencies: async () => ({
          dependencyRootHash: plan.provenance.dependencies.dependencyRootHash,
          dependencyContentHash: plan.provenance.dependencies.dependencyContentHash,
          dependencyDevice: plan.provenance.dependencies.dependencyDevice,
          dependencyInode: plan.provenance.dependencies.dependencyInode,
        }),
        provisionVendorAssets: async () => ({ vendorRuntimeHash: '7'.repeat(64) }),
        verifyProvisionedVendorAssets: async () => {
          vendorVerifications += 1;
          return { vendorRuntimeHash: '7'.repeat(64) };
        },
        verifyServedAssets: async () => {
          assetVerifications += 1;
        },
        materialize: async () => ({
          root: runtimeRoot,
          files: plan.provenance.overlay.files,
          manifestSha256: plan.provenance.overlay.manifestSha256,
          cleanup: async () => {
            overlayCleaned = true;
          },
        }),
        procIdentity: async (pid: number) => ({
          pid,
          startIdentity: String(pid),
          startedAt: launchedAt,
          startUncertaintyMs: 10,
          cwd: runtimeRoot,
          cmdlineHash: token(String(pid)),
          cmdline:
            pid === 1001
              ? 'node src/index.ts web --host 127.0.0.1'
              : pid === 1003
                ? 'opencode --serve'
                : 'chromium --headless',
        }),
        launch: async () => ({
          runtimeRoot,
          serverPid: 1001,
          browserPid: 1002,
          opencodePid: 1003,
          baseUrl: 'http://127.0.0.1:3000',
          launchedAt,
          fetch: async () => new Response('asset'),
          page: {
            evaluate: async (callback: () => unknown) => {
              if (String(callback).includes('innerWidth')) return { width: 390, height: 844 };
              expect(String(callback)).toContain('terminal?.options?.fontSize');
              expect(String(callback)).not.toContain('getComputedStyle');
              return 9;
            },
          },
          opencodeVersion: async () => 'fixture',
          identities: async () => ({ tmuxSession: 'tmux-fixture', tempRoot: runtimeRoot }),
          measureBrowserQuiescence: async () => {
            gateCalls.push('browser-quiescence');
            return browserQuiescenceEvidence();
          },
          captureRepetition: async () => {
            gateCalls.push('capture-repetition');
            captured += 1;
            return [1, 4].map((rate) => ({
              rate,
              realizedCpuThrottle: rate,
              cpuCalibration: {
                baselineSamplesMs: [10, 10, 10, 10, 10],
                throttledSamplesMs: [10 * rate, 10 * rate, 10 * rate, 10 * rate, 10 * rate],
                baselineMedianMs: 10,
                throttledMedianMs: 10 * rate,
                ratio: rate,
              },
              samples: Array.from({ length: 10 }, (_, index) => makeTraceOffArtifact(rate * 10_000 + index * 10)),
            }));
          },
          diagnostics: async () => ({
            pageErrorHashes: [],
            consoleErrorHashes: [],
            processReplaced: false,
          }),
          cleanup: async () => {
            runtimeCleaned = true;
            return {
              browserClosed: true,
              serverStopped: true,
              tmuxRemoved: true,
              tempRootRemoved: true,
              hooksRestored: true,
              listenersDisposed: true,
            };
          },
        }),
      },
    };
    await runPhaseBProducer(producerOptions);

    expect(captured).toBe(1);
    expect(vendorVerifications).toBe(3);
    expect(assetVerifications).toBe(1);
    expect(gateCalls).toEqual(['host-quiescence', 'browser-quiescence', 'capture-repetition']);
    expect(runtimeCleaned).toBe(true);
    expect(overlayCleaned).toBe(true);
    const manifest = JSON.parse(
      await (await import('node:fs/promises')).readFile(join(experimentRoot, 'ledger.json'), 'utf8')
    );
    expect(manifest.attempts).toHaveLength(1);
    expect(manifest.attempts[0].accepted).toBe(true);
    const published = JSON.parse(
      await (await import('node:fs/promises')).readFile(join(experimentRoot, 'attempts/attempt-0001.json'), 'utf8')
    );
    expect(published.clock.browserClockId).toBe('page-123e4567-e89b-42d3-a456-426614174000');
    expect(published.clock.serverClockId).not.toBe(plan.clock.serverClockId);
    expect(published.clock.harnessClockId).not.toBe(plan.clock.harnessClockId);
    expect(published.provenance.process.runId).not.toBe(plan.provenance.process.runId);
    expect(published.provenance.runtimeVendorHash).toBe('7'.repeat(64));
    expect(published.timing.loadAverageBefore).not.toEqual(plan.timing.loadAverageBefore);
    expect(published.quiescence).toEqual({
      host: hostQuiescenceEvidence(),
      browser: browserQuiescenceEvidence(),
      passed: true,
    });

    const contaminatedRoot = await mkdtemp(join(tmpdir(), 'cod374-runner-contaminated-'));
    temporaryRoots.push(contaminatedRoot);
    let procReads = 0;
    const contaminatedRuntime = await producerOptions.testAdapters.launch();
    const originalCapture = contaminatedRuntime.captureRepetition;
    contaminatedRuntime.captureRepetition = async () => {
      const cells = await originalCapture();
      cells[0].samples[0].resizeEvents = [{ atMs: 12 }];
      return cells;
    };
    await runPhaseBProducer({
      ...producerOptions,
      experimentRoot: contaminatedRoot,
      testAdapters: {
        ...producerOptions.testAdapters,
        procIdentity: async (pid: number) => {
          procReads += 1;
          const identity = await producerOptions.testAdapters.procIdentity(pid);
          return procReads > 3 && pid === 1001 ? { ...identity, startIdentity: '9999' } : identity;
        },
        launch: async () => contaminatedRuntime,
      },
    });
    const contaminated = JSON.parse(
      await (await import('node:fs/promises')).readFile(join(contaminatedRoot, 'attempts/attempt-0001.json'), 'utf8')
    );
    expect(contaminated.selection).toMatchObject({ lifecycle: 'completed', accepted: false });
    expect(contaminated.diagnostics).toMatchObject({ processReplaced: true, resizeEvents: [{ atMs: 12 }] });

    const startupRoot = await mkdtemp(join(tmpdir(), 'cod374-runner-startup-'));
    temporaryRoots.push(startupRoot);
    await runPhaseBProducer({
      ...producerOptions,
      experimentRoot: startupRoot,
      testAdapters: {
        ...producerOptions.testAdapters,
        launch: async () => {
          const nestedMessage = 'ERR_MODULE_NOT_FOUND secret-looking-token';
          throw Object.assign(new AggregateError([new Error(nestedMessage)], 'startup failed after allocation'), {
            postAllocation: true,
            launchedAt,
            serverDiagnostics: { stdoutHashes: [], stderrHashes: [token('secret-looking-token')] },
            cleanupAllocation: {
              browserClosed: false,
              serverStopped: true,
              tmuxRemoved: false,
              tempRootRemoved: false,
              hooksRestored: false,
              listenersDisposed: false,
            },
            cleanupProof: {
              browserClosed: true,
              serverStopped: true,
              tmuxRemoved: true,
              tempRootRemoved: true,
              hooksRestored: true,
              listenersDisposed: true,
            },
          });
        },
      },
    });
    const startup = JSON.parse(
      await (await import('node:fs/promises')).readFile(join(startupRoot, 'attempts/attempt-0001.json'), 'utf8')
    );
    expect(startup.selection).toMatchObject({ lifecycle: 'partial', accepted: false });
    expect(startup.cleanup).toEqual({
      browserClosed: true,
      serverStopped: true,
      tmuxRemoved: true,
      tempRootRemoved: true,
      hooksRestored: true,
      listenersDisposed: true,
    });
    expect(startup.allocation).toEqual({
      browserClosed: false,
      serverStopped: true,
      tmuxRemoved: false,
      tempRootRemoved: true,
      hooksRestored: false,
      listenersDisposed: false,
    });
    expect(JSON.stringify(startup)).not.toContain('secret-looking-token');
    expect(startup.diagnostics.startupMessageHashes).toContain(token('ERR_MODULE_NOT_FOUND secret-looking-token'));
    expect(startup.diagnostics.serverStderrHashes).toContain(token('secret-looking-token'));

    const mismatchRoot = await mkdtemp(join(tmpdir(), 'cod374-runner-mismatch-'));
    temporaryRoots.push(mismatchRoot);
    const capturedBeforeMismatch = captured;
    await runPhaseBProducer({
      ...producerOptions,
      experimentRoot: mismatchRoot,
      overlayArtifact: { ...producerOptions.overlayArtifact, patchSha256: '0'.repeat(64) },
    });
    const mismatch = JSON.parse(
      await (await import('node:fs/promises')).readFile(join(mismatchRoot, 'attempts/attempt-0001.json'), 'utf8')
    );
    expect(mismatch.selection).toMatchObject({ lifecycle: 'preflight', accepted: false });
    expect(captured).toBe(capturedBeforeMismatch);

    const partialRoot = await mkdtemp(join(tmpdir(), 'cod374-runner-partial-'));
    temporaryRoots.push(partialRoot);
    const partialRuntime = await producerOptions.testAdapters.launch();
    partialRuntime.captureRepetition = async () => {
      const error = new Error('capture stopped');
      Object.assign(error, {
        partialArtifacts: [
          {
            rate: 1,
            realizedCpuThrottle: 1,
            cpuCalibration: {
              baselineSamplesMs: [10, 10, 10, 10, 10],
              throttledSamplesMs: [10, 10, 10, 10, 10],
              baselineMedianMs: 10,
              throttledMedianMs: 10,
              ratio: 1,
            },
            samples: [makeTraceOffArtifact(30_000)],
          },
        ],
      });
      throw error;
    };
    await runPhaseBProducer({
      ...producerOptions,
      experimentRoot: partialRoot,
      testAdapters: { ...producerOptions.testAdapters, launch: async () => partialRuntime },
    });
    const partial = JSON.parse(
      await (await import('node:fs/promises')).readFile(join(partialRoot, 'attempts/attempt-0001.json'), 'utf8')
    );
    expect(partial.selection).toMatchObject({ lifecycle: 'partial', accepted: false });
    expect(partial.cells[0].samples).toHaveLength(1);

    const setupFailureRoot = await mkdtemp(join(tmpdir(), 'cod374-runner-setup-failure-'));
    temporaryRoots.push(setupFailureRoot);
    const setupFailureRuntime = await producerOptions.testAdapters.launch({});
    setupFailureRuntime.identities = async () => {
      throw new Error('runtime identity failed');
    };
    await runPhaseBProducer({
      ...producerOptions,
      experimentRoot: setupFailureRoot,
      testAdapters: { ...producerOptions.testAdapters, launch: async () => setupFailureRuntime },
    });
    const setupFailure = JSON.parse(
      await (await import('node:fs/promises')).readFile(join(setupFailureRoot, 'attempts/attempt-0001.json'), 'utf8')
    );
    expect(setupFailure.selection).toMatchObject({ lifecycle: 'partial', accepted: false });
    expect(setupFailure.cells).toEqual([]);
    expect(setupFailure.provenance.process.server).toMatchObject({ pid: 1001 });
    expect(setupFailure.provenance.process.tempRootHash).toBeNull();

    const postCleanupRoot = await mkdtemp(join(tmpdir(), 'cod374-runner-post-cleanup-'));
    temporaryRoots.push(postCleanupRoot);
    const postCleanupRuntime = await producerOptions.testAdapters.launch();
    const retainedConsoleHash = 'abcdef0123456789';
    postCleanupRuntime.diagnostics = async () => ({
      pageErrorHashes: [],
      consoleErrorHashes: [retainedConsoleHash],
      processReplaced: false,
    });
    let postCleanupRuntimeCalls = 0;
    let postCleanupOverlayCalls = 0;
    postCleanupRuntime.cleanup = async () => {
      postCleanupRuntimeCalls += 1;
      return {
        browserClosed: true,
        serverStopped: true,
        tmuxRemoved: true,
        tempRootRemoved: true,
        hooksRestored: true,
        listenersDisposed: true,
      };
    };
    const proofMessage = `dynamic proof failure ${randomBytes(8).toString('hex')}`;
    await runPhaseBProducer({
      ...producerOptions,
      experimentRoot: postCleanupRoot,
      testAdapters: {
        ...producerOptions.testAdapters,
        materialize: async () => ({
          root: runtimeRoot,
          files: plan.provenance.overlay.files,
          manifestSha256: plan.provenance.overlay.manifestSha256,
          cleanup: async () => {
            postCleanupOverlayCalls += 1;
          },
        }),
        launch: async () => postCleanupRuntime,
        measureRuntimeObservation: () => {
          throw new Error(proofMessage);
        },
      },
    });
    const postCleanup = JSON.parse(
      await (await import('node:fs/promises')).readFile(join(postCleanupRoot, 'attempts/attempt-0001.json'), 'utf8')
    );
    expect(postCleanupRuntimeCalls).toBe(1);
    expect(postCleanupOverlayCalls).toBe(1);
    expect(postCleanup.selection).toMatchObject({ attempt: 1, lifecycle: 'partial', accepted: false });
    expect(postCleanup.selection.failureReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'runtime-contaminated' }),
        { code: 'runtime-proof-failed', detailHash: token(`Error: ${proofMessage}`) },
      ])
    );
    expect(postCleanup.cleanup).toEqual({
      browserClosed: true,
      serverStopped: true,
      tmuxRemoved: true,
      tempRootRemoved: true,
      hooksRestored: true,
      listenersDisposed: true,
    });
    expect(postCleanup.cells).toHaveLength(2);
    expect(postCleanup.cells.every((cell: any) => cell.samples.length === 10)).toBe(true);
    expect(postCleanup.diagnostics.consoleErrorHashes).toEqual([retainedConsoleHash]);
    expect(postCleanup.diagnostics.errorHashes).toContain(token(`Error: ${proofMessage}`));
    expect(postCleanup.diagnostics.startupStageHashes).toContain(token('runtime-proof'));
    expect(postCleanup.diagnostics.startupMessageHashes).toContain(token(proofMessage));

    const partialCleanupRoot = await mkdtemp(join(tmpdir(), 'cod374-runner-partial-cleanup-proof-'));
    temporaryRoots.push(partialCleanupRoot);
    const partialCleanupRuntime = await producerOptions.testAdapters.launch();
    let partialCleanupRuntimeCalls = 0;
    let partialCleanupOverlayCalls = 0;
    const cleanupMessage = `dynamic cleanup failure ${randomBytes(8).toString('hex')}`;
    partialCleanupRuntime.cleanup = async () => {
      partialCleanupRuntimeCalls += 1;
      throw Object.assign(new Error(cleanupMessage), {
        cleanupProof: {
          browserClosed: true,
          serverStopped: true,
          tmuxRemoved: true,
          tempRootRemoved: true,
          hooksRestored: true,
          listenersDisposed: true,
        },
      });
    };
    const postCleanupProofMessage = `dynamic post-cleanup proof failure ${randomBytes(8).toString('hex')}`;
    await runPhaseBProducer({
      ...producerOptions,
      experimentRoot: partialCleanupRoot,
      testAdapters: {
        ...producerOptions.testAdapters,
        materialize: async () => ({
          root: runtimeRoot,
          files: plan.provenance.overlay.files,
          manifestSha256: plan.provenance.overlay.manifestSha256,
          cleanup: async () => {
            partialCleanupOverlayCalls += 1;
          },
        }),
        launch: async () => partialCleanupRuntime,
        measureRuntimeObservation: () => {
          throw new Error(postCleanupProofMessage);
        },
      },
    });
    const partialCleanup = JSON.parse(
      await (await import('node:fs/promises')).readFile(join(partialCleanupRoot, 'attempts/attempt-0001.json'), 'utf8')
    );
    expect(partialCleanupRuntimeCalls).toBe(1);
    expect(partialCleanupOverlayCalls).toBe(1);
    expect(partialCleanup.selection).toMatchObject({ lifecycle: 'partial', accepted: false });
    expect(partialCleanup.selection.failureReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'runtime-contaminated' }),
        { code: 'runtime-proof-failed', detailHash: token(`Error: ${postCleanupProofMessage}`) },
        { code: 'runtime-cleanup-failed', detailHash: token(`Error: ${cleanupMessage}`) },
      ])
    );
    expect(partialCleanup.cleanup).toEqual({
      browserClosed: true,
      serverStopped: true,
      tmuxRemoved: true,
      tempRootRemoved: true,
      hooksRestored: true,
      listenersDisposed: true,
    });
    expect(partialCleanup.cells).toHaveLength(2);
    expect(partialCleanup.diagnostics.errorHashes).toEqual(
      expect.arrayContaining([token(`Error: ${cleanupMessage}`), token(`Error: ${postCleanupProofMessage}`)])
    );
    expect(partialCleanup.diagnostics.startupStageHashes).toEqual(
      expect.arrayContaining([token('runtime-cleanup'), token('runtime-proof')])
    );
    expect(partialCleanup.diagnostics.startupMessageHashes).toEqual(
      expect.arrayContaining([token(cleanupMessage), token(postCleanupProofMessage)])
    );

    const strictValidationRoot = await mkdtemp(join(tmpdir(), 'cod374-runner-strict-validation-'));
    temporaryRoots.push(strictValidationRoot);
    const strictValidationRuntime = await producerOptions.testAdapters.launch();
    const strictCapture = strictValidationRuntime.captureRepetition;
    let strictCleanupCalls = 0;
    strictValidationRuntime.captureRepetition = async () => {
      const cells = await strictCapture();
      const events = cells[0].samples[0].browserEvents;
      const group = events.filter((event: any) => event.generation === 0 && event.writeId === 1);
      const insertAt = Math.min(...group.map((event: any) => events.indexOf(event)));
      cells[0].samples[0].browserEvents = events.filter((event: any) => !group.includes(event));
      cells[0].samples[0].browserEvents.splice(
        insertAt,
        0,
        ...[
          'browser.xterm-write',
          'browser.xterm-parsed',
          'browser.xterm-write-callback',
          'browser.xterm-write-return',
        ].map((stage, index) => ({
          ...group.find((event: any) => event.stage === stage),
          atMs: group[0].atMs + index,
        }))
      );
      return cells;
    };
    strictValidationRuntime.cleanup = async () => {
      strictCleanupCalls += 1;
      return {
        browserClosed: true,
        serverStopped: true,
        tmuxRemoved: true,
        tempRootRemoved: true,
        hooksRestored: true,
        listenersDisposed: true,
      };
    };
    await runPhaseBProducer({
      ...producerOptions,
      experimentRoot: strictValidationRoot,
      testAdapters: { ...producerOptions.testAdapters, launch: async () => strictValidationRuntime },
    });
    const strictValidation = JSON.parse(
      await (
        await import('node:fs/promises')
      ).readFile(join(strictValidationRoot, 'attempts/attempt-0001.json'), 'utf8')
    );
    expect(strictCleanupCalls).toBe(1);
    expect(strictValidation.selection).toMatchObject({ lifecycle: 'partial', accepted: false });
    expect(strictValidation.selection.failureReasons).toEqual(
      expect.arrayContaining([
        {
          code: 'runtime-proof-failed',
          detailHash: token('Error: COD-374 evidence invalid: browser xterm write chain is incomplete or out of order'),
        },
      ])
    );
    expect(strictValidation.selection.failureReasons).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'producer-crash' })])
    );
    expect(strictValidation.cells).toHaveLength(1);
    expect(strictValidation.cells[0].samples).toEqual([]);
    expect(strictValidation.cleanup).toEqual({
      browserClosed: true,
      serverStopped: true,
      tmuxRemoved: true,
      tempRootRemoved: true,
      hooksRestored: true,
      listenersDisposed: true,
    });
    expect(strictValidation.diagnostics.startupStageHashes).toContain(token('runtime-proof'));
    expect(JSON.stringify(strictValidation)).not.toContain('browser xterm write chain is incomplete or out of order');
  });
});
it('waits for terminal initialization and an open SSE stream before creating the measured session', async () => {
  const app: any = { terminal: null, eventSource: { readyState: 0 }, _connectionStatus: 'connecting' };
  const originalWindow = (globalThis as any).window;
  (globalThis as any).window = { app };
  const observations: boolean[] = [];
  const page: any = {
    bringToFront: async () => observations.push(false),
    waitForFunction: async (callback: () => boolean) => {
      observations.push(callback());
      app.terminal = { options: {} };
      app.eventSource.readyState = 1;
      app._connectionStatus = 'connected';
      observations.push(callback());
    },
  };
  try {
    await awaitPhaseBAppReadiness(page);
  } finally {
    (globalThis as any).window = originalWindow;
  }
  expect(observations).toEqual([false, false, true]);
});

it('reports only safe readiness booleans when the app readiness barrier times out', async () => {
  const page: any = {
    bringToFront: async () => {},
    waitForFunction: async () => {
      throw new Error('timeout');
    },
    evaluate: async () => ({ terminalOptions: true, eventSourceOpen: false, connected: true }),
  };
  await expect(awaitPhaseBAppReadiness(page)).rejects.toThrow(
    'Phase B app readiness timed out (terminalOptions=true,eventSourceOpen=false,connected=true)'
  );
});
