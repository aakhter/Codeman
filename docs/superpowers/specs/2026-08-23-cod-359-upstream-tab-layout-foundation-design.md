# COD-359 Upstream Owner-Scoped Tab-Layout Foundation Design

## Goal

Extract the reviewed non-visual tab-layout foundation delivered by COD-308, COD-304, and COD-303 into a focused branch
based on `upstream/master`. The branch provides the pure semantic model, owner-scoped persistence and migration,
authoritative coordination service, authenticated versioned API, lifecycle repair, and minimal SSE invalidation required by
later grouped-rail work.

The extraction freezes its feature surface at historical commit `b9526f09`, the final reviewed COD-303 correction. It does
not import later downstream additions merely because they now live in the same modules. Two extraction corrections are
required: preserve upstream's legacy session-order contract until COD-360 supplies a browser consumer, and prevent a PUT
from persisting reconciliation before its version check.

## Selected Approach

Replay and audit the nine reviewed commits in dependency order:

1. COD-308: `8d86435a`, `37d6b4d6`, `2c09de85`;
2. COD-304: `7513dc89`, `d7152800`;
3. COD-303: `7db0590c`, `ccaccfc1`, `d02ed887`, `b9526f09`.

Each commit is applied separately to a clean `upstream/master` branch. Conflicts are resolved against the responsibility of
that commit and audited against its historical patch, rather than accepting either side wholesale. Preserve the original
review-sized commit boundaries where upstream compatibility permits it. Add focused compatibility/correctness commits for
the two extraction corrections rather than rewriting the historical patches invisibly.

Rejected alternatives:

- Copy the complete scoped-file snapshot from `b9526f09`. This produces a shorter history but obscures which lifecycle
  guarantees came from each review correction and makes omissions harder to detect.
- Start from current `local` and prune later behavior. The current model and service contain Focus flags, semantic-operation
  replay, case-default placement, and other later integrations that would leak COD-360/361/362 scope into this foundation.

## Architecture

### Pure semantic model

`src/tab-layout.ts` remains framework-independent. It defines versioned layouts, named groups, session/webview references,
owner-supplied metadata, validation limits, deterministic normalization, lineage-derived placement, orphan materialization,
and immutable group/ref manipulation primitives. It has no route, persistence, runtime-session, SSE, or browser dependency.

The model includes group mutation primitives needed by later consumers, but COD-359 does not expose the later semantic
operation protocol over HTTP. It also excludes later Focus flags and Focus-group behavior.

### Owner-scoped persistence

`src/tab-layout-persistence.ts`, `src/types/app-state.ts`, and `src/state-store.ts` store layouts by a server-derived owner key.
Single-user mode uses the stable `@single` key. Multi-user requests resolve their authenticated username; clients never
submit or select an owner key.

When an owner has no layout, migration deterministically converts legacy session order plus saved webviews into one flat
ungrouped layout. Persisted sessions seed restart recovery, matching live sessions replace their records authoritatively,
and foreign-owner records never enter the owner's layout. Re-running migration is idempotent and never overwrites an
existing owner layout.

COD-359 retains upstream's legacy ordering contract alongside the new owner layout. `/api/status` continues to expose
`sessionOrder`, and `PUT /api/session-order` continues to validate, merge, persist, and broadcast legacy order updates. The
new migration reads that order, but the old contract is not made read-only until COD-360 migrates the browser to
`/api/tab-layout`. This avoids silently disabling ordering for existing browsers and cross-device clients between PRs.

The two contracts are synchronized rather than independent. The legacy PUT derives the authenticated owner, enters that
owner's service queue, applies the merged session rank to the owner layout, commits at most one changed layout, and returns
the canonical flattened session projection. For the normal pre-COD-360 flat layout, the effective legacy order after the
existing server-known-ID merge is preserved exactly. If an API client has already introduced groups, the bridge preserves
group membership and group order, ranks session refs within their existing containers, and leaves webview slots stable;
the returned legacy projection reflects that canonical grouped result rather than destroying structure the old client
cannot represent.

Conversely, every successful layout initialization, normalization, lifecycle commit, or PUT refreshes the stored legacy
session-order projection from the canonical flattened owner session refs while preserving server-known IDs outside that
owner. It emits `session:orderChanged` only when that projection changes. This makes `/api/status.sessionOrder` a
compatibility projection of the owner layout after initialization, prevents a later legacy reorder from leaving a stale
stored layout, and gives COD-360 a safe cutover GET without overwriting either side.

