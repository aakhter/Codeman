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
- a normal-tree cache record containing `{ sessionId, showHidden, data }`;
- the current flat match list/search-mode flag if needed by rendering.

Every input change advances the search epoch before doing anything else. A valid non-empty input captures the File Viewer
owner session ID, hidden-files preference, and search epoch, then requests the existing files endpoint with `depth=5`,
`showHidden`, and an encoded `q`. A response may update the visible panel only when its search epoch is current, its captured
owner is still both the File Viewer owner and active session, its captured hidden preference is current, and the input still
contains that query. Session changes, refreshes, every panel-hide path, hidden toggles, and input clearing also advance the
search epoch.

Normal-tree loads use a separate tree epoch. A response updates the cache only when its tree epoch, session ID, and hidden
preference are still current. A compatible tree response may refresh the cache while a search is active, but it must not
replace the search results. It renders only when the current query is empty and the panel is visible. This separation lets a
hidden-toggle or refresh populate the required new cache without allowing its tree UI to overwrite a newer search.

The historical `renderFileBrowserTree()` client-filter branch and `hasMatchingChild()` helper are removed or bypassed.
`fileBrowserFilter` records the current server query only; cached trees always render unfiltered. This prevents a server
search from being double-filtered and prevents hidden-toggle cache reloads from briefly hiding entries using the old
depth-limited filter.

Successful search responses render `data.matches` as a flat list:

- file rows retain the existing icon and size behavior; preview and download actions bind to the captured result/cache
  session ID rather than consulting a later `activeSessionId`;
- directory rows retain directory styling; clicking one clears the search, restores the cached tree, expands the directory
  and its ancestor paths, and leaves the user at the normal tree. Ancestors are found by recursively walking the cached tree,
  not by splitting path strings, so `/` and Windows `\` paths behave identically;
- an empty list renders `No matches`;
- the status line uses the server's validated `matchCount` (falling back to the rendered list length) and appends
  `(truncated)` when `data.truncated` is true.

Clearing the query never refetches. It cancels the debounce/in-flight search epoch and exits search mode. It renders and
restores status only from a cache whose session ID and hidden preference match the current panel owner. If no compatible
cache exists—for example, while session B is loading after switching from session A—the panel keeps B's loading/empty state
and never renders A's paths under B's actions.

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

The hidden-files toggle preserves an active valid query. It advances the search epoch, captures the query/session/new hidden
preference, and starts a new tree load. Its continuation reruns the captured query only if that tree load won its tree epoch,
the session and hidden preference remain current, the input is unchanged, and the panel remains visible. A query typed while
the tree request is pending may run independently; the compatible tree response may update only the cache. A second toggle
invalidates both the first toggle's tree response and its continuation. With an empty query the control behaves as it does
today.

Changing the hidden preference immediately removes prior-preference results from the visible panel and shows the new tree
load state. If that load fails, the new preference remains selected and persisted, the captured query is not rerun, and the
panel shows the escaped tree-load failure with no compatible restoration cache. The input may remain for correction or a
new search; clearing it retains the load failure rather than restoring prior-preference data. Refresh clears the query and
retries the normal tree, while toggling again retries under the newly selected preference.

`selectSession()` in `app.js` calls a narrow File Viewer owner/reset hook immediately after assigning the new
`activeSessionId`, before terminal replay and the later idle-callback tree load. The hook synchronously changes the File
Viewer owner, clears search input/state, invalidates both epochs, blocks prior-owner row interaction, and shows the new
owner's loading state when the panel is visible. Thus there is no interval in which input can target session B while the
panel is still owned by A. The later `loadFileBrowser(B)` populates the cache normally. The panel never restores/renders a
cache owned by another session or hidden preference. Tree and search row actions pass their captured session owner to
`openFilePreview()` and construct download URLs from that owner.

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
  load;
- independent tree/search epochs under query changes, two hidden toggles, search during refresh, and search during a cache
  reload;
- late search and tree response suppression after a newer query, clear, refresh, either close path, or session switch;
- search failure followed by clear-to-recover;
- directory-result navigation back to the cached tree with separator-independent ancestor expansion, including a
  Windows-style path fixture;
- hidden-toggle reload followed by rerunning the active query;
- hidden-toggle tree-load failure, clear-without-stale-restoration, refresh recovery, and toggle-back recovery;
- refresh and session changes clearing search state;
- Expand/Collapse All remaining inert and disabled during search, then recovering afterward;
- settings-driven hide/reopen reset behavior.

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
