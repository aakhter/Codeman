# `codeman doctor` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `codeman doctor` CLI command (alias `check-deps`) that probes the host for the tools Codeman and its skills depend on and prints an environment-aware (incl. WSL) readiness report.

**Architecture:** A static registry (`config/dependency-registry.ts`) describes each tool and its per-environment resolvers. A pure probe engine (`utils/dependency-checker.ts`) runs against an injectable `ProbeHost` seam (real impl uses `execSync`/`existsSync`; tests inject fakes). A formatter (`utils/dependency-report.ts`) renders the table/JSON and computes the exit code. `cli.ts` is thin glue.

**Tech Stack:** TypeScript ESM (NodeNext), commander, chalk, vitest. Spec: `docs/superpowers/specs/2026-06-08-cod-45-codeman-doctor-design.md`.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/config/dependency-registry.ts` (create) | Shared types (`ProbeEnvironment`, `ToolCategory`, `ResolverSpec`, `ToolDependency`) + `DEPENDENCY_REGISTRY` seed data. No logic. |
| `src/utils/dependency-checker.ts` (create) | `ProbeHost` interface, `detectEnvironment`, `extractVersion`, `compareVersions`, `checkTool`, `checkAll`, `createRealHost`. |
| `src/utils/dependency-report.ts` (create) | `renderTable`, `renderJson`, `computeExitCode`. Plain text (no color) for stable tests. |
| `src/utils/index.ts` (modify) | Barrel re-exports for the two new util modules. |
| `src/cli.ts` (modify) | Register the `doctor` command before `export { program }`. |
| `test/dependency-checker.test.ts` (create) | Unit tests for detection, version helpers, and `checkTool`/`checkAll` via a fake `ProbeHost`. |
| `test/dependency-report.test.ts` (create) | Unit tests for table/JSON rendering and exit code. |

All tests are pure (no tmux, no real subprocess) — CI-safe.

---

## Task 1: Registry types and seed data

**Files:**
- Create: `src/config/dependency-registry.ts`
- Test: `test/dependency-checker.test.ts` (registry-invariants block)

- [ ] **Step 1: Write the failing test**

Create `test/dependency-checker.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { DEPENDENCY_REGISTRY } from '../src/config/dependency-registry.js';

