#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const HOST = '127.0.0.1';
const SERIOUS_CONSOLE = /(?:uncaught|unhandled|failed|fatal|error)/i;

function parseArgs(argv) {
  const options = { output: null };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--output') options.output = resolve(argv[++index]);
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return options;
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
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    new Promise((resolveWait) => setTimeout(resolveWait, 5_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
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

async function addStaticSizes(profile) {
  const rows = [];
  for (const resource of profile.resources) {
    const relative = resource.path.replace(/^\//, '');
    const file = join(ROOT, 'src/web/public', relative);
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const tempRoot = await mkdtemp(join(tmpdir(), 'cod356-assets-'));
  const dataDir = join(tempRoot, 'data');
  await mkdir(dataDir, { recursive: true });
  const port = await unusedPort();
  const credentials = { username: 'cod356-assets', password: 'cod356-assets-profile' };
  const authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
  const baseUrl = `http://${HOST}:${port}`;
  const child = spawn(
    join(ROOT, 'node_modules/.bin/tsx'),
    ['src/index.ts', 'web', '--host', HOST, '--port', String(port)],
    {
      cwd: ROOT,
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
  try {
    await waitForServer(baseUrl, child, authorization);
    browser = await chromium.launch({ headless: true });
    const variants = [
      ['desktop', { width: 1365, height: 768 }],
      ['mobile-390', { width: 390, height: 844 }],
    ];
    const profiles = {};
    for (const [device, viewport] of variants) {
      for (const cache of ['cold', 'warm']) {
        profiles[`${device}-${cache}`] = await addStaticSizes(
          await profileNavigation({ browser, baseUrl, credentials, viewport, cache })
        );
      }
    }
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      target: { host: HOST, port: 'ephemeral', disposable: true },
      profiles,
      cleanup: { browserClosed: true, childStopped: true, tempRootRemoved: true },
    };
    const text = `${JSON.stringify(report, null, 2)}\n`;
    if (options.output) {
      await mkdir(dirname(options.output), { recursive: true });
      await writeFile(options.output, text);
    }
    process.stdout.write(text);
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n${logs.slice(-30).join('')}\n`);
    process.exitCode = 1;
  } finally {
    await browser?.close();
    await stopChild(child);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

await main();
