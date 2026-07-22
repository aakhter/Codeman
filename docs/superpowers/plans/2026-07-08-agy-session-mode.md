# Agy Session Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `agy` (Antigravity CLI) as a new `SessionMode` in Codeman, following the exact pattern of the existing Gemini mode.

**Architecture:** Mirror every Gemini-mode touchpoint — CLI resolver, type definitions, tmux command builder, session methods, Zod schemas, route handlers, system status endpoint, and frontend badge/labels — replacing `gemini`/`Gemini`/`gm` with `agy`/`Agy`/`ag`. The agy CLI uses `--dangerously-skip-permissions`, `--continue`/`--conversation`, and `--model` flags; no approval-mode equivalent exists.

**Tech Stack:** TypeScript (ESM strict), Fastify, Zod v4, Vitest, vanilla JS frontend

## Global Constraints

- TypeScript strict mode: `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`
- ESM only — no `require()`, all dynamic imports use `await import()`
- No task-referencing comments or `// added for agy` comments in code
- Follow exact Gemini patterns unless explicitly noted otherwise
- Injection-safe: all CLI args built from regex-validated inputs only
- Test commands: `npm test -- test/<file>.test.ts` (never bare `npm test`)
- Typecheck: `tsc --noEmit`

---

## File Map

| Action | File | What changes |
|--------|------|-------------|
| Create | `src/utils/agy-cli-resolver.ts` | `resolveAgyDir()`, `isAgyAvailable()` |
| Modify | `src/types/session.ts` | Add `'agy'` to `SessionMode`, `RemoteCommandMode`; add `AgyConfig` interface; add `agyConfig?` to `SessionState` |
| Modify | `src/tmux-manager.ts` | Import `AgyConfig`/`resolveAgyDir`; add `buildAgyCommand()`; extend `buildSpawnCommand`, `buildPathExport`, `createSession`, `respawnPane`, env-export logic |
| Modify | `src/session.ts` | Add `'agy'` to `isExternalCliMode`, `getModeLabel`, `isAltScreenStripMode`; add `_agyConfig` field + getter; handle in constructor and `toState()`; pass in `respawn()` |
| Modify | `src/web/schemas.ts` | Add `AgyConfigSchema`; add `'agy'` to `CreateSessionSchema` and `QuickStartSchema` mode enums; add `agyConfig` field |
| Modify | `src/web/routes/session-routes.ts` | Add `isAgyAvailable` check; add `agyConfig` extraction; extend all `gemini`-gated guards to include `agy` |
| Modify | `src/web/routes/system-routes.ts` | Add `GET /api/agy/status` endpoint |
| Modify | `src/web/routes/respawn-routes.ts` | Add `agy` to all `gemini` no-respawn guards |
| Modify | `src/web/public/app.js` | Add `ag` tab badge; extend alt-screen/isExternalCli/kill-label checks |
| Modify | `src/web/public/session-ui.js` | Add `runAgy()` method; extend mode checks; add `Run AG` label; extend mode normalization |
| Create | `test/agy-cli-resolver.test.ts` | Unit tests for resolver functions |
| Create | `test/agy-mode.test.ts` | Schema tests for agy session config |
| Modify | `test/routes/system-routes.test.ts` | Add mock for `agy-cli-resolver` + tests for `GET /api/agy/status` |

---

### Task 1: CLI Resolver

**Files:**
- Create: `src/utils/agy-cli-resolver.ts`
- Create: `test/agy-cli-resolver.test.ts`

**Interfaces:**
- Produces: `resolveAgyDir(): string | null`, `isAgyAvailable(): boolean`
- Later tasks import from `../../utils/agy-cli-resolver.js`

- [ ] **Step 1: Write the failing test**

Create `test/agy-cli-resolver.test.ts`:

```typescript
/**
 * @fileoverview Tests for the Agy CLI resolver.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const mockedExecSync = vi.mocked(execSync);
const mockedExistsSync = vi.mocked(existsSync);

// Reset module cache between tests so _agyDir caching doesn't bleed
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('resolveAgyDir', () => {
  it('returns directory from `which agy` when found in PATH', async () => {
    mockedExecSync.mockReturnValue('/home/user/.local/bin/agy\n');
    mockedExistsSync.mockReturnValue(true);
    const { resolveAgyDir } = await import('../src/utils/agy-cli-resolver.js');
    expect(resolveAgyDir()).toBe('/home/user/.local/bin');
  });

  it('returns null when agy is not found anywhere', async () => {
    mockedExecSync.mockImplementation(() => { throw new Error('not found'); });
    mockedExistsSync.mockReturnValue(false);
    const { resolveAgyDir } = await import('../src/utils/agy-cli-resolver.js');
    expect(resolveAgyDir()).toBeNull();
  });

  it('falls back to common install dirs when `which` fails', async () => {
    mockedExecSync.mockImplementation(() => { throw new Error('not found'); });
    mockedExistsSync.mockImplementation((p) => String(p).endsWith('/.local/bin/agy'));
    const { resolveAgyDir } = await import('../src/utils/agy-cli-resolver.js');
    const result = resolveAgyDir();
    expect(result).toMatch(/\.local\/bin$/);
  });
});

describe('isAgyAvailable', () => {
  it('returns true when resolveAgyDir returns a path', async () => {
    mockedExecSync.mockReturnValue('/home/user/.local/bin/agy\n');
    mockedExistsSync.mockReturnValue(true);
    const { isAgyAvailable } = await import('../src/utils/agy-cli-resolver.js');
    expect(isAgyAvailable()).toBe(true);
  });

  it('returns false when agy cannot be found', async () => {
    mockedExecSync.mockImplementation(() => { throw new Error('not found'); });
    mockedExistsSync.mockReturnValue(false);
    const { isAgyAvailable } = await import('../src/utils/agy-cli-resolver.js');
    expect(isAgyAvailable()).toBe(false);
  });
});
```

- [ ] **Step 2: Run the failing test**

```bash
cd /home/aakht/.codeman/app
npm test -- test/agy-cli-resolver.test.ts
```

Expected: FAIL — module `../src/utils/agy-cli-resolver.js` not found.

- [ ] **Step 3: Create `src/utils/agy-cli-resolver.ts`**

