/**
 * @fileoverview F2 renames the active tab (COD-450).
 *
 * The Rename Tab shortcut (COD-193) is bound to a bare F2, but the document
 * capture handler returned early on any keydown without Ctrl/Cmd/Alt, so F2
 * never reached the registry and nothing happened. Function keys are now the
 * one modifier-less class the dispatcher considers: typing never produces them,
 * so they cannot steal text. A focused text field keeps its own F-keys, the
 * terminal does not count as one, and xterm must not also write F2's escape
 * sequence into the PTY.
 *
 * Real code under test: constants.js + app.js (DEFAULT_SHORTCUTS,
 * getShortcutRegistry, matchesShortcutEvent, documentShortcutFor) in a `vm`
 * context.
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const read = (f: string) => readFileSync(resolve(import.meta.dirname, `../src/web/public/${f}`), 'utf8');

type Shortcut = { id: string; action?: string };
type App = {
  documentShortcutFor(e: Record<string, unknown>): Shortcut | null;
  loadAppSettingsFromStorage: () => Record<string, unknown>;
};

function makeApp(settings: Record<string, unknown> = {}): App {
  const context = vm.createContext({
    console,
    performance,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn(),
    HTMLCanvasElement: class HTMLCanvasElement {},
    WebSocket: { OPEN: 1 },
    fetch: vi.fn(),
    document: { addEventListener: vi.fn() },
    localStorage: { length: 0, key: vi.fn(), getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    MobileDetection: {},
  });
  vm.runInContext(`${read('constants.js')}\n${read('app.js')}\nglobalThis.__CodemanApp = CodemanApp;`, context);
  const CodemanApp = (context as unknown as { __CodemanApp: { prototype: object } }).__CodemanApp;
  const app = Object.create(CodemanApp.prototype) as App;
  app.loadAppSettingsFromStorage = () => settings;
  return app;
}

const target = (tagName: string, extra: Record<string, unknown> = {}) => ({
  tagName,
  isContentEditable: false,
  classList: { contains: (c: string) => ((extra.classes as string[]) || []).includes(c) },
  ...extra,
});

const keydown = (overrides: Record<string, unknown>) => ({
  type: 'keydown',
  key: 'F2',
  code: 'F2',
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  target: target('BODY'),
  ...overrides,
});

describe('F2 renames the active tab (COD-450)', () => {
  it('a bare F2 on the page dispatches Rename Tab', () => {
    expect(makeApp().documentShortcutFor(keydown({}))?.action).toBe('renameActiveTab');
  });

  it('a bare F2 in the terminal dispatches Rename Tab', () => {
    const xtermTextarea = target('TEXTAREA', { classes: ['xterm-helper-textarea'] });
    expect(makeApp().documentShortcutFor(keydown({ target: xtermTextarea }))?.action).toBe('renameActiveTab');
  });

  it.each([
    ['an input', target('INPUT')],
    ['a textarea', target('TEXTAREA')],
    ['a select', target('SELECT')],
    ['a contenteditable', target('DIV', { isContentEditable: true })],
  ])('a bare F2 in %s is left to the field', (_name, field) => {
    expect(makeApp().documentShortcutFor(keydown({ target: field }))).toBeNull();
  });

  it('plain typing still never reaches the registry', () => {
    const app = makeApp();
    expect(app.documentShortcutFor(keydown({ key: 'k', code: 'KeyK' }))).toBeNull();
    expect(app.documentShortcutFor(keydown({ key: 'Enter', code: 'Enter' }))).toBeNull();
  });

  it('a disabled Rename Tab shortcut lets F2 through', () => {
    const app = makeApp({ shortcutOverrides: { 'rename-tab': { disabled: true } } });
    expect(app.documentShortcutFor(keydown({}))).toBeNull();
  });

  it('modified chords still dispatch as before', () => {
    expect(makeApp().documentShortcutFor(keydown({ key: 'l', code: 'KeyL', ctrlKey: true }))?.action).toBe(
      'clearTerminal'
    );
  });

  it('smart copy stays out of the document dispatcher', () => {
    expect(makeApp().documentShortcutFor(keydown({ key: 'c', code: 'KeyC', ctrlKey: true }))).toBeNull();
  });

  it('the capture handler and the xterm key handler both go through documentShortcutFor', () => {
    expect(read('app.js')).toContain('const shortcut = this.documentShortcutFor(e);');
    // Without the xterm gate F2 renames the tab AND writes ESC O Q into the PTY.
    expect(read('terminal-ui.js')).toMatch(/ev\.type === 'keydown' && this\.isFunctionKeyShortcut\?\.\(ev\)/);
  });
});
