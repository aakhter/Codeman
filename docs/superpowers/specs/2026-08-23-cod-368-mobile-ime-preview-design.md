# COD-368 Mobile IME Preview Design

## Problem

On iPhone Chrome with the standard Apple keyboard, terminal text can remain several seconds behind fast typing and
continue appearing one character at a time after typing stops. The delay grows with typing speed and is specific to
Codeman's terminal input.

Live LAN diagnostics on the deployed COD-356 branch separated the input path into composition, Codeman input,
transport, PTY output, and xterm rendering. Normal mobile input completed in roughly 10-40 ms after Codeman received
it. Holding an IME composition open for five seconds reproduced 5.062 seconds end to end, with zero Codeman input
records during the hold. Once committed, the WebSocket acknowledgement took 1.7 ms, Codex output took 37.3 ms, and
xterm made the write visible in 1.8 ms. Faster real-device typing also creates a visible catch-up tail after the user
stops.

The Apple keyboard exposes the condition, but Codeman owns the poor experience. On iOS, Chrome uses WebKit and feeds
terminal input through xterm's hidden textarea and composition helper. xterm correctly withholds provisional bytes
until the IME commits them, but Codeman offers no durable visual bridge from provisional composition through the
authoritative terminal echo. Multi-character IME commits also clear Codeman's predictive echo instead of presenting
the committed run immediately.

## Goals

- Keep the latest iPhone IME text visually current while the user types, regardless of composition duration or update
  rate.
- Eliminate the character-by-character visual catch-up tail after composition commits.
- Preserve the exact final bytes and order delivered by xterm and Codeman's reliable input transport.
- Preserve autocorrect, replacement, backspace, punctuation, CJK candidate selection, Enter, and interactive Codex
  composer behavior.
- Bound work during fast typing: many composition updates must collapse into at most one pending browser render.
- Fail open to the current xterm input behavior if the preview layer cannot initialize or render.

## Non-goals

- Sending provisional or autocorrectable text to the PTY.
- Changing WebSocket, HTTP fallback, server deduplication, tmux, or Codex itself.
- Replacing the terminal with a separate submit-on-Enter input box.
- Changing desktop or physical-keyboard input behavior.
- Claiming physical iPhone acceptance from Chromium emulation alone.

## Considered Approaches

### 1. Latest-state mobile IME preview — selected

Codeman observes composition state, renders only the newest provisional value, and transfers the final committed value
to an optimistic terminal preview until authoritative output reconciles it. The preview is visual only; xterm remains
the sole producer of bytes sent to the PTY.

This preserves IME correctness and makes rendering cost independent of how many intermediate updates Apple emits.

### 2. Stream provisional composition fragments to the PTY

This could make remote output appear sooner, but a terminal cannot retract bytes after autocorrect or candidate
replacement changes them. It would produce duplicated or corrupted commands and is rejected.

### 3. Disable prediction/composition or use a separate input box

Disabling Apple keyboard features is not reliably honored by iOS and would degrade normal typing. A separate input box
would make composition visible but would break direct terminal editing, slash menus, cursor movement, and other
interactive Codex behavior. Both are rejected as the primary solution.

## Architecture

### Mobile IME preview controller

Add a small browser module responsible only for the visual lifecycle of one composition. It attaches to xterm's helper
textarea when a terminal is initialized and is enabled only for touch iOS/WebKit sessions.

The controller owns:

- the active composition generation;
- the latest provisional string;
- one scheduled animation-frame render;
- the final xterm-emitted commit awaiting authoritative output;
- one preview element positioned at the current terminal cursor;
- cleanup for terminal reinitialization, session changes, blur, disconnect, and destruction.

`compositionstart` begins a new generation. `compositionupdate` and composing `input` events replace the stored value;
they never append work to a queue. If a render is already scheduled, no second frame is scheduled. The next frame
paints the newest value once.

The preview controller must not call `_sendInputAsync`, synthesize terminal input, rewrite the helper textarea, or
prevent xterm's events. xterm continues to determine the canonical committed string and emit it through `onData`.

### Commit handoff

When composition ends, the controller waits for the corresponding printable `onData` value produced by xterm. That
actual value, not `CompositionEvent.data`, is authoritative because browser composition event data is not reliable for
all languages and autocorrect paths.

