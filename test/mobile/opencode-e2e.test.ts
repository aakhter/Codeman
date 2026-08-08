import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import type { WebServer } from '../../src/web/server.js';
import { createTestServer, stopTestServer } from './helpers/server.js';
import { createDevicePage, closeAllBrowsers } from './helpers/browser.js';
import { PORTS, SELECTORS, WAIT } from './helpers/constants.js';
import { DEVICE_REGISTRY } from './devices.js';

const PORT = PORTS.OPENCODE_E2E;
const BASE_URL = `http://localhost:${PORT}`;
let server: WebServer;
const iPhone = DEVICE_REGISTRY.find((d) => d.name === 'iPhone 15 Pro')!;

describe('opencode e2e iPhone opencode viewport+scroll', () => {
  beforeAll(async () => {
    server = await createTestServer(PORT);
  });
  afterAll(async () => {
    await closeAllBrowsers();
    await stopTestServer(server);
  });

  it('viewport not clipped: terminal visible inside --app-height bounds on iPhone 15 Pro', async () => {
    const { context, page } = await createDevicePage(iPhone, BASE_URL, 'chromium');
    try {
      await page.waitForTimeout(WAIT.PAGE_SETTLE);
      const r = await page.evaluate(() => {
        const term = document.querySelector('.terminal-container') as HTMLElement | null;
        const toolbar = document.querySelector('.toolbar') as HTMLElement | null;
        const main = document.querySelector('.main') as HTMLElement | null;
        const appH = getComputedStyle(document.documentElement).getPropertyValue('--app-height');
        const termRect = term?.getBoundingClientRect() ?? null;
        const toolbarRect = toolbar?.getBoundingClientRect() ?? null;
        const mainStyle = main ? getComputedStyle(main) : null;
        return {
          viewportH: window.innerHeight,
          appHeight: appH.trim(),
          termBottom: termRect?.bottom ?? -1,
          toolbarTop: toolbarRect?.top ?? -1,
          mainMinHeight: mainStyle?.minHeight ?? '',
          termDisplay: term ? getComputedStyle(term).display : '',
          clipped: termRect && toolbarRect ? termRect.bottom > toolbarRect.top + 2 : null,
        };
      });
      expect(r.termDisplay).not.toBe('none');
      expect(r.clipped).toBe(false);
      expect(r.viewportH).toBeGreaterThan(500);
      expect(fs.readFileSync(path.resolve('src/web/public/mobile.css'), 'utf8')).toContain(
        'min-height: calc(var(--app-height, 100dvh)'
      );
    } finally {
      await context.close();
    }
  });

  it('scroll: pan-y + rAF path allows opencode scroll without native clip', async () => {
    const { context, page } = await createDevicePage(iPhone, BASE_URL, 'chromium');
    try {
      await page.waitForTimeout(WAIT.PAGE_SETTLE);
      const r = await page.evaluate(() => {
        const term = document.querySelector('.terminal-container') as HTMLElement | null;
        const touchAction = term ? getComputedStyle(term).touchAction : '';
        const overflow = term ? getComputedStyle(term).overflowY : '';
        return { touchAction, overflow };
      });
      expect(r.touchAction).toMatch(/pan-y|none/);
      const css = fs.readFileSync(path.resolve('src/web/public/terminal-ui.js'), 'utf8');
      expect(css).toContain("touchAction = 'pan-y'");
      expect(css).toMatch(/isOpencodeMobile\s*\?\s*8/);
      expect(css).toContain('requestAnimationFrame');
      expect(css).toMatch(/classList\.add\('scrolling'\)/);
    } finally {
      await context.close();
    }
  });

  it('batch SGR static: opencode wheel batched within 16ms', () => {
    const code = fs.readFileSync(path.resolve('src/web/public/terminal-ui.js'), 'utf8');
    expect(code).toMatch(/wheelRaf|wheelDelta/);
    expect(code).toMatch(/requestAnimationFrame.*wheelDelta|wheelDelta.*requestAnimationFrame/s);
  });

  it('no clip FPS >55: rAF sustains frame budget on iPhone viewport', async () => {
    const { context, page } = await createDevicePage(iPhone, BASE_URL, 'chromium');
    try {
      await page.waitForTimeout(800);
      const fps = await page.evaluate(() => {
        return new Promise<number>((resolve) => {
          let frames = 0;
          const start = performance.now();
          function tick() {
            frames += 1;
            if (performance.now() - start < 500) requestAnimationFrame(tick);
            else resolve((frames * 1000) / (performance.now() - start));
          }
          requestAnimationFrame(tick);
        });
      });
      expect(fps).toBeGreaterThan(55);
    } finally {
      await context.close();
    }
  });

  it('static viewport fix artefacts present (dvh + --app-height fallback)', () => {
    const mobileCss = fs.readFileSync(path.resolve('src/web/public/mobile.css'), 'utf8');
    const stylesCss = fs.readFileSync(path.resolve('src/web/public/styles.css'), 'utf8');
    const handlers = fs.readFileSync(path.resolve('src/web/public/mobile-handlers.js'), 'utf8');
    expect(mobileCss).toContain('max(0px, 100dvh - var(--app-height)');
    expect(mobileCss).toContain('min-height: calc(var(--app-height, 100dvh)');
    expect(stylesCss).toContain('height: var(--app-height, 100dvh)');
    expect(handlers).not.toMatch(/updateAppHeight\(\)[^}]*keyboardVisible.*return/s);
  });
});
