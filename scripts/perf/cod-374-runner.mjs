#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink } from 'node:fs/promises';
import { hostname, loadavg, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  OVERLAY_FILES,
  bindExperimentPreflightQuiescence,
  canonicalJson,
  measureRuntimeObservation,
  runExperimentProducerTransaction,
  validateAttempt,
  verifyExperimentPreflight,
} from './cod-374-summarize.mjs';
import {
  BROWSER_TIMER_INTERVAL_MS,
  HOST_SAMPLE_INTERVAL_MS,
  measureHostQuiescence,
  validateBrowserQuiescence,
  validatePersistedHostQuiescence,
} from './cod-374-quiescence.mjs';

const execFileAsync = promisify(execFile);
const WORKLOAD = [
  { inputIndex: 0, generation: 1, tokenHash: '8e35c2cd3bf6641b', tokenLength: 1 },
  { inputIndex: 1, generation: 2, tokenHash: 'fee3b802a9ba4eeb', tokenLength: 2 },
  { inputIndex: 2, generation: 3, tokenHash: '93557903501f1ae7', tokenLength: 3 },
];
const VENDOR_RUNTIME_FILES = [
  'src/web/public/vendor/dompurify.min.js',
  'src/web/public/vendor/exceljs.min.js',
  'src/web/public/vendor/fflate.min.js',
  'src/web/public/vendor/marked.min.js',
  'src/web/public/vendor/xterm-addon-fit.min.js',
  'src/web/public/vendor/xterm-addon-serialize.min.js',
  'src/web/public/vendor/xterm-addon-unicode11.min.js',
  'src/web/public/vendor/xterm-addon-webgl.min.js',
  'src/web/public/vendor/xterm-predictive-echo.js',
  'src/web/public/vendor/xterm-zerolag-input.js',
  'src/web/public/vendor/xterm.css',
  'src/web/public/vendor/xterm.min.js',
];
const TRACKED_VENDOR_RUNTIME_FILES = new Set([
  'src/web/public/vendor/dompurify.min.js',
  'src/web/public/vendor/marked.min.js',
]);

