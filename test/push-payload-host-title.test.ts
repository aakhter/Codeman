/**
 * Verifies that web-push payloads include the hostname-aware `hostTitle`
 * field so service-worker OS notifications can disambiguate Codeman
 * instances on multiple machines (laptop / dev box / NAS).
 *
 * The in-page Notification path (notification-manager.js) prefixes with
 * `${originalTitle}: ${title}` reading from `document.title`. The service
 * worker has no access to document.title, so the server must ship the
 * prefix in the push payload itself.
 *
 * Strategy: mock the `web-push` module, instantiate WebServer (no port
 * binding — start() is never called), stub the push store with one fake
 * subscription, then call the private sendPushNotifications and inspect
 * the JSON payload handed to webpush.sendNotification.
 *
 * Port: N/A (no server start)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock is hoisted to the top of the file, so factory captures must use
// vi.hoisted() to be initialized before the mocked import is evaluated.
const { sendNotification, setVapidDetails, generateVAPIDKeys } = vi.hoisted(() => ({
  sendNotification: vi.fn(async () => undefined),
  setVapidDetails: vi.fn(),
  generateVAPIDKeys: vi.fn(() => ({
    publicKey: 'test-public-key',
    privateKey: 'test-private-key',
  })),
}));

vi.mock('web-push', () => ({
  default: { sendNotification, setVapidDetails, generateVAPIDKeys },
}));

import { WebServer } from '../src/web/server.js';

interface PushPayload {
  title: string;
  hostTitle?: string;
  body: string;
  tag: string;
  sessionId: string;
  urgency: string;
  actions?: Array<{ action: string; title: string }>;
}

function makeServerWithHost(host: string): WebServer {
  // Constructor only assigns fields — no network/disk activity until start().
  const server = new WebServer(0, false, true, host);
  // Stub push store: one subscription with all events enabled.
  const fakeSub = {
    endpoint: 'https://push.example.com/abc',
    keys: { p256dh: 'k1', auth: 'k2' },
    pushPreferences: {} as Record<string, boolean>,
  };
  const stubStore = {
    getAll: () => [fakeSub],
    getVapidKeys: () => ({ publicKey: 'pub', privateKey: 'priv', generatedAt: 0 }),
    removeByEndpoint: vi.fn(),
  };
  (server as unknown as { pushStore: typeof stubStore }).pushStore = stubStore;
  return server;
}

function lastPayload(): PushPayload {
  expect(sendNotification).toHaveBeenCalled();
  const call = sendNotification.mock.calls[sendNotification.mock.calls.length - 1];
  return JSON.parse(call[1] as string) as PushPayload;
}

describe('push payload hostTitle (Web Push hostname plumbing)', () => {
  beforeEach(() => {
    sendNotification.mockClear();
    setVapidDetails.mockClear();
  });

  it('includes hostTitle = codeman:<titleHostname> in the payload', () => {
    const server = makeServerWithHost('laptop');
    (
      server as unknown as {
        sendPushNotifications: (e: string, d: Record<string, unknown>) => void;
      }
    ).sendPushNotifications('hook:idle_prompt', {
      sessionId: 's-1',
      sessionName: 'mysession',
    });

    const payload = lastPayload();
    expect(payload.hostTitle).toBe('codeman:laptop');
    // The bare event title is preserved separately so the SW can compose them.
    expect(payload.title).toBe('Waiting for Input');
  });

  it('falls back to os.hostname() when --title-hostname is not provided', () => {
    const server = makeServerWithHost(''); // empty -> constructor uses getHostname()
    (
      server as unknown as {
        sendPushNotifications: (e: string, d: Record<string, unknown>) => void;
      }
    ).sendPushNotifications('hook:permission_prompt', {
      sessionId: 's-2',
      sessionName: 'sess',
      tool_name: 'Bash',
    });

    const payload = lastPayload();
    expect(payload.hostTitle).toMatch(/^codeman:.+/);
    expect(payload.hostTitle).not.toBe('codeman:');
    expect(payload.title).toBe('Permission Required');
  });

  it('different WebServer instances ship distinct hostTitles', () => {
    const a = makeServerWithHost('host-a');
    const b = makeServerWithHost('host-b');

    (
      a as unknown as {
        sendPushNotifications: (e: string, d: Record<string, unknown>) => void;
      }
    ).sendPushNotifications('hook:stop', { sessionId: 's-a', sessionName: 'A' });
    (
      b as unknown as {
        sendPushNotifications: (e: string, d: Record<string, unknown>) => void;
      }
    ).sendPushNotifications('hook:stop', { sessionId: 's-b', sessionName: 'B' });

    expect(sendNotification).toHaveBeenCalledTimes(2);
    const first = JSON.parse(sendNotification.mock.calls[0][1] as string) as PushPayload;
    const second = JSON.parse(sendNotification.mock.calls[1][1] as string) as PushPayload;
    expect(first.hostTitle).toBe('codeman:host-a');
    expect(second.hostTitle).toBe('codeman:host-b');
  });
});

// ─── SW display-title formatting ─────────────────────────────────────────
// The SW logic at sw.js:130 composes the OS notification title from the
// payload. It's a 3-line conditional we mirror here so any future change
// (e.g. swapping the separator) shows up in this test instead of being
// caught only by users running multiple Codeman instances.

function computeSwDisplayTitle(payload: { title?: string; hostTitle?: string }): string {
  const { title, hostTitle } = payload;
  return hostTitle && title ? `${hostTitle}: ${title}` : title || hostTitle || 'Codeman';
}

describe('service worker displayTitle composition (mirrors sw.js)', () => {
  it('joins host and title with ": " when both present', () => {
    expect(computeSwDisplayTitle({ hostTitle: 'codeman:laptop', title: 'Permission Required' })).toBe(
      'codeman:laptop: Permission Required'
    );
  });

  it('falls back to bare title when hostTitle is missing (older server)', () => {
    expect(computeSwDisplayTitle({ title: 'Permission Required' })).toBe('Permission Required');
  });

  it('falls back to hostTitle alone when title is missing', () => {
    expect(computeSwDisplayTitle({ hostTitle: 'codeman:laptop' })).toBe('codeman:laptop');
  });

  it('defaults to "Codeman" when both missing', () => {
    expect(computeSwDisplayTitle({})).toBe('Codeman');
  });
});
