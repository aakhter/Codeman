# COD-336 Approval Hook Coverage Design

## Goal

Add direct regression coverage proving that the shipped approvals UI forwards a live, unacknowledged Codex idle approval to the existing tab-alert state machine.

## Design

Create a focused Node/Vitest frontend unit test that evaluates `src/web/public/approvals-ui.js` in a minimal `node:vm` context with a stub `CodemanApp` class. Instantiate the resulting real prototype mixin without a DOM, invoke `_onApprovalPending()`, and spy on `setPendingHook()`.

The primary case asserts that a Codex-style idle item forwards its session ID with the `idle_prompt` hook type. A boundary case asserts that an item carrying `acknowledgedAt` does not re-arm the hook. The test will not assert rendering, stale sibling cleanup, other approval-kind mappings, or SSE routing because those behaviors are outside COD-336.

## Verification

Because the production behavior already exists, the new test will initially pass. Prove regression sensitivity by temporarily removing the existing `setPendingHook()` call, observe the focused test fail for the expected missing invocation, restore the production source unchanged, and observe the test pass. Then run the existing listener-level regression and the repository's static/build gates. Do not run the separately environment-blocked push-payload suite.

## Scope

- Add one focused test file.
- Make no production behavior changes.
- Keep Playwright, browser launch, live ports, and tmux out of the test setup.
