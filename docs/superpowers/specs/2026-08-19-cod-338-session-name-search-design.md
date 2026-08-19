# COD-338: Vertical Navigation Session-Name Search

**Jira:** COD-338  
**Date:** 2026-08-19  
**Status:** Approved by delegated self-review

## Problem

The live Codeman vertical navigation has no visible search control. With sessions distributed across Focus, named groups, collapsed groups, and Ungrouped, finding a session requires scanning the list and manually opening sections.

The checkout contains an older generic sidebar-filter path, but the requested feature is not visible in the live UI. Treat that code only as possible scaffolding. The implementation is complete only when the search is visible and works in the running application.

## User Experience

Add a session-name search field at the top of the expanded vertical navigation, before Focus and all other sections.

Typing filters immediately using a case-insensitive substring match against each displayed session name. A non-empty query produces a grouped projection of the full session collection:

- Matching session rows remain under their existing section headers.
- Sessions inside collapsed sections are temporarily revealed.
- Nonmatching session rows, non-session rows, and sections with no matches are hidden.
- Focus shortcuts follow existing semantics: if a focused session matches, its Focus shortcut and its canonical row may both appear in their existing sections.
- Section counts and the overall visible count reflect the displayed matches.
- When nothing matches, the navigation shows a concise `No sessions match` state instead of empty section headers.

The search field includes an explicit clear button marked with an × and an accessible `Clear session search` label. The button appears only for a non-empty query. Activating it clears the query, keeps keyboard focus in the search field, and restores the ordinary navigation.

Search is transient. It is not stored across reloads. Collapsing the entire sidebar or switching back to the horizontal session list clears the search so an invisible query can never continue hiding rows.

## State and Rendering

The query belongs to the vertical-navigation controller as transient client state. Normalize it with `trim().toLocaleLowerCase()` (or the project's established equivalent) for matching, while preserving the entered value in the input.

Filtering must happen against the complete canonical session projection, not only against rows currently present in the DOM. This is required because collapsed groups do not render all of their session rows. During an active search, derive a filtered projection that contains only matching session references and the headers needed to preserve their context.

Search must not mutate persisted Focus or group-collapse state. Matched groups paint as expanded for the filtered projection, but their disclosure controls do not change saved state while search is active. Clearing the query rebuilds the ordinary projection from the still-authoritative stored collapse state. If the implementation reuses the dormant DOM-filter code, it must first correct these projection and state-boundary limitations; a second independent filter path must not be added.

Sessions remain selectable and expose their normal row actions. Renames, additions, removals, regrouping, Focus changes, and live session updates reapply the active query to the new canonical state without stale results or visible flicker.

## Accessibility and Interaction

- The input has the accessible name `Search sessions` and an appropriate placeholder.
- The explicit clear control is a real button, keyboard reachable, and labelled `Clear session search`.
- Filtered-out rows and empty groups are absent from keyboard traversal and the accessibility tree.
- Matching rows preserve existing selection, menu, drag, and action behavior.
- Clearing by button restores the full list and returns focus to the search field.
- Group headers shown as search context must not imply that activating them will hide required matches.

## Empty and Boundary Cases

- Empty or whitespace-only input renders the unfiltered navigation.
- Multiple matches across multiple groups retain group order and session order.
- Duplicate names all remain visible.
- A query that matches only a session in a collapsed group still shows that group and session.
- Webview rows and other non-session entries do not match a session-name query and are hidden while it is active.
- Closing or changing the navigation layout cannot leave an unreachable active filter.

## Verification

Use focused tests only; do not run the full Vitest suite from a Codeman-managed session.

DOM-level regression coverage must prove:

- visible placement before Focus;
- case-insensitive substring matching by displayed session name only;
- preservation of group and session order;
- matches from collapsed groups without persisted collapse-state mutation;
- hiding nonmatches, non-session rows, and empty groups;
- match counts and the no-results state;
- explicit clear-button visibility, accessible name, focus behavior, and full restoration;
- live reapplication after add, rename, remove, regroup, and Focus changes;
- query clearing when the sidebar becomes unreachable.

A real-browser check must exercise typing, selecting a result from a formerly collapsed group, clearing, and confirming that the original collapsed/expanded structure returns. The worker must also verify the control in the running Codeman instance because the checkout's dormant filter code is not evidence that the live feature exists.

## Self-Review

- No placeholders or deferred decisions remain.
- The design distinguishes the live UI from dormant checkout code.
- Matching scope is session display names only.
- Group preservation, Focus duplication, counts, no-results behavior, clear behavior, and collapse restoration are explicit.
- The work is a single frontend feature with focused regression coverage; no backend or persistence changes are required.
