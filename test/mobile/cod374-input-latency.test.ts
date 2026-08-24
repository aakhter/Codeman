import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import {
  BROWSER_GLOBAL_OUTPUT_STAGES,
  BROWSER_INPUT_STAGES,
  BROWSER_VISIBILITY_STAGES,
  armBrowserLatencyTrial,
  completeBrowserLatencyWindow,
  correlateBrowserServerTrace,
  installBrowserLatencyHooks,
  installBrowserLatencyInitScript,
  observePaneVisibilities,
  PaneObservationError,
  readBrowserLatencyTrace,
  removeBrowserLatencyHooks,
  requireNoBrowserLongTasks,
  type PaneVisibilityResult,
  validateBrowserLatencyTrace,
  validateServerOutputChain,
} from '../utils/cod374-latency-trace.js';
import { Cod370OpenCodeFixture, hasMandatoryCleanupProof } from '../utils/cod370-opencode-fixture.js';

const POLL_MS = 20;

async function waitUntil(label: string, probe: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await probe()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`Timed out waiting for ${label}${lastError instanceof Error ? `: ${lastError.message}` : ''}`);
}

async function terminalText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const terminal = (window as unknown as { app: Record<string, any> }).app.terminal;
    const buffer = terminal.buffer.active;
    const lines: string[] = [];
    for (let row = 0; row < buffer.length; row++) lines.push(buffer.getLine(row)?.translateToString(true) ?? '');
    return lines.join('\n');
  });
}

async function dispatchRapidKeys(page: Page, inputs: string[]): Promise<void> {
  const session = await page.context().newCDPSession(page);
  try {
    const dispatches: Array<Promise<unknown>> = [];
    for (const input of inputs) {
      const upper = input.toUpperCase();
      const code = /^[a-z]$/i.test(input) ? `Key${upper}` : /^\d$/.test(input) ? `Digit${input}` : '';
      const windowsVirtualKeyCode = upper.charCodeAt(0);
      dispatches.push(
        session.send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: input,
          code,
          text: input,
          unmodifiedText: input,
          windowsVirtualKeyCode,
          nativeVirtualKeyCode: windowsVirtualKeyCode,
        }),
        session.send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: input,
          code,
          windowsVirtualKeyCode,
          nativeVirtualKeyCode: windowsVirtualKeyCode,
        })
      );
    }
    await Promise.all(dispatches);
  } finally {
    await session.detach();
  }
}

function exactComposerToken(text: string, marker: string): string | null {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = text
    .split('\n')
    .map((line) => line.match(new RegExp(`^\\s*[│┃]\\s+(${escaped}[A-Za-z0-9]*)\\s*(?:[│┃])?\\s*$`))?.[1])
    .filter((value): value is string => !!value);
  return matches.length === 1 ? matches[0] : null;
}

async function selectAndFocusPhone(fixture: Cod370OpenCodeFixture): Promise<void> {
  const page = fixture.phonePage!;
  await page.bringToFront();
  await page.evaluate(
    (id) => (window as unknown as { app: Record<string, any> }).app.selectSession(id, { auto: true }),
    fixture.sessionId
  );
  await page.waitForFunction(
    (id) => {
      const app = (window as unknown as { app: Record<string, any> }).app;
      return app.activeSessionId === id && app._wsReady === true && app._wsSessionId === id && !!app.terminal?.buffer;
    },
    fixture.sessionId,
    { timeout: 20_000 }
  );
  await waitUntil('OpenCode composer in pane and xterm', async () => {
    const pane = fixture.paneText();
    return pane.includes('Ask anything') && (await terminalText(page)).includes('Ask anything');
  });
  const screen = page.locator('#terminalContainer .xterm-screen');
  const box = await screen.boundingBox();
  if (!box) throw new Error('Phone xterm screen has no bounding box');
  const composerRow = fixture
    .paneText()
    .split('\n')
    .findIndex((line) => line.includes('Ask anything'));
  const rows = await page.evaluate(() => (window as unknown as { app: Record<string, any> }).app.terminal.rows);
  await screen.click({ position: { x: 30, y: ((composerRow + 0.5) * box.height) / rows } });
  await page.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea'), undefined, {
    timeout: 2_000,
  });
  let stableSince = 0;
  await waitUntil('empty focused OpenCode composer stable for 500ms', async () => {
    const browser = await page.evaluate(() => {
      const app = (window as unknown as { app: Record<string, any> }).app;
      return {
        activeSessionId: app.activeSessionId,
        wsReady: app._wsReady,
        wsSessionId: app._wsSessionId,
        focused: document.activeElement?.classList.contains('xterm-helper-textarea') === true,
      };
    });
    const pane = fixture.paneText();
    const xterm = await terminalText(page);
    const ready =
      browser.activeSessionId === fixture.sessionId &&
      browser.wsReady === true &&
      browser.wsSessionId === fixture.sessionId &&
      browser.focused &&
      /┃\s*\n\s*┃\s+Ask anything/.test(pane) &&
      /┃\s*\n\s*┃\s+Ask anything/.test(xterm);
    if (!ready) {
      stableSince = 0;
      return false;
    }
    stableSince ||= Date.now();
    return Date.now() - stableSince >= 500;
  });
}

