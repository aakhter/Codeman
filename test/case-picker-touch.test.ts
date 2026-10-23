/**
 * @fileoverview COD-527: a touch tap on the toolbar Case picker must not focus its text box.
 *
 * The picker's opener is a text input (`#quickStartCaseSearch`). Focusing it ran
 * `input.select()`, which on Android raised the floating text-selection menu
 * (Copy / Web search), and on every touch device KeyboardHandler's focusin
 * handler then called `scrollInputIntoView()`, which centred the bottom-toolbar
 * box and shifted the whole screen up until the box lost focus. A touch tap now
 * opens (or closes) the list without focusing the box; mouse and keyboard keep
 * the focus-and-select behavior so desktop users can still type to filter.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadPicker() {
  const listeners: Record<string, (event: any) => void> = {};
  const elements: Record<string, any> = {
    quickStartCase: { value: 'Alpha', dataset: {} },
    quickStartCaseSearch: {
      value: 'Alpha',
      dataset: {},
      setAttribute: vi.fn(),
      removeAttribute: vi.fn(),
      addEventListener: vi.fn((event: string, handler: (event: any) => void) => {
        listeners[event] = handler;
      }),
      select: vi.fn(),
      focus: vi.fn(),
      blur: vi.fn(),
    },
    quickStartCaseList: {
      innerHTML: '',
      classList: { add: vi.fn(), remove: vi.fn() },
      addEventListener: vi.fn(),
    },
    quickStartCasePicker: { contains: () => true },
  };
  const CodemanApp = function CodemanApp(this: any) {};
  const context = vm.createContext({
    CodemanApp,
    localStorage: { getItem: () => null, setItem: () => {} },
    document: { getElementById: (id: string) => elements[id] ?? null, addEventListener: vi.fn() },
    console,
    escapeHtml: (s: string) => s,
    setInterval: () => 1,
    clearInterval: () => {},
    fetch: () => new Promise(() => {}),
  });
  const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
  vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });
  const app = new (CodemanApp as any)();
  app.cases = [{ name: 'Alpha' }, { name: 'zeta' }];
  app.setupQuickStartCasePicker();
  return { app, listeners, input: elements.quickStartCaseSearch };
}

const pointer = (pointerType: string) => ({ pointerType, button: 0, preventDefault: vi.fn() });

describe('COD-527 case picker on touch', () => {
  it('opens the list on a touch tap without focusing or selecting the text box', () => {
    const { app, listeners, input } = loadPicker();
    const down = pointer('touch');
    listeners.pointerdown(down);
    // preventDefault on pointerdown is what stops the tap from focusing the box.
    expect(down.preventDefault).toHaveBeenCalled();
    expect(app._casePickerOpen).toBe(true);
    // The click that follows the tap must not select the text either.
    listeners.click(pointer('touch'));
    expect(input.select).not.toHaveBeenCalled();
    expect(input.focus).not.toHaveBeenCalled();
    expect(app._casePickerOpen).toBe(true);
  });

  it('closes the open list on a second touch tap', () => {
    const { app, listeners } = loadPicker();
    listeners.pointerdown(pointer('touch'));
    listeners.click(pointer('touch'));
    expect(app._casePickerOpen).toBe(true);
    listeners.pointerdown(pointer('touch'));
    listeners.click(pointer('touch'));
    expect(app._casePickerOpen).toBe(false);
  });

  it('keeps the focus-and-select behavior for a mouse', () => {
    const { app, listeners, input } = loadPicker();
    const down = pointer('mouse');
    listeners.pointerdown(down);
    expect(down.preventDefault).not.toHaveBeenCalled();
    listeners.focus({});
    listeners.click(pointer('mouse'));
    expect(input.select).toHaveBeenCalled();
    expect(app._casePickerOpen).toBe(true);
  });
});
