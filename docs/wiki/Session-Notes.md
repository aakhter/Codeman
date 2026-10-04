# Session Notes

> Feature branch draft for COD-477. The editor is implemented and reviewed; sharing actions and final integration are under development; this page does not describe a deployed release yet.

Session notes are a private Markdown notebook for your notes, ideas, and next steps. A notebook belongs to its originating session and an assigned project. Session, project, and global views open the same notebook.

## Write and find notes

Open **Notes** from a session to edit beside its terminal on desktop, or in a full-screen editor on mobile. Opening notes does not start or resume the agent. Start with an empty notebook or insert the optional Notes, Ideas, and Next steps headings.

The header **Notes** action opens the notes browser. Choose **All projects** for the global view, or choose a project to narrow the list. Search matches notebook titles and Markdown text. Project, originating-session, and unfinished-item filters can be combined.

Rows show the notebook title, project, originating session, last modification time, and unfinished checklist count. Notes remain available when a session is stopped, parked, or removed. If its history is unavailable, the retained session summary still identifies the source.

## Save status and draft recovery

Edits autosave after 750 milliseconds without typing, and when leaving the editor. Watch the save status:

| Status      | Meaning                                                   |
| ----------- | --------------------------------------------------------- |
| Unsaved     | Your latest edit has not been acknowledged by the server. |
| Saving      | A save request is in progress.                            |
| Saved       | The server has acknowledged the current version.          |
| Save failed | The request failed; keep the draft and retry.             |

The browser keeps unsaved drafts scoped to the Codeman instance, owning user, and notebook. Reloading can restore a draft, including its stable identity before the first successful content save. Changing users or instances does not restore another scope's draft. Browser storage can be cleared by browser settings; it is not a substitute for backing up saved notes.

Opening an empty notebook creates its association metadata. The Markdown file is created on the first nonempty content save. Title and project changes can be saved before that file exists.

## Projects and reassignment

Initial assignment prefers the configured project selected at launch. Otherwise, Codeman matches the launch working directory to the most specific configured root, including established Git worktree relationships. An unmatched directory becomes a directory-based notes project.

Local directories, SSH hosts, and containers have separate identities. Identical path text on different execution locations does not combine their projects. Running `cd` in the terminal does not reassign notes.

Use project reassignment to move a notebook's grouping and storage folder. Its notebook ID, source session, original directory, contents, and creation time remain intact. Reassignment does not change the session's actual directory or configured project.

Project labels can be renamed without changing notebook IDs. Removing a configured project retains its notes as a historical project that can be reassigned.

## Next steps as Markdown checkboxes

Use ordinary Markdown task lists under any heading:

```markdown
## Next steps

- [ ] Review the proposed design
- [x] Capture the decision
```

The unfinished view links items to their source notebooks. Completing an item changes the checkbox in the original Markdown using a checked revision. Task examples inside fenced code blocks are excluded. There is no separate task database or reminder schedule.

## Concurrent edits and external editors

You can edit saved Markdown files with an external editor. Change the body and user-facing title; retain the identity and provenance fields in frontmatter. Use project reassignment for changes to grouping.

When a clean editor observes an external change, it reloads the current version. When it contains a draft, Codeman preserves both versions and presents a conflict. Review the current file and your draft, then explicitly reload, combine, or replace the current version. A stale save cannot silently overwrite a newer version.

The same conflict protection applies to draft title and project changes before the first content save. External tools do not participate in Codeman's lock, so Codeman also retains displaced file bytes for recovery. This is recoverable history, not a guarantee that every change made by an arbitrary external tool was captured.

Malformed frontmatter or altered session provenance is shown as a repairable file. Its bytes remain available, and ordinary saves are blocked. Explicit repair restores retained original provenance while preserving the displaced version. If trusted provenance is unavailable, repair requires manual inspection rather than guessing a session association.

## Privacy and explicit sharing

Notes are not automatically added to prompts, checkpoints, recovery instructions, or agent memory. Agent responses are not automatically captured. Reads, searches, edits, exports, and change notifications are scoped to the owning user, including administrators.

**Send to session** previews the chosen text and destination before sending. For an inactive source, explicitly choose an active destination; sharing does not silently resume the source session.

**Save response to notes** appends only the response text you selected, with a timestamp and source reference. It uses the current notebook revision so an external edit cannot be overwritten.

This workflow privacy does not isolate files from a process running as the same operating-system user.

## Files, export, and backup

The default instance keeps notes under `~/.codeman/notes`. A named instance uses its own data directory, such as `~/.codeman-beta/notes`. A configured `CODEMAN_DATA_DIR` overrides that base directory.

```text
notes/
  <owner-key>/
    projects.json
    bindings.json
    projects/
      <project-id>/
        <notebook-id>.md
    .history/
    .project-history/
    .binding-history/
```

Owner keys and filenames are stable identifiers, not display names. The Markdown frontmatter records notebook identity and retained source metadata; the body is ordinary Markdown. Project and binding files retain organization and session associations. Search and checklist projections are rebuilt from the canonical files.

Export downloads a notebook's Markdown body as a standalone file. For a complete backup, copy the entire `notes` directory, including metadata and recovery history. Keep a copy before moving or repairing the directory. An export of one body does not include the registry or session associations.

There is no automatic expiry or permanent-delete action in this version. Team sharing, cloud synchronization, due dates, reminders, and automatic agent access are outside its scope.
