# COD-314: Restore Codex Predictor Identity from tmux

## Problem

Read My Mind records secret-free Codex provider provenance in `state.json`. Sessions created before that record existed were
restored conservatively as credential-lost and then persisted as `credentialSource: "session-key"`. This permanently fences
the predictor after every routine Codeman restart, even when the still-running Codex pane uses the ordinary restorable Codex
login. All current affected production panes have this mismatch: the disk record says `session-key`, while their live tmux
session contains no Codex API-key override.

Session Bridge demonstrates the relevant lifecycle property: Codeman's tmux server and panes survive a Codeman process
restart. Per-session environment set by Codeman therefore remains an authoritative, runtime-only recovery source for the
same live pane.

## Decision

On local Codex mux restoration, recover only the closed provider allowlist `CODEX_HOME`, `OPENAI_API_KEY`, and
`CODEX_API_KEY` from the exact mapped tmux session. Feed that runtime-only environment into the restored `Session` before
computing whether credentials were lost.

- A present API key restores the exact session credential in memory. It is never written to `state.json`, returned by an
  API, logged, or interpolated into a process command line.
- A present `CODEX_HOME` restores the same configuration namespace and is canonicalized by the existing Session logic.
- When the live tmux session has no provider override, a legacy or previously fenced record is healed to
  `credentialSource: "restorable"`: the pane demonstrably uses Codex's normal ambient login, matching Session Bridge-created
  sessions.
- An unreadable, missing, malformed, remote, Docker, or non-Codex mux environment does not heal anything. Existing
  fail-closed behavior remains.
- An explicit recognized `restorable` disk record remains restorable without requiring tmux environment recovery.

The recovered values live only on `Session._envOverrides`. Existing persistence continues to discard API keys while writing
the corrected secret-free provenance. This makes the first successful restoration self-healing for later restarts.

## Components and Data Flow

1. `TmuxManager` exposes a narrow method that reads selected environment variables for one validated, tracked mux session.
   It uses argv-based process execution and returns only recognized non-empty values.
2. The server restoration loop calls that method only for local Codex sessions.
3. A pure resolver combines saved provenance with the recovered live environment. Live provider data can heal a fenced
   record; absence can heal only when the exact live tmux environment was read successfully and contains no provider
   overrides.
4. `Session` receives the resolved provenance and recovered provider environment. Read My Mind then uses its existing
   provider lane and isolation controls unchanged.

## Error and Security Boundaries

Failure to read tmux is not evidence of default authentication and must remain fenced. The distinction between “read
successfully with no matching variables” and “could not read” is explicit. Target names are taken from Codeman's reconciled
mux registry and validated by the existing safe-name rules. Error messages contain no environment values. Tests must prove
that secrets remain absent from public state and disk persistence.

## Verification

- Pure restoration tests: explicit restorable provenance, legacy empty live environment, retained API-key environment,
  retained `CODEX_HOME`, unreadable tmux, malformed values, and non-Codex modes.
- Tmux-manager tests: allowlist enforcement, empty/unset parsing, and command failure.
- Read My Mind route regression: healed sessions reach the Codex predictor; unrecoverable sessions still fail closed.
- Repository gates: focused tests, typecheck, lint, formatting, lockfile, and production build.
- Live beta/production check: restart Codeman while an existing Codex pane survives, then confirm Read My Mind succeeds for
  that restored session without creating a new pane or involving Claude.
