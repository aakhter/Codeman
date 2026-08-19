# COD-334 Login-Shell Agent CLI Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all six local agent CLIs resolve and launch through the logged-in user's interactive login-shell environment, with actionable missing-executable diagnostics.

**Architecture:** Add one injectable resolver factory that checks the server PATH, known directories, then the same resolved interactive login shell used by tmux panes. Keep each existing agent resolver API as a compatibility wrapper, retain Pi's version validation, route every local agent pane through the login-shell wrapper, and pass bounded diagnostics through status, create, and quick-start errors.

**Tech Stack:** TypeScript ESM/NodeNext, Node `execFileSync`, Fastify, browser JavaScript, Vitest, tmux.

**Spec:** `docs/superpowers/specs/2026-08-19-cod-334-login-shell-cli-resolution-design.md`

---

## File map

- Create `src/utils/cli-executable-resolver.ts`: generic resolver factory, production host adapter, success-only cache, diagnostics formatter.
- Create `test/cli-executable-resolver.test.ts`: pure precedence, shell-only, rejection, caching, and diagnostic tests.
- Modify `src/utils/claude-cli-resolver.ts`: delegate directory lookup to the shared resolver while retaining version/path helpers.
- Modify `src/utils/opencode-cli-resolver.ts`: delegate and export its bounded not-found formatter.
- Modify `src/utils/codex-cli-resolver.ts`: delegate and export its bounded not-found formatter.
- Modify `src/utils/gemini-cli-resolver.ts`: delegate and export its bounded not-found formatter.
- Modify `src/utils/antigravity-cli-resolver.ts`: delegate and export its bounded not-found formatter.
- Modify `src/utils/pi-cli-resolver.ts`: delegate with the existing semantic version validator and preserve version reporting.
- Modify `src/utils/index.ts`: re-export shared diagnostic helpers needed by `TmuxManager`.
- Modify `src/tmux-manager.ts`: apply the login-shell wrapper to Claude and Pi and use resolver-owned errors for all six modes.
- Modify `src/web/routes/system-routes.ts`: add optional `error` to unavailable CLI status responses.
- Modify `src/web/routes/session-routes.ts`: use resolver-owned errors in create and quick-start preflight.
- Modify `src/web/public/session-ui.js`: show server status diagnostics for the five status-probed run modes.
- Modify `test/tmux-manager.test.ts`: cover all six agent modes and detailed errors.
- Modify `test/routes/system-routes.test.ts`: cover optional unavailable diagnostics without changing existing fields.
- Modify `test/run-mode-ui.test.ts`: cover status diagnostic passthrough and install-message fallback.
- Modify `test/antigravity-cli-resolver.test.ts`: adapt the existing resolver tests to the shared factory behavior.
- Modify `docs/architecture-invariants.md`: record the shared local discovery/launch invariant.

---

### Task 1: Build the shared executable resolver with RED-first pure tests

**Files:**
- Create: `src/utils/cli-executable-resolver.ts`
- Create: `test/cli-executable-resolver.test.ts`

- [ ] **Step 1: Write failing tests for precedence, login-shell discovery, validation, and caching**

Create `test/cli-executable-resolver.test.ts` with a fake host and these behaviors:

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  createCliExecutableResolver,
  formatCliNotFoundMessage,
  type CliResolverHost,
} from '../src/utils/cli-executable-resolver.js';

function host(overrides: Partial<CliResolverHost> = {}): CliResolverHost {
  return {
    processPath: '/usr/bin:/bin',
    shellPath: '/bin/bash',
    shellArgs: ['-i', '-l'],
    findOnProcessPath: vi.fn(() => null),
    findInLoginShell: vi.fn(() => null),
    exists: vi.fn(() => false),
    ...overrides,
  };
}

