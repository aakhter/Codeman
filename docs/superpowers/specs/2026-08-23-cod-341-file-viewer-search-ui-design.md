# COD-341 File Viewer Server-Side Search UI Design

## Goal

Complete the UI half of the already-upstream File Viewer search API. The existing search input currently filters only the
depth-limited tree already loaded in the browser. After this change, a valid non-empty query calls
`GET /api/sessions/:id/files?q=...`, renders the endpoint's flat `matches`, reports truncation, and restores the cached tree
when the query is cleared.

This is a focused follow-up to upstream PR #324. The backend matcher, traversal limits, response schema, existing search
input, and existing File Viewer row styles remain unchanged.

## Selected Approach

Extend the existing File Viewer mixin in `src/web/public/panels-ui.js` with a small debounced search state machine and add
focused VM-based frontend tests beside `test/file-browser-hidden.test.ts`.

The browser keeps the most recently loaded normal tree plus its owner identity as its restoration cache. A valid trimmed
non-empty query schedules a server request after 250 ms. A blank or whitespace-only query cancels the pending search and
immediately restores a compatible cached tree and its normal status. Search results use the existing file-tree row classes
and click behaviors, so no HTML or CSS changes are needed.

Rejected alternatives:

- Port the historical downstream implementation verbatim. It provides the basic feature but allows a late search response
  to overwrite a tree restored after clearing the input.
- Extract a standalone search controller/module. That would isolate the state, but it adds script wiring and a new public
  abstraction for a small panel-local behavior.
- Keep client-side filtering and fetch a deeper tree. This still transfers and renders unrelated workspace content and
  defeats the bounded flat-search API already accepted upstream.

## State and Data Flow

The mixin lazily initializes panel-local state so this extraction does not require constructor wiring:

- a debounce timer;
- independent monotonically increasing tree-load and search epochs;
- the File Viewer owner session ID, updated synchronously when session activation changes;
- an owner-tagged normal-tree state record containing `{ sessionId, showHidden, phase, data?, error? }`, where `phase` is
  `loading`, `ready`, or `error`;
- an in-flight normal-tree load record keyed by owner session and hidden preference for request deduplication;
- explicit panel view ownership: `normal`, `search-pending`, `search-results`, `search-error`, or `query-error`;
- the current flat match list and an optional deferred directory target tied to one owner/preference/tree epoch plus its
  originating search epoch and query.

Every input change advances the search epoch and clears any deferred directory target before doing anything else. A valid
non-empty input captures the File Viewer owner session ID, hidden-files preference, and search epoch, then requests the
existing files endpoint with `depth=5`,
`showHidden`, and an encoded `q`. A response may update the visible panel only when its search epoch is current, its captured
owner is still both the File Viewer owner and active session, its captured hidden preference is current, and the input still
contains that query. Session changes, refreshes, every panel-hide path, hidden toggles, and input clearing also advance the
search epoch.

Normal-tree loads use a separate tree epoch and immediately record an owner-tagged `loading` state. A non-forced request for
the same owner/hidden identity reuses either its in-flight promise or its compatible settled normal state; refreshes and
hidden toggles explicitly force a new epoch/load. A response records either
`ready` data or a normalized `error` only when its tree epoch, session ID, and hidden preference are still current. A
compatible tree response may refresh this normal state while a search view owns the panel, but it must not replace
search-owned UI. Normal state renders only when explicit view ownership is `normal` and the panel is visible; query text may
still be non-empty during a hidden-toggle reload. This separation lets a hidden-toggle or refresh populate the required new
cache/error without allowing its tree UI to overwrite a newer search.

The historical `renderFileBrowserTree()` client-filter branch and `hasMatchingChild()` helper are removed or bypassed.
`fileBrowserFilter` records the current server query only; cached trees always render unfiltered. This prevents a server
search from being double-filtered and prevents hidden-toggle cache reloads from briefly hiding entries using the old
depth-limited filter.

Successful search responses render `data.matches` as a flat list:

- file rows retain the existing icon and size behavior; preview and download actions bind to the captured result/cache
  session ID rather than consulting a later `activeSessionId`;
