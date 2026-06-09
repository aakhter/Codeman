# Security Architecture

This document describes Codeman's security model: how it decides who may reach
the web UI, how requests are authenticated, how the file-serving and tmux layers
are hardened, and the recommended ways to expose an instance safely.

Codeman spawns and drives Claude/OpenCode CLIs with
`--dangerously-skip-permissions`. **Anyone who can reach an unauthenticated
instance can run arbitrary commands as your user.** The defaults below are chosen
so that a fresh install is safe on the machine it runs on, while remote access is
an explicit, guided opt‑in.

> TL;DR — Codeman binds **loopback only (`127.0.0.1`) by default**, so out of the
> box it is reachable only from the same machine and needs no password. To reach
> it from elsewhere, either put it behind an **authenticated tunnel**
> (`tailscale serve` / `cloudflared`) **or** bind a wider host **and set
> `CODEMAN_PASSWORD`**. If you bind a non‑loopback host with no password, Codeman
> still starts but prints a **loud warning** telling you how to secure it.

---

## Contents

1. [Network binding model](#1-network-binding-model)
2. [Authentication](#2-authentication)
3. [Request‑origin trust & the tunnel caveat](#3-requestorigin-trust--the-tunnel-caveat)
4. [Recommended remote‑access setups](#4-recommended-remoteaccess-setups)
5. [File‑serving hardening](#5-fileserving-hardening)
6. [tmux launch hardening](#6-tmux-launch-hardening-cod31)
7. [Supply‑chain & build‑asset hardening](#7-supplychain--buildasset-hardening-cod28)
8. [Multi‑instance isolation](#8-multiinstance-isolation)
9. [Transport security headers](#9-transport-security-headers)
10. [Quick reference](#10-quick-reference)

---

## Trust model

**The security boundary is the network bind plus authentication — not the code Codeman
runs.** Because sessions launch with `--dangerously-skip-permissions`, the web UI is by
design a remote‑code‑execution surface for whoever is allowed to reach it. Everything
below exists to control *who* that is.

| Actor | Reaches the UI when… | Is granted |
|-------|----------------------|------------|
| Same‑machine user | Always (default loopback bind) | Full session control — the intended local‑use case. |
| Authenticated remote client | Tunnel/LAN reachability **and** a valid password or session cookie | Full session control. |
| Unauthenticated remote client | Only if you bind a non‑loopback host with no password | Full session control — the exact case every default and warning works to prevent. |
| Clients behind a loopback‑connecting tunnel | A reverse tunnel terminates on `127.0.0.1` | Inherit `req.ip = 127.0.0.1`, so they hit the localhost‑only exemptions (§3) unless a password is set. |

**Explicitly out of scope.** Codeman is access control for the operator console, not a
sandbox for the code that console runs. It does **not** defend against: a compromised
local user account (loopback is trusted), malicious contents in a workspace you
deliberately open, or the breadth of filesystem a session's `workingDir` is pointed at
(§5).

---

## 1. Network binding model

| Setting | Default | Source |
|---------|---------|--------|
| Bind host | `127.0.0.1` (loopback) | `--host` / `CODEMAN_HOST` → `WebServer` ctor |
| Port | `3000` | `--port` / `CODEMAN_PORT` |
| TLS | off (`--https` to enable) | `--https` |

### Bind host classification

`isLoopbackBindHost()` (`src/web/network-auth-policy.ts`) decides whether a bind
host is loopback-only. It returns `true` for:

- `localhost`
- any IPv4 in `127.0.0.0/8` (e.g. `127.0.0.1`, `127.42.0.9`)
- IPv6 loopback `::1` (bracketed `[::1]` and the long form `0:0:0:0:0:0:0:1`)
- IPv4‑mapped loopback `::ffff:127.*`

It returns `false` for `0.0.0.0`, `::` (all interfaces), LAN IPs, and hostnames.
The classification is **fail‑safe in the dangerous direction**: any host that is
not provably loopback is treated as non‑loopback (it never mistakes `0.0.0.0`
for loopback). Shorthand forms like `127.1` or integer/octal IPs classify as
non‑loopback (you'll get a warning, not a silent wide‑open bind) — use
`127.0.0.1` for an unambiguous loopback bind.

### Startup policy (the "warn, don't block" rule)

At `WebServer.start()`:

| Bind host | `CODEMAN_PASSWORD` | Behavior |
|-----------|--------------------|----------|
| loopback (default) | unset | **Start.** Safe — reachable only from this machine. |
| loopback | set | **Start.** Auth required even locally. |
| non‑loopback | set | **Start.** Auth protects the open bind. |
| non‑loopback | unset | **Start + LOUD warning** listing how to secure it. |
| non‑loopback | unset, `--allow-unauthenticated-network` | **Start + terse acknowledged note.** |

> History: an earlier iteration (unreleased COD‑29) *refused to start* on a
> non‑loopback bind without a password. That surprised setups that "just worked"
> before, so **0.9.0 changed it to start‑and‑warn**. Loopback is still the safe
> default; the warning (with three concrete fixes) replaces the hard failure.

The warning points at three ways to secure the instance:

1. `CODEMAN_PASSWORD=<password>` — turns on HTTP Basic auth (see §2).
2. `--host 127.0.0.1` + an authenticated tunnel (`cloudflared` / `tailscale serve`).
3. `--allow-unauthenticated-network` / `CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK=1`
   — explicitly accept the risk (downgrades the warning to a one‑line note). This
   flag is **only** an acknowledgement; it does not change reachability.

`CODEMAN_API_URL` (used by hooks/child processes) is always derived as a loopback
address (`0.0.0.0`/`localhost`/`::1` → `127.0.0.1`) so in‑process hooks reach the
server over loopback regardless of the public bind.

---

## 2. Authentication

Auth is **optional** and controlled by env vars captured at startup:

- `CODEMAN_USERNAME` (default `admin` when only a password is set)
- `CODEMAN_PASSWORD`

When `CODEMAN_PASSWORD` is unset, no auth is enforced — which is why the default
loopback bind matters. The auth pipeline (`src/web/middleware/auth.ts`,
`onRequest` hook) runs in this order:

1. **Localhost‑only exemptions** (always first): `POST /api/hook-event` and the QR
   `/q/` short‑code path are exempt when `req.ip` is loopback (see §3).
2. **Session cookie** check — a valid `codeman_session` cookie short‑circuits to
   allow.
3. **HTTP Basic** check — correct credentials short‑circuit to allow and clear
   that IP's failure counter.
4. **Rate‑limit gate** — if neither cookie nor credentials passed and the IP is
   locked out, return `429` with a `Retry-After` header.
5. Otherwise return `401`, incrementing the IP's failure counter.

### Session cookies

On successful Basic auth the server issues `codeman_session`, an opaque
server‑side token (`randomBytes(32)`), valid 24h with auto‑extend and device
context for the audit log. Tokens are **not** client‑signed — they're validated
by presence in a server‑side map, so they cannot be forged offline.

### Rate limiting / lockout recovery

Failed auth is tracked **per IP**: 10 failures → `429`, with a 15‑minute decay.
The QR path has its own separate limiter.

The lockout check sits **after** the cookie/credential checks (step 4, not first).
This is deliberate: a user with a **valid cookie or correct password recovers
immediately** even while an attacker is hammering the same IP — important because
all traffic through a tunnel shares one source IP (loopback). Wrong credentials
are still counted and still hit the `429` at the threshold, so brute‑force
protection is unchanged.

---

## 3. Request‑origin trust & the tunnel caveat

`req.ip` is derived from the **TCP socket only** — Fastify runs with
`trustProxy: false`, so `X-Forwarded-For` / `X-Real-IP` / `Forwarded` are
**ignored**. A remote client cannot forge `req.ip` to `127.0.0.1`.

**However**, a reverse tunnel that connects to the server over loopback (e.g.
`cloudflared --url http://localhost:3000`) makes **every tunneled request arrive
with `req.ip = 127.0.0.1`**. The localhost‑only exemptions then treat those
requests as local:

- `POST /api/hook-event` — auth‑exempt for loopback. Bounded impact: it is
  `HookEventSchema`‑validated and requires a valid in‑memory `sessionId`; it can
  drive respawn signals, SSE broadcasts, push notifications, and transcript
  watching — **not** arbitrary terminal input or file reads. It is a
  session‑disruption / notification‑spoofing surface, not RCE.
- QR `/q/` — still protected by its own short‑code brute‑force limiter
  (10 failures / 60s against a 62⁶ space).

**Mitigation:** set `CODEMAN_PASSWORD` whenever a loopback‑connecting tunnel is
up (it does not gate the hook‑event exemption, but it gates everything else and
is the documented practice). Prefer `tailscale serve` (below), which authenticates
at the tailnet layer so untrusted clients never reach the loopback port at all.

### Host‑header & Origin allowlist (DNS‑rebinding & CSRF defense)

Since **0.9.5** an **always‑on** `onRequest` hook (`registerHostGuard`,
`src/web/middleware/auth.ts`; policy in `src/web/network-auth-policy.ts`) runs
**before** the auth pipeline in §2 and guards **every** request — including the
localhost‑only exemptions above, SSE, the WebSocket upgrade, and static files. It
closes the browser‑driven RCE path (DNS rebinding plus a cross‑site `text/plain`
`POST`) that the loopback‑no‑password default otherwise exposed to any site the
operator merely visits.

- **Host allowlist (anti‑DNS‑rebinding).** The `Host` header is validated on
  **every** request, all methods. A custom domain rebound to `127.0.0.1` is
  rejected with `403 Forbidden: host not allowed` before any handler runs. Allowed:
  `localhost`; **any** IP literal (IPv4/IPv6 — a browser hitting a numeric address
  can't be a rebinding victim); the bind host; the suffixes `.ts.net`,
  `.trycloudflare.com`, `.cfargotunnel.com`; the hostname of the active
  Codeman‑managed tunnel; and anything in `CODEMAN_ALLOWED_HOSTS`. A missing/empty
  `Host` is rejected.
- **Origin / CSRF guard.** On **state‑changing** methods (everything except
  `GET`/`HEAD`/`OPTIONS`) the `Origin` header must also pass the same allowlist,
  else `403 Forbidden: cross‑site request blocked`. A **missing `Origin` is
  allowed** (so `curl`, the CLI, and Claude Code hooks keep working); only a
  present‑but‑foreign origin — or the opaque `null` origin (sandboxed iframe) — is
  rejected. This blocks the cross‑site CSRF that could previously create sessions,
  trigger self‑update, or flip `tunnelEnabled`.
- **Raw `text/plain` bodies.** The global `text/plain` content‑type parser no
  longer JSON‑parses bodies — it hands handlers the raw string (`/api/crash-diag`
  self‑parses its beacon payload). This removes the CORS "simple request" CSRF
  vector, where a cross‑site `fetch` with `Content-Type: text/plain` smuggled a
  JSON body into a write route with no preflight — defense‑in‑depth alongside the
  Origin guard.
- **WebSocket upgrades.** The terminal WS upgrade (`src/web/routes/ws-routes.ts`)
  runs the **same** Host + Origin check and closes with code `4003` on failure
  (anti‑CSWSH).

The policy is rebuilt per request from
`buildHostPolicy(bindHost, tunnelManager.getUrl())`, so starting or stopping a
tunnel at runtime updates the allowlist with no restart.

> **Reverse‑proxy operators:** a custom proxy domain (e.g. `codeman.example.com`)
> is **not** in the default allowlist and gets `403 host not allowed`. Add it via
> `CODEMAN_ALLOWED_HOSTS` — comma‑separated, case‑insensitive; an exact hostname
> matches only itself, while a leading‑dot entry (`.corp.internal`) matches the
> bare domain **and** all subdomains. Behaviour is covered by
> `test/network-host-guard.test.ts`.

---

## 4. Recommended remote‑access setups

Ordered most‑to‑least recommended:

### A. Tailscale serve (recommended)

Bind loopback, let Tailscale front it on your tailnet with a real cert:

```bash
codeman web --https            # binds 127.0.0.1:3000
tailscale serve --bg https / http://127.0.0.1:3000
```

Only devices on your tailnet can reach it; Tailscale handles identity. No app
password and no `0.0.0.0` bind required. (This is the maintainer's production
setup.)

### B. Authenticated cloudflared tunnel + password

```bash
export CODEMAN_PASSWORD=<password>
codeman web --https
cloudflared tunnel --url https://localhost:3000
```

Always set `CODEMAN_PASSWORD` here — the tunnel connects over loopback, so the
hook‑event exemption (§3) would otherwise be reachable from the public URL.

### C. Direct LAN bind + password

```bash
export CODEMAN_PASSWORD=<password>
codeman web --https --host 0.0.0.0
```

Exposes the port on all interfaces; the password is the only thing protecting it.

### Avoid

`--host 0.0.0.0` **without** a password. Codeman will start (and warn), but
anyone on the network can control your Claude sessions. Never re‑expose `0.0.0.0`
without a password.

---

## 5. File‑serving hardening

Three routes serve workspace files; all require a valid `sessionId` and run the
shared path validator `validateSessionFilePath()` (`src/web/route-helpers.ts`):
it `realpath`s the target **before** the boundary check and rejects anything that
escapes the session working directory (`..`, absolute paths, and symlinks that
resolve outside). The realpath‑before‑check ordering closes the validation‑time
TOCTOU window.

| Route | Cap | Notes |
|-------|-----|-------|
| `file-content` | 10 MB | text preview |
| `file-raw` | 50 MB | inline MIME map; **`X-Content-Type-Options: nosniff` on all responses** |
| `POST /api/download` | 50 MB | forced `attachment`; sensitive‑path blocklist |

### SVG / content‑type XSS

A workspace `.svg` served inline as `image/svg+xml` is a stored‑XSS vector (SVG
can carry `<script>`, same‑origin = full session control). `file-raw` therefore
serves `.svg` as `application/octet-stream` + `Content-Disposition: attachment` +
`nosniff`. The control here is the **`octet-stream` + `attachment` + `nosniff`
combination**, which forces a download instead of a render — not the CSP: the
policy's `script-src` allows `'unsafe-inline'` (§9), so a same‑origin HTML
document *would* be able to run inline scripts if the browser ever rendered it.
By the same combination, other text types (`.html`, `.xml`, …) that fall through
to `octet-stream` are downloaded, not executed. Trusted QR/welcome SVGs are
injected from API JSON (`innerHTML`), not via `file-raw`, so they are unaffected.

### Download sensitive‑path blocklist

`/api/download` additionally refuses a blocklist of sensitive paths
(`/etc/shadow`, `~/.ssh/`, `.env`, `*credentials*`, `.aws/credentials`, …). This
is **defense‑in‑depth, not the primary boundary** — the realpath containment is
the control.

### Known limitation — `workingDir` scope

The file‑route boundary is the session's `workingDir`, and `POST /api/sessions`
currently accepts an arbitrary absolute `workingDir` (validated as "exists + is a
directory"). A session created with `workingDir=/` can therefore read files
across the filesystem within that boundary. This is **pre‑existing** across all
file routes and not widened by the recent changes. Recommended follow‑up:
constrain `workingDir` to an allowlist (e.g. under the cases dir / `$HOME`).

---

## 6. tmux launch hardening (COD‑31)

New sessions and respawns launch the tmux server/pane from a stable `/tmp`
(`TMUX_LAUNCH_CWD`) and then `cd` into the real workspace **inside** the pane,
against the live mount table:

```
respawn-pane -k -c /tmp -t <session> bash -c "cd <workingDir> && <cmd>"
```

This avoids a class of failures on FUSE/rclone‑mounted workspaces where a
transient mount blip at launch poisons tmux's long‑lived cwd and crashes
`new-session`. Safety properties:

- **Fail‑safe cwd:** the command is `cd "<dir>" && <cmd>` — if `cd` fails the CLI
  does **not** run in `/tmp`; the pane dies with a visible error instead.
- **No injection:** `workingDir` passes `isValidWorkingDir` (absolute, rejects
  `;&|$\`(){}<>'"` and newlines and `..`) and `isValidPath`, and is double‑quoted
  in the pane command. Paths with spaces work; metacharacters are rejected before
  reaching the shell.
- It does not change which tmux socket is targeted, so instance isolation (§8) is
  preserved.

---

## 7. Supply‑chain & build‑asset hardening (COD‑28)

- **Dependency advisories:** security‑sensitive ranges are bumped to patched
  versions, and `overrides` force patched transitive deps (`picomatch`,
  `basic-ftp`, `fast-uri`, `flatted`). `test/dependency-security.test.ts` asserts
  these stay patched in the lockfile.
- **Lockfile integrity:** `npm run check:lockfile` (CI on every push/PR) fails on
  drift between `package.json` and `package-lock.json`. All lockfile entries
  resolve to `registry.npmjs.org` with `sha512` integrity hashes.
- **Public‑asset checker:** `npm run check:public-assets`
  (`scripts/check-public-assets.mjs`) scans `src/web/public/**` for literal NUL
  bytes and runs `node --check` on every `.js` file (syntax validation), plus a
  Prettier pass on maintained files. It uses `execFileSync` with argv arrays (no
  shell), so filenames/content cannot inject commands; `node --check` only parses,
  never executes. Large hand‑formatted/generated assets (`app.js`, the gesture
  bundle, vendored libs) are `.prettierignore`d for the style pass, but the NUL +
  syntax checks still cover them.

---

## 8. Multi‑instance isolation

The tmux socket (`tmux -L codeman[-<instance>]`) and data dir
(`~/.codeman[-<instance>]`) are **process‑wide and shared by every Codeman on the
machine**, derived from `CODEMAN_INSTANCE` (`src/config/instance.ts`). A second
instance on the **same** socket discovers and attaches PTYs to the first
instance's live sessions. To run instances side by side, give each a distinct
`CODEMAN_INSTANCE` (scopes both dir + socket), or set `CODEMAN_TMUX_SOCKET` +
`CODEMAN_DATA_DIR` individually. `CODEMAN_INSTANCE` defaults to empty = the
production layout (`~/.codeman`, `-L codeman`, port 3000).

---

## 9. Transport security headers

`registerSecurityHeaders` (`src/web/middleware/auth.ts`) applies on every response:

- **`Content-Security-Policy`** — baseline `default-src 'self'`, with these
  deliberate widenings (so the policy is tighter than "self only" but every
  exception is enumerated and same‑origin‑first):
  - `script-src` / `style-src` / `font-src` also allow `https://cdn.jsdelivr.net`
    (CDN fallback for a few libraries). `script-src` and `style-src` additionally
    allow `'unsafe-inline'` — relevant to the SVG/HTML handling in §5, where the
    `octet-stream` + `nosniff` download (not the CSP) is what blocks execution.
    Because `'unsafe-inline'` is still present (removing it needs a nonce
    migration), AI‑derived strings rendered into the subagent/activity panels are
    HTML‑escaped at the injection sites (`escapeHtml` in
    `src/web/public/constants.js`; sinks in `panels-ui.js` / `subagent-windows.js`)
    so a hostile tool name or argument can't execute — defense‑in‑depth from the
    2026‑06‑09 review (H4).
  - `connect-src` allows `wss://api.deepgram.com` (streaming voice input).
  - `img-src` allows `data:` and `blob:` (inline / generated images, QR codes).
  - `frame-ancestors 'self'`.
  - **Gesture opt‑in (`CODEMAN_GESTURE=1`):** `script-src` gains
    `'wasm-unsafe-eval'` and a `worker-src 'self' blob:` directive is added, for
    self‑hosted MediaPipe. Its wasm runtime + model are same‑origin under
    `/gesture/`, so no extra `connect-src` entry is needed. OFF by default, so the
    production CSP is byte‑for‑byte unchanged.
- **`X-Content-Type-Options: nosniff`** — blocks MIME sniffing (pairs with §5).
- **`X-Frame-Options: SAMEORIGIN`** — clickjacking defense (mirrors
  `frame-ancestors 'self'`).
- **`Strict-Transport-Security: max-age=31536000; includeSubDomains`** — only when
  served over HTTPS (`--https`).
- **CORS** — `Access-Control-Allow-Origin` is reflected **only** for origins whose
  hostname is `localhost` / `127.0.0.1` / `::1`; any other origin gets no CORS
  headers. `OPTIONS` preflights are answered `204`.

---

## 10. Quick reference

| Env / flag | Effect |
|------------|--------|
| `CODEMAN_PASSWORD` (+ `CODEMAN_USERNAME`) | Enable HTTP Basic auth |
| `--host` / `CODEMAN_HOST` | Bind host (default `127.0.0.1`) |
| `CODEMAN_ALLOWED_HOSTS` | Extra `Host`/`Origin` allowlist entries for reverse proxies (comma‑separated; exact host, or leading‑dot `.suffix` for subdomains) — see §3 |
| `--allow-unauthenticated-network` / `CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK` | Acknowledge an unauthenticated non‑loopback bind (downgrades the warning) |
| `--https` | Enable TLS (adds HSTS) |
| `CODEMAN_INSTANCE` | Scope tmux socket + data dir for isolation |
| `CODEMAN_GESTURE=1` | Make the gesture overlay available (widens CSP) |

**Audit log:** session lifecycle and server start are recorded in
`~/.codeman/session-lifecycle.jsonl`.

### Key source files

| Concern | File |
|---------|------|
| Bind‑host classification, env‑flag parsing, Host/Origin allowlist (`buildHostPolicy` / `isAllowedRequestHost` / `isAllowedRequestOrigin`) | `src/web/network-auth-policy.ts` |
| Start‑and‑warn policy | `src/web/server.ts` (`WebServer.start()`) |
| Auth pipeline, rate limiting, security headers, CORS, Host/Origin guard (`registerHostGuard`) | `src/web/middleware/auth.ts` |
| File‑path containment (realpath‑before‑check) | `src/web/route-helpers.ts` (`validateSessionFilePath`) |
| File routes, caps, SVG handling, download blocklist | `src/web/routes/file-routes.ts` |
| Instance/socket/data‑dir scoping | `src/config/instance.ts` |

---

> **Maintenance note:** the behaviours above were verified against the source on
> 2026‑06‑09. When you change auth, the bind policy, CSP/headers, or the file
> routes, update this document in the same change — several sections quote exact
> values (caps, CSP directives, TTLs) that drift silently otherwise.
