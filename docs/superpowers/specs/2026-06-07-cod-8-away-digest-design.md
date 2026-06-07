# COD-8 Away Digest Design

## Goal

Add an Away Digest view that answers: what happened across Codeman sessions while the user was away, and what needs attention now?

The first implementation should aggregate existing persisted and live data sources. It must not read full terminal buffers by default.

## Current Context

Existing useful sources:

- `GET /api/session-lifecycle`: persisted JSONL lifecycle entries from `~/.codeman/session-lifecycle.jsonl`.
- `GET /api/token-stats`: persisted day-level token and cost history plus aggregate active-session totals.
- `GET /api/sessions/:id/run-summary`: live per-session run summary from `RunSummaryTracker`; useful while sessions are active, but not currently persisted.
- `GET /api/status`: active sessions, respawn status, aggregate stats, and recent subagents.
- In-page notifications: useful while the page is alive, but not durable across reloads.

Key constraint: after a server restart, lifecycle and token stats survive, but run summaries and notification drawer state may not. The digest should explicitly favor durable sources and degrade gracefully when live-only details are unavailable.

## Recommended Approach

Build a backend aggregate endpoint plus a frontend modal:

- `GET /api/away-digest?range=since-last-visit|1h|today|24h|custom&since=<ms>&until=<ms>`
- Backend returns a typed digest response with sections already classified:
  - `needsAttention`
  - `completed`
  - `stillRunning`
  - `idle`
  - `informational`
- Frontend renders the response without reimplementing classification logic.
- A small persisted client preference stores the last viewed digest timestamp, used for "since last visit".

This keeps session classification testable in TypeScript and lets the UI stay simple.

## Alternatives Considered

### Frontend-only aggregation

Fetch `/api/session-lifecycle`, `/api/token-stats`, `/api/status`, and every active run summary from the browser, then classify in JavaScript.

Pros:

- Minimal backend surface.
- Easy to prototype.

Cons:

- Duplicates classification logic in public JavaScript.
- Harder to test well.
- More round trips and more edge cases in the browser.
- Poor fit for future persistence.

### Backend aggregate endpoint

Add an `AwayDigestBuilder` on the backend and serve one response.

Pros:

- Centralized, typed, unit-testable classification.
- One browser request for the main view.
- Easier to add durable event persistence later.
- Keeps terminal-buffer avoidance enforceable on the server.

Cons:

- Adds a new route and type contract.
- Requires careful source boundaries so it does not become another large server method.

Recommendation: backend aggregate endpoint.

### Full event persistence first

Persist every notable run-summary, respawn, Ralph, subagent, notification, and image event, then build the digest from that durable event store.

Pros:

- Best long-term data model.
- Strongest restart behavior.

Cons:

- Larger project than COD-8 needs for a first usable digest.
- Requires event schema/versioning and migration decisions.

Recommendation: defer this. COD-8 should leave a clear extension point for a durable event store.

## Backend Design

Add `src/web/away-digest.ts` with a pure builder:

```ts
export interface AwayDigestRequest {
  since: number;
  until: number;
  range: 'since-last-visit' | '1h' | 'today' | '24h' | 'custom';
}

export interface AwayDigestItem {
  id: string;
  sessionId?: string;
  sessionName?: string;
  timestamp: number;
  category: 'needs_attention' | 'completed' | 'still_running' | 'idle' | 'informational';
  severity: 'info' | 'success' | 'warning' | 'error';
  title: string;
  detail?: string;
  source: 'lifecycle' | 'run_summary' | 'status' | 'token_stats' | 'subagent';
  link?: {
    type: 'session' | 'run_summary' | 'lifecycle' | 'notification';
    sessionId?: string;
  };
}

export interface AwayDigestResponse {
  range: AwayDigestRequest;
  generatedAt: number;
  dataFreshness: {
    lifecyclePersisted: true;
    tokenStatsPersisted: true;
    runSummariesLiveOnly: true;
  };
  totals: {
    sessionsCreated: number;
    sessionsExited: number;
    activeSessions: number;
    needsAttention: number;
    completed: number;
    errors: number;
    warnings: number;
    inputTokens?: number;
    outputTokens?: number;
    estimatedCost?: number;
  };
  sections: {
    needsAttention: AwayDigestItem[];
    completed: AwayDigestItem[];
    stillRunning: AwayDigestItem[];
    idle: AwayDigestItem[];
    informational: AwayDigestItem[];
  };
}
```

Route placement:

