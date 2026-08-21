# COD-351 Saved Codex Command Profiles — Design

## Goal

Replace the single raw **Codex Command Override** field for remote cases with a reusable, owner-private library of saved Codex command profiles. A remote case can use the normal Codex command, select a saved profile, or retain a one-off custom command.

This is limited to **Codex** command overrides in the first release. It does not add profile libraries for Claude, Gemini, OpenCode, Pi, shell, Docker, or remote-host command fields.

## User decisions

- The case form uses the selected mockup: a compact profile selector, a read-only command preview, and a separate **Manage** action.
- Profiles are global across an owner's remote hosts and cases, and private to that owner across devices.
- Existing raw per-case Codex commands are migrated automatically into shared, deduplicated profiles.
- Migrated profile names are derived from commands, for example `exec codx personal` becomes `Personal`, with deterministic collision handling and an `Imported N` fallback.
- Editing a profile updates every case that references it. The UI must show the usage count and require confirmation before saving an edited command used by other cases.
- A profile cannot be deleted while cases reference it. The manager shows those cases so they can be reassigned.

## Data model

```ts
interface CodexCommandProfile {
  id: string;
  name: string;
  command: string;
}

type CodexCommandSelection =
  | { kind: 'default' }
  | { kind: 'profile'; profileId: string }
  | { kind: 'custom'; command: string };
```

Profiles are persisted server-side in an owner-keyed profile library. Each remote case stores its selection state. The browser never sends or chooses an owner key; routes derive it from the authenticated request.

Profile IDs are stable and opaque. Names are unique case-insensitively within one owner's library. Commands retain the existing remote-command validation and maximum length contract.

### Case command resolution

For a remote Codex launch, resolve commands in this order:

1. A valid selected profile's current command.
2. A case's custom command.
3. Existing host/default Codex command resolution.

The selection is server authoritative. If a profile ID is corrupt or unavailable, the launch fails with a clear configuration error; it must not silently run under a potentially different Codex account.

## Migration and compatibility

On profile-library access or remote-case save, migrate eligible legacy raw Codex case commands for that owner:

1. Normalize and deduplicate matching commands within the owner library.
2. Reuse an existing matching profile if present; otherwise create one with a derived, collision-safe name.
3. Link every matching owned case to that profile.
4. Preserve the legacy raw value until the profile link is durably written, making a retry safe after an interrupted migration.

Migration is idempotent and does not duplicate profiles on retry.

Owned cases migrate into their owner's private library. In single-user mode, legacy cases migrate into the `@single` owner library. Multi-user ownerless legacy remote cases remain custom until an administrator explicitly converts them: assigning a shared legacy case to one user's private library would be ambiguous and could expose the command.

New selections have three mutually exclusive states:

- **Default Codex command:** no profile link and no custom case command.
- **Saved profile:** profile link present; custom case command cleared.
- **Custom command:** profile link cleared; raw custom command present.

## APIs and authorization

Provide authenticated owner-scoped routes:

- `GET /api/codex-command-profiles` returns profiles and computed referencing-case usage.
- `POST /api/codex-command-profiles` creates a profile.
- `PUT /api/codex-command-profiles/:id` updates name and/or command. If usage is nonzero, require an explicit confirmation flag and return the affected count before mutation.
- `DELETE /api/codex-command-profiles/:id` rejects with a conflict and affected case names while usage is nonzero; it deletes only when unused.

Remote case create/update accepts a Codex selection of `default`, `profile`, or `custom`. It validates profile ownership before storing a profile ID. Existing case-access rules remain the authority for all reads and writes; profile APIs must not disclose profile names, commands, usage, or case names across owners.

Profile commands are user-owned remote shell snippets, matching the current trust boundary. They are never constructed from terminal output or other untrusted session input.

## UI

The existing remote-case form replaces the raw field with:

- **Saved profile** selector containing `Default Codex command`, all owner-visible profiles, and `Custom command`.
- A read-only command preview for a saved selection.
- A command input only when `Custom command` is selected.
- A **Manage** action opening a dedicated profile manager.

The manager shows profile name, command preview, usage count, and referencing case names. It supports creating profiles, editing names/commands, and deleting unused profiles. Editing a referenced command requires a clear confirmation such as “Update Personal for all 3 cases?” Deletion remains unavailable with a visible explanation until references are reassigned.

All controls support loading, saving, failure rollback, and responsive mobile layout. The selected profile must render by stable ID so renaming a profile changes the label everywhere without changing the selected case state.

## Error handling

- Invalid names, commands, profile IDs, and incompatible selection payloads return normal input errors.
- A profile update without required confirmation returns the usage count and affected cases; no mutation occurs.
- Referenced-profile deletion returns a conflict with affected case names; no mutation occurs.
- UI save failures restore the last confirmed selection and show an error toast.
- Missing/corrupt profile references fail launch with an actionable configuration error and prompt the user to select another profile or custom command.

## Test plan

Add focused coverage for:

- State persistence, owner isolation, stable IDs, name uniqueness, and restart behavior.
- Migration deduplication, derived names, collisions, idempotency, and legacy ownerless behavior.
- Authenticated API ownership, validation, usage reporting, update confirmation, and delete conflicts.
- Remote-case lifecycle: profile selection, custom/default transitions, rename/delete handling, and stale/missing profile launch errors.
- Remote tmux command resolution: selected profile, custom command, default fallback, owner isolation, and unchanged non-Codex modes.
- Browser behavior: selector, preview, custom input, manager CRUD, edit confirmation, delete blocking, responsive layout, and failed-request rollback.

## Non-goals

- Profiles for non-Codex modes.
- Sharing profiles between users.
- Applying profiles to remote-host or Docker-host command override fields.
- Silent fallback from a missing profile to a different Codex command.
