import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const handlers = fs.readFileSync(path.resolve('src/web/public/mobile-handlers.js'), 'utf8');
const terminalUi = fs.readFileSync(path.resolve('src/web/public/terminal-ui.js'), 'utf8');
const stylesCss = fs.readFileSync(path.resolve('src/web/public/styles.css'), 'utf8');
const mobileCss = fs.readFileSync(path.resolve('src/web/public/mobile.css'), 'utf8');

describe('COD-284 iPhone opencode keyboard corruption fix', () => {
  it('canvas uses paint not strict containment', () => {
    expect(stylesCss).toMatch(/\.terminal-container\s+canvas\s*\{[^}]*contain:\s*paint/s);
    expect(stylesCss).not.toMatch(/\.terminal-container\s+canvas\s*\{[^}]*contain:\s*strict/s);
  });

  it('scrolling will-change stays auto (no transform promotion)', () => {
    expect(stylesCss).toMatch(/\.touch-device\s+\.terminal-container\.scrolling[^}]*will-change:\s*auto/s);
  });

  it('mobile terminal overflow is hidden (not visible bleed)', () => {
    // phone breakpoint now hidden to prevent canvas bleed
    expect(mobileCss).toMatch(/\.terminal-container\s*\{[^}]*overflow:\s*hidden/s);
    expect(mobileCss).not.toMatch(/\.terminal-container\s*\{[^}]*overflow:\s*visible[^}]*\}/s);
  });

  it('terminal resize uses RAF immediate fit + 300ms PTY debounce', () => {
    expect(terminalUi).toContain('scheduleImmediateFit');
    expect(terminalUi).toContain('requestAnimationFrame');
    expect(terminalUi).toMatch(/_resizeRaf/);
    expect(terminalUi).toMatch(/_resizeTimeout/);
    expect(terminalUi).toContain('300');
    // immediate fit does refresh on iOS/opencode to clear black bars
    expect(terminalUi).toMatch(/needsRefresh|terminal\.refresh/);
  });

  it('mobile Safari initial fit does double-rAF + refresh', () => {
    expect(terminalUi).toMatch(/isMobileSafari[\s\S]*?requestAnimationFrame[\s\S]*?fitAddon\.fit[\s\S]*?refresh/s);
  });

  it('onKeyboardShow/Hide uses settled double-rAF + geometry sync + refresh (COD-284)', () => {
    expect(handlers).toMatch(/onKeyboardShow[\s\S]*?requestAnimationFrame[\s\S]*?syncTerminalGeometry[\s\S]*?refresh/s);
    expect(handlers).toMatch(/onKeyboardHide[\s\S]*?requestAnimationFrame[\s\S]*?syncTerminalGeometry[\s\S]*?refresh/s);
    expect(handlers).toContain('COD-284');
  });

  it('_shrinkPaddingToFit does not inflate container paddingBottom', () => {
    // old code set container.style.paddingBottom = `${gap}px` — removed in COD-284
    expect(handlers).not.toMatch(/container\.style\.paddingBottom\s*=\s*`?\$\{gap\}/);
    expect(handlers).toMatch(/_shrinkPaddingToFit[\s\S]*?COD-284/);
  });

  it('keyboard viewport handling syncs --app-height via MobileDetection', () => {
    expect(handlers).toMatch(/MobileDetection\.updateAppHeight/);
  });

  it('touch scrolling is dynamic per session (COD-284b)', () => {
    expect(terminalUi).toMatch(/getIsOpencodeMobile/);
    expect(terminalUi).toContain('_syncTerminalTouchAction');
    expect(terminalUi).toMatch(/getThreshold/);
    expect(mobileCss).toContain(".touch-device .terminal-container[style*='pan-y']");
    expect(terminalUi).toMatch(/syncTouchAction\(\)/);
  });

  it('tab-switch does fit+refresh+touch sync (COD-284b)', () => {
    const appJs = fs.readFileSync(path.resolve('src/web/public/app.js'), 'utf8');
    expect(appJs).toMatch(/selectSession[\s\S]*?fitAddon\.fit[\s\S]*?refresh/);
    expect(appJs).toContain('_syncTerminalTouchAction');
  });
});
