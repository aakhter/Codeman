import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

const publicDir = join(process.cwd(), 'src/web/public');

let KeyboardHandler: any;
let MobileDetection: any;
let dom: JSDOM;

beforeAll(() => {
  const mobileHandlers = readFileSync(join(publicDir, 'mobile-handlers.js'), 'utf8');
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  const combined =
    mobileHandlers +
    '\n;globalThis.__KeyboardHandler = KeyboardHandler; globalThis.__MobileDetection = MobileDetection;';
  (0, eval)(combined);
  KeyboardHandler = (globalThis as any).__KeyboardHandler;
  MobileDetection = (globalThis as any).__MobileDetection;
});

function setElementHeight(el: HTMLElement, height: number): void {
  Object.defineProperty(el, 'offsetHeight', { configurable: true, value: height });
  el.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: height,
      width: 390,
      height,
      toJSON() {},
    }) as DOMRect;
}

describe('mobile keyboard layout', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <main class="main"></main>
      <div class="keyboard-accessory-bar visible"></div>
      <div class="toolbar"></div>
    `;
    vi.stubGlobal('innerHeight', 844);
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: {
        offsetTop: 0,
        height: 544,
        addEventListener() {},
        removeEventListener() {},
      },
    });
    MobileDetection.isSmallScreen = () => true;
    MobileDetection.isMediumScreen = () => false;
    KeyboardHandler.keyboardVisible = true;
    KeyboardHandler.initialViewportHeight = 844;
  });

  it('reserves the measured mobile toolbar and accessory stack above the keyboard', () => {
    const toolbar = document.querySelector('.toolbar') as HTMLElement;
    const accessory = document.querySelector('.keyboard-accessory-bar') as HTMLElement;
    const main = document.querySelector('.main') as HTMLElement;
    setElementHeight(toolbar, 56);
    setElementHeight(accessory, 44);

    KeyboardHandler.updateLayoutForKeyboard();

    expect(main.style.paddingBottom).toBe('100px');
  });
});
