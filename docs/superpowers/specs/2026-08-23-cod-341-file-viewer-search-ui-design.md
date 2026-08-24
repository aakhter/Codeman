# COD-341 File Viewer Server-Side Search UI Design

## Goal

Complete the UI half of the already-upstream File Viewer search API. The existing search input currently filters only the
depth-limited tree already loaded in the browser. After this change, a non-empty query calls
`GET /api/sessions/:id/files?q=...`, renders the endpoint's flat `matches`, reports truncation, and restores the cached tree
when the query is cleared.

This is a focused follow-up to upstream PR #324. The backend matcher, traversal limits, response schema, existing search
input, and existing File Viewer row styles remain unchanged.

## Selected Approach

Extend the existing File Viewer mixin in `src/web/public/panels-ui.js` with a small debounced search state machine and add
focused VM-based frontend tests beside `test/file-browser-hidden.test.ts`.

The browser keeps the most recently loaded normal tree as its restoration cache. A trimmed non-empty query schedules a
server request after 250 ms. A blank or whitespace-only query cancels the pending generation and immediately restores the
cached tree and its normal status. Search results use the existing file-tree row classes and click behaviors, so no HTML or
CSS changes are needed.

Rejected alternatives:

- Port the historical downstream implementation verbatim. It provides the basic feature but allows a late search response
  to overwrite a tree restored after clearing the input.
- Extract a standalone search controller/module. That would isolate the state, but it adds script wiring and a new public
  abstraction for a small panel-local behavior.
- Keep client-side filtering and fetch a deeper tree. This still transfers and renders unrelated workspace content and
  defeats the bounded flat-search API already accepted upstream.

## State and Data Flow

The app gains only panel-local search state:

- a debounce timer;
- a monotonically increasing request generation;
- the current flat match list/search-mode flag if needed by rendering.

Every input change invalidates the prior generation before doing anything else. Non-empty input captures the active session
ID, hidden-files preference, and generation, then requests the existing files endpoint with `depth=5`, `showHidden`, and an
encoded `q`. A response may update the panel only when its generation is current and its captured session is still active.
Session tree loads, refreshes, panel closure, and input clearing also invalidate pending searches.

Successful search responses render `data.matches` as a flat list:

- file rows retain the existing icon, size, preview click, and download link behavior;
- directory rows retain directory styling; clicking one clears the search, restores the cached tree, expands the directory
  and its ancestor paths, and leaves the user at the normal tree;
- an empty list renders `No matches`;
- the status line uses the server's `matchCount` (falling back to the rendered list length) and appends `(truncated)` when
  `data.truncated` is true.

Clearing the query never refetches. It cancels the debounce/in-flight generation, exits search mode, renders the cached
tree, and restores the normal `N files, M dirs` status including the existing tree truncation and hidden-files indicators.

## Existing Controls

Refresh remains an explicit reset: it clears the search input and state, invalidates pending responses, clears expanded
directories, and reloads the normal tree.

Closing the panel also clears the search input/state and invalidates pending responses, so reopening cannot reveal a stale
query or accept a response produced while the panel was hidden.

The hidden-files toggle preserves an active query. It reloads the normal cache with the new `showHidden` value, then reruns
that query against the server. With an empty query it behaves exactly as it does today. The reload and rerun share the same
generation fencing, so neither the old tree request nor the old search request can overwrite the newer state.

Session changes invalidate requests for the prior session. The search field is cleared when a different session becomes the
File Viewer owner, avoiding a tree that appears filtered locally while no matching server search has run for that session.

## Failure Handling

- Non-2xx responses, unsuccessful envelopes, and malformed search envelopes render an escaped `Search failed` message.
- A failed search does not discard the cached normal tree; clearing the input recovers immediately without another request.
- Late successes and late failures are ignored after a newer query, clear, refresh, close, hidden-toggle reload, or session
  switch.
- Missing panel elements or a missing active session remain safe no-ops.
- Query text is encoded in the URL, names and paths remain HTML-escaped, and status text is assigned through `textContent`.

## Verification

Add `test/file-browser-search.test.ts` using the established VM-loaded mixin pattern. Focused tests cover:

- 250 ms debouncing and URL encoding of `q`, session ID, and `showHidden`;
- rendering file and directory matches with existing preview/download behavior;
- match counts, no-match state, and the server's truncation indicator;
- immediate cached-tree restoration for blank and whitespace-only input;
- late response suppression after a newer query, clear, refresh, close, or session switch;
- search failure followed by clear-to-recover;
- directory-result navigation back to the cached tree with ancestor expansion;
- hidden-toggle reload followed by rerunning the active query;
- refresh and session changes clearing search state.

Run only the new frontend test and directly related existing File Viewer/search route tests from the managed session. Finish
with typecheck, lint, formatting, lockfile, frontend syntax, and production build checks. Audit the final branch diff against
the freshly fetched upstream base and confirm no backend matcher, route contract, markup, CSS, or unrelated downstream File
Viewer behavior was imported.

## Delivery

Create an isolated COD-341 worktree from a freshly fetched `upstream/master`. Keep the implementation to the File Viewer
mixin, focused frontend tests, and the release changeset required by upstream. Push the review branch to the configured
GitHub fork and open an upstream pull request only under the user's existing upstream-submission authorization. Do not merge
upstream, merge into local, or deploy production as part of this extraction.