```typescript
/**
 * @fileoverview Resolve the Agy CLI binary across common install paths.
 *
 * Mirrors gemini-cli-resolver.ts. Finds the `agy` binary and provides
 * an augmented PATH directory for tmux sessions.
 *
 * @module utils/agy-cli-resolver
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { EXEC_TIMEOUT_MS } from '../config/exec-timeout.js';

/** Common directories where the Agy CLI binary may be installed */
const AGY_SEARCH_DIRS = [
  join(homedir(), '.local', 'bin'),
  '/usr/local/bin',
  join(homedir(), '.bun', 'bin'),
  join(homedir(), '.npm-global', 'bin'),
  join(homedir(), 'bin'),
];

/** Cached directory containing the agy binary (empty string = searched but not found) */
let _agyDir: string | null = null;

/**
 * Finds the directory containing the `agy` binary.
 * Checks `which agy` first, then falls back to common install locations.
 *
 * @returns Directory path, or null if not found
 */
export function resolveAgyDir(): string | null {
  if (_agyDir !== null) return _agyDir || null;

  try {
    const result = execSync('which agy', {
      encoding: 'utf-8',
      timeout: EXEC_TIMEOUT_MS,
    }).trim();
    if (result && existsSync(result)) {
      _agyDir = dirname(result);
      return _agyDir;
    }
  } catch {
    // Agy not in PATH, will check common locations
  }

  for (const dir of AGY_SEARCH_DIRS) {
    if (existsSync(join(dir, 'agy'))) {
      _agyDir = dir;
      return _agyDir;
    }
  }

  _agyDir = '';
  return null;
}

/**
 * Check if Agy CLI is available on the system.
 */
export function isAgyAvailable(): boolean {
  return resolveAgyDir() !== null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm test -- test/agy-cli-resolver.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /home/aakht/.codeman/app
git add src/utils/agy-cli-resolver.ts test/agy-cli-resolver.test.ts
git commit -m "COD-195 feat: add agy-cli-resolver utility"
```

---

### Task 2: Types

**Files:**
- Modify: `src/types/session.ts` (lines 11, 44, 46, 188-area, 346-area)

**Interfaces:**
- Consumes: nothing new
- Produces: `SessionMode` extended with `'agy'`; `AgyConfig` interface; `SessionState.agyConfig?: AgyConfig`

- [ ] **Step 1: Write the failing schema test**

Create `test/agy-mode.test.ts`:

```typescript
/**
 * @fileoverview Schema tests for agy session mode.
 */
import { describe, expect, it } from 'vitest';
import { CreateSessionSchema, QuickStartSchema } from '../src/web/schemas.js';

describe('Agy mode schemas', () => {
  it('accepts agy session creation config', () => {
    const parsed = CreateSessionSchema.parse({
      workingDir: '/tmp',
      mode: 'agy',
      agyConfig: {
        model: 'claude-3-5-sonnet',
      },
    });

    expect(parsed.mode).toBe('agy');
    expect(parsed.agyConfig).toEqual({ model: 'claude-3-5-sonnet' });
  });

  it('accepts agy quick-start config', () => {
    const parsed = QuickStartSchema.parse({
      caseName: 'agy-case',
      mode: 'agy',
      agyConfig: {
        resumeSession: 'latest',
      },
    });

    expect(parsed.mode).toBe('agy');
    expect(parsed.agyConfig?.resumeSession).toBe('latest');
  });

  it('rejects unsafe agy model strings', () => {
    expect(() =>
      CreateSessionSchema.parse({
        workingDir: '/tmp',
        mode: 'agy',
        agyConfig: { model: 'agy; rm -rf /' },
      })
    ).toThrow();
  });

  it('rejects unsafe agy resumeSession strings', () => {
    expect(() =>
      CreateSessionSchema.parse({
        workingDir: '/tmp',
        mode: 'agy',
        agyConfig: { resumeSession: '../../../etc/passwd' },
      })
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test -- test/agy-mode.test.ts
```

Expected: FAIL — `'agy'` not in the mode enum.

- [ ] **Step 3: Update `src/types/session.ts`**

3a. Update the `@fileoverview` comment to mention `AgyConfig`:

Find:
```typescript
 * - GeminiConfig — Gemini CLI-specific settings (model, approvalMode, resumeSession)
```
Replace with:
```typescript
 * - GeminiConfig — Gemini CLI-specific settings (model, approvalMode, resumeSession)
 * - AgyConfig — Agy CLI-specific settings (model, resumeSession)
```

3b. Extend `SessionMode`:

Find:
```typescript
export type SessionMode = 'claude' | 'shell' | 'opencode' | 'codex' | 'gemini';
```
Replace with:
```typescript
export type SessionMode = 'claude' | 'shell' | 'opencode' | 'codex' | 'gemini' | 'agy';
```

3c. Extend `RemoteCommandMode`:

Find:
```typescript
export type RemoteCommandMode = Extract<SessionMode, 'shell' | 'claude' | 'opencode' | 'codex' | 'gemini'>;
```
Replace with:
```typescript
export type RemoteCommandMode = Extract<SessionMode, 'shell' | 'claude' | 'opencode' | 'codex' | 'gemini' | 'agy'>;
```

3d. Add `AgyConfig` after `GeminiConfig` (after the closing `}` of `GeminiConfig`):

Find:
```typescript
/** Gemini CLI session configuration */
export interface GeminiConfig {
  /** Model identifier (e.g., "gemini-2.5-pro"). Passed via --model. */
  model?: string;
  /** Gemini approval mode for tool calls. */
  approvalMode?: 'default' | 'auto_edit' | 'yolo' | 'plan';
  /** Resume a previous Gemini session ("latest", index, or session id). */
  resumeSession?: string;
}
```
Replace with:
```typescript
/** Gemini CLI session configuration */
export interface GeminiConfig {
  /** Model identifier (e.g., "gemini-2.5-pro"). Passed via --model. */
  model?: string;
  /** Gemini approval mode for tool calls. */
  approvalMode?: 'default' | 'auto_edit' | 'yolo' | 'plan';
  /** Resume a previous Gemini session ("latest", index, or session id). */
  resumeSession?: string;
}

/** Agy CLI session configuration */
export interface AgyConfig {
  /** Model identifier (e.g., "claude-3-5-sonnet"). Passed via --model. */
  model?: string;
  /** Resume a previous Agy session ("latest" for --continue, or conversation ID for --conversation). */
  resumeSession?: string;
}
```

3e. Add `agyConfig` to `SessionState` (right after the `geminiConfig` line):

Find:
```typescript
  /** Gemini-specific configuration (only for mode === 'gemini') */
  geminiConfig?: GeminiConfig;
```
Replace with:
```typescript
  /** Gemini-specific configuration (only for mode === 'gemini') */
  geminiConfig?: GeminiConfig;
  /** Agy-specific configuration (only for mode === 'agy') */
  agyConfig?: AgyConfig;
```

