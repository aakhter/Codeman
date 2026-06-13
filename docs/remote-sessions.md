# Remote Sessions (SSH)

Codeman can run a session's agent on a **remote host over SSH** instead of the
local machine. The agent (Claude, OpenCode, Codex, Gemini, or a plain shell)
runs inside a `tmux` server **on the remote host**, so it survives the SSH
connection dropping; Codeman attaches to it the same way it attaches to a local
managed session.

This document covers the data model, the shell-safe SSH command construction
(COD-107), the durable-launch design (COD-104), and the operational caveats.
For the local session/mux machinery this builds on, see the **Mux** and
**Session** entries in `CLAUDE.md` → Architecture.

## Why it exists

A developer box (`AA-DESKTOP`) often needs to drive an agent on another machine —
a NAS, a build server, a host reachable only through a jump box or a
cloudflared SOCKS5 proxy. Rather than wrap `ssh` by hand per host, Codeman
stores reusable **remote hosts** + **remote cases** and reproduces the exact
connection the operator already uses (`ssh-aa-desktop`-style configs:
custom port, identity file, `-J` jump host, `-o ProxyCommand`).

## Data model

Types live in `src/types/session.ts`; persistence in `src/remote-hosts.ts`.

| Type | Role |
|------|------|
| `RemoteSshOptions` | The **HOW-to-reach** fields, shared by host + session: `identityFile`, `socksProxy` (`host:port`), `jumpHost` (`[user@]host[:port]`), `extraSshOptions` (`KEY=VALUE[]`). Every field optional — all-absent reproduces port-22, default-identity, directly-SSH-able behavior. |
| `RemoteHost` (extends `RemoteSshOptions`) | A saved host: `id`, `label`, `host`, `username`, `port?`, `commands?` (per-mode launch command override). |
| `RemoteCase` | A working directory on a host: `name`, `type: 'remote'`, `hostId`, `remotePath`. |
| `SessionRemote` (extends `RemoteSshOptions`) | The resolved bundle stamped onto a live session: host coordinates + `remotePath` + `commands`. Built by `toSessionRemote(host, case)`, which copies the advanced SSH options through so the launch connects exactly as configured. |
| `RemoteCommandMode` | `Extract<SessionMode, 'shell' \| 'claude' \| 'opencode' \| 'codex' \| 'gemini'>` — the modes that can run remotely. |

Persistence is two flat JSON arrays in the instance data dir:

- `~/.codeman/remote-hosts.json` — `readRemoteHosts()` / `writeRemoteHosts()`
- `~/.codeman/remote-cases.json` — `readRemoteCases()` / `writeRemoteCases()`

(Paths via `remoteHostsPath()` / `remoteCasesPath()`; both honor `CODEMAN_INSTANCE`
because the config dir is the instance data dir.)

On the live `Session`, the remote rides as `_remote?: SessionRemote`. When
attaching, `resolveMuxAttachCwd()` forces the cwd to `/tmp` for remote sessions —
the local working directory is meaningless on the remote box.

## SSH command construction (COD-107 — the injection surface)

**All** SSH command lines flow through one function so user-controlled fields are
escaped once and the launch + prereq probe can never drift apart:

```ts
// src/remote-hosts.ts
buildSshConnectionArgs(remote: RemoteSshOptions & Pick<RemoteHost, 'port'>): string[]
```

It returns the **ordered leading tokens** of an ssh command line (no `-t`, no
target, no remote command):

```
ssh -o BatchMode=yes
    [-p <port>]
    [-i <abs-identity>]            # ~ / $HOME expanded, then shellescaped
    [-J <jumpHost>]                # shellescaped, single token
    [-o ProxyCommand=nc -X 5 -x <socks> %h %p]   # ONE shellescaped -o token
    [-o <KEY=VALUE>] …             # each extra option, shellescaped
```

Rules that keep this safe — **do not bypass them by hand-building an ssh line elsewhere:**

- **Every** user-controlled value (`-i`, `-J`, `-o`, ProxyCommand) is POSIX
  single-quote `shellescape`d (`'…'` with embedded `'\''`). The helper mirrors
  the one in `tmux-manager.ts`.
- **`~`/`$HOME` in `identityFile` is expanded at build time** (`expandIdentityPath`),
  *before* escaping — ssh does not expand `~` inside `-i`, and the escaped value
  never reaches a shell that would.
- **The ProxyCommand is one shellescaped `-o KEY=VALUE` token**, so its spaces and
  the `%h`/`%p` placeholders reach ssh as a single argument. `%h %p` survive
  verbatim — **ssh** expands them to the real host/port, not the shell.
