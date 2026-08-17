# COD-314 Read My Mind Error Surface Design

## Problem

After a Codeman server restart, a restored Codex session may no longer have a session-scoped `OPENAI_API_KEY` or `CODEX_API_KEY`. Codeman intentionally persists only secret-free provider provenance, so the Read My Mind route rejects that session with an actionable `OPERATION_FAILED` response telling the user to recreate or restart it.

The browser currently calls the route through `_apiJson()`. That shared helper collapses every non-2xx response to `null`, and `readmymind-ui.js` interprets `null` as an empty suggestion set. The modal therefore displays “No suggestion this time,” hiding the actual recovery instruction and encouraging ineffective Rethink attempts.

## Constraints

- Preserve strict provider lanes and the existing secret-free recovery boundary.
- Do not fall back from a restored session identity to process or default credentials.
- Do not recover, persist, expose, or log credential values.
- Preserve the existing generic empty-suggestion state for a successful response that genuinely contains no usable suggestions.
- Keep the change local to the Read My Mind request and modal; do not alter the shared `_apiJson()` contract used throughout the frontend.

## Considered Approaches

1. **Recommended: Read the Read My Mind response directly and render its sanitized API error.** This preserves the shared API helper, distinguishes transport/API failures from successful empty results, and gives the modal the server's actionable message.
2. Change `_apiJson()` to return error envelopes. This would affect many unrelated callers that currently rely on `null` and is too broad for the regression.
3. Fall back to default Codex credentials for restored sessions. This could silently switch provider identity and violates the agreed lane and secret boundaries.

## Design

`readmymind-ui.js` will add a small Read My Mind-specific JSON request helper. It will:

1. Call `_api()` so the response status and body remain available.
2. Parse the uniform API envelope.
3. Return a discriminated result representing success data or a user-safe error string.
4. Use a stable fallback message for network failures, malformed responses, or missing server error text.

`_readMyMindPredict()` will render successful suggestions exactly as it does today. On failure, it will store the returned message in the current modal state and enter the error phase. `_rmmSetPhase('error')` will write that message using `textContent` into the existing `.readmymind-error` element. Opening the modal or starting a new prediction will clear stale error text.

The backend contract remains unchanged. In particular, restored sessions with lost session-scoped credentials continue to fail before context assembly or provider invocation.

## User Experience

For the reproduced case, the modal will display:

> Read My Mind cannot use this restored Codex session because its session credentials were not persisted; please recreate or restart the session.

Rethink remains available for ordinary prediction failures, but the visible message makes clear that repeating the same request cannot repair a missing credential. A newly created local Codex session can use the normal restorable Codex authentication source.

## Testing

- Add a browser-source regression test proving Read My Mind uses `_api()` rather than the error-swallowing `_apiJson()` path.
- Exercise the request helper with a successful envelope, a structured non-2xx API error, a network failure, and malformed JSON.
- Assert error rendering uses `textContent` and clears stale errors on a subsequent loading/success cycle.
- Retain the existing backend route test that proves lost restored credentials return `502 OPERATION_FAILED` without invoking the predictor.
- Run the focused frontend and route tests, then typecheck, lint, formatting, lockfile, build, beta smoke checks, and the normal managed deployment checks.

## Non-goals

- Making old session-scoped credentials recoverable after restart.
- Changing Codex authentication selection.
- Invoking a real provider prediction during automated verification.
- Redesigning the modal or shared API client.
