#!/usr/bin/env node
import { chromium, devices } from 'playwright';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3002/?debugMobile=1';
const iPhone = devices['iPhone 15 Pro'];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ ...iPhone, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);

try {
  await cdp.send('Overlay.setShowFPSCounter', { show: true }).catch(() => {});
} catch {}

page.on('console', (msg) => {
  if (msg.text().includes('[mobile]')) console.log(msg.text());
});

console.log(`[repro] goto ${BASE_URL}`);
await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
await page.waitForTimeout(1500);

try {
  const res = await page.request.post(`${new URL(BASE_URL).origin}/api/quick-start`, {
    data: { mode: 'opencode', caseName: `repro-${Date.now()}` },
    headers: { 'Content-Type': 'application/json' },
  });
  console.log(`[repro] quick-start status=${res.status()}`);
  const body = await res.text();
  console.log(`[repro] quick-start body=${body.slice(0, 500)}`);
} catch (e) {
  console.log(`[repro] quick-start failed: ${e.message} (server may not be running)`);
}

await page.waitForTimeout(1000);

const metrics = await page.evaluate(() => {
  const vv = window.visualViewport;
  return {
    innerHeight: window.innerHeight,
    vvHeight: vv?.height,
    vvScale: vv?.scale,
    appHeight: getComputedStyle(document.documentElement).getPropertyValue('--app-height'),
    headerH: document.querySelector('.header')?.getBoundingClientRect().height,
    toolbarH: document.querySelector('.toolbar')?.getBoundingClientRect().height,
    termH: document.querySelector('.terminal-container')?.getBoundingClientRect().height,
    mainH: document.querySelector('.main')?.getBoundingClientRect().height,
  };
});
console.log('[repro] metrics', JSON.stringify(metrics, null, 2));

const termBottom = await page.evaluate(() => {
  const el = document.querySelector('.terminal-container');
  return el ? el.getBoundingClientRect().bottom : null;
});
const viewportH = metrics.vvHeight || metrics.innerHeight;
if (termBottom != null) {
  const clipped = termBottom > viewportH + 1;
  console.log(`[repro] terminal bottom=${termBottom} viewport=${viewportH} clipped=${clipped}`);
  if (clipped) console.log('[repro] FAIL: terminal clipped behind toolbar');
  else console.log('[repro] PASS: terminal fills viewport');
}

await page.screenshot({ path: 'repro-opencode-mobile.png', fullPage: false }).catch(() => {});
console.log('[repro] done — check --app-height, scroll jank via Performance panel');

await browser.close();