function fail(message) {
  throw new Error(`COD-374 producer invalid: ${message}`);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hash16(value) {
  return sha256(value).slice(0, 16);
}

function retainSchemaValidCellPrefix(repetition) {
  const retained = { ...repetition, cells: [] };
  validateAttempt(retained);
  for (const cell of repetition.cells) {
    const retainedCell = { ...cell, samples: [] };
    const withCell = { ...retained, cells: [...retained.cells, retainedCell] };
    try {
      validateAttempt(withCell);
    } catch {
      return retained;
    }
    retained.cells = withCell.cells;
    for (const sample of cell.samples) {
      retainedCell.samples.push(sample);
      try {
        validateAttempt(retained);
      } catch {
        retainedCell.samples.pop();
        return retained;
      }
    }
  }
  return retained;
}

const CLI_AVAILABILITY_KEYS = Object.freeze([
  'claude',
  'opencode',
  'codex',
  'gemini',
  'antigravity',
  'pi',
  'cloudflared',
  'git',
]);

function singleOccurrence(value, token, label) {
  if (value.indexOf(token) === -1 || value.indexOf(token) !== value.lastIndexOf(token)) {
    fail(`rendered index ${label} is ambiguous`);
  }
}

function escapeHtmlText(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function canonicalizeRenderedIndexHtml({ sourceHtml, renderedHtml, expectedTitle }) {
  if (
    typeof sourceHtml !== 'string' ||
    typeof renderedHtml !== 'string' ||
    typeof expectedTitle !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(expectedTitle) ||
    renderedHtml.length > sourceHtml.length + 4_096
  ) {
    fail('rendered index input is invalid');
  }
  const sourceTitle = '<title>Codeman</title>';
  const renderedTitle = `<title>${escapeHtmlText(expectedTitle)}</title>`;
  singleOccurrence(sourceHtml, sourceTitle, 'source title');
  singleOccurrence(renderedHtml, renderedTitle, 'title');
  singleOccurrence(sourceHtml, ' btn-multimonitor--hidden', 'multi-monitor toggle');
  singleOccurrence(sourceHtml, ' btn-away-digest--hidden', 'away-digest toggle');

  const sourceAssetRefs = [...sourceHtml.matchAll(/(\s(?:src|href)=")([^"?:]+\.(?:js|css))(")/g)].map(
    (match) => `${match[1]}\0${match[2]}`
  );
  const renderedAssetRefs = [
    ...renderedHtml.matchAll(/(\s(?:src|href)=")([^"?:]+\.(?:js|css))\?v=(?:0|[1-9][0-9]{0,15})(")/g),
  ].map((match) => `${match[1]}\0${match[2]}`);
  if (
    sourceAssetRefs.length === 0 ||
    sourceAssetRefs.length !== renderedAssetRefs.length ||
    sourceAssetRefs.some((entry, index) => entry !== renderedAssetRefs[index])
  ) {
    fail('rendered index asset cache-busters are invalid');
  }

  const cliPattern = /<script>window\.__codemanCliAvailable=([^<\n]{2,512});<\/script>\n<\/head>/g;
  const cliMatches = [...renderedHtml.matchAll(cliPattern)];
  if (cliMatches.length !== 1) fail('rendered index CLI bootstrap is missing or ambiguous');
  let cliFlags;
  try {
    cliFlags = JSON.parse(cliMatches[0][1]);
  } catch {
    fail('rendered index CLI bootstrap is invalid');
  }
  if (
    !cliFlags ||
    typeof cliFlags !== 'object' ||
    Array.isArray(cliFlags) ||
    Object.keys(cliFlags).join(',') !== CLI_AVAILABILITY_KEYS.join(',') ||
    Object.values(cliFlags).some((value) => typeof value !== 'boolean') ||
    JSON.stringify(cliFlags) !== cliMatches[0][1]
  ) {
    fail('rendered index CLI bootstrap is invalid');
  }

  const normalized = renderedHtml
    .replace(cliPattern, '</head>')
    .replace(renderedTitle, sourceTitle)
    .replace(/(\s(?:src|href)="[^"?:]+\.(?:js|css))\?v=(?:0|[1-9][0-9]{0,15})(")/g, '$1$2');
  const candidates = [sourceHtml];
  for (const marker of [' btn-multimonitor--hidden', ' btn-away-digest--hidden']) {
    candidates.push(...candidates.map((candidate) => candidate.replace(marker, '')));
  }
  if (!candidates.includes(normalized)) fail('rendered index contains a non-allowlisted mutation');
  return sourceHtml;
}

export async function verifyServedRuntimeAssets({
  runtimeRoot,
  baseUrl,
  fetch,
  expectedAssets,
  expectedTitle = `codeman:${hostname()}`,
}) {
  if (!Array.isArray(expectedAssets)) fail('served asset manifest is invalid');
  for (const entry of expectedAssets) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      Object.keys(entry).sort().join(',') !== 'path,sha256' ||
      typeof entry.path !== 'string' ||
      typeof entry.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(entry.sha256)
    ) {
      fail('served asset manifest is invalid');
    }
  }
  const paths = expectedAssets.map((entry) => entry.path);
  if (paths.join(',') !== '/,/app.js,/styles.css') fail('served asset manifest is invalid');
  const exactRuntimeRoot = await realpath(runtimeRoot);
  const sourcePaths = {
    '/': join(exactRuntimeRoot, 'src/web/public/index.html'),
    '/app.js': join(exactRuntimeRoot, 'src/web/public/app.js'),
    '/styles.css': join(exactRuntimeRoot, 'src/web/public/styles.css'),
  };
  const sources = {};
  for (const expected of expectedAssets) {
    const sourcePath = sourcePaths[expected.path];
    const info = await lstat(sourcePath);
    if (!info.isFile() || info.isSymbolicLink()) fail(`served asset source is unsafe: ${expected.path}`);
    const bytes = await readFile(sourcePath);
    if (sha256(bytes) !== expected.sha256) fail(`served asset source hash mismatch: ${expected.path}`);
    sources[expected.path] = bytes;
  }
  const sourceIndex = sources['/'].toString('utf8');
  if (!/(?:src|href)="app\.js"/.test(sourceIndex) || !/(?:src|href)="styles\.css"/.test(sourceIndex)) {
    fail('served asset source references are invalid');
  }

  const responses = {};
  for (const expected of expectedAssets) {
    const response = await fetch(`${baseUrl}${expected.path}`);
    if (!response.ok) fail(`served asset failed: ${expected.path}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 32 * 1024 * 1024) fail(`served asset is too large: ${expected.path}`);
    responses[expected.path] = bytes;
  }
  canonicalizeRenderedIndexHtml({
    sourceHtml: sourceIndex,
    renderedHtml: responses['/'].toString('utf8'),
    expectedTitle,
  });
  for (const path of ['/app.js', '/styles.css']) {
    if (
      !responses[path].equals(sources[path]) ||
      sha256(responses[path]) !== expectedAssets.find((entry) => entry.path === path).sha256
    ) {
      fail(`served asset hash mismatch: ${path}`);
    }
  }
  return {
    sourceIndexSha256: sha256(sources['/']),
    renderedIndexSha256: sha256(responses['/']),
    appSha256: sha256(responses['/app.js']),
    stylesSha256: sha256(responses['/styles.css']),
  };
}

export async function readTerminalFontPx(page) {
  if (!page || typeof page.evaluate !== 'function') fail('terminal font probe is unavailable');
  const fontPx = await page.evaluate(() => window.app?.terminal?.options?.fontSize);
  if (typeof fontPx !== 'number' || !Number.isFinite(fontPx) || fontPx <= 0) {
    fail('terminal font option is missing or invalid');
  }
  return fontPx;
}

async function vendorRuntimeManifest(options) {
  const bytes = await readFile(resolve(options.vendorManifestPath));
  if (sha256(bytes) !== options.expectedManifestSha256) fail('vendor manifest hash mismatch');
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('vendor manifest JSON is invalid');
  }
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest) ||
    Object.keys(manifest).sort().join(',') !== 'files,schemaVersion' ||
    manifest.schemaVersion !== 1 ||
    !Array.isArray(manifest.files)
  )
    fail('vendor manifest schema is invalid');
  const entries = manifest.files.map((entry) => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      Object.keys(entry).sort().join(',') !== 'file,sha256' ||
      typeof entry.file !== 'string' ||
      typeof entry.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(entry.sha256)
    )
      fail('vendor manifest entry is invalid');
    return entry;
  });
  const paths = entries.map((entry) => entry.file);
  if (
    new Set(paths).size !== paths.length ||
    paths.slice().sort().join('\n') !== VENDOR_RUNTIME_FILES.slice().sort().join('\n')
  )
    fail('vendor manifest allowlist is invalid');
  return entries.slice().sort((left, right) => left.file.localeCompare(right.file));
}

async function measureRuntimeVendorAssets(options, provision) {
  const entries = await vendorRuntimeManifest(options);
  const exactRepositoryRoot = await realpath(options.repositoryRoot);
  const exactRuntimeRoot = await realpath(options.runtimeRoot);
  const runtimeVendorDirectory = join(exactRuntimeRoot, 'src/web/public/vendor');
  if (provision) await mkdir(runtimeVendorDirectory, { recursive: true, mode: 0o755 });
  const vendorDirectoryInfo = await lstat(runtimeVendorDirectory);
  if (
    !vendorDirectoryInfo.isDirectory() ||
    vendorDirectoryInfo.isSymbolicLink() ||
    (typeof process.getuid === 'function' && vendorDirectoryInfo.uid !== process.getuid())
  )
    fail('runtime vendor directory is unsafe');
  const proofRows = [];
  for (const entry of entries) {
    const source = join(exactRepositoryRoot, entry.file);
    if (!source.startsWith(`${exactRepositoryRoot}/`)) fail('vendor source escapes repository');
    const sourceInfo = await lstat(source, { bigint: true });
    if (
      !sourceInfo.isFile() ||
      sourceInfo.isSymbolicLink() ||
      (typeof process.getuid === 'function' && Number(sourceInfo.uid) !== process.getuid())
    )
      fail('vendor source is not an owned regular file');
    const sourceBytes = await readFile(source);
    const mode = Number(sourceInfo.mode) & 0o777;
    const size = Number(sourceInfo.size);
    if ((mode & 0o002) !== 0 || size < 1 || size > 16 * 1024 * 1024) fail('vendor source mode or size is invalid');
    if (sha256(sourceBytes) !== entry.sha256) fail('vendor source hash mismatch');
    const target = join(exactRuntimeRoot, entry.file);
    if (!target.startsWith(`${exactRuntimeRoot}/`)) fail('vendor target escapes runtime');
    let runtimeMode = 'link';
    if (TRACKED_VENDOR_RUNTIME_FILES.has(entry.file)) {
      const targetInfo = await lstat(target);
      if (!targetInfo.isFile() || targetInfo.isSymbolicLink()) fail('tracked vendor file is not a regular file');
      const targetBytes = await readFile(target);
      runtimeMode = (targetInfo.mode & 0o777).toString(8);
      if ((targetInfo.mode & 0o002) !== 0 || targetInfo.size !== size || sha256(targetBytes) !== entry.sha256)
        fail('tracked vendor file would be overwritten');
    } else if (provision) {
      try {
        await lstat(target);
        fail('ignored vendor target must be absent');
      } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
      }
      await symlink(source, target, 'file');
    }
    if (!TRACKED_VENDOR_RUNTIME_FILES.has(entry.file)) {
      const targetInfo = await lstat(target);
      if (!targetInfo.isSymbolicLink() || (await realpath(target)) !== source)
        fail('ignored vendor symlink target is invalid');
    }
    proofRows.push(
      `${entry.file}\0${mode.toString(8)}\0${runtimeMode}\0${size}\0${entry.sha256}\0${sourceInfo.dev}\0${sourceInfo.ino}`
    );
  }
  return { vendorRuntimeHash: sha256(proofRows.join('\n')) };
}

export async function provisionRuntimeVendorAssets(options) {
  return measureRuntimeVendorAssets(options, true);
}

export async function verifyProvisionedRuntimeVendorAssets({ expectedProof, ...options }) {
  const proof = await measureRuntimeVendorAssets(options, false);
  if (!expectedProof || proof.vendorRuntimeHash !== expectedProof.vendorRuntimeHash)
    fail('runtime vendor identity changed');
  return proof;
}

export function errorDiagnosticHashes(error, stage) {
  const names = [];
  const messages = [];
  const seen = new Set();
  const visit = (entry) => {
    if (!entry || typeof entry !== 'object' || seen.has(entry) || seen.size >= 32) return;
    seen.add(entry);
    names.push(hash16(String(entry.name ?? 'Error')));
    messages.push(hash16(String(entry.message ?? entry)));
    if (entry instanceof AggregateError) entry.errors.forEach(visit);
    visit(entry.cause);
  };
  visit(error);
  return {
    startupStageHashes: [hash16(stage)],
    startupNameHashes: [...new Set(names)],
    startupMessageHashes: [...new Set(messages)],
  };
}

async function verifiedHarnessDependencyRoot(repositoryRoot, expectedLockSha256) {
  const dependencyPath = join(repositoryRoot, 'node_modules');
  const dependencyInfo = await lstat(dependencyPath);
  if (!dependencyInfo.isDirectory() || dependencyInfo.isSymbolicLink()) fail('harness dependency root is not owned');
  if (typeof process.getuid === 'function' && dependencyInfo.uid !== process.getuid())
    fail('harness dependency root owner is unsafe');
  const lockSha256 = sha256(await readFile(join(repositoryRoot, 'package-lock.json')));
  if (lockSha256 !== expectedLockSha256) fail('harness dependency lock hash mismatch');
  const exactDependencyRoot = await realpath(dependencyPath);
  const installedLockBytes = await readFile(join(exactDependencyRoot, '.package-lock.json'));
  const installedLock = JSON.parse(installedLockBytes.toString('utf8'));
  const packagePaths = Object.entries(installedLock.packages ?? {})
    .filter(([path]) => path.startsWith('node_modules/'))
    .map(([path]) => path)
    .sort();
  if (
    packagePaths.length === 0 ||
    packagePaths.some(
      (path) =>
        path.length > 512 ||
        /[\\\r\n\0]/.test(path) ||
        path.split('/').includes('..') ||
        !/^node_modules\/(?:@?[a-z0-9._-]+)(?:\/(?:@?[a-z0-9._-]+))*$/i.test(path)
    )
  )
    fail('dependency package path is unsafe');
  const entries = [];
  let fileCount = 0;
  let byteCount = 0;
  const exactRepositoryRoot = await realpath(repositoryRoot);
  const resolvedTargetManifest = async (resolvedTarget) => {
    if (resolvedTarget !== exactRepositoryRoot && !resolvedTarget.startsWith(`${exactRepositoryRoot}/`))
      fail('dependency symlink escapes harness repository');
    const targetEntries = [];
    const seen = new Set();
    const walk = async (absolutePath, relativePath) => {
      const info = await lstat(absolutePath, { bigint: true });
      if (info.isDirectory()) {
        const identity = `${info.dev}:${info.ino}`;
        if (seen.has(identity)) return;
        seen.add(identity);
        for (const child of (await readdir(absolutePath)).sort()) {
          if (child === '.git' || child === 'node_modules') continue;
          await walk(join(absolutePath, child), `${relativePath}/${child}`);
        }
        return;
      }
      fileCount += 1;
      if (fileCount > 50_000) fail('dependency content manifest file bound exceeded');
      const mode = (Number(info.mode) & 0o777).toString(8);
      if (info.isSymbolicLink()) {
        const target = await readlink(absolutePath);
        const nestedResolved = await realpath(absolutePath);
        if (nestedResolved !== exactRepositoryRoot && !nestedResolved.startsWith(`${exactRepositoryRoot}/`))
          fail('dependency target content symlink escapes harness repository');
        targetEntries.push(
          `${relativePath}\0link\0${mode}\0${sha256(target)}\0${sha256(
            nestedResolved.slice(exactRepositoryRoot.length) || '.'
          )}`
        );
        await walk(nestedResolved, `${relativePath}->target`);
        return;
      }
      if (!info.isFile()) fail('dependency target content contains a special file');
      const size = Number(info.size);
      byteCount += size;
      if (byteCount > 1024 * 1024 * 1024) fail('dependency content manifest byte bound exceeded');
      targetEntries.push(`${relativePath}\0file\0${mode}\0${size}\0${sha256(await readFile(absolutePath))}`);
    };
    await walk(resolvedTarget, '.');
    const targetIdentity = await lstat(resolvedTarget, { bigint: true });
    return {
      relativeTarget: resolvedTarget.slice(exactRepositoryRoot.length) || '.',
      device: targetIdentity.dev.toString(),
      inode: targetIdentity.ino.toString(),
      contentHash: sha256(targetEntries.sort().join('\n')),
    };
  };
  const visit = async (absolutePath, relativePath) => {
    const info = await lstat(absolutePath);
    if (info.isDirectory()) {
      for (const child of (await readdir(absolutePath)).sort()) {
        await visit(join(absolutePath, child), `${relativePath}/${child}`);
      }
      return;
    }
    fileCount += 1;
    if (fileCount > 50_000) fail('dependency content manifest file bound exceeded');
    const mode = (info.mode & 0o777).toString(8);
    if (info.isSymbolicLink()) {
      const target = await readlink(absolutePath);
      if (target.length > 512 || /[\r\n\0]/.test(target)) fail('dependency symlink target is unsafe');
      const resolved = await realpath(absolutePath);
      const resolvedManifest = await resolvedTargetManifest(resolved);
      entries.push(
        `${relativePath}\0link\0${mode}\0${sha256(target)}\0${sha256(resolvedManifest.relativeTarget)}\0${
          resolvedManifest.device
        }\0${resolvedManifest.inode}\0${resolvedManifest.contentHash}`
      );
      return;
    }
    if (!info.isFile()) fail('dependency content manifest contains a special file');
    byteCount += info.size;
    if (byteCount > 1024 * 1024 * 1024) fail('dependency content manifest byte bound exceeded');
    const bytes = await readFile(absolutePath);
    entries.push(`${relativePath}\0file\0${mode}\0${info.size}\0${sha256(bytes)}`);
  };
  entries.push(`node_modules/.package-lock.json\0file\0${sha256(installedLockBytes)}`);
  for (const packagePath of packagePaths) {
    const visitPackage = async (absolutePath, relativePath) => {
      const info = await lstat(absolutePath);
      if (info.isDirectory()) {
        for (const child of (await readdir(absolutePath)).sort()) {
          if (child === 'node_modules') continue;
          await visitPackage(join(absolutePath, child), `${relativePath}/${child}`);
        }
        return;
      }
      await visit(absolutePath, relativePath);
    };
    await visitPackage(join(repositoryRoot, packagePath), packagePath);
  }
  const identity = await lstat(exactDependencyRoot, { bigint: true });
  return {
    exactDependencyRoot,
    dependencyContentHash: sha256(entries.sort().join('\n')),
    dependencyDevice: identity.dev.toString(),
    dependencyInode: identity.ino.toString(),
  };
}

export async function provisionRuntimeDependencies({ runtimeRoot, repositoryRoot, expectedLockSha256 }) {
  const exactRuntimeRoot = await realpath(runtimeRoot);
  const dependency = await verifiedHarnessDependencyRoot(repositoryRoot, expectedLockSha256);
  const exactDependencyRoot = dependency.exactDependencyRoot;
  const target = join(exactRuntimeRoot, 'node_modules');
  if (await lstat(target).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error))))
    fail('runtime dependency target must be absent');
  await symlink(exactDependencyRoot, target, 'dir');
  const targetInfo = await lstat(target);
  if (!targetInfo.isSymbolicLink() || (await realpath(target)) !== exactDependencyRoot)
    fail('runtime dependency symlink verification failed');
  return Object.freeze({
    dependencyRootHash: sha256(exactDependencyRoot),
    dependencyContentHash: dependency.dependencyContentHash,
    dependencyDevice: dependency.dependencyDevice,
    dependencyInode: dependency.dependencyInode,
  });
}

export async function verifyProvisionedRuntimeDependencies({
  runtimeRoot,
  repositoryRoot,
  expectedLockSha256,
  expectedProof,
}) {
  const dependency = await verifiedHarnessDependencyRoot(repositoryRoot, expectedLockSha256);
  const exactDependencyRoot = dependency.exactDependencyRoot;
  const target = join(await realpath(runtimeRoot), 'node_modules');
  const targetInfo = await lstat(target);
  if (!targetInfo.isSymbolicLink() || (await realpath(target)) !== exactDependencyRoot)
    fail('runtime dependency provision changed');
  const proof = Object.freeze({
    dependencyRootHash: sha256(exactDependencyRoot),
    dependencyContentHash: dependency.dependencyContentHash,
    dependencyDevice: dependency.dependencyDevice,
    dependencyInode: dependency.dependencyInode,
  });
  if (expectedProof && canonicalJson(proof) !== canonicalJson(expectedProof))
    fail('runtime dependency identity changed');
  return proof;
}

function rejectedPreflight(plan, error) {
  const startedAt = new Date().toISOString();
  return {
    ...plan,
    timing: {
      startedAt,
      endedAt: new Date(Date.parse(startedAt) + 1).toISOString(),
      loadAverageBefore: loadavg(),
      loadAverageAfter: loadavg(),
    },
    provenance: {
      ...plan.provenance,
      process: {
        ...plan.provenance.process,
        runId: randomBytes(8).toString('hex'),
        tmuxSessionHash: null,
        tempRootHash: null,
        server: null,
        browser: null,
        opencode: null,
      },
    },
    selection: {
      ...plan.selection,
      lifecycle: 'preflight',
      accepted: false,
      failureReasons: [{ code: 'prerequisite-verification-failed', detailHash: hash16(String(error)) }],
    },
    allocation: {
      browserClosed: false,
      serverStopped: false,
      tmuxRemoved: false,
      tempRootRemoved: false,
      hooksRestored: false,
      listenersDisposed: false,
    },
    cells: [],
  };
}

function quiescencePlaceholder() {
  return { host: null, browser: null, passed: false };
}

function failedHostQuiescence(error, cpuCount = 1) {
  return {
    cpuCount: Number.isInteger(cpuCount) && cpuCount > 0 ? cpuCount : 1,
    sampleCount: 0,
    sampleIntervalMs: HOST_SAMPLE_INTERVAL_MS,
    startedAtMs: 0,
    endedAtMs: 0,
    sampleTimesMs: [],
    idlePercent: 0,
    firstLoad1: 0,
    finalLoad1: 0,
    processes: [],
    measurementErrorHash: hash16(error instanceof Error ? `${error.name}:${error.message}` : String(error)),
    passed: false,
  };
}

function failedBrowserQuiescence(error) {
  return {
    tickCount: 0,
    timerIntervalMs: BROWSER_TIMER_INTERVAL_MS,
    driftsMs: [],
    p95DriftMs: 0,
    maxDriftMs: 0,
    longTaskDurationsMs: [],
    pageErrorHashes: [],
    consoleErrorHashes: [],
    resizeCount: 0,
    overflowed: false,
    measurementErrorHash: hash16(error instanceof Error ? `${error.name}:${error.message}` : String(error)),
    passed: false,
  };
}

function hostRejectedPreflight(plan, host) {
  const repetition = rejectedPreflight(plan, new Error('host-not-quiescent'));
  repetition.selection.failureReasons = [{ code: 'host-not-quiescent', detailHash: hash16(canonicalJson(host)) }];
  repetition.quiescence = { host, browser: null, passed: false };
  return repetition;
}

function command(args, cwd, input) {
  if (input !== undefined) {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      const stdout = [];
      const stderr = [];
      child.stdout.on('data', (chunk) => stdout.push(chunk));
      child.stderr.on('data', (chunk) => stderr.push(chunk));
      child.once('error', rejectPromise);
      child.once('close', (code) =>
        code === 0
          ? resolvePromise(Buffer.concat(stdout))
          : rejectPromise(new Error(`git ${args.join(' ')} failed: ${Buffer.concat(stderr).toString('utf8')}`))
      );
      child.stdin.end(input);
    });
  }
  return execFileAsync('git', args, { cwd, encoding: 'buffer' }).then((result) => result.stdout);
}

function parseStatus(buffer) {
  return buffer
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((entry) => ({ status: entry.slice(0, 2), file: entry.slice(3) }))
    .sort((left, right) => left.file.localeCompare(right.file));
}

export async function materializeVerifiedRuntimeOverlay(
  artifact,
  { repositoryRoot = process.cwd(), git = command, read = readFile, stat = lstat, resolveRealpath = realpath } = {}
) {
  const patchPath = resolve(artifact.patchPath);
  const patch = await read(patchPath);
  if (sha256(patch) !== artifact.patchSha256) fail('overlay patch hash mismatch');
  const container = await mkdtemp(join(tmpdir(), 'cod374-overlay-runtime-'));
  const worktree = join(container, 'worktree');
  let active = false;
  try {
    await git(['worktree', 'add', '--detach', worktree, artifact.product.sha], repositoryRoot);
    active = true;
    const head = (await git(['rev-parse', 'HEAD'], worktree)).toString('utf8').trim();
    const tree = (await git(['rev-parse', 'HEAD^{tree}'], worktree)).toString('utf8').trim();
    if (head !== artifact.product.sha || tree !== artifact.product.tree) fail('materialized product identity mismatch');
    await git(['apply', '--check', '-'], worktree, patch);
    await git(['apply', '-'], worktree, patch);
    const status = parseStatus(
      await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'], worktree)
    );
    if (
      status.some((entry) => entry.status === '!!') ||
      JSON.stringify(status.map((entry) => entry.file)) !== JSON.stringify([...OVERLAY_FILES].sort()) ||
      JSON.stringify(artifact.files.map((entry) => entry.file)) !== JSON.stringify(OVERLAY_FILES)
    )
      fail('overlay allowlist or ignored-file mismatch');
    const files = [];
    for (const expected of artifact.files) {
      const info = await stat(join(worktree, expected.file));
      if (!info.isFile() || info.isSymbolicLink()) fail(`overlay file is not regular: ${expected.file}`);
      const mode = (info.mode & 0o111) === 0 ? '100644' : '100755';
      const contents = await read(join(worktree, expected.file));
      const actual = { file: expected.file, mode, sha256: sha256(contents) };
      if (canonicalJson(actual) !== canonicalJson(expected)) fail(`overlay file mismatch: ${expected.file}`);
      files.push(actual);
    }
    const manifestSha256 = sha256(files.map((entry) => `${entry.file}\0${entry.mode}\0${entry.sha256}\n`).join(''));
    if (manifestSha256 !== artifact.manifestSha256) fail('overlay manifest mismatch');
    const exactRoot = await resolveRealpath(worktree);
    let cleaned = false;
    return {
      root: exactRoot,
      files,
      manifestSha256,
      async cleanup() {
        if (cleaned) return;
        cleaned = true;
        const failures = [];
        if (active)
          await git(['worktree', 'remove', '--force', exactRoot], repositoryRoot).catch((error) =>
            failures.push(error)
          );
        await rm(container, { recursive: true, force: true }).catch((error) => failures.push(error));
        if (failures.length) throw new AggregateError(failures, 'runtime overlay cleanup failed');
      },
    };
  } catch (error) {
    const failures = [error];
    if (active)
      await git(['worktree', 'remove', '--force', worktree], repositoryRoot).catch((entry) => failures.push(entry));
    await rm(container, { recursive: true, force: true }).catch((entry) => failures.push(entry));
    if (failures.length > 1) throw new AggregateError(failures, 'runtime overlay materialization failed');
    throw error;
  }
}

export function adaptTask3Artifact(artifact, sampleIndex) {
  if (!artifact || artifact.schemaVersion !== 1) fail('Task 3 artifact schema mismatch');
  const browserEvents = artifact.browserEvents;
  const durable = browserEvents.filter((event) => event.stage === 'browser.durable-queued');
  if (durable.length !== 3) fail('Task 3 artifact does not contain three rapid inputs');
  const inputs = WORKLOAD.map((expected) => {
    const event = durable.find(
      (entry) => entry.inputIndex === expected.inputIndex && entry.generation === expected.generation
    );
    if (!event || event.tokenHash !== expected.tokenHash || event.tokenLength !== expected.tokenLength) {
      fail('Task 3 rapid input identity mismatch');
    }
    if (typeof event.clientId !== 'string' || !Number.isSafeInteger(event.seq)) fail('Task 3 durable identity missing');
    return {
      ...expected,
      clientId: hash16(event.clientId),
      seq: event.seq,
      coalescedIndex: event.coalescedIndex ?? 0,
      coalescedCount: event.coalescedCount ?? 1,
    };
  });
  if (new Set(inputs.map((input) => input.clientId)).size !== 1) fail('Task 3 client changed within rapid window');
  if (inputs.some((input, index) => index > 0 && input.seq < inputs[index - 1].seq))
    fail('Task 3 sequence is not monotonic');
  const firstBrowserAck = browserEvents.find((event) => event.stage === 'browser.ws-input-ack');
  if (!firstBrowserAck || typeof firstBrowserAck.clientId !== 'string' || !Number.isSafeInteger(firstBrowserAck.seq))
    fail('Task 3 first ACK identity is missing');
  const firstServerAck = artifact.serverEvents.find(
    (event) =>
      event.stage === 'server.input.post-ack' &&
      event.clientId === firstBrowserAck.clientId &&
      event.seq === firstBrowserAck.seq
  );
  return {
    index: sampleIndex,
    inputs,
    evidence: {
      browserEvents: browserEvents.map((event) =>
        event.clientId === undefined ? event : { ...event, clientId: hash16(event.clientId) }
      ),
      serverEvents: artifact.serverEvents.map((event) =>
        event.clientId === undefined ? event : { ...event, clientId: hash16(event.clientId) }
      ),
      paneResults: artifact.paneResults,
      longTaskWindow: artifact.longTaskWindow,
      resizeEvents: artifact.resizeEvents,
      firstAcked: {
        clientId: hash16(firstBrowserAck.clientId),
        seq: firstBrowserAck.seq,
        serverOrdinal: firstServerAck?.ordinal ?? null,
      },
    },
  };
}

export function calibrateProcessStartWindow({
  beforeWallMs,
  beforeUptimeSeconds,
  afterWallMs,
  afterUptimeSeconds,
  startTicks,
  clockTicks,
  uptimeResolutionMs,
}) {
  for (const value of [
    beforeWallMs,
    beforeUptimeSeconds,
    afterWallMs,
    afterUptimeSeconds,
    startTicks,
    clockTicks,
    uptimeResolutionMs,
  ]) {
    if (!Number.isFinite(value) || value < 0) fail('process start calibration input is invalid');
  }
  if (
    afterWallMs < beforeWallMs ||
    afterUptimeSeconds < beforeUptimeSeconds ||
    clockTicks <= 0 ||
    uptimeResolutionMs <= 0
  )
    fail('process start calibration bracket is invalid');
  const bootBefore = beforeWallMs - beforeUptimeSeconds * 1_000;
  const bootAfter = afterWallMs - afterUptimeSeconds * 1_000;
  const measurementUncertaintyMs = uptimeResolutionMs / 2 + 0.5;
  const lowerMs = Math.min(bootBefore, bootAfter) - measurementUncertaintyMs + (startTicks / clockTicks) * 1_000;
  const upperMs = Math.max(bootBefore, bootAfter) + measurementUncertaintyMs + ((startTicks + 1) / clockTicks) * 1_000;
  const midpointMs = (lowerMs + upperMs) / 2;
  return {
    startedAt: new Date(midpointMs).toISOString(),
    startUncertaintyMs: Math.ceil((upperMs - lowerMs) / 2) + 1,
  };
}

async function procIdentity(pid) {
  const beforeWallMs = Date.now();
  const beforeUptimeText = (await readFile('/proc/uptime', 'utf8')).split(' ')[0];
  const beforeUptimeSeconds = Number(beforeUptimeText);
  const [stat, cwd, cmdline, clockTicksResult] = await Promise.all([
    readFile(`/proc/${pid}/stat`, 'utf8'),
    realpath(`/proc/${pid}/cwd`),
    readFile(`/proc/${pid}/cmdline`),
    execFileAsync('getconf', ['CLK_TCK'], { encoding: 'utf8' }),
  ]);
  const afterUptimeText = (await readFile('/proc/uptime', 'utf8')).split(' ')[0];
  const afterUptimeSeconds = Number(afterUptimeText);
  const afterWallMs = Date.now();
  const close = stat.lastIndexOf(')');
  const startIdentity = stat.slice(close + 2).split(' ')[19];
  const clockTicks = Number(clockTicksResult.stdout.trim());
  if (!/^\d+$/.test(startIdentity) || !Number.isSafeInteger(clockTicks)) {
    fail('process start identity cannot be measured');
  }
  const calibrated = calibrateProcessStartWindow({
    beforeWallMs,
    beforeUptimeSeconds,
    afterWallMs,
    afterUptimeSeconds,
    startTicks: Number(startIdentity),
    clockTicks,
    uptimeResolutionMs: Math.max(
      10 ** -(beforeUptimeText.split('.')[1]?.length ?? 0) * 1_000,
      10 ** -(afterUptimeText.split('.')[1]?.length ?? 0) * 1_000
    ),
  });
  return {
    pid,
    startIdentity,
    ...calibrated,
    cwd,
    cmdlineHash: hash16(cmdline),
    cmdline: cmdline.toString('utf8').replaceAll('\0', ' '),
  };
}

export async function runPhaseBProducer(options) {
  const adapters = options.testAdapters;
  if (adapters && process.env.NODE_ENV !== 'test') fail('injected adapters are test-only');
  const repetitionPlan = { ...options.repetition, quiescence: quiescencePlaceholder() };
  const materialize = adapters?.materialize ?? materializeVerifiedRuntimeOverlay;
  const launch =
    adapters?.launch ??
    (async (launchOptions) => {
      const module = await import('./cod-374-playwright-runtime.ts');
      return module.launchConcretePhaseBRuntime(launchOptions);
    });
  return runExperimentProducerTransaction({
    experimentRoot: options.experimentRoot,
    repositoryRoot: options.repositoryRoot,
    intent: repetitionPlan,
    produce: async ({ stagingDirectory, rejectBeforeHostMeasurement, bindHostQuiescence }) => {
      let overlay;
      let runtime;
      const cleanupFields = [
        'browserClosed',
        'serverStopped',
        'tmuxRemoved',
        'tempRootRemoved',
        'hooksRestored',
        'listenersDisposed',
      ];
      const resourceState = { runtime: 'unallocated', overlay: 'unallocated' };
      const runtimeCleanupProof = Object.fromEntries(cleanupFields.map((field) => [field, true]));
      let overlayCleanupProof = true;
      let runtimeCleanupAttempted = false;
      let overlayCleanupAttempted = false;
      const cleanupErrors = [];
      let attemptSnapshot;
      const mergeCleanupProof = (proof) => {
        if (!proof || typeof proof !== 'object') return;
        for (const field of cleanupFields) {
          if (proof[field] === true) runtimeCleanupProof[field] = true;
        }
      };
      const validateCleanupProof = (proof) => {
        mergeCleanupProof(proof);
        const keys = proof && typeof proof === 'object' && !Array.isArray(proof) ? Object.keys(proof).sort() : [];
        if (
          !proof ||
          typeof proof !== 'object' ||
          Array.isArray(proof) ||
          canonicalJson(keys) !== canonicalJson([...cleanupFields].sort()) ||
          cleanupFields.some((field) => typeof proof[field] !== 'boolean' || proof[field] !== true)
        ) {
          throw Object.assign(new Error('COD-374 runtime cleanup proof is invalid or incomplete'), {
            cleanupProof: proof,
          });
        }
      };
      const cleanupEvidence = () => ({
        ...runtimeCleanupProof,
        tempRootRemoved: runtimeCleanupProof.tempRootRemoved && overlayCleanupProof,
      });
      const cleanupRuntimeResource = async () => {
        if (resourceState.runtime !== 'live' || runtimeCleanupAttempted) return;
        runtimeCleanupAttempted = true;
        try {
          validateCleanupProof(await runtime.cleanup());
        } catch (error) {
          mergeCleanupProof(error?.cleanupProof);
          cleanupErrors.push(error);
        } finally {
          if (cleanupFields.every((field) => runtimeCleanupProof[field] === true)) resourceState.runtime = 'cleaned';
          runtime = null;
        }
      };
      const cleanupOverlayResource = async () => {
        if (resourceState.overlay !== 'live' || overlayCleanupAttempted) return;
        overlayCleanupAttempted = true;
        try {
          await overlay.cleanup();
          overlayCleanupProof = true;
          resourceState.overlay = 'cleaned';
        } catch (error) {
          cleanupErrors.push(error);
        } finally {
          overlay = null;
        }
      };
      let runtimeLaunchedAt = null;
      let serverProc;
      let browserProc;
      let opencodeProc;
      let runtimeIdentities;
      let primaryError;
      let preflightProof;
      let vendorRuntimeProof;
      try {
        try {
          preflightProof = await verifyExperimentPreflight({
            repetition: repetitionPlan,
            repositoryRoot: options.repositoryRoot,
            vendorManifestPath: options.vendorManifestPath,
            gitVerifier: adapters?.gitVerifier,
          });
        } catch (error) {
          return {
            repetition: rejectedPreflight(repetitionPlan, error),
            runtimeObservation: undefined,
            preflightProof: undefined,
            beforeHostRejection: rejectBeforeHostMeasurement(error),
          };
        }
        let hostQuiescence;
        try {
          hostQuiescence = await (adapters?.measureHostQuiescence ?? measureHostQuiescence)();
          validatePersistedHostQuiescence(hostQuiescence);
        } catch (error) {
          if (error?.evidence) {
            try {
              validatePersistedHostQuiescence(error.evidence);
              hostQuiescence = error.evidence;
            } catch {
              hostQuiescence = failedHostQuiescence(error, repetitionPlan.provenance.host.cpuCount);
            }
          } else {
            hostQuiescence = failedHostQuiescence(error, repetitionPlan.provenance.host.cpuCount);
          }
        }
        bindHostQuiescence(hostQuiescence);
        repetitionPlan.quiescence = { host: hostQuiescence, browser: null, passed: false };
        bindExperimentPreflightQuiescence(preflightProof, repetitionPlan);
        if (!hostQuiescence.passed) {
          const repetition = hostRejectedPreflight(repetitionPlan, hostQuiescence);
          bindExperimentPreflightQuiescence(preflightProof, repetition);
          return { repetition, runtimeObservation: undefined, preflightProof };
        }
        try {
          const claimedOverlay = repetitionPlan.provenance.overlay;
          if (
            canonicalJson(options.overlayArtifact.product) !== canonicalJson(repetitionPlan.provenance.product) ||
            options.overlayArtifact.patchSha256 !== claimedOverlay.patchSha256 ||
            options.overlayArtifact.manifestSha256 !== claimedOverlay.manifestSha256 ||
            canonicalJson(options.overlayArtifact.files) !== canonicalJson(claimedOverlay.files)
          ) {
            fail('overlay artifact does not match repetition provenance');
          }
          overlay = await materialize(options.overlayArtifact, { repositoryRoot: options.repositoryRoot });
          resourceState.overlay = 'live';
          overlayCleanupProof = false;
          if (
            overlay.manifestSha256 !== claimedOverlay.manifestSha256 ||
            canonicalJson(overlay.files) !== canonicalJson(claimedOverlay.files)
          )
            fail('materialized overlay does not match repetition provenance');
          const dependencyOptions = {
            runtimeRoot: overlay.root,
            repositoryRoot: options.repositoryRoot,
            expectedLockSha256: repetitionPlan.provenance.dependencies.packageLockSha256,
          };
          const expectedDependencyProof = {
            dependencyRootHash: repetitionPlan.provenance.dependencies.dependencyRootHash,
            dependencyContentHash: repetitionPlan.provenance.dependencies.dependencyContentHash,
            dependencyDevice: repetitionPlan.provenance.dependencies.dependencyDevice,
            dependencyInode: repetitionPlan.provenance.dependencies.dependencyInode,
          };
          const dependencyProof = await (adapters?.provisionDependencies ?? provisionRuntimeDependencies)(
            dependencyOptions
          );
          if (canonicalJson(dependencyProof) !== canonicalJson(expectedDependencyProof))
            fail('runtime dependency root provenance mismatch');
          const verifiedDependencyProof = await (
            adapters?.verifyProvisionedDependencies ?? verifyProvisionedRuntimeDependencies
          )({ ...dependencyOptions, expectedProof: dependencyProof });
          if (canonicalJson(verifiedDependencyProof) !== canonicalJson(dependencyProof))
            fail('runtime dependency proof changed before launch');
          const vendorOptions = {
            runtimeRoot: overlay.root,
            repositoryRoot: options.repositoryRoot,
            vendorManifestPath: options.vendorManifestPath,
            expectedManifestSha256: repetitionPlan.provenance.dependencies.vendorManifestSha256,
          };
          vendorRuntimeProof = await (adapters?.provisionVendorAssets ?? provisionRuntimeVendorAssets)(vendorOptions);
          const verifiedVendorProof = await (
            adapters?.verifyProvisionedVendorAssets ?? verifyProvisionedRuntimeVendorAssets
          )({ ...vendorOptions, expectedProof: vendorRuntimeProof });
          if (canonicalJson(verifiedVendorProof) !== canonicalJson(vendorRuntimeProof))
            fail('runtime vendor proof changed before launch');
        } catch (error) {
          let failure = error;
          const tempRootAllocated = overlay !== undefined;
          let tempRootRemoved = !tempRootAllocated;
          if (overlay) {
            overlayCleanupAttempted = true;
            try {
              await overlay.cleanup();
              tempRootRemoved = true;
              overlayCleanupProof = true;
              resourceState.overlay = 'cleaned';
            } catch (cleanupError) {
              failure = new AggregateError([error, cleanupError], 'overlay verification and cleanup failed');
            }
            overlay = null;
          }
          const repetition = rejectedPreflight(repetitionPlan, failure);
          repetition.allocation.tempRootRemoved = tempRootAllocated;
          repetition.cleanup.tempRootRemoved = tempRootRemoved;
          repetition.diagnostics.errorHashes = [hash16(String(failure))];
          Object.assign(repetition.diagnostics, errorDiagnosticHashes(failure, 'overlay-preflight'));
          return {
            repetition,
            runtimeObservation: undefined,
            preflightProof,
          };
        }
        runtime = await launch({ runtimeRoot: overlay.root, stagingDirectory, plan: repetitionPlan });
        resourceState.runtime = 'live';
        for (const field of cleanupFields) runtimeCleanupProof[field] = false;
        runtimeLaunchedAt = runtime.launchedAt;
        const exactRuntimeRoot = await realpath(overlay.root);
        if ((await realpath(runtime.runtimeRoot)) !== exactRuntimeRoot)
          fail('launched runtime is not verified overlay');
        const finalDependencyProof = await (
          adapters?.verifyProvisionedDependencies ?? verifyProvisionedRuntimeDependencies
        )({
          runtimeRoot: overlay.root,
          repositoryRoot: options.repositoryRoot,
          expectedLockSha256: repetitionPlan.provenance.dependencies.packageLockSha256,
          expectedProof: {
            dependencyRootHash: repetitionPlan.provenance.dependencies.dependencyRootHash,
            dependencyContentHash: repetitionPlan.provenance.dependencies.dependencyContentHash,
            dependencyDevice: repetitionPlan.provenance.dependencies.dependencyDevice,
            dependencyInode: repetitionPlan.provenance.dependencies.dependencyInode,
          },
        });
        if (finalDependencyProof.dependencyContentHash !== repetitionPlan.provenance.dependencies.dependencyContentHash)
          fail('runtime dependency proof changed after launch');
        const finalVendorProof = await (
          adapters?.verifyProvisionedVendorAssets ?? verifyProvisionedRuntimeVendorAssets
        )({
          runtimeRoot: overlay.root,
          repositoryRoot: options.repositoryRoot,
          vendorManifestPath: options.vendorManifestPath,
          expectedManifestSha256: repetitionPlan.provenance.dependencies.vendorManifestSha256,
          expectedProof: vendorRuntimeProof,
        });
        if (canonicalJson(finalVendorProof) !== canonicalJson(vendorRuntimeProof))
          fail('runtime vendor proof changed after launch');
        serverProc = await (adapters?.procIdentity ?? procIdentity)(runtime.serverPid);
        if (
          serverProc.cwd !== exactRuntimeRoot ||
          !serverProc.cmdline.includes('src/index.ts') ||
          !serverProc.cmdline.includes(' web ')
        )
          fail('server process is not the verified overlay launch');
        browserProc = await (adapters?.procIdentity ?? procIdentity)(runtime.browserPid);
        opencodeProc = await (adapters?.procIdentity ?? procIdentity)(runtime.opencodePid);
        if (!opencodeProc.cmdline.includes('opencode')) fail('OpenCode process identity is invalid');
        await (adapters?.verifyServedAssets ?? verifyServedRuntimeAssets)({
          runtimeRoot: overlay.root,
          baseUrl: runtime.baseUrl,
          fetch: runtime.fetch,
          expectedAssets: repetitionPlan.provenance.overlay.servedAssets,
        });
        const viewport = await runtime.page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        const fontPx = await readTerminalFontPx(runtime.page);
        const opencodeVersion = await runtime.opencodeVersion();
        runtimeIdentities = await runtime.identities();
        const loadAverageBefore = loadavg();
        let browserQuiescence;
        try {
          browserQuiescence = await runtime.measureBrowserQuiescence();
          validateBrowserQuiescence(browserQuiescence);
        } catch (error) {
          if (
            browserQuiescence?.passed === false &&
            typeof error?.message === 'string' &&
            error.message === 'COD-374 browser is not quiescent'
          ) {
            // The validator has already established the exact failed evidence shape.
          } else {
            browserQuiescence = failedBrowserQuiescence(error);
          }
        }
        repetitionPlan.quiescence = {
          host: repetitionPlan.quiescence.host,
          browser: browserQuiescence,
          passed: repetitionPlan.quiescence.host.passed && browserQuiescence.passed,
        };
        bindExperimentPreflightQuiescence(preflightProof, repetitionPlan);
        if (!browserQuiescence.passed) {
          let processReplaced = false;
          let processVerificationError;
          try {
            const [finalServer, finalBrowser, finalOpenCode] = await Promise.all([
              (adapters?.procIdentity ?? procIdentity)(runtime.serverPid),
              (adapters?.procIdentity ?? procIdentity)(runtime.browserPid),
              (adapters?.procIdentity ?? procIdentity)(runtime.opencodePid),
            ]);
            processReplaced = [
              [serverProc, finalServer],
              [browserProc, finalBrowser],
              [opencodeProc, finalOpenCode],
            ].some(([initial, final]) => initial.pid !== final.pid || initial.startIdentity !== final.startIdentity);
          } catch (error) {
            processReplaced = true;
            processVerificationError = error;
          }
          await cleanupRuntimeResource();
          await cleanupOverlayResource();
          const cleanup = cleanupEvidence();
          const diagnostics = {
            traceOverflowed: false,
            observerErrorHashes: [],
            pageErrorHashes: [],
            consoleErrorHashes: [],
            processReplaced,
            resizeEvents: [],
            longTasks: [],
            errorHashes: [
              ...new Set(
                [processVerificationError, ...cleanupErrors].filter(Boolean).map((error) => hash16(String(error)))
              ),
            ],
            serverStdoutHashes: [],
            serverStderrHashes: [],
            startupStageHashes: [],
            startupNameHashes: [],
            startupMessageHashes: [],
          };
          if (processVerificationError) {
            const proof = errorDiagnosticHashes(processVerificationError, 'runtime-process-verification');
            for (const field of ['startupStageHashes', 'startupNameHashes', 'startupMessageHashes']) {
              diagnostics[field].push(...proof[field].filter((value) => !diagnostics[field].includes(value)));
            }
          }
          for (const cleanupError of cleanupErrors) {
            const proof = errorDiagnosticHashes(cleanupError, 'runtime-cleanup');
            for (const field of ['startupStageHashes', 'startupNameHashes', 'startupMessageHashes']) {
              diagnostics[field].push(...proof[field].filter((value) => !diagnostics[field].includes(value)));
            }
          }
          const repetition = {
            ...repetitionPlan,
            timing: {
              startedAt: runtimeLaunchedAt,
              endedAt: new Date().toISOString(),
              loadAverageBefore,
              loadAverageAfter: loadavg(),
            },
            clock: {
              mode: 'component-local',
              browserClockId: hash16(`browser:${browserProc.pid}:${browserProc.startIdentity}`),
              serverClockId: hash16(`server:${serverProc.pid}:${serverProc.startIdentity}`),
              harnessClockId: randomBytes(8).toString('hex'),
            },
            provenance: {
              ...repetitionPlan.provenance,
              runtimeVendorHash: vendorRuntimeProof.vendorRuntimeHash,
              process: {
                runId: randomBytes(8).toString('hex'),
                tmuxSessionHash: hash16(runtimeIdentities.tmuxSession),
                tempRootHash: hash16(runtimeIdentities.tempRoot),
                server: {
                  pid: serverProc.pid,
                  startedAt: serverProc.startedAt,
                  startIdentity: serverProc.startIdentity,
                  startUncertaintyMs: serverProc.startUncertaintyMs,
                },
                browser: {
                  pid: browserProc.pid,
                  startedAt: browserProc.startedAt,
                  startIdentity: browserProc.startIdentity,
                  startUncertaintyMs: browserProc.startUncertaintyMs,
                },
                opencode: {
                  pid: opencodeProc.pid,
                  startedAt: opencodeProc.startedAt,
                  startIdentity: opencodeProc.startIdentity,
                  startUncertaintyMs: opencodeProc.startUncertaintyMs,
                },
              },
            },
            selection: {
              ...repetitionPlan.selection,
              lifecycle: 'partial',
              accepted: false,
              failureReasons: [
                { code: 'browser-not-quiescent', detailHash: hash16(canonicalJson(browserQuiescence)) },
                ...(processReplaced
                  ? [{ code: 'runtime-contaminated', detailHash: hash16(canonicalJson(diagnostics)) }]
                  : []),
                ...cleanupErrors.map((error) => ({
                  code: 'runtime-cleanup-failed',
                  detailHash: hash16(String(error)),
                })),
              ],
            },
            quiescence: repetitionPlan.quiescence,
            cells: [],
            diagnostics,
            cleanup,
          };
          attemptSnapshot = repetition;
          return { repetition, runtimeObservation: undefined, preflightProof };
        }
        let lifecycleError;
        let artifacts;
        try {
          artifacts = await runtime.captureRepetition();
        } catch (error) {
          lifecycleError = error;
          artifacts =
            error && typeof error === 'object' && Array.isArray(error.partialArtifacts) ? error.partialArtifacts : [];
        }
        const loadAverageAfter = loadavg();
        const cells = artifacts.map((cell) => ({
          rate: cell.rate,
          realizedCpuThrottle: cell.realizedCpuThrottle,
          cpuCalibration: cell.cpuCalibration,
          samples: cell.samples.map((artifact, index) => adaptTask3Artifact(artifact, index)),
        }));
        let runtimeDiagnostics = { pageErrorHashes: [], consoleErrorHashes: [] };
        try {
          runtimeDiagnostics = await runtime.diagnostics();
        } catch (error) {
          lifecycleError ??= error;
        }
        let processReplaced = false;
        try {
          const [finalServer, finalBrowser, finalOpenCode] = await Promise.all([
            (adapters?.procIdentity ?? procIdentity)(runtime.serverPid),
            (adapters?.procIdentity ?? procIdentity)(runtime.browserPid),
            (adapters?.procIdentity ?? procIdentity)(runtime.opencodePid),
          ]);
          processReplaced = [
            [serverProc, finalServer],
            [browserProc, finalBrowser],
            [opencodeProc, finalOpenCode],
          ].some(([initial, final]) => initial.pid !== final.pid || initial.startIdentity !== final.startIdentity);
        } catch {
          processReplaced = true;
        }
        const sampleArtifacts = artifacts.flatMap((cell) => cell.samples);
        const browserClockIds = new Set(
          sampleArtifacts.flatMap((artifact) => artifact.browserEvents.map((event) => event.clockId))
        );
        if (browserClockIds.size > 1) fail('captured browser clock identity is mixed');
        const browserClockId =
          [...browserClockIds][0] ?? hash16(`browser:${browserProc.pid}:${browserProc.startIdentity}`);
        const observerErrorHashes = sampleArtifacts.flatMap((artifact) =>
          artifact.paneResults.flatMap((pane, index) =>
            [
              ...(index === artifact.paneResults.length - 1 ? [pane.errorHash] : []),
              ...pane.probes.map((probe) => probe.errorHash),
            ].filter(Boolean)
          )
        );
        const diagnostics = {
          traceOverflowed: sampleArtifacts.some((artifact) => artifact.traceOverflowed === true),
          observerErrorHashes,
          pageErrorHashes: runtimeDiagnostics.pageErrorHashes,
          consoleErrorHashes: runtimeDiagnostics.consoleErrorHashes,
          processReplaced,
          resizeEvents: sampleArtifacts.flatMap((artifact) => artifact.resizeEvents),
          longTasks: sampleArtifacts.flatMap((artifact) => artifact.longTaskWindow.entries),
          errorHashes: [],
          serverStdoutHashes: [],
          serverStderrHashes: [],
          startupStageHashes: [],
          startupNameHashes: [],
          startupMessageHashes: [],
        };
        const launchedAt = runtime.launchedAt;
        const publishDependencyProof = await (
          adapters?.verifyProvisionedDependencies ?? verifyProvisionedRuntimeDependencies
        )({
          runtimeRoot: overlay.root,
          repositoryRoot: options.repositoryRoot,
          expectedLockSha256: repetitionPlan.provenance.dependencies.packageLockSha256,
          expectedProof: {
            dependencyRootHash: repetitionPlan.provenance.dependencies.dependencyRootHash,
            dependencyContentHash: repetitionPlan.provenance.dependencies.dependencyContentHash,
            dependencyDevice: repetitionPlan.provenance.dependencies.dependencyDevice,
            dependencyInode: repetitionPlan.provenance.dependencies.dependencyInode,
          },
        });
        if (
          publishDependencyProof.dependencyContentHash !== repetitionPlan.provenance.dependencies.dependencyContentHash
        )
          fail('runtime dependency proof changed before publication');
        const publishVendorProof = await (
          adapters?.verifyProvisionedVendorAssets ?? verifyProvisionedRuntimeVendorAssets
        )({
          runtimeRoot: overlay.root,
          repositoryRoot: options.repositoryRoot,
          vendorManifestPath: options.vendorManifestPath,
          expectedManifestSha256: repetitionPlan.provenance.dependencies.vendorManifestSha256,
          expectedProof: vendorRuntimeProof,
        });
        if (canonicalJson(publishVendorProof) !== canonicalJson(vendorRuntimeProof))
          fail('runtime vendor proof changed before publication');
        await cleanupRuntimeResource();
        await cleanupOverlayResource();
        const cleanup = cleanupEvidence();
        const endedAt = new Date().toISOString();
        const contaminated =
          diagnostics.traceOverflowed ||
          diagnostics.processReplaced ||
          observerErrorHashes.length > 0 ||
          diagnostics.pageErrorHashes.length > 0 ||
          diagnostics.consoleErrorHashes.length > 0 ||
          diagnostics.resizeEvents.length > 0 ||
          diagnostics.longTasks.length > 0 ||
          Object.values(cleanup).some((value) => value !== true) ||
          lifecycleError !== undefined ||
          cleanupErrors.length > 0;
        const retainedErrors = [lifecycleError, ...cleanupErrors].filter(Boolean);
        diagnostics.errorHashes.push(...new Set(retainedErrors.map((error) => hash16(String(error)))));
        for (const cleanupError of cleanupErrors) {
          const proof = errorDiagnosticHashes(cleanupError, 'runtime-cleanup');
          for (const field of ['startupStageHashes', 'startupNameHashes', 'startupMessageHashes']) {
            diagnostics[field].push(...proof[field].filter((value) => !diagnostics[field].includes(value)));
          }
        }
        const repetition = {
          ...repetitionPlan,
          timing: { startedAt: launchedAt, endedAt, loadAverageBefore, loadAverageAfter },
          clock: {
            mode: 'component-local',
            browserClockId,
            serverClockId: hash16(`server:${serverProc.pid}:${serverProc.startIdentity}`),
            harnessClockId: randomBytes(8).toString('hex'),
          },
          provenance: {
            ...repetitionPlan.provenance,
            runtimeVendorHash: vendorRuntimeProof.vendorRuntimeHash,
            process: {
              ...repetitionPlan.provenance.process,
              runId: randomBytes(8).toString('hex'),
              tmuxSessionHash: hash16(runtimeIdentities.tmuxSession),
              tempRootHash: hash16(runtimeIdentities.tempRoot),
              server: {
                pid: serverProc.pid,
                startedAt: serverProc.startedAt,
                startIdentity: serverProc.startIdentity,
                startUncertaintyMs: serverProc.startUncertaintyMs,
              },
              browser: {
                pid: browserProc.pid,
                startedAt: browserProc.startedAt,
                startIdentity: browserProc.startIdentity,
                startUncertaintyMs: browserProc.startUncertaintyMs,
              },
              opencode: {
                pid: opencodeProc.pid,
                startedAt: opencodeProc.startedAt,
                startIdentity: opencodeProc.startIdentity,
                startUncertaintyMs: opencodeProc.startUncertaintyMs,
              },
            },
          },
          selection: contaminated
            ? {
                ...repetitionPlan.selection,
                lifecycle:
                  artifacts.length === repetitionPlan.config.rates.length &&
                  artifacts.every((cell) => cell.samples.length === repetitionPlan.config.samplesPerCell)
                    ? 'completed'
                    : 'partial',
                accepted: false,
                failureReasons: [{ code: 'runtime-contaminated', detailHash: hash16(canonicalJson(diagnostics)) }],
              }
            : repetitionPlan.selection,
          cells,
          diagnostics,
          cleanup,
        };
        attemptSnapshot = repetition;
        const runtimeObservation = (adapters?.measureRuntimeObservation ?? measureRuntimeObservation)(repetition, {
          readOpenCodeVersion: () => opencodeVersion,
          readViewport: () => viewport,
          readFontPx: () => fontPx,
          readRealizedCpuThrottle: (rate) => cells.find((cell) => cell.rate === rate)?.realizedCpuThrottle,
          readCpuCalibration: (rate) => cells.find((cell) => cell.rate === rate)?.cpuCalibration,
          readServerProcess: () => repetition.provenance.process.server,
          readBrowserProcess: () => repetition.provenance.process.browser,
          readOpenCodeProcess: () => repetition.provenance.process.opencode,
        });
        return { repetition, runtimeObservation, preflightProof };
      } catch (error) {
        primaryError = error;
        if (attemptSnapshot) {
          const diagnostics = structuredClone(attemptSnapshot.diagnostics);
          diagnostics.errorHashes.push(hash16(String(error)));
          const proofDiagnostics = errorDiagnosticHashes(error, 'runtime-proof');
          for (const field of ['startupStageHashes', 'startupNameHashes', 'startupMessageHashes']) {
            diagnostics[field].push(...proofDiagnostics[field].filter((value) => !diagnostics[field].includes(value)));
          }
          const failureReasons = [...attemptSnapshot.selection.failureReasons];
          failureReasons.push({ code: 'runtime-proof-failed', detailHash: hash16(String(error)) });
          for (const cleanupError of cleanupErrors) {
            const reason = { code: 'runtime-cleanup-failed', detailHash: hash16(String(cleanupError)) };
            if (!failureReasons.some((entry) => canonicalJson(entry) === canonicalJson(reason))) {
              failureReasons.push(reason);
            }
          }
          const rejected = retainSchemaValidCellPrefix({
            ...attemptSnapshot,
            selection: {
              ...attemptSnapshot.selection,
              lifecycle: 'partial',
              accepted: false,
              failureReasons,
            },
            diagnostics,
            cleanup: cleanupEvidence(),
          });
          return {
            repetition: rejected,
            runtimeObservation: undefined,
            preflightProof,
          };
        }
        const serverDiagnostics = error?.serverDiagnostics ?? { stdoutHashes: [], stderrHashes: [] };
        const cleanupAllocation = error?.cleanupAllocation;
        const postAllocation = runtimeLaunchedAt !== null || error?.postAllocation === true;
        if (runtimeLaunchedAt === null && error?.launchedAt) runtimeLaunchedAt = error.launchedAt;
        if (cleanupAllocation) {
          for (const field of cleanupFields) {
            if (cleanupAllocation[field] === true) runtimeCleanupProof[field] = false;
          }
        }
        mergeCleanupProof(error?.cleanupProof);
        await cleanupRuntimeResource();
        await cleanupOverlayResource();
        const cleanup = cleanupEvidence();
        const repetition = rejectedPreflight(repetitionPlan, primaryError);
        repetition.cleanup = cleanup;
        repetition.diagnostics.errorHashes = [
          ...new Set([primaryError, ...cleanupErrors].map((retainedError) => hash16(String(retainedError)))),
        ];
        Object.assign(repetition.diagnostics, errorDiagnosticHashes(primaryError, 'runtime-setup'));
        for (const cleanupError of cleanupErrors) {
          const proof = errorDiagnosticHashes(cleanupError, 'runtime-cleanup');
          for (const field of ['startupStageHashes', 'startupNameHashes', 'startupMessageHashes']) {
            repetition.diagnostics[field].push(
              ...proof[field].filter((value) => !repetition.diagnostics[field].includes(value))
            );
          }
        }
        repetition.diagnostics.serverStdoutHashes = serverDiagnostics.stdoutHashes;
        repetition.diagnostics.serverStderrHashes = serverDiagnostics.stderrHashes;
        if (postAllocation) {
          repetition.provenance.runtimeVendorHash = vendorRuntimeProof?.vendorRuntimeHash ?? null;
          repetition.allocation = cleanupAllocation
            ? { ...cleanupAllocation, tempRootRemoved: true }
            : {
                browserClosed: true,
                serverStopped: true,
                tmuxRemoved: true,
                tempRootRemoved: true,
                hooksRestored: true,
                listenersDisposed: true,
              };
          repetition.selection = {
            ...repetition.selection,
            lifecycle: 'partial',
            failureReasons: [
              { code: 'runtime-setup-failed', detailHash: hash16(String(primaryError)) },
              ...cleanupErrors.map((cleanupError) => ({
                code: 'runtime-cleanup-failed',
                detailHash: hash16(String(cleanupError)),
              })),
            ],
          };
          repetition.timing = {
            startedAt: runtimeLaunchedAt ?? new Date().toISOString(),
            endedAt: new Date().toISOString(),
            loadAverageBefore: loadavg(),
            loadAverageAfter: loadavg(),
          };
          repetition.provenance.process = {
            runId: randomBytes(8).toString('hex'),
            tmuxSessionHash: runtimeIdentities ? hash16(runtimeIdentities.tmuxSession) : null,
            tempRootHash: runtimeIdentities ? hash16(runtimeIdentities.tempRoot) : null,
            server: serverProc
              ? {
                  pid: serverProc.pid,
                  startedAt: serverProc.startedAt,
                  startIdentity: serverProc.startIdentity,
                  startUncertaintyMs: serverProc.startUncertaintyMs,
                }
              : null,
            browser: browserProc
              ? {
                  pid: browserProc.pid,
                  startedAt: browserProc.startedAt,
                  startIdentity: browserProc.startIdentity,
                  startUncertaintyMs: browserProc.startUncertaintyMs,
                }
              : null,
            opencode: opencodeProc
              ? {
                  pid: opencodeProc.pid,
                  startedAt: opencodeProc.startedAt,
                  startIdentity: opencodeProc.startIdentity,
                  startUncertaintyMs: opencodeProc.startUncertaintyMs,
                }
              : null,
          };
        }
        return {
          repetition,
          runtimeObservation: undefined,
          preflightProof: repetition.quiescence.host === null ? undefined : preflightProof,
        };
      } finally {
        await cleanupRuntimeResource();
        await cleanupOverlayResource();
      }
    },
  });
}

function parseCli(argv) {
  if (argv.some((entry) => /[*?\[\]]/.test(entry))) fail('glob input is forbidden');
  if (
    argv.length !== 10 ||
    argv[0] !== '--experiment-root' ||
    argv[2] !== '--repository-root' ||
    argv[4] !== '--vendor-manifest' ||
    argv[6] !== '--repetition-plan' ||
    argv[8] !== '--overlay-artifact'
  ) {
    fail(
      'usage: cod-374-runner.mjs --experiment-root ROOT --repository-root REPO --vendor-manifest FILE --repetition-plan JSON --overlay-artifact JSON'
    );
  }
  return {
    experimentRoot: resolve(argv[1]),
    repositoryRoot: resolve(argv[3]),
    vendorManifestPath: resolve(argv[5]),
    repetitionPath: resolve(argv[7]),
    overlayPath: resolve(argv[9]),
  };
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  const [repetition, overlayArtifact] = await Promise.all([
    readFile(options.repetitionPath, 'utf8').then(JSON.parse),
    readFile(options.overlayPath, 'utf8').then(JSON.parse),
  ]);
  await runPhaseBProducer({ ...options, repetition, overlayArtifact });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
