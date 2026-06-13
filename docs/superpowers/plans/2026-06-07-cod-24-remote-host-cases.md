# COD-24 Remote Host Cases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add metadata-only remote host cases that launch shell/Codex/agent sessions over SSH inside Codeman's existing local tmux backend.

**Architecture:** Remote hosts and remote cases are persisted as explicit metadata under `~/.codeman/`. Case APIs return a mixed local/linked/remote case list, session creation resolves remote cases into `SessionRemote` metadata, and `TmuxManager` wraps the normal mode command with `ssh ... 'cd <remotePath> && <command>'` when remote metadata is present. Local tmux remains the owner for scrollback, replay, tab switching, resize, cleanup, and persisted session identity.

**Tech Stack:** TypeScript ESM, Fastify routes, Zod schemas, Vitest route/unit tests, existing `TmuxManager`, existing browser JS/CSS case UI.

---

## File Structure

- Create `src/remote-hosts.ts`: shared remote host/case types, JSON persistence, validation helpers, SSH probe helper, and command-default helpers.
- Modify `src/types/session.ts`: add `RemoteHost`, `RemoteCase`, `SessionRemote`, and extend `CaseInfo`/`SessionState`.
- Modify `src/types/index.ts`: export any new type module only if `src/remote-hosts.ts` needs a separate type export path; otherwise keep types in `session.ts`.
- Modify `src/web/schemas.ts`: add Zod schemas for remote host CRUD and remote case linking, and allow `caseName` on `CreateSessionSchema`.
- Modify `src/web/routes/case-routes.ts`: include remote cases in `GET /api/cases`, add remote host routes, add `POST /api/cases/remote-link`, and make `DELETE /api/cases/:name` delete remote metadata first.
- Modify `src/web/routes/session-routes.ts`: resolve `caseName` to local or remote case, skip local `statSync` for remote cases, pass `remote` into `Session`.
- Modify `src/session.ts`: store optional `remote`, persist it in session state, and pass it to mux create/respawn options.
- Modify `src/mux-interface.ts`: add `remote?: SessionRemote` to `MuxSession`, `CreateSessionOptions`, and `RespawnPaneOptions`.
- Modify `src/tmux-manager.ts`: build local launch commands through a helper that wraps mode commands in SSH for remote sessions and persists remote metadata in mux session records.
- Modify `src/web/public/session-ui.js`: add remote host/case management calls and make case selection use `caseName` instead of remote display path for session creation.
- Modify `src/web/public/index.html`: add compact controls/modal fields for remote host and remote case creation in case management/settings.
- Modify `src/web/public/styles.css` and `src/web/public/mobile.css`: style remote badges and keep mobile case controls usable.
- Modify `/home/ubuntu/.codex/skills/codeman-prod-realistic-smoke/scripts/run-codeman-prod-smoke.mjs`: add optional env-gated remote smoke coverage.
- Test `test/remote-hosts.test.ts`: pure unit tests for persistence, validation, and SSH command construction.
- Test `test/routes/case-routes.test.ts`: route coverage for remote host and remote case APIs.
- Test `test/routes/session-routes.test.ts`: session creation coverage for `caseName` remote resolution and local validation skip.
- Test `test/tmux-manager.test.ts`: tmux launch command coverage for remote wrapping and command overrides.
- Test `test/run-mode-ui.test.ts`: browser UI unit coverage for remote case display and selected case session payload.

---

### Task 1: Remote Host And Case Domain Module

**Files:**
- Create: `src/remote-hosts.ts`
- Modify: `src/types/session.ts`
- Test: `test/remote-hosts.test.ts`

- [ ] **Step 1: Write failing tests for remote host persistence and command defaults**

Create `test/remote-hosts.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultRemoteCommandForMode,
  readRemoteCases,
  readRemoteHosts,
  remoteDisplayPath,
  remoteSshTarget,
  writeRemoteCases,
  writeRemoteHosts,
} from '../src/remote-hosts.js';

describe('remote-hosts domain', () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function configDir(): string {
    dir = mkdtempSync(join(tmpdir(), 'codeman-remote-hosts-'));
    return dir;
  }

  it('round-trips remote hosts and remote cases from a config directory', async () => {
    const root = configDir();
    await writeRemoteHosts(root, [
      {
        id: 'gpu-box',
        label: 'GPU Box',
        host: '10.0.0.42',
        username: 'ubuntu',
        commands: { codex: 'exec codx personal' },
      },
    ]);
    await writeRemoteCases(root, [{ name: 'gpu-work', type: 'remote', hostId: 'gpu-box', remotePath: '/home/ubuntu/work' }]);

    await expect(readRemoteHosts(root)).resolves.toEqual([
      {
        id: 'gpu-box',
        label: 'GPU Box',
        host: '10.0.0.42',
        username: 'ubuntu',
        commands: { codex: 'exec codx personal' },
      },
    ]);
    await expect(readRemoteCases(root)).resolves.toEqual([
      { name: 'gpu-work', type: 'remote', hostId: 'gpu-box', remotePath: '/home/ubuntu/work' },
    ]);
  });

  it('returns safe mode defaults and remote display values', () => {
    expect(defaultRemoteCommandForMode('shell')).toBe('exec bash -l');
    expect(defaultRemoteCommandForMode('codex')).toBe('exec codex');
    expect(defaultRemoteCommandForMode('claude')).toBe('exec claude');
    expect(remoteSshTarget({ id: 'h1', label: 'H1', host: 'box.local', username: 'aamer' })).toBe('aamer@box.local');
    expect(remoteDisplayPath({ username: 'aamer', host: 'box.local', path: '/opt/work' })).toBe('aamer@box.local:/opt/work');
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
npm test -- test/remote-hosts.test.ts
```