describe('DEPENDENCY_REGISTRY', () => {
  it('has unique ids', () => {
    const ids = DEPENDENCY_REGISTRY.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('marks core tools required and skill tools optional', () => {
    const core = DEPENDENCY_REGISTRY.filter((t) => t.category === 'core');
    expect(core.length).toBeGreaterThan(0);
    expect(core.every((t) => t.required)).toBe(true);
    const office = DEPENDENCY_REGISTRY.filter((t) => t.category === 'office');
    expect(office.every((t) => t.required === false)).toBe(true);
  });

  it('gives msoffice a windows-side resolver scoped to wsl + win32 only', () => {
    const ms = DEPENDENCY_REGISTRY.find((t) => t.id === 'msoffice');
    expect(ms).toBeDefined();
    const spec = ms!.resolvers.find((r) => r.resolver.kind === 'windows-side');
    expect(spec).toBeDefined();
    expect(spec!.match.sort()).toEqual(['win32', 'wsl']);
    // no resolver applies on plain linux -> tool will be reported 'skipped' there
    expect(ms!.resolvers.some((r) => r.match.includes('linux'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/dependency-checker.test.ts`
Expected: FAIL — cannot resolve `../src/config/dependency-registry.js`.

- [ ] **Step 3: Write the registry**

Create `src/config/dependency-registry.ts`:

```ts
/**
 * @fileoverview Static registry of downstream tool dependencies probed by
 * `codeman doctor`. Each entry declares per-environment resolvers and the
 * skills that use it. EXTENSION POINT: skill-manifest-driven discovery
 * (COD follow-up) will merge dynamically-found entries into this list.
 *
 * @module config/dependency-registry
 */

export type ProbeEnvironment = 'linux' | 'darwin' | 'win32' | 'wsl';
export type ToolCategory = 'core' | 'office' | 'documents' | 'media' | 'other';

/** Resolve a binary on the PATH and read its version. */
export interface PathResolver {
  kind: 'path';
  bins: string[];
  versionArg?: string; // default '--version'
  versionRegex?: RegExp; // default matches first \d+.\d+(.\d+)?
}

/** Resolve a Windows-installed app reachable from win32 or WSL. */
export interface WindowsSideResolver {
  kind: 'windows-side';
  appDirs: string[]; // relative to a Program Files root
  exes: string[]; // candidate executables; first found wins
}

export interface ResolverSpec {
  match: ProbeEnvironment[];
  resolver: PathResolver | WindowsSideResolver;
}

export interface ToolDependency {
  id: string;
  label: string;
  category: ToolCategory;
  required: boolean;
  usedBy?: string[];
  minVersion?: string;
  resolvers: ResolverSpec[];
  installHint?: Partial<Record<ProbeEnvironment, string>>;
}

const ALL: ProbeEnvironment[] = ['linux', 'darwin', 'wsl', 'win32'];

export const DEPENDENCY_REGISTRY: ToolDependency[] = [
  {
    id: 'node',
    label: 'Node.js',
    category: 'core',
    required: true,
    minVersion: '18.0.0',
    resolvers: [{ match: ALL, resolver: { kind: 'path', bins: ['node'], versionArg: '--version' } }],
    installHint: { linux: 'https://nodejs.org', darwin: 'brew install node', wsl: 'https://nodejs.org' },
  },
  {
    id: 'claude',
    label: 'Claude CLI',
    category: 'core',
    required: true,
    resolvers: [{ match: ALL, resolver: { kind: 'path', bins: ['claude'], versionArg: '--version' } }],
    installHint: { linux: 'https://docs.claude.com/claude-code', darwin: 'https://docs.claude.com/claude-code' },
  },
  {
    id: 'tmux',
    label: 'tmux',
    category: 'core',
    required: true,
    resolvers: [{ match: ['linux', 'darwin', 'wsl'], resolver: { kind: 'path', bins: ['tmux'], versionArg: '-V' } }],
    installHint: { linux: 'sudo apt install tmux', darwin: 'brew install tmux', wsl: 'sudo apt install tmux' },
  },
  {
    id: 'opencode',
    label: 'OpenCode CLI',
    category: 'core',
    required: false,
    usedBy: ['OpenCode sessions'],
    resolvers: [{ match: ALL, resolver: { kind: 'path', bins: ['opencode'], versionArg: '--version' } }],
  },
  {
    id: 'libreoffice',
    label: 'LibreOffice',
    category: 'office',
    required: false,
    usedBy: ['slides', 'spreadsheet', 'docx'],
    resolvers: [
      { match: ['linux', 'darwin', 'wsl'], resolver: { kind: 'path', bins: ['libreoffice', 'soffice'], versionArg: '--version' } },
    ],
    installHint: { linux: 'sudo apt install libreoffice', darwin: 'brew install --cask libreoffice' },
  },
  {
    id: 'msoffice',
    label: 'MS Office',
    category: 'office',
    required: false,
    usedBy: ['slides', 'spreadsheet', 'docx'],
    resolvers: [
      {
        match: ['wsl', 'win32'],
        resolver: {
          kind: 'windows-side',
          appDirs: ['Microsoft Office/root/Office16'],
          exes: ['WINWORD.EXE', 'POWERPNT.EXE', 'EXCEL.EXE'],
        },
      },
    ],
  },
  {
    id: 'pandoc',
    label: 'Pandoc',
    category: 'documents',
    required: false,
    usedBy: ['cisco-pandoc-docx'],
    resolvers: [{ match: ALL, resolver: { kind: 'path', bins: ['pandoc'], versionArg: '--version' } }],
    installHint: { linux: 'sudo apt install pandoc', darwin: 'brew install pandoc' },
  },
  {
    id: 'ffmpeg',
    label: 'FFmpeg',
    category: 'media',
    required: false,
    usedBy: ['video-transcribe-docx'],
    resolvers: [{ match: ALL, resolver: { kind: 'path', bins: ['ffmpeg'], versionArg: '-version' } }],
    installHint: { linux: 'sudo apt install ffmpeg', darwin: 'brew install ffmpeg' },
  },
  {
    id: 'imagemagick',
    label: 'ImageMagick',
    category: 'media',
    required: false,
    usedBy: ['image-input'],
    resolvers: [{ match: ALL, resolver: { kind: 'path', bins: ['magick', 'convert'], versionArg: '--version' } }],
    installHint: { linux: 'sudo apt install imagemagick', darwin: 'brew install imagemagick' },
  },
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/dependency-checker.test.ts`
Expected: PASS (3 tests in the `DEPENDENCY_REGISTRY` block).

- [ ] **Step 5: Commit**

```bash
git add src/config/dependency-registry.ts test/dependency-checker.test.ts
git commit -m "feat: COD-45 add dependency registry types and seed data"
```

---

## Task 2: Environment detection

**Files:**
- Create: `src/utils/dependency-checker.ts`
- Test: `test/dependency-checker.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `test/dependency-checker.test.ts`:

```ts
import { detectEnvironment } from '../src/utils/dependency-checker.js';

describe('detectEnvironment', () => {
  it('returns win32/darwin straight from platform', () => {
    expect(detectEnvironment({ platform: 'win32', procVersion: '', hasWindowsInterop: false })).toBe('win32');
    expect(detectEnvironment({ platform: 'darwin', procVersion: '', hasWindowsInterop: false })).toBe('darwin');
  });

  it('detects wsl from /proc/version + interop, else linux', () => {
    const wsl = detectEnvironment({
      platform: 'linux',
      procVersion: 'Linux version 6.6 (Microsoft@WSL2)',
      hasWindowsInterop: true,
    });
    expect(wsl).toBe('wsl');
    expect(detectEnvironment({ platform: 'linux', procVersion: 'Microsoft', hasWindowsInterop: false })).toBe('linux');
    expect(detectEnvironment({ platform: 'linux', procVersion: 'generic', hasWindowsInterop: true })).toBe('linux');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/dependency-checker.test.ts`
Expected: FAIL — cannot resolve `../src/utils/dependency-checker.js`.

- [ ] **Step 3: Write the module skeleton + detectEnvironment**

Create `src/utils/dependency-checker.ts`:

```ts
/**
 * @fileoverview Probe engine for `codeman doctor`. Resolves each registry tool
 * against an injectable ProbeHost (real impl uses child_process/fs; tests inject
 * fakes) and returns structured results. Pure given the host — no global I/O.
 *
 * @module utils/dependency-checker
 */

import type { ProbeEnvironment, ToolCategory, ToolDependency } from '../config/dependency-registry.js';

export interface EnvDetectionInputs {
  platform: NodeJS.Platform;
  procVersion: string;
  hasWindowsInterop: boolean;
}

export function detectEnvironment(inputs: EnvDetectionInputs): ProbeEnvironment {
  if (inputs.platform === 'win32') return 'win32';
  if (inputs.platform === 'darwin') return 'darwin';
  const isWsl = /microsoft|wsl/i.test(inputs.procVersion) && inputs.hasWindowsInterop;
  return isWsl ? 'wsl' : 'linux';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/dependency-checker.test.ts`
Expected: PASS (registry + detectEnvironment blocks).

- [ ] **Step 5: Commit**

```bash
git add src/utils/dependency-checker.ts test/dependency-checker.test.ts
git commit -m "feat: COD-45 add environment detection (incl. WSL)"
```

---

## Task 3: Version helpers

**Files:**
- Modify: `src/utils/dependency-checker.ts`
- Test: `test/dependency-checker.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `test/dependency-checker.test.ts`:

```ts
import { extractVersion, compareVersions } from '../src/utils/dependency-checker.js';

describe('extractVersion', () => {
  it('pulls a dotted version from typical --version output', () => {
    expect(extractVersion('v22.22.1')).toBe('22.22.1');
    expect(extractVersion('tmux 3.4')).toBe('3.4');
    expect(extractVersion('no digits here')).toBeUndefined();
  });
  it('honors a custom regex', () => {
    expect(extractVersion('ProductVersion 16.0.19929.20172', /(\d+\.\d+\.\d+)/)).toBe('16.0.19929');
  });
});

describe('compareVersions', () => {
  it('orders by numeric components', () => {
    expect(compareVersions('18.0.0', '18.0.0')).toBe(0);
    expect(compareVersions('16.5.0', '18.0.0')).toBe(-1);
    expect(compareVersions('22.22.1', '18.0.0')).toBe(1);
    expect(compareVersions('3.4', '3.4.0')).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/dependency-checker.test.ts`
Expected: FAIL — `extractVersion`/`compareVersions` not exported.

- [ ] **Step 3: Add the helpers**

Append to `src/utils/dependency-checker.ts`:

```ts
const DEFAULT_VERSION_RE = /(\d+\.\d+(?:\.\d+)?)/;

export function extractVersion(text: string, re?: RegExp): string | undefined {
  const m = (re ?? DEFAULT_VERSION_RE).exec(text);
  return m ? m[1] : undefined;
}

/** Returns -1 if a < b, 0 if equal, 1 if a > b (numeric, component-wise). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
```

> Note: registry `versionRegex` values must be NON-global (no `/g`) — these are passed straight to `.exec()` and a `g` flag would carry `lastIndex` (see CLAUDE.md "Global regex lastIndex" gotcha).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/dependency-checker.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/utils/dependency-checker.ts test/dependency-checker.test.ts
git commit -m "feat: COD-45 add version extract/compare helpers"
```

---

## Task 4: ProbeHost + checkTool/checkAll

**Files:**
- Modify: `src/utils/dependency-checker.ts`
- Test: `test/dependency-checker.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `test/dependency-checker.test.ts`:

```ts
import { checkTool, checkAll } from '../src/utils/dependency-checker.js';
import type { ProbeHost } from '../src/utils/dependency-checker.js';
import type { ProbeEnvironment, ToolDependency } from '../src/config/dependency-registry.js';

function fakeHost(env: ProbeEnvironment, over: Partial<ProbeHost> = {}): ProbeHost {
  return {
    environment: env,
    which: () => null,
    fileExists: () => false,
    runVersion: () => null,
    windowsProgramRoots: () => [],
    windowsFileVersion: () => null,
    ...over,
  };
}

const tmuxTool: ToolDependency = {
  id: 'tmux', label: 'tmux', category: 'core', required: true,
  resolvers: [{ match: ['linux', 'wsl'], resolver: { kind: 'path', bins: ['tmux'], versionArg: '-V' } }],
};
const nodeTool: ToolDependency = {
  id: 'node', label: 'Node.js', category: 'core', required: true, minVersion: '18.0.0',
  resolvers: [{ match: ['linux'], resolver: { kind: 'path', bins: ['node'] } }],
};
const msTool: ToolDependency = {
  id: 'msoffice', label: 'MS Office', category: 'office', required: false,
  resolvers: [{ match: ['wsl', 'win32'], resolver: { kind: 'windows-side', appDirs: ['Microsoft Office/root/Office16'], exes: ['WINWORD.EXE'] } }],
};

describe('checkTool', () => {
  it('reports ok with path + version when found on PATH', () => {
    const host = fakeHost('linux', { which: (b) => (b === 'tmux' ? '/usr/bin/tmux' : null), runVersion: () => 'tmux 3.4' });
    expect(checkTool(tmuxTool, host)).toMatchObject({ id: 'tmux', status: 'ok', version: '3.4', path: '/usr/bin/tmux' });
  });

  it('reports missing when no bin resolves', () => {
    expect(checkTool(tmuxTool, fakeHost('linux'))).toMatchObject({ id: 'tmux', status: 'missing' });
  });

  it('reports outdated when below minVersion', () => {
    const host = fakeHost('linux', { which: () => '/n', runVersion: () => 'v16.5.0' });
    expect(checkTool(nodeTool, host)).toMatchObject({ id: 'node', status: 'outdated', version: '16.5.0' });
  });

  it('reports error when minVersion set but version unparseable', () => {
    const host = fakeHost('linux', { which: () => '/n', runVersion: () => 'unknown' });
    expect(checkTool(nodeTool, host)).toMatchObject({ id: 'node', status: 'error' });
  });

  it('reports skipped when no resolver matches the environment', () => {
    expect(checkTool(msTool, fakeHost('linux'))).toMatchObject({ id: 'msoffice', status: 'skipped' });
  });

  it('finds windows-side apps under WSL', () => {
    const host = fakeHost('wsl', {
      windowsProgramRoots: () => ['/mnt/c/Program Files'],
      fileExists: (p) => p === '/mnt/c/Program Files/Microsoft Office/root/Office16/WINWORD.EXE',
      windowsFileVersion: () => '16.0.19929.20172',
    });
    expect(checkTool(msTool, host)).toMatchObject({
      id: 'msoffice', status: 'ok', version: '16.0.19929', path: '/mnt/c/Program Files/Microsoft Office/root/Office16/WINWORD.EXE',
    });
  });
});

describe('checkAll', () => {
  it('maps every tool to a result', () => {
    const results = checkAll([tmuxTool, msTool], fakeHost('linux'));
    expect(results.map((r) => r.id)).toEqual(['tmux', 'msoffice']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/dependency-checker.test.ts`
Expected: FAIL — `checkTool`/`checkAll`/`ProbeHost` not exported.

- [ ] **Step 3: Implement ProbeHost + checkTool/checkAll**

Append to `src/utils/dependency-checker.ts`:

```ts
export type ToolStatus = 'ok' | 'missing' | 'outdated' | 'skipped' | 'error';

export interface ToolResult {
  id: string;
  label: string;
  category: ToolCategory;
  required: boolean;
  usedBy: string[];
  status: ToolStatus;
  version?: string;
  path?: string;
  installHint?: string;
  reason?: string;
}

export interface ProbeHost {
  environment: ProbeEnvironment;
  which(bin: string): string | null;
  fileExists(path: string): boolean;
  runVersion(bin: string, args: string[]): string | null;
  windowsProgramRoots(): string[];
  windowsFileVersion(winPath: string): string | null;
}

function finalize(
  base: Pick<ToolResult, 'id' | 'label' | 'category' | 'required' | 'usedBy'>,
  tool: ToolDependency,
  path: string,
  version: string | undefined
): ToolResult {
  if (tool.minVersion) {
    if (!version) return { ...base, status: 'error', path, reason: 'version required but could not be parsed' };
    if (compareVersions(version, tool.minVersion) < 0) return { ...base, status: 'outdated', path, version };
  }
  return { ...base, status: 'ok', path, version };
}

export function checkTool(tool: ToolDependency, host: ProbeHost): ToolResult {
  const base = {
    id: tool.id,
    label: tool.label,
    category: tool.category,
    required: tool.required,
    usedBy: tool.usedBy ?? [],
  };
  const installHint = tool.installHint?.[host.environment];

  const spec = tool.resolvers.find((r) => r.match.includes(host.environment));
  if (!spec) return { ...base, status: 'skipped', reason: `not applicable on ${host.environment}` };

  if (spec.resolver.kind === 'path') {
    const { bins, versionArg, versionRegex } = spec.resolver;
    for (const bin of bins) {
      const resolved = host.which(bin);
      if (resolved) {
        const out = host.runVersion(bin, [versionArg ?? '--version']);
        const version = out ? extractVersion(out, versionRegex) : undefined;
        return finalize(base, tool, resolved, version);
      }
    }
    return { ...base, status: 'missing', installHint };
  }

  // windows-side
  const { appDirs, exes } = spec.resolver;
  for (const root of host.windowsProgramRoots()) {
    for (const dir of appDirs) {
      for (const exe of exes) {
        const winPath = `${root}/${dir}/${exe}`;
        if (host.fileExists(winPath)) {
          const version = host.windowsFileVersion(winPath) ?? undefined;
          return finalize(base, tool, winPath, version);
        }
      }
    }
  }
  return { ...base, status: 'missing', installHint };
}

export function checkAll(registry: ToolDependency[], host: ProbeHost): ToolResult[] {
  return registry.map((tool) => checkTool(tool, host));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/dependency-checker.test.ts`
Expected: PASS (all blocks).

- [ ] **Step 5: Commit**

```bash
git add src/utils/dependency-checker.ts test/dependency-checker.test.ts
git commit -m "feat: COD-45 add ProbeHost seam and checkTool/checkAll"
```

---

## Task 5: Report formatter + exit code

**Files:**
- Create: `src/utils/dependency-report.ts`
- Test: `test/dependency-report.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/dependency-report.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { renderTable, renderJson, computeExitCode } from '../src/utils/dependency-report.js';
import type { ToolResult } from '../src/utils/dependency-checker.js';

const results: ToolResult[] = [
  { id: 'node', label: 'Node.js', category: 'core', required: true, usedBy: [], status: 'ok', version: '22.22.1', path: '/n' },
  { id: 'tmux', label: 'tmux', category: 'core', required: true, usedBy: [], status: 'missing', installHint: 'sudo apt install tmux' },
  { id: 'ffmpeg', label: 'FFmpeg', category: 'media', required: false, usedBy: ['video-transcribe-docx'], status: 'missing' },
  { id: 'msoffice', label: 'MS Office', category: 'office', required: false, usedBy: ['docx'], status: 'skipped', reason: 'not applicable on linux' },
];

describe('computeExitCode', () => {
  it('non-zero when a required tool is missing/outdated/error', () => {
    expect(computeExitCode(results)).toBe(1);
  });
  it('zero when only optional tools are missing', () => {
    const ok = results.filter((r) => r.id !== 'tmux');
    expect(computeExitCode(ok)).toBe(0);
  });
});

describe('renderTable', () => {
  it('groups by category and shows status, version, and install hints', () => {
    const out = renderTable(results, 'linux');
    expect(out).toContain('CORE');
    expect(out).toContain('node');
    expect(out).toContain('22.22.1');
    expect(out).toContain('MEDIA');
    expect(out).toContain('video-transcribe-docx');
    expect(out).toContain('sudo apt install tmux');
  });
});

describe('renderJson', () => {
  it('includes environment, summary, and per-tool data', () => {
    const json = renderJson(results, 'linux');
    expect(json.platform.environment).toBe('linux');
    expect(json.summary.exitCode).toBe(1);
    expect(json.summary.ok).toBe(1);
    expect(json.tools).toHaveLength(4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/dependency-report.test.ts`
Expected: FAIL — cannot resolve `../src/utils/dependency-report.js`.

- [ ] **Step 3: Implement the formatter**

Create `src/utils/dependency-report.ts`:

```ts
/**
 * @fileoverview Renders ToolResult[] from the dependency checker into a
 * human-readable grouped table or JSON, and computes the process exit code.
 * Plain text only (no color) so output is stable and snapshot-friendly; the
 * CLI layer may colorize.
 *
 * @module utils/dependency-report
 */

import type { ProbeEnvironment, ToolCategory } from '../config/dependency-registry.js';
import type { ToolResult, ToolStatus } from './dependency-checker.js';

const CATEGORY_ORDER: ToolCategory[] = ['core', 'office', 'documents', 'media', 'other'];

function glyph(r: ToolResult): string {
  if (r.status === 'ok') return '✓'; // ✓
  if (r.status === 'skipped') return '○'; // ○
  return r.required ? '✗' : '○'; // ✗ for required gaps, ○ otherwise
}

function statusText(r: ToolResult): string {
  if (r.status === 'ok') return r.version ?? 'installed';
  if (r.status === 'outdated') return `${r.version ?? '?'} (below minimum)`;
  if (r.status === 'skipped') return 'n/a';
  if (r.status === 'error') return 'version error';
  return 'not found';
}

export function computeExitCode(results: ToolResult[]): number {
  const failed = results.some(
    (r) => r.required && (r.status === 'missing' || r.status === 'outdated' || r.status === 'error')
  );
  return failed ? 1 : 0;
}

export function renderTable(results: ToolResult[], environment: ProbeEnvironment): string {
  const lines: string[] = [`Codeman dependency check — ${environment}`, ''];
  for (const category of CATEGORY_ORDER) {
    const rows = results.filter((r) => r.category === category);
    if (rows.length === 0) continue;
    lines.push(category.toUpperCase());
    for (const r of rows) {
      const detail = r.path ? `  ${r.path}` : '';
      lines.push(`  ${glyph(r)} ${r.label.padEnd(14)} ${statusText(r).padEnd(22)}${detail}`);
      if (r.usedBy.length) lines.push(`        used by: ${r.usedBy.join(', ')}`);
      if (r.installHint) lines.push(`        install: ${r.installHint}`);
    }
    lines.push('');
  }
  const ok = results.filter((r) => r.status === 'ok').length;
  const requiredMissing = results.filter(
    (r) => r.required && r.status !== 'ok' && r.status !== 'skipped'
  ).length;
  const optionalMissing = results.filter((r) => !r.required && r.status === 'missing').length;
  lines.push(`Summary: ${ok} ok · ${requiredMissing} required missing · ${optionalMissing} optional missing`);
  return lines.join('\n');
}

export interface DependencyReportJson {
  platform: { environment: ProbeEnvironment };
  summary: { ok: number; requiredMissing: number; optionalMissing: number; exitCode: number };
  tools: ToolResult[];
}

export function renderJson(results: ToolResult[], environment: ProbeEnvironment): DependencyReportJson {
  const byStatus = (s: ToolStatus) => results.filter((r) => r.status === s).length;
  return {
    platform: { environment },
    summary: {
      ok: byStatus('ok'),
      requiredMissing: results.filter((r) => r.required && r.status !== 'ok' && r.status !== 'skipped').length,
      optionalMissing: results.filter((r) => !r.required && r.status === 'missing').length,
      exitCode: computeExitCode(results),
    },
    tools: results,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/dependency-report.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/utils/dependency-report.ts test/dependency-report.test.ts
git commit -m "feat: COD-45 add dependency report renderer and exit code"
```

---

## Task 6: Real ProbeHost implementation

**Files:**
- Modify: `src/utils/dependency-checker.ts`
- Test: `test/dependency-checker.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `test/dependency-checker.test.ts`:

```ts
import { createRealHost } from '../src/utils/dependency-checker.js';

describe('createRealHost', () => {
  it('returns a host with a valid detected environment and callable methods', () => {
    const host = createRealHost();
    expect(['linux', 'darwin', 'win32', 'wsl']).toContain(host.environment);
    expect(typeof host.which).toBe('function');
    expect(Array.isArray(host.windowsProgramRoots())).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/dependency-checker.test.ts`
Expected: FAIL — `createRealHost` not exported.

- [ ] **Step 3: Implement createRealHost**

Append to `src/utils/dependency-checker.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { EXEC_TIMEOUT_MS } from '../config/exec-timeout.js';

function safeWhich(bin: string): string | null {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], {
      encoding: 'utf-8',
      timeout: EXEC_TIMEOUT_MS,
    }).trim();
    const first = out.split(/\r?\n/)[0]?.trim();
    return first && existsSync(first) ? first : null;
  } catch {
    return null;
  }
}

function safeRunVersion(bin: string, args: string[]): string | null {
  try {
    return execFileSync(bin, args, { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (err: unknown) {
    // Some tools (e.g. ffmpeg) exit non-zero on -version but still print to stdout
    const stdout = (err as { stdout?: Buffer | string })?.stdout;
    return stdout ? stdout.toString() : null;
  }
}

function readProcVersion(): string {
  try {
    return readFileSync('/proc/version', 'utf-8');
  } catch {
    return '';
  }
}

function listWindowsProgramRoots(): string[] {
  const roots: string[] = [];
  try {
    for (const entry of readdirSync('/mnt')) {
      for (const pf of ['Program Files', 'Program Files (x86)']) {
        const root = `/mnt/${entry}/${pf}`;
        if (existsSync(root)) roots.push(root);
      }
    }
  } catch {
    // /mnt absent (not WSL) -> no roots
  }
  return roots;
}

function readWindowsFileVersion(winPath: string): string | null {
  try {
    const windowsPath = execFileSync('wslpath', ['-w', winPath], { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS }).trim();
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', `(Get-Item '${windowsPath.replace(/'/g, "''")}').VersionInfo.ProductVersion`],
      { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS }
    ).trim();
    return out || null;
  } catch {
    return null;
  }
}

export function createRealHost(): ProbeHost {
  const environment = detectEnvironment({
    platform: process.platform,
    procVersion: readProcVersion(),
    hasWindowsInterop: safeWhich('cmd.exe') !== null || safeWhich('powershell.exe') !== null,
  });
  return {
    environment,
    which: safeWhich,
    fileExists: existsSync,
    runVersion: safeRunVersion,
    windowsProgramRoots: listWindowsProgramRoots,
    windowsFileVersion: readWindowsFileVersion,
  };
}
```

> Move the three `import` lines to the top of the file alongside the existing imports (ESM hoists imports, but keep them grouped for lint/readability).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/dependency-checker.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/utils/dependency-checker.ts test/dependency-checker.test.ts
git commit -m "feat: COD-45 add real ProbeHost (PATH + WSL windows-side)"
```

---

## Task 7: Wire the `doctor` CLI command

**Files:**
- Modify: `src/utils/index.ts`
- Modify: `src/cli.ts:577` (insert new command before `export { program }`)

- [ ] **Step 1: Add barrel exports**

In `src/utils/index.ts`, append after the existing resolver exports:

```ts
export { detectEnvironment, extractVersion, compareVersions, checkTool, checkAll, createRealHost } from './dependency-checker.js';
export type { ProbeHost, ToolResult, ToolStatus } from './dependency-checker.js';
export { renderTable, renderJson, computeExitCode } from './dependency-report.js';
export type { DependencyReportJson } from './dependency-report.js';
```

- [ ] **Step 2: Register the command**

In `src/cli.ts`, immediately before the final `export { program };` line, insert:

```ts
program
  .command('doctor')
  .alias('check-deps')
  .description('Check downstream tool dependencies (tmux, LibreOffice, MS Office, pandoc, ffmpeg, ...)')
  .option('--json', 'Output structured JSON instead of a table')
  .option('--category <name>', 'Only check one category (core|office|documents|media|other)')
  .action(async (options) => {
    const { createRealHost, checkAll } = await import('./utils/dependency-checker.js');
    const { renderTable, renderJson, computeExitCode } = await import('./utils/dependency-report.js');
    const { DEPENDENCY_REGISTRY } = await import('./config/dependency-registry.js');

    const host = createRealHost();
    const registry = options.category
      ? DEPENDENCY_REGISTRY.filter((t) => t.category === options.category)
      : DEPENDENCY_REGISTRY;
    const results = checkAll(registry, host);

    if (options.json) {
      console.log(JSON.stringify(renderJson(results, host.environment), null, 2));
    } else {
      console.log(renderTable(results, host.environment));
    }
    process.exit(computeExitCode(results));
  });
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Manual verification (real run on this host)**

Run: `npx tsx src/index.ts doctor`
Expected: a grouped report; on this WSL host `msoffice` shows `ok` with a `WINWORD.EXE` path and a `16.x` version, `tmux`/`node`/`claude`/`pandoc`/`libreoffice` show `ok`, `ffmpeg`/`imagemagick`/`opencode` show not-found. Exit code 0 (`echo $?`).

Run: `npx tsx src/index.ts doctor --json | jq .summary`
Expected: valid JSON with `environment: "wsl"` and `exitCode: 0`.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/utils/index.ts
git commit -m "feat: COD-45 wire codeman doctor command"
```

---

## Task 8: Final verification, docs, and Jira

**Files:**
- Modify: `app/CLAUDE.md` (Additional Commands table) and `app/AGENTS.md` (Build/Test/Dev commands) — document the new command.

- [ ] **Step 1: Run the full quality gate (CI-safe, no bare `npm test`)**

```bash
npm run typecheck
npm run lint
npm run format:check
npm test -- test/dependency-checker.test.ts
npm test -- test/dependency-report.test.ts
```
Expected: all pass. If `format:check` flags the new files, run `npm run format` and re-check.

- [ ] **Step 2: Document the command**

In `app/CLAUDE.md`, add a row to the "Additional Commands" table:

```
| Check tool deps | `npx tsx src/index.ts doctor` (`--json` for machine output) |
```

In `app/AGENTS.md`, add a bullet under "Build, Test, and Development Commands":

```
- `codeman doctor` (alias `check-deps`): report on downstream tool dependencies (tmux, LibreOffice, MS Office, pandoc, ffmpeg). `--json` for machine output; non-zero exit if a required dep is missing.
```

- [ ] **Step 3: Commit docs**

```bash
git add app/CLAUDE.md app/AGENTS.md
git commit -m "docs: COD-45 document codeman doctor command"
```

- [ ] **Step 4: Update Jira COD-45**

Per CLAUDE.md Jira/Git traceability: add a comment to COD-45 noting the implementation is complete, listing the new files (`dependency-registry.ts`, `dependency-checker.ts`, `dependency-report.ts`, cli wiring), the verification that passed (typecheck/lint/format + the two test files), and the latest commit hash. Then transition COD-45 to Done. (Use the `atlassian` MCP tools in a fresh session, or the REST API.)

---

## Self-Review Notes

- **Spec coverage:** command surface + alias (Task 7) · `--json`/`--category` (Task 7) · exit-code on core-required (Task 5) · registry shape + extension-point comment (Task 1) · environment-aware probes incl. WSL windows-side (Tasks 2/4/6) · status vocabulary ok|missing|outdated|skipped|error (Task 4) · module boundaries registry/checker/report/cli (all tasks) · WSL acceptance criterion (Task 4 windows-side test + Task 7 manual verify) · CI-safe tests, no tmux (all test tasks). All spec sections map to a task.
- **No placeholders:** every code step contains complete code; no TODO/TBD.
- **Type consistency:** `ProbeHost`, `ToolResult`, `ToolStatus`, `ToolDependency`, `ResolverSpec`, `checkTool`, `checkAll`, `renderTable`, `renderJson`, `computeExitCode`, `createRealHost`, `windowsProgramRoots` are used identically across tasks.
