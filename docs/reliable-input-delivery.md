# Reliable input delivery (exactly-once, durable)

## The bug this fixes

With local echo on, pressing Enter cleared the overlay and then sent the prompt
over the WebSocket **fire-and-forget** (`ws.send({t:'i',d})`). On a flaky link
(e.g. a moving train) the socket is frequently _half-open_: `readyState === OPEN`
so `ws.send()` does **not** throw, but the underlying TCP is dead, so the frame is
silently discarded. Nothing was enqueued (the send "succeeded"), the on-screen
prompt was already wiped, and `navigator.onLine` stays `true` — so a long typed
prompt vanished with no trace and no resend.

## The guarantee

Every byte of browser terminal input is **recorded durably before delivery** and
**only dropped once the server ACKs it**, while the target session still exists.
A half-open socket, a transient reconnect, or a page reload therefore cannot lose
input. Redelivery is **exactly-once**: the server applies each `(clientId, seq)`
at most once, so a resend can't type the prompt twice. If the terminal endpoint
authoritatively reports that the session is gone (WS close 4004/4009), its
undeliverable queue is discarded and the UI says the session ended.

## How it works

### Client (`app.js`)

- A stable **`clientId`** (`localStorage['codeman:clientId']`) identifies this
  browser to the server's dedup across reconnects and reloads.
- Each input frame gets a **monotonic per-session `seq`**. Frame records
  (`{seq,data,useMux,ts,tries,sentAt}`) live in `_pendingDeliveries`
  (`Map<sessionId, record[]>`), persisted (debounced, + flushed on `pagehide`/
  `visibilitychange`) to `localStorage['codeman:pendingInput']`. The seq counters
  persist too, so seqs stay monotonic across reloads (never reset — a reset would
  let the server treat fresh input as an already-applied duplicate).
- **Delivery** (`_drainSession`) uses only the session's ownership-capable WS.
  When that socket is `OPEN`, the browser first sends viewer activation (`va`)
  and the latest ownership-fenced geometry (`z`), then sends each not-yet-sent
  input record (`sentAt === 0`) in seq order. Records stay pending until the
  server's `{t:'ia',seq}` ACK removes them. Browser code does **not** fall back to
  `POST /input`, because that would bypass active-viewer ownership.
- **Transient outage** — records remain persisted and queued until the exact
  session gets a fresh activated WS. A 4004/4009 close is terminal rather than
  transient: only that dead session's queue, pending resize, and viewer activity
  are cleared, persistence is flushed immediately, no reconnect is scheduled,
  and further input, resize, restore, and manual terminal reconnect actions are
  rejected for the still-selected dead terminal. The connection-loss retry can
  still reconnect SSE without reopening that terminal WS.
- **Half-open recovery** (`_redeliverSweep`, every 2s): if the active WS session's
  oldest record is unacked past `_reliableAckTimeoutMs` (4s), the socket is assumed
  dead — `ws.close()` forces a fast reconnect; `onopen` (`_onWsReady`) resets
  `sentAt = 0` and re-sends everything pending after viewer activation. Background
  sessions remain queued until they become the active WS session. The sweep also
  fires on SSE reconnect / `online`.
- The connection indicator shows pending count/bytes (`_pendingBytes`).

### Server

- **`Session.shouldApplyInput(clientId, seq)`** — returns `true` exactly once per
  `(clientId, seq)`: the first time a seq strictly greater than that client's
  last-applied is seen. A replayed/lower seq returns `false`. Bounded MRU map
  (`MAX_INPUT_DEDUP_CLIENTS = 256`).
- **WS route** (`ws-routes.ts`) — parses optional `cid`/`seq` on `{t:'i'}`; applies
  via `shouldApplyInput` (skips a duplicate, still ACKs with `{t:'ia',seq}` so the
  client drops it). Untagged frames apply unconditionally (no behavior change).
- **POST route** (`/api/sessions/:id/input`) remains available to non-browser and
  external API callers. Optional `seq`/`clientId` in `SessionInputWithLimitSchema`
  provides deduplication; a duplicate returns 200 without writing. Browser
  terminal delivery does not call this route.

## Known limitation

Dedup state is in-memory on the server. A **server restart** between a write and
the client's redelivery of that same seq could re-apply it (a rare duplicate).
This is a deliberate trade-off: favor _never losing input_ over a rare duplicate
across the narrow restart window.

## Tests

- `test/reliable-input-dedup.test.ts` — `Session.shouldApplyInput` exactly-once
  semantics (monotonic, per-client, gap-tolerant, eviction-safe).
- `test/routes/session-routes.test.ts` — POST `/input` applies a tagged
  `(clientId, seq)` once on redelivery; untagged input always applies.
- `test/ws-state-lifecycle.test.ts` — browser input activates the exact fresh WS
  before replay and fails closed, without HTTP or cross-session deletion, when
  the terminal reports 4004/4009.