Expected: fail with `Cannot find module '../src/remote-hosts.js'`.

- [ ] **Step 3: Add remote types**

Modify `src/types/session.ts` near `SessionMode`:

```ts
export type RemoteCommandMode = Extract<SessionMode, 'shell' | 'claude' | 'opencode' | 'codex' | 'gemini'>;

export interface RemoteHost {
  id: string;
  label: string;
  host: string;
  username: string;
  port?: number;
  commands?: Partial<Record<RemoteCommandMode, string>>;
}

export interface RemoteCase {
  name: string;
  type: 'remote';
  hostId: string;
  remotePath: string;
}

export interface SessionRemote {
  hostId: string;
  label: string;
  host: string;
  username: string;
  port?: number;
  remotePath: string;
  commands?: Partial<Record<RemoteCommandMode, string>>;
}
```

Extend `SessionState` after `workingDir`:

```ts
  /** Remote execution metadata, present when this session runs over SSH through local tmux */
  remote?: SessionRemote;
```

- [ ] **Step 4: Implement the domain module**

Create `src/remote-hosts.ts`:

```ts
import { existsSync, mkdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import type { RemoteCase, RemoteCommandMode, RemoteHost, SessionMode, SessionRemote } from './types.js';

const REMOTE_HOSTS_FILE = 'remote-hosts.json';
const REMOTE_CASES_FILE = 'remote-cases.json';

export function remoteHostsPath(configDir: string): string {
  return join(configDir, REMOTE_HOSTS_FILE);
}

export function remoteCasesPath(configDir: string): string {
  return join(configDir, REMOTE_CASES_FILE);
}

async function readJsonArray<T>(path: string): Promise<T[]> {
  try {
    const raw = await fs.readFile(path, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

async function writeJsonArray<T>(configDir: string, path: string, value: T[]): Promise<void> {
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
  await fs.writeFile(path, JSON.stringify(value, null, 2));
}

export async function readRemoteHosts(configDir: string): Promise<RemoteHost[]> {
  return readJsonArray<RemoteHost>(remoteHostsPath(configDir));
}

export async function writeRemoteHosts(configDir: string, hosts: RemoteHost[]): Promise<void> {
  await writeJsonArray(configDir, remoteHostsPath(configDir), hosts);
}

export async function readRemoteCases(configDir: string): Promise<RemoteCase[]> {
  return readJsonArray<RemoteCase>(remoteCasesPath(configDir));
}

export async function writeRemoteCases(configDir: string, cases: RemoteCase[]): Promise<void> {
  await writeJsonArray(configDir, remoteCasesPath(configDir), cases);
}

export function defaultRemoteCommandForMode(mode: SessionMode): string {
  const commands: Record<RemoteCommandMode, string> = {
    shell: 'exec bash -l',
    claude: 'exec claude',
    opencode: 'exec opencode',
    codex: 'exec codex',
    gemini: 'exec gemini',
  };
  return commands[mode as RemoteCommandMode] || commands.shell;
}

export function remoteSshTarget(host: Pick<RemoteHost, 'username' | 'host'>): string {
  return `${host.username}@${host.host}`;
}

export function remoteDisplayPath(remote: Pick<SessionRemote, 'username' | 'host' | 'remotePath'> | { username: string; host: string; path: string }): string {
  const path = 'remotePath' in remote ? remote.remotePath : remote.path;
  return `${remote.username}@${remote.host}:${path}`;
}

export function toSessionRemote(host: RemoteHost, remoteCase: RemoteCase): SessionRemote {
  return {
    hostId: host.id,
    label: host.label,
    host: host.host,
    username: host.username,
    port: host.port,
    remotePath: remoteCase.remotePath,
    commands: host.commands,
  };
}
```

- [ ] **Step 5: Run test and commit**

Run:

```bash
npm test -- test/remote-hosts.test.ts
npm run typecheck
```

Expected: both pass.

