# COD-358 Upstream Vertical Session Rail Foundation Design

## Goal

Reconstruct the downstream vertical session rail as a focused upstream review branch based on the current
`upstream/master`. The extraction combines the coherent behavior delivered by COD-286, COD-299, COD-300, COD-311,
COD-326, COD-327, COD-339, and COD-352 while excluding the later tab-group model and grouped-rail behavior.

## Selected Approach

Rebuild the feature against current upstream code, porting behavior ticket by ticket rather than cherry-picking the old
downstream commits. Those commits were created against several older upstream bases and now sit among unrelated local
work. Reconstructing the slice makes each dependency explicit, avoids carrying downstream-only group assumptions, and
produces a reviewable diff.

Rejected alternatives:

- Cherry-pick and trim the historical commits. This is faster initially but risks hidden dependencies and noisy conflict
  resolution in the hottest browser files.
- Split the foundation into multiple pull requests. This reduces each individual diff but adds temporary compatibility
  states and contradicts COD-358's role as the first coherent dependency in the PR train.

## Architecture

Keep the existing single `#sessionTabs` element. Horizontal mode owns it through the header host; vertical mode moves the
same node into a resizable rail beside the terminal. The existing session-sidebar layout retains precedence when it is
selected. DOM ownership and `aria-orientation` are resolved together so settings refreshes cannot leave placement,
presentation, and accessibility state out of sync.

The orientation and width remain device-display settings. Phones resolve to horizontal mode. Vertical mode disables
horizontal wrapping and overflow behavior, sizes the terminal after the rail settles, and redraws lineage against the
new tab geometry. The homepage session list is suppressed while the persistent vertical rail is active.

No tab-group types, persistence, API calls, group headers, group menus, Focus group, or grouped tree semantics enter this
branch. The rail renders the upstream flat session list.

## Components and Data Flow

1. The settings schema and App Settings UI validate and persist tab orientation, rail width, and session-name font size.
2. Startup resolves device and layout policy before terminal creation, places `#sessionTabs`, restores width, and fits the
   terminal once against the settled rail.
3. Live orientation or width changes update root layout attributes, move the existing tab-list node, rebuild row action
   placement when crossing the compact threshold, refit terminals, and redraw lineage.
4. Vertical lineage routing uses the rail gutter rather than horizontal header geometry.
5. Expanded vertical layouts place the existing action cluster beside the session name. Compact rails keep the direct
   child overflow control so actions remain reachable. Existing hover, focus, active, and coarse-pointer visibility rules
   continue to open the established session action menu.
6. Session Options uses its corrected content-width-responsive layout so the added display controls do not introduce
   horizontal overflow.

## Boundaries and Failure Handling

Invalid or absent settings fall back to existing defaults; persisted width and font values are clamped by their schemas
and client resolvers. Phones cannot activate the rail. A missing optional terminal or lineage hook must not prevent DOM
placement; follow the existing guarded-call pattern for refit and redraw operations. Pointer-resize cancellation restores
a settled width and removes temporary drag state. This extraction introduces no new network endpoints or server-side data
migration.

## Verification

Focused tests will prove:

- orientation defaults, phone fallback, live node movement, persistence, and accessibility state;
- width restoration, resize bounds, compact-threshold transitions, tab wrapping, and terminal refit timing;
- homepage suppression and vertical lineage routing;
- session-list refresh ownership with sidebar precedence;
- session-name font sizing and action placement across expanded, compact, horizontal, and sidebar layouts;
- action-trigger visibility and menu opening for mouse, keyboard, active, and coarse-pointer states;
- Session Options has no horizontal overflow at representative desktop and wide viewports.

Use existing unit/DOM files and focused Chromium tests, then run typecheck, lint, formatting, lockfile, public-asset/static
checks, and the production build. Do not run the unscoped full Vitest suite from a Codeman-managed session.

## Delivery

Create an isolated COD-358 worktree and branch from a freshly fetched `upstream/master`. Keep implementation and tests in
review-sized commits, include a changeset for the user-facing feature, push only to Bitbucket `origin`, and target the
upstream base without writing to GitHub.
