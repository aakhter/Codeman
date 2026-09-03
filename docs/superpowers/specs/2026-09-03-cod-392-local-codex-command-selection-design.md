# COD-392 Local Codex Command Selection — Design

Goal: add reusable Codex command selection to managed-local and linked-local cases.

Decisions:
- Owner-scoped `caseCodexCommandSelections` map in AppState; absence = default.
- Top-level `CaseInfo.codexCommandSelection`; keep nested remote for compat.
- Complete command executes as-is; no flags appended.
- Single-user: allowed; multi-user: require privileged-command grant at save, launch, respawn, recovery.
- Rename moves metadata; delete removes it; profile deletion blocked while used.
- Docker unsupported; resolved command persisted privately in session for stable respawn/recovery.