Commit:

```bash
git add src/types/session.ts src/remote-hosts.ts test/remote-hosts.test.ts
git commit -m "feat: add remote host case domain"
```

---

### Task 2: Remote Host And Remote Case Routes

**Files:**
- Modify: `src/web/schemas.ts`
- Modify: `src/web/routes/case-routes.ts`
- Test: `test/routes/case-routes.test.ts`

- [ ] **Step 1: Add failing route tests**

Append to `test/routes/case-routes.test.ts`:

```ts
describe('remote host and remote case routes', () => {
  it('creates a remote host and lists it', async () => {
    const create = await harness.app.inject({
      method: 'POST',
      url: '/api/remote-hosts',
      payload: {
        id: 'gpu-box',
        label: 'GPU Box',
        host: '10.0.0.42',
        username: 'ubuntu',
        commands: { codex: 'exec codx personal' },
      },
    });
    expect(create.statusCode).toBe(200);
    expect(JSON.parse(create.body)).toMatchObject({ success: true });

    const list = await harness.app.inject({ method: 'GET', url: '/api/remote-hosts' });
    expect(list.statusCode).toBe(200);
    expect(JSON.parse(list.body)).toEqual([
      expect.objectContaining({ id: 'gpu-box', label: 'GPU Box', commands: { codex: 'exec codx personal' } }),
    ]);
  });

  it('links a remote case and includes it in GET /api/cases', async () => {
    await harness.app.inject({
      method: 'POST',
      url: '/api/remote-hosts',
      payload: { id: 'gpu-box', label: 'GPU Box', host: '10.0.0.42', username: 'ubuntu' },
    });

    const link = await harness.app.inject({
      method: 'POST',
      url: '/api/cases/remote-link',
      payload: { name: 'gpu-work', hostId: 'gpu-box', remotePath: '/home/ubuntu/work' },
    });
    expect(link.statusCode).toBe(200);

    const cases = await harness.app.inject({ method: 'GET', url: '/api/cases' });
    expect(JSON.parse(cases.body)).toContainEqual(
      expect.objectContaining({
        name: 'gpu-work',
        location: 'remote',
        path: 'ubuntu@10.0.0.42:/home/ubuntu/work',
        remote: expect.objectContaining({ hostId: 'gpu-box', hostLabel: 'GPU Box', path: '/home/ubuntu/work' }),
      })
    );
  });

  it('deletes remote case metadata only', async () => {
    await harness.app.inject({
      method: 'POST',
      url: '/api/remote-hosts',
      payload: { id: 'gpu-box', label: 'GPU Box', host: '10.0.0.42', username: 'ubuntu' },
    });
    await harness.app.inject({
      method: 'POST',
      url: '/api/cases/remote-link',
      payload: { name: 'gpu-work', hostId: 'gpu-box', remotePath: '/home/ubuntu/work' },
    });

    const deleted = await harness.app.inject({ method: 'DELETE', url: '/api/cases/gpu-work' });
    expect(deleted.statusCode).toBe(200);
    expect(JSON.parse(deleted.body)).toEqual({ success: true, data: { name: 'gpu-work' } });
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npm test -- test/routes/case-routes.test.ts
```

Expected: fail because `/api/remote-hosts` and `/api/cases/remote-link` are not registered.

- [ ] **Step 3: Add Zod schemas**

Modify `src/web/schemas.ts` near case schemas:

```ts
const RemoteCommandOverridesSchema = z
  .object({
    shell: z.string().min(1).max(300).optional(),
    claude: z.string().min(1).max(300).optional(),
    opencode: z.string().min(1).max(300).optional(),
    codex: z.string().min(1).max(300).optional(),
    gemini: z.string().min(1).max(300).optional(),
  })
  .strict()
  .optional();

export const RemoteHostSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Invalid remote host id'),
  label: z.string().min(1).max(100),
  host: z.string().min(1).max(255).regex(/^[a-zA-Z0-9._:-]+$/, 'Invalid SSH host'),
  username: z.string().min(1).max(100).regex(/^[a-zA-Z0-9._-]+$/, 'Invalid SSH username'),
  port: z.number().int().min(1).max(65535).optional(),
  commands: RemoteCommandOverridesSchema,
});

export const RemoteCaseLinkSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Invalid case name format'),
  hostId: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Invalid remote host id'),
  remotePath: z.string().min(1).max(2000).regex(/^\//, 'Remote path must be absolute'),
});
```

- [ ] **Step 4: Implement route behavior**

In `src/web/routes/case-routes.ts`:

```ts
import { dirname } from 'node:path';
import {
  readRemoteCases,
  readRemoteHosts,
  remoteDisplayPath,
  toSessionRemote,
  writeRemoteCases,
  writeRemoteHosts,
} from '../../remote-hosts.js';
import { RemoteCaseLinkSchema, RemoteHostSchema } from '../schemas.js';
```

