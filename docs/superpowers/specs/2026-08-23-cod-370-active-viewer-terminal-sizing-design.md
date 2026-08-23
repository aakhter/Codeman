# COD-370 Active-Viewer Terminal Sizing Design

## Summary

Codeman must keep one OpenCode process, conversation, tmux pane, and terminal stream while allowing a user to move between an idle-but-connected desktop browser and an actively used phone. The viewer with the most recent explicit foreground interaction owns the shared terminal dimensions. Background viewers continue receiving output but cannot resize the pane.

On mobile OpenCode, Codeman also uses a smaller device-local terminal font so the fitted grid has enough rows and columns for OpenCode's prompt/status area to occupy a minority of the visible terminal. Returning to desktop restores the desktop grid without restarting or replacing the session.

## Problem

On a 390-pixel iPhone viewport, the production OpenCode session shows oversized terminal text and an OpenCode prompt/status region that consumes much of the usable height. The same session remains open in a desktop browser, but that desktop is not being used.

Current resize arbitration gives a connected desktop a sizing claim and blocks mobile/tablet resizes for 90 seconds after desktop claim registration or typed input. In the reproduced session, the phone fitted approximately 62 columns by 50 rows while the shared tmux pane remained approximately 50 columns by 27 rows. OpenCode therefore continued drawing a short desktop-owned screen inside a taller phone xterm. The stale backend geometry magnified the prompt/status region and left usable phone space idle.

Prior COD-283 browser coverage did not launch a real OpenCode process or session. It validated empty-xterm geometry and CSS strings, so it could pass without detecting this mismatch.

## Goals

- Preserve the exact same Codeman session, OpenCode process, conversation, tmux pane, and terminal byte stream across desktop/mobile handoffs.
- Let a foregrounded or explicitly used phone take sizing ownership immediately, even while an idle desktop remains connected.
- Restore desktop sizing immediately when the user returns to and interacts with desktop.
- Reduce OpenCode terminal text on phones and increase usable rows and columns.
- Prevent background tabs, reconnects, viewport noise, and periodic fit operations from causing resize oscillation.
- Keep terminal input exact and maintain current delivery, retry, and deduplication guarantees.
- Bound the one-time handoff cost without adding work to the steady-state typing hot path.

## Non-goals

- Do not launch OpenCode with `--mini`.
- Do not run a second OpenCode client, agent process, or conversation.
- Do not build a Codeman-native OpenCode conversation renderer.
- Do not parse, filter, hide, or rewrite OpenCode's terminal escape output.
- Do not restart the session when the active device changes.
- Do not change Codeman's bottom Run/Stop/Shell toolbar as part of COD-370.
- Do not make desktop font or sizing behavior follow mobile preferences.

## Architecture

### Viewer identity

Each terminal WebSocket connection already has a connection-scoped lifetime. Extend that connection state with:

- a unique server-owned token;
- the last announced viewport type and fitted dimensions;
- whether the viewer most recently reported itself foregrounded/focused;
- the server-received time of its last explicit activation.

Client timestamps are not authoritative. WebSocket arrival order and a server-owned ownership generation determine which viewer currently owns sizing.

### Single sizing owner

Each `Session` has at most one sizing owner token and a monotonically increasing ownership generation.

Ownership transfers on an explicit viewer activation:

- the document becomes visible or foregrounded;
- the terminal receives focus;
- the user touches or points within the terminal;
- the user provides terminal input.

Opening a socket, reconnecting a background document, or sending an ordinary fit/resize message does not by itself steal ownership.

When no owner exists, the first visible/focused viewer activation becomes owner. When the owner socket closes, the owner is cleared; another viewer must activate before it controls sizing.

### Resize authorization

Only the current sizing owner may apply typed desktop, tablet, or mobile dimensions. Resize messages from other connected viewers are ignored. Legacy or recovery paths may retain an explicitly documented untyped force-resize path, but passive browser traffic must not use it to bypass ownership.

An ownership transfer applies the new owner's most recently fitted dimensions once. Identical dimensions remain deduplicated by the existing PTY dimension check. Background viewer fit operations can continue locally but cannot change the pane.

The existing 90-second desktop preference is removed from browser-viewer arbitration. A timeout cannot reliably distinguish an idle connected desktop from an active one and creates the observed delay when moving to a phone.

### Input fallback

Terminal input itself is an activation signal. If a focus or visibility event was missed, the server transfers ownership before forwarding the input bytes and requests/applies the viewer's last known dimensions. Resize failure never blocks, delays, changes, or drops input; bytes continue through the existing reliable input path.

### Shared geometry reconciliation

After a real PTY dimension change, the existing `resized` event remains authoritative. Every connected viewer reconciles its terminal from the shared tmux capture as needed. The owner sees the layout fitted to its viewport. Passive viewers may temporarily display the owner's geometry until they become active and take ownership.

## Mobile OpenCode Font Policy

OpenCode on a phone defaults to an 8-pixel terminal font instead of the current 10-pixel mobile default. The font is applied before fitting and announcing dimensions.

Mobile and desktop font choices are stored independently so using the phone cannot alter desktop text size. Existing font controls remain available. If profiling demonstrates a material redraw or long-task regression at 8 pixels, the default becomes 9 pixels while retaining 8 pixels as a selectable mobile value.

Other agent modes keep their current mobile defaults unless evidence from their own tests supports a change.

## Data Flow