- Add a system route in `src/web/routes/system-routes.ts`, or a new `away-digest-routes.ts` if the route body grows beyond a simple adapter.
- The route should collect:
  - lifecycle entries filtered by `since` and `until`
  - active sessions and respawn status from the route context
  - live run summaries for active sessions only
  - token stats for day-level ranges
  - recent subagents from the same status source used by `/api/status`

Classification rules:

- `needsAttention`: lifecycle `exit` with non-zero code, `mux_died`, run-summary `error`, `state_stuck`, respawn blocked/error events, Ralph circuit breaker/exit-gate style events when present.
- `completed`: run-summary `ralph_completion`, hook stop/task-completed style events, lifecycle exits with zero code when the session was running a task and no error is known.
- `stillRunning`: active sessions in working/running states and active respawn timers.
- `idle`: active sessions idle or watching without recent error.
- `informational`: session created/started/recovered/deleted, token milestones, auto-clear/auto-compact, subagent completions when no action is required.

Limits:

- Default item limit: 200 total items after classification.
- Never call terminal-buffer endpoints from the digest route.
- Do not fetch image/file previews automatically. Include links only when metadata already has them.

## Frontend Design

Entry point:

- Add a header icon button near notifications/lifecycle log.
- Suggested title: `Away Digest`.
- Use the existing modal pattern, not a floating nested card.

Modal structure:

- Header with range segmented control:
  - Since last visit
  - Last hour
  - Today
  - 24h
  - Custom
- Summary strip:
  - Needs attention
  - Completed
  - Active
  - Tokens/cost where available
- Main list sections:
  - Needs Attention first
  - Completed
  - Still Running
  - Idle
  - Informational
- Each item shows timestamp, session name, title, short detail, and one action button when available:
  - Open Session
  - Run Summary
  - Lifecycle Log

Mobile:

- Same modal content, single-column.
- Range controls wrap to multiple rows.
- Items keep stable row height and avoid horizontal scrolling.

Since-last-visit:

- Use localStorage key `codeman-away-digest-last-viewed`.
- Opening the digest with `range=since-last-visit` uses that timestamp.
- Update the timestamp only when the digest successfully loads and the user closes the modal or switches away from "since last visit"; this avoids clearing the marker on failed loads.

## Error Handling

- If the digest endpoint fails, show a retry state in the modal.
- If live run summaries fail for one session, keep the digest response and include a warning informational item for that session.
- If token stats are not available for a precise custom window, return day-level token totals with `tokenWindowPrecision: 'day'`.
- If there are no events, render an empty state with the selected range and active-session count.

## Testing Plan

Backend unit tests:

- `AwayDigestBuilder` classifies non-zero exits and run-summary errors as needs-attention.
- Successful Ralph completion appears in completed.
- Active session status appears in still-running or idle.
- Lifecycle entries outside the selected range are excluded.
- Token stats are included for day-backed ranges and marked as day precision.
- The builder never requires terminal buffers.

Route tests:

- `GET /api/away-digest` validates range inputs.
- Default range resolves to since-last-visit fallback when no timestamp is supplied.
- Response shape includes stable sections and totals.

Frontend static/unit tests:

- Away Digest modal exists and has range controls.
- Header entry point opens the modal.
- `since-last-visit` localStorage timestamp is read and updated only after a successful load.
- Renderer separates needs-attention from informational updates.

Mobile/layout tests:

- Modal is readable in a mobile viewport.
- Range controls do not overflow.
- Digest items do not overlap or clip long session names.

## Implementation Order

1. Add backend types and pure `AwayDigestBuilder` with tests.
2. Add `GET /api/away-digest` route with route tests.
3. Add frontend modal shell and header button.
4. Add frontend fetch/render logic and localStorage last-viewed handling.
5. Add mobile CSS and layout tests.
6. Run focused tests, public asset checks, lint, typecheck, and format.

## Explicit Non-Goals For COD-8

- No full terminal-buffer summarization.
- No AI-generated digest text.
- No durable event-store migration in the first implementation.
- No push-notification changes.
- No automatic file/image preview fetches.

## Review Questions

1. Should "since last visit" update when the modal opens, or only after the user closes it? Recommended: after successful load and close.
2. Should COD-8 include subagent completions in the first implementation if they are only recent/live, or defer them to the durable event-store follow-up? Recommended: include recent/live with a freshness note.
3. Should a zero-exit lifecycle event count as completed, or only as informational unless paired with a run-summary completion event? Recommended: informational unless paired with completion evidence.
