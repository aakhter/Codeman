/** Real Chromium visibility and click coverage for nested vertical session actions. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';

const styles = readFileSync(resolve(import.meta.dirname, '../src/web/public/styles.css'), 'utf8');

function fixture(surface: 'sidebar' | 'rail', active = false) {
  const root =
    surface === 'sidebar'
      ? 'data-session-list="sidebar" data-sidebar="expanded" data-tab-orientation="horizontal"'
      : 'data-session-list="header" data-sidebar="expanded" data-tab-orientation="vertical"';
  const hostClass = surface === 'sidebar' ? 'session-sidebar' : 'tab-rail';
  return `<!doctype html><html ${root}><head><style>${styles}</style></head><body>
    <div class="${hostClass}"><div class="session-tabs">
      <div class="session-tab${active ? ' active' : ''}" tabindex="0">
        <span class="tab-info"><span class="tab-name-row"><span class="tab-name">session</span>
          <span class="tab-actions"><button class="tab-more" type="button">…</button></span>
        </span></span>
      </div>
    </div></div>
    <script>document.querySelector('.tab-more').onclick=()=>{const m=document.createElement('div');m.className='tab-rail-action-menu';document.body.appendChild(m)}</script>
  </body></html>`;
}

async function actionState(page: Page) {
  return page.locator('.tab-more').evaluate((node) => {
    const style = getComputedStyle(node);
    return { visibility: style.visibility, pointerEvents: style.pointerEvents };
  });
}

describe('expanded vertical session actions in Chromium', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  });

  afterAll(async () => {
    await browser.close();
  });

  for (const surface of ['sidebar', 'rail'] as const) {
    it(`${surface} hides inactive actions, reveals them contextually, and opens the menu`, async () => {
      await page.setContent(fixture(surface));
      await page.mouse.move(1200, 760);
      const tab = page.locator('.session-tab');
      expect(await actionState(page)).toEqual({ visibility: 'hidden', pointerEvents: 'none' });
      await tab.hover();
      expect(await actionState(page)).toEqual({ visibility: 'visible', pointerEvents: 'auto' });
      await page.locator('.tab-more').click();
      expect(await page.locator('.tab-rail-action-menu').count()).toBe(1);

      await page.setContent(fixture(surface));
      await page.locator('.session-tab').focus();
      expect(await actionState(page)).toEqual({ visibility: 'visible', pointerEvents: 'auto' });

      await page.setContent(fixture(surface, true));
      expect(await actionState(page)).toEqual({ visibility: 'visible', pointerEvents: 'auto' });
    });
  }

  it('keeps nested actions reachable for a coarse pointer', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
    try {
      const touchPage = await context.newPage();
      for (const surface of ['sidebar', 'rail'] as const) {
        await touchPage.setContent(fixture(surface));
        expect(await actionState(touchPage)).toEqual({ visibility: 'visible', pointerEvents: 'auto' });
      }
    } finally {
      await context.close();
    }
  });
});
