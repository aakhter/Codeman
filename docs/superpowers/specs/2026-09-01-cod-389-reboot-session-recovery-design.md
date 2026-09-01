# COD-389: Reboot Session Recovery Design

## Problem

Codeman's tmux-backed sessions survive a browser disconnect and a Codeman-process
restart, but a host reboot terminates the local tmux server. Startup correctly
removes the dead mux records, yet the user loses the convenient path back to the
CLI conversation even when the CLI's own transcript still exists.

Recovery must preserve conversation continuity without unexpectedly restarting
agents after an outage. It also must distinguish a local reboot from a remote
session whose remote tmux server is still alive.

## Goal

After a host reboot, Codeman presents a persistent, selective Recovery section.
Each eligible prior session can be reattached or resumed in a new local pane,
using the correct transport and CLI-native identity. No agent continues work
until the user explicitly selects an action.

## Non-goals

- Recreating a dead local tmux pane or its terminal scrollback.
- Automatically resuming every session on boot.
- Inferring how an arbitrary custom command accepts a resume identifier.
- Altering ordinary Codeman-process restart recovery, existing remote discovery,
  or Docker-case lifecycle behavior.
- Adding resume support for CLIs without a verified, durable session identity.

## Existing behavior to preserve

- A Codeman-process restart reconciles and reattaches surviving local tmux sessions.
- A local host reboot kills those tmux sessions; dead mux/state entries are
  reconciled at startup.
- Claude transcript history and conversation IDs support `claude --resume <id>`.
- Codex rollout IDs are captured for resumable sessions and launch through
  `codex resume <id>`.
- OpenCode accepts `opencode --session <id>` and optional `--fork`. Codeman
  already discovers and persists that ID when a session is explicitly parked,
  then relaunches it through `openCodeConfig.continueSession`; reboot recovery
  must reuse and extend this path without relying on a shared working directory.
- Owned remote sessions use a separate remote tmux socket and deterministic name;
  discovered remote sessions are attach-only and must never be created or killed
  by this Codeman instance.
- Docker cases already prefer an inner-tmux reattach and otherwise use their
  persisted resume information.

## Recovery record

Introduce a versioned persisted recovery record separate from an active session
record. It is retained when a previously managed session becomes unavailable due
to boot reconciliation. It contains only data needed to decide and execute a
safe recovery:

- Original Codeman session ID, display name, mode, working directory, creation
  and last-activity timestamps.
- Transport snapshot: `local`, `remote`, or `docker`; remote host/case reference,
  remote path, remote tmux name, and ownership; Docker case/container reference.
- A CLI recovery identity with its type (`claudeConversation`, `codexRollout`, or
  `openCodeSession`) and a validated ID.
- Launch provenance: a built-in launcher or a custom command identifier and its
  declared recovery strategy.
- Recovery outcome state: `pending`, `reattachable`, `resumable`,
  `manual_required`, `unavailable`, or `recovered`, plus a bounded diagnostic
  reason that contains no credentials or raw remote stderr.

Records are immutable evidence of the old session. A successful recovery creates
a new session ID and links it to the old record; it never mutates the old record
into a live session or deletes it merely because a resume attempt failed.

## Boot and probing flow

1. Run the existing mux reconciliation first.
2. Preserve a recovery record for each session that was managed before the boot
   but is no longer locally attachable.
3. Classify its transport before offering an action:
   - Local: resolve a CLI-native resume identity from its persisted identity or
     durable CLI history.
   - Owned remote: probe the configured host using the existing saved SSH
     connection options. If its dedicated remote tmux session still exists,
     classify it as `reattachable`; do not invoke a CLI. If it is absent, then
     resolve the remote CLI resume identity and command strategy.
   - Discovered/unowned remote: probe for attachability only. It must never
     become `resumable` through Codeman.
   - Docker: retain the existing Docker launch decision: reattach the inner tmux
     when it exists, otherwise apply the case's persisted resume path.