describe('createCliExecutableResolver', () => {
  it('prefers process PATH, then known directories, then the login shell', () => {
    const h = host({
      findOnProcessPath: vi.fn(() => '/process/bin/codex'),
      findInLoginShell: vi.fn(() => '/shell/bin/codex'),
      exists: vi.fn(() => true),
    });
    const resolver = createCliExecutableResolver({ binary: 'codex', searchDirs: ['/known/bin'] }, h);
    expect(resolver.resolve()).toMatchObject({ binaryPath: '/process/bin/codex', source: 'process-path' });
    expect(h.findInLoginShell).not.toHaveBeenCalled();
  });

  it('finds an executable exposed only by the interactive login shell', () => {
    const h = host({
      findInLoginShell: vi.fn(() => '/home/u/.nvm/versions/node/v22/bin/codex'),
      exists: vi.fn((path) => path === '/home/u/.nvm/versions/node/v22/bin/codex'),
    });
    const resolver = createCliExecutableResolver({ binary: 'codex', searchDirs: ['/known/bin'] }, h);
    expect(resolver.resolve()).toMatchObject({
      binaryPath: '/home/u/.nvm/versions/node/v22/bin/codex',
      directory: '/home/u/.nvm/versions/node/v22/bin',
      source: 'login-shell',
    });
  });

  it('continues after a validator rejects an earlier candidate', () => {
    const h = host({
      findOnProcessPath: vi.fn(() => '/usr/bin/pi'),
      findInLoginShell: vi.fn(() => '/home/u/.npm/bin/pi'),
      exists: vi.fn(() => true),
    });
    const resolver = createCliExecutableResolver(
      {
        binary: 'pi',
        searchDirs: [],
        validateCandidate: (path) => (path.includes('.npm') ? { accepted: true, metadata: '0.84.1' } : { accepted: false }),
      },
      h
    );
    expect(resolver.resolve()).toMatchObject({ binaryPath: '/home/u/.npm/bin/pi', metadata: '0.84.1' });
  });

  it('caches success but retries failure', () => {
    const findInLoginShell = vi.fn<() => string | null>().mockReturnValueOnce(null).mockReturnValue('/new/bin/codex');
    const h = host({ findInLoginShell, exists: vi.fn((path) => path === '/new/bin/codex') });
    const resolver = createCliExecutableResolver({ binary: 'codex', searchDirs: [] }, h);
    expect(resolver.resolve()).toBeNull();
    expect(resolver.resolve()?.binaryPath).toBe('/new/bin/codex');
    expect(resolver.resolve()?.binaryPath).toBe('/new/bin/codex');
    expect(findInLoginShell).toHaveBeenCalledTimes(2);
  });

  it('rejects unsafe binary names and relative or nonexistent results', () => {
    const h = host({ findInLoginShell: vi.fn(() => 'relative/codex'), exists: vi.fn(() => false) });
    expect(() => createCliExecutableResolver({ binary: 'codex;id', searchDirs: [] }, h)).toThrow('Unsafe CLI binary name');
    expect(createCliExecutableResolver({ binary: 'codex', searchDirs: [] }, h).resolve()).toBeNull();
  });
});

describe('formatCliNotFoundMessage', () => {
  it('includes only the bounded resolution diagnostics', () => {
    const message = formatCliNotFoundMessage('Codex CLI not found. Install with: npm install -g @openai/codex', {
      binary: 'codex',
      processPath: '/usr/bin:/bin',
      shellPath: '/bin/bash',
      shellArgs: ['-i', '-l'],
      searchDirs: ['/home/u/.local/bin', '/usr/local/bin'],
    });
    expect(message).toContain('Server PATH: /usr/bin:/bin');
    expect(message).toContain('Login shell: /bin/bash -i -l');
    expect(message).toContain('Checked directories: /home/u/.local/bin, /usr/local/bin');
    expect(message).not.toContain('API_KEY');
  });
});
```

- [ ] **Step 2: Run the test and verify the RED is the missing module**

Run: `npm test -- test/cli-executable-resolver.test.ts`

Expected: FAIL because `src/utils/cli-executable-resolver.ts` does not exist.

- [ ] **Step 3: Implement the injectable factory and production adapter**

Create `src/utils/cli-executable-resolver.ts` with these exported contracts and behavior:

```ts
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { EXEC_TIMEOUT_MS } from '../config/exec-timeout.js';
import { loginShellArgs, resolveLocalShell } from './shell-resolver.js';

