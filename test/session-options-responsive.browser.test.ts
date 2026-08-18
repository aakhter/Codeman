/**
 * @fileoverview Real-browser responsive layout coverage for COD-326 Session Options.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const html = readFileSync(resolve(publicDir, 'index.html'), 'utf8');
const styles = readFileSync(resolve(publicDir, 'styles.css'), 'utf8');
const mobileStyles = readFileSync(resolve(publicDir, 'mobile.css'), 'utf8');

function sessionOptionsMarkup(): string {
  const start = html.indexOf('<div class="modal" id="sessionOptionsModal">');
  const end = html.indexOf('<!-- Close Session Confirmation Modal -->', start);
  if (start < 0 || end < 0) throw new Error('Session Options markup not found');
  return html.slice(start, end);
}

describe('COD-326 Session Options responsive layout in Chromium', () => {
  let browser: Browser | undefined;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser?.close();
  });

  async function renderAt(width: number) {
    await page.setViewportSize({ width, height: 1000 });
    await page.setContent(`
      <!doctype html>
      <html>
        <head>
          <style>${styles}</style>
          <style>@media (max-width: 1023px) { ${mobileStyles} }</style>
        </head>
        <body>${sessionOptionsMarkup()}</body>
      </html>
    `);
    await page.evaluate(() => {
      document.getElementById('sessionOptionsModal')!.classList.add('active');
      document
        .querySelectorAll('#sessionOptionsModal .set-section')
        .forEach((section) => section.classList.add('hidden'));
      document.getElementById('context-tab')!.classList.remove('hidden');
    });
  }

  async function metrics() {
    return page.evaluate(() => {
      const modal = document.querySelector<HTMLElement>('#sessionOptionsModal .modal-content')!;
      const doc = document.getElementById('sessionOptionsDoc')!;
      const panel = document.getElementById('context-tab')!;
      const header = panel.querySelector<HTMLElement>(':scope > .set-section-head')!;
      const blurb = panel.querySelector<HTMLElement>(':scope > .set-section-blurb')!;
      const overflowing = [panel, ...panel.querySelectorAll<HTMLElement>('*')]
        .filter((element) => element.scrollWidth > element.clientWidth + 1)
        .map((element) => element.id || element.className || element.tagName);
      return {
        modalWidth: modal.getBoundingClientRect().width,
        docClientWidth: doc.clientWidth,
        docScrollWidth: doc.scrollWidth,
        panelClientWidth: panel.clientWidth,
        panelScrollWidth: panel.scrollWidth,
        tracks: getComputedStyle(panel)
          .gridTemplateColumns.split(' ')
          .map((track) => Number.parseFloat(track)),
        headerGridColumn: getComputedStyle(header).gridColumn,
        blurbGridColumn: getComputedStyle(blurb).gridColumn,
        overflowing,
      };
    });
  }

  it('uses one fitting column at the reported tablet-width desktop viewport', async () => {
    await renderAt(974);
    const layout = await metrics();

    expect(layout.tracks).toHaveLength(1);
    expect(layout.docScrollWidth).toBe(layout.docClientWidth);
    expect(layout.panelScrollWidth).toBe(layout.panelClientWidth);
    expect(layout.overflowing).toEqual([]);
  });

  it('uses two fitting columns with a full-width introduction on wide screens', async () => {
    await renderAt(1440);
    const layout = await metrics();

    expect(layout.modalWidth).toBeGreaterThan(1000);
    expect(layout.tracks).toHaveLength(2);
    expect(Math.abs(layout.tracks[0] - layout.tracks[1])).toBeLessThan(2);
    expect(layout.headerGridColumn).toBe('1 / -1');
    expect(layout.blurbGridColumn).toBe('1 / -1');
    expect(layout.panelScrollWidth).toBe(layout.panelClientWidth);
    expect(layout.overflowing).toEqual([]);
  });
});
