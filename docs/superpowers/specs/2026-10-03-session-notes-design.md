# Persistent Session Notes Design

Date: 2026-10-03
Status: Product behavior approved in conversation; detailed design proposed for implementation.

## Purpose and agreed decisions

Let a user capture notes, ideas, and next steps while working in a Codeman session, then find and edit those notes after the session ends. The same notebook must be available from its session, its project, and a global Notes view.

The user approved these decisions:

- One Markdown notebook per session, with freeform text, headings, links, and checkboxes.
- Persistent Markdown files organized by project in Codeman's data folder.
- Project assignment uses the configured Codeman project and its working directory, with manual reassignment.
- Autosave with visible save and error status.
- Search and filters for project, session, and unfinished next steps.
- External Markdown editing and export, with protection against overwriting concurrent edits.
- Notes are private in the product workflow by default. Sharing with an agent uses explicit actions: Send to session and Save response to notes.

The detailed mechanics below are design recommendations implementing those decisions. This document does not record implementation or test results.

## Notebook experience

Each session offers a Notes action. On desktop, it opens a resizable panel beside the terminal; on mobile, it opens a full-screen editor with a return-to-session action. Opening Notes does not start or resume the agent.

Allocate a stable notebook ID when editing begins, and create its Markdown file on the first nonempty save, rather than producing an empty file for every session. Offer an optional starting template with Notes, Ideas, and Next steps headings. Users can change or remove those headings and write ordinary Markdown.

The editor has edit and preview modes. The header displays the notebook title, assigned project, originating session, and save status: Saving, Saved, Unsaved, or Save failed. Session title changes must not change the notebook's stable identity or discard a user-edited notebook title.

Autosave after 750 ms without typing and when leaving the editor. Saved means the server has persisted the file successfully. Keep an unsaved draft through a page reload using storage scoped to the Codeman instance, owner, and notebook; clear it only after the corresponding save succeeds. Restore a draft against the current file revision, using the same conflict workflow as any other edit. Drafts for a new notebook retain the originating session association and allocated ID so retries do not create duplicates.

## Project and global views

A header-level Notes action opens a dedicated browser with a project list, notebook list, and selected notebook. Selecting All projects shows the global view. Selecting a project narrows the same view; it does not copy notebooks into a separate collection.

List rows show notebook title, project, originating session title, last modified time, and unfinished checklist count. Sort by most recently modified. Search title and Markdown body. Combine search with project, originating-session, and unfinished-items filters.

Recognize Markdown task-list markers outside fenced code blocks. Unchecked items are unfinished, checked items are complete. They can occur under any heading. The global view can show unfinished items with links to their source notebook. Completion changes the source Markdown using the current file revision; there is no separate task database.

Notes for stopped, parked, or removed sessions remain in the default project and global lists. A source session link opens its available history; if history is unavailable, display the retained session summary and keep the notebook editable.

## Project identity and reassignment

Represent a notes project using a stable internal ID, a display name, and its execution-location/root mapping. Current configured cases expose names and paths, rather than a universal stable project ID, so the notes subsystem needs a small project registry rather than assuming a display name is permanent.

Initial assignment follows these rules:

1. Use the configured project selected when the session was launched, when available.
2. Otherwise, match the session's launch working directory to a configured project root in the same execution location. Prefer the most specific containing root and require a path-component boundary.
3. Recognize a linked Git worktree's main repository root only when existing metadata establishes that relationship. Do not infer it from a similar directory name.
4. If no configured project matches, create a directory-based notes project for that execution location and root. It can be renamed or reassigned later.

Local, SSH, and container roots must retain their execution-location identity: an identical path string on two hosts is not the same project. Use the session's launch directory, rather than changing project assignment whenever the terminal runs cd.

Reassign project is available from the notebook header and list. It changes the notebook's grouping and storage folder, and preserves its notebook ID, session association, original working directory, content, and creation time. A manual assignment remains authoritative. Reassignment does not change the session's actual working directory or its configured project.

Project renames update display names without invalidating notebook identity. Project removal retains its notes as a historical project with a reassignment action. Later session recovery must resolve existing notebooks through retained session/conversation aliases when known, rather than silently creating a second notebook.

## Markdown storage and durability

Markdown files are the canonical content store. Keep the files under this instance's data directory through dataPath(), rather than hardcoding ~/.codeman. Scope directories and API access to the owning user in multi-user mode.

Suggested layout within that directory:

```text
notes/
  <owner-key>/
    projects.json
    projects/
      <project-id>/
        <notebook-id>.md
    index.json
```

Stable IDs keep filenames independent of title and project-name edits. The project registry records readable names and roots. Each Markdown file has a small versioned frontmatter block containing notebook ID, project ID, owner key, originating session ID and known conversation aliases, notebook title, session title snapshot, original working directory, execution-location identity, creation time, and application modification time. The body is ordinary Markdown. Listing can use actual file modification time to recognize external edits.

The search/list index is a rebuildable cache. Losing it must not lose notebook contents or session associations. The project registry is persistent metadata and is included when backing up the notes directory. Exporting one notebook produces a standalone Markdown file; backing up or moving the complete notes directory preserves project organization and identity metadata.

All writes use temporary-file replacement and serialize mutations per notebook. Project reassignment uses a recoverable move operation; an interrupted move must leave at least one readable canonical copy and must not produce duplicate notebooks in the index. Session cleanup does not delete notes. No automatic note expiry or permanent deletion is included in the initial scope.

