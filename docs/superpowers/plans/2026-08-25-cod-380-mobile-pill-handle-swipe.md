# COD-380 Mobile Pill Handle Swipe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the mobile session-switcher sheet open during downward list scrolling while preserving drag-to-dismiss from the top handle.

**Architecture:** Move gesture ownership from the sheet container to `.sheet-handle`, retaining the 50px downward threshold and the existing `toggle(false)` state transition. Expand only the handle's hit-tested area with a pseudo-element that occupies its existing margins, leaving the visible grip and surrounding controls unchanged.

**Tech Stack:** Plain browser JavaScript and CSS, Playwright browser automation, Vitest mobile configuration.

---

## File Map

- `test/mobile/mobile-tab-pill.test.ts`: browser-level regression coverage for gestures starting on the list and handle.
- `src/web/public/mobile-tabs.js`: touch gesture ownership and lifecycle.
- `src/web/public/mobile.css`: invisible handle hit-area expansion without changing the visible grip.

### Task 1: Add Gesture-Ownership Regression Coverage

**Files:**

- Modify: `test/mobile/mobile-tab-pill.test.ts:1-132`

- [ ] **Step 1: Add a reusable downward-touch helper**

Import `Page` with the existing Playwright types and add this helper below `BASE_URL`:

```typescript
import type { Browser, BrowserContext, Page } from 'playwright';

async function dispatchDownSwipe(page: Page, selector: string, distance = 80): Promise<void> {
  await page.evaluate(
    ({ targetSelector, swipeDistance }) => {
      const target = document.querySelector(targetSelector);
      if (!(target instanceof HTMLElement)) throw new Error(`Missing swipe target: ${targetSelector}`);
      const rect = target.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const startY = rect.top + Math.max(1, rect.height / 2);
      const touch = (y: number) =>
        new Touch({
          identifier: 1,
          target,
          clientX: x,
          clientY: y,
          pageX: x,
          pageY: y,
        });

      target.dispatchEvent(
        new TouchEvent('touchstart', {
          touches: [touch(startY)],
          changedTouches: [touch(startY)],
          bubbles: true,
        })
      );
      target.dispatchEvent(
        new TouchEvent('touchmove', {
          touches: [touch(startY + swipeDistance)],
          changedTouches: [touch(startY + swipeDistance)],
          bubbles: true,
        })
      );
      target.dispatchEvent(
        new TouchEvent('touchend', {
          touches: [],
          changedTouches: [touch(startY + swipeDistance)],
          bubbles: true,
        })
      );
    },
    { targetSelector: selector, swipeDistance: distance }
  );
}
```

- [ ] **Step 2: Add the failing list-swipe test and the preserved handle-swipe test**

Append these tests inside the existing `describe` block:

```typescript
it('keeps the sheet open when a downward swipe starts on the session list', async () => {
  const context = await browser.newContext({ viewport: { width: 440, height: 900 }, hasTouch: true });
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.app && window.MobileTabSheet);

  await page.evaluate(() => window.MobileTabSheet.toggle(true));
  await dispatchDownSwipe(page, '#mobileTabList');

  expect(
    await page.evaluate(() => ({
      sheetOpen: document.getElementById('mobileTabSheet')?.classList.contains('open'),
      scrimOpen: document.getElementById('mobileTabScrim')?.classList.contains('open'),
      expanded: document.getElementById('mobileTabPill')?.getAttribute('aria-expanded'),
      bodyOverflow: document.body.style.overflow,
    }))
  ).toEqual({ sheetOpen: true, scrimOpen: true, expanded: 'true', bodyOverflow: 'hidden' });
});

it('closes the sheet when a downward swipe starts on the top handle', async () => {
  const context = await browser.newContext({ viewport: { width: 440, height: 900 }, hasTouch: true });
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.app && window.MobileTabSheet);

  await page.evaluate(() => window.MobileTabSheet.toggle(true));
  await dispatchDownSwipe(page, '#mobileTabSheet .sheet-handle');

  expect(
    await page.evaluate(() => ({
      sheetOpen: document.getElementById('mobileTabSheet')?.classList.contains('open'),
      scrimOpen: document.getElementById('mobileTabScrim')?.classList.contains('open'),
      expanded: document.getElementById('mobileTabPill')?.getAttribute('aria-expanded'),
      bodyOverflow: document.body.style.overflow,
    }))
  ).toEqual({ sheetOpen: false, scrimOpen: false, expanded: 'false', bodyOverflow: '' });
});
```

- [ ] **Step 3: Run the two gesture tests and verify the regression is red**

Run:

```bash
npm run test:mobile -- test/mobile/mobile-tab-pill.test.ts -t 'downward swipe'
```

Expected: the list-swipe test fails because `sheetOpen`, `scrimOpen`, and `expanded` become false and body overflow becomes empty. The handle-swipe test passes, proving the dismissal behavior being preserved.