export type CliResolutionSource = 'process-path' | 'common-directory' | 'login-shell';

export interface CliResolutionDiagnostics {
  binary: string;
  processPath: string;
  shellPath: string;
  shellArgs: string[];
  searchDirs: string[];
}

export interface CliResolverHost {
  processPath: string;
  shellPath: string;
  shellArgs: string[];
  findOnProcessPath(binary: string): string | null;
  findInLoginShell(binary: string): string | null;
  exists(path: string): boolean;
}

export interface CandidateValidation<T> {
  accepted: boolean;
  metadata?: T;
}

export interface CliResolution<T = undefined> {
  binaryPath: string;
  directory: string;
  source: CliResolutionSource;
  metadata?: T;
}

export interface CliExecutableResolver<T = undefined> {
  resolve(): CliResolution<T> | null;
  diagnostics(): CliResolutionDiagnostics;
}

function lastAbsoluteLine(output: string): string | null {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (isAbsolute(lines[index])) return lines[index];
  }
  return null;
}

export function createProductionCliResolverHost(): CliResolverHost {
  const shellPath = resolveLocalShell();
  const shellArgs = loginShellArgs(shellPath).trim().split(/\s+/).filter(Boolean);
  const run = (file: string, args: string[]) => {
    try {
      return execFileSync(file, args, {
        encoding: 'utf8',
        timeout: EXEC_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return '';
    }
  };
  return {
    processPath: process.env.PATH ?? '',
    shellPath,
    shellArgs,
    findOnProcessPath: (binary) => lastAbsoluteLine(run('which', [binary])),
    findInLoginShell: (binary) => {
      if (process.env.VITEST) return null;
      return lastAbsoluteLine(run(shellPath, [...shellArgs, '-c', `command -v -- ${binary}`]));
    },
    exists: existsSync,
  };
}

export function createCliExecutableResolver<T = undefined>(
  options: {
    binary: string;
    searchDirs: string[];
    validateCandidate?: (path: string) => CandidateValidation<T>;
  },
  host: CliResolverHost = createProductionCliResolverHost()
): CliExecutableResolver<T> {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(options.binary)) throw new Error(`Unsafe CLI binary name: ${options.binary}`);
  let cached: CliResolution<T> | null = null;
  const accept = (path: string | null, source: CliResolutionSource): CliResolution<T> | null => {
    if (!path || !isAbsolute(path) || !host.exists(path)) return null;
    const validation = options.validateCandidate?.(path) ?? ({ accepted: true } as CandidateValidation<T>);
    if (!validation.accepted) return null;
    return { binaryPath: path, directory: dirname(path), source, metadata: validation.metadata };
  };
  return {
    resolve() {
      if (cached) return cached;
      cached = accept(host.findOnProcessPath(options.binary), 'process-path');
      if (cached) return cached;
      for (const dir of options.searchDirs) {
        cached = accept(join(dir, options.binary), 'common-directory');
        if (cached) return cached;
      }
      cached = accept(host.findInLoginShell(options.binary), 'login-shell');
      return cached;
    },
    diagnostics: () => ({
      binary: options.binary,
      processPath: host.processPath,
      shellPath: host.shellPath,
      shellArgs: [...host.shellArgs],
      searchDirs: [...options.searchDirs],
    }),
  };
}

export function formatCliNotFoundMessage(base: string, diagnostics: CliResolutionDiagnostics): string {
  const shell = [diagnostics.shellPath, ...diagnostics.shellArgs].join(' ');
  const dirs = diagnostics.searchDirs.length > 0 ? diagnostics.searchDirs.join(', ') : '(none)';
  return `${base}\nServer PATH: ${diagnostics.processPath || '(empty)'}\nLogin shell: ${shell}\nChecked directories: ${dirs}`;
}
```

Keep helper functions small and format with Prettier after the first GREEN.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm test -- test/cli-executable-resolver.test.ts`

Expected: 1 file passes with all new tests green.

- [ ] **Step 5: Commit the shared resolver slice**

```bash
git add -- src/utils/cli-executable-resolver.ts test/cli-executable-resolver.test.ts
git commit -m "fix(core): COD-334 add login-shell CLI resolver"
```

---

### Task 2: Migrate Claude, OpenCode, Codex, Gemini, and Antigravity wrappers

**Files:**
- Modify: `src/utils/claude-cli-resolver.ts`
- Modify: `src/utils/opencode-cli-resolver.ts`
- Modify: `src/utils/codex-cli-resolver.ts`
- Modify: `src/utils/gemini-cli-resolver.ts`
- Modify: `src/utils/antigravity-cli-resolver.ts`
- Modify: `test/antigravity-cli-resolver.test.ts`

- [ ] **Step 1: Change the Antigravity tests to prove login-shell-only discovery and negative retry**

Replace child-process implementation assertions with behavior through the exported `createAntigravityResolverForTest` factory and an injected shared resolver host. The required RED assertions are:

```ts
it('resolves agy from the login shell when the service PATH and common directories miss', () => {
  const resolver = createAntigravityResolverForTest(fakeHost({ loginShellPath: '/home/u/.mise/bin/agy' }));
  expect(resolver.resolve()?.directory).toBe('/home/u/.mise/bin');
});

it('retries after an unavailable result', () => {
  const login = vi.fn().mockReturnValueOnce(null).mockReturnValue('/home/u/.local/bin/agy');
  const resolver = createAntigravityResolverForTest(fakeHost({ findInLoginShell: login }));
  expect(resolver.resolve()).toBeNull();
  expect(resolver.resolve()?.binaryPath).toBe('/home/u/.local/bin/agy');
});
```

Use the shared `CliResolverHost` type and a local fake builder; do not spawn the developer's actual shell.

- [ ] **Step 2: Run the existing resolver test and verify RED**

Run: `npm test -- test/antigravity-cli-resolver.test.ts`

Expected: FAIL because the wrapper still uses its private `execSync`/process-lifetime negative cache and has no test factory.

- [ ] **Step 3: Replace each private lookup/cache with a shared resolver instance**

For each resolver, retain its current search-directory constant and public function names. Use this wrapper pattern (Codex example):

```ts
import {
  createCliExecutableResolver,
  formatCliNotFoundMessage,
  type CliResolverHost,
} from './cli-executable-resolver.js';

const CODEX_INSTALL_HINT = 'Codex CLI not found. Install with: npm install -g @openai/codex';

function createResolver(host?: CliResolverHost) {
  return createCliExecutableResolver({ binary: 'codex', searchDirs: CODEX_SEARCH_DIRS }, host);
}

const resolver = createResolver();

export function resolveCodexDir(): string | null {
  return resolver.resolve()?.directory ?? null;
}

export function isCodexAvailable(): boolean {
  return resolveCodexDir() !== null;
}

export function getCodexNotFoundMessage(): string {
  return formatCliNotFoundMessage(CODEX_INSTALL_HINT, resolver.diagnostics());
}

export const createCodexResolverForTest = createResolver;
```

Apply the same structure and exact existing install text to Claude (`claude`), OpenCode (`opencode`), Gemini (`gemini`), and Antigravity (`agy`). Keep Claude's `getClaudeBinaryPath`, `getAugmentedPath`, and version-probe policy unchanged except that their directory source is the shared successful resolution.

- [ ] **Step 4: Run focused wrapper and Claude version-cache tests**

Run: `npm test -- test/antigravity-cli-resolver.test.ts test/claude-cli-version-cache.test.ts test/render-index-html.test.ts`

Expected: all focused files pass; render-time availability remains boolean-compatible.

- [ ] **Step 5: Commit the five compatibility wrappers**

```bash
git add -- src/utils/claude-cli-resolver.ts src/utils/opencode-cli-resolver.ts src/utils/codex-cli-resolver.ts src/utils/gemini-cli-resolver.ts src/utils/antigravity-cli-resolver.ts test/antigravity-cli-resolver.test.ts
git commit -m "fix(core): COD-334 share agent CLI discovery"
```

---

### Task 3: Preserve Pi identity validation on the shared discovery path

**Files:**
- Modify: `src/utils/pi-cli-resolver.ts`
- Modify: `test/pi-mode.test.ts`

- [ ] **Step 1: Add RED tests for rejected-first/accepted-shell Pi candidates**

Add a resolver-focused describe block that injects a validator probe:

```ts
it('rejects a generic pi on service PATH and accepts the coding agent from the login shell', () => {
  const versions = new Map([
    ['/usr/bin/pi', null],
    ['/home/u/.nvm/bin/pi', '0.84.1'],
  ]);
  const resolver = createPiResolverForTest(
    fakeCliHost({ processPathResult: '/usr/bin/pi', loginShellResult: '/home/u/.nvm/bin/pi' }),
    (path) => versions.get(path) ?? null
  );
  expect(resolver.resolve()).toMatchObject({ binaryPath: '/home/u/.nvm/bin/pi', metadata: '0.84.1' });
});

it('reports the validated version from the accepted shared resolution', () => {
  const resolver = createPiResolverForTest(fakeCliHost({ loginShellResult: '/home/u/.nvm/bin/pi' }), () => '0.84.1');
  expect(resolver.resolve()?.metadata).toBe('0.84.1');
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- test/pi-mode.test.ts`

Expected: FAIL because `createPiResolverForTest` does not exist and the current Pi resolver cannot continue from a rejected PATH candidate to a login-shell candidate.

- [ ] **Step 3: Delegate Pi to `createCliExecutableResolver<string>`**

Retain `PI_VERSION_REGEX` and the current production `probePiVersion()`. Create the resolver with:

```ts
function createResolver(host?: CliResolverHost, versionProbe = probePiVersion) {
  return createCliExecutableResolver<string>(
    {
      binary: 'pi',
      searchDirs: PI_SEARCH_DIRS,
      validateCandidate: (path) => {
        if (process.env.VITEST && versionProbe === probePiVersion) return { accepted: true };
        const version = versionProbe(path);
        return version ? { accepted: true, metadata: version } : { accepted: false };
      },
    },
    host
  );
}
```

Make `resolvePiDir()` return the accepted directory, `getPiCliVersion()` return accepted metadata or null, and `getPiNotFoundMessage()` use the shared formatter with the existing install hint. Export `createPiResolverForTest` for the focused injected test.

- [ ] **Step 4: Run Pi and dependency consistency tests**

Run: `npm test -- test/pi-mode.test.ts test/dependency-checker.test.ts test/routes/system-routes.test.ts`

Expected: all pass; `PI_VERSION_REGEX` remains the single shared identity rule.

- [ ] **Step 5: Commit the Pi migration**

```bash
git add -- src/utils/pi-cli-resolver.ts test/pi-mode.test.ts
git commit -m "fix(pi): COD-334 resolve validated CLI through login shell"
```

---

### Task 4: Apply login-shell launch and detailed preflight errors to all modes

**Files:**
- Modify: `src/utils/index.ts`
- Modify: `src/tmux-manager.ts`
- Modify: `test/tmux-manager.test.ts`

- [ ] **Step 1: Add RED coverage for all six local agent modes**

Replace the single OpenCode assertion in `COD-276 buildLocalPaneCommand` with a parameterized test:

```ts
it.each(['claude', 'opencode', 'codex', 'gemini', 'antigravity', 'pi'] as const)(
  'routes %s through the user login shell',
  (mode) => {
    const out = buildLocalPaneCommand({
      mode,
      pathExport: `export PATH="/resolved/${mode}:$PATH" && `,
      envExports: ['export CODEMAN_MUX=1'],
      cmd: `${mode === 'antigravity' ? 'agy' : mode} --version`,
    });
    expect(out).toContain('-i -l -c ');
    expect(out).toContain(`export PATH="/resolved/${mode}:$PATH"`);
  }
);
```

Add a pure exported `cliNotFoundMessage(mode)` test asserting each result contains its existing install hint plus `Server PATH`, `Login shell`, and `Checked directories`.

- [ ] **Step 2: Run and verify RED for Claude and Pi**

Run: `npm test -- test/tmux-manager.test.ts`

Expected: the new parameterized test fails for `claude` and `pi`, and the diagnostic helper is absent.

- [ ] **Step 3: Extend the local-agent predicate and centralize error selection**

Change `isAgentCliMode()` to include all six modes. Re-export each resolver's not-found formatter through `src/utils/index.ts`, then add an exhaustive `cliNotFoundMessage(mode)` switch in `src/tmux-manager.ts`. Replace the six hard-coded `throw new Error(...)` branches with the helper. Keep shell mode outside the helper and throw `new Error('No external CLI error exists for shell mode')` in the switch default.

- [ ] **Step 4: Run focused launch tests and verify GREEN**

Run: `npm test -- test/tmux-manager.test.ts test/shell-session-launch.test.ts test/pi-mode.test.ts`

Expected: all pass, including the unchanged shell-mode behavior.

- [ ] **Step 5: Commit launch consistency**

```bash
git add -- src/utils/index.ts src/tmux-manager.ts test/tmux-manager.test.ts
git commit -m "fix(session): COD-334 align preflight and login-shell launch"
```

---

### Task 5: Carry diagnostic errors through status, routes, and browser launchers

**Files:**
- Modify: `src/web/routes/system-routes.ts`
- Modify: `src/web/routes/session-routes.ts`
- Modify: `src/web/public/session-ui.js`
- Modify: `test/routes/system-routes.test.ts`
- Modify: `test/run-mode-ui.test.ts`

- [ ] **Step 1: Add RED route tests for optional diagnostic errors**

Extend each resolver mock with its `get*NotFoundMessage` export. Add a table-driven status test for the six endpoints that asserts unavailable responses keep `available: false` and add the mock diagnostic, while available responses omit `error`:

```ts
expect(JSON.parse(unavailable.body).data).toMatchObject({
  available: false,
  error: 'diagnostic: login shell and PATH checked',
});
expect(JSON.parse(available.body).data).not.toHaveProperty('error');
```

- [ ] **Step 2: Add RED browser coverage for server-message preference and fallback**

In `test/run-mode-ui.test.ts`, drive the real `session-ui.js` with `/api/codex/status` returning:

```ts
{ success: true, data: { available: false, error: 'Codex missing\nServer PATH: /usr/bin\nLogin shell: /bin/bash -i -l' } }
```

Assert `_reportSessionLaunchError` receives that exact server message and `/api/quick-start` is never called. Add a second case with no `error` and assert the existing install hint remains the fallback. Use one table-driven VM harness covering OpenCode, Codex, Gemini, Antigravity, and Pi; each row supplies the run-method name, status URL, and existing fallback string.

- [ ] **Step 3: Run route and UI tests and verify RED**

Run: `npm test -- test/routes/system-routes.test.ts test/run-mode-ui.test.ts`

Expected: FAIL because status responses do not expose `error` and browser functions ignore it.

- [ ] **Step 4: Implement status and route propagation**

For each status handler, resolve once and return:

```ts
const path = resolveCodexDir();
return {
  available: path !== null,
  path,
  ...(path === null ? { error: getCodexNotFoundMessage() } : {}),
};
```

Keep Pi's `version` field. In both create and quick-start local preflight blocks, replace static strings with the corresponding resolver formatter. Remove the duplicate Antigravity checks while preserving one correctly formatted gate in each flow.

In each of the five status-probed browser launchers, change the unavailable branch to:

```js
this._reportSessionLaunchError(
  ownsLaunchTerminal,
  status.error || 'Codex CLI not found. Install with: npm install -g @openai/codex'
);
```

Use the mode's existing fallback string verbatim.

- [ ] **Step 5: Run focused route/UI tests and verify GREEN**

Run: `npm test -- test/routes/system-routes.test.ts test/run-mode-ui.test.ts test/render-index-html.test.ts`

Expected: all pass; boot-time availability flags remain unchanged.

- [ ] **Step 6: Commit diagnostic propagation**

```bash
git add -- src/web/routes/system-routes.ts src/web/routes/session-routes.ts src/web/public/session-ui.js test/routes/system-routes.test.ts test/run-mode-ui.test.ts
git commit -m "fix(web): COD-334 surface CLI resolution diagnostics"
```

---

### Task 6: Document the invariant and verify the complete change

**Files:**
- Modify: `docs/architecture-invariants.md`
- Modify: `docs/superpowers/specs/2026-08-19-cod-334-login-shell-cli-resolution-design.md`
- Create: `docs/superpowers/plans/2026-08-19-cod-334-login-shell-cli-resolution.md`

- [ ] **Step 1: Add the architecture invariant**

Under “External CLI modes,” document that local availability and local launch share this order: service PATH → agent common directories → interactive login shell; accepted paths are prepended after profile loading; only successes cache; Pi validates every candidate; remote/Docker remain environment-local.

- [ ] **Step 2: Run the focused behavior bundle**

Run:

```bash
npm test -- test/cli-executable-resolver.test.ts test/antigravity-cli-resolver.test.ts test/claude-cli-version-cache.test.ts test/pi-mode.test.ts test/tmux-manager.test.ts test/shell-session-launch.test.ts test/routes/system-routes.test.ts test/run-mode-ui.test.ts test/render-index-html.test.ts
```

Expected: every named file passes. If subprocess tests receive sandbox `EPERM`, rerun this same focused command with the required subprocess permission; do not alter tests to hide the failure.

- [ ] **Step 3: Run static and build gates**

Run:

```bash
npm run typecheck
npm run lint
npm run check:frontend-syntax
npm run check:lockfile
npx prettier --check src/utils/cli-executable-resolver.ts src/utils/claude-cli-resolver.ts src/utils/opencode-cli-resolver.ts src/utils/codex-cli-resolver.ts src/utils/gemini-cli-resolver.ts src/utils/antigravity-cli-resolver.ts src/utils/pi-cli-resolver.ts src/utils/index.ts src/tmux-manager.ts src/web/routes/system-routes.ts src/web/routes/session-routes.ts src/web/public/session-ui.js test/cli-executable-resolver.test.ts test/antigravity-cli-resolver.test.ts test/pi-mode.test.ts test/tmux-manager.test.ts test/routes/system-routes.test.ts test/run-mode-ui.test.ts docs/architecture-invariants.md docs/superpowers/specs/2026-08-19-cod-334-login-shell-cli-resolution-design.md docs/superpowers/plans/2026-08-19-cod-334-login-shell-cli-resolution.md
npm run build
git diff --check
```

Expected: every command exits zero. Existing documented build warnings may remain only if byte-for-byte unrelated to COD-334.

- [ ] **Step 4: Perform a real minimal-PATH functional check**

Using a temporary home and fake executable, start only the isolated verification instance. The temporary profile must add the fake CLI directory while the server `PATH` omits it. Assert:

1. the relevant `/api/<agent>/status` response reports `available: true` and the fake directory;
2. the local pane command resolves through the login shell; and
3. an unavailable fake name produces diagnostics containing the minimal server PATH and resolved shell.

Use `mktemp -d` for the temporary home, a distinct `CODEMAN_INSTANCE=cod334-verify`, distinct data directory/socket, and a non-production port. Terminate only the exact isolated process PID/process group and confirm the port is released. Do not restart or deploy production.

- [ ] **Step 5: Commit documentation and any verification-only test adjustments**

```bash
git add -- docs/architecture-invariants.md docs/superpowers/specs/2026-08-19-cod-334-login-shell-cli-resolution-design.md docs/superpowers/plans/2026-08-19-cod-334-login-shell-cli-resolution.md
git commit -m "docs: COD-334 record shared CLI discovery invariant"
```

- [ ] **Step 6: Prepare Jira evidence**

Record the RED failure, GREEN focused tests, static/build results, isolated functional proof, branch name, and final commit hash in COD-334. Keep the issue In Progress until independent review and landing are complete.