- [ ] **Step 4: Run the schema test**

```bash
npm test -- test/agy-mode.test.ts
```

Expected: FAIL still — schemas not updated yet. This confirms the types compiled but schemas aren't done. Move to Task 3 (schemas) before re-running this test.

- [ ] **Step 5: Commit types only**

```bash
cd /home/aakht/.codeman/app
git add src/types/session.ts test/agy-mode.test.ts
git commit -m "COD-195 feat: add AgyConfig type and agy SessionMode"
```

---

### Task 3: Schemas

**Files:**
- Modify: `src/web/schemas.ts`

**Interfaces:**
- Consumes: `AgyConfig` from `src/types/session.ts` (type-level only; schemas are runtime Zod)
- Produces: `AgyConfigSchema` (internal); `CreateSessionSchema` and `QuickStartSchema` accept `mode: 'agy'` and `agyConfig`

- [ ] **Step 1: Add `AgyConfigSchema` and extend both schemas**

In `src/web/schemas.ts`, after `GeminiConfigSchema` (after its `.optional()` closing), add:

Find:
```typescript
/** Schema for Gemini CLI-specific configuration */
const GeminiConfigSchema = z
  .object({
    model: z
      .string()
      .max(100)
      .regex(/^[a-zA-Z0-9._\-/]+$/)
      .optional(),
    approvalMode: z.enum(['default', 'auto_edit', 'yolo', 'plan']).optional(),
    resumeSession: z
      .string()
      .max(100)
      .regex(/^[a-zA-Z0-9._-]+$/)
      .optional(),
  })
  .optional();
```
Replace with:
```typescript
/** Schema for Gemini CLI-specific configuration */
const GeminiConfigSchema = z
  .object({
    model: z
      .string()
      .max(100)
      .regex(/^[a-zA-Z0-9._\-/]+$/)
      .optional(),
    approvalMode: z.enum(['default', 'auto_edit', 'yolo', 'plan']).optional(),
    resumeSession: z
      .string()
      .max(100)
      .regex(/^[a-zA-Z0-9._-]+$/)
      .optional(),
  })
  .optional();

/** Schema for Agy CLI-specific configuration */
const AgyConfigSchema = z
  .object({
    model: z
      .string()
      .max(100)
      .regex(/^[a-zA-Z0-9._\-/]+$/)
      .optional(),
    resumeSession: z
      .string()
      .max(100)
      .regex(/^[a-zA-Z0-9._-]+$/)
      .optional(),
  })
  .optional();
```

In `CreateSessionSchema`, extend the mode enum and add `agyConfig`. Find:
```typescript
  mode: z.enum(['claude', 'shell', 'opencode', 'codex', 'gemini']).optional(),
```
(First occurrence, in `CreateSessionSchema`) — replace with:
```typescript
  mode: z.enum(['claude', 'shell', 'opencode', 'codex', 'gemini', 'agy']).optional(),
```

Then find (within `CreateSessionSchema`):
```typescript
  geminiConfig: GeminiConfigSchema,
```
Replace with:
```typescript
  geminiConfig: GeminiConfigSchema,
  agyConfig: AgyConfigSchema,
```

In `QuickStartSchema`, find:
```typescript
  mode: z.enum(['claude', 'shell', 'opencode', 'codex', 'gemini']).optional(),
  openCodeConfig: OpenCodeConfigSchema,
  codexConfig: CodexConfigSchema,
  geminiConfig: GeminiConfigSchema,
```
Replace with:
```typescript
  mode: z.enum(['claude', 'shell', 'opencode', 'codex', 'gemini', 'agy']).optional(),
  openCodeConfig: OpenCodeConfigSchema,
  codexConfig: CodexConfigSchema,
  geminiConfig: GeminiConfigSchema,
  agyConfig: AgyConfigSchema,
```

There is also a second `mode` enum in the update schema around line 417. Find:
```typescript
  mode: z.enum(['claude', 'shell', 'opencode', 'codex', 'gemini']).optional(),
  ...
  geminiConfig: GeminiConfigSchema,
```
(Second occurrence — in the update/patch schema) and apply the same two changes there.

- [ ] **Step 2: Run schema tests**

```bash
npm test -- test/agy-mode.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 3: Typecheck**

```bash
tsc --noEmit 2>&1 | head -30
```

Expected: 0 errors (or only pre-existing errors unrelated to agy).

- [ ] **Step 4: Commit**

```bash
cd /home/aakht/.codeman/app
git add src/web/schemas.ts
git commit -m "COD-195 feat: add AgyConfigSchema and agy to session schemas"
```

---

### Task 4: TmuxManager — command builder and session wiring

**Files:**
- Modify: `src/tmux-manager.ts`

**Interfaces:**
- Consumes: `AgyConfig` from `src/types/session.ts`; `resolveAgyDir` from `src/utils/agy-cli-resolver.ts`
- Produces: `buildAgyCommand(config?: AgyConfig): string`; `buildSpawnCommand` / `buildPathExport` / `createSession` / `respawnPane` extended with `agyConfig`

- [ ] **Step 1: Add imports**

In `src/tmux-manager.ts`, locate the existing imports block for types and CLI resolvers. Add `AgyConfig` to the types import and add the resolver import.

Find:
```typescript
  type GeminiConfig,
```
Replace with:
```typescript
  type AgyConfig,
  type GeminiConfig,
```

Find:
```typescript
  resolveGeminiDir,
```
Replace with:
```typescript
  resolveAgyDir,
  resolveGeminiDir,
```

(These import lines are near the top of the file, alongside other CLI resolver imports.)

- [ ] **Step 2: Add `buildAgyCommand()`**

Find the closing brace of `buildGeminiCommand` (the function that ends with `return parts.join(' ');`). Append after it:

Find:
```typescript
  if (options.mode === 'gemini') {
    return buildGeminiCommand(options.geminiConfig);
  }
```
Replace with:
```typescript
  if (options.mode === 'gemini') {
    return buildGeminiCommand(options.geminiConfig);
  }
  if (options.mode === 'agy') {
    return buildAgyCommand(options.agyConfig);
  }
```

Now find where `buildGeminiCommand` is defined (the function body itself) and add `buildAgyCommand` right after it (before `buildSpawnCommand` or the function that contains the `options.mode === 'gemini'` branch):

The new function to insert:

```typescript
/**
 * Build the Agy CLI command with appropriate flags.
 *
 * Uses --dangerously-skip-permissions to match Codeman's Claude default.
 * --continue resumes the latest conversation; --conversation <id> resumes
 * a specific one.
 */
