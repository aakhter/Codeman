# Mobile Collapsible Navbar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Codeman header collapsible at widths up to 768px so session tabs are not crowded by utility buttons.

**Architecture:** A semantic toggle in the existing header controls the existing `#headerRight` utility cluster.
`CodemanApp` owns the page-local expanded state while responsive CSS changes the cluster into a second row and adjusts
the fixed-header content offset. Desktop markup and utility handlers remain unchanged.

**Tech Stack:** Plain HTML, CSS media queries, browser JavaScript, Vitest, Playwright

---

### Task 1: Add the failing mobile interaction tests

**Files:**
- Modify: `test/mobile/header-buttons.test.ts`

- [ ] **Step 1: Add a large-phone collapse test**

Add a Playwright test that opens `REPRESENTATIVE_DEVICES['large-phone']`, asserts
`.mobile-header-utility-toggle` is visible with `aria-expanded="false"`, and asserts `#headerRight` is hidden. Click the
toggle, then assert `aria-expanded="true"`, `#headerRight` is visible, and `.app` has a larger computed `padding-top`.
Click again and assert the original state is restored.

- [ ] **Step 2: Add a desktop preservation test**

Open `REPRESENTATIVE_DEVICES['large-tablet']`, then assert `.mobile-header-utility-toggle` is hidden and `#headerRight`
is visible.

- [ ] **Step 3: Verify RED**

Run:

```bash
npm test -- test/mobile/header-buttons.test.ts
```

Expected: FAIL because `.mobile-header-utility-toggle` does not exist.

### Task 2: Implement the accessible collapse controller

**Files:**
- Modify: `src/web/public/index.html`
- Modify: `src/web/public/app.js`
- Modify: `src/web/public/mobile.css`

- [ ] **Step 1: Add the toggle markup**

Insert a button after `#sessionTabs`:

```html
<button
  class="mobile-header-utility-toggle"
  type="button"
  onclick="app.toggleMobileHeaderUtilities()"
  aria-label="Toggle header controls"
  aria-controls="headerRight"
  aria-expanded="false"
>
  <!-- menu/close icon -->
</button>
```

- [ ] **Step 2: Add the controller**

Add `toggleMobileHeaderUtilities()` to `CodemanApp`. Toggle `mobile-utilities-expanded` on `.header` and
`mobile-header-utilities-expanded` on `.app`, then write the resulting boolean to the button's `aria-expanded`.

- [ ] **Step 3: Add responsive layout rules**

Within the existing `max-width: 768px` styles, show the toggle, hide `.header-right` unless the expanded class is present,
and render the expanded utility cluster as a full-width wrapped second row. Increase `.app` top padding while expanded.
Use the existing tablet and phone header heights and safe-area variables.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npm test -- test/mobile/header-buttons.test.ts
```

Expected: all tests in the file pass.

### Task 3: Verify, integrate, and deploy

**Files:**
- Verify all files changed by Tasks 1–2

- [ ] **Step 1: Run focused and static verification**

```bash
npm test -- test/mobile/header-buttons.test.ts
npm run check:frontend-syntax
npm run typecheck
npm run lint
npm run format:check
npm run check:lockfile
npm run build
```

Expected: every command exits 0.

- [ ] **Step 2: Run realistic browser verification**

Run the Codeman realistic smoke script and inspect its summary and browser errors:

```bash
node /home/ubuntu/.codex/skills/codeman-prod-realistic-smoke/scripts/run-codeman-prod-smoke.mjs
```

Expected: PASS with cleanup confirmed.

- [ ] **Step 3: Commit, merge, and push**

Commit the focused changes on `fix/mobile-collapsible-navbar`, merge the branch into the production checkout, rerun the
focused test on the merged result, and push the merged commit to Bitbucket `origin/local`.

- [ ] **Step 4: Deploy**

Build the merged production checkout, restart `codeman-web`, and verify the service is active and
`http://127.0.0.1:3000/` returns the expected redirect/healthy response.