Add:

```ts
const CODEMAN_CONFIG_DIR = join(homedir(), '.codeman');
```

Add remote cases into `GET /api/cases` after linked-local cases:

```ts
const remoteHosts = await readRemoteHosts(CODEMAN_CONFIG_DIR);
const remoteHostMap = new Map(remoteHosts.map((host) => [host.id, host]));
for (const remoteCase of await readRemoteCases(CODEMAN_CONFIG_DIR)) {
  const host = remoteHostMap.get(remoteCase.hostId);
  if (!host || existingNames.has(remoteCase.name) || !SAFE_CASE_NAME.test(remoteCase.name)) continue;
  existingNames.add(remoteCase.name);
  cases.push({
    name: remoteCase.name,
    path: remoteDisplayPath({ username: host.username, host: host.host, path: remoteCase.remotePath }),
    hasClaudeMd: false,
    location: 'remote',
    remote: {
      hostId: host.id,
      hostLabel: host.label,
      host: host.host,
      username: host.username,
      path: remoteCase.remotePath,
    },
  });
}
```

Add routes:

```ts
app.get('/api/remote-hosts', async () => readRemoteHosts(CODEMAN_CONFIG_DIR));

app.post('/api/remote-hosts', async (req): Promise<ApiResponse<{ host: unknown }>> => {
  const host = parseBody(RemoteHostSchema, req.body);
  const hosts = await readRemoteHosts(CODEMAN_CONFIG_DIR);
  if (hosts.some((item) => item.id === host.id)) {
    return createErrorResponse(ApiErrorCode.ALREADY_EXISTS, 'Remote host already exists');
  }
  await writeRemoteHosts(CODEMAN_CONFIG_DIR, [...hosts, host]);
  return { success: true, data: { host } };
});

app.put('/api/remote-hosts/:id', async (req): Promise<ApiResponse<{ host: unknown }>> => {
  const { id } = req.params as { id: string };
  const host = parseBody(RemoteHostSchema, { ...(req.body as object), id });
  const hosts = await readRemoteHosts(CODEMAN_CONFIG_DIR);
  const index = hosts.findIndex((item) => item.id === id);
  if (index === -1) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Remote host not found');
  const next = [...hosts];
  next[index] = host;
  await writeRemoteHosts(CODEMAN_CONFIG_DIR, next);
  return { success: true, data: { host } };
});

app.delete('/api/remote-hosts/:id', async (req): Promise<ApiResponse<{ id: string }>> => {
  const { id } = req.params as { id: string };
  const cases = await readRemoteCases(CODEMAN_CONFIG_DIR);
  if (cases.some((item) => item.hostId === id)) {
    return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Remote host is still used by remote cases');
  }
  await writeRemoteHosts(CODEMAN_CONFIG_DIR, (await readRemoteHosts(CODEMAN_CONFIG_DIR)).filter((item) => item.id !== id));
  return { success: true, data: { id } };
});

app.post('/api/cases/remote-link', async (req): Promise<ApiResponse<{ case: unknown }>> => {
  const remoteCase = { ...parseBody(RemoteCaseLinkSchema, req.body), type: 'remote' as const };
  const hosts = await readRemoteHosts(CODEMAN_CONFIG_DIR);
  const host = hosts.find((item) => item.id === remoteCase.hostId);
  if (!host) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Remote host not found');
  const remoteCases = await readRemoteCases(CODEMAN_CONFIG_DIR);
  if (remoteCases.some((item) => item.name === remoteCase.name) || existsSync(join(CASES_DIR, remoteCase.name))) {
    return createErrorResponse(ApiErrorCode.ALREADY_EXISTS, 'Case already exists');
  }
  await writeRemoteCases(CODEMAN_CONFIG_DIR, [...remoteCases, remoteCase]);
  ctx.broadcast(SseEvent.CaseLinked, { name: remoteCase.name, path: remoteCase.remotePath, type: 'remote' });
  return { success: true, data: { case: remoteCase } };
});
```

Update `DELETE /api/cases/:name` before linked-local deletion:

```ts
const remoteCases = await readRemoteCases(CODEMAN_CONFIG_DIR);
if (remoteCases.some((item) => item.name === name)) {
  await writeRemoteCases(CODEMAN_CONFIG_DIR, remoteCases.filter((item) => item.name !== name));
  ctx.broadcast(SseEvent.CaseDeleted, { name, type: 'remote-unlinked' });
  return { success: true, data: { name } };
}
```

- [ ] **Step 5: Run tests and commit**

Run:

```bash
npm test -- test/routes/case-routes.test.ts test/remote-hosts.test.ts
npm run typecheck
```

Expected: pass.

Commit:

```bash
git add src/web/schemas.ts src/web/routes/case-routes.ts test/routes/case-routes.test.ts
git commit -m "feat: add remote host case routes"
```