function buildAgyCommand(config?: AgyConfig): string {
  const parts = ['agy', '--dangerously-skip-permissions'];
  if (config?.model) {
    const safeModel = /^[a-zA-Z0-9._\-/]+$/.test(config.model) ? config.model : undefined;
    if (safeModel) parts.push('--model', safeModel);
  }
  if (config?.resumeSession) {
    if (config.resumeSession === 'latest') {
      parts.push('--continue');
    } else {
      const safeId = /^[a-zA-Z0-9._-]+$/.test(config.resumeSession) ? config.resumeSession : undefined;
      if (safeId) parts.push('--conversation', safeId);
    }
  }
  return parts.join(' ');
}
```

- [ ] **Step 3: Extend `CreateSessionOptions` and `RespawnPaneOptions` interfaces**

Find the `geminiConfig?: GeminiConfig;` line in `CreateSessionOptions`:
```typescript
  geminiConfig?: GeminiConfig;
```
Replace with:
```typescript
  agyConfig?: AgyConfig;
  geminiConfig?: GeminiConfig;
```

Do the same in `RespawnPaneOptions` (same field pattern, different interface).

- [ ] **Step 4: Extend `buildPathExport`**

Find:
```typescript
    if (mode === 'gemini') {
      const dir = resolveGeminiDir();
      return { pathExport: dir ? `export PATH="${dir}:$PATH" && ` : '', dir };
    }
```
Replace with:
```typescript
    if (mode === 'gemini') {
      const dir = resolveGeminiDir();
      return { pathExport: dir ? `export PATH="${dir}:$PATH" && ` : '', dir };
    }
    if (mode === 'agy') {
      const dir = resolveAgyDir();
      return { pathExport: dir ? `export PATH="${dir}:$PATH" && ` : '', dir };
    }
```

- [ ] **Step 5: Extend `buildEnvExports` truecolor/NO_COLOR lines**

Find:
```typescript
      mode === 'opencode' || mode === 'codex' || mode === 'gemini' || truecolorEnabled
```
Replace with:
```typescript
      mode === 'opencode' || mode === 'codex' || mode === 'gemini' || mode === 'agy' || truecolorEnabled
```

Find:
```typescript
      ...(mode === 'codex' || mode === 'gemini' ? ['unset NO_COLOR'] : []),
```
Replace with:
```typescript
      ...(mode === 'codex' || mode === 'gemini' || mode === 'agy' ? ['unset NO_COLOR'] : []),
```

- [ ] **Step 6: Extend `createSession` — CLI not found error + config extraction**

Find:
```typescript
    if (mode === 'gemini' && !cliDir) {
      throw new Error('Gemini CLI not found. Install with: npm install -g @google/gemini-cli');
    }
```
Replace with:
```typescript
    if (mode === 'gemini' && !cliDir) {
      throw new Error('Gemini CLI not found. Install with: npm install -g @google/gemini-cli');
    }
    if (mode === 'agy' && !cliDir) {
      throw new Error('Agy CLI not found. Install from antigravity.');
    }
```

In the destructuring of `createSession` options, add `agyConfig` alongside `geminiConfig`:

Find:
```typescript
      geminiConfig,
      resumeSessionId,
```
Replace with:
```typescript
      agyConfig,
      geminiConfig,
      resumeSessionId,
```

In the `buildSpawnCommand` call inside `createSession`, add `agyConfig`:

Find:
```typescript
      geminiConfig,
      resumeSessionId,
      effort,
    });
```
(The call within `createSession`) — replace with:
```typescript
      agyConfig,
      geminiConfig,
      resumeSessionId,
      effort,
    });
```

- [ ] **Step 7: Extend `createSession` — Gemini env-configure block**

Find:
```typescript
      // For Gemini: set Gemini/Google auth env vars via tmux setenv
      if (mode === 'gemini') {
        await this._configureGemini(muxName);
      }
```
Replace with:
```typescript
      // For Gemini: set Gemini/Google auth env vars via tmux setenv
      if (mode === 'gemini') {
        await this._configureGemini(muxName);
      }
      // Agy uses the same auth as Claude; no additional env setup needed
```

(No `_configureAgy` method is needed — agy authenticates like Claude.)

- [ ] **Step 8: Extend `respawnPane` — same agyConfig plumbing**

Destructure `agyConfig` in `respawnPane` options (same pattern as Step 6).

Add to the `buildSpawnCommand` call in `respawnPane` (same pattern as Step 6).

Find the Gemini-configure block in `respawnPane`:
```typescript
      // For Gemini: set Gemini/Google auth env vars via tmux setenv before respawn
      if (mode === 'gemini') {
        await this._configureGemini(muxName);
      }
```
Replace with:
```typescript
      // For Gemini: set Gemini/Google auth env vars via tmux setenv before respawn
      if (mode === 'gemini') {
        await this._configureGemini(muxName);
      }
      // Agy uses the same auth as Claude; no additional env setup needed
```

- [ ] **Step 9: Typecheck**

```bash
tsc --noEmit 2>&1 | head -30
```

Expected: 0 new errors.

- [ ] **Step 10: Commit**

```bash
cd /home/aakht/.codeman/app
git add src/tmux-manager.ts
git commit -m "COD-195 feat: add agy command builder and tmux session wiring"
```

---

### Task 5: Session class

**Files:**
- Modify: `src/session.ts`

**Interfaces:**
- Consumes: `AgyConfig` from `src/types/session.ts`; `resolveAgyDir` from `agy-cli-resolver`
- Produces: `isExternalCliMode('agy') === true`; `getModeLabel('agy') === 'Agy'`; `isAltScreenStripMode('agy') === true`; `session.agyConfig` getter

- [ ] **Step 1: Update `isExternalCliMode`**

Find:
```typescript
export function isExternalCliMode(mode: SessionMode): boolean {
  return mode === 'opencode' || mode === 'codex' || mode === 'gemini';
}
```
Replace with:
```typescript
export function isExternalCliMode(mode: SessionMode): boolean {
  return mode === 'opencode' || mode === 'codex' || mode === 'gemini' || mode === 'agy';
}
```

- [ ] **Step 2: Update `getModeLabel`**

Find:
```typescript
    case 'gemini':
      return 'Gemini';
```
Replace with:
```typescript
    case 'gemini':
      return 'Gemini';
    case 'agy':
      return 'Agy';
