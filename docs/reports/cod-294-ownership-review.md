# COD-294 — session ownership on tail-file, download and source routes

**Lane:** review-gated (`security` label). Implemented on `cod-294-session-ownership`, **not merged**.
**Date:** 2026-08-15 · **Base:** `local` @ `9ea95571` (v1.18.4, upstream drift 0)

## 1. The defect

`findSessionOrFail(ctx, sessionId, req?)` (`src/web/route-helpers.ts:266`) performs the
ownership check **only when the request is passed**. Without `req` it degenerates into an
existence check, and in multi-user mode any authenticated non-admin who knows (or guesses)
another user's session id reaches that session's `workingDir`.

Seven call sites were passing no request:

| Route | Method | Effect for a foreign non-admin |
| --- | --- | --- |
| `/api/sessions/:id/tail-file` | GET | **Read** — opens an SSE `tail -f` on any file in another user's workspace |
| `/api/sessions/:id/tail-file/:streamId` | DELETE | Closes a stream by id; also confirms the session exists |
| `/api/download` | GET | **Read** — downloads any non-blocklisted file in another user's workspace |
| `/api/sessions/:id/sources` | GET | Reads another user's source list (titles + URLs) |
| `/api/sessions/:id/sources` | POST | **Write** — injects a source into another user's session |
| `/api/sessions/:id/sources/upload` | POST | **Write** — plants a file in another user's workspace (`.codeman-sources/`) |
| `/api/sessions/:id/sources/:sourceId` | DELETE | **Write** — removes another user's source |

The issue named the first three; the other four came out of its "audit adjacent routes for
the same unchecked lookup pattern" acceptance criterion. They are the more serious half:
three of them **mutate** another user's session, and the upload one writes attacker-chosen
bytes into another user's workspace, which an agent running in that session may then read.

## 2. Exploitability and blast radius

- **Requires multi-user mode** (`--multiuser` / `CODEMAN_MULTIUSER=1`, off by default). With
  it off, `canAccessOwned()` short-circuits to `true` and behaviour is unchanged, so a
  single-user install was never affected.
- **Requires an authenticated account** on the instance and knowledge of a target session id.
  Session ids are UUIDs and are not enumerable through a list endpoint (the list routes are
  already owner-scoped), so this is a privilege boundary failure between known users rather
  than an unauthenticated read.
- **Bounded by the workspace**: every one of these routes still applies
  `validateSessionFilePath()` (realpath + workspace containment) and the sensitive-path
  blocklist, so the exposure is another user's *workspace*, not arbitrary host files. That
  workspace is exactly what multi-user mode exists to separate.
- Multi-user mode is documented as a **workspace** boundary, not an agent sandbox (all
  sessions still run as one OS account). This bug broke the boundary that *is* claimed.

## 3. The fix

Pass `req` at all seven sites, so the lookup is ownership-aware, and place it **before** any
filesystem work, stream allocation or rate-limit accounting:

- `src/web/routes/file-routes.ts` — tail-file GET (before `fileStreamManager.createStream`),
  tail-file DELETE, `/api/download` (before `validateSessionFilePath` / `fs.stat` / open).
- `src/web/routes/source-routes.ts` — all four routes. The upload route additionally moves
  the lookup **above** its per-`(IP, sessionId)` token bucket, mirroring the attachment
  upload route (`file-routes.ts:1999`): otherwise foreign 404s drain the owner's quota, which
  turns an authorization bug into a cheap denial-of-service against the legitimate owner.

Behaviour for the owner and for admins is unchanged. A foreign non-admin now receives the
same `404 { success:false, error:"Session <id> not found", errorCode:NOT_FOUND }` used
everywhere else, so the response does not distinguish "not yours" from "does not exist".

## 4. Verification

Red-first, both suites:

- `test/routes/file-routes-ownership.test.ts` (extends the COD-292 file) — 5 new cases.
  **Before the fix: 3 failed** (foreign caller got `200` from tail-file GET, tail-file DELETE
  and `/api/download`) **/ 8 passed**; the owner+admin control cases passed throughout, which
  is what proves the new assertions bite on the vulnerability rather than on the harness.
- `test/routes/source-routes-ownership.test.ts` (new) — 6 cases.
  **Before the fix: 5 failed / 1 passed**; after: 6/6.
- After the fix: **11/11** and **6/6**.

Owner/admin coverage is asserted through the first guard *after* the lookup (missing `path`
→ 400, unknown stream id → `{closed:false}`, download headers), which is what demonstrates
the ownership check runs ahead of the work rather than after it.

Gate (run by the orchestrator, visible output): `tsc --noEmit` 0 · `npm run lint` 0 ·
`prettier --check` clean on all four changed files · `npm run test:ci` — see the Jira note
for the exact pass/fail counts on this base.

## 5. Residual risk / not taken

- **Static analysis is the real fix.** `findSessionOrFail`'s `req` parameter is optional, so
  every future call site can silently reopen this. Options: make `req` required and give the
  handful of genuinely request-less callers an explicit `findSessionUnscoped()`, or add a lint
  rule. Out of scope here (it touches every route file) — worth its own ticket.
- The upload rate-limit key is `${req.ip}:${sessionId}`, so users behind one NAT still share a
  bucket per session. Unchanged by this fix and not a boundary this issue claims.
- No frontend change: every caller of these routes already operates on its own sessions.