- **Empty options ⇒ `['ssh', '-o BatchMode=yes']`** (+ `-p` only when set) —
  byte-identical to the historical behavior.

Token construction is unit-tested independently of any live connection (see
`test/` for `buildSshConnectionArgs` / `buildRemoteTmuxCheckCommand` cases).

## Durable launch (COD-104)

`buildRemoteLaunchCommand({ mode, remote, sessionId })` in `tmux-manager.ts`
builds the command that launches (or **reattaches** to) the remote session:

```
ssh -o BatchMode=yes -t <connection-args> user@host \
  'tmux -L codeman new-session -A -s codeman-<id> -c <remotePath> "cd <remotePath> && exec <cli>" \; \
     set -g status off \; set -g mouse off \; set -sg escape-time 0 \; set -g prefix C-q'
```

Key points:

- **`new-session -A -s codeman-<id>`** = attach-if-exists-else-create, so a
  reconnect (same deterministic `remoteTmuxSessionName(sessionId)`) lands back in
  the **same** remote session rather than spawning a duplicate. This is what makes
  the remote agent survive an SSH drop.
- **`-L codeman`** = canonical remote socket (the remote's own tmux server, not
  the local one).
- **`exec <cli>`** replaces the pane shell with the agent, so the pane PID *is*
  the agent. The per-mode command comes from `remote.commands?.[mode]` or
  `defaultRemoteCommandForMode(mode)` (`exec claude` / `exec opencode` /
  `exec codex` / `exec gemini` / `exec bash -l`).
- The **whole tmux invocation is a single shell-quoted ssh argument**, and the
  pane command is independently quoted, so a `remotePath` with spaces is safe.
- Connection options come from the **same `buildSshConnectionArgs(remote)`** as
  the prereq probe; `-t` is inserted right after `ssh -o BatchMode=yes`,
  preserving historical token order.

### tmux prerequisite probe

Because durable remote sessions require tmux on the remote host,
`checkRemoteTmuxAvailable(host)` runs `command -v tmux` over SSH **before**
creating a remote case/session and returns a structured, never-throwing result:

- empty stdout / non-zero exit → *"remote host `<host>` needs tmux installed for
  durable remote sessions"*
- stderr present → *"could not verify tmux on remote host `<host>`: `<stderr>`"*
  (a real connection failure, surfaced to the operator)
- success → `{ ok: true, tmuxPath }`

It connects with the **identical** options as the launch
(`buildRemoteTmuxCheckCommand` reuses `buildSshConnectionArgs` and inserts
`-o ConnectTimeout=10`), so a proxied/custom-port/identity host that the launch
can reach also passes the probe (and vice-versa).

**Test-mode short-circuit:** under `VITEST` the probe returns
`{ ok: true, tmuxPath: '(test-mode)' }` without opening a socket — mirroring
`TmuxManager`'s no-op-shell-under-VITEST (`IS_TEST_MODE`). Without it, remote-case
create-path tests would hit a real ~10s ssh timeout. Only the live probe is
skipped; command construction is still asserted by unit tests.

## API

Routes are registered in `src/web/routes/case-routes.ts`:

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/remote-hosts` | List saved hosts |
| `POST` | `/api/remote-hosts` | Create a host |
| `PUT` | `/api/remote-hosts/:id` | Update a host |
| `DELETE` | `/api/remote-hosts/:id` | Delete a host |
| `POST` | `/api/cases/remote-link` | Link a case to a remote host (creates the `RemoteCase`) |

Frontend touchpoints: the remote-host management UI is in `session-ui.js` /
`panels-ui.js`; a remote session is created by picking a remote host/case in the
session-create flow.

## Security notes

- **`identityFile` is a path only — never key bytes.** Codeman stores the path and
  passes it to `ssh -i`; the key never enters Codeman's state or the wire.
- The injection surface is the SSH option fields. The single-source
  `buildSshConnectionArgs` + `shellescape` discipline (COD-107) is the control —
  audit any new code path that constructs an ssh command to route through it
  rather than concatenating options inline.
- `BatchMode=yes` means **no interactive password/passphrase prompts** — remote
  hosts must be reachable with key-based or agent auth (or an unencrypted key the
  agent has loaded). A host needing a passphrase will fail the probe with an ssh
  diagnostic rather than hang.

## Related

- `CLAUDE.md` → Architecture → **Remote** row, and the **Remote sessions (SSH)**
  Key Pattern.
- `docs/security-architecture.md` — overall network/auth model.
- COD-104 (tmux prereq + durable launch), COD-107 (shell-safe connection args).