```

- [ ] **Step 3: Update `isAltScreenStripMode`**

Find:
```typescript
export function isAltScreenStripMode(mode: SessionMode): boolean {
  return mode === 'codex' || mode === 'claude' || mode === 'gemini';
}
```
Replace with:
```typescript
export function isAltScreenStripMode(mode: SessionMode): boolean {
  return mode === 'codex' || mode === 'claude' || mode === 'gemini' || mode === 'agy';
}
```

- [ ] **Step 4: Add import for `AgyConfig`**

Find the existing import that includes `GeminiConfig`:
```typescript
  type GeminiConfig,
```
Replace with:
```typescript
  type AgyConfig,
  type GeminiConfig,
```

- [ ] **Step 5: Add `_agyConfig` private field**

Find:
```typescript
  // Gemini configuration (only for mode === 'gemini')
  private _geminiConfig: GeminiConfig | undefined;
```
Replace with:
```typescript
  // Agy configuration (only for mode === 'agy')
  private _agyConfig: AgyConfig | undefined;
  // Gemini configuration (only for mode === 'gemini')
  private _geminiConfig: GeminiConfig | undefined;
```

- [ ] **Step 6: Handle `agyConfig` in constructor config parameter**

The constructor's config parameter type lists supported fields. Find where `geminiConfig?: GeminiConfig;` appears inside the constructor's config type (around line 525-526):
```typescript
      /** Gemini configuration (only for mode === 'gemini') */
      geminiConfig?: GeminiConfig;
```
Replace with:
```typescript
      /** Agy configuration (only for mode === 'agy') */
      agyConfig?: AgyConfig;
      /** Gemini configuration (only for mode === 'gemini') */
      geminiConfig?: GeminiConfig;
```

Then in the constructor body, after the Gemini config block:
```typescript
    // Apply Gemini configuration
    if (config.geminiConfig) {
      this._geminiConfig = config.geminiConfig;
    }
```
Replace with:
```typescript
    // Apply Agy configuration
    if (config.agyConfig) {
      this._agyConfig = config.agyConfig;
    }
    // Apply Gemini configuration
    if (config.geminiConfig) {
      this._geminiConfig = config.geminiConfig;
    }
```

- [ ] **Step 7: Add getter**

Find the getter for `geminiConfig` (if it exists) or add after `_geminiConfig` private field. After the line `private _geminiConfig: GeminiConfig | undefined;`, look for any existing getter pattern and add:

```typescript
  get agyConfig(): AgyConfig | undefined {
    return this._agyConfig;
  }
```

(If the Gemini getter exists, add the agy getter in the same location pattern.)

- [ ] **Step 8: Add to `toState()`**

Find:
```typescript
      geminiConfig: this._geminiConfig,
```
Replace with:
```typescript
      agyConfig: this._agyConfig,
      geminiConfig: this._geminiConfig,
```

- [ ] **Step 9: Pass `agyConfig` in `respawn()` and all spawn call sites**

Search for all call sites in `session.ts` that pass `geminiConfig` to tmux:

```bash
grep -n 'geminiConfig: this\._geminiConfig' src/session.ts
```

For each match found, add `agyConfig: this._agyConfig,` on the line before `geminiConfig: this._geminiConfig,`.

- [ ] **Step 9b: Add tmux-required guard for agy**

Find:
```typescript
      // Gemini sessions require tmux for Gemini/Google auth env injection via setenv
      if (this.mode === 'gemini') {
        throw new Error('Gemini sessions require tmux. Direct PTY fallback is not supported.');
      }
```
Replace with:
```typescript
      // Gemini sessions require tmux for Gemini/Google auth env injection via setenv
      if (this.mode === 'gemini') {
        throw new Error('Gemini sessions require tmux. Direct PTY fallback is not supported.');
      }
      if (this.mode === 'agy') {
        throw new Error('Agy sessions require tmux. Direct PTY fallback is not supported.');
      }
```

- [ ] **Step 10: Typecheck**

```bash
tsc --noEmit 2>&1 | head -30
```

Expected: 0 new errors.

- [ ] **Step 11: Commit**

```bash
cd /home/aakht/.codeman/app
git add src/session.ts
git commit -m "COD-195 feat: add agy mode support to Session class"
```

---

### Task 6: Route handlers

**Files:**
- Modify: `src/web/routes/session-routes.ts`
- Modify: `src/web/routes/system-routes.ts`
- Modify: `src/web/routes/respawn-routes.ts`

**Interfaces:**
- Consumes: `isAgyAvailable` from `agy-cli-resolver.js`; `AgyConfig`/`agyConfig` from schemas
- Produces: `GET /api/agy/status`; session creation/quick-start handle `mode: 'agy'`

- [ ] **Step 1: Write the system-routes test additions**

In `test/routes/system-routes.test.ts`, add the agy mock alongside the gemini mock. Find:
```typescript
vi.mock('../../src/utils/gemini-cli-resolver.js', () => ({
  isGeminiAvailable: vi.fn(() => false),
  resolveGeminiDir: vi.fn(() => null),
}));
```
Replace with:
```typescript
vi.mock('../../src/utils/agy-cli-resolver.js', () => ({
  isAgyAvailable: vi.fn(() => false),
  resolveAgyDir: vi.fn(() => null),
}));

vi.mock('../../src/utils/gemini-cli-resolver.js', () => ({
  isGeminiAvailable: vi.fn(() => false),
  resolveGeminiDir: vi.fn(() => null),
}));
```

Then add the imports alongside the gemini ones:
```typescript
import { isAgyAvailable, resolveAgyDir } from '../../src/utils/agy-cli-resolver.js';
```

And mocked references:
```typescript
const mockedIsAgyAvailable = vi.mocked(isAgyAvailable);
const mockedResolveAgyDir = vi.mocked(resolveAgyDir);
```

In the `beforeEach` reset block, add:
```typescript
    mockedIsAgyAvailable.mockReturnValue(false);
    mockedResolveAgyDir.mockReturnValue(null);