describe('COD-374 real mobile OpenCode latency trace', () => {
  it('records every latency boundary', async () => {
    const traceSecret = randomBytes(24).toString('hex');
    const fixture = new Cod370OpenCodeFixture({ mobileTrace: { secret: traceSecret, capacity: 20_000 } });
    const failures: Error[] = [];
    const pageErrors: string[] = [];
    const seriousConsoleErrors: string[] = [];
    const diagnosticWarnings: string[] = [];
    let acceptedWindowDiagnosticWarnings: string[] = [];
    let hooksCleanup: { wrappersRestored: boolean; listenersDisposed: boolean } | null = null;
    let paneController: AbortController | null = null;
    let panePromise: Promise<PaneVisibilityResult[]> | null = null;
    let paneObserverSettled = false;
    try {
      await fixture.start();
      const phone = fixture.phonePage!;
      phone.on('pageerror', (error) => pageErrors.push(error.message));
      phone.on('console', (message) => {
        const text = message.text();
        if (message.type() === 'warning' && /^\[CRASH-DIAG\].*long task/i.test(text)) {
          diagnosticWarnings.push(text);
          return;
        }
        if (
          message.type() === 'error' ||
          (message.type() === 'warning' && /(?:crash|exception|uncaught|failed|fatal)/i.test(text))
        ) {
          seriousConsoleErrors.push(`${message.type()}: ${text}`);
        }
      });
      await installBrowserLatencyInitScript(phone);
      await fixture.navigatePages();
      let injectedInstallFailure = '';
      const listenerCountBeforeRollback = await phone.evaluate(
        () => (window as any).__cod374LatencyTrace.listenerCount as number
      );
      try {
        await installBrowserLatencyHooks(phone, { failAfter: 'parsed-listener' });
      } catch (error) {
        injectedInstallFailure = error instanceof Error ? error.message : String(error);
      }
      const rollbackProof = await phone.evaluate(() => {
        const browserWindow = window as any;
        const state = browserWindow.__cod374LatencyTrace;
        const app = browserWindow.app;
        return {
          wrappersInstalled: state.wrappersInstalled,
          cleanupCount: state.hookCleanup.length,
          listenerCount: state.listenerCount,
          methodsRestored:
            app._sendInputAsync === state.originals._sendInputAsync &&
            app._reliableSend === state.originals._reliableSend &&
            app._drainSession === state.originals._drainSession &&
            app.terminal.write === state.originals.terminalWrite,
        };
      });
      await installBrowserLatencyHooks(phone);
      const probeTrialId = `cod374-send-probe-${Date.now().toString(36)}`;
      await armBrowserLatencyTrial(phone, {
        trialId: probeTrialId,
        inputIndex: 0,
        tokenHash: createHash('sha256').update('x').digest('hex').slice(0, 16),
        tokenLength: 1,
        token: 'x',
      });
      const sendProbe = await phone.evaluate(() => {
        const state = (window as any).__cod374LatencyTrace;
        state.dispatchContext = state.armedContexts.shift();
        state.originals.record('browser.keydown', {}, state.dispatchContext);
        const TracedWebSocket = window.WebSocket;
        const BaseWebSocket = Object.getPrototypeOf(TracedWebSocket) as typeof WebSocket;
        const originalSend = BaseWebSocket.prototype.send;
        let calls = 0;
        let thrown = '';
        BaseWebSocket.prototype.send = function () {
          calls++;
          if (calls === 1) throw new Error('send-once-probe');
        };
        try {
          const socket = Object.create(TracedWebSocket.prototype) as WebSocket;
          const frame = JSON.stringify({ t: 'i', cid: 'probe-client', seq: 1, d: 'x' });
          try {
            socket.send(frame);
          } catch (error) {
            thrown = error instanceof Error ? error.message : String(error);
          }
          socket.send(frame);
        } finally {
          BaseWebSocket.prototype.send = originalSend;
        }
        return { calls, thrown };
      });
      const sendProbeEvents = await readBrowserLatencyTrace(phone, probeTrialId);
      await fixture.createOpenCodeSession();
      await selectAndFocusPhone(fixture);
      expect(sendProbe).toEqual({ calls: 2, thrown: 'send-once-probe' });
      expect(
        sendProbeEvents
          .filter((event) => event.stage === 'browser.ws-input-send')
          .map((event) => ({ attempt: event.attempt, selected: event.selectedForAttribution }))
      ).toEqual([
        { attempt: 1, selected: false },
        { attempt: 2, selected: true },
      ]);
      expect(sendProbeEvents.filter((event) => event.stage === 'browser.ws-input-send-failure')).toMatchObject([
        { attempt: 1, failureHash: expect.stringMatching(/^[0-9a-f]{16}$/) },
      ]);
      expect(sendProbeEvents.filter((event) => event.stage === 'browser.ws-input-send-return')).toMatchObject([
        { attempt: 2 },
      ]);
      expect(injectedInstallFailure).toMatch(/injected hook install failure after parsed-listener/i);
      expect(rollbackProof).toEqual({
        wrappersInstalled: false,
        cleanupCount: 0,
        listenerCount: listenerCountBeforeRollback,
        methodsRestored: true,
      });
      expect(fixture.paneCount()).toBe(1);
      const identity = fixture.identities();

      await fixture.mobileTraceSnapshot(traceSecret, true);
      diagnosticWarnings.length = 0;
      const marker = 'q';
      const trialId = `cod374-${Date.now().toString(36)}`;
      const inputs = ['q', 'z', '1'];
      const expectedTokens: string[] = [];
      let expected = '';
      for (const [inputIndex, character] of inputs.entries()) {
        expected += character;
        expectedTokens.push(expected);
        const tokenHash = createHash('sha256').update(expected).digest('hex').slice(0, 16);
        await armBrowserLatencyTrial(phone, {
          trialId,
          inputIndex,
          tokenHash,
          tokenLength: expected.length,
          token: expected,
        });
      }
      paneObserverSettled = false;
      paneController = new AbortController();
      panePromise = observePaneVisibilities({
        capture: ({ signal, timeoutMs }) => fixture.capturePaneText({ signal, timeoutMs }),
        targets: expectedTokens.map((token) => ({
          id: token,
          isPresent: (text: string) => exactComposerToken(text, marker) === token,
        })),
        completionTargetId: expectedTokens.at(-1)!,
        deadlineMs: 10_000,
        pollIntervalMs: 5,
        signal: paneController.signal,
      });

      await dispatchRapidKeys(phone, inputs);
      await phone.waitForFunction(
        () => {
          const app = (window as unknown as { app: Record<string, any> }).app;
          return !app._pendingInput && (app._pendingDeliveries.get(app.activeSessionId)?.length ?? 0) === 0;
        },
        undefined,
        { timeout: 10_000 }
      );
      try {
        await waitUntil('final rapid browser paint-proxy boundary', async () =>
          (await readBrowserLatencyTrace(phone, trialId)).some(
            (event) =>
              event.stage === 'browser.paint-proxy' &&
              event.inputIndex === inputs.length - 1 &&
              event.selectedForAttribution === true
          )
        );
      } catch (error) {
        const trace = await readBrowserLatencyTrace(phone, trialId);
        const paneText = fixture.paneText();
        const xtermText = await terminalText(phone);
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; trace=${JSON.stringify(trace)}; pane=${JSON.stringify(
            {
              bytes: Buffer.byteLength(paneText),
              hash: createHash('sha256').update(paneText).digest('hex').slice(0, 16),
              exactToken: exactComposerToken(paneText, marker),
            }
          )}; xterm=${JSON.stringify({
            bytes: Buffer.byteLength(xtermText),
            hash: createHash('sha256').update(xtermText).digest('hex').slice(0, 16),
            exactToken: exactComposerToken(xtermText, marker),
          })}`
        );
      }
      const paneResults = await panePromise;
      paneObserverSettled = true;
      expect(paneResults.map((result) => result.id)).toEqual(expectedTokens);
      const firstProbeStarts = paneResults.map((result) =>
        (result.status === 'visible' ? result.interval.probes : result.error.probes)[0]?.startedNs.toString()
      );
      expect(new Set(firstProbeStarts).size).toBe(1);
      const finalPaneResult = paneResults.find((result) => result.id === expectedTokens.at(-1))!;
      if (finalPaneResult.status !== 'visible') {
        const browserTrace = await readBrowserLatencyTrace(phone, trialId);
        const paneText = fixture.paneText();
        const xtermText = await terminalText(phone);
        const probeSummary =
          finalPaneResult.error instanceof PaneObservationError
            ? {
                count: finalPaneResult.error.probes.length,
                errorCount: finalPaneResult.error.probes.filter((probe) => probe.error).length,
              }
            : null;
        throw new Error(
          `Final rapid pane token was not observed; probes=${JSON.stringify(probeSummary)}; browser=${JSON.stringify(
            browserTrace
          )}; pane=${JSON.stringify({
            bytes: Buffer.byteLength(paneText),
            hash: createHash('sha256').update(paneText).digest('hex').slice(0, 16),
            exactToken: exactComposerToken(paneText, marker),
          })}; xterm=${JSON.stringify({
            bytes: Buffer.byteLength(xtermText),
            hash: createHash('sha256').update(xtermText).digest('hex').slice(0, 16),
            exactToken: exactComposerToken(xtermText, marker),
          })}`
        );
      }
      await completeBrowserLatencyWindow(phone, trialId);
      acceptedWindowDiagnosticWarnings = [...diagnosticWarnings];

      const browserEvents = validateBrowserLatencyTrace(await readBrowserLatencyTrace(phone, trialId));
      const durable = browserEvents.filter((event) => event.stage === 'browser.durable-queued');
      expect(durable).toHaveLength(inputs.length);
      const keydowns = browserEvents.filter((event) => event.stage === 'browser.keydown');
      const firstOutput = browserEvents.find((event) => event.stage === 'browser.ws-output-receive')!;
      expect(keydowns).toHaveLength(inputs.length);
      expect(Math.max(...keydowns.map((event) => event.atMs))).toBeLessThan(firstOutput.atMs);
      for (const inputIndex of inputs.keys()) {
        const selected = browserEvents.filter(
          (event) => event.generation > 0 && event.inputIndex === inputIndex && event.selectedForAttribution !== false
        );
        expect(
          selected.filter((event) => BROWSER_INPUT_STAGES.includes(event.stage as any)).map((event) => event.stage)
        ).toEqual(BROWSER_INPUT_STAGES);
        const inputDurable = selected.find((event) => event.stage === 'browser.durable-queued')!;
        expect(inputDurable).toMatchObject({ clientId: expect.any(String), seq: expect.any(Number) });
        for (const stage of ['browser.ws-input-send', 'browser.ws-input-send-return', 'browser.ws-input-ack']) {
          expect(selected.find((event) => event.stage === stage)).toMatchObject({
            clientId: inputDurable.clientId,
            seq: inputDurable.seq,
          });
        }
        expect(selected.find((event) => event.stage === 'browser.ws-input-ack')).toMatchObject({
          pendingCount: expect.any(Number),
        });
        expect(selected.every((event) => event.tokenLength === expectedTokens[inputIndex].length)).toBe(true);
        const visibility = selected.filter((event) => BROWSER_VISIBILITY_STAGES.includes(event.stage as any));
        const incomplete = selected.filter((event) => event.stage === 'browser.generation-incomplete');
        if (visibility.length === 0) {
          expect(incomplete).toEqual([
            expect.objectContaining({ incompleteReason: 'coalesced-before-exact-visibility' }),
          ]);
        } else {
          expect(visibility.map((event) => event.stage)).toEqual(BROWSER_VISIBILITY_STAGES);
          expect(incomplete).toEqual([]);
        }
      }
      const acknowledgements = browserEvents.filter((event) => event.stage === 'browser.ws-input-ack');
      expect(acknowledgements.at(-1)).toMatchObject({ pendingCount: 0 });
      expect(durable.some((event) => (event.coalescedCount ?? 1) > 1)).toBe(true);
      expect(
        browserEvents
          .filter((event) => event.generation === 0)
          .every((event) => BROWSER_GLOBAL_OUTPUT_STAGES.includes(event.stage as any))
      ).toBe(true);
      const browserOutput = browserEvents.filter((event) => event.stage === 'browser.ws-output-receive');
      expect(browserOutput.length).toBeGreaterThan(0);
      expect(
        browserOutput.every(
          (event) =>
            typeof event.bytes === 'number' &&
            event.bytes >= 0 &&
            typeof event.valueHash === 'string' &&
            /^[0-9a-f]{16}$/.test(event.valueHash)
        )
      ).toBe(true);
      expect(browserEvents.some((event) => Object.hasOwn(event, 'raw') || Object.hasOwn(event, 'rawValue'))).toBe(
        false
      );

      expect(finalPaneResult.interval.probes.length).toBeGreaterThan(1);
      expect(finalPaneResult.interval.firstPresentCompletedNs).toBeGreaterThanOrEqual(
        finalPaneResult.interval.firstPresentStartedNs
      );
      expect(exactComposerToken(fixture.paneText(), marker)).toBe(expected);
      expect(exactComposerToken(await terminalText(phone), marker)).toBe(expected);
      expect(fixture.identities()).toEqual(identity);

      const server = await fixture.mobileTraceSnapshot(traceSecret);
      expect(server.enabled).toBe(true);
      expect(server.overflowed).toBe(false);
      const expectedServerInputStages = [
        'server.input.received',
        'server.input.parsed',
        'server.input.deduped',
        'server.input.activated',
        'server.input.pre-write',
        'server.input.post-write',
        'server.input.pre-ack',
        'server.input.post-ack',
      ];
      for (const inputDurable of durable) {
        const matching = server.events.filter(
          (event) => event.clientId === inputDurable.clientId && event.seq === inputDurable.seq
        );
        expect(matching.map((event) => event.stage)).toEqual(expectedServerInputStages);
        expect(matching.find((event) => event.stage === 'server.input.deduped')).toMatchObject({ applied: true });
        expect(matching.find((event) => event.stage === 'server.input.post-write')).toMatchObject({ delivered: true });
        const connectionHashes = new Set(matching.map((event) => event.connectionHash));
        expect(connectionHashes.size).toBe(1);
        expect([...connectionHashes][0]).toMatch(/^[0-9a-f]{16}$/);
        expect(matching.map((event) => event.ordinal)).toEqual(
          [...matching.map((event) => event.ordinal)].sort((a, b) => Number(a) - Number(b))
        );
      }
      const firstInput = durable[0];
      const correlated = correlateBrowserServerTrace(browserEvents, server.events, {
        clientId: firstInput.clientId!,
        seq: firstInput.seq!,
      });
      expect(correlated).toHaveLength(browserOutput.length);
      expect(correlated.map((event) => event.serverOrdinal)).toEqual(
        [...correlated.map((event) => event.serverOrdinal)].sort((a, b) => a - b)
      );
      expect(new Set(correlated.map((event) => event.connectionHash)).size).toBe(1);
      const serverOutputChain = validateServerOutputChain(server.events, correlated[0].connectionHash);
      expect(serverOutputChain).toMatchObject({
        upstreamChunks: expect.any(Number),
        connectionChunks: expect.any(Number),
        flushes: expect.any(Number),
      });
      expect(serverOutputChain.upstreamChunks).toBeGreaterThan(0);
      expect(serverOutputChain.connectionChunks).toBeGreaterThan(0);
      expect(serverOutputChain.flushes).toBeGreaterThanOrEqual(browserOutput.length);
      const correlatedOrdinals = new Set(correlated.map((event) => event.ordinal));
      expect(
        browserOutput
          .filter((event) => event.selectedForAttribution)
          .every((event) => correlatedOrdinals.has(event.ordinal))
      ).toBe(true);
      expect(pageErrors).toEqual([]);
      expect(seriousConsoleErrors).toEqual([]);
      requireNoBrowserLongTasks(acceptedWindowDiagnosticWarnings);
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    } finally {
      paneController?.abort();
      if (panePromise) await Promise.allSettled([panePromise]);
      paneObserverSettled = true;
      if (fixture.phonePage) {
        try {
          hooksCleanup = await removeBrowserLatencyHooks(fixture.phonePage);
        } catch (error) {
          failures.push(new Error(`browser hook cleanup: ${error instanceof Error ? error.message : String(error)}`));
        }
      }
      if (fixture.root) {
        try {
          await fixture.cleanup();
          expect(hasMandatoryCleanupProof(fixture.cleanupProof)).toBe(true);
        } catch (error) {
          failures.push(error instanceof Error ? error : new Error(String(error)));
        }
      }
    }
    if (failures.length) throw new AggregateError(failures, 'COD-374 real browser trace failed');
    expect(hooksCleanup).toEqual({ wrappersRestored: true, listenersDisposed: true });
    expect(paneObserverSettled).toBe(true);
  }, 180_000);
});
