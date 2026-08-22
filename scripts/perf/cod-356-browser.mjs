import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function selectSessionAndWaitForTerminal(page, sessionId) {
  await page.evaluate((id) => window.app.selectSession(id), sessionId);
  await page.waitForFunction(
    (id) =>
      window.app.activeSessionId === id && Boolean(window.app.terminal?.buffer?.active) && window.app._wsReady === true,
    sessionId,
    { timeout: 20_000 }
  );
}

export async function prepareInteractiveTargetSession(page, { interactiveSessionId, targetSessionId }) {
  if (interactiveSessionId) await selectSessionAndWaitForTerminal(page, interactiveSessionId);
  await selectSessionAndWaitForTerminal(page, targetSessionId);
}

export function assertBrowserSampleClean({ pageErrors, seriousConsoleErrors }) {
  if (pageErrors.length > 0) throw new Error(`browser page error: ${pageErrors.join(' | ')}`);
  if (seriousConsoleErrors.length > 0) {
    throw new Error(`serious browser console error: ${seriousConsoleErrors.join(' | ')}`);
  }
}

export async function createServerTelemetryPreload(dataDir, telemetryLog) {
  const preloadPath = join(dataDir, 'cod356-server-telemetry.mjs');
  const source = `import { appendFile } from 'node:fs/promises';
import { monitorEventLoopDelay } from 'node:perf_hooks';

if (process.argv.some((value) => value === 'src/index.ts' || value.endsWith('/src/index.ts'))) {
  const logPath = ${JSON.stringify(telemetryLog)};
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  let previousCpu = process.cpuUsage();
  let previousTime = performance.now();
  let writes = Promise.resolve();
  histogram.enable();
  const timer = setInterval(() => {
    const now = performance.now();
    const cpu = process.cpuUsage(previousCpu);
    const elapsedMs = Math.max(1, now - previousTime);
    previousCpu = process.cpuUsage();
    previousTime = now;
    const event = {
      timestamp: Date.now(),
      eventLoop: {
        minMs: Number.isFinite(histogram.min) ? histogram.min / 1e6 : 0,
        medianMs: histogram.percentile(50) / 1e6,
        p95Ms: histogram.percentile(95) / 1e6,
        p99Ms: histogram.percentile(99) / 1e6,
        maxMs: histogram.max / 1e6,
      },
      cpuPercentOfOneCore: ((cpu.user + cpu.system) / 1000 / elapsedMs) * 100,
      rssBytes: process.memoryUsage.rss(),
    };
    histogram.reset();
    writes = writes.then(() => appendFile(logPath, JSON.stringify(event) + '\\n')).catch(() => undefined);
  }, 100);
  timer.unref();
  process.once('exit', () => histogram.disable());
}
`;
  await writeFile(preloadPath, source, { mode: 0o600 });
  return preloadPath;
}

export async function readProbeEvents(probeLog) {
  const text = await readFile(probeLog, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export async function installPageInstrumentation(page) {
  await page.addInitScript(() => {
    window.__cod356 = { longTasks: [], webSocketSends: [], inputAcks: [], outputFrames: [] };
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__cod356.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
      }
    }).observe({ type: 'longtask', buffered: true });
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      const byteLength =
        typeof data === 'string'
          ? new TextEncoder().encode(data).byteLength
          : data instanceof ArrayBuffer
            ? data.byteLength
            : (data?.byteLength ?? 0);
      let frame = null;
      if (typeof data === 'string') {
        try {
          frame = JSON.parse(data);
        } catch {}
      }
      window.__cod356.webSocketSends.push({ timestamp: performance.now(), byteLength, frame });
      return originalSend.call(this, data);
    };
  });
}

export async function attachAppInstrumentation(page) {
  await page.evaluate(() => {
    const app = window.app;
    const trace = window.__cod356;
    const originalAck = app._onWsInputAck.bind(app);
    app._onWsInputAck = (seq) => {
      trace.inputAcks.push({ seq, timestamp: performance.now() });
      return originalAck(seq);
    };
    const originalTerminal = app._onSessionTerminal.bind(app);
    app._onSessionTerminal = (event) => {
      trace.outputFrames.push({
        timestamp: performance.now(),
        byteLength: new TextEncoder().encode(event?.data ?? '').byteLength,
        data: event?.data ?? '',
      });
      return originalTerminal(event);
    };
  });
}

export async function terminalContains(page, token) {
  return page.evaluate((value) => {
    const terminal = window.app?.terminal;
    const buffer = terminal?.buffer?.active;
    if (!buffer) return false;
    let rendered = '';
    for (let row = Math.max(0, buffer.baseY - 20); row < buffer.length; row++) {
      rendered += buffer.getLine(row)?.translateToString(false) ?? '';
    }
    return rendered.includes(value);
  }, token);
}

export async function browserQueueSnapshot(page) {
  return page.evaluate(() => ({
    timestamp: performance.now(),
    pendingWritesCount: window.app.pendingWrites?.length ?? null,
    pendingWritesBytes: window.app.pendingWrites?.reduce((sum, value) => sum + value.length, 0) ?? null,
    writeFrameScheduled: window.app.writeFrameScheduled ?? null,
  }));
}

export async function collectBrowserMetrics(page) {
  return page.evaluate(() => {
    const resources = performance.getEntriesByType('resource');
    const navigation = performance.getEntriesByType('navigation')[0];
    return {
      resourceCount: resources.length,
      transferBytes: resources.reduce((sum, entry) => sum + (entry.transferSize || 0), 0),
      decodedBytes: resources.reduce((sum, entry) => sum + (entry.decodedBodySize || 0), 0),
      domNodes: document.getElementsByTagName('*').length,
      longTasks: window.__cod356.longTasks,
      webSocketSends: window.__cod356.webSocketSends,
      inputAcks: window.__cod356.inputAcks,
      outputFrames: window.__cod356.outputFrames.map(({ data: _data, ...entry }) => entry),
      domContentLoadedMs: navigation?.domContentLoadedEventEnd ?? null,
      loadEventMs: navigation?.loadEventEnd ?? null,
    };
  });
}