## External edits and conflicts

Use a revision derived from the current file bytes. A save supplies the revision the editor loaded; the server rechecks it before replacing the file. Serialize this check and write so simultaneous browser saves cannot both pass against the same old content.

External editors do not participate in the server's mutation lock. Recheck immediately before replacement and retain the displaced file version in recoverable history; implement replacement so the retained version is the file actually displaced, rather than an earlier cached read. Revision checking handles observed changes, and the retained version covers an external write during replacement. Do not claim exclusive editing or complete version history for arbitrary external tools. The recoverable history is separate from the rebuildable search index and participates in notes backup.

Detect external changes with filesystem notifications backed by a rescan when the notes browser opens and before saving. If the editor is clean, reload the changed file. If it has unsaved changes, preserve both versions and show a conflict view with the user's draft and the current file. Let the user reload, combine them, or explicitly replace the current version. Do not automatically overwrite either version.

External editors normally change the body and user-facing title. Validate frontmatter before adopting changes to identity, ownership, or project association. A malformed or missing frontmatter block must not make content disappear: surface a repairable-file entry, retain the bytes, and block automatic rewriting until repaired.

## Agent interaction and privacy

Do not automatically inject notes into prompts, checkpoints, recovery, or agent memory. Do not automatically capture responses. Private means the UI and sharing workflow keep content unshared by default; it does not provide OS-level isolation from a process running as the same system user.

Send to session previews selected text, or the whole notebook when explicitly selected, and its destination. Send only when the user invokes that action. For an inactive originating session, offer an explicit choice of an active destination; sharing must not silently resume a session.

Save response to notes appends the response the user selected, with a timestamp and source-session reference. If no response has been selected, require selection rather than guessing which terminal text to capture. This action also uses revision checking, so it cannot overwrite an external edit.

Owner checks apply to lookup, search, reads, writes, exports, reassignment, and change notifications. Render Markdown with HTML sanitization. Resolve files through validated IDs within the notes root rather than accepting arbitrary filesystem paths from the browser.

## Implementation boundaries

- Notes store: Markdown parsing, atomic writes, revision checks, recovery, export, and owner-scoped file access.
- Notes project resolver: configured-project matching, execution-location/root identity, registry maintenance, and explicit reassignment.
- Notes index: rebuildable search and list projections, including parsed task-list items.
- Notes routes and events: authenticated note operations and owner-scoped change notifications. Historical-note operations must not require a live Session instance.
- Notes UI: session panel, project/global browser, editor, draft recovery, conflicts, and explicit sharing actions.

Reuse existing session-history and project metadata at these boundaries. Keep the notes lifecycle independent of session-state deletion. Integrate with the existing plain JavaScript frontend and Fastify route patterns; this feature does not require replacing either framework.

## Acceptance criteria and implementation verification

1. Create notes in a session and see the identical content from session, project, and global views.
2. Reload the browser, restart Codeman, stop the session, and remove its runtime record; notes remain readable and editable.
3. Match configured project roots, nested roots, established worktree relationships, and separate execution locations correctly; preserve a manual reassignment.
4. Rename or remove a project and recover a session without losing notes or creating unintended duplicates.
5. Search Markdown and filter unfinished task-list items; completion changes the original notebook and excludes code-block examples.
6. Edit externally while the browser is clean and while it contains a draft; reload or surface a conflict without losing either version. Include simultaneous browser saves.
7. Simulate a failed save and interrupted reassignment; never show a false Saved state, discard a draft, or lose the canonical file.
8. Rebuild the index from the files, recover malformed metadata visibly, and verify instance and owner isolation.
9. Verify desktop and mobile layouts, keyboard navigation, safe Markdown rendering, and explicit agent-sharing actions.

Implement focused regression tests for persistence, identity, conflicts, access control, and checklist parsing; use browser verification for editor and layout behavior. Run the repository's required checks during implementation, with targeted test files rather than the full suite in a managed session. No implementation tests have been run for this design-only work.

## Scope limits and trade-offs

The first version has one notebook per session. Reminders, due dates, automatic agent access, automatic summaries, shared team notebooks, cloud synchronization, arbitrary file import, and storage inside source repositories are outside this design.

Markdown provides portability and direct external editing, but introduces synchronization and metadata-repair work. A separate store avoids coupling note retention to transient session records, but requires a project registry and recoverable index. Reusing ordinary checkboxes keeps next steps portable, while limiting task features to text and completion status.

## Evidence read

- src/services/unified-session-service.ts: combines live sessions, persisted sessions, transcript history, and lifecycle history; records project and worktree metadata and conversation aliases.
- src/types/session.ts: session identity, launch working directory, owner, and execution metadata.
- src/state-store.ts: existing persistent session state, distinct from the proposed Markdown notes store.
- src/types/api.ts and src/web/routes/case-routes.ts: configured cases include names, paths, and local/remote/container location information.
- src/config/instance.ts and CLAUDE.md: instance-aware dataPath() and isolation requirements.
- src/web/public/index.html and src/web/public/panels-ui.js: existing session-manager and panel entry points.

## Design review

Reviewed against the agreed behavior for retention, project organization, global access, Markdown portability, and private-by-default sharing. Checked failure cases for removed sessions/projects, directory ambiguity, interrupted writes/moves, concurrent editing, malformed metadata, and owner/instance isolation. The remaining detail is implementation planning and visual layout verification, rather than an unresolved product choice.
