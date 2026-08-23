# COD-359 Upstream Owner-Scoped Tab-Layout Foundation Design

## Goal

Extract the reviewed non-visual tab-layout foundation delivered by COD-308, COD-304, and COD-303 into a focused branch
based on `upstream/master`. The branch provides the pure semantic model, owner-scoped persistence and migration,
authoritative coordination service, authenticated versioned API, lifecycle repair, and minimal SSE invalidation required by
later grouped-rail work.

The extraction freezes behavior at historical commit `b9526f09`, the final reviewed COD-303 correction. It does not import
later downstream additions merely because they now live in the same modules.

## Selected Approach

Replay and audit the nine reviewed commits in dependency order:

1. COD-308: `8d86435a`, `37d6b4d6`, `2c09de85`;
2. COD-304: `7513dc89`, `d7152800`;
3. COD-303: `7db0590c`, `ccaccfc1`, `d02ed887`, `b9526f09`.

Each commit is applied separately to a clean `upstream/master` branch. Conflicts are resolved against the responsibility of
that commit and audited against its historical patch, rather than accepting either side wholesale. Preserve the original
review-sized commit boundaries where upstream compatibility permits it.

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

### Coordination service

`src/tab-layout-service.ts` is the only authoritative mutation boundary. It gathers persisted sessions, live sessions, and
saved webviews; normalizes them through the pure model; serializes work per owner; commits at most one version increment for
one completed action; persists before broadcasting; and provides lifecycle wrappers for atomic creation, deletion, and
stale cleanup.

The service retains the historical restoration state machine. Deletion-sensitive work fails closed while restoration is
pending. Startup explicitly marks restoration complete, failed, or skipped in tests, then reconciles layouts only when it
is safe to distinguish stale records from sessions that have not yet been restored.

### API and SSE boundary

`GET /api/tab-layout` returns the authenticated owner's authoritative layout. `PUT /api/tab-layout` accepts exactly
`{ baseVersion, layout }`, applies a 128 KiB body limit, and performs an exact-version compare before validation and commit.
The request cannot provide an owner key.

Successful mutations emit the minimal tab-layout SSE invalidation through the existing registry and owner filtering. The
event does not duplicate the layout; consumers refetch. Registry parity may require the corresponding public event token,
but this branch adds no browser handler, renderer, projection, settings UI, or grouped-rail DOM.

## Data Flow

1. A route or lifecycle caller derives the owner from authenticated/server-owned state.
2. The service reads that owner's stored layout and authoritative session/webview facts.
3. Persistence primitives migrate a missing layout or the model normalizes an existing one without mutating caller input.
4. A GET returns the normalized authoritative layout.
5. A PUT enters the owner's serialized queue. If `baseVersion` differs from the current version, it returns a conflict with
   the current layout and performs no write.
6. A valid matching PUT stores one incremented layout, then emits one owner-filtered invalidation.
7. Session, Ralph, cron, and webview creation hooks update layout only after their underlying creation succeeds. Session,
   webview, and stale cleanup paths coordinate the underlying deletion and layout repair transactionally.

## Boundaries

Included:

- historical COD-308 model and its reviewed follow-parent replay correction;
- historical COD-304 owner persistence, legacy migration, and authoritative live-record correction;
- historical COD-303 GET/PUT API, per-owner serialization, restoration gate, lifecycle atomicity, deletion repair, stale
  cleanup transaction, and SSE invalidation;
- the minimum route-port, server, state, session/webview/Ralph/cron, event-registry, mock, and test wiring needed by those
  behaviors;
- a minor changeset for the new versioned owner-scoped API.

Excluded:

- browser layout fetching, grouped or flat rendering, collapse UI, lineage drawing, editing UI, drag/drop, menus, and
  accessibility tree behavior;
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
- Owner queues continue after a rejected operation and never serialize unrelated owners behind one another.
- Persistence completes before invalidation. A failed store write propagates and cannot announce a state that was not
  committed.
- Restoration-pending deletion paths fail closed. Restoration failure or explicit test skip releases the gate without
  incorrectly pruning sessions that were never proven stale.
- Creation hooks run only after successful underlying creation. Transactional deletion wrappers prevent layout repair and
  runtime deletion from observing conflicting intermediate states.
- Multi-owner stale cleanup acquires owner queues in stable order to avoid deadlock and performs the cleanup action once.

## Verification

Focused verification will prove:

- model validation, defensive cloning, capacity bounds, deterministic normalization, lineage following, orphan handling,
  immutable group/ref operations, and reviewed follow-parent replay safety;
- owner-key derivation, single-user compatibility, deterministic/idempotent migration, restart persistence, foreign-owner
  isolation, and authoritative replacement by live records;
- exact-version conflicts, per-owner serialization, queue recovery after failure, one-write/one-event commits, atomic
  validation and persistence failures, restoration gating, deletion repair, and stable multi-owner stale cleanup;
- authenticated GET/PUT envelopes, owner isolation, the 128 KiB body limit, `400` validation responses, and `409` conflict
  responses through focused Fastify injection tests;
- session, webview, Ralph, cron, restore, cleanup, route-port, SSE filtering, and event-registry integration required by the
  historical series;
- an isolated server API smoke test covering authenticated owner-scoped GET, one successful PUT, and one stale-version
  conflict without exercising browser rendering.

Run only explicitly named safe test files from the managed session. Finish with typecheck, lint, formatting, lockfile,
frontend-syntax/event-parity checks, and the production build. Audit the final branch diff against `upstream/master`, the
nine historical patches, and the scoped `b9526f09` snapshot. Confirm that no browser rendering or post-cutpoint service/API
surface entered the branch.

## Delivery

Create `cod-359-upstream-tab-layout-foundation` in an isolated worktree from a freshly fetched `upstream/master`. Keep the
audited historical series in review-sized commits, add the changeset as a final release-metadata commit, and push only to
Bitbucket `origin`. Preserve the worktree for review; do not merge into `local` or deploy until the user explicitly selects
that finishing action.