---

### Task 3: Session Creation Resolves Remote Cases

**Files:**
- Modify: `src/web/schemas.ts`
- Modify: `src/web/routes/session-routes.ts`
- Modify: `src/session.ts`
- Test: `test/routes/session-routes.test.ts`

- [ ] **Step 1: Write failing route test**

Add to `test/routes/session-routes.test.ts`:

```ts
it('creates a session from a remote case without local stat validation', async () => {
  await writeRemoteHosts(join(homedir(), '.codeman'), [
    { id: 'gpu-box', label: 'GPU Box', host: '10.0.0.42', username: 'ubuntu', commands: { codex: 'exec codx personal' } },
  ]);
  await writeRemoteCases(join(homedir(), '.codeman'), [
    { name: 'gpu-work', type: 'remote', hostId: 'gpu-box', remotePath: '/home/ubuntu/work' },
  ]);

  const res = await harness.app.inject({
    method: 'POST',
    url: '/api/sessions',
    payload: { caseName: 'gpu-work', mode: 'codex', name: 'Remote Codex' },
  });

  expect(res.statusCode).toBe(200);
  const body = JSON.parse(res.body);
  expect(body.success).toBe(true);
  expect(body.session.workingDir).toBe('/home/ubuntu/work');
  expect(body.session.remote).toMatchObject({
    hostId: 'gpu-box',
    host: '10.0.0.42',
    username: 'ubuntu',
    remotePath: '/home/ubuntu/work',
    commands: { codex: 'exec codx personal' },
  });
});
```

If the existing route harness does not expose a real config dir, mock `readRemoteHosts()` and `readRemoteCases()` from `../../src/remote-hosts.js` instead of writing files.

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
npm test -- test/routes/session-routes.test.ts -t "remote case"
```

Expected: fail because `CreateSessionSchema` does not accept `caseName`.

- [ ] **Step 3: Allow `caseName` in session creation**

Modify `src/web/schemas.ts` in `CreateSessionSchema`:

```ts
  caseName: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/, 'Invalid case name format')
    .optional(),
```

- [ ] **Step 4: Resolve local vs remote case in route**

Modify `src/web/routes/session-routes.ts` imports:

```ts
import { readRemoteCases, readRemoteHosts, toSessionRemote } from '../../remote-hosts.js';
```

Add near `LINKED_CASES_FILE`:

```ts
const CODEMAN_CONFIG_DIR = join(homedir(), '.codeman');
```

Replace:

```ts
const workingDir = body.workingDir || process.cwd();
```

with:

```ts
let workingDir = body.workingDir || process.cwd();
let remote = undefined;

