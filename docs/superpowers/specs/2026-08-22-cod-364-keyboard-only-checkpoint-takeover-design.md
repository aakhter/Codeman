# COD-364: Keyboard-only checkpoint takeover classification

## Problem

Agent-initiated `new` checkpoints send `/new`, wait for an authoritative fresh conversation identity, and then send a
continuation prompt. Any input accepted by the WebSocket or HTTP terminal-input routes currently calls
`session.cancelCheckpoint('manual-takeover')` before the bytes are forwarded. That treats terminal mouse and focus reports
as if the user had typed a prompt. An attached browser terminal can therefore cancel the handoff after `/new` while the
fresh thread remains empty.

The continuation fence is behaving correctly: after cancellation, it prevents a stale automated write. The defect is the
input classification that triggers cancellation.

## Decision

Only keyboard-bearing input cancels an active checkpoint. Mouse and focus reports continue to the PTY without cancelling
the handoff.

Classification happens on the server from the actual bytes that will be written. This avoids expanding the durable browser
input protocol, keeps WebSocket and HTTP fallback behavior identical, and does not trust a client-supplied origin label.

## Input classification

Add a focused server utility that exports a pure predicate:

```ts
isKeyboardTerminalInput(data: string): boolean
```

The predicate returns `false` only when `data` is nonempty and every byte can be consumed as one or more complete terminal
reports from this allowlist:

- Focus in/out: `ESC [ I` and `ESC [ O`
- SGR mouse: `ESC [ < Cb ; Cx ; Cy M` and the corresponding release suffix `m`
- X10 mouse: `ESC [ M` followed by exactly three payload bytes

The parser scans from offset zero until the entire string is consumed. This supports multiple reports coalesced into one
input frame. Any malformed report, trailing byte, keyboard character, paste, Enter, Escape, arrow/navigation key, control
key, unknown escape sequence, or mixture of keyboard data and reports returns `true`. Empty input also returns `true` as a
fail-closed default.

This deliberately classifies mouse activity as non-keyboard even when caused by a human click, matching the operator's
chosen policy. The bytes are still forwarded unchanged and can affect the TUI normally.

## Route integration

Both terminal-input paths call the shared predicate only for an input that will actually be applied:

- WebSocket `t: 'i'`: after sequence deduplication decides `apply`, before `session.write(msg.d)`.
- HTTP `POST /api/sessions/:id/input`: after duplicate detection, only when the input is not a duplicate, and before the
  existing write path.

Keyboard-bearing input preserves the current atomic ordering: cancel the checkpoint first, then accept the user's input.
Report-only input skips cancellation and is forwarded through the same delivery, acknowledgement, retry, and sequence
bookkeeping as before.

Duplicate frames retain current semantics and must not acquire a new cancellation side effect. Unknown or mixed input
remains keyboard-bearing so a malformed client cannot bypass the takeover fence.

## Diagnostics

When keyboard input cancels an active checkpoint, emit a safe structured log containing only:

- route: `ws` or `http`
- class: `keyboard`
- session ID already used by existing operational logs

Do not log raw bytes, prompt text, byte previews, hashes, or continuation content. Report-only traffic does not need a log
entry because it does not change checkpoint state.

To avoid misleading cancellation logs when no checkpoint is active, expose the existing `SessionAutoOps.isCheckpointActive`
state through a read-only `Session.isCheckpointActive` getter. Routes check this immediately before cancellation and log only
when it is true. The cancellation method and persisted reason remain `manual-takeover` for compatibility.

## Tests

### Pure classifier

Cover:

- one focus report;
- SGR press, release, wheel, and large coordinates;
- one X10 report;
- concatenated reports of the same and different forms;
- text, paste, Enter, Escape, arrow/navigation keys, and control keys;
- malformed and truncated reports;
- a report followed or preceded by keyboard input;
- empty input.

### Route behavior

WebSocket and HTTP route regressions prove:

- keyboard input still calls `cancelCheckpoint('manual-takeover')` before forwarding;
- report-only input is forwarded unchanged without cancellation;
- mixed input cancels;
- reliable WebSocket acknowledgement and HTTP fallback delivery remain unchanged.

### Checkpoint safety

Existing checkpoint state-machine tests continue to prove that genuine manual takeover suppresses continuation. The route
regressions cover the missing boundary: report-only terminal traffic no longer invokes that cancellation, allowing the
existing fresh-identity state machine to advance to `continue-submitted` exactly once.

## Scope

In scope:

- server-side keyboard/report classification;
- WebSocket and HTTP input-route integration;
- safe cancellation diagnostics;
- focused unit and route regressions.

Out of scope:

- changes to checkpoint sequencing or conversation identity detection;
- changes to browser reliable-delivery records or wire format;
- suppression of mouse/focus reports;
- reclassification of terminal query replies already suppressed by the browser;
- changes to generic session input semantics outside checkpoint cancellation.

## Acceptance

1. A report-only terminal input frame never cancels an active checkpoint and is still written unchanged.
2. Any keyboard-bearing or mixed frame cancels before its write.
3. WebSocket and HTTP fallback paths enforce the same policy.
4. Concatenated reports are recognized only when the parser consumes every byte.
5. Cancellation logs contain route and class but no input content.
6. Focused classifier, route, and checkpoint tests pass along with repository quality checks.
