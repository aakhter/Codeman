# COD-247 Navbar Hover Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the final desktop session tab from flickering between navbar rows when its controls appear on hover.

**Architecture:** Keep the existing tab markup and desktop flex-wrap policy. Make gear, detach, and close controls occupy
stable desktop layout space in both hidden and visible states, changing only opacity and pointer interaction on hover or
keyboard focus. Cover the behavior with a real Chromium regression test at the exact wrapping boundary.

**Tech Stack:** Plain CSS, browser DOM, Playwright, Vitest

---

## File map

- `test/mobile/tabs.test.ts`: Real-browser regression proving a full desktop navbar remains geometrically stable on hover.
- `src/web/public/styles.css`: Stable desktop dimensions and visibility/pointer behavior for session-tab controls.

### Task 1: Add the failing full-navbar hover regression

**Files:**
- Modify: `test/mobile/tabs.test.ts`

- [ ] **Step 1: Add the failing browser test**

Add this desktop test inside the top-level `describe('Tab Navigation', ...)` block:

```ts
it('keeps the last full-row tab stationary when hover controls appear', async () => {
  const { context, page } = await createDevicePage(REPRESENTATIVE_DEVICES['large-tablet'], BASE_URL, 'chromium');
  try {
    await page.waitForTimeout(WAIT.PAGE_SETTLE);
    await page.evaluate(() => {
      const container = document.querySelector('.session-tabs') as HTMLElement;
      container.className = 'session-tabs';
      container.style.cssText = 'flex:none;overflow:visible;';
      container.innerHTML = ['Alpha', 'Bravo', 'Charlie', 'Delta']
        .map(
          (name) => `
            <div class="session-tab">
              <span class="tab-status idle"></span>
              <span class="tab-info"><span class="tab-name-row"><span class="tab-name">${name}</span></span></span>
              <span class="tab-gear" tabindex="0">&#9881;</span>
              <span class="tab-detach" tabindex="0">&#x29C9;</span>
              <span class="tab-close" tabindex="0">&times;</span>
            </div>`
        )
        .join('');

      const tabs = Array.from(container.querySelectorAll<HTMLElement>('.session-tab'));
      const style = getComputedStyle(container);
      const width =
        tabs.reduce((sum, tab) => sum + tab.getBoundingClientRect().width, 0) +
        (parseFloat(style.columnGap) || 0) * (tabs.length - 1) +
        (parseFloat(style.paddingLeft) || 0) +
        (parseFloat(style.paddingRight) || 0);
      container.style.width = `${Math.ceil(width)}px`;
      container.classList.add('tabs-auto-wrap');

      const last = tabs.at(-1)!;
      (window as any).__cod247HoverEvents = { enter: 0, leave: 0 };
      last.addEventListener('mouseenter', () => (window as any).__cod247HoverEvents.enter++);
      last.addEventListener('mouseleave', () => (window as any).__cod247HoverEvents.leave++);
    });

    const tab = page.locator('.session-tab').last();
    const header = page.locator('.header');
    const beforeTab = await tab.boundingBox();
    const beforeHeader = await header.boundingBox();
    expect(beforeTab).not.toBeNull();
    expect(beforeHeader).not.toBeNull();

    await page.mouse.move(
      beforeTab!.x + beforeTab!.width / 2,
      beforeTab!.y + beforeTab!.height / 2
    );
    await page.waitForTimeout(500);

    const afterTab = await tab.boundingBox();
    const afterHeader = await header.boundingBox();
    const events = await page.evaluate(() => (window as any).__cod247HoverEvents);
    const gearOpacity = await tab.locator('.tab-gear').evaluate((element) => getComputedStyle(element).opacity);

    expect(events).toEqual({ enter: 1, leave: 0 });
    expect(afterTab?.x).toBeCloseTo(beforeTab!.x, 1);
    expect(afterTab?.y).toBeCloseTo(beforeTab!.y, 1);
    expect(afterTab?.width).toBeCloseTo(beforeTab!.width, 1);
    expect(afterHeader?.height).toBeCloseTo(beforeHeader!.height, 1);
    expect(Number(gearOpacity)).toBe(1);
  } finally {
    await context.close();
  }
});
```