### Task 2: Give the Handle Sole Gesture Ownership

**Files:**

- Modify: `src/web/public/mobile-tabs.js:102-139`
- Modify: `src/web/public/mobile.css:4012`
- Test: `test/mobile/mobile-tab-pill.test.ts`

- [ ] **Step 1: Move the touch listeners from the sheet to the handle**

Replace the current sheet-wide swipe block in `_bindEvents()` with:

```javascript
// Swipe down from the top handle to close. Content gestures belong to their
// own controls, especially the vertically scrollable session list.
const handle = document.querySelector('#mobileTabSheet .sheet-handle');
let startY = null;
handle?.addEventListener(
  'touchstart',
  (e) => {
    startY = e.touches[0]?.clientY ?? null;
  },
  { passive: true }
);
handle?.addEventListener(
  'touchmove',
  (e) => {
    const currentY = e.touches[0]?.clientY;
    if (startY !== null && currentY !== undefined && currentY - startY > 50) {
      startY = null;
      this.toggle(false);
    }
  },
  { passive: true }
);
const resetHandleSwipe = () => {
  startY = null;
};
handle?.addEventListener('touchend', resetHandleSwipe, { passive: true });
handle?.addEventListener('touchcancel', resetHandleSwipe, { passive: true });
```

- [ ] **Step 2: Expand the handle hit area inside its existing margins**

Replace the handle CSS rule with these two rules:

```css
.mobile-tab-sheet .sheet-handle {
  position: relative;
  width: 36px;
  height: 4px;
  background: #3a4350;
  border-radius: 2px;
  margin: 8px auto 6px;
}
.mobile-tab-sheet .sheet-handle::before {
  content: '';
  position: absolute;
  inset: -8px -12px -6px;
}
```

The pseudo-element adds 12px horizontally and fills only the existing 8px top and 6px bottom margin vertically, so it enlarges hit testing without covering the search field or changing layout.

- [ ] **Step 3: Run the focused mobile pill file and verify green**

Run:

```bash
npm run test:mobile -- test/mobile/mobile-tab-pill.test.ts
```

Expected: one test file passes with seven tests, including list-swipe persistence and handle-swipe dismissal.

- [ ] **Step 4: Inspect the focused diff**

Run:

```bash
git diff -- src/web/public/mobile-tabs.js src/web/public/mobile.css test/mobile/mobile-tab-pill.test.ts
git diff --check
```

Expected: only the handle gesture block, hit-area CSS, and two regression tests change; `git diff --check` exits 0 with no output.

- [ ] **Step 5: Commit the implementation**

```bash
git add src/web/public/mobile-tabs.js src/web/public/mobile.css test/mobile/mobile-tab-pill.test.ts
git commit -m 'fix(mobile): COD-380 keep session list open while scrolling'
```

### Task 3: Run Delivery Gates and Record Evidence

**Files:**

- Verify only; no source changes expected.

- [ ] **Step 1: Re-run the behavioral regression file**

```bash
npm run test:mobile -- test/mobile/mobile-tab-pill.test.ts
```

Expected: one file and seven tests pass.

- [ ] **Step 2: Run repository static and packaging gates**

Run each command separately and require exit code 0:

```bash
npm run typecheck
npm run lint
npm run format:check
npm run check:lockfile
npm run build
git diff --check HEAD~1..HEAD
```

Expected: TypeScript, ESLint, Prettier, lockfile validation, production build, and whitespace checks all pass. Do not run bare `npm test` or raw unscoped Vitest from the managed session.

- [ ] **Step 3: Confirm branch scope**

```bash
git status --short --branch
git log --oneline local..HEAD
git diff --stat local...HEAD
```

Expected: the worktree is clean; commits consist of the COD-380 design, plan, and focused implementation; the diff contains only the spec, plan, mobile touch handler, handle CSS, and focused mobile test.

- [ ] **Step 4: Update Jira without claiming deployment**

```bash
cod380_branch=$(git branch --show-current)
cod380_plan_commit=$(git log --format=%h --grep='docs: COD-380 plan handle-only sheet dismissal' -1)
cod380_implementation_commit=$(git log --format=%h --grep='fix(mobile): COD-380 keep session list open while scrolling' -1)
JIRA_PROFILE=work JIRA_SITE=https://aakhter.atlassian.net jira comment COD-380 --body "Branch: ${cod380_branch}. Plan commit: ${cod380_plan_commit}. Implementation commit: ${cod380_implementation_commit}. TDD evidence: the list-swipe test failed against the original sheet-wide listener, while handle dismissal passed; after implementation the focused mobile pill file passed 7/7. Typecheck, lint, format check, lockfile check, build, and diff check all exited 0. Integration, deployment/restart, and live mobile verification have not yet been performed."
```

Record tests and build separately from integration, deployment/restart, and live verification. Do not move COD-380 to Done until the authorized delivery and live mobile checks have occurred.