if (body.caseName) {
  const remoteCases = await readRemoteCases(CODEMAN_CONFIG_DIR);
  const remoteCase = remoteCases.find((item) => item.name === body.caseName);
  if (remoteCase) {
    const host = (await readRemoteHosts(CODEMAN_CONFIG_DIR)).find((item) => item.id === remoteCase.hostId);
    if (!host) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Remote host not found');
    workingDir = remoteCase.remotePath;
    remote = toSessionRemote(host, remoteCase);
  } else {
    const linkedCases = await readJsonConfig<Record<string, string>>(LINKED_CASES_FILE, 'linked cases', {});
    workingDir = linkedCases[body.caseName] || validatePathWithinBase(body.caseName, CASES_DIR) || workingDir;
  }
}
```

Change local stat validation:

```ts
if (body.workingDir && !remote) {
```

Pass `remote` to `new Session({ ... })`.

- [ ] **Step 5: Persist remote on Session**

Modify `src/session.ts`:

```ts
import type { SessionRemote } from './types.js';
```

Add private field:

```ts
  private readonly _remote?: SessionRemote;
```

Add constructor config:

```ts
      remote?: SessionRemote;
```

Set it:

```ts
this._remote = config.remote;
```

Where session state is built, include:

```ts
remote: this._remote,
```

Pass `remote: this._remote` in both `createSessionOptions` and `respawnPaneOptions` for `startInteractive()` and `startShell()`.

- [ ] **Step 6: Run tests and commit**

Run:

```bash
npm test -- test/routes/session-routes.test.ts -t "remote case"
npm run typecheck
```

Expected: pass.

Commit:

```bash
git add src/web/schemas.ts src/web/routes/session-routes.ts src/session.ts test/routes/session-routes.test.ts
git commit -m "feat: resolve remote cases for sessions"
```

---

### Task 4: Tmux SSH Launch Wrapping

**Files:**
- Modify: `src/mux-interface.ts`
- Modify: `src/tmux-manager.ts`
- Test: `test/tmux-manager.test.ts`

- [ ] **Step 1: Write failing unit tests for remote command building**

Add exported helper tests in `test/tmux-manager.test.ts`:

```ts
import { buildRemoteLaunchCommand } from '../src/tmux-manager.js';

describe('remote launch command builder', () => {
  it('wraps codex command overrides in ssh with remote cd', () => {
    const command = buildRemoteLaunchCommand({
      mode: 'codex',
      remote: {
        hostId: 'gpu-box',
        label: 'GPU Box',
        host: '10.0.0.42',
        username: 'ubuntu',
        remotePath: '/home/ubuntu/work',
        commands: { codex: 'exec codx personal' },
      },
    });

    expect(command).toContain('ssh');
    expect(command).toContain('BatchMode=yes');
    expect(command).toContain('ubuntu@10.0.0.42');
    expect(command).toContain('cd /home/ubuntu/work');
    expect(command).toContain('exec codx personal');
  });

  it('uses default shell command when no override is configured', () => {
    const command = buildRemoteLaunchCommand({
      mode: 'shell',
      remote: {
        hostId: 'gpu-box',
        label: 'GPU Box',
        host: '10.0.0.42',
        username: 'ubuntu',
        remotePath: '/home/ubuntu/work',
      },
    });

    expect(command).toContain('exec bash -l');
  });
});
```

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
npm test -- test/tmux-manager.test.ts -t "remote launch command builder"
```

Expected: fail because `buildRemoteLaunchCommand` is not exported.

- [ ] **Step 3: Extend mux interfaces**

Modify `src/mux-interface.ts`:

```ts
import type { SessionRemote } from './types.js';
```

Add `remote?: SessionRemote` to `MuxSession`, `CreateSessionOptions`, and `RespawnPaneOptions`.

- [ ] **Step 4: Implement remote launch helper**

Modify `src/tmux-manager.ts` imports:

```ts
import { defaultRemoteCommandForMode, remoteSshTarget } from './remote-hosts.js';
import type { SessionRemote } from './types.js';
```

Add helper near `buildSpawnCommand()`:

```ts
export function buildRemoteLaunchCommand(options: { mode: SessionMode; remote: SessionRemote }): string {
  const { mode, remote } = options;
  const modeCommand = remote.commands?.[mode] || defaultRemoteCommandForMode(mode);
  const target = remoteSshTarget(remote);
  const args = ['ssh', '-o', 'BatchMode=yes', '-t'];
  if (remote.port) args.push('-p', String(remote.port));
  args.push(target, `cd ${shellescape(remote.remotePath)} && ${modeCommand}`);
  return args.map((arg) => shellescape(arg)).join(' ');
}
```

- [ ] **Step 5: Use remote launch in create and respawn**

In `createSession(options)`, destructure `remote`. Change `fullCmd` construction:

```ts
const localFullCmd = `${buildNofileLimitCommand()} && ${pathExport}${envExportsStr} && ${cmd}`;
const fullCmd = remote ? buildRemoteLaunchCommand({ mode, remote }) : localFullCmd;
```

Change `launchCmd`:

```ts
const launchCmd = remote ? fullCmd : `cd ${JSON.stringify(workingDir)} && ${fullCmd}`;
```

Persist `remote` into the `MuxSession`.

Apply the same logic in `respawnPane(options)`.

- [ ] **Step 6: Run tests and commit**

Run:

```bash
npm test -- test/tmux-manager.test.ts -t "remote launch command builder"
npm run typecheck
```

Expected: pass.

Commit:

```bash
git add src/mux-interface.ts src/tmux-manager.ts test/tmux-manager.test.ts
git commit -m "feat: launch remote sessions through ssh"
```

---

### Task 5: UI For Remote Hosts And Remote Cases

**Files:**
- Modify: `src/web/public/session-ui.js`
- Modify: `src/web/public/index.html`
- Modify: `src/web/public/styles.css`
- Modify: `src/web/public/mobile.css`
- Test: `test/run-mode-ui.test.ts`

- [ ] **Step 1: Write failing UI test**

Add to `test/run-mode-ui.test.ts`:

```ts
it('renders remote cases and creates sessions by caseName', async () => {
  const fetchCalls = [];
  global.fetch = vi.fn(async (url, options) => {
    fetchCalls.push({ url: String(url), options });
    if (url === '/api/cases') {
      return {
        ok: true,
        json: async () => [
          {
            name: 'gpu-work',
            path: 'ubuntu@10.0.0.42:/home/ubuntu/work',
            hasClaudeMd: false,
            location: 'remote',
            remote: { hostId: 'gpu-box', hostLabel: 'GPU Box', host: '10.0.0.42', username: 'ubuntu', path: '/home/ubuntu/work' },
          },
        ],
      };
    }
    if (url === '/api/sessions') return { ok: true, json: async () => ({ success: true, session: { id: 's1' } }) };
    return { ok: true, json: async () => ({}) };
  }) as never;

  const app = createAppHarness();
  await app.loadQuickStartCases();
  document.getElementById('caseSelect').value = 'gpu-work';
  await app.createSession('codex');

  const createCall = fetchCalls.find((call) => call.url === '/api/sessions');
  expect(JSON.parse(createCall.options.body)).toMatchObject({ caseName: 'gpu-work', mode: 'codex' });
});
```

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
npm test -- test/run-mode-ui.test.ts -t "remote cases"
```

Expected: fail because session creation still sends only `workingDir` in some paths.

- [ ] **Step 3: Update case display and payload**

In `src/web/public/session-ui.js`, when rendering case options, use:

```js
const label = c.location === 'remote' && c.remote ? `${c.name} @ ${c.remote.hostLabel}` : c.name;
option.textContent = label;
option.dataset.location = c.location || 'local';
option.dataset.path = c.path || '';
```

In session creation payload, when selected case exists in `this.cases`, send:

```js
payload.caseName = selectedCase.name;
```

Only send `workingDir` when no matching case exists and the UI is using a raw directory.

- [ ] **Step 4: Add minimal remote management UI**

In `src/web/public/index.html`, add fields in the case management modal:

```html
<section class="case-manager-section" id="remoteHostSection">
  <h3>Remote Hosts</h3>
  <input id="remoteHostIdInput" placeholder="host id">
  <input id="remoteHostLabelInput" placeholder="label">
  <input id="remoteHostHostInput" placeholder="host or ip">
  <input id="remoteHostUserInput" placeholder="username">
  <input id="remoteHostCodexCommandInput" placeholder="codex command override">
  <button id="addRemoteHostBtn">Add Remote Host</button>
</section>
<section class="case-manager-section" id="remoteCaseSection">
  <h3>Remote Cases</h3>
  <select id="remoteCaseHostSelect"></select>
  <input id="remoteCaseNameInput" placeholder="case name">
  <input id="remoteCasePathInput" placeholder="/remote/path">
  <button id="linkRemoteCaseBtn">Link Remote Case</button>
</section>
```

In `session-ui.js`, bind those buttons to:

```js
fetch('/api/remote-hosts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
fetch('/api/cases/remote-link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
```

After success call `await this.loadQuickStartCases()` and refresh the case management list.

- [ ] **Step 5: Add compact styling**

In `styles.css`, add:

```css
.case-location-badge {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 0 0.4rem;
  font-size: 0.75rem;
  color: var(--text-muted);
}
```

In `mobile.css`, ensure remote fields wrap:

```css
@media (max-width: 1023px) {
  #remoteHostSection,
  #remoteCaseSection {
    display: grid;
    gap: 0.5rem;
  }
}
```

- [ ] **Step 6: Run tests and commit**

Run:

```bash
npm test -- test/run-mode-ui.test.ts
npm run format:check
```

Expected: pass.

Commit:

```bash
git add src/web/public/session-ui.js src/web/public/index.html src/web/public/styles.css src/web/public/mobile.css test/run-mode-ui.test.ts
git commit -m "feat: add remote case UI"
```

---

### Task 6: Optional Remote Smoke Coverage

**Files:**
- Modify: `/home/ubuntu/.codex/skills/codeman-prod-realistic-smoke/scripts/run-codeman-prod-smoke.mjs`
- Modify: `/home/ubuntu/.codex/skills/codeman-prod-realistic-smoke/SKILL.md`

- [ ] **Step 1: Add remote smoke env contract**

In the smoke script, read:

```js
const REMOTE_SMOKE_HOST = process.env.CODEMAN_REMOTE_SMOKE_HOST || '';
const REMOTE_SMOKE_USER = process.env.CODEMAN_REMOTE_SMOKE_USER || '';
const REMOTE_SMOKE_PATH = process.env.CODEMAN_REMOTE_SMOKE_PATH || '';
const REMOTE_SMOKE_CODEX_COMMAND = process.env.CODEMAN_REMOTE_SMOKE_CODEX_COMMAND || '';
const SHOULD_REMOTE_SMOKE = REMOTE_SMOKE_HOST && REMOTE_SMOKE_USER && REMOTE_SMOKE_PATH;
```

- [ ] **Step 2: Add remote host/case creation and cleanup**

After local case snapshot, create a remote host/case only when `SHOULD_REMOTE_SMOKE`:

```js
const remoteHostId = `smoke-remote-${runId.slice(11, 19)}`;
const remoteCaseName = `smoke-remote-case-${runId.slice(11, 19)}`;
await api(page, '/api/remote-hosts', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    id: remoteHostId,
    label: 'Smoke Remote',
    host: REMOTE_SMOKE_HOST,
    username: REMOTE_SMOKE_USER,
    commands: REMOTE_SMOKE_CODEX_COMMAND ? { codex: REMOTE_SMOKE_CODEX_COMMAND } : undefined,
  }),
});
await api(page, '/api/cases/remote-link', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: remoteCaseName, hostId: remoteHostId, remotePath: REMOTE_SMOKE_PATH }),
});
```

In cleanup:

```js
await api(page, `/api/cases/${encodeURIComponent(remoteCaseName)}`, { method: 'DELETE' });
await api(page, `/api/remote-hosts/${encodeURIComponent(remoteHostId)}`, { method: 'DELETE' });
```

- [ ] **Step 3: Add one remote shell marker test**

Create a shell session with:

```js
const remoteShell = await createSession(page, { mode: 'shell', caseName: remoteCaseName, name: `smoke-remote-shell-${runId.slice(11, 19)}` });
await startSession(page, remoteShell, 'shell');
await sendInput(page, remoteShell, 'printf "SMOKE_REMOTE_SHELL_OK:%s\\n" "$PWD"\\r');
const remoteWait = await waitForTerminal(page, remoteShell, 'SMOKE_REMOTE_SHELL_OK', 30000);
mark('remote shell marker visible over ssh', remoteWait.found, remoteWait.found ? 'SMOKE_REMOTE_SHELL_OK found' : remoteWait.last.slice(-250));
```

- [ ] **Step 4: Update skill docs**

Add:

```md
Remote host coverage is skipped unless `CODEMAN_REMOTE_SMOKE_HOST`, `CODEMAN_REMOTE_SMOKE_USER`, and `CODEMAN_REMOTE_SMOKE_PATH` are set. Optional `CODEMAN_REMOTE_SMOKE_CODEX_COMMAND` validates host command overrides.
```

- [ ] **Step 5: Verify**

Run:

```bash
node --check /home/ubuntu/.codex/skills/codeman-prod-realistic-smoke/scripts/run-codeman-prod-smoke.mjs
```

Expected: no output, exit 0.

This skill change is outside the Codeman repo. Do not include it in the repo commit.

---

### Task 7: Full Verification And Jira Update

**Files:**
- No code files unless prior tasks reveal a focused issue.

- [ ] **Step 1: Run targeted and repo verification**

Run:

```bash
npm test -- test/remote-hosts.test.ts test/routes/case-routes.test.ts test/routes/session-routes.test.ts test/tmux-manager.test.ts test/run-mode-ui.test.ts
npm run typecheck
npm run lint
npm run format:check
npm run check:lockfile
npm run build
```

Expected: all exit 0.

- [ ] **Step 2: Run optional local smoke**

Run the realistic smoke without remote env first:

```bash
node /home/ubuntu/.codex/skills/codeman-prod-realistic-smoke/scripts/run-codeman-prod-smoke.mjs --tab-switch-rounds 2
```

Expected: final `SUMMARY` has no failures and remote coverage is skipped.

If a configured SSH target is available, run:

```bash
CODEMAN_REMOTE_SMOKE_HOST=10.0.0.42 \
CODEMAN_REMOTE_SMOKE_USER=ubuntu \
CODEMAN_REMOTE_SMOKE_PATH=/home/ubuntu/projects/work \
CODEMAN_REMOTE_SMOKE_CODEX_COMMAND='exec codx personal' \
node /home/ubuntu/.codex/skills/codeman-prod-realistic-smoke/scripts/run-codeman-prod-smoke.mjs --tab-switch-rounds 2
```

Expected: remote shell marker passes and cleanup deletes the remote smoke case and host metadata.

- [ ] **Step 3: Update Jira `COD-24`**

Add a Jira comment:

```text
Implementation complete on branch feat/COD-24-remote-host-cases.
Includes metadata-only remote host/case links, local tmux SSH launch, per-host command overrides, UI wiring, and optional env-gated remote smoke coverage.
Verification: npm test -- test/remote-hosts.test.ts test/routes/case-routes.test.ts test/routes/session-routes.test.ts test/tmux-manager.test.ts test/run-mode-ui.test.ts; npm run typecheck; npm run lint; npm run format:check; npm run check:lockfile; npm run build.
```

- [ ] **Step 4: Commit any final docs/test updates**

If no files changed after verification, do nothing. If a focused doc/test update was needed:

```bash
git add <files>
git commit -m "docs: update COD-24 verification notes"
```

---

## Self-Review Checklist

- Every design requirement maps to a task:
  - Remote host metadata: Task 1 and Task 2.
  - Remote case metadata-only links: Task 1 and Task 2.
  - Per-host command overrides: Task 1, Task 4, Task 6.
  - Local tmux wrapping SSH: Task 4.
  - Remote session creation without local stat: Task 3.
  - UI distinction for local/remote: Task 5.
  - Optional smoke coverage: Task 6.
- No task requires remote directory creation or remote file seeding.
- Delete semantics are metadata-only for remote cases.
- Remote tmux remains out of scope.
