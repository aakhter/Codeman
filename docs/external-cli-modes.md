# External CLI Modes (OpenCode, Codex, Gemini)

Codeman runs non-Claude agent CLIs alongside Claude Code. `SessionMode` is
`'claude' | 'shell' | 'opencode' | 'codex' | 'gemini'`; the non-Claude agent
modes are "external CLI" modes that render their own TUIs, so Codeman steps back
from the Claude-specific parsing it normally does.

This doc covers the session-level gating and the Codex specifics. For the
OpenCode resolver design, see `docs/opencode-integration.md`.

## Gating: `isExternalCliMode()`

`isExternalCliMode()` in `session.ts` gates Claude-specific behavior — **Ralph
tracker, BashToolParser, token/CLI-info parsing, and ❯-prompt readiness detection
are all skipped** (these CLIs render their own TUIs; readiness is detected by
output stabilization instead). Respawn/Ralph options are Claude-only, so the
session-options dialog opens on the **Summary** tab for external CLI sessions.

## tmux is required (no direct PTY fallback)

Both OpenCode and Codex **require tmux — there is no direct PTY fallback** —
because secrets are injected via `tmux setenv`, never on the spawn command line:

- **OpenCode** gets `OPENCODE_CONFIG_CONTENT` etc.
- **Codex** gets `OPENAI_API_KEY` / `CODEX_API_KEY` / `CODEX_HOME`
  (`setCodexEnvVars` in `tmux-manager.ts`).

## Codex specifics

- Command built by `buildCodexCommand()`: `--model`, `resume <id>`, and
  `--dangerously-bypass-approvals-and-sandbox` (from the `codexConfig` payload /
  `codexDangerouslyBypassApprovals` app setting). `renderMode` is schema-coerced
  to `'hybrid'`, the only supported mode.
- tmux exports `COLORTERM=truecolor` and unsets `NO_COLOR` (other modes unset
  `COLORTERM`).
- Availability via `GET /api/codex/status` — session/quick-start routes fail with
  `OPERATION_FAILED` and an install hint (`npm install -g @openai/codex`) when the
  binary is missing.
- **Frontend**: run-mode dropdown → `runCodex()` in `session-ui.js` ("Run CX"
  label), App Settings → Codex CLI tab.
- Agent checkpoints use positive rendered-frame evidence: Codex is ready only
  when the `›` input prompt is visible and no `Working (... esc to interrupt)`
  frame is present. A quiet-window `isWorking === false` is not readiness.
- **Tests**: `test/run-mode-ui.test.ts` (vm-sandbox harness, no real DOM) and
  `test/codex-working-detection.test.ts` (working frames + checkpoint prompts).

## Related

- `docs/opencode-integration.md` — OpenCode resolver design.
- `CLAUDE.md` → Common Gotchas → **Multi-CLI prefix discipline** (env-var prefix
  allowlist) and **`envOverrides` flow** (the secret-injection path).
- CLI path resolution: `src/utils/{claude,opencode,codex,gemini}-cli-resolver.ts`.
