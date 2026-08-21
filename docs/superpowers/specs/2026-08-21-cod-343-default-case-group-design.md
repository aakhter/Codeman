# COD-343 Per-Case Default Session Group Design

## Problem

Codeman's vertical session rail has owner-scoped named groups such as `codeman`, `tcc`, and `nzbdav`, plus
`Ungrouped`. Session creation can already target a group explicitly through COD-320, but ordinary launches have no
case-level default. A user who wants every new `nzbdav` session in the `nzbdav` group must move each session after
creation.

COD-343 adds a server-authoritative default group per owner and case. The setting follows the signed-in user across
devices and applies to every supported launch mode while preserving explicit group placement and child lineage.

## Scope

- Add a **Default session group** selector to desktop and mobile Case Settings.
- List the authenticated owner's current named vertical-rail groups plus `Ungrouped`.
- Persist the selection per owner and case in Codeman state.
- Apply the default during authoritative session-layout creation for local, linked-local, remote, and Docker cases.
- Preserve explicit COD-320 placement, parent/follow-parent behavior, and atomic first render.
- Migrate or remove the setting when its case is renamed or deleted.

The feature does not create groups, move existing sessions, change browser-local Agent Teams or 1M Opus settings,
or make group defaults global across users.

## Persistence and identity

`AppState` gains an optional owner-scoped map:

```ts
caseDefaultGroups?: Record<string, Record<string, string | null>>;
```

The outer key is the same owner layout key used by `TabLayoutService` (`@single` in single-user mode or the
authenticated username in multi-user mode). The inner key is the case name visible in the case picker. The value is
the stable tab-group ID; `null` means an intentional `Ungrouped` selection. Missing legacy state behaves as
`Ungrouped`, so no migration is required.

`StateStore` owns validated get/set/rename/delete accessors. Case names and group IDs use the existing bounded input
rules. Case rename moves the authenticated owner's mapping from the old name to the new name. Case deletion or
unlink removes it. Group renames require no migration because the stored ID is stable.

## Owner-scoped API

Case routes expose:

- `GET /api/cases/:name/default-group`
- `PUT /api/cases/:name/default-group` with `{ "groupId": string | null }`

Both routes resolve the authenticated owner, verify that the named case is accessible to that owner, and never accept
an owner override from the client. GET returns the effective selection and the current named group options from the
owner's authoritative tab layout. PUT accepts `null` or a group ID that currently exists in that layout; unknown IDs
return the standard invalid-input response without changing state.

If a previously stored group no longer exists, GET returns `null` and clears the stale value. Session creation performs
the same validation, so a stale selection can never block a launch.

## Session creation and precedence

Both `POST /api/sessions` and `POST /api/quick-start` pass a resolved case name into the central session-registration
path. Quick Start already has an explicit case name. The general session route uses its `caseName` when supplied and
otherwise matches the normalized working directory against cases accessible to the caller. A request that is not
associated with a known case receives no case default and keeps existing behavior.

The route context carries a typed placement hint instead of performing a later client-side move. Under the existing
per-owner `TabLayoutService` mutation lock, session creation reconciles the new session and applies this precedence:

1. A valid explicit `tabGroupId` supplied by COD-320 or an API caller.
2. Valid existing parent/follow-parent placement.
3. The case's valid configured default group.
4. `Ungrouped`.

An explicit group placement remains marked `manual`, matching COD-320. A case-default placement is automatic and is
not marked manual. An invalid explicit group retains the existing non-failing behavior and does not silently turn into
a different explicit destination. Missing/deleted case defaults clear to `Ungrouped`.

The registration callback, layout reconciliation, placement, persistence, and SSE broadcast remain one transaction.
Creation responses include the authoritative layout whenever either an explicit group or a case default affected
placement. The browser adopts that layout before rendering or selecting the new tab, preventing an
Ungrouped-to-group visual jump.

## Case Settings UI

Desktop and mobile Case Settings add an accessible labeled `<select>` named **Default session group**. Opening either
popover fetches the selected case's server setting and rebuilds the options in current layout order:

1. `Ungrouped`
2. Each named owner group using its stable ID and current display name

Changing the selector saves immediately through the owner-scoped PUT endpoint. The control is disabled while loading
or saving. On failure, it restores the last confirmed value and uses the existing toast/error pattern. Desktop and
mobile controls mirror the confirmed server value.

Opening the popover always refreshes from the server. Case changes and accepted tab-layout updates invalidate cached
options, so newly created, renamed, or deleted groups appear correctly the next time the popover opens. Another device
does not need to send the setting with its launch: server-side creation reads the shared value directly.

## Failure handling and lifecycle

- Unknown or unauthorized cases use existing not-found/forbidden responses and expose no group names.
- Invalid group IDs are rejected on PUT without altering the previous value.
- A group deleted between selection and launch falls back to `Ungrouped`, clears the stale mapping, and does not fail
  session creation.
- A case rename migrates only the authenticated owner's mapping after the case update succeeds.
- A case delete/unlink clears only the authenticated owner's mapping after the case removal succeeds.
- Changing a default affects future sessions only.
- Session creation rollback continues to remove a partially registered session and leaves no phantom layout reference.

## Verification

Focused automated coverage will prove:

- state round-trip, owner isolation, legacy-state compatibility, case rename, and case deletion;
- API authentication, case access checks, current options, valid/null saves, invalid-group rejection, and stale fallback;
- explicit-group > parent-follow > case-default > Ungrouped precedence;
- automatic placement is not marked manual, while explicit placement remains manual;
- local, linked-local, remote, Docker, and every supported CLI launch path carry the case identity;
- authoritative response/SSE adoption renders directly in the final group;
- desktop/mobile selector loading, saving, mirroring, error reversion, and group-option refresh;
- existing COD-320, lineage, tab-layout concurrency, and case lifecycle behavior remains green.

Before deployment, run typecheck, lint, formatting, lockfile, frontend syntax, browser exclusions, a production build,
focused Node/Chromium tests, and the realistic Codeman smoke. Live LAN acceptance will set `nzbdav` to the existing
`nzbdav` group through Case Settings, create a disposable session through the normal UI, confirm its first rendered
location is the target group, then remove only that disposable session. The selected default remains configured.
