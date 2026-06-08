# COD-45 — `codeman doctor` dependency check

**Date:** 2026-06-08
**Jira:** [COD-45](https://aakhter.atlassian.net/browse/COD-45)
**Status:** Design approved, pending implementation plan

## Summary

Add a `codeman doctor` CLI command (alias `check-deps`) that probes the host for
the tools Codeman and its skills/workflows depend on, reports presence + version
per tool grouped by category, and exits non-zero when a **core-required**
dependency is missing or too old. Probes are environment-aware
(`linux | darwin | win32 | wsl`) so Windows-side tools reachable from WSL are
detected as present.

## Motivation

Codeman shells out to a handful of external tools: the agent CLIs it can drive
(Claude, OpenCode, Codex, Gemini), tmux for session multiplexing, and
LibreOffice / MS Office for DOCX→PDF document preview and thumbnails
(`document-preview-cache.ts`, `document-thumbnailer.ts`). When one is missing,
failures surface deep inside a session or a preview path with an opaque error. A
single preflight report makes readiness visible up front, and the `usedBy`
mapping tells the user *which Codeman feature* a missing tool affects.

Scope note: this checks tools **Codeman itself** uses. Tools that only specific
Claude Code *skills* invoke (e.g. pandoc, ffmpeg) are intentionally out of scope —
they vary by which skills are installed and are not a property of the Codeman
product. Skill-tool discovery remains a possible follow-up.

## Command surface

`codeman doctor` (alias `check-deps`), registered in `src/cli.ts` alongside the
existing `commander` commands.

- **Default:** human-readable report, tools grouped by category, each row showing
  a status glyph, version, resolved path, and (for missing tools) an install hint
  and the skills that need it.
- `--json`: structured machine output (same data).
- `--category <name>`: optional filter (e.g. `office`).
- **Exit code:** `0` if all core-required deps present; non-zero if any
  core-required dep is missing/outdated. Missing optional/skill deps are warnings
  only and never affect the exit code.

### Status vocabulary

`ok | missing | outdated | skipped | error`

- `skipped` — not applicable in this environment (e.g. `msoffice` on plain Linux
  with no interop; LibreOffice covers that lane).
- `error` — resolver found the tool but version probe failed to parse.

## Dependency registry

Static, hand-maintained registry in `src/config/dependency-registry.ts`. Each
entry:

```ts
interface ToolDependency {
  id: string;                 // 'msoffice'
  label: string;              // 'MS Office'
  category: 'core' | 'office' | 'other';
  required: boolean;          // core deps required; skill deps optional
  usedBy?: string[];          // skills/features that need it (for the report)
  minVersion?: string;        // optional floor; warn if below
  resolvers: ResolverSpec[];  // environment-appropriate resolution (see below)
  installHint?: Partial<Record<'linux' | 'darwin' | 'win32' | 'wsl', string>>;
}
```

Seed entries: **core** → node, tmux (hard-required) plus the agent CLIs
claude, opencode, codex, gemini (all optional — Codeman runs any of them);
**office** → libreoffice/soffice, msoffice (DOCX→PDF preview & thumbnails). Only
node and tmux are required; everything else is advisory and never fails the exit
code. A comment marks `resolvers` as the extension point where
future skill-driven discovery will merge in dynamically-found deps.

## Environment-aware probes (incl. WSL)

The probe engine detects the current environment at runtime:
`linux | darwin | win32 | wsl`. WSL is detected via `/proc/version` plus the
presence of `cmd.exe` / `powershell.exe` interop. On WSL, Windows-installed apps
are reachable from Linux and **must** be detected as present.

A tool declares one or more `ResolverSpec`s; the engine picks the one matching the
detected environment:

- **PATH resolver** (default): resolve a binary on the Linux/macOS `PATH`; version
  via `<bin> <versionArg>` parsed with a per-tool regex.
- **Windows-side-under-WSL resolver**: search
  `/mnt/<drive>/Program Files[ (x86)]/<app dir>/*.EXE`; read version via
  `powershell.exe … VersionInfo.ProductVersion`.
- **win32 resolver**: native Windows program-dir paths.

`msoffice` is the seed consumer of the Windows-side resolver:

- `wsl` → Office16 EXEs under
  `/mnt/<drive>/Program Files[ (x86)]/Microsoft Office/root/Office16`
  (`WINWORD.EXE` / `POWERPNT.EXE` / `EXCEL.EXE`), version via interop.
- `win32` → native Office16 paths.
- plain `linux` / `darwin` without interop → `skipped`.

A tool found on the Windows side counts as **present** and never contributes to a
non-zero exit. The resolver is generic, so other tools (e.g. a Windows `ffmpeg.exe`)
can opt in later.

## Modules & boundaries

| Module | Responsibility |
|--------|----------------|
| `src/config/dependency-registry.ts` | Static data: the typed list of `ToolDependency` entries. No logic. |
| `src/utils/dependency-checker.ts` | Probe engine. Environment detection + resolvers + version parse/compare. Returns structured `ToolResult[]`. Pure given injected resolvers. |
| `src/utils/dependency-report.ts` | Formatting: `ToolResult[]` → table string or JSON. No probing. |
| `src/cli.ts` | Wires the `doctor` command: calls the checker, picks formatter by `--json`, sets exit code. |

Probe logic and formatting are separate so each is testable in isolation: mock the
resolver and assert on `ToolResult[]`; feed fixed `ToolResult[]` and assert on
rendered output. Environment detection and interop are injectable so tests are
deterministic on any CI host.

## Example output

```
$ aicodeman doctor

Codeman dependency check — wsl

CORE
  ✓ Node.js       22.22.1             /home/.../node
  ✓ Claude CLI    2.1.168             /home/.../claude   (default backend)
  ✓ tmux          3.4                 /usr/bin/tmux
  ○ OpenCode CLI  not found           used by: OpenCode sessions
  ✓ Codex CLI     0.137.0             /home/.../codex
  ✓ Gemini CLI    0.42.0              /home/.../gemini

OFFICE
  ✓ LibreOffice   24.2.7              /usr/bin/libreoffice   used by: document preview, thumbnails
  ✓ MS Office     16.0.19929          C:\...\Office16\WINWORD.EXE  (via WSL interop)

Summary: 7 ok · 0 required missing · 1 optional missing
Exit code: 0
```

## Out of scope (follow-up issues)

- Skill-manifest-driven dependency discovery (dynamic registry).
- Web UI panel + `GET /api/diagnostics/dependencies` endpoint.
- Auto-install of missing tools.

## Acceptance criteria

1. `codeman doctor` lists all registry tools grouped by category with
   found/missing/outdated/skipped status and version.
2. A present tool shows resolved path + parsed version; a missing core-required
   tool causes non-zero exit; a missing optional/skill tool does not.
3. On WSL with MS Office installed, `msoffice` shows `ok` with the Windows path +
   ProductVersion and does not affect exit code; on plain Linux/macOS without
   interop it shows `skipped`.
4. `--json` emits the same data as valid structured output
   (`status ∈ ok|missing|outdated|skipped|error`).
5. Unit tests (CI-safe, no tmux, mocked resolvers) cover
   found / missing / outdated / version-parse-error / wsl-windows-side / skipped,
   plus a formatter check for table + JSON.

## Testing notes

Tests must not spawn tmux. Mock the binary / Windows-side resolvers; assert on
probe results and on rendered table/JSON output. WSL detection and interop are
injected/mocked so tests are deterministic on any CI host.
