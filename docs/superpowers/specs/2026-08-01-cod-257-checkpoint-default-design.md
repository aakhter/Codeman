# COD-257: Persistent Agent Checkpoint Default

## Goal

Let an operator choose whether Agent Checkpoint is enabled for newly created agent sessions. The setting is enabled by default, persists across Codeman rebuilds and upgrades, and is shared by desktop browsers and installed mobile/PWA clients.

## Source of truth

`settings.json` is authoritative. `PUT /api/settings` validates and persists `checkpointDefaultEnabled`; `GET /api/settings` returns it to every client. Browser local storage may cache the value through the existing settings synchronization flow, but a client must not become the source of truth.

When the key is absent, the effective default is `true`. This makes Agent Checkpoint default-on for fresh and upgraded installations while still allowing an operator to turn it off globally.

## Session behavior

Every newly created agent session receives the effective app default at construction time, including interactive creation, quick start, Ralph/plan-driven creation, and scheduled/workflow creation paths. The initial allowed modes remain `compact` and `clear`; this setting changes only enablement.

Existing or restored sessions are not rewritten. Recovery continues to restore the persisted per-session `checkpointEnabled` and `checkpointModes` fields. The existing Session Options control remains the authoritative per-session override after creation.

Shell-only sessions may carry the same inert permission value for consistency, but no checkpoint runs unless an agent explicitly invokes the checkpoint hook.

## UI

Add an “Agent Checkpoint for new sessions” switch to App Settings in an Automation section. The switch reads the server-synchronized value, defaults checked when absent, and writes it through the existing settings save path. Copy must make clear that it affects new sessions only.

## Implementation boundaries

- Add `checkpointDefaultEnabled` to the strict settings schema.
- Add one cached settings resolver to the server configuration port.
- Add an optional initial checkpoint flag to `Session`; initialize `SessionAutoOps` once from it.
- Pass the resolved default through every production new-session path, while recovery supplies saved per-session state instead.
- Wire the App Settings control into open, save, defaults, and server synchronization using existing patterns.
- Do not change checkpoint sequencing, command delivery, lifecycle events, modes, CLI behavior, or existing-session persistence.

## Failure behavior

Missing or malformed settings files use the safe product default (`true`). A rejected settings update leaves the prior server value intact. Session creation should not fail solely because the settings file is absent.

## Verification

Use TDD with focused regressions proving:

1. A new `Session` can initialize checkpoint permission ON or OFF without changing mode defaults.
2. The strict settings schema accepts the boolean and rejects invalid values.
3. Standard and quick-start creation receive the server-resolved default.
4. Restored sessions keep their saved per-session value, including OFF while the global default is ON.
5. The App Settings switch is default-checked when absent and round-trips through the server-synchronized settings payload.

Run targeted Vitest files only, then typecheck, lint, Prettier, lockfile, frontend syntax/public-asset checks, build, and an isolated `:5000` browser/API check. Treat this as substrate-adjacent session lifecycle work: land verified changes to `local` as deploy-pending, with no production restart without explicit authorization.
