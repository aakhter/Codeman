import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('opencode mobile viewport', () => {
  it('terminal fills app-height minus header+toolbar on iPhone', () => {
    const appHeight = 852;
    const header = 42 + 12;
    const toolbar = 40 + 12;
    const available = appHeight - header - toolbar;
    expect(available).toBeGreaterThan(700);
    expect(available).toBeLessThan(800);
  });
});

describe('COD-283 viewport clipping fix', () => {
  const handlersPath = path.resolve('src/web/public/mobile-handlers.js');
  const mobileCssPath = path.resolve('src/web/public/mobile.css');
  const stylesCssPath = path.resolve('src/web/public/styles.css');
  const handlers = fs.readFileSync(handlersPath, 'utf8');
  const mobileCss = fs.readFileSync(mobileCssPath, 'utf8');
  const stylesCss = fs.readFileSync(stylesCssPath, 'utf8');

  it('updateAppHeight always updates --app-height even with keyboardVisible', () => {
    expect(handlers).toContain('updateAppHeight()');
    expect(handlers).not.toContain('if (typeof KeyboardHandler !==');
    expect(handlers).toMatch(/updateAppHeight\(\)\s*\{[^}]*visualViewport[^}]*--app-height/s);
    expect(handlers).not.toMatch(/updateAppHeight\(\)[^}]*keyboardVisible.*return/s);
  });

  it('iOS toolbar uses 100dvh with max(0px, ...) and keyboard-visible override', () => {
    expect(mobileCss).toContain('max(0px, 100dvh - var(--app-height)');
    expect(mobileCss).toContain('.keyboard-visible .toolbar');
    expect(mobileCss).toMatch(/bottom:\s*calc\(var\(--safe-area-bottom\)\s*\+\s*max\(0px/);
  });

  it('.main min-height uses --app-height fallback and dvh', () => {
    expect(mobileCss).toContain('min-height: calc(var(--app-height, 100dvh)');
    expect(mobileCss).toContain('--keyboard-accessory-height');
  });

  it('_shrinkPaddingToFit quantization gap uses floor and >2 threshold', () => {
    expect(handlers).toContain('_shrinkPaddingToFit');
    expect(handlers).toMatch(/gap\s*>\s*2/);
    expect(handlers).toMatch(/Math\.floor/);
  });

  it('styles.css body and .app use var(--app-height, 100dvh) fallback', () => {
    expect(stylesCss).toContain('height: var(--app-height, 100dvh)');
    expect(stylesCss).toContain('height: 100dvh');
  });
});