- directory rows retain directory styling. With compatible `ready` normal state containing the target, clicking one clears
  the search, transfers view ownership to `normal`, restores the tree, and expands the directory plus its ancestors. A fresh
  search may find a newly created/renamed directory absent from that older ready cache; in that case the click retains search
  results and shows `Reload files before opening this folder`. With compatible `loading` state, it records a deferred
  owner/preference/tree-epoch target plus the originating search epoch/query while retaining search results. It transfers to
  the expanded normal tree only if that exact tree load becomes `ready`, contains the target, and the originating search
  epoch/query/view still owns the panel. A successful transfer explicitly advances the search epoch, cancels any debounce,
  clears the input/filter/matches/deferred target, changes view ownership to `normal`, restores Expand/Collapse, then expands
  and renders the target; it never relies on assigning the input value to dispatch an `input` event. Any later user input
  clears the target, so newer search UI always wins. Absence or failure clears the deferred target, keeps the search results
  visible, and shows the reload prompt; a stored load failure is revealed later if the query is cleared. With compatible
  `error` state, the click likewise keeps search results visible and shows the reload prompt rather than discarding the only
  usable view. Ancestors are found by recursively walking the cached tree, not by splitting path strings, so `/` and Windows
  `\` paths behave identically;
- an empty list renders `No matches`;
- the status line uses the server's validated `matchCount` (falling back to the rendered list length) and appends
  `(truncated)` when `data.truncated` is true.

Clearing the query never refetches. It cancels the debounce/in-flight search epoch, transfers view ownership to `normal`, and
renders only the compatible owner-tagged normal state: ready cache and status, current loading state, or stored tree-load
error. If no compatible state exists, the panel shows the current owner's loading/empty state and never renders another
owner's paths or error under current actions.

Queries of 1–256 trimmed characters are valid, matching the upstream matcher. A longer query sends no request, exits search
results, and displays `Search queries are limited to 256 characters`; clearing or shortening it recovers normally.

## Existing Controls

Refresh remains an explicit reset: it clears the search input and state, invalidates pending responses, clears expanded
directories, and reloads the normal tree.

One shared reset helper clears the search input/state, advances both the search and tree epochs, and restores the
Expand/Collapse control. Both `closeFileBrowserPanel()` and the settings-driven hide branch in
`settings-ui.js::applyMonitorVisibility()` call it. Advancing the tree epoch means a tree response arriving after either hide
path cannot update the cache; search responses additionally require the panel to remain visible. Reopening therefore starts
a fresh normal-tree load and cannot reveal state produced while hidden. This intentionally adds the narrow settings mixin
edit to the extraction scope.

The hidden-files toggle preserves an active valid query. It advances and captures the search epoch plus the query/session/new
hidden preference, then starts a new tree load. Its continuation reruns the captured query only if that tree load won its
tree epoch, the captured search epoch is still current, the session and hidden preference remain current, the input is
unchanged, and the panel remains visible. Any input event while the tree request is pending invalidates that continuation and
may run its own search independently; the compatible tree response may update only normal state. A second toggle invalidates
both the first toggle's tree response and its continuation. With an empty query the control behaves as it does today.

With an overlength query, toggling hidden files advances both request epochs and reloads owner-tagged normal state for the new
preference, but keeps `query-error` view ownership and never sends/reruns the invalid query. The length error remains visible
while the normal load settles behind it. Clearing transfers to `normal` and reveals that load's ready tree or stored error.

Changing the hidden preference immediately removes prior-preference results from the visible panel and shows the new tree
load state under `normal` view ownership even though the captured input remains non-empty. If that load fails, the new
preference remains selected and persisted, the captured query is not rerun, and the owner-tagged normal state records the
tree-load failure and renders it escaped. A new query typed during the reload transfers ownership to a search view and may
complete/remain visible even if the tree load later fails; clearing that query transfers ownership back to `normal` and
reveals the stored failure rather than prior-preference data. Refresh clears the query and retries the normal tree, while
toggling again retries under the newly selected preference.

`selectSession()` in `app.js` calls a narrow File Viewer owner/reset hook immediately after assigning the new
`activeSessionId`, before terminal replay and the later idle callback. The hook synchronously changes the File Viewer owner,
clears search input/state, invalidates both epochs, blocks prior-owner row interaction, and, when the panel is visible, starts
the new owner's normal-tree load fire-and-forget. File loading therefore proceeds even if terminal fetch/replay later fails.
The existing idle-callback `loadFileBrowser(B)` call is retained for panel initialization but deduplicates against the same
in-flight owner/preference request; if the immediate request already settled, it may render/reuse the compatible ready/error
normal state without issuing a duplicate request. Thus there is no interval in which input can target session B while the
panel is still owned by A, and no terminal failure can strand B permanently in a synthetic loading state. The panel never
restores/renders a cache owned by another session or hidden preference. Tree and search row actions pass their captured
session owner to `openFilePreview()` and construct download URLs from that owner.

Expand/Collapse All is disabled while any non-empty query is pending or showing results/errors, and its handler is a no-op
in those states. Leaving search mode restores the control and its prior tree expansion state. This prevents the existing
handler from replacing search UI with the cached tree while leaving the search field and status active.

## Failure Handling

- Non-2xx responses, unsuccessful envelopes, and malformed search envelopes render an escaped `Search failed` message.
- A valid envelope requires `data.mode === 'search'`, an array `data.matches`, and every entry to have string `name` and
  `path` plus `type` exactly `file` or `directory`. Optional size/extension fields must have their expected primitive types.
  `truncated` must be boolean, and any supplied `matchCount` must be a finite non-negative number. The entire envelope fails
  closed rather than partially rendering untrusted entries.
- A failed search does not discard the cached normal tree; clearing the input recovers immediately without another request.
- Late successes and late failures are ignored after a newer query, clear, refresh, close, hidden-toggle reload, or session
  switch.
- Missing panel elements or a missing active session remain safe no-ops.
- Query text is encoded in the URL; session IDs, names, paths, attribute values, and download URLs are escaped/encoded at
  their output boundary; and status text is assigned through `textContent`.

## Verification

Add `test/file-browser-search.test.ts` using the established VM-loaded mixin pattern. Focused tests cover:

- 250 ms debouncing and URL encoding of `q`, session ID, and `showHidden`;
- rendering file and directory matches with existing preview/download behavior;
- match counts, no-match state, and the server's truncation indicator;
- immediate cached-tree restoration for blank and whitespace-only input;
- 256-character acceptance and 257-character client rejection without a request;
- strict malformed-envelope rejection and HTML-metacharacter escaping in names, paths, attributes, and links;
- owner-tagged restoration and row actions, including overlapping A/B tree loads and clear-before-B-load-completes;
- the real `selectSession()` owner/reset hook, including input attempted after B becomes active but before B's delayed tree
  load, terminal-selection failure, and deduplication of the immediate owner load with the later idle-callback load;
- independent tree/search epochs under query changes, two hidden toggles, search during refresh, and search during a cache
  reload. A newer query or clear suppresses prior search responses but still permits a compatible tree response to update
  normal state; a new tree load suppresses the prior tree response; and hide, session switch, or hidden-preference change
  suppresses both response classes as applicable;
- search failure followed by clear-to-recover;
- directory-result navigation back to the cached tree with separator-independent ancestor expansion, including a
  Windows-style path fixture, immediate ready-state navigation, deferred loading-state navigation while results remain
  visible, newer query input cancelling deferred navigation, successful deferred navigation explicitly resetting every
  search field/control without a synthetic input event, load failure clearing a deferred target, error-state click
  retention/toast behavior, and a stale ready cache that does not contain the fresh search-result directory;
- hidden-toggle reload followed by rerunning the active query;
- hidden toggle during a 257-character `query-error`, with no search request and clear revealing the background tree
  ready/error state;
- hidden-toggle tree-load failure, clear-without-stale-restoration, refresh recovery, and toggle-back recovery, including a
  new query that wins the UI before the concurrent tree load fails and reveals the stored error only when cleared;
- refresh and session changes clearing search state;
- Expand/Collapse All remaining inert and disabled during search, then recovering afterward;
- settings-driven hide/reopen reset behavior;
- explicit normal/search view ownership when hidden-toggle loading/error UI coexists with non-empty captured query text.

Run only the new frontend test and directly related existing File Viewer/search route tests from the managed session. Finish
with typecheck, lint, formatting, lockfile, frontend syntax, and production build checks. Audit the final branch diff against
the freshly fetched upstream base and confirm no backend matcher, route contract, markup, CSS, or unrelated downstream File
Viewer behavior was imported.

## Delivery

Create an isolated COD-341 worktree from a freshly fetched `upstream/master`. Keep the implementation to the File Viewer
mixin, the narrow `app.js` session-owner hook, the narrow settings-driven hide/reset hook, focused frontend tests, and the
release changeset required by upstream. Push the review branch to the configured GitHub fork and open an upstream pull
request only under the user's existing upstream-submission authorization. Do not merge upstream, merge into local, or deploy
production as part of this extraction.
