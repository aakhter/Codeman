# COD-208 OpenCode Selection Auto-Copy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically copy non-empty xterm selections in OpenCode/Codeman terminal sessions to the clipboard.

**Architecture:** Add a focused helper on `CodemanApp.prototype` in `src/web/public/terminal-ui.js` that subscribes to xterm's `onSelectionChange`, debounces selection updates, and writes the latest non-empty, non-duplicate selected text via the existing `_copyText` clipboard helper. Cover the behavior with a VM harness test that executes the browser module without launching the app.

**Tech Stack:** TypeScript/Vitest test runner, browser JavaScript in `src/web/public/terminal-ui.js`, xterm.js terminal APIs (`onSelectionChange`, `getSelection`).

---

## File Structure

- Modify: `src/web/public/terminal-ui.js`
  - Install the auto-copy helper after `this.terminal.open(container)` in `initTerminal()`.
  - Add `_installTerminalSelectionAutoCopy()` and `_copyTerminalSelectionToClipboard()` near existing terminal clipboard helpers.
- Create: `test/terminal-selection-autocopy.test.ts`
  - VM-load `terminal-ui.js` with a minimal browser/app harness.
  - Verify selection copy, empty selection ignore, duplicate suppression, latest-selection debounce, and clipboard failure safety.

---

## Execution Summary

- Added failing coverage for terminal selection auto-copy.
- Implemented debounced selection copying from xterm's `getSelection()`.
- Suppressed duplicate clipboard writes, including async in-flight duplicates.
- Kept clipboard failures non-fatal.

## Verification

- `npm test -- test/terminal-selection-autocopy.test.ts`
- `npm run typecheck`
- `npm run lint`
- `npm run format:check`
- `npm run check:lockfile`

## Self-Review

- Spec coverage: The implementation covers auto-copy on non-empty selection, duplicate suppression, debounced latest selection, use of xterm selection APIs, quiet clipboard failure handling, and focused tests.
- Placeholder scan: No placeholders, TBDs, or vague implementation steps remain.
- Type consistency: Method names are consistent across tests and implementation: `_installTerminalSelectionAutoCopy`, `_copyTerminalSelectionToClipboard`, and `_copyText`.
