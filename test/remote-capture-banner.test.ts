// Port: none (pure frontend module in a node VM with a fake DOM — no browser, no server).
//
// COD-463: while a remote host is in ssh capture backoff the server serves the
// LOCAL wrapper's copy of the pane and flags the /terminal response with
// `remoteCaptureDegraded`. The user must be told the view may not be live, only
// for the active session, and the warning must clear once the host recovers.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const REMOTE_ID = 'remote-session-0001';
const LOCAL_ID = 'local-session-0001';

type El = { hidden: boolean; textContent: string; disabled: boolean; classList: { add(): void; remove(): void } };

function fakeElement(): El {
  return { hidden: true, textContent: '', disabled: false, classList: { add() {}, remove() {} } };
}

function loadApp(frameResponse: () => unknown) {
  const fetches: string[] = [];
  const toasts: string[] = [];
  const refreshes: unknown[] = [];
  const ids = [
    'hostWakeBanner',
    'hostWakeBannerText',
    'hostWakeBannerDetail',
    'hostWakeBannerAction',
    'remoteCaptureBanner',
    'remoteCaptureBannerText',
    'remoteCaptureBannerDetail',
    'remoteCaptureBannerAction',
  ];
  const elements = new Map<string, El>(ids.map((id) => [id, fakeElement()]));
  const CodemanApp = function CodemanApp(this: unknown) {};
  const context = vm.createContext({
    CodemanApp,
    console,
    setInterval: () => 1,
    clearInterval: () => {},
    fetch: (url: string) => {
      fetches.push(url);
      return Promise.resolve({ json: () => Promise.resolve(frameResponse()) });
    },
    document: {
      visibilityState: 'visible',
      getElementById: (id: string) => elements.get(id) ?? null,
      addEventListener: () => {},
    },
    window: {},
  });
  vm.runInContext(readFileSync(resolve(PUBLIC, 'host-wake-ui.js'), 'utf8'), context, { filename: 'host-wake-ui.js' });
  const app = new (CodemanApp as new () => Record<string, any>)();
  app.$ = (id: string) => elements.get(id) ?? null;
  app.activeSessionId = REMOTE_ID;
  app.sessions = new Map<string, { remote?: Record<string, unknown> }>([
    [REMOTE_ID, { remote: { hostId: 'ubuntu-worker', host: '192.168.20.91', label: 'ubuntu-worker' } }],
    [LOCAL_ID, {}],
  ]);
  app.showToast = (msg: string) => toasts.push(msg);
  app._onSessionNeedsRefresh = (event: unknown) => refreshes.push(event);
  return {
    app,
    fetches,
    toasts,
    refreshes,
    banner: elements.get('remoteCaptureBanner') as El,
    text: elements.get('remoteCaptureBannerText') as El,
  };
}

describe('remote capture backoff banner (COD-463)', () => {
  it('warns that the view may not be live when the active session response is flagged', () => {
    const { app, banner, text } = loadApp(() => ({}));
    app.noteRemoteCaptureState(REMOTE_ID, { remoteCaptureDegraded: true });
    expect(banner.hidden).toBe(false);
    expect(text.textContent).toBe('ubuntu-worker is not responding over ssh: this view may not be live');
  });

  it('a later unflagged response clears it', () => {
    const { app, banner } = loadApp(() => ({}));
    app.noteRemoteCaptureState(REMOTE_ID, { remoteCaptureDegraded: true });
    app.noteRemoteCaptureState(REMOTE_ID, { source: 'mux-frame' });
    expect(banner.hidden).toBe(true);
  });

  it('is shown only for the active session, and returns when switching back', () => {
    const { app, banner } = loadApp(() => ({}));
    app.noteRemoteCaptureState(REMOTE_ID, { remoteCaptureDegraded: true });
    app.activeSessionId = LOCAL_ID;
    app.refreshHostWakeBanner(LOCAL_ID);
    expect(banner.hidden).toBe(true);
    app.activeSessionId = REMOTE_ID;
    app.refreshHostWakeBanner(REMOTE_ID);
    expect(banner.hidden).toBe(false);
  });

  it('a flag for a background session does not raise the banner', () => {
    const { app, banner } = loadApp(() => ({}));
    app.activeSessionId = LOCAL_ID;
    app.noteRemoteCaptureState(REMOTE_ID, { remoteCaptureDegraded: true });
    expect(banner.hidden).toBe(true);
  });

  it('recheck: on recovery it hides the banner and reloads the session', async () => {
    const { app, banner, fetches, refreshes } = loadApp(() => ({ success: true, data: { source: 'mux-frame' } }));
    app.noteRemoteCaptureState(REMOTE_ID, { remoteCaptureDegraded: true });
    await app._remoteCaptureRecheck();
    expect(fetches).toEqual([`/api/sessions/${REMOTE_ID}/terminal?frame=1`]);
    expect(banner.hidden).toBe(true);
    expect(refreshes).toEqual([{ id: REMOTE_ID }]);
  });

  it('manual retry while still degraded keeps the banner and says so', async () => {
    const { app, banner, toasts, refreshes } = loadApp(() => ({
      success: true,
      data: { source: 'mux-frame', remoteCaptureDegraded: true },
    }));
    app.noteRemoteCaptureState(REMOTE_ID, { remoteCaptureDegraded: true });
    await app.remoteCaptureRetry();
    expect(banner.hidden).toBe(false);
    expect(toasts).toEqual(['Remote host still not responding over ssh']);
    expect(refreshes).toEqual([]);
  });

  it('the periodic recheck does nothing for a healthy session', async () => {
    const { app, fetches } = loadApp(() => ({}));
    await app._remoteCaptureRecheck();
    expect(fetches).toEqual([]);
  });

  it('the banner markup exists in index.html', () => {
    const html = readFileSync(resolve(PUBLIC, 'index.html'), 'utf8');
    for (const id of ['remoteCaptureBanner', 'remoteCaptureBannerText', 'remoteCaptureBannerAction']) {
      expect(html).toContain(`id="${id}"`);
    }
  });
});