`StateStore` gains one validated combined write primitive for operations that change both representations. It prepares the
next `tabLayouts[owner]` value and global `sessionOrder` projection in memory, persists them through one state-file save,
and makes neither visible if validation or persistence fails. Service code emits layout and legacy invalidations only after
that combined save succeeds. Operations that change only one representation may retain their focused setter, but may not
implement synchronization as two independently observable writes.

### Coordination service

`src/tab-layout-service.ts` is the only authoritative mutation boundary. It gathers persisted sessions, live sessions, and
saved webviews; normalizes them through the pure model; serializes work per owner; persists before broadcasting; and
provides lifecycle wrappers for atomic creation, deletion, and stale cleanup.

GET and lifecycle reconciliation may persist one initialization or normalization update. PUT uses a side-effect-free
reconciliation preparation path: it derives the same authoritative base and version that GET would produce without storing
or broadcasting, compares `baseVersion`, and only then commits the normalized requested layout. A stale PUT therefore
writes nothing; a matching direct-first or normalization-requiring PUT collapses reconciliation plus the requested change
into one tab-layout version change and one tab-layout invalidation. When its flattened session order also changes, the
layout and legacy projection are persisted atomically in one combined state save before both applicable invalidations; a
conflict updates neither representation.

The service retains the historical restoration state machine. Deletion-sensitive work fails closed while restoration is
pending or failed. Only successful completion or an explicit test-only skip unlocks destructive cleanup. Startup
reconciles layouts only after successful restoration, when it is safe to distinguish stale records from sessions that have
not yet been restored.

### API and SSE boundary

`GET /api/tab-layout` returns the authenticated owner's authoritative layout. `PUT /api/tab-layout` accepts exactly
`{ baseVersion, layout }`, applies a 128 KiB body limit, and performs an exact-version compare against the side-effect-free
reconciled base before validation and commit. The request cannot provide an owner key. The legacy session-order status
field, PUT route, and `session:orderChanged` event remain intact as a synchronized temporary compatibility surface.

Successful mutations emit the minimal tab-layout SSE invalidation through the existing registry and owner filtering. The
event does not duplicate the layout; consumers refetch. Registry parity may require the corresponding public event token,
but this branch adds no browser handler, renderer, projection, settings UI, or grouped-rail DOM.

## Data Flow

1. A route or lifecycle caller derives the owner from authenticated/server-owned state.
2. The service reads that owner's stored layout and authoritative session/webview facts.
3. Persistence primitives derive migration or normalization without mutating caller input.
4. A GET persists at most one required reconciliation, synchronizes the legacy projection if needed, emits only the events
   for changed stores, and returns the authoritative layout.
5. A PUT enters the owner's serialized queue and prepares the reconciled base without side effects. If `baseVersion`
   differs from that prepared version, it returns the prepared authoritative layout and performs no write or invalidation.
6. A valid matching PUT normalizes the requested layout against the same facts, stores one incremented result, synchronizes
   the legacy projection, then emits the applicable owner-filtered layout and legacy-order invalidations. Initialization or
   normalization is folded into that single layout commit and, when necessary, its atomic compatibility projection save.
7. Existing browsers continue reading and writing `sessionOrder` until COD-360 migrates them. A legacy PUT is translated
   through the owner queue into the canonical layout and then returned/broadcast as its flattened compatibility projection.
8. Session, Ralph, cron, and webview creation hooks update layout only after their underlying creation succeeds. Session,
   webview, and stale cleanup paths coordinate the underlying deletion and layout repair transactionally.

## Boundaries

Included:

- historical COD-308 model and its reviewed follow-parent replay correction;
- historical COD-304 owner persistence, legacy migration, and authoritative live-record correction;
- historical COD-303 GET/PUT API, per-owner serialization, restoration gate, lifecycle atomicity, deletion repair, stale
  cleanup transaction, and SSE invalidation;
- temporary preservation of upstream's legacy `/api/status.sessionOrder`, writable `/api/session-order`, merge behavior,
  persistence, and `session:orderChanged` broadcast until the browser migration lands, with bidirectional synchronization
  through the owner layout service;
- an extraction-specific side-effect-free PUT reconciliation path with no-write conflict and single-write direct-first
  guarantees;
- a validated combined StateStore persistence primitive for atomic layout-and-legacy-projection updates;
- the minimum route-port, server, state, session/webview/Ralph/cron, event-registry, mock, and test wiring needed by those
  behaviors;
- a minor changeset for the new versioned owner-scoped API.

Excluded:

- new browser layout fetching, grouped or flat rendering, collapse UI, lineage drawing, editing UI, drag/drop, menus, and
  accessibility tree behavior; the existing legacy session-order browser behavior remains operational;
- HTTP semantic-operation replay, recovery-base layouts, Focus flags/groups, search, case-default groups, automatic child
  placement, Session Bridge placement, and saved-webview UI integration;
- unrelated downstream refactors or fixes that happen to touch the same large server or route files;
- writes, branches, pull requests, or comments on the read-only GitHub `upstream` remote;
- production deployment from the upstream review branch.

## Failure Handling

- Invalid bodies, layouts, names, references, limits, or versions fail with `400 INVALID_INPUT`; parsing and normalization
  are atomic.
- A stale `baseVersion` returns `409 CONFLICT` with the current authoritative layout and causes no persistence write or SSE
  event.
- A matching PUT against a missing or normalization-requiring layout folds reconciliation and the requested update into one
  stored layout version and one layout invalidation; it never exposes an intermediate persisted layout. A changed legacy
  projection adds its event but is part of the same atomic state save, not a second write or layout version.
- Owner queues continue after a rejected operation and never serialize unrelated owners behind one another.
- Persistence completes before invalidation. A failed store write propagates and cannot announce a state that was not
  committed. A combined layout/projection failure leaves both prior representations intact and emits neither event.
- Legacy-to-layout translation is serialized with all other owner mutations. Flat layouts honor the merged legacy order;
  grouped layouts preserve group membership/order and webview slots. Layout-to-legacy projection preserves server-known
  IDs outside the owner and emits no event when the projection is unchanged.
- Restoration-pending and restoration-failed deletion paths remain closed. Only successful restoration or an explicit
  test-only skip unlocks destructive cleanup; failed restoration cannot prune sessions that were never proven stale.
- Creation hooks run only after successful underlying creation. Transactional deletion wrappers prevent layout repair and
  runtime deletion from observing conflicting intermediate states.
- Multi-owner stale cleanup acquires owner queues in stable order to avoid deadlock and performs the cleanup action once.

## Verification

Focused verification will prove:

- model validation, defensive cloning, capacity bounds, deterministic normalization, lineage following, orphan handling,
  immutable group/ref operations, and reviewed follow-parent replay safety;
- owner-key derivation, single-user compatibility, deterministic/idempotent migration, restart persistence, foreign-owner
  isolation, and authoritative replacement by live records;
- preservation of the legacy status field and writable session-order route, including validation, server-known ID merge,
  persistence, cross-device broadcast, migration use, and bidirectional compatibility synchronization until COD-360
  replaces the browser consumer;
- exact-version conflicts, per-owner serialization, queue recovery after failure, one layout version/invalidation per
  commit, atomic combined projection saves, validation and persistence failures, side-effect-free conflict reconciliation,
  single-write direct-first and normalized PUTs, restoration success/failure/skip gating, deletion repair, and stable
  multi-owner stale cleanup;
- authenticated GET/PUT envelopes, owner isolation, the 128 KiB body limit, `400` validation responses, and `409` conflict
  responses through focused Fastify injection tests;
- session, webview, Ralph, cron, restore, cleanup, route-port, SSE filtering, and event-registry integration required by the
  historical series;
- an isolated server API smoke test covering the preserved legacy ordering contract, authenticated owner-scoped GET, one
  successful direct-first PUT, and one stale-version no-write conflict without exercising new browser rendering.

The compatibility regression must explicitly exercise: initialize an owner layout, submit a legacy reorder, then perform a
COD-360-style tab-layout GET and verify that it returns the reordered canonical layout. Additional coverage must prove the
reverse projection after a layout PUT, no event on an unchanged projection, foreign/server-known ID preservation, and
group/webview preservation when an old client submits an order it cannot fully represent.

Run only explicitly named safe test files from the managed session. Finish with typecheck, lint, formatting, lockfile,
frontend-syntax/event-parity checks, and the production build. Audit the final branch diff against `upstream/master`, the
nine historical patches, and the scoped `b9526f09` snapshot. Confirm that no browser rendering or post-cutpoint service/API
surface entered the branch.

## Delivery

Create `cod-359-upstream-tab-layout-foundation` in an isolated worktree from a freshly fetched `upstream/master`. Keep the
audited historical series in review-sized commits, add the changeset as a final release-metadata commit, and push only to
Bitbucket `origin`. Preserve the worktree for review; do not merge into `local` or deploy until the user explicitly selects
that finishing action.
