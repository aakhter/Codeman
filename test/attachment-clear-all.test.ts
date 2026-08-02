// @vitest-environment jsdom
/**
 * COD-76 — "Clear all" control for the attachment card stack.
 *
 * Attachment cards (detected docs/images) pile up in `#attachmentCardStack` and can previously
 * only be dismissed one-at-a-time via each card's `×`. This suite drives the SHIPPING
 * panels-ui.js attachment-card methods under jsdom and asserts the new bulk-clear affordance:
 *
 *   - a "Clear all" control that is present only when >= 2 cards are on the stack
 *     (absent at 0 and 1 card),
 *   - clicking it (or calling `closeAllAttachmentCards()`) removes every card, empties
 *     `this.attachmentCards`, and tears down the `#attachmentCardStack` container,
 *   - the per-card `×` (`closeAttachmentCard`) still removes exactly one card,
 *   - the existing per-session bulk close (`closeSessionAttachmentCards`) is untouched.
 *
 * The real methods are mixed into `CodemanApp.prototype` via `Object.assign` in panels-ui.js.
 * We eval the shipping file into the jsdom window against a minimal `CodemanApp` stub +
 * `escapeHtml` global, then construct a tiny host with just the state these methods touch.
 * No port / server needed; pure DOM logic in jsdom.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const publicDir = join(process.cwd(), 'src/web/public');

interface AttachmentHost {
  attachmentCards: Map<string, { element: HTMLElement; sessionId: string; filePath: string }>;
  attachmentCardStack: HTMLElement | null;
  sessions: Map<string, { name?: string }>;
  formatFileSize(n: number): string;
  ensureAttachmentCardStack(): HTMLElement;
  addAttachmentCard(event: Record<string, unknown>): void;
  closeAttachmentCard(id: string): void;
  closeAllAttachmentCards(): void;
  closeSessionAttachmentCards(sessionId: string): void;
  _refreshAttachmentClearAll(): void;
  openFilePreview(...args: unknown[]): void;
  openAttachmentInNewTab(...args: unknown[]): void;
}

/** Eval the shipping panels-ui.js into the jsdom window and return its mixed-in methods. */
function loadAttachmentMethods(): Record<string, (...args: unknown[]) => unknown> {
  const win = window as unknown as Record<string, unknown>;
  // panels-ui.js does `Object.assign(CodemanApp.prototype, {...})` at module-eval; provide a stub.
  function CodemanApp(this: unknown) {}
  win.CodemanApp = CodemanApp;
  // constants.js provides escapeHtml in the browser; provide an equivalent.
  win.escapeHtml = (s: unknown) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  const src = readFileSync(join(publicDir, 'panels-ui.js'), 'utf8');
  (0, eval)(src);
  return (CodemanApp as unknown as { prototype: Record<string, (...args: unknown[]) => unknown> }).prototype;
}

function makeHost(methods: Record<string, (...args: unknown[]) => unknown>): AttachmentHost {
  const host = {
    attachmentCards: new Map(),
    attachmentCardStack: null,
    sessions: new Map([['sess-1', { name: 'Session One' }]]),
    formatFileSize: (n: number) => `${n}B`,
    openFilePreview: () => {},
    openAttachmentInNewTab: () => {},
  } as unknown as AttachmentHost;
  for (const name of [
    'ensureAttachmentCardStack',
    'addAttachmentCard',
    'closeAttachmentCard',
    'closeAllAttachmentCards',
    'closeSessionAttachmentCards',
    '_refreshAttachmentClearAll',
  ]) {
    if (typeof methods[name] !== 'function') throw new Error(`panels-ui.js missing method: ${name}`);
    (host as unknown as Record<string, unknown>)[name] = methods[name];
  }
  return host;
}

function addCard(host: AttachmentHost, id: string, sessionId = 'sess-1') {
  host.addAttachmentCard({
    sessionId,
    fileName: `${id}.pptx`,
    relativePath: `docs/${id}.pptx`,
    timestamp: Date.now(),
    size: 1234,
    attachmentType: 'document',
    extension: 'pptx',
    attachmentId: id,
  });
}

/** The clear-all control: a marker class on the stack so we can find it regardless of header/footer. */
function clearAllControl(): HTMLElement | null {
  return document.querySelector('#attachmentCardStack .attachment-clear-all');
}

let methods: Record<string, (...args: unknown[]) => unknown>;

beforeAll(() => {
  methods = loadAttachmentMethods();
});

