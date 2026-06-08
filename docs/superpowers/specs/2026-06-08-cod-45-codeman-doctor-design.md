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

Codeman's own runtime deps are minimal (Node, Claude CLI, tmux), but many skills
shell out to optional tools at runtime — LibreOffice / MS Office (docx/pptx/
spreadsheet skills), pandoc (cisco-pandoc-docx), ffmpeg (video-transcribe-docx),
imagemagick (image-input), etc. Today a missing tool fails deep inside a session
with an opaque error. A single preflight report makes environment readiness
visible up front, and the `usedBy` mapping tells the user *which skill* a missing
tool would break.

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
  category: 'core' | 'office' | 'documents' | 'media' | 'other';
  required: boolean;          // core deps required; skill deps optional
  usedBy?: string[];          // skills/features that need it (for the report)
  minVersion?: string;        // optional floor; warn if below
  resolvers: ResolverSpec[];  // environment-appropriate resolution (see below)
  installHint?: Partial<Record<'linux' | 'darwin' | 'win32' | 'wsl', string>>;
}
```

Seed entries: **core** → node, claude (and opencode if resolvable), tmux;
**office** → libreoffice/soffice, msoffice; **documents** → pandoc; **media** →
ffmpeg, imagemagick. A comment marks `resolvers` as the extension point where
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
$ codeman doctor

Codeman dependency check — wsl (x64)

CORE
  ✓ node          v22.22.1            /home/.../node
  ✓ claude        2.1.168             /home/.../claude
  ○ opencode      not found           (optional — only for OpenCode sessions)
  ✓ tmux          3.4                 /usr/bin/tmux

OFFICE
  ✓ libreoffice   24.2.7.2            /usr/bin/soffice
  ✓ msoffice      16.0.19929          C:\...\Office16\WINWORD.EXE  (via WSL interop)
                                      used by: slides, spreadsheet, docx

DOCUMENTS
  ✓ pandoc        3.9                 /opt/.../pandoc

MEDIA
  ✗ ffmpeg        not found           used by: video-transcribe-docx
                                      install: sudo apt install ffmpeg
  ○ imagemagick   not found           used by: image-input

Summary: 6 ok · 0 core-required missing · 2 skill/optional missing
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