```

Then add the test suite at the bottom (before the closing `describe` of the file or after the Gemini tests):
```typescript
  // ========== GET /api/agy/status ==========

  describe('GET /api/agy/status', () => {
    it('returns unavailable when agy is not installed', async () => {
      mockedIsAgyAvailable.mockReturnValue(false);
      mockedResolveAgyDir.mockReturnValue(null);

      const res = await harness.app.inject({ method: 'GET', url: '/api/agy/status' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.available).toBe(false);
      expect(body.path).toBeNull();
    });

    it('returns available with path when agy is installed', async () => {
      mockedIsAgyAvailable.mockReturnValue(true);
      mockedResolveAgyDir.mockReturnValue('/home/user/.local/bin');

      const res = await harness.app.inject({ method: 'GET', url: '/api/agy/status' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.available).toBe(true);
      expect(body.path).toBe('/home/user/.local/bin');
    });
  });
```

- [ ] **Step 2: Run to verify these tests fail**

```bash
npm test -- test/routes/system-routes.test.ts 2>&1 | grep -E 'FAIL|agy|PASS' | head -20
```

Expected: the agy tests fail (endpoint does not exist yet).

- [ ] **Step 3: Add `GET /api/agy/status` to `src/web/routes/system-routes.ts`**

Find the existing Gemini endpoint block:
```typescript
  // ========== Gemini ==========

  app.get('/api/gemini/status', async () => {
    const { isGeminiAvailable, resolveGeminiDir } = await import('../../utils/gemini-cli-resolver.js');
    return {
      available: isGeminiAvailable(),
      path: resolveGeminiDir(),
    };
  });
```
Replace with:
```typescript
  // ========== Gemini ==========

  app.get('/api/gemini/status', async () => {
    const { isGeminiAvailable, resolveGeminiDir } = await import('../../utils/gemini-cli-resolver.js');
    return {
      available: isGeminiAvailable(),
      path: resolveGeminiDir(),
    };
  });

  // ========== Agy ==========

  app.get('/api/agy/status', async () => {
    const { isAgyAvailable, resolveAgyDir } = await import('../../utils/agy-cli-resolver.js');
    return {
      available: isAgyAvailable(),
      path: resolveAgyDir(),
    };
  });
```

- [ ] **Step 4: Verify system-routes tests pass**

```bash
npm test -- test/routes/system-routes.test.ts 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 5: Update `src/web/routes/session-routes.ts` — `POST /api/sessions`**

5a. Extend the `canStripDisk` guard (settings.local.json is Claude-only):

Find:
```typescript
      body.mode !== 'gemini' &&
```
Replace with:
```typescript
      body.mode !== 'gemini' &&
      body.mode !== 'agy' &&
```

5b. Add the CLI availability check after the Gemini one:

Find:
```typescript
    // Check Gemini availability if requested
    if (body.mode === 'gemini') {
      const { isGeminiAvailable } = await import('../../utils/gemini-cli-resolver.js');
      if (!isGeminiAvailable()) {
        return createErrorResponse(
          ApiErrorCode.OPERATION_FAILED,
          'Gemini CLI not found. Install with: npm install -g @google/gemini-cli'
        );
      }
    }
```
Replace with:
```typescript
    // Check Gemini availability if requested
    if (body.mode === 'gemini') {
      const { isGeminiAvailable } = await import('../../utils/gemini-cli-resolver.js');
      if (!isGeminiAvailable()) {
        return createErrorResponse(
          ApiErrorCode.OPERATION_FAILED,
          'Gemini CLI not found. Install with: npm install -g @google/gemini-cli'
        );
      }
    }

    // Check Agy availability if requested
    if (body.mode === 'agy') {
      const { isAgyAvailable } = await import('../../utils/agy-cli-resolver.js');
      if (!isAgyAvailable()) {
        return createErrorResponse(
          ApiErrorCode.OPERATION_FAILED,
          'Agy CLI not found.'
        );
      }
    }
```

5c. Extend the model extraction chain:

Find:
```typescript
    const model =
      mode === 'opencode'
        ? body.openCodeConfig?.model
        : mode === 'codex'
          ? body.codexConfig?.model
          : mode === 'gemini'
            ? body.geminiConfig?.model
            : mode !== 'shell'
              ? modelConfig?.defaultModel || undefined
              : undefined;
```
Replace with:
```typescript
    const model =
      mode === 'opencode'
        ? body.openCodeConfig?.model
        : mode === 'codex'
          ? body.codexConfig?.model
          : mode === 'gemini'
            ? body.geminiConfig?.model
            : mode === 'agy'
              ? body.agyConfig?.model
              : mode !== 'shell'
                ? modelConfig?.defaultModel || undefined
                : undefined;
```

5d. Add `agyConfig` to `new Session(...)` call:

Find:
```typescript
      geminiConfig: mode === 'gemini' ? body.geminiConfig : undefined,
```
Replace with:
```typescript
      agyConfig: mode === 'agy' ? body.agyConfig : undefined,
      geminiConfig: mode === 'gemini' ? body.geminiConfig : undefined,
```

5e. Extend the Ralph guard (not supported for agy):

Find:
```typescript
        session.mode !== 'gemini' &&
```
Replace with:
```typescript
        session.mode !== 'gemini' &&
        session.mode !== 'agy' &&
```

5f. Extend `isCaptureOnlyTuiMode`:

Find:
```typescript
    const isCaptureOnlyTuiMode = session.mode === 'codex' || session.mode === 'gemini' || session.mode === 'opencode';
```
Replace with:
```typescript
    const isCaptureOnlyTuiMode = session.mode === 'codex' || session.mode === 'gemini' || session.mode === 'opencode' || session.mode === 'agy';
```

- [ ] **Step 6: Update `src/web/routes/session-routes.ts` — `POST /api/quick-start`**

6a. Extend `canStripDisk` (same guard pattern as Step 5a but in the quick-start handler):

Find (second occurrence, in quick-start):
```typescript
      mode !== 'gemini' &&
```
Replace with:
```typescript
      mode !== 'gemini' &&
      mode !== 'agy' &&
```

6b. Add agy availability check (same pattern as Step 5b):

Find (second occurrence in quick-start):
```typescript
    // Check Gemini availability if requested
    if (mode === 'gemini') {
      const { isGeminiAvailable } = await import('../../utils/gemini-cli-resolver.js');
      if (!isGeminiAvailable()) {
        return createErrorResponse(
          ApiErrorCode.OPERATION_FAILED,
          'Gemini CLI not found. Install with: npm install -g @google/gemini-cli'
        );
      }
    }
```
Replace with:
```typescript
    // Check Gemini availability if requested
    if (mode === 'gemini') {
      const { isGeminiAvailable } = await import('../../utils/gemini-cli-resolver.js');
      if (!isGeminiAvailable()) {
        return createErrorResponse(
          ApiErrorCode.OPERATION_FAILED,
          'Gemini CLI not found. Install with: npm install -g @google/gemini-cli'
        );
      }
    }

    // Check Agy availability if requested
    if (mode === 'agy') {
      const { isAgyAvailable } = await import('../../utils/agy-cli-resolver.js');
      if (!isAgyAvailable()) {
        return createErrorResponse(
          ApiErrorCode.OPERATION_FAILED,
          'Agy CLI not found.'
        );
      }
    }
```

6c. Destructure `agyConfig` from `parseBody`:

Find (in quick-start body):
```typescript
      geminiConfig,
      envOverrides,
```
Replace with:
```typescript
      agyConfig,
      geminiConfig,
      envOverrides,
```

6d. Extend model extraction chain (same as Step 5c but in quick-start):

Find (in quick-start):
```typescript
    const qsModel =
      mode === 'opencode'
        ? openCodeConfig?.model
        : mode === 'codex'
          ? codexConfig?.model
          : mode === 'gemini'
            ? geminiConfig?.model
            : mode !== 'shell'
              ? qsModelConfig?.defaultModel || undefined
              : undefined;
```
Replace with:
```typescript
    const qsModel =
      mode === 'opencode'
        ? openCodeConfig?.model
        : mode === 'codex'
          ? codexConfig?.model
          : mode === 'gemini'
            ? geminiConfig?.model
            : mode === 'agy'
              ? agyConfig?.model
              : mode !== 'shell'
                ? qsModelConfig?.defaultModel || undefined
                : undefined;
```

6e. Add `agyConfig` to the `new Session(...)` call in quick-start:

Find:
```typescript
      geminiConfig: mode === 'gemini' ? geminiConfig : undefined,
```
Replace with:
```typescript
      agyConfig: mode === 'agy' ? agyConfig : undefined,
      geminiConfig: mode === 'gemini' ? geminiConfig : undefined,
```

- [ ] **Step 7: Extend no-respawn guards in Claude-specific inline session update**

Find (around line 1686):
```typescript
        if (mode !== 'opencode' && mode !== 'codex' && mode !== 'gemini') {
```
Replace with:
```typescript
        if (mode !== 'opencode' && mode !== 'codex' && mode !== 'gemini' && mode !== 'agy') {
```

Find (around line 1706):
```typescript
      mode !== 'gemini' &&
```
(In the inline-session respawn guard) — replace with:
```typescript
      mode !== 'gemini' &&
      mode !== 'agy' &&
```

Find (around line 1723):
```typescript
          : mode === 'gemini'
            ? geminiConfig?.model
```
(In the model extraction for respawn-in-session) — replace with:
```typescript
          : mode === 'gemini'
            ? geminiConfig?.model
            : mode === 'agy'
              ? agyConfig?.model
```

Find (around line 1742):
```typescript
      geminiConfig: mode === 'gemini' ? geminiConfig : undefined,
```
(In the inline-session new Session call) — replace with:
```typescript
      agyConfig: mode === 'agy' ? agyConfig : undefined,
      geminiConfig: mode === 'gemini' ? geminiConfig : undefined,
```

Make sure `agyConfig` is also destructured from the inline-session `parseBody` call (same pattern as Step 6c).

- [ ] **Step 8: Update `src/web/routes/respawn-routes.ts`**

There are three guards:

Find (each occurrence):
```typescript
    if (session.mode === 'opencode' || session.mode === 'codex' || session.mode === 'gemini') {
```
Replace each with:
```typescript
    if (session.mode === 'opencode' || session.mode === 'codex' || session.mode === 'gemini' || session.mode === 'agy') {
```

- [ ] **Step 9: Typecheck**

```bash
tsc --noEmit 2>&1 | head -30
```

Expected: 0 new errors.

- [ ] **Step 10: Commit**

```bash
cd /home/aakht/.codeman/app
git add src/web/routes/session-routes.ts src/web/routes/system-routes.ts src/web/routes/respawn-routes.ts test/routes/system-routes.test.ts
git commit -m "COD-195 feat: add agy route handlers and status endpoint"
```

---

### Task 7: Frontend — `app.js`

**Files:**
- Modify: `src/web/public/app.js`

**Interfaces:**
- No TypeScript interfaces — plain JS frontend
- Produces: `ag` tab badge for agy sessions; kill label "Kill Tmux & Agy"; alt-screen and isExternalCli guards include agy

- [ ] **Step 1: Add the `ag` tab badge**

Find:
```javascript
${mode === 'shell' ? '<span class="tab-mode shell" aria-hidden="true">sh</span>' : mode === 'opencode' ? '<span class="tab-mode opencode" aria-hidden="true">oc</span>' : mode === 'codex' ? '<span class="tab-mode codex" aria-hidden="true">cx</span>' : mode === 'gemini' ? '<span class="tab-mode gemini" aria-hidden="true">gm</span>' : ''}
```
Replace with:
```javascript
${mode === 'shell' ? '<span class="tab-mode shell" aria-hidden="true">sh</span>' : mode === 'opencode' ? '<span class="tab-mode opencode" aria-hidden="true">oc</span>' : mode === 'codex' ? '<span class="tab-mode codex" aria-hidden="true">cx</span>' : mode === 'gemini' ? '<span class="tab-mode gemini" aria-hidden="true">gm</span>' : mode === 'agy' ? '<span class="tab-mode agy" aria-hidden="true">ag</span>' : ''}
```

- [ ] **Step 2: Extend the kill button label**

Find:
```javascript
      killTitle.textContent = session.mode === 'opencode'
        ? 'Kill Tmux & OpenCode'
        : session.mode === 'codex'
          ? 'Kill Tmux & Codex'
          : session.mode === 'gemini'
            ? 'Kill Tmux & Gemini'
            : 'Kill Tmux & Claude Code';
```
Replace with:
```javascript
      killTitle.textContent = session.mode === 'opencode'
        ? 'Kill Tmux & OpenCode'
        : session.mode === 'codex'
          ? 'Kill Tmux & Codex'
          : session.mode === 'gemini'
            ? 'Kill Tmux & Gemini'
            : session.mode === 'agy'
              ? 'Kill Tmux & Agy'
              : 'Kill Tmux & Claude Code';
```

- [ ] **Step 3: Extend alt-screen / codex-gemini checks**

Find (COD-179 resize handler):
```javascript
    if (session?.mode !== 'codex' && session?.mode !== 'gemini') return;
```
Replace with:
```javascript
    if (session?.mode !== 'codex' && session?.mode !== 'gemini' && session?.mode !== 'agy') return;
```

Find (COD-182 stale rows check):
```javascript
    return session?.mode === 'codex' || session?.mode === 'gemini';
```
Replace with:
```javascript
    return session?.mode === 'codex' || session?.mode === 'gemini' || session?.mode === 'agy';
```

Find (COD-180 remote reconcile check):
```javascript
    return mode === 'codex' || mode === 'gemini' || mode === 'claude';
```
Replace with:
```javascript
    return mode === 'codex' || mode === 'gemini' || mode === 'agy' || mode === 'claude';
```

Find the scrollback/Codex-gemini tabs comment line:
```javascript
    // Codex/gemini tabs render only the current screen (scrollback 0); scroll-up
```
(This is a comment — no code change needed here, just context.)

Find (line ~2125 claude-only guard):
```javascript
      activeSession?.mode === 'claude'
```
(This is checking for Claude-only tab — no change needed as agy is external CLI.)

Find (line ~2245 alt-screen strip mode check in app.js):
```javascript
    return mode === 'codex' || mode === 'gemini' || mode === 'claude';
```
This was already updated in step 3c above; ensure only one occurrence needs updating.

- [ ] **Step 4: Verify JS syntax**

```bash
cd /home/aakht/.codeman/app
npm run check:frontend-syntax 2>&1 | head -20
```

Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
cd /home/aakht/.codeman/app
git add src/web/public/app.js
git commit -m "COD-195 feat: add agy tab badge and kill label to app.js"
```

---

### Task 8: Frontend — `session-ui.js`

**Files:**
- Modify: `src/web/public/session-ui.js`

**Interfaces:**
- No TypeScript interfaces — plain JS frontend
- Produces: `runAgy()` method; `Run AG` button label; agy included in `isAltMode` and `isExternalCli` checks; mode normalization includes agy

- [ ] **Step 1: Add `runAgy()` dispatch in `run()` method**

Find:
```javascript
    if (mode === 'gemini') {
      return this.runGemini();
    }
    return this.runClaude();
```
Replace with:
```javascript
    if (mode === 'gemini') {
      return this.runGemini();
    }
    if (mode === 'agy') {
      return this.runAgy();
    }
    return this.runClaude();
```

- [ ] **Step 2: Extend the `Run AG` button label**

Find:
```javascript
      label.textContent = mode === 'opencode' ? 'Run OC' : mode === 'codex' ? 'Run CX' : mode === 'gemini' ? 'Run GM' : 'Run';
```
Replace with:
```javascript
      label.textContent = mode === 'opencode' ? 'Run OC' : mode === 'codex' ? 'Run CX' : mode === 'gemini' ? 'Run GM' : mode === 'agy' ? 'Run AG' : 'Run';
```

- [ ] **Step 3: Add `runAgy()` method**

Immediately after the closing of the last `runGemini()` method (the second definition at line ~920), add:

```javascript
  async runAgy() {
    const caseName = document.getElementById('quickStartCase').value || 'testcase';

    this.terminal.clear();
    this.terminal.writeln(`\x1b[1;32m Starting Agy session in ${caseName}...\x1b[0m`);
    this.terminal.writeln('');
    this.terminal.focus();

    try {
      const statusRes = await fetch('/api/agy/status');
      const status = (await statusRes.json()).data;
      if (!status.available) {
        this.terminal.writeln('\x1b[1;31m Agy CLI not found.\x1b[0m');
        this.terminal.writeln('\x1b[90m Install from antigravity.\x1b[0m');
        return;
      }

      const envOverrides = this.buildEnvOverrides(this.getCaseSettings(caseName), this.loadAppSettingsFromStorage());
      const res = await fetch('/api/quick-start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caseName,
          mode: 'agy',
          ...(Object.keys(envOverrides).length > 0 ? { envOverrides } : {}),
        })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Failed to start Agy');

      if (data.data.sessionId) {
        await this.selectSession(data.data.sessionId);
      }

      this.terminal.focus();
    } catch (err) {
      this.terminal.writeln(`\x1b[1;31m Error: ${err.message}\x1b[0m`);
    }
  },
```

- [ ] **Step 4: Extend `isAltMode` check**

Find:
```javascript
    const isAltMode = session.mode === 'opencode' || session.mode === 'codex' || session.mode === 'gemini';
```
Replace with:
```javascript
    const isAltMode = session.mode === 'opencode' || session.mode === 'codex' || session.mode === 'gemini' || session.mode === 'agy';
```

- [ ] **Step 5: Extend `isExternalCli` check**

Find:
```javascript
    const isExternalCli = session.mode === 'opencode' || session.mode === 'codex' || session.mode === 'gemini';
```
Replace with:
```javascript
    const isExternalCli = session.mode === 'opencode' || session.mode === 'codex' || session.mode === 'gemini' || session.mode === 'agy';
```

- [ ] **Step 6: Extend mode normalization**

Find:
```javascript
      mode === 'opencode' || mode === 'codex' || mode === 'gemini' || mode === 'claude' ? mode : 'claude';
```
Replace with:
```javascript
      mode === 'opencode' || mode === 'codex' || mode === 'gemini' || mode === 'agy' || mode === 'claude' ? mode : 'claude';
```

- [ ] **Step 7: Check frontend JS syntax**

```bash
npm run check:frontend-syntax 2>&1 | head -20
```

Expected: 0 errors.

- [ ] **Step 8: Commit**

```bash
cd /home/aakht/.codeman/app
git add src/web/public/session-ui.js
git commit -m "COD-195 feat: add runAgy() and agy mode checks to session-ui.js"
```

---

### Task 9: Final verification

**Files:** none new — verification only

- [ ] **Step 1: Run typecheck**

```bash
tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 2: Run lint**

```bash
npm run lint 2>&1 | head -30
```

Expected: 0 new warnings or errors.

- [ ] **Step 3: Run all new test files**

```bash
npm test -- test/agy-cli-resolver.test.ts
npm test -- test/agy-mode.test.ts
npm test -- test/routes/system-routes.test.ts
```

Expected: all pass.

- [ ] **Step 4: Run existing related tests**

```bash
npm test -- test/gemini-mode.test.ts
npm test -- test/tmux-manager.test.ts
npm test -- test/session.test.ts
npm test -- test/routes/session-routes.test.ts
npm test -- test/routes/respawn-routes.test.ts
```

Expected: all pass (no regressions).

- [ ] **Step 5: Run CI suite**

```bash
npm run test:ci 2>&1 | tail -20
```

Expected: all pass.

- [ ] **Step 6: Final commit (if any stray files)**

```bash
cd /home/aakht/.codeman/app
git status
```

If clean, no commit needed. If any file was missed, stage and commit.