describe('COD-76 attachment "Clear all" control', () => {
  it('is absent at 0 cards and at exactly 1 card', () => {
    document.body.innerHTML = '';
    const host = makeHost(methods);

    expect(clearAllControl()).toBeNull();

    addCard(host, 'a');
    expect(host.attachmentCards.size).toBe(1);
    const control1 = clearAllControl();
    // Either not rendered, or rendered-but-hidden — assert it is not visibly active.
    if (control1) {
      expect(control1.hidden || control1.classList.contains('hidden')).toBe(true);
    } else {
      expect(control1).toBeNull();
    }
  });

  it('becomes present/visible on the 2nd card and hides again when dropping back to 1', () => {
    document.body.innerHTML = '';
    const host = makeHost(methods);

    addCard(host, 'a');
    addCard(host, 'b');
    expect(host.attachmentCards.size).toBe(2);
    const control = clearAllControl();
    expect(control).not.toBeNull();
    expect(control!.hidden).toBe(false);
    expect(control!.classList.contains('hidden')).toBe(false);

    // Drop back to a single card — the control must hide/disappear.
    host.closeAttachmentCard('b');
    expect(host.attachmentCards.size).toBe(1);
    const after = clearAllControl();
    if (after) {
      expect(after.hidden || after.classList.contains('hidden')).toBe(true);
    } else {
      expect(after).toBeNull();
    }
  });

  it('keeps the single visible control first while attachment cards stay newest-first', () => {
    document.body.innerHTML = '';
    const host = makeHost(methods);

    addCard(host, 'a');
    addCard(host, 'b');
    addCard(host, 'c');

    const stack = host.attachmentCardStack!;
    const controls = stack.querySelectorAll('.attachment-clear-all:not([hidden])');
    expect(controls).toHaveLength(1);
    expect(stack.firstElementChild).toBe(controls[0]);
    expect(Array.from(stack.querySelectorAll('.attachment-card')).map((card) => card.dataset.attachmentId)).toEqual([
      'c',
      'b',
      'a',
    ]);
  });

  it('closeAllAttachmentCards() empties the map and tears down the stack container (no leaked nodes)', () => {
    document.body.innerHTML = '';
    const host = makeHost(methods);

    addCard(host, 'a');
    addCard(host, 'b');
    addCard(host, 'c');
    expect(host.attachmentCards.size).toBe(3);
    expect(document.getElementById('attachmentCardStack')).not.toBeNull();

    host.closeAllAttachmentCards();

    expect(host.attachmentCards.size).toBe(0);
    expect(host.attachmentCardStack).toBeNull();
    expect(document.getElementById('attachmentCardStack')).toBeNull();
    // No orphaned cards left anywhere in the document.
    expect(document.querySelectorAll('.attachment-card').length).toBe(0);
  });

  it('clicking the rendered "Clear all" control invokes the bulk clear', () => {
    document.body.innerHTML = '';
    const host = makeHost(methods);

    addCard(host, 'a');
    addCard(host, 'b');
    const control = clearAllControl();
    expect(control).not.toBeNull();

    control!.click();

    expect(host.attachmentCards.size).toBe(0);
    expect(document.getElementById('attachmentCardStack')).toBeNull();
  });

  it('the per-card × (closeAttachmentCard) still removes exactly one card', () => {
    document.body.innerHTML = '';
    const host = makeHost(methods);

    addCard(host, 'a');
    addCard(host, 'b');
    addCard(host, 'c');
    expect(host.attachmentCards.size).toBe(3);

    host.closeAttachmentCard('b');

    expect(host.attachmentCards.size).toBe(2);
    expect(host.attachmentCards.has('a')).toBe(true);
    expect(host.attachmentCards.has('b')).toBe(false);
    expect(host.attachmentCards.has('c')).toBe(true);
    expect(document.querySelectorAll('.attachment-card').length).toBe(2);
    // Two cards remain, so the clear-all control is still present/visible.
    expect(clearAllControl()).not.toBeNull();
    expect(clearAllControl()!.hidden).toBe(false);
  });

  it('per-session bulk close (closeSessionAttachmentCards) remains intact', () => {
    document.body.innerHTML = '';
    const host = makeHost(methods);
    host.sessions.set('sess-2', { name: 'Session Two' });

    addCard(host, 'a', 'sess-1');
    addCard(host, 'b', 'sess-1');
    addCard(host, 'c', 'sess-2');
    expect(host.attachmentCards.size).toBe(3);

    host.closeSessionAttachmentCards('sess-1');

    expect(host.attachmentCards.size).toBe(1);
    expect(host.attachmentCards.has('c')).toBe(true);
    // Only one card left → clear-all hidden/absent.
    const control = clearAllControl();
    if (control) expect(control.hidden || control.classList.contains('hidden')).toBe(true);
  });
});