- [ ] **Step 2: Run the test and verify the regression is red**

Run:

```bash
npm test -- test/mobile/tabs.test.ts -t "keeps the last full-row tab stationary"
```

Expected: FAIL because repeated `mouseenter`/`mouseleave` events occur and the last tab changes row or width.

- [ ] **Step 3: Commit the failing regression**

```bash
git add test/mobile/tabs.test.ts
git commit -m "test: COD-247 reproduce full-navbar hover flicker"
```

### Task 2: Stabilize desktop tab-control geometry

**Files:**
- Modify: `src/web/public/styles.css`
- Test: `test/mobile/tabs.test.ts`

- [ ] **Step 1: Reserve fixed space for the close control**

Replace the close control's zero-width hidden geometry and hover-time width/padding changes with:

```css
.session-tab .tab-close {
  opacity: 0;
  width: 1.5rem;
  padding: 0.15rem 0.35rem;
  box-sizing: border-box;
  flex-shrink: 0;
  pointer-events: none;
  /* existing typography, color, overflow, cursor, radius, and transition declarations */
}

.session-tab:hover .tab-close,
.session-tab .tab-close:focus-visible {
  opacity: 1;
  pointer-events: auto;
}
```

Keep only opacity in the transition; width and padding are stable.

- [ ] **Step 2: Reserve fixed space for the gear and detach controls**

Apply the same stable-geometry policy to both controls:

```css
.session-tab .tab-gear,
.session-tab .tab-detach {
  opacity: 0;
  width: 1.6rem;
  padding: 0 0.3rem;
  box-sizing: border-box;
  flex-shrink: 0;
  pointer-events: none;
}
```

Preserve each control's existing typography, color, cursor, overflow, and decorative transitions. Their hover/focus reveal
rules must change only opacity and pointer events:

```css
.session-tab:hover .tab-gear,
.session-tab .tab-gear:focus-visible,
.session-tab:hover .tab-detach,
.session-tab .tab-detach:focus-visible {
  opacity: 1;
  pointer-events: auto;
}
```

- [ ] **Step 3: Run the focused browser test and verify green**

Run:

```bash
npm test -- test/mobile/tabs.test.ts -t "keeps the last full-row tab stationary"
```

Expected: PASS with one enter event, no leave event, stable tab geometry, stable header height, and visible hover controls.

- [ ] **Step 4: Run adjacent regression tests**

Run:

```bash
npm test -- test/tab-overflow.test.ts
npm test -- test/mobile/header-buttons.test.ts
```

Expected: both files PASS.

- [ ] **Step 5: Commit the CSS fix**

```bash
git add src/web/public/styles.css
git commit -m "fix(ui): COD-247 stabilize full-navbar tab hover"
```

### Task 3: Verify the completed branch

**Files:**
- Verify: `src/web/public/styles.css`
- Verify: `test/mobile/tabs.test.ts`

- [ ] **Step 1: Run focused behavior tests**

```bash
npm test -- test/mobile/tabs.test.ts -t "keeps the last full-row tab stationary"
npm test -- test/tab-overflow.test.ts
npm test -- test/mobile/header-buttons.test.ts
```

Expected: all selected tests PASS.

- [ ] **Step 2: Run repository static checks**

```bash
npm run typecheck
npm run lint
npm run format:check
npm run check:lockfile
```

Expected: every command exits 0.

- [ ] **Step 3: Run the production build**

```bash
npm run build
```

Expected: esbuild completes and emits `dist/` without errors.

- [ ] **Step 4: Inspect the final branch**

```bash
git diff --check master...HEAD
git status --short
git log --oneline master..HEAD
```

Expected: no whitespace errors, a clean worktree, and only COD-247 commits.