1. The phone page becomes foregrounded or receives terminal interaction.
2. Codeman applies the device-local OpenCode font, fits xterm, and sends one viewer-activation control message with viewport type and fitted dimensions.
3. The server assigns a new ownership generation to that connection.
4. The server applies the phone dimensions if they differ from the current PTY geometry.
5. OpenCode redraws the same TUI in the larger mobile grid.
6. The session emits its existing shared-geometry event; connected viewers reconcile without acquiring ownership.
7. When the desktop later receives explicit interaction, the same flow transfers ownership and restores its stored dimensions.

Typing does not produce an additional activity message per character. Existing input frames implicitly reinforce ownership, and activation messages are deduplicated/rate-limited on the client.

## Concurrency Rules

- The most recently received explicit activation wins.
- A passive connection cannot regain ownership through resize traffic alone.
- Simultaneous genuine use is supported deterministically: whichever viewer most recently interacts controls geometry.
- A stale activation or resize tied to an older ownership generation cannot overwrite the current owner's dimensions.
- Socket close only releases ownership when the closing token is still the current owner.

## Failure Handling

- If applying a resize fails, retain the last known-good PTY geometry, emit bounded diagnostics, and continue input/output.
- If activation arrives without valid dimensions, record ownership and request/reuse that viewer's last validated dimensions; do not apply invalid values.
- Clamp dimensions through existing terminal bounds before storing or applying them.
- If the owner disconnects during a resize, generation fencing prevents its late work from changing the next owner's geometry.
- If no viewer owns sizing, the current geometry remains stable until explicit activation.
- Repeated identical activation and dimension messages are no-ops.

## Performance Design

The steady-state typing path adds no separate per-character network operation. Connection state is constant-space per viewer, and the server performs no new polling or heartbeat.

A device handoff intentionally performs at most one effective resize and one OpenCode redraw. The target is visible reflow within 300 milliseconds. Background resize retries should decrease because non-owners cannot trigger server work.

At the reproduced viewport, changing from roughly 62 by 50 cells at 10 pixels to roughly 75 by 62 cells at 8 pixels increases terminal cell capacity by about 50 percent. This can increase the cost of full-screen redraws. Acceptance therefore compares input latency, output convergence, long tasks, resize count, and WebSocket bytes at 8 pixels and under CPU load. A 9-pixel default is the predetermined fallback if 8 pixels causes a material regression.

## Testing

### Unit and route tests

- A mobile viewer immediately replaces an idle-but-connected desktop owner.
- A passive desktop resize cannot reclaim ownership.
- Desktop input reclaims ownership and restores its stored dimensions.
- Background connection/reconnection does not claim sizing.
- Owner disconnect clears ownership without clearing a newer owner.
- Stale ownership generations cannot resize.
- Invalid dimensions do not replace last-known-good dimensions.
- Resize failure does not block or alter input bytes.
- Identical activation and resize messages do not cause repeated PTY resizes.

### Two-browser integration

Use one desktop context and one 390-pixel phone context connected to the same real disposable OpenCode session:

1. Establish desktop geometry.
2. Leave desktop connected and idle.
3. Foreground/interact with the phone and verify immediate ownership and mobile pane dimensions.
4. Type on mobile and verify exact logical, durable, and PTY bytes with no duplication, loss, or reordering.
5. Return to desktop, interact, and verify desktop geometry restoration.
6. Confirm the Codeman session ID, OpenCode process, and tmux pane identities never change.

### Mobile visual and geometry acceptance

- Use a real OpenCode TUI, not an empty xterm fixture.
- At 390 pixels with keyboard hidden, backend pane dimensions match the phone's proposed dimensions and provide at least 45 rows rather than remaining near 27.
- The OpenCode prompt/status region occupies a minority of visible terminal height.
- Phone reflow and desktop restoration each complete within 300 milliseconds.
- Keyboard focus, scrolling, and rotation remain functional.

### Performance acceptance

Run before/after measurements under idle host conditions and 4x browser CPU throttling:

- typing-to-visible median and p95 do not materially regress;
- no input byte correctness failure occurs;
- each ownership transfer causes at most one effective PTY resize after viewport settlement;
- no resize loop or background reclaim occurs;
- browser long-task and WebGL fallback behavior do not materially regress;
- the 8-pixel grid is retained only if it meets these gates, otherwise use the specified 9-pixel fallback.

Final acceptance requires physical iPhone Chrome verification of desktop-to-phone-to-desktop handoff with the desktop browser left connected but idle.

## Rollout

The change is scoped to browser terminal sizing arbitration and the OpenCode mobile font default. It does not migrate stored sessions or alter OpenCode command construction. Deploy behind the existing web release process, verify one real OpenCode session on desktop and iPhone, then retain only if geometry, input correctness, and performance gates pass.

## Rejected Alternatives

### Session-level OpenCode `--mini`

Rejected because the same session moves between desktop and mobile. A session-level UI mode would make one device inherit the other device's compromise.

### Separate full and mini OpenCode clients

Rejected because the user requires one existing terminal session rather than parallel presentation clients, and multiple interactive clients add synchronization and input-ownership complexity.

### Codeman-native mobile conversation UI

Rejected as disproportionate scope and a long-term feature-parity risk.

### Shorter desktop timeout

Rejected because it preserves a delay and allows background activity to fight foreground sizing.

### Font reduction only

Rejected as incomplete because a phone can still display a short desktop-owned backend grid inside a taller local xterm.
