# COD-549: retire session-bridge

The user approved the replacement design and implementation on 2026-10-24.

## Decision

Make Codeman the sole installed coordination skill. Implement native TypeScript local operator tools, not a Python wrapper. Existing authenticated agent endpoints remain session-scoped. Arbitrary local file and tmux targets are available only to the machine's local operator CLI. Preserve current-session identity guards and explicit target selection.

## History

`codeman history read` accepts exactly one of `--file`, `--session-id`, or `--root-session-id`, plus `--sessions-root`, `--topic`, `--after`, `--before`, `--max-bytes`, and JSON/text output. It works without a running server or CODEMAN_MUX. Resolve native Codex session identities from metadata, never cwd/mtime guesses. Traverse parent relationships transitively with cycle protection. Preserve complete user/assistant turns and source identity/time; reject ambiguous IDs, malformed dates, missing evidence, invalid UTF8, nonregular files and exhausted budgets. Explicitly report incomplete scans/truncation; never claim an incomplete family is complete. Scan and output budgets are bounded independently. No HTTP endpoint accepts arbitrary transcript paths.

## Local terminal operators

`codeman local inspect`, `stage`, and `submit` require explicit socket/target. Inspect returns bounded, labeled pane evidence. Stage types without Enter, verifies a supported empty composer and caret, and issues a private short-lived receipt tied to pane identity and message hash. Submit consumes the receipt once, verifies exact contents/caret and pane identity, and sends one Enter without retry. Reject self-target, foreign receipt, changed pane, changed composer, expired receipt, unsupported composer, embedded terminal controls, symlinks and nonregular receipt/message files. Local tmux captures do not serialize independent tmux writers; this limitation is explicit. No claim that local snapshots provide the managed API input revision guarantee. Never create another session just to inspect one.

## Composer support

Extend characterized Codex composer verification to explicit multiline paste with exact rows/caret. Add a characterized Claude profile only when fixture evidence supports reliable identification; unsupported or ambiguous states fail closed. Profile selection uses registry capabilities. Preserve lifecycle generation, pending input, input revision, draft fences and one-shot receipts. Newline paste is bracketed, never raw Enter. Explicit multiline authorization is required. Ordinary message files may normalize one terminal newline, without stripping meaningful interior content.

## Working directories

Add `codeman agent spawn --working-dir <existing-directory>` and default to the current directory when no case is named. Use existing session-create and interactive-start APIs rather than bypassing workspace ownership checks. Keep explicit named-case quick-start behavior unchanged. Validate mode and directory, preserve parent lineage, and report readiness and failed-created-session identities honestly.

## Migration and acceptance

Cover real file fixtures, root/child genealogy, filters, malformed and bounded records, unsupported modes, exact staging, receipt consumption, input races and CLI parsing. Run existing focused guards plus typecheck, lint, format and lockfile checks. Synchronize packaged skill and plugin mirror. Update agent/web documentation with exact commands and limitations. Land verified code on Bitbucket local. Retain a reversible copy of the installed old skill until the new CLI is built and smoke-tested; then remove session-bridge from discovery and update workspace guidance. No deployment of the production web server is implicit in this implementation request.
