# Bounded inspection and guarded submission

Use these commands inside a Codeman session. They use its authenticated HTTP API;
no direct tmux access, second transport, or session-bridge installation is required.
They supplement `send`, `wait` and `read`. Saved transcript queries and explicit
external tmux targets use the native [local session tools](local-session-tools.md),
which replace the separate session-bridge installation.

## Inspect recent evidence

```bash
codeman agent inspect "$SID" --max-bytes 8192 --json
codeman agent inspect "$SID" --max-bytes 8192 --since "$CURSOR" --json
```

Read `source`, `identity`, `activity`, `evidence`, `truncated` and `cursor` before
interpreting the result. `maxBytes` bounds UTF8 evidence bytes, excluding the JSON
metadata/envelope. The default is 8192, maximum 65536.

- `codex-jsonl`: strictly attributed local Codex JSONL records. The first call
  selects recent complete records within a bounded tail window;
  `omittedBeforeBytes` labels older bytes deliberately omitted. A cursor continues
  after the last consumed complete record. Partial final records remain pending.
- `pane-snapshot`: UTF8-safe tail of a visible frame or the session's buffered
  output. It has `incremental:false` and `cursor:null`. This is the fallback for
  other modes, remote/container sessions, ambiguous attribution, and exhausted
  attribution budgets. Repeating a snapshot can repeat evidence.

Cursors are opaque, scoped to the requesting identity, session, pane generation
and attributed transcript, expire after 15 minutes, and disappear on server
restart. At most 1024 are retained; capacity eviction can invalidate an older
cursor. A replaced/truncated/rewritten source, reassociated session, foreign cursor
or unavailable native source returns `409 CONFLICT`. Inspect again without
`--since` to establish a new tail baseline; this may omit older evidence.

`blockedReason` explains an unfinished or oversized record. Incremental reads
never split or silently skip one. Increase the byte budget for
`record-exceeds-output-budget`; when the record exceeds the maximum or scan cap,
use `read --tail` for a labeled terminal view or start a fresh tail baseline.
Inspect scans at most 256 KiB of record data plus bounded generation anchors.
Attribution separately caps directory entries and metadata bytes. Evidence and
activity are observations, not proof of task completion or authorization.

## Stage, inspect, then submit once

```bash
printf '%s' 'Review src/ and report the failing tests' > /tmp/codeman-message.txt
codeman agent stage "$SID" --message-file /tmp/codeman-message.txt --json
# Review the returned stageId, sha256, expiresAt; inspect the target if needed.
codeman agent submit "$SID" --stage-id "$STAGE_ID" --confirm-sha "$SHA256" --json
```

Stage types the file contents **without Enter**. The file must be regular UTF8,
at most 8192 bytes; one terminal newline is normalized. Terminal control characters
and trailing whitespace are refused. Multiline text additionally requires the
explicit `--multiline` option and active bracketed-paste mode in the target.
The server requires a characterized local Codex or Claude composer, exact logical
rows and caret evidence. Unknown, working, modal, ambiguously wrapped,
remote/container and shell composers are refused. A customized footer or
unsupported character-width rendering can also make verification unavailable.
Self-targets are refused by the CLI. If the complete draft does not fit a verifiable
composer, write a workspace file and stage a short instruction referencing it.

The receipt stores a hash and ephemeral identities, never prompt content. It
expires after two minutes; capacity is 1024 live receipts. Stage delivery can
precede the next screen paint: a receipt acknowledges typing, while submit still
requires the fully painted exact composer. If typing fails or is ambiguous, stage
issues no receipt; inspect the pane before trying again.

Submit checks the caller, session, hash, expiry, pane lifecycle, input revision,
exact composer and caret, then sends one conditional Enter at the session's input
boundary. Competing Codeman writes are refused during dispatch. Browser/API/key
input and managed restarts invalidate receipts even when the visible text or pid
is restored. Direct tmux edits are outside that input serialization; captures
remain evidence at the time observed, rather than terminal isolation.

Every owned submit attempt consumes its receipt, including hash mismatch,
verification failure and delivery failure. Concurrent/repeated submits cannot
replay Enter, and there is no autonomous retry. A successful response means one
Enter was delivered; use inspection or a suitable wait signal to observe native
acceptance. A `409` or broken connection means inspect first. Do not automatically
stage/submit again or send an unguarded Enter to recover.
