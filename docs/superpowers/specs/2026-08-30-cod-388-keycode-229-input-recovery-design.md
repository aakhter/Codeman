# COD-388 keyCode 229 Input Recovery Design

## Problem

In production, `w1-home-mon` accepts focus and keyboard events but can show no typed text and ignore Enter. The same
browser tab can type in `w2-Codeman`, while the affected session's WebSocket, tmux pane, PTY, replay, and file APIs
remain healthy.

The failing boundary is reproducible in Chromium: dispatch a non-composing `keydown` with `keyCode === 229`, an
explicit printable `key` (or Enter), and no helper-textarea mutation. xterm's `CompositionHelper` treats 229 as a
possible IME commit, schedules a textarea diff, and emits nothing when the value did not change. There is then no
`onData`, WebSocket input frame, or PTY byte. Existing coverage exercises 229 only when `insertText` also mutates the
helper textarea.

## Goals

- Recover an explicit printable key or Enter when xterm's 229 path emits no canonical data.
- Deliver recovered input through Codeman's existing terminal-data path exactly once.
- Preserve real composition, autocorrect, punctuation, shortcuts, local echo, reliable input sequencing, and query
  filtering.
- Keep the change browser-only and scoped to the terminal instance that observed the event.
- Clean up every listener and timer when xterm is replaced.

## Non-goals

- Changing the terminal WebSocket, server deduplication, tmux, PTY, or Codex process.
- Recovering `Process`, `Unidentified`, `Dead`, modifier chords, or `isComposing === true` events.
- Replacing or patching xterm's composition implementation.
- Guessing text from keyboard layout codes when `KeyboardEvent.key` is not explicit.

## Considered Approaches

### 1. Bounded exact-once recovery around xterm input — selected

Observe eligible 229 keydowns, allow xterm's own textarea-diff task to run first, and recover only if no matching
canonical `onData`, textarea input, or composition lifecycle event arrives. Route the recovered byte through the same
Codeman handler used by xterm. A short-lived key token suppresses a delayed matching canonical input from the same
event.

This is narrow, testable, and leaves xterm authoritative whenever the browser supplies usable input.

### 2. Patch the vendored xterm composition helper

Changing xterm could recover the symptom closer to its source, but creates a vendor fork and risks every supported IME.
It is rejected because the browser anomaly is Codeman-specific and can be fenced without changing xterm semantics.

### 3. Route all keyCode 229 events through the visible CJK field

This would change focus, keyboard, and terminal-editing behavior for physical keyboards and non-CJK users. It is too
intrusive and is rejected.

## Architecture

### Recovery controller

Add a small browser module loaded after xterm and before `terminal-ui.js`. One controller is created for the current
xterm helper textarea and destroyed before terminal replacement.

For every keydown the controller advances a monotonically increasing key token. It arms recovery only when all of the
following are true:

- `type === 'keydown'` and `keyCode === 229`;
- `isComposing === false`;
- no Ctrl, Alt, Meta, or AltGraph modifier is active;
- `key` is exactly one printable Unicode character, or `key === 'Enter'`;
- `key` is not `Process`, `Unidentified`, or `Dead`.

The candidate stores its token and canonical terminal data (`key`, or `\r` for Enter). A microtask schedules the
recovery timer after xterm has returned from its keydown handler, which means xterm's own zero-delay textarea diff was
queued first. Any matching canonical `onData`, textarea `input`, or composition start cancels the candidate.

If the candidate remains unresolved after xterm's task, the controller invokes a supplied recovery callback once. The
callback enters the existing Codeman terminal-data handler, preserving history exit, CJK safety, query filtering,
one-shot modifiers, local echo, reliable sequencing, and diagnostics.

### Late canonical deduplication

After recovery, the controller keeps a short-lived record containing the recovered byte and originating key token. An
`input` capture listener records which key token owns the synchronous browser input dispatch. If xterm emits the same
byte during that related input event, the controller consumes it instead of forwarding it a second time.

Canonical data always wins before recovery. Pending candidates are matched before recovered records so rapid repeated
229 keys remain one byte per key. A newer ordinary keydown changes the current token, preventing its same-character
input from being mistaken for a delayed duplicate. Recovery and deduplication records expire promptly and are cleared
on composition start, blur, destroy, or terminal replacement.

### Failure behavior

The controller fails open. Missing globals, listener errors, or scheduling errors leave the existing xterm path active.
No fallback is attempted without an explicit recoverable `key`. Cleanup never sends data. The module does not mutate
the xterm textarea or synthesize composition events.

## Verification

### Unit tests

- Recover printable text and Enter only after xterm's canonical opportunity is empty.
- Cancel recovery when matching `onData`, input, or composition arrives first.
- Suppress one delayed matching canonical event from the same token.
- Preserve rapid repeated 229 keys and an immediate ordinary same-character key.
- Reject composing, `Process`, `Unidentified`, `Dead`, shortcut, modifier, and keyup events.
- Destroy cancels queued work and removes listeners.

### Real-browser tests

- Reproduce the production failure with 229 keydown/keyup and no textarea mutation, then observe one logical character
  and one Enter through the Codeman input path.
- Follow 229 with a real textarea mutation and prove one, not two, terminal records.
- Preserve Chinese composition plus full-width punctuation.
- Preserve ordinary typing and shortcut behavior.

### Delivery verification

- Run the focused unit and browser files plus typecheck, lint, format, lockfile, frontend syntax, public-asset, browser
  exclusion, and production build gates.
- After deployment, open the exact production `w1-home-mon` session in a fresh Chromium context, send a unique marker
  and Enter, verify the marker in both xterm and tmux, clear it without submitting a command, and check browser console,
  WebSocket acknowledgements, service health, and HTTP responses.

## Scope

Expected files are the recovery module, terminal integration, HTML/build asset wiring, focused unit/browser tests,
release changeset, generated release metadata, and these design/plan documents. No backend protocol or session-state
change is included.
