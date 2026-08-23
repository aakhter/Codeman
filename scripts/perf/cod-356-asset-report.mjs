#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { promisify } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = resolve(HERE, '../..');
const HOST = '127.0.0.1';
const SERIOUS_CONSOLE = /(?:uncaught|unhandled|failed|fatal|error)/i;
const execFileAsync = promisify(execFile);

export function parseArgs(argv) {
  const options = { output: null, runtimeRoot: TOOL_ROOT, runtimeRevision: null, samples: 5 };
  const valueAfter = (index, option) => {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
    return value;
  };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--output') options.output = resolve(valueAfter(index++, '--output'));
    else if (argv[index] === '--runtime-root') options.runtimeRoot = resolve(valueAfter(index++, '--runtime-root'));
    else if (argv[index] === '--runtime-revision') {
      options.runtimeRevision = valueAfter(index++, '--runtime-revision');
    } else if (argv[index] === '--samples') options.samples = Number(valueAfter(index++, '--samples'));
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (!Number.isSafeInteger(options.samples) || options.samples < 1)
    throw new Error('samples must be a positive integer');
  if (!options.runtimeRevision) throw new Error('--runtime-revision is required');
  return options;
}

export async function verifyRuntimeProvenance(runtimeRoot, runtimeRevision) {
  if (!/^[0-9a-f]{40}$/.test(runtimeRevision || '')) {
    throw new Error('--runtime-revision must be a full lowercase 40-character commit SHA');
  }
  const git = async (...args) =>
    (await execFileAsync('git', ['-C', runtimeRoot, ...args], { encoding: 'utf8' })).stdout.trim();
  const headRevision = await git('rev-parse', 'HEAD');
  if (headRevision !== runtimeRevision) {
    throw new Error(`runtime revision mismatch: expected ${runtimeRevision}, found ${headRevision}`);
  }
  const trackedStatus = await git('status', '--porcelain', '--untracked-files=no');
  if (trackedStatus) throw new Error(`runtime root has tracked changes:\n${trackedStatus}`);
  return {
    requestedRevision: runtimeRevision,
    verifiedHeadRevision: headRevision,
    verifiedTree: await git('rev-parse', 'HEAD^{tree}'),
    trackedRuntimeClean: true,
  };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export async function collectProfilerProvenance(toolRoot = TOOL_ROOT) {
  const paths = ['package-lock.json', 'package.json', 'scripts/perf/cod-356-asset-report.mjs'];
  const files = await Promise.all(
    paths.map(async (path) => {
      const content = await readFile(join(toolRoot, path));
      return { path, bytes: content.byteLength, sha256: sha256(content) };
    })
  );
  const git = async (...args) =>
    (await execFileAsync('git', ['-C', toolRoot, ...args], { encoding: 'utf8' })).stdout.trim();
  const trackedStatus = await git('status', '--porcelain', '--untracked-files=no');
  const playwrightPackage = JSON.parse(await readFile(join(toolRoot, 'node_modules/playwright/package.json'), 'utf8'));
  return {
    schemaVersion: 1,
    algorithm: 'sha256 of sorted path/byte-length/content-sha256 manifest',
    contentHash: sha256(JSON.stringify(files)),
    files,
    toolRepository: {
      headRevision: await git('rev-parse', 'HEAD'),
      headTree: await git('rev-parse', 'HEAD^{tree}'),
      trackedTreeClean: trackedStatus.length === 0,
      trackedChanges: trackedStatus ? trackedStatus.split('\n') : [],
      untrackedFilesExcludedByDesign: true,
    },
    dependencies: {
      node: process.version,
      playwright: playwrightPackage.version,
      packageLockSha256: files.find((file) => file.path === 'package-lock.json').sha256,
    },
  };
}

export function assertCleanupComplete(cleanup) {
  if (!cleanup.browserClosed || !cleanup.childStopped || !cleanup.tempRootRemoved) {
    throw new Error(`incomplete profiler cleanup: ${JSON.stringify(cleanup)}`);
  }
}

export async function publishReport({ output, report, cleanup, writeStdout = false }) {
  assertCleanupComplete(cleanup);
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (output) {
    await mkdir(dirname(output), { recursive: true });
    const temporaryOutput = `${output}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
    try {
      await writeFile(temporaryOutput, text, { flag: 'wx' });
      await rename(temporaryOutput, output);
    } catch (error) {
      await rm(temporaryOutput, { force: true });
      throw error;
    }
  }
  if (writeStdout) process.stdout.write(text);
}

async function unusedPort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      server.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
}

async function waitForServer(baseUrl, child, authorization) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`temporary Codeman exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/status`, { headers: { authorization } });
      if (response.ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error('temporary Codeman did not become ready');
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    new Promise((resolveWait) => setTimeout(resolveWait, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await Promise.race([
      new Promise((resolveExit) => child.once('exit', resolveExit)),
      new Promise((resolveWait) => setTimeout(resolveWait, 5_000)),
    ]);
  }
  return child.exitCode !== null || child.signalCode !== null;
}

async function stopTrace(cdp) {
  const completed = new Promise((resolveCompleted) => cdp.once('Tracing.tracingComplete', resolveCompleted));
  await cdp.send('Tracing.end');
  const { stream } = await completed;
  let json = '';
  while (true) {
    const chunk = await cdp.send('IO.read', { handle: stream });
    json += chunk.data;
    if (chunk.eof) break;
  }
  await cdp.send('IO.close', { handle: stream });
  const parsed = JSON.parse(json);
  return Array.isArray(parsed.traceEvents) ? parsed.traceEvents : [];
}

function scriptUrl(event) {
  const data = event.args?.data || event.args?.beginData || {};
  return data.url || data.scriptName || data.fileName || null;
}

function summarizeTrace(events, appLoadedAt) {
  const parseEvaluateByUrl = new Map();
  const scriptEvents = events.filter(
    (event) =>
      event.ph === 'X' &&
      Number.isFinite(event.dur) &&
      ['EvaluateScript', 'CompileScript', 'v8.compile', 'FunctionCall'].includes(event.name)
  );
  for (const event of scriptEvents) {
    const url = scriptUrl(event);
    if (!url || !/^https?:/.test(url)) continue;
    const path = new URL(url).pathname;
    parseEvaluateByUrl.set(path, (parseEvaluateByUrl.get(path) || 0) + event.dur / 1000);
  }
  const longTasks = events
    .filter((event) => event.ph === 'X' && ['RunTask', 'Task'].includes(event.name) && event.dur >= 50_000)
    .map((task) => {
      const start = task.ts;
      const end = task.ts + task.dur;
      const attribution = scriptEvents
        .filter((event) => event.ts >= start && event.ts + event.dur <= end)
        .map(scriptUrl)
        .filter(Boolean)
        .map((url) => (/^https?:/.test(url) ? new URL(url).pathname : url));
      return { durationMs: task.dur / 1000, attribution: [...new Set(attribution)] };
    });
  return { appLoadedAt, parseEvaluateByUrl: Object.fromEntries(parseEvaluateByUrl), longTasks };
}

async function profileNavigation({ browser, baseUrl, credentials, viewport, cache }) {
  const context = await browser.newContext({ viewport, httpCredentials: credentials });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const pageErrors = [];
  const seriousConsoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if ((message.type() === 'error' || message.type() === 'warning') && SERIOUS_CONSOLE.test(message.text())) {
      seriousConsoleErrors.push(`${message.type()}: ${message.text()}`);
    }
  });
  await page.addInitScript(() => {
    window.__cod356Startup = { appLoadedAt: null, longTasks: [] };
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__cod356Startup.longTasks.push({
            startTimeMs: entry.startTime,
            durationMs: entry.duration,
            attribution: (entry.attribution || []).map((item) => ({
              name: item.name,
              containerName: item.containerName,
              containerSrc: item.containerSrc,
            })),
          });
        }
      }).observe({ type: 'longtask', buffered: true });
    } catch {}
    const capture = () => {
      if (document.body?.classList.contains('app-loaded') && window.__cod356Startup.appLoadedAt === null) {
        window.__cod356Startup.appLoadedAt = performance.now();
      }
    };
    document.addEventListener('DOMContentLoaded', capture, { once: true });
    const installObserver = () => {
      if (!document.documentElement) return requestAnimationFrame(installObserver);
      new MutationObserver(capture).observe(document.documentElement, {
        subtree: true,
        attributes: true,
        attributeFilter: ['class'],
      });
    };
    installObserver();
  });
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: cache === 'cold' });

  if (cache === 'warm') {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForFunction(() => document.body.classList.contains('app-loaded'));
    await page.waitForTimeout(500);
    await page.goto('about:blank');
    pageErrors.length = 0;
    seriousConsoleErrors.length = 0;
  }

  await cdp.send('Tracing.start', {
    categories: 'devtools.timeline,v8,disabled-by-default-v8.compile,blink.user_timing',
    options: 'record-as-much-as-possible',
    transferMode: 'ReturnAsStream',
  });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(() => document.body.classList.contains('app-loaded'));
  await page.waitForTimeout(500);
  const navigation = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const resources = performance.getEntriesByType('resource').map((entry) => ({
      path: new URL(entry.name).pathname,
      initiatorType: entry.initiatorType,
      startTimeMs: entry.startTime,
      responseEndMs: entry.responseEnd,
      transferBytes: entry.transferSize,
      encodedBytes: entry.encodedBodySize,
      decodedBytes: entry.decodedBodySize,
    }));
    return {
      appLoadedAt: window.__cod356Startup.appLoadedAt,
      observedLongTasks: window.__cod356Startup.longTasks,
      domContentLoadedMs: nav.domContentLoadedEventEnd,
      loadMs: nav.loadEventEnd,
      resources,
    };
  });
  const trace = summarizeTrace(await stopTrace(cdp), navigation.appLoadedAt);
  await context.close();
  if (pageErrors.length || seriousConsoleErrors.length) {
    throw new Error(`unclean profile page: ${JSON.stringify({ pageErrors, seriousConsoleErrors })}`);
  }
  return {
    ...navigation,
    ...trace,
    longTasks: trace.longTasks.length ? trace.longTasks : navigation.observedLongTasks,
    pageErrors,
    seriousConsoleErrors,
  };
}

async function addStaticSizes(profile, runtimeRoot) {
  const rows = [];
  for (const resource of profile.resources) {
    const relative = resource.path.replace(/^\//, '');
    const file = join(runtimeRoot, 'src/web/public', relative);
    const content = await readFile(file).catch(() => null);
    rows.push({
      ...resource,
      rawBytes: content?.byteLength ?? null,
      gzipBytes: content ? gzipSync(content, { level: 9 }).byteLength : null,
      brotliBytes: content
        ? brotliCompressSync(content, {
            params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9 },
          }).byteLength
        : null,
      parseEvaluateMs: profile.parseEvaluateByUrl[resource.path] || 0,
      requiredBeforeAppLoaded: resource.responseEndMs <= profile.appLoadedAt,
    });
  }
  return { ...profile, assets: rows };
}

function summarize(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return { count: 0, median: null, p95: null, min: null, max: null };
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
  return {
    count: sorted.length,
    median,
    p95: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)],
    min: sorted[0],
    max: sorted.at(-1),
  };
}

export function summarizeProfileSamples(samples) {
  const paths = [...new Set(samples.flatMap((sample) => sample.assets.map((asset) => asset.path)))].sort();
  return {
    appLoadedMs: summarize(samples.map((sample) => sample.appLoadedAt)),
    domContentLoadedMs: summarize(samples.map((sample) => sample.domContentLoadedMs)),
    loadMs: summarize(samples.map((sample) => sample.loadMs)),
    totalDecodedBytes: summarize(
      samples.map((sample) => sample.assets.reduce((sum, asset) => sum + asset.decodedBytes, 0))
    ),
    longTaskCount: summarize(samples.map((sample) => sample.longTasks.length)),
    navigationPlusPostReadyLongTaskTotalDurationMs: summarize(
      samples.map((sample) => sample.longTasks.reduce((sum, task) => sum + task.durationMs, 0))
    ),
    observationWindow: { start: 'navigationStart', end: 'appLoadedAt + 500ms' },
    assets: Object.fromEntries(
      paths.map((path) => {
        const assets = samples.flatMap((sample) => sample.assets.filter((asset) => asset.path === path));
        return [
          path,
          {
            sampleCount: assets.length,
            rawBytes: [...new Set(assets.map((asset) => asset.rawBytes))],
            gzipBytes: [...new Set(assets.map((asset) => asset.gzipBytes))],
            brotliBytes: [...new Set(assets.map((asset) => asset.brotliBytes))],
            requestStartMs: summarize(assets.map((asset) => asset.startTimeMs)),
            responseEndMs: summarize(assets.map((asset) => asset.responseEndMs)),
            parseEvaluateMs: summarize(assets.map((asset) => asset.parseEvaluateMs)),
            requiredBeforeAppLoaded: {
              trueCount: assets.filter((asset) => asset.requiredBeforeAppLoaded).length,
              falseCount: assets.filter((asset) => !asset.requiredBeforeAppLoaded).length,
            },
          },
        ];
      })
    ),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const runtimeProvenance = await verifyRuntimeProvenance(options.runtimeRoot, options.runtimeRevision);
  const profilerProvenance = await collectProfilerProvenance();
  const tempRoot = await mkdtemp(join(tmpdir(), 'cod356-assets-'));
  const dataDir = join(tempRoot, 'data');
  await mkdir(dataDir, { recursive: true });
  const port = await unusedPort();
  const credentials = { username: 'cod356-assets', password: 'cod356-assets-profile' };
  const authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
  const baseUrl = `http://${HOST}:${port}`;
  const child = spawn(
    join(TOOL_ROOT, 'node_modules/.bin/tsx'),
    ['src/index.ts', 'web', '--host', HOST, '--port', String(port)],
    {
      cwd: options.runtimeRoot,
      env: {
        ...process.env,
        CODEMAN_INSTANCE: `cod356-assets-${process.pid}`,
        CODEMAN_DATA_DIR: dataDir,
        CODEMAN_HOST: HOST,
        CODEMAN_PORT: String(port),
        CODEMAN_USERNAME: credentials.username,
        CODEMAN_PASSWORD: credentials.password,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  const logs = [];
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
  let browser;
  let profiles;
  let profileError;
  try {
    await waitForServer(baseUrl, child, authorization);
    browser = await chromium.launch({ headless: true });
    const variants = [
      ['desktop', { width: 1365, height: 768 }],
      ['mobile-390', { width: 390, height: 844 }],
    ];
    profiles = {};
    for (const [device, viewport] of variants) {
      for (const cache of ['cold', 'warm']) {
        const samples = [];
        for (let sampleIndex = 0; sampleIndex < options.samples; sampleIndex++) {
          samples.push(
            await addStaticSizes(
              await profileNavigation({ browser, baseUrl, credentials, viewport, cache }),
              options.runtimeRoot
            )
          );
        }
        profiles[`${device}-${cache}`] = { samples, aggregate: summarizeProfileSamples(samples) };
      }
    }
  } catch (error) {
    profileError = error;
  }

  const cleanup = { browserClosed: false, childStopped: false, tempRootRemoved: false };
  try {
    await browser?.close();
    cleanup.browserClosed = !browser || !browser.isConnected();
  } catch (error) {
    profileError ??= error;
  }
  try {
    cleanup.childStopped = await stopChild(child);
  } catch (error) {
    profileError ??= error;
  }
  try {
    await rm(tempRoot, { recursive: true, force: true });
    cleanup.tempRootRemoved = await access(tempRoot).then(
      () => false,
      () => true
    );
  } catch (error) {
    profileError ??= error;
  }

  try {
    assertCleanupComplete(cleanup);
  } catch (error) {
    profileError ??= error;
  }
  if (profileError) {
    process.stderr.write(`${profileError.stack || profileError}\n${logs.slice(-30).join('')}\n`);
    process.exitCode = 1;
    return;
  }

  const report = {
    schemaVersion: 3,
    generatedAt: new Date().toISOString(),
    runtime: { revision: options.runtimeRevision, root: options.runtimeRoot, provenance: runtimeProvenance },
    profilerProvenance,
    target: { host: HOST, port: 'ephemeral', disposable: true },
    samplesPerProfile: options.samples,
    profiles,
    cleanup,
  };
  await publishReport({ output: options.output, report, cleanup, writeStdout: true });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
