# COD-415 Codex Background Helper Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mark a Codex session with a ready composer as idle/available even when a durable background helper remains.

**Architecture:** `classifyCodexRenderedState()` is the one boundary between a rendered Codex frame and the external-CLI idle timer. Keep explicit Working and approval-dialog detection ahead of composer detection, but remove background-terminal presence as a reason to return `working`. The background-process fact remains visible in the raw terminal and is not used to infer process safety.

**Tech Stack:** TypeScript, Vitest, tmux-rendered terminal frames.

---

### Task 1: Specify parent-session availability semantics

**Files:**
- Modify: `test/codex-background-terminal-idle.test.ts:4-77`
- Test: `test/codex-background-terminal-idle.test.ts`

- [ ] **Step 1: Replace the background-terminal working expectations with input-ready expectations**

```ts
it('reports input-ready when the composer is ready alongside a background terminal', () => {
  const frame = ['• Done.', '  · 1 background terminal running', COMPOSER, MODEL_FOOTER].join('\r\n');
  expect(classifyCodexRenderedState(frame)).toBe('input-ready');
});

it('reports input-ready for multiple background terminals when the composer is ready', () => {
  const frame = ['  · 3 background terminals running', COMPOSER].join('\r\n');
  expect(classifyCodexRenderedState(frame)).toBe('input-ready');
});
```

- [ ] **Step 2: Run the changed regression test and verify it fails under the old classifier**

Run: `npm test -- test/codex-background-terminal-idle.test.ts`

Expected: FAIL because the old classifier returns `working` for nonzero background-terminal counts.

- [ ] **Step 3: Preserve precedence tests for actual work and user input**

```ts
it('keeps a real action-required prompt actionable while a terminal runs', () => {
  const frame = ['• Done.', '  · 1 background terminal running', 'Allow this command?', '› 1. Yes, run it', '  2. No', COMPOSER].join('\r\n');
  expect(classifyCodexRenderedState(frame)).toBe('input-ready');
});
```

- [ ] **Step 4: Commit the red test and design documents**

```bash
git add docs/superpowers/specs/2026-09-06-codex-background-helper-status-design.md docs/superpowers/plans/2026-09-06-codex-background-helper-status.md test/codex-background-terminal-idle.test.ts
git commit -m "test(COD-415): define background helper availability"
```

### Task 2: Stop treating helper presence as active Codex work

**Files:**
- Modify: `src/session.ts:365-399`
- Test: `test/codex-background-terminal-idle.test.ts`

- [ ] **Step 1: Remove the background-terminal branch from the rendered-state classifier**

```ts
if (detectCodexCheckpointWorkingFrame(plain)) return 'working';
if (hasCodexNumberedChoiceBlock(plain)) return 'input-ready';
if (CODEX_COMPOSER_LINE_PATTERN.test(plain)) return 'input-ready';
return 'unknown';
```

- [ ] **Step 2: Update the classifier documentation to state that background terminals are informational**

```ts
// A ready composer establishes parent-session availability. A remaining
// background terminal can be a durable helper (for example, a preview server),
// so it is not evidence that Codex is currently working.
```

- [ ] **Step 3: Run the focused regression suite**

Run: `npm test -- test/codex-working-detection.test.ts test/codex-background-terminal-idle.test.ts`

Expected: PASS with all Codex frame-classification assertions green.

- [ ] **Step 4: Run static validation**

Run: `npm run typecheck && npm run lint && npm run format:check && npm run check:lockfile`

Expected: all commands exit 0.

- [ ] **Step 5: Commit the implementation**

```bash
git add src/session.ts test/codex-background-terminal-idle.test.ts
git commit -m "fix(COD-415): keep ready helpers out of working status"
```
