# COD-326 Session Options Responsive Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate horizontal overflow in Session Options while retaining a useful two-column Session panel on genuinely wide windows.

**Architecture:** Keep the Session panel as a single-column CSS grid by default. At a 1200px viewport breakpoint, widen only Session Options and switch that panel to two zero-minimum tracks, with its heading and blurb spanning both columns. A shipping-markup Chromium test owns the responsive contract at the reported 974px width and at 1440px.

**Tech Stack:** Plain HTML/CSS, Vitest, Playwright Chromium.

---

## File Map

- Create `test/session-options-responsive.browser.test.ts`: real layout measurements against shipping Session Options HTML and CSS.
- Modify `test/session-options-modal-layout.test.ts`: replace the obsolete COD-88 breakpoint assertion with the approved responsive contract.
- Modify `src/web/public/styles.css`: replace the obsolete 680px two-column rule with the approved default and wide-screen layouts.
- Modify `config/vitest.ci.config.ts`: exclude the Chromium-driven regression from browser-less CI collection.

### Task 1: Capture the responsive regression in Chromium

**Files:**

- Create: `test/session-options-responsive.browser.test.ts`
- Modify: `config/vitest.ci.config.ts:59`

- [ ] **Step 1: Add the browser regression**

Create `test/session-options-responsive.browser.test.ts`:

```ts
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
```

- [ ] **Step 2: Keep browser-less CI from collecting the test**

Add this entry after `tab-focus-smart-group.browser.test.ts` in `config/vitest.ci.config.ts`:

```ts
      'test/session-options-responsive.browser.test.ts', // browser (Playwright + chromium)
```

- [ ] **Step 3: Run the test and verify RED**

Run:

```bash
npm test -- test/session-options-responsive.browser.test.ts
```

Expected: both cases fail. At 974px, the panel reports two tracks and `panelScrollWidth > panelClientWidth`. At 1440px, the modal remains 900px wide and the introduction does not span both columns.

- [ ] **Step 4: Verify the browser-test exclusion is registered**

Run:

```bash
npm run check:browser-excludes
```

Expected: PASS and all browser-driven files are excluded from the CI suite.

### Task 2: Make the Session panel responsive to usable width

**Files:**

- Modify: `src/web/public/styles.css:7945-7975`
- Modify: `src/web/public/styles.css:19176-19390`
- Modify: `test/session-options-modal-layout.test.ts:19-27`
- Test: `test/session-options-responsive.browser.test.ts`

- [ ] **Step 1: Remove the obsolete viewport-based grid block**

Delete the entire `/* COD-88 ... */` `@media (min-width: 680px)` block near line 7945. Its selectors refer partly to pre-settings-surface markup, and its `1fr 1fr` grid is the source of the content-minimum overflow.

- [ ] **Step 2: Add the default one-column contract**

Immediately after the final `#sessionOptionsModal .set-doc` rule, add:

```css
#sessionOptionsModal #context-tab {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 0.25rem 1rem;
  align-items: start;
}
```

- [ ] **Step 3: Add the genuinely-wide two-column contract**

After the Session Options sizing and control rules, add:

```css
@media (min-width: 1200px) {
  #sessionOptionsModal .modal-content.modal-lg {
    max-width: min(1120px, 96vw);
    width: min(1120px, 96vw);
  }

  #sessionOptionsModal #context-tab {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  #sessionOptionsModal #context-tab > .set-section-head,
  #sessionOptionsModal #context-tab > .set-section-blurb {
    grid-column: 1 / -1;
  }
}
```

- [ ] **Step 4: Run the browser regression and verify GREEN**

Run:

```bash
npm test -- test/session-options-responsive.browser.test.ts
```

Expected: 2 tests pass. The 974px case has one track and no overflowing descendant; the 1440px case has two equal tracks, a modal wider than 1000px, full-width introductory elements, and no overflow.

- [ ] **Step 5: Run adjacent Session Options regressions**

Before running the bundle, replace the obsolete 680px assertion in `test/session-options-modal-layout.test.ts` with:

```ts
it('uses one Context column by default and two only on genuinely wide screens', () => {
  expect(css).toMatch(/#sessionOptionsModal #context-tab\s*{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);

  const mediaIdx = css.search(/@media[^{]*min-width:\s*1200px/);
  expect(mediaIdx).toBeGreaterThan(-1);
  const after = css.slice(mediaIdx);
  expect(after).toMatch(/#sessionOptionsModal #context-tab\s*{[^}]*repeat\(2, minmax\(0, 1fr\)\)/s);
});
```

Run:

```bash
npm test -- test/session-options-modal-layout.test.ts test/session-options-structure.test.ts test/inline-rename.test.ts
```

Expected: all tests pass. `inline-rename.test.ts` requires local Chromium and confirms the modal's existing interaction path is intact.

### Task 3: Verify and commit COD-326

**Files:**

- Modify: `src/web/public/styles.css`
- Modify: `config/vitest.ci.config.ts`
- Modify: `test/session-options-modal-layout.test.ts`
- Create: `test/session-options-responsive.browser.test.ts`

- [ ] **Step 1: Run required static gates**

Run each command separately:

```bash
npm run typecheck
npm run lint
npm run format:check -- src/web/public/styles.css config/vitest.ci.config.ts test/session-options-responsive.browser.test.ts
npm run check:lockfile
npm run check:browser-excludes
npm run build
git diff --check
```

Expected: every command exits 0. The build may retain the known duplicate Chinese `Idle` translation warning; no new warning is acceptable.

- [ ] **Step 2: Review the final diff against the spec**

Run:

```bash
git diff -- src/web/public/styles.css config/vitest.ci.config.ts test/session-options-responsive.browser.test.ts
```

Confirm the diff is limited to the responsive CSS, the real-browser regression, and its CI exclusion. Confirm App Settings and Add Case selectors are unchanged.

- [ ] **Step 3: Commit the implementation**

```bash
git add -- src/web/public/styles.css config/vitest.ci.config.ts test/session-options-modal-layout.test.ts test/session-options-responsive.browser.test.ts docs/superpowers/plans/2026-08-18-cod-326-session-options-responsive-layout.md
git commit -m "fix(settings): COD-326 contain Session Options width"
```

- [ ] **Step 4: Confirm the worktree is clean**

Run:

```bash
git status --short --branch
```

Expected: branch `cod-326-session-options-responsive` with no modified or untracked files.
