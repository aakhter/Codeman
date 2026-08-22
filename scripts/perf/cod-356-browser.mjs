import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function resolveAuthoritativeRunningPid(sessionId, authoritativeSession) {
  if (authoritativeSession?.id !== sessionId) return null;
  if (!['idle', 'busy'].includes(authoritativeSession.status)) return null;
  return Number.isSafeInteger(authoritativeSession.pid) && authoritativeSession.pid > 0
    ? authoritativeSession.pid
    : null;
}

export async function waitForAuthoritativeSessionReady(
  fetchState,
  sessionId,
  { timeoutMs = 20_000, intervalMs = 50, signal } = {}
) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  while (Date.now() <= deadline) {
    signal?.throwIfAborted();
    lastState = await fetchState(sessionId);
    if (resolveAuthoritativeRunningPid(sessionId, lastState) !== null) return lastState;
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
  }
  throw new Error(`authoritative session ${sessionId} did not become process-ready: ${JSON.stringify(lastState)}`);
}

export async function selectSessionAndWaitForTerminal(page, sessionId, authoritativeSession) {
  const authoritativeRunningPid = resolveAuthoritativeRunningPid(sessionId, authoritativeSession);
  await page.evaluate(
    ({ sessionId: id, authoritativeRunningPid: runningPid }) => {
      const cached = window.app.sessions.get(id);
      // WebServer's 1s light-state cache can carry pid=null from immediately
      // before this benchmark fixture attached. Repair only that exact stale
      // field, and only from the uncached per-session API state fetched by the
      // harness. A genuinely stopped or foreign session still takes the real
      // attach path in selectSession().
      if (cached?.pid === null && runningPid !== null) cached.pid = runningPid;
      return window.app.selectSession(id);
    },
    { sessionId, authoritativeRunningPid }
  );
  await page.waitForFunction(
    (id) =>
      window.app.activeSessionId === id && Boolean(window.app.terminal?.buffer?.active) && window.app._wsReady === true,
    sessionId,
    { timeout: 20_000 }
  );
}

