// @vitest-environment jsdom
/**
 * @fileoverview COD-367: menu-button state and predictable Tab dismissal for the
 * vertical session rail's overflow menu.
 *
 * The trigger already had an accessible name and moved focus into a `role="menu"`,
 * but exposed no menu-button state, so assistive technology could not tell it was
 * a menu button or whether the popup was open. Tab from inside the menu also left
 * the popup on screen.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const appJs = readFileSync(resolve(PUBLIC, 'app.js'), 'utf8');

interface RailHost {
  openTabRailActionMenu: (event: unknown, sessionId: string) => void;
  closeTabRailActionMenu: (options?: { restoreFocus?: boolean }) => void;
  [key: string]: unknown;
}

function makeHost(): { host: RailHost; trigger: HTMLButtonElement } {
  class CodemanApp {}
  (globalThis as unknown as { CodemanApp: unknown }).CodemanApp = CodemanApp;
  const source = readFileSync(resolve(PUBLIC, 'tab-rail-resize.js'), 'utf8');
  // eslint-disable-next-line no-eval
  (0, eval)(source);

  document.body.innerHTML = `
    <div id="sessionTabs"></div>
    <button id="before">before</button>
    <button type="button" class="tab-more" aria-haspopup="menu" aria-expanded="false" aria-label="Session actions">…</button>
    <button id="after">after</button>`;
  const trigger = document.querySelector('.tab-more') as HTMLButtonElement;

  const host = Object.create(CodemanApp.prototype) as RailHost;
  Object.assign(host, {
    sessions: new Map([['s1', { id: 's1', name: 'One', mode: 'claude' }]]),
    tabLayout: { version: 1, groups: [], ungrouped: [{ kind: 'session', id: 's1' }] },
    activeSessionId: 's1',
    detachedSessions: new Set(),
    loadAppSettingsFromStorage: () => ({ showTabDetachButton: false }),
    openSessionOptions: vi.fn(),
    requestCloseSession: vi.fn(),
    detachSession: vi.fn(),
    moveTabRefToGroup: vi.fn(),
    // The real one always returns an action object; returning null here made
    // the menu builder throw before it rendered anything.
    _tabRefFocusAction: () => ({ label: 'Add to Focus', run: vi.fn() }),
    _tabRefPlacementActions: () => [],
    _tabRefMoveActions: () => [{ label: 'Move to Ungrouped', groupId: null, index: 0 }],
  });
  return { host, trigger };
}

function openMenu(host: RailHost, trigger: HTMLButtonElement): HTMLElement {
  host.openTabRailActionMenu({ preventDefault() {}, stopPropagation() {}, currentTarget: trigger }, 's1');
  return document.querySelector('.tab-rail-action-menu') as HTMLElement;
}

describe('COD-367 overflow menu ARIA state and Tab dismissal', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('marks the trigger as a menu button in the rendered markup', () => {
    // Static markup, so assistive technology sees it before any interaction.
    const railTrigger = appJs.slice(appJs.indexOf('class="tab-more"'), appJs.indexOf('class="tab-more"') + 400);
    expect(railTrigger).toContain('aria-haspopup="menu"');
    expect(railTrigger).toContain('aria-expanded="false"');
  });

  it('sets aria-expanded true only while the menu is open', () => {
    const { host, trigger } = makeHost();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    openMenu(host, trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    host.closeTabRailActionMenu();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('Tab dismisses the popup and leaves focus on the trigger, not on nothing', () => {
    const { host, trigger } = makeHost();
    const menu = openMenu(host, trigger);

    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    menu.dispatchEvent(event);

    expect(document.querySelector('.tab-rail-action-menu')).toBeNull();
    expect(event.defaultPrevented).toBe(true);
    // "without trapping or losing keyboard focus": the trigger is a predictable,
    // still-present landing spot, and Tab from there continues normally.
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('Shift+Tab dismisses it the same way', () => {
    const { host, trigger } = makeHost();
    const menu = openMenu(host, trigger);

    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));

    expect(document.querySelector('.tab-rail-action-menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes when focus leaves the menu entirely', () => {
    const { host, trigger } = makeHost();
    const menu = openMenu(host, trigger);
    const after = document.getElementById('after') as HTMLButtonElement;

    menu.dispatchEvent(new FocusEvent('focusout', { relatedTarget: after, bubbles: true }));

    expect(document.querySelector('.tab-rail-action-menu')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('does NOT close while focus moves between its own items', () => {
    // Arrow-key navigation fires focusout on every hop; closing there would make
    // the menu unusable by keyboard, which is the opposite of the fix.
    const { host, trigger } = makeHost();
    const menu = openMenu(host, trigger);
    const buttons = [...menu.querySelectorAll('button')];
    expect(buttons.length).toBeGreaterThan(1);

    menu.dispatchEvent(new FocusEvent('focusout', { relatedTarget: buttons[1], bubbles: true }));

    expect(document.querySelector('.tab-rail-action-menu')).not.toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps Escape and arrow-key behaviour working', () => {
    const { host, trigger } = makeHost();
    const menu = openMenu(host, trigger);
    const buttons = [...menu.querySelectorAll('button')];

    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    expect(buttons).toContain(document.activeElement);

    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(document.querySelector('.tab-rail-action-menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
