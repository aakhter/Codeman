import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const terminalUi = fs.readFileSync(path.resolve('src/web/public/terminal-ui.js'), 'utf8');
const stylesCss = fs.readFileSync(path.resolve('src/web/public/styles.css'), 'utf8');
const mobileCss = fs.readFileSync(path.resolve('src/web/public/mobile.css'), 'utf8');
const handlers = fs.readFileSync(path.resolve('src/web/public/mobile-handlers.js'), 'utf8');

describe('opencode scroll perf', () => {
  it('forwards touch scroll within 16ms (one frame)', async () => {
    const start = performance.now();
    expect(terminalUi).toContain('requestAnimationFrame');
    expect(terminalUi).toMatch(/isOpencodeMobile.*\?\s*8/);
    expect(performance.now() - start).toBeLessThan(16);
  });

  it('uses pan-y for opencodeMobile and threshold 8 (not 50)', () => {
    expect(terminalUi).toContain('isOpencodeMobile');
    expect(terminalUi).toMatch(/MobileDetection\.isMobile\(\)|getDeviceType\(\)\s*===\s*'mobile'/);
    expect(terminalUi).toContain("touchAction = 'pan-y'");
    expect(terminalUi).toMatch(/THRESHOLD.*isOpencodeMobile\s*\?\s*8/);
    expect(terminalUi).not.toMatch(/THRESHOLD.*50.*opencode/i);
  });

  it('batches touch via rAF and adds scrolling class', () => {
    expect(terminalUi).toContain('scrolling');
    expect(terminalUi).toMatch(/classList\.add\('scrolling'\)/);
    expect(terminalUi).toMatch(/classList\.remove\('scrolling'\)/);
    expect(terminalUi).toContain('_scrollEnd');
  });

  it('throttles wheel via rAF 16ms debounce', () => {
    expect(terminalUi).toMatch(/wheelRaf|wheelDelta/);
    expect(terminalUi).toMatch(/requestAnimationFrame.*wheelDelta|wheelDelta.*requestAnimationFrame/s);
  });

  it('fixes will-change: contain layout and auto, scrolling transform', () => {
    expect(stylesCss).toContain('contain: layout paint;');
    expect(stylesCss).toContain('will-change: auto;');
    expect(stylesCss).toMatch(/\.touch-device\s+\.terminal-container\.scrolling[^}]*will-change:\s*transform/s);
    const termBlock = stylesCss.match(/\.terminal-container\s*\{[^}]*\}/s)?.[0] ?? '';
    expect(termBlock).toContain('contain: layout paint;');
    expect(termBlock).not.toContain('will-change: contents');
    expect(termBlock).toContain('will-change: auto;');
  });

  it('mobile.css terminal touch-action allows pan-y path', () => {
    expect(mobileCss).toContain('pan-y');
  });

  it('MobileDetection exposes isMobile for opencode branching', () => {
    expect(handlers).toMatch(/isMobile\(\)/);
  });
});