export async function prepareInteractiveTargetSession(
  page,
  { interactiveSessionId, targetSessionId, authoritativeSessions = {}, waitForAuthoritativeReady }
) {
  const prepare = async (sessionId) => {
    const initialState = authoritativeSessions[sessionId];
    const attachAlreadyInProgress =
      initialState?.id === sessionId && initialState.status === 'busy' && initialState.pid === null;
    if (attachAlreadyInProgress) {
      const readyState = (await waitForAuthoritativeReady?.(sessionId)) ?? initialState;
      await selectSessionAndWaitForTerminal(page, sessionId, readyState);
      return;
    }
    await selectSessionAndWaitForTerminal(page, sessionId, initialState);
    if (resolveAuthoritativeRunningPid(sessionId, initialState) === null) {
      await waitForAuthoritativeReady?.(sessionId);
    }
  };

  if (interactiveSessionId) {
    await prepare(interactiveSessionId);
  }
  await prepare(targetSessionId);
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
  const completeText = text.endsWith('\n') ? text : text.slice(0, text.lastIndexOf('\n') + 1);
  return completeText
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export async function installPageInstrumentation(page) {
  await page.addInitScript(() => {
    window.__cod356 = { longTasks: [], webSocketSends: [], inputAcks: [], outputFrames: [] };
    const hashText = (value) => {
      let hash = 0x811c9dc5;
      for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
      }
      return (hash >>> 0).toString(16).padStart(8, '0');
    };
    const boundedText = (value) => {
      const text = value ?? '';
      const correlationTokens = [
        ...new Set([...text.matchAll(/COD356_ECHO:[A-Za-z0-9+/=]{1,128}/g)].map((match) => match[0])),
      ].slice(-16);
      return {
        hash: hashText(text),
        byteLength: new TextEncoder().encode(text).byteLength,
        prefix: text.slice(0, 128),
        suffix: text.slice(-128),
        correlationToken: correlationTokens[0] ?? null,
        correlationTokens,
      };
    };
    window.__cod356HashText = hashText;
    window.__cod356BoundedText = boundedText;
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
          const parsed = JSON.parse(data);
          frame = {
            t: parsed?.t ?? null,
            seq: parsed?.seq ?? null,
            cid: parsed?.cid ?? null,
            ...(typeof parsed?.d === 'string'
              ? {
                  dataHash: hashText(parsed.d),
                  dataByteLength: new TextEncoder().encode(parsed.d).byteLength,
                }
              : {}),
          };
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
      const bounded = window.__cod356BoundedText(event?.data ?? '');
      trace.outputFrames.push({
        timestamp: performance.now(),
        ...bounded,
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

export async function armFirstVisibleObservation(page, token, { timeoutMs = 10_000 } = {}) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 256) {
    throw new Error('first-visible correlation token must contain 1-256 characters');
  }
  const observationId = await page.evaluate(
    ({ value, deadlineMs }) => {
      const previous = window.__cod356VisibleObservation;
      previous?.disposable?.dispose();
      if (previous?.timeoutId) clearTimeout(previous.timeoutId);
      const terminal = window.app?.terminal;
      if (!terminal?.buffer?.active || typeof terminal.onWriteParsed !== 'function') {
        throw new Error('xterm onWriteParsed observation is unavailable');
      }
      const id = (window.__cod356NextVisibleObservationId ?? 0) + 1;
      window.__cod356NextVisibleObservationId = id;
      const observation = {
        id,
        tokenLength: value.length,
        detectedAt: null,
        detection: null,
        checks: 0,
        snapshots: [],
        disposable: null,
        timeoutId: null,
      };
      const hashText = (text) => {
        let hash = 0x811c9dc5;
        for (let index = 0; index < text.length; index++) {
          hash ^= text.charCodeAt(index);
          hash = Math.imul(hash, 0x01000193);
        }
        return (hash >>> 0).toString(16).padStart(8, '0');
      };
      const snapshotBuffer = (buffer) => {
        if (!buffer) return null;
        let rendered = '';
        for (let row = Math.max(0, buffer.baseY - 20); row < buffer.length; row++) {
          rendered += buffer.getLine(row)?.translateToString(false) ?? '';
        }
        return {
          hash: hashText(rendered),
          length: rendered.length,
          containsToken: rendered.includes(value),
          prefix: rendered.slice(0, 64),
          suffix: rendered.slice(-64),
          baseY: buffer.baseY,
          viewportY: buffer.viewportY,
          cursorX: buffer.cursorX,
          cursorY: buffer.cursorY,
        };
      };
      const inspect = () => {
        observation.checks++;
        const active = snapshotBuffer(terminal.buffer.active);
        if (observation.snapshots.length < 16) {
          observation.snapshots.push({
            timestamp: performance.now(),
            active,
            normal: snapshotBuffer(terminal.buffer.normal),
            alternate: snapshotBuffer(terminal.buffer.alternate),
          });
        }
        if (active?.containsToken && observation.detectedAt === null) {
          const detectedAt = performance.now();
          observation.detectedAt = detectedAt;
          observation.detection = {
            token: value,
            timestamp: detectedAt,
            snapshot: { timestamp: detectedAt, active },
          };
        }
      };
      observation.disposable = terminal.onWriteParsed(inspect);
      observation.timeoutId = setTimeout(() => {
        observation.disposable?.dispose();
        observation.disposable = null;
        observation.timeoutId = null;
      }, deadlineMs);
      window.__cod356VisibleObservation = observation;
      inspect();
      return id;
    },
    { value: token, deadlineMs: timeoutMs }
  );
  const dispose = async () => {
    if (page.isClosed()) return;
    await page.evaluate((id) => {
      const observation = window.__cod356VisibleObservation;
      if (observation?.id !== id) return;
      observation.disposable?.dispose();
      if (observation.timeoutId) clearTimeout(observation.timeoutId);
      observation.disposable = null;
      observation.timeoutId = null;
    }, observationId);
  };
  const waitForDetection = async () => {
    try {
      return await page
        .waitForFunction(
          (id) => {
            const observation = window.__cod356VisibleObservation;
            return observation?.id === id && observation.detection ? observation.detection : false;
          },
          observationId,
          { timeout: timeoutMs }
        )
        .then((handle) => handle.jsonValue());
    } catch (error) {
      const diagnostic = page.isClosed()
        ? { pageClosed: true }
        : await page.evaluate((id) => {
            const observation = window.__cod356VisibleObservation;
            if (observation?.id !== id) return { observationReplaced: true };
            return {
              checks: observation.checks,
              tokenLength: observation.tokenLength,
              snapshots: observation.snapshots,
              recentOutputFrames: window.__cod356?.outputFrames?.slice(-8) ?? [],
              recentTerminalReceipts: window.__cod356?.terminalReceipts?.slice(-8) ?? [],
              recentXtermWrites: window.__cod356?.xtermWrites?.slice(-8) ?? [],
              recentFlushCalls: window.__cod356?.flushCalls?.slice(-8) ?? [],
            };
          }, observationId);
      throw new Error(`first-visible observation unavailable: ${JSON.stringify(diagnostic)}`, { cause: error });
    } finally {
      await dispose();
    }
  };
  return {
    async wait() {
      return (await waitForDetection()).timestamp;
    },
    waitForDetection,
    dispose,
  };
}

export async function prepareInputTrialObservation(page, token, options) {
  if (await terminalContains(page, token)) {
    throw new Error('current-trial visible token was present before input send');
  }
  return armFirstVisibleObservation(page, token, options);
}

export async function withInputTrialObservation(page, token, operation, options) {
  const observation = await prepareInputTrialObservation(page, token, options);
  try {
    return await operation(observation);
  } finally {
    await observation.dispose();
  }
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