The normal `onData` path remains byte-for-byte unchanged. In parallel, the controller transfers that exact printable,
single-line commit into a visual committed state. Control sequences, bracketed paste, multiline data, or an unmatched
event bypass the preview and follow existing behavior.

### Predictive reconciliation

Extend the predictive-echo visual API with an atomic text-run operation for an IME commit. Today a multi-character
`text` input clears predictions. For a source-tagged IME commit, the addon instead presents the entire committed run in
one operation at the current valid Codex/OpenCode composer anchor.

The committed preview remains visual-only and is removed when authoritative terminal output reconciles the same text.
If no safe composer anchor exists, the dedicated IME preview may remain briefly while the first post-commit terminal
write arrives, then clears. A bounded timeout clears stale visual state, but never changes delivery or retries.

Plain paste and other multi-character input remain on the existing clear-predictions path. Only an exact composition
handoff may use atomic text prediction.

### Preview presentation

The preview is a single DOM element in the xterm helper layer, positioned from the current cursor cell. Each render
replaces `textContent`; it does not create per-character nodes. During active composition it visually distinguishes
provisional text using the existing terminal foreground with a subtle underline. After commit it uses the normal
predictive-echo appearance until reconciliation.

On supported mobile sessions, Codeman suppresses xterm's native composition view only while the owned preview is
active, preventing duplicate provisional text. If the controller fails or is disabled, xterm's native view remains
untouched.

## State and Ordering Rules

1. At most one composition generation may own the preview.
2. At most one animation frame may be pending.
3. A newer composition update replaces an older value before rendering.
4. No provisional composition value reaches Codeman's reliable input queue.
5. Exactly the string emitted by xterm `onData` reaches the existing send path exactly once.
6. An old generation cannot clear or repaint a newer generation.
7. Session switch, terminal replacement, blur cancellation, or destruction invalidates scheduled work and clears the
   preview without sending it.
8. Authoritative output always wins over optimistic visual state.

## Failure Handling

- Initialization or rendering errors are contained and leave xterm's input and native composition handling active.
- Missing or unexpected composition events abandon the preview rather than guessing committed bytes.
- A preview timeout clears visual state only; it never retries, drops, or modifies input.
- Offline delivery continues to use the existing durable queue and connection indicator. The preview must not imply
  that provisional text has reached the server.
- Terminal or session generation checks prevent delayed callbacks from painting into a different session.

## Verification

### Unit tests

- A burst of at least 500 composition updates schedules one frame and paints only the latest value.
- Replacement and backspace update the same preview rather than append stale characters.
- Composition commit does not independently send input; the existing xterm `onData` value is forwarded once.
- A source-tagged, printable single-line IME commit uses atomic text prediction.
- Paste, multiline data, control sequences, and unmatched text retain current behavior.
- Stale generations, tab switches, terminal replacement, timeouts, and destruction leave no listeners, timers, frames,
  preview nodes, or sent bytes.

### Browser and integration tests

- Hold a composition open for five seconds: the latest provisional value becomes visible within one animation frame,
  while logical input and PTY bytes remain zero until commit.
- Commit the composition: one exact logical record and one exact PTY byte sequence are observed, with no duplicate,
  missing, or reordered text.
- Fast composition-update bursts produce no frame backlog and no post-stop character-by-character preview drain.
- Exercise English autocorrect replacement, backspace, punctuation, CJK composition, paste, Enter, reconnect, session
  switch, and Codex/OpenCode composer anchors.
- Preserve existing reliable-input, predictive-echo, mobile keyboard, and terminal-input performance suites.

### Physical iPhone acceptance

Final acceptance requires iPhone Chrome with the standard Apple keyboard against a LAN build:

- provisional text is visible within 50 ms of the latest keyboard update;
- stopping after fast typing leaves no visual catch-up lasting more than 100 ms;
- final committed bytes are exact and ordered;
- autocorrect and replacement display the final word without duplicated prefixes;
- Enter submits the intended command once;
- no page errors, serious console errors, focus loss, keyboard dismissal, or terminal corruption occurs.

The physical-device result must be recorded on COD-368. Chromium mobile emulation is necessary regression coverage but
is not sufficient for closing the issue.

## Scope

Implementation stays on `COD-356-performance-improvements` and is tracked by COD-368. Expected changes are limited to
the mobile composition preview/controller, terminal input wiring, predictive visual reconciliation, scoped CSS, and
targeted tests. No server, transport, tmux, or deployment changes are part of this design.
