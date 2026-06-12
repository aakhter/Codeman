# COD-24 Remote Host Cases Design

## Goal

Allow Codeman users to define SSH remote hosts and link existing remote directories as cases/environments. Sessions for those cases should run on the remote host while preserving Codeman's current local tmux, replay, scrollback, tab, and cleanup behavior.

## Scope

First version is metadata-only for remote cases:

- Codeman stores remote host definitions.
- Codeman stores remote case links to existing remote paths.
- Codeman validates SSH connectivity and remote path existence.
- Codeman launches shell and agent sessions by running SSH inside the existing local tmux pane.
- Deleting a remote case removes Codeman metadata only.

First version does not:

- Create remote directories.
- Seed `CLAUDE.md`, `.claude/settings.local.json`, hooks, or other files on the remote host.
- Delete remote directories.
- Browse or edit remote files through local filesystem routes.
- Manage remote tmux sessions.

## Remote Host Model

A remote host is a configured SSH target:

```ts
type RemoteHost = {
  id: string;
  label: string;
  host: string;
  username: string;
  port?: number;
  commands?: Partial<Record<'shell' | 'codex' | 'claude' | 'opencode' | 'gemini', string>>;
};
```

The host config must not store private keys, passwords, or tokens. The assumption is that key-based SSH is already configured outside Codeman and this command works non-interactively:

```bash
ssh -o BatchMode=yes user@host 'pwd'
```

`commands` lets a host override how a mode starts. Defaults are:

- `shell`: `exec bash -l`
- `codex`: `exec codex`
- `claude`: `exec claude`
- `opencode`: `exec opencode`
- `gemini`: `exec gemini`

Example override:

```json
{
  "id": "gpu-box",
  "label": "GPU Box",
  "host": "10.0.0.42",
  "username": "ubuntu",
  "commands": {
    "codex": "exec codx personal"
  }
}
```

This allows hosts where `codx personal` selects a different Codex auth profile. Command values are remote shell snippets owned by the user. Codeman must not interpolate untrusted session input into them.

## Remote Case Model

Remote cases are linked cases with remote metadata:

```ts
type RemoteCase = {
  name: string;
  type: 'remote';
  hostId: string;
  remotePath: string;
};
```

The existing local case list becomes a mixed list:

```ts
type CaseInfo = {
  name: string;
  path: string;
  hasClaudeMd: boolean;
  linked?: boolean;
  location?: 'local' | 'linked-local' | 'remote';
  remote?: {
    hostId: string;
    hostLabel: string;
    host: string;
    username: string;
    path: string;
  };
};
```

For remote cases, `path` is display-oriented and should be formatted as `ssh://user@host/remote/path` or a similarly clear remote label. It must not be treated as a local filesystem path.

## Persistence

Use separate config files under `~/.codeman/`:

- `remote-hosts.json`: remote host definitions.
- `remote-cases.json`: remote case links.

Keeping remote hosts and cases separate from `linked-cases.json` avoids changing the meaning of linked local folder records and makes delete semantics explicit.

## API Design

Add remote host routes:

- `GET /api/remote-hosts`
- `POST /api/remote-hosts`
- `PUT /api/remote-hosts/:id`
- `DELETE /api/remote-hosts/:id`
- `POST /api/remote-hosts/:id/test`

Add remote case route:

- `POST /api/cases/remote-link`

`POST /api/cases/remote-link` accepts:

```json
{
  "name": "gpu-work",
  "hostId": "gpu-box",
  "remotePath": "/home/ubuntu/projects/work"
}
```

It validates:

- case name is safe and not already used by local, linked-local, or remote cases.
- host exists.
- SSH connectivity works with `BatchMode=yes`.
- remote path exists and is a directory via `test -d`.

Existing `GET /api/cases` includes remote cases. Existing `DELETE /api/cases/:name` removes remote metadata when `name` is a remote case.

## Session Launch Design

Local tmux remains the only tmux backend for this first version. For remote cases, Codeman creates the local tmux session exactly as it does today, but the pane command is SSH:

```bash
ssh -o BatchMode=yes -t -p <port> <username>@<host> 'cd <remotePath> && <modeCommand>'
```

Examples:

```bash
ssh -o BatchMode=yes -t ubuntu@10.0.0.42 'cd /home/ubuntu/projects/work && exec bash -l'
ssh -o BatchMode=yes -t ubuntu@10.0.0.42 'cd /home/ubuntu/projects/work && exec codx personal'
```

The remote path and remote command must be shell-escaped for the remote shell. The SSH target and port must be validated and passed as argument-safe values.

Session creation must not run local `statSync()` on a remote path. Instead, when a case selection resolves to a remote case, the session stores remote metadata:

```ts
type SessionRemote = {
  hostId: string;
  username: string;
  host: string;
  port?: number;
  remotePath: string;
  commands?: RemoteHost['commands'];
};
```

The persisted session state must include this metadata so browser reload and server restart can restore the same local tmux-backed session identity.

## UI Design

Keep the first UI small:

- Add remote host management in settings or the case management modal.
- Add a remote-link action in case management.
- Show remote cases distinctly in case selectors, for example `gpu-work @ GPU Box`.
- For remote cases, show the path as `ubuntu@10.0.0.42:/home/ubuntu/projects/work`.

The case selector must continue to work on mobile and desktop. It should not assume every case has a local path.

## Error Handling

SSH and remote path validation should return clear errors:

- host not found
- SSH authentication failed or requires interaction
- remote path does not exist
- remote path is not a directory
- configured command missing for selected mode
- SSH session exited immediately

Codeman should surface these errors in the same places current session startup errors appear.

## Testing

Unit and route tests should cover:

- remote host CRUD validation.
- remote case linking and duplicate-name rejection.
- remote cases included by `GET /api/cases`.
- deleting a remote case removes metadata only.
- session creation skips local filesystem validation for remote cases.
- tmux launch command wraps the selected remote command in SSH.
- command override selection, including `codex: "exec codx personal"`.
- remote paths and SSH arguments are escaped safely.

Smoke coverage should be optional because it requires a configured SSH host. Add an environment-gated smoke path such as:

```bash
CODEMAN_REMOTE_SMOKE_HOST=...
CODEMAN_REMOTE_SMOKE_USER=...
CODEMAN_REMOTE_SMOKE_PATH=...
```

When unset, the smoke should skip remote-host coverage.

## Risks

The main risk is conflating remote paths with local paths. The implementation should keep remote case metadata explicit and avoid passing remote display paths into local file routes.

Another risk is command escaping. The implementation should build SSH argv safely and shell-escape only the remote `cd` and command composition.

Remote tmux persistence is intentionally deferred. If SSH disconnect behavior becomes a problem, remote tmux can be added as a second-stage mode without changing the metadata shape.