4. Never block server startup on an unreachable remote host. Persist a bounded
   unavailable result and retry the probe only when the user refreshes or acts
   on that row.

## CLI recovery adapters

### Claude

Use the existing authoritative Claude conversation ID and transcript lookup.
The recovery action launches `claude --resume <conversation-id>` in the original
working directory or through the applicable transport command builder.

### Codex

Use the validated rollout ID captured from Codex's persistent session data. The
built-in launcher recovers through `codex resume <rollout-id>` while retaining
the normal model, credential, and environment setup supplied by Codeman.

### OpenCode

Reuse the existing native-resume identity and `openCodeConfig.continueSession`
launch path. Extend identity capture so an unplanned reboot has an effective
OpenCode session ID without associating concurrent panes solely by working
directory or most-recent timestamps. Persist that ID as `openCodeSession`. The
normal recovery action launches `opencode --session <id>`; a user may choose Fork
only as an explicit secondary action, never as the default recovery path.

## Custom Codex launch commands

Custom launch commands and per-remote-host `commands.codex` overrides are
authoritative. Recovery must not replace them with a bare `codex resume` command
or append text to an opaque shell string.

Support three explicit strategies:

1. **Built-in**: Codeman composes the normal Codex command with the validated
   rollout ID.
2. **Declared resume template**: a trusted custom configuration supplies a
   separate resume command template containing exactly one resume-ID placeholder.
   The implementation validates the identifier before substitution and runs it
   through the same local or remote command wrapper as the original command.
3. **Opaque custom command**: Codeman exposes the saved command context and
   rollout ID as `manual_required`; it offers no automatic Resume action.

The recovery UI must explain this distinction rather than presenting a button
that silently loses a router, wrapper, or initialization step.

## Recovery Queue UX

The Session Manager/welcome screen gains a persistent Recovery section. Each row
shows the session name, CLI, transport, original location, most-recent activity,
and one explicit status. Actions are state-specific:

- **Reconnect** for reattachable owned or discovered remote sessions.
- **Resume** for a safe CLI-native recovery.
- **Fork** only for OpenCode sessions with a usable ID.
- **Start new session** for unavailable transcript/identity cases.
- **Manual recovery required** for an opaque custom command, with a copyable,
  sanitized recovery hint and no automatic command execution.

The UI confirms the working directory/remote host before launching and indicates
that recovery opens a new pane. It does not offer bulk auto-resume.

## Security and safety

- Reuse the existing remote-host configuration and SSH option validation; do not
  persist decrypted credentials or duplicate connection secrets in recovery data.
- Treat all persisted native IDs as untrusted at their command-construction
  boundary and apply CLI-specific allowlist validation.
- Do not send arbitrary saved command text through a new interpolation path.
- Keep remote probe errors sanitized and bounded in persisted state and UI.
- Enforce existing multi-user ownership checks for lists, probes, and recovery
  actions.

## Verification requirements

- Unit tests for recovery-record serialization/migration and ID validation.
- Command-builder tests for built-in Claude, Codex, and OpenCode recovery.
- OpenCode capture tests proving two concurrent panes in one working directory do
  not cross-associate session IDs.
- Boot-reconciliation tests for local dead sessions and no regression to ordinary
  process-restart reattach.
- Remote tests for live owned reattach, dead owned resume, unreachable host,
  and the prohibition on resuming an unowned discovered session.
- Docker tests confirming existing reattach/resume behavior remains unchanged.
- Custom Codex tests proving a declared template preserves its wrapper and an
  opaque command fails closed to `manual_required`.
- Route/UI tests confirming no boot action launches an agent automatically and
  that a recovery action creates exactly one new session linked to its source.

## Delivery boundaries

The implementation work must use focused tests only while running inside a
Codeman-managed session. A merge, deployment, service restart, and live reboot
exercise are separate approvals and outcomes. Before production rollout, test
with disposable local and remote sessions rather than user work.
